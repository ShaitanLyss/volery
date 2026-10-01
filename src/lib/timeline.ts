/* Timelines, as the wall draws them.
 *
 * A card's plan for a long piece of work, drawn as a frise: major steps as
 * milestones along one hairline, sub-steps as ticks between them, and a step
 * whose work runs in parallel forking into strands that rejoin at the next
 * milestone. `timeline.rs` owns the plan and every write to it; this is the
 * reading of one — the shape a row arrives in, how far along it is, and where
 * every mark goes on the line.
 *
 * Pure, and tested directly in `test/timeline.test.ts`. Nothing here knows
 * there is a DOM: the geometry is numbers and path strings, so the plate and
 * the archive draw from one source and a change to the drawing is a change a
 * test can see.
 *
 * ### Where colour is allowed
 *
 * Exactly one place: the live markers, which are drawn in the owning card's own
 * status colour (`Tier`) — celadon while it works, amber when it is asking,
 * muted at rest. A live marker is *where work is happening right now*, and that
 * is a status; everything else on the frise is how far a plan has got, which is
 * not, so it stays in the ink ramp. A milestone is never tinted. */

export type State = "todo" | "active" | "done";

export type Sub = {
  title: string;
  state: State;
  /** The write that put it on the plan, and the one that marked it done. */
  born?: number;
  done?: number;
};

export type Strand = {
  name?: string;
  background?: boolean;
  subs: Sub[];
};

export type Step = {
  title: string;
  about: string;
  /** Read only when the step has no sub-steps — see `effective`. */
  state: State;
  strands: Strand[];
  born?: number;
  done?: number;
};

export type Plan = { rev: number; steps: Step[] };

/** `live` is on the glass and moving; `complete` is on the glass and finished,
 *  waiting for the archive click; `left` is a live one whose card was closed. */
export type Standing = "live" | "complete" | "left";

export type Timeline = {
  id: string;
  ownerId: string;
  sessionId: string | null;
  cwd: string;
  project: string;
  /** The owning card's title when it last wrote — what the archive names it by
   *  once the card itself is gone. */
  source: string;
  title: string;
  plan: Plan;
  state: Standing;
  archivedAt: number | null;
  /** Where the user dragged it on the glass, or null for the stack. */
  glassX: number | null;
  glassY: number | null;
  bornAt: number;
  updatedAt: number;
  endedAt: number | null;
};

/* ── reading a row ───────────────────────────────────────────────────────── */

const STATES: readonly State[] = ["todo", "active", "done"];
const STANDINGS: readonly Standing[] = ["live", "complete", "left"];

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function rev(v: unknown): number | undefined {
  const n = num(v);
  return n !== null && n > 0 ? n : undefined;
}
function state(v: unknown): State {
  return STATES.includes(v as State) ? (v as State) : "todo";
}
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function subOf(raw: unknown): Sub {
  const o = obj(raw);
  return { title: str(o.title), state: state(o.state), born: rev(o.born), done: rev(o.done) };
}

/** A plan as it came off the wire, degraded to something drawable. Rust owns
 *  the shape and writes it typed, so this is a guard against a newer build's
 *  row rather than against Rust — the bargain every stored document strikes. */
export function planOf(raw: unknown): Plan {
  const o = obj(raw);
  return {
    rev: num(o.rev) ?? 0,
    steps: list(o.steps).map((s) => {
      const so = obj(s);
      return {
        title: str(so.title),
        about: str(so.about),
        state: state(so.state),
        born: rev(so.born),
        done: rev(so.done),
        strands: list(so.strands).map((k) => {
          const ko = obj(k);
          return {
            ...(typeof ko.name === "string" ? { name: ko.name } : {}),
            ...(ko.background === true ? { background: true } : {}),
            subs: list(ko.subs).map(subOf),
          };
        }),
      };
    }),
  };
}

export function timelineOf(raw: unknown): Timeline | null {
  const o = obj(raw);
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    ownerId: str(o.owner_id),
    sessionId: typeof o.session_id === "string" ? o.session_id : null,
    cwd: str(o.cwd),
    project: str(o.project),
    source: str(o.source),
    title: str(o.title, "untitled"),
    plan: planOf(o.plan),
    state: STANDINGS.includes(o.state as Standing) ? (o.state as Standing) : "live",
    archivedAt: num(o.archived_at),
    glassX: num(o.glass_x),
    glassY: num(o.glass_y),
    bornAt: num(o.born_at) ?? 0,
    updatedAt: num(o.updated_at) ?? 0,
    endedAt: num(o.ended_at),
  };
}

/* ── how far along ───────────────────────────────────────────────────────── */

export function subsOf(step: Step): Sub[] {
  return step.strands.flatMap((k) => k.subs);
}

/** A step is exactly as far along as its sub-steps; only a step with none
 *  carries a state of its own. Same rule as `Step::effective` in Rust. */
export function effective(step: Step): State {
  const subs = subsOf(step);
  if (subs.length === 0) return step.state;
  if (subs.every((s) => s.state === "done")) return "done";
  if (subs.some((s) => s.state !== "todo")) return "active";
  return "todo";
}

const WORTH: Record<State, number> = { todo: 0, active: 0.5, done: 1 };

/** Done units over all units, an active one counting half — which is also
 *  where the frise draws it, at the middle of its span. */
export function fraction(plan: Plan): number {
  let got = 0;
  let all = 0;
  for (const step of plan.steps) {
    const subs = subsOf(step);
    if (subs.length === 0) {
      all += 1;
      got += WORTH[step.state];
    } else {
      for (const s of subs) {
        all += 1;
        got += WORTH[s.state];
      }
    }
  }
  return all === 0 ? 0 : got / all;
}

/** The first step that is not done, 0-based, or -1 when all are. */
export function current(plan: Plan): number {
  return plan.steps.findIndex((s) => effective(s) !== "done");
}

/** How many strands of a step have work moving in them right now. */
export function liveStrands(step: Step): number {
  return step.strands.filter((k) => k.subs.some((s) => s.state === "active")).length;
}

const ROMAN: [number, string][] = [
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** Lowercase roman, the frise's own numbering — a step count on a wall is
 *  never going to need more than the twelve the Rust side allows. */
export function roman(n: number): string {
  if (!Number.isFinite(n) || n < 1) return String(n);
  let out = "";
  let left = Math.floor(n);
  for (const [v, s] of ROMAN) {
    while (left >= v) {
      out += s;
      left -= v;
    }
  }
  return out;
}

/* ── the line ────────────────────────────────────────────────────────────── */

/** How far apart two strands run. Enough for a live marker's halo on one not to
 *  sit on the next, which is the whole constraint. */
export const STRAND_GAP = 9;
/** Room above the line for a milestone and a halo. */
const PAD = 9;

export type Node = { x: number; y: number; state: State };
export type Tick = { x: number; y1: number; y2: number; done: boolean };
export type Mark = { x: number; y: number };
export type Span = {
  index: number;
  x0: number;
  x1: number;
  title: string;
  state: State;
};

export type Frise = {
  width: number;
  height: number;
  base: number;
  /** The whole line, unfilled — path data, one per segment or strand. */
  track: string[];
  /** The part already walked. */
  fill: string[];
  ticks: Tick[];
  nodes: Node[];
  /** Where work is moving now, one per active item. */
  lives: Mark[];
  spans: Span[];
};

const f = (n: number) => Math.round(n * 100) / 100;

/** How far into its run a list of sub-steps has got, from 0 to 1.
 *
 *  The done prefix, plus half of the item after it if that one is active. Not
 *  a count of done items: a run that is done, todo, done is drawn filled to the
 *  end of the first — the line shows where the work has *reached*, and the
 *  second done item is a tick of its own rather than a gap in the fill. */
export function reach(subs: Sub[]): number {
  if (subs.length === 0) return 0;
  let k = 0;
  while (k < subs.length && subs[k].state === "done") k++;
  let r = k;
  if (k < subs.length && subs[k].state === "active") r += 0.5;
  return r / subs.length;
}

/** The frise for a plan at a width: every mark, in the plate's own units.
 *
 *  Every step gets the same span. Proportional spans were the alternative and
 *  read worse: a frise is read as milestones, and a milestone pushed to the
 *  edge because the step before it had eight sub-steps is a timeline saying
 *  the work is further along than it is. The ticks carry the density instead. */
export function frise(plan: Plan, width: number): Frise {
  const n = plan.steps.length;
  const most = Math.max(1, ...plan.steps.map((s) => s.strands.length));
  const half = ((most - 1) * STRAND_GAP) / 2;
  const base = PAD + half;
  const out: Frise = {
    width,
    height: base * 2,
    base,
    track: [],
    fill: [],
    ticks: [],
    nodes: [],
    lives: [],
    spans: [],
  };
  if (n === 0) return out;
  const w = width / n;

  plan.steps.forEach((step, i) => {
    const x0 = i * w;
    const x1 = x0 + w;
    const eff = effective(step);
    out.spans.push({ index: i, x0, x1, title: step.title, state: eff });
    out.nodes.push({ x: x0, y: base, state: eff });

    const strands = step.strands;
    if (strands.length <= 1) {
      out.track.push(`M${f(x0)},${f(base)} H${f(x1)}`);
      const subs = strands[0]?.subs ?? [];
      if (subs.length === 0) {
        const r = WORTH[step.state];
        if (r > 0) out.fill.push(`M${f(x0)},${f(base)} H${f(x0 + r * w)}`);
        if (step.state === "active") out.lives.push({ x: f(x0 + w / 2), y: base });
        return;
      }
      lay(subs, x0, x1, base);
      const r = reach(subs);
      if (r > 0) out.fill.push(`M${f(x0)},${f(base)} H${f(x0 + r * w)}`);
      return;
    }

    /* A fork. The curve is a quarter of the span at most, so a step crowded
       between eleven others still has room for its straight run. */
    const c = Math.min(28, w / 4);
    strands.forEach((strand, k) => {
      const y = base + (k - (strands.length - 1) / 2) * STRAND_GAP;
      const a = x0 + c;
      const b = x1 - c;
      const into = `M${f(x0)},${f(base)} C${f(x0 + c * 0.43)},${f(base)} ${f(x0 + c * 0.5)},${f(y)} ${f(a)},${f(y)}`;
      const out_ = `C${f(x1 - c * 0.5)},${f(y)} ${f(x1 - c * 0.43)},${f(base)} ${f(x1)},${f(base)}`;
      out.track.push(`${into} H${f(b)} ${out_}`);
      lay(strand.subs, a, b, y);
      const r = reach(strand.subs);
      if (r > 0) {
        out.fill.push(`${into} H${f(a + r * (b - a))}${r >= 1 ? ` ${out_}` : ""}`);
      }
    });
  });

  /* The end of the line, a tick taller than the rest — so a frise reads as
     having an end rather than being cut off by the plate. */
  out.ticks.push({ x: width, y1: base - 5.5, y2: base + 5.5, done: current(plan) === -1 });
  return out;

  function lay(subs: Sub[], a: number, b: number, y: number) {
    const step = (b - a) / subs.length;
    subs.forEach((s, k) => {
      if (k > 0) {
        out.ticks.push({
          x: f(a + k * step),
          y1: y - 3.5,
          y2: y + 3.5,
          done: subs[k - 1].state === "done",
        });
      }
      if (s.state === "active") out.lives.push({ x: f(a + (k + 0.5) * step), y });
    });
  }
}

/** How wide the line is for a plan: a span of 128 a step, kept between the
 *  narrowest a plate reads at and the widest a pane can give one. */
export function railWidth(steps: number): number {
  return Math.max(448, Math.min(768, steps * 128));
}

/* ── finding where a step was written ────────────────────────────────────── */

/** Every write's answer ends `[timeline 3fa9c1 r7]` (`timeline.rs::receipt`):
 *  which timeline, and which of its writes. The id is in it because a revision
 *  restarts at 1 for every timeline and a card can hold two. */
const RECEIPT = /\[timeline ([0-9a-f]{6}) r(\d+)\]/g;

/** The six characters a receipt names a timeline by — `timeline.rs::short`. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6);
}

/** The receipt a tool result carries, or null. The *last* one, since nothing
 *  else in a result would carry one and a quoted earlier answer must not win. */
export function receiptOf(text: string): { id: string; rev: number } | null {
  let found: { id: string; rev: number } | null = null;
  for (const m of text.matchAll(RECEIPT)) found = { id: m[1], rev: Number(m[2]) };
  return found;
}

/** Whether a tool result is the answer to this write of this timeline. */
export function isReceipt(text: string, timelineId: string, rev: number): boolean {
  const r = receiptOf(text);
  return !!r && r.rev === rev && r.id === shortId(timelineId);
}

/** Where to take somebody who clicked a step: the write that finished it, or
 *  the one that put it on the plan when it is not finished yet. */
export function stepRev(step: Step): number | null {
  if (effective(step) === "done") {
    return step.done ?? (Math.max(0, ...subsOf(step).map((s) => s.done ?? 0)) || null);
  }
  return step.born ?? null;
}

export function subRev(sub: Sub): number | null {
  return (sub.state === "done" ? sub.done : sub.born) ?? sub.born ?? null;
}

/* ── the words ───────────────────────────────────────────────────────────── */

/** A length of time the way the plate says it: `2d 4h`, `6h 12m`, `14m`. */
export function took(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The head's right-hand reading, as separate words so the plate can set the
 *  first one brighter: where it is, and how far. */
export function whereabouts(t: Timeline): string[] {
  const p = t.plan;
  if (t.state === "complete") {
    return ["complete", `took ${took((t.endedAt ?? t.updatedAt) - t.bornAt)}`];
  }
  const at = current(p);
  const pct = `${Math.round(fraction(p) * 100)}%`;
  if (t.state === "left") {
    const where = at === -1 ? "left with every step done" : `left at step ${roman(at + 1)}`;
    return [
      `${where}, ${day(t.endedAt ?? t.updatedAt)}`,
      `ran ${took((t.endedAt ?? t.updatedAt) - t.bornAt)}`,
    ];
  }
  if (at === -1) return ["every step done", pct];
  const step = p.steps[at];
  const strands = liveStrands(step);
  return [
    step.title,
    ...(strands > 1 ? [`${strands} strands`] : []),
    `step ${roman(at + 1)} of ${roman(p.steps.length)}`,
    pct,
  ];
}

/** The project a timeline belongs to, by name, falling back to the last
 *  segment of its directory for a row written before the name was known. */
export function projectOf(t: Timeline): string {
  if (t.project) return t.project;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
