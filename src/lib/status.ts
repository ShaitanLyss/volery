/* What the status page said, and every judgement about it.
 *
 * `status.rs` asks `status.claude.com/api/v2/summary.json` and answers in facts;
 * this file decides what any of them mean. That is the split `limits.ts` draws
 * against `limits.rs` and `update.ts` against `update.rs`, and it is drawn here
 * for their reason — the ladder of severities, the ordering, the colour, the
 * cadence and the wording are the parts that will be argued about, and an
 * argument is worth having against tests.
 *
 * Pure — no runes, no DOM. `beacon.svelte.ts` holds the one reader behind
 * however many faces are up, and `Status.svelte` draws them.
 *
 * ### The one thing this file is really for
 *
 * Nothing on this wall polls unless it has an argument, and the argument is
 * written in CLAUDE.md: *when the thing you care about emits nothing, look for
 * an event that already exists near it and fold that instead, then bound
 * whatever is left over.* Statuspage emits nothing a desktop process can hear —
 * `status.rs` records why each of the four "subscribe to updates" options is not
 * a way to be told — so this is a fourth thing that goes and looks, and it owes
 * the shape.
 *
 * Two events already exist near it, and both are folded:
 *
 * 1. **You coming back to the window.** `attention.focused`, exactly as the
 *    update check uses it. A wall left open on a second monitor for a week asks
 *    nothing, and the moment you look is the moment the answer is worth having.
 * 2. **A card's turn ending in an error.** This is the fold the update check
 *    does not have, and it is the better of the two, because it is the moment
 *    the question is actually being asked. Volery *is* a Claude Code client: an
 *    outage arrives on this wall as turns failing, which is a `result` event
 *    already folded into `Conversation.ending`. "Is it me or is it them?" is the
 *    whole of what this widget answers, and a card going rust is when somebody
 *    wants it answered.
 *
 * What is left over is bounded three ways, and only the first two are the update
 * check's. **The third inverts, and that is the interesting half.** `update.ts`
 * stops asking for good once there is something to say, on the observation that
 * no further ask can change the answer. That does not transfer here, because an
 * outage *resolves*: the moment there is something to say is the moment the
 * answer starts changing, and "amber forever" would be a worse lie than no
 * widget at all. So the third bound is not a stop but a **cadence that tightens
 * with the news** — `PACE` below. A green wall is asked about rarely, an unwell
 * one often, and an unreachable one at the unwell rate, because not knowing
 * resolves too.
 *
 * The worst case is therefore a window you never leave during an outage: one ask
 * every two minutes, thirty an hour, of a static CDN-fronted document, and only
 * while somebody is looking at it. Statuspage publishes no rate limit for the v2
 * API and serves it from a CDN precisely so that clients may do this. */

/* ── what came off the wire ─────────────────────────────────────────────── */

export type Note = { status: string; body: string; at: string };

export type Incident = {
  id: string;
  name: string;
  status: string;
  impact: string;
  url: string;
  startedAt: string;
  notes: Note[];
  affects: string[];
};

export type Part = {
  name: string;
  status: string;
  position: number;
  group: boolean;
  hiddenWhenWell: boolean;
};

export type Health = {
  indicator: string;
  description: string;
  updatedAt: string;
  components: Part[];
  incidents: Incident[];
  maintenances: Incident[];
};

/* ── the two ladders ────────────────────────────────────────────────────── */

/** How bad a thing is, in one word, and the only vocabulary above this file.
 *
 * Five rungs, and they are deliberately *ours* rather than Statuspage's: the
 * page has one ladder for the whole site (`none | minor | major | critical |
 * maintenance`) and a different one for a single component (`operational |
 * degraded_performance | partial_outage | major_outage | under_maintenance`),
 * and a face that had to know both would be a face that draws the same news two
 * ways. `unknown` is the sixth thing and is not a rung: it is the absence of a
 * reading, and the whole point of naming it is that it must never be drawn as
 * one of the five. */
export type Grade = "well" | "watch" | "wrong" | "broken" | "planned" | "unknown";

/** Worse is higher. `planned` sits below `watch` on purpose — maintenance
 *  somebody scheduled is not a fault, and sorting it above a real degradation
 *  would put the least urgent row at the top of a widget cut to three lines.
 *  `unknown` sits at the bottom for the same kind of reason: not knowing is not
 *  evidence of anything, and a page we could not reach must not outrank a
 *  component the page told us is down. */
const RANK: Record<Grade, number> = {
  unknown: 0,
  well: 1,
  planned: 2,
  watch: 3,
  wrong: 4,
  broken: 5,
};

export function rankOf(g: Grade): number {
  return RANK[g] ?? 0;
}

export function worse(a: Grade, b: Grade): Grade {
  return rankOf(a) >= rankOf(b) ? a : b;
}

/** The page's own indicator, on our ladder.
 *
 * Total, and anything unrecognised is `unknown` rather than `well` — that is the
 * failure direction that matters. A rung Statuspage adds tomorrow read as "all
 * fine" would be this widget quietly saying the opposite of the truth; read as
 * "cannot tell" it is merely honest, and the description string beside it still
 * says whatever the page said. */
export function gradeOf(indicator: string): Grade {
  switch (indicator) {
    case "none":
      return "well";
    case "minor":
      return "watch";
    case "major":
      return "wrong";
    case "critical":
      return "broken";
    case "maintenance":
      return "planned";
    default:
      return "unknown";
  }
}

/** A single component's status, on the same ladder. Same totality, same
 *  direction: an unknown component status is `unknown`, never `well`. */
export function gradeOfPart(status: string): Grade {
  switch (status) {
    case "operational":
      return "well";
    case "degraded_performance":
      return "watch";
    case "partial_outage":
      return "wrong";
    case "major_outage":
      return "broken";
    case "under_maintenance":
      return "planned";
    default:
      return "unknown";
  }
}

/** An incident's `impact`, which is the site ladder minus `maintenance`. */
export function gradeOfImpact(impact: string): Grade {
  return impact === "none" ? "well" : gradeOf(impact);
}

/** What to call a component's state, in the wall's register — lowercase, quiet,
 *  sentence-shaped. Not the page's own wording, which is Title Case and written
 *  for a web page: "Degraded Performance" in a 0.62rem row is shouting. The
 *  headline keeps the page's exact sentence (`description`) wherever that
 *  sentence is not milder than the page's own components — paraphrasing somebody
 *  else's overall status is a thing this app has no business doing, and drawing
 *  it over a worse reading is a thing it has less business doing still
 *  (`headlineOf`). A per-component word is our own summary of an enum. */
export function sayGrade(g: Grade): string {
  switch (g) {
    case "well":
      return "operational";
    case "watch":
      return "degraded";
    case "wrong":
      return "partial outage";
    case "broken":
      return "outage";
    case "planned":
      return "maintenance";
    default:
      return "unknown";
  }
}

/** Which status colour a grade wears.
 *
 * The house rule is that chrome is achromatic and colour is reserved for status.
 * This widget *is* status, so the existing five tokens map straight onto the
 * ladder and nothing new is invented — see `tokens.css`, where every `--st-*` is
 * declared un-themeable for exactly this reason.
 *
 * - `well` → `--st-work`, celadon. The wall's "alive and fine".
 * - `watch` → `--st-soft`, half amber. The page's own "minor" is a half-signal
 *   and the token is literally amber at half bloom.
 * - `wrong` → `--st-ask`, full amber. Something wants attention.
 * - `broken` → `--st-fail`, rust.
 * - `planned` → `--st-rest`, the muted one. Maintenance is not a fault, and it
 *   is the same reading `set aside` already settles for a card.
 * - `unknown` → `--paper-faint`, which is **not a status colour and must not
 *   become one.** Not having reached the page is the absence of a reading;
 *   drawing it in any of the five would be this widget inventing news. */
export function toneOf(g: Grade): string {
  switch (g) {
    case "well":
      return "var(--st-work)";
    case "watch":
      return "var(--st-soft)";
    case "wrong":
      return "var(--st-ask)";
    case "broken":
      return "var(--st-fail)";
    case "planned":
      return "var(--st-rest)";
    default:
      return "var(--paper-faint)";
  }
}

/* ── the reading ────────────────────────────────────────────────────────── */

/** One component, graded and ready to draw. */
export type Row = { name: string; grade: Grade; word: string; position: number };

/** A whole reading of the page, or of the fact that there is not one.
 *
 * `at` is when *this wall* asked, not `page.updated_at` — those are different
 * facts and conflating them is the honesty bug this type exists to prevent. A
 * status page untouched for a week is perfectly normal; a reading taken a week
 * ago is not a reading of now, and the face has to be able to say so. */
export type Reading =
  | { got: true; health: Health; at: number }
  | { got: false; fault: string | null; at: number };

/** The grade a reading amounts to, which is the dot and the whole small face.
 *
 * The page's own indicator, never a recomputation from the components — the page
 * is entitled to call a single degraded component a `minor` or a `major` and it
 * knows things this does not. The one place the components get a say is the
 * floor: if the page says `none` while a component says it is down, the worse of
 * the two wins. That has happened on real Statuspage instances during the gap
 * between a component being flipped and an incident being opened, and "all
 * systems operational" over a red row would be a widget arguing with itself. */
export function gradeOfReading(r: Reading): Grade {
  if (!r.got) return "unknown";
  let g = gradeOf(r.health.indicator);
  for (const p of r.health.components) {
    if (p.group) continue;
    g = worse(g, gradeOfPart(p.status));
  }
  return g;
}

/** What the page's own indicator claims, apart from what its components say.
 *
 * Held separately from `gradeOfReading` because the two disagreeing is the whole
 * of the bug below, and a reading that cannot state both halves cannot notice
 * it. */
export function gradeClaimed(r: Reading): Grade {
  return r.got ? gradeOf(r.health.indicator) : "unknown";
}

/** Whether the page's own headline is milder than the page's own components.
 *
 * Statuspage's site indicator is a summary of *incidents*, and Anthropic's
 * incidents are opened with an auto-calculated impact that runs a rung below
 * what the components are set to — so a partial outage of claude.ai, the API,
 * Claude Code and Cowork all at once sat under a `minor` indicator, whose canned
 * sentence is "Minor Service Outage". */
export function understates(r: Reading): boolean {
  return rankOf(gradeOfReading(r)) > rankOf(gradeClaimed(r));
}

/** The headline reading: a big line and, where the two sources disagree, a small
 *  one under it.
 *
 * ### The bug this shape exists to prevent
 *
 * `gradeOfReading` floors the grade on the worst component, so the dot has been
 * honest since the widget shipped. The *words* were not: they were
 * `description`, verbatim, which is the page's aggregate sentence about the
 * whole site. On 2026-09-03 Claude's page carried an incident that set claude.ai,
 * Claude API, Claude Code and Claude Cowork to `partial_outage` for three hours
 * (`incidents.json`, incident "Elevated errors for multiple models") while the
 * site indicator stayed a rung below it — so the widget drew a full-amber dot
 * over the sentence "Minor Service Outage", and reported the mildest reading
 * available for the worst thing that had happened that week. The one line that
 * carried *our* word for the grade was suppressed by `!lead`, i.e. exactly and
 * only when there was an incident open to suppress it.
 *
 * So: our word leads whenever the page's own sentence would understate its own
 * components, and the page's sentence is kept verbatim below it rather than
 * dropped. Nothing is paraphrased away — the disagreement is drawn, which is
 * what an instrument owes when its two sources differ. */
export type Headline = { line: string; sub: string | null };

export function headlineOf(r: Reading): Headline {
  if (!r.got) return { line: "could not reach the status page", sub: null };
  const said = r.health.description.trim();
  const grade = gradeOfReading(r);
  if (understates(r)) {
    return { line: sayGrade(grade), sub: said ? `page says "${said}"` : null };
  }
  return { line: said || sayGrade(grade), sub: null };
}

/** The components worth drawing, worst first.
 *
 * Three decisions, each of which would be a bug the other way round:
 *
 * - **Groups are dropped.** A Statuspage group row is a heading, not a service,
 *   and drawing one would be a line that cannot be down.
 * - **A component marked `only_show_if_degraded` is dropped while it is well.**
 *   That flag is the page saying "do not put this in front of people unless it
 *   matters", and honouring it is why the flag is carried up from Rust at all.
 * - **Worst first, then the page's own order.** The box you drag it to is the
 *   setting (`rowsFor`), so a widget cut to three rows has to show the three
 *   that matter — which is the same call `perf.ts` makes putting orphans above
 *   cost. On a green day every grade is equal and `position` alone decides, so
 *   nothing shuffles while all is well. */
export function rowsOf(r: Reading, onlyIll = false): Row[] {
  if (!r.got) return [];
  const rows: Row[] = [];
  for (const p of r.health.components) {
    if (p.group) continue;
    const grade = gradeOfPart(p.status);
    if (p.hiddenWhenWell && grade === "well") continue;
    if (onlyIll && grade === "well") continue;
    rows.push({ name: p.name, grade, word: sayGrade(grade), position: p.position });
  }
  return rows.sort(
    (a, b) => rankOf(b.grade) - rankOf(a.grade) || a.position - b.position,
  );
}

/** How many components a filtered reading is not showing, so an empty pane can
 *  say why. Same bargain `logface.ts`'s `tail` strikes: what a *filter* dropped
 *  is owed an explanation, because an empty box that cannot account for itself
 *  reads as a widget that has broken. */
export function hiddenBy(r: Reading, onlyIll: boolean): number {
  return onlyIll ? rowsOf(r).length - rowsOf(r, true).length : 0;
}

/** Every unresolved incident, worst first, then newest first.
 *
 * Maintenance is folded in only when asked for. A window three weeks out is not
 * a reading of *now* and this is an instrument about now — but it is exactly
 * what somebody planning a Friday deploy wants, which is why it is a knob rather
 * than a decision. */
export function incidentsOf(r: Reading, withPlanned = false): Incident[] {
  if (!r.got) return [];
  const all = withPlanned
    ? [...r.health.incidents, ...r.health.maintenances]
    : r.health.incidents;
  return [...all].sort(
    (a, b) =>
      rankOf(gradeOfImpact(b.impact)) - rankOf(gradeOfImpact(a.impact)) ||
      b.startedAt.localeCompare(a.startedAt),
  );
}

/** The latest thing said about an incident. Newest first off the wire, so this
 *  is the first one — but taken by name rather than by index, because "the wire
 *  happens to be sorted" is the kind of thing that stops being true. */
export function latestNote(i: Incident): Note | null {
  if (!i.notes.length) return null;
  return [...i.notes].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** One line of an incident's prose, for a face that has one line.
 *
 * Statuspage bodies run to a paragraph and arrive with hard newlines in them.
 * Clipped rather than wrapped, for `covering`'s reason: a widget's rows are one
 * line each and an incident with four sentences would otherwise be the whole
 * face. Reaching the rest is the shortlink, which is one click. */
export function clip(text: string, max = 120): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1).trimEnd()}…`;
}

/* ── how old the reading is ─────────────────────────────────────────────── */

/** Past this, a reading stops being a reading of now.
 *
 * Twice the calm backstop, so a wall that has been in front all along never
 * shows it: the only way to get here is to have been away, which is precisely
 * the case where a green dot would be a claim nobody checked. */
export const STALE = 30 * 60_000;

export function isStale(r: Reading, now: number): boolean {
  return now - r.at >= STALE;
}

/** How long ago the wall last got an answer, in the register `board.ts` already
 *  set for ages on this wall. Deliberately the same vocabulary — two widgets
 *  spelling "17m" differently is two instruments disagreeing about a minute. */
export function sayAge(at: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* ── the cadence ────────────────────────────────────────────────────────── */

/** The least time between two asks, whatever provoked them.
 *
 * A minute. It is a floor rather than a debounce — the pending ask is moved, not
 * queued — so alt-tabbing forty times costs one question, and so does a whole
 * territory of cards failing in the same second. That second case is the one
 * this number is really sized for: six cards erroring together is one outage,
 * not six, and it must be one ask. */
export const FLOOR = 60_000;

/** How long to wait before asking again when nothing has provoked it.
 *
 * The third bound, and the one that does not look like the update check's. There
 * the rule is *stop for good once there is something to say*; here the news moves
 * in both directions, so the same observation runs the other way — the moment
 * there is something to say is the moment the answer starts changing, and a
 * widget that latched amber would be worse than no widget.
 *
 * So it tightens instead of stopping:
 *
 * - **`well` → fifteen minutes.** The answer is "All Systems Operational"
 *   essentially always, and a wall in front all day should not spend a request a
 *   minute confirming it. Fifteen is `release.svelte.ts`'s backstop, deliberately
 *   — two instruments asking the internet on two different rhythms would be two
 *   numbers to reason about instead of one.
 * - **anything else → two minutes.** Now the reading is live news and the thing
 *   you are waiting for is the resolution. This is the *only* state that spends
 *   anything worth counting, and it is the state you are watching the widget in.
 * - **`unknown` → two minutes as well**, which is the rung this classification
 *   exists to get right. Not having reached the page is not a quiet state: either
 *   the network came back and the answer is a second away, or it did not and the
 *   widget is telling you something true. Backing off to fifteen minutes there
 *   would make the one case where the instrument is useful the one case where it
 *   is slowest. */
export const PACE: { calm: number; alert: number } = {
  calm: 15 * 60_000,
  alert: 2 * 60_000,
};

export function paceFor(g: Grade): number {
  return g === "well" ? PACE.calm : PACE.alert;
}

/** Whatever is left of the floor, or nothing if it has already passed.
 *
 * What a *trigger* — a focus, a card going rust — waits before it is allowed to
 * ask. Zero means ask on this tick, which is what the first call after launch
 * gets, since nothing has been asked yet. */
export function delayFor(since: number): number {
  return Math.max(0, FLOOR - Math.max(0, since));
}
