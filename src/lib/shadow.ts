/* A card that lives on another wall, as this one sees it.
 *
 * The flyway (`src-tauri/src/flyway/`) carries what one wall tells another, and
 * this file is what a wall tells another about its *cards*: enough to draw one
 * at every density and to know whether it is worth speaking to. It is the half
 * of distributed Volery that makes it a dashboard rather than a remote spawn
 * button — Lyss's words were "spawn cards on both laptops and control them from
 * my work laptop", and controlling starts with seeing.
 *
 * ### Why the front end makes it, and Rust only carries it
 *
 * What colour a card is — the tier — is `classify.ts`'s taxonomy, in TypeScript.
 * Rust sees every raw event first and still cannot say whether a card is asking,
 * so the owning wall's *front end* folds its own cards into digests and hands
 * them to Rust, which ships them as one opaque JSON value per wall and never
 * looks inside. That is `widget.config_json`'s bargain applied across a network:
 * `readSnapshot` runs on every read and degrades to something drawable, so a
 * field a newer build adds costs no Rust change and no lockstep between two
 * machines that are never upgraded at the same moment.
 *
 * Porting the taxonomy to Rust to make this tidier was the obvious alternative
 * and is the wrong one: two homes for one vocabulary drift silently, and the
 * drift would land on the machine you are not looking at.
 *
 * ### A shadow is a third thing
 *
 * Not a card — a card has a process, or a row that can be given one. Not a
 * *dormant* card either, which is a card with no process *yet*: it wakes when
 * you type. A shadow has no process here and never will; nothing on this wall
 * can wake it, close it, clear it or meter it. What it can do is be spoken to,
 * and the owning wall then does all of those things on its own machine.
 *
 * That is why shadows are kept out of `Skein.convs` entirely rather than being
 * cards with a mark. That array feeds rousing, reaping, history, holds, the
 * slash warm-up and every row the wall writes, and each of those would have had
 * to remember to skip one — where forgetting the rousing pass spawns
 * `claude --resume` here on a session id that only exists over there. A type
 * that cannot be passed where a `Conversation` is wanted is a guard nobody can
 * forget. See `shadows.svelte.ts`.
 *
 * Pure, and tested directly in `test/shadow.test.ts`.
 */

import { spanOf, UNACKNOWLEDGED_LINE, type Ending, type Tier } from "./classify";
import { layout, REGION_GAP, regionWidth, type Box, type Laid, type Region } from "./layout";

/** The digest's shape version — this file's, not the wire's. Read leniently: a
 *  newer wall's digest is drawn from whatever fields this build understands. */
export const DIGEST_V = 1;

/* The caps a digest is written under. `SAID_CAP` is `Card.svelte`'s `SAY_CAP`:
   as much as one clipped line of a card can draw, which is all the face ever
   shows of it. The rest are generous for what they hold and exist so that one
   wall cannot make another hold an unbounded string per card. */
export const TITLE_CAP = 80;
export const DOING_CAP = 120;
export const SAID_CAP = 200;
/** A wall with more open cards than this is drawn with the first this many. */
export const CARDS_CAP = 400;

/** One card, as its own wall describes it to the others. */
export type CardDigest = {
  /** The card's id **on the wall that owns it** — what a prompt is addressed
   *  to. It means nothing here. */
  id: string;
  /** Raw, so the far side's `cardName` decides how an unnamed card reads. */
  title: string;
  project: string;
  /** The grouping it stands in, by name. Drawn, never matched on: a territory's
   *  identity on one machine is not a folder on another. */
  territory: string;
  kind: "project" | "chat";
  /** As the owning wall computed it. */
  tier: Tier;
  ending: Ending | null;
  dormant: boolean;
  working: boolean;
  aside: boolean;
  planning: boolean;
  /** The activity line, without the idle suffix — that is added on the far
   *  side, off its own clock. */
  doing: string;
  /** When the card last came to rest, **on the owning wall's clock**, or null
   *  while a turn is open.
   *
   *  A timestamp rather than the idle seconds, because idle changes every second
   *  with no event behind it — a digest carrying it would differ every second
   *  and have to be shipped every second, which is a poller wearing a disguise.
   *  This is constant for as long as the card rests. And it is never compared
   *  with *this* wall's clock: `idleOf` subtracts it from the snapshot's own
   *  `at`, so two machines whose clocks disagree still agree how long a card
   *  has been quiet. */
  restingSince: number | null;
  /** Context occupancy, 0–1. */
  ctx: number;
  /** The last thing the agent said, from the front — what the card face draws.
   *  The settled last message rather than the one streaming, since streaming
   *  changes per token and the face is not worth a snapshot per token. */
  said: string;
  /** Background jobs still running. */
  jobs: number;
};

/** Everything one wall says about its cards, replaced wholesale on every
 *  publish. A card missing from the next one has been closed — there are no
 *  tombstones, which is what makes a snapshot self-healing after any loss. */
export type Snapshot = {
  v: number;
  /** The owning wall's clock when the snapshot was made. Only ever subtracted
   *  from that same wall's `restingSince`; see there. Null when a wall sent
   *  none, which costs the idle suffix and nothing else. */
  at: number | null;
  cards: CardDigest[];
};

/* ── text that crosses a machine ─────────────────────────────────────── */

/** The C0 controls and DEL, less tab, newline and carriage return — the line
 *  `crate::clean` draws, for its reason: a byte nothing types and nothing
 *  means, which one card's tool output pasted into its last line would
 *  otherwise carry onto every wall in the flyway. Rust scrubs the snapshot
 *  again on arrival; this is the side that knows the field is agent output. */
// eslint-disable-next-line no-control-regex
const IMPOSSIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function scrub(s: string): string {
  return s.replace(IMPOSSIBLE, "");
}

/** Scrubbed and cut to `n` code points — never through a surrogate pair — with
 *  a mark where something was taken off, because a text altered on its way to
 *  a reader owes them a sign that it was (`clip.rs`). */
export function capText(s: string, n: number): string {
  const clean = scrub(s);
  if (clean.length <= n) return clean;
  const points = Array.from(clean);
  if (points.length <= n) return clean;
  return points.slice(0, Math.max(0, n - 1)).join("") + "…";
}

/* ── making one ──────────────────────────────────────────────────────── */

/** What a digest is made from: the fields of a `Conversation` it reads, plus the
 *  territory's name, which a card carries only as an id. Structural, so the
 *  test hands it a plain object and this file imports no runes. */
export type DigestSource = {
  id: string;
  title: string;
  project: string;
  territory: string;
  kind: "project" | "chat";
  tier: Tier;
  ending: Ending | null;
  dormant: boolean;
  working: boolean;
  aside: boolean;
  gear: string;
  /** The card's word for what it is doing, and the three states that qualify
   *  it — see `steadyDoing` for why these rather than `Conversation.doing`. */
  activity: string;
  held: { why: string } | null;
  stalled: boolean;
  unacknowledged: boolean;
  restingSince: number | null;
  ctx: number;
  lines: readonly { kind: string; text: string }[];
  jobs: readonly unknown[];
};

/** `Conversation.doing` without the parts that count.
 *
 *  `doing` appends a live countdown to a held prompt and a running total to a
 *  compaction, both off the wall's one-second tick — so a digest carrying it
 *  would differ every second for as long as a card was held or folding, and be
 *  shipped every second, which is the poller this file is careful not to be.
 *  The words are kept and the counting is dropped: the far side learns that a
 *  card is held and why, and not how many seconds remain. Same order as
 *  `doing`, so the two cannot disagree about which state wins. */
export function steadyDoing(c: Pick<DigestSource, "activity" | "held" | "stalled" | "unacknowledged">): string {
  if (c.held) return c.held.why;
  if (c.stalled) return `${c.activity} · not picked up`;
  if (c.unacknowledged) return `${c.activity} · ${UNACKNOWLEDGED_LINE}`;
  return c.activity;
}

/** The last thing said, scanned from the end — a card holds up to three hundred
 *  lines and this runs for every card on every change. */
function lastSaid(lines: DigestSource["lines"]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === "text") return l.text;
  }
  return "";
}

export function digestOf(c: DigestSource): CardDigest {
  return {
    id: c.id,
    title: capText(c.title, TITLE_CAP),
    project: capText(c.project, TITLE_CAP),
    territory: capText(c.territory, TITLE_CAP),
    kind: c.kind,
    tier: c.tier,
    ending: c.ending,
    dormant: c.dormant,
    working: c.working,
    aside: c.aside,
    planning: c.gear === "planning",
    doing: capText(steadyDoing(c), DOING_CAP),
    restingSince: c.working ? null : c.restingSince,
    ctx: Math.round(clamp01(c.ctx) * 1000) / 1000,
    said: capText(lastSaid(c.lines), SAID_CAP),
    jobs: c.jobs.length,
  };
}

/** Whether two sets of digests would draw the same — what decides a publish.
 *
 *  Compared as text because every digest is built by `digestOf`, so its keys
 *  always come in one order; and `ctx` is rounded there, so a card whose
 *  occupancy moved by a token does not count as a change. */
export function sameCards(a: readonly CardDigest[], b: readonly CardDigest[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ── reading one ─────────────────────────────────────────────────────── */

const TIERS: readonly Tier[] = ["work", "ask", "soft", "rest", "fail"];
const ENDINGS: readonly Ending[] = ["ok", "question", "asked", "stopped", "error"];

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function str(v: unknown, n: number): string {
  return typeof v === "string" ? capText(v, n) : "";
}

function stamp(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One digest off the wire, or null if it cannot be drawn at all.
 *
 *  Only a missing id refuses: a card with no id is nothing a prompt could be
 *  addressed to. Everything else degrades — a tier this build does not know
 *  reads as `rest`, which is the one tier that claims nothing, since drawing a
 *  newer wall's word as a colour we would have to guess is the failure. */
export function readDigest(raw: unknown): CardDigest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? scrub(r.id).trim() : "";
  if (!id) return null;
  const tier = TIERS.includes(r.tier as Tier) ? (r.tier as Tier) : "rest";
  const ending = ENDINGS.includes(r.ending as Ending) ? (r.ending as Ending) : null;
  const jobs = typeof r.jobs === "number" && Number.isFinite(r.jobs) ? r.jobs : 0;
  return {
    id: id.slice(0, 64),
    title: str(r.title, TITLE_CAP),
    project: str(r.project, TITLE_CAP),
    territory: str(r.territory, TITLE_CAP),
    kind: r.kind === "chat" ? "chat" : "project",
    tier,
    ending,
    dormant: r.dormant === true,
    working: r.working === true,
    aside: r.aside === true,
    planning: r.planning === true,
    doing: str(r.doing, DOING_CAP),
    restingSince: stamp(r.restingSince),
    ctx: clamp01(typeof r.ctx === "number" ? r.ctx : 0),
    said: str(r.said, SAID_CAP),
    jobs: Math.min(99, Math.max(0, Math.floor(jobs))),
  };
}

/** A whole snapshot off the wire. Null only when there is no list of cards in
 *  it at all, which is a wall saying nothing rather than a wall with none. */
export function readSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.cards)) return null;
  const seen = new Set<string>();
  const cards: CardDigest[] = [];
  for (const c of r.cards) {
    if (cards.length >= CARDS_CAP) break;
    const d = readDigest(c);
    /* First wins on a repeated id. A correct wall never sends one; a broken
       one must not draw two cards that a prompt cannot tell apart. */
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    cards.push(d);
  }
  return { v: typeof r.v === "number" ? r.v : DIGEST_V, at: stamp(r.at), cards };
}

/* ── drawing one ─────────────────────────────────────────────────────── */

/** How long a wall may go unheard before its cards stop claiming a state.
 *
 *  The fleet's `QUIET_AFTER_MS`, and it must be: the roster calls a wall quiet
 *  at this age and refuses a prompt to it from then on, so a card still drawn
 *  as working past it would be a card you could see and not reach. Three of
 *  the fleet's announce periods, because one missed period is a dropped frame
 *  and three is a pattern. */
export const QUIET_AFTER_MS = 90_000;

/** How long the card has been resting, in seconds, read off this wall's clock.
 *
 *  `madeAt` is this wall's estimate of when the snapshot was made — when it
 *  arrived, less the age the link said it had. The owner's `at - restingSince`
 *  is how long it had already rested by then, measured on the owner's clock
 *  alone; `now - madeAt` is how long since, measured on this one alone. No
 *  term compares the two clocks, which is the only reason the answer survives
 *  them disagreeing. */
export function idleOf(d: CardDigest, at: number | null, madeAt: number, now: number): number {
  if (d.working || d.restingSince === null || at === null) return 0;
  const before = Math.max(0, at - d.restingSince);
  const since = Math.max(0, now - madeAt);
  return Math.floor((before + since) / 1000);
}

/** What a shadow is drawn as, given how long its wall has been unheard.
 *
 *  **A wall that has gone quiet hides everything its cards last said about
 *  themselves**, and that is the whole honesty of a shadow. A laptop that shut
 *  its lid mid-turn sent a digest saying *working*, and will never send the one
 *  that takes it back; drawn as it was, the card would glow celadon over a
 *  machine in a bag — a link that is down looking exactly like an agent that is
 *  thinking. So past `QUIET_AFTER_MS` the card claims no state at all: no
 *  colour, a muted ring, and words that say why. It keeps its title, which is
 *  still true, and what it was last doing, which is history and says so. */
export type ShadowFace = {
  tier: Tier;
  working: boolean;
  /** Drawn muted, as a card with nothing behind it is. */
  dormant: boolean;
  doing: string;
  idleSeconds: number;
  /** The wall has not been heard from for longer than `QUIET_AFTER_MS`. */
  unheard: boolean;
};

export function faceOf(
  d: CardDigest,
  host: string,
  quietMs: number,
  idleSeconds: number,
): ShadowFace {
  /* Not `quietMs > QUIET_AFTER_MS` alone: a wall never heard from at all is
     Infinity, and anything that is not a number is not evidence of being heard. */
  if (!(quietMs <= QUIET_AFTER_MS)) {
    const was = d.working ? "was working" : d.doing ? `was ${d.doing}` : "";
    const span = Number.isFinite(quietMs) ? ` for ${spanOf(quietMs / 1000)}` : "";
    return {
      tier: "rest",
      working: false,
      dormant: true,
      doing: `${host} not heard from${span}${was ? ` · ${was}` : ""}`,
      idleSeconds: 0,
      unheard: true,
    };
  }
  /* The owner's tier, as it was sent, and never re-derived here. A card that
     finished cleanly warms as it is left, and that warming is a change to the
     owner's own `tier` — a derived that changes value, which is an event the
     owner's publisher hears — so the next snapshot carries it. Re-warming here
     off the far side's idle would be a second home for the ladder in
     `Conversation.tier`, and it would get the held card wrong: the owner keeps
     a card holding a prompt at `rest` on purpose, and a digest does not carry
     enough to know why. */
  return {
    tier: d.tier,
    working: d.working,
    dormant: d.dormant,
    doing: d.doing,
    idleSeconds,
    unheard: false,
  };
}

/* ── speaking to one ──────────────────────────────────────────────────
 *
 * A prompt to a card on this wall has three readings — `pending` until the
 * process echoes it, `failed` if it never left, and nothing once it has
 * arrived (CLAUDE.md, "The event pipeline"). A prompt to a card on another
 * wall needs one more, between the two that matter: **it has left this wall,
 * and the other one has not yet said it has it.** Folding that into `pending`
 * would draw a link that is down exactly like an agent that has not got round
 * to it, and the difference is the whole of what you would act on — one wants
 * patience, the other wants the other machine woken.
 *
 * ### Refused now, never queued for later
 *
 * A prompt into a wall that has gone quiet is refused on the spot, with the
 * text left on the line to copy out of. The alternative — hold it and send on
 * reconnect — is convenient and delivers, when a lid lifts eight hours later,
 * something you have since changed your mind about, onto a card running with
 * the machine in its hands. The fleet's ask was built with the same refusal
 * (`fleet.rs`, `ASK_TTL_MS`), and a prompt is the same kind of act: not
 * idempotent, and only worth doing while somebody is waiting for it.
 *
 * So a prompt has a short life and a definite end. It may sit in this wall's
 * outbox for the moment between a transient dial failure and the retry, which
 * is `queued`; the link refuses it outright if it never leaves inside the
 * fleet's TTL; and past `GIVE_UP_MS` with nothing heard, the line says it does
 * not know rather than guessing either way. */

/** The fleet's `GIVE_UP_MS`: by then the far wall would refuse the prompt as
 *  expired even with the clocks at the edge of their slack, so silence past it
 *  is an answer that is never coming — unless one is merely late, which is why
 *  a late answer is still taken (`advance`). */
export const GIVE_UP_MS = 2 * 60_000 + 2 * 2 * 60_000;

export type SentState =
  /** Handed to the link, not yet written to any connection. */
  | "queued"
  /** Written to a connection; the other wall has not said it has it. */
  | "left"
  /** The other wall has it and handed it to the card. */
  | "taken"
  /** Never delivered: refused here, or by the other wall, for `why`. */
  | "refused";

export type Sent = {
  /** Minted once per send, and the whole of what makes a redelivered frame one
   *  prompt rather than two on the far side. */
  id: string;
  text: string;
  /** This wall's clock when it was sent. */
  at: number;
  state: SentState;
  why?: string;
};

export type SentEvent =
  | { kind: "left" }
  | { kind: "answer"; outcome: "taken" | "refused"; why?: string }
  /** The link would not take it at all — the wall is quiet or unknown. */
  | { kind: "unsent"; why: string };

/** Fold one event into a sent prompt.
 *
 *  An answer is final, and so is a refusal made here; nothing after either
 *  changes the line, because each is an end the far side also reached. A
 *  `left` that arrives after its own answer — two events on two channels — is
 *  stale and ignored, or it would walk a delivered prompt back into doubt. */
export function advance(s: Sent, ev: SentEvent): Sent {
  if (s.state === "taken" || s.state === "refused") return s;
  switch (ev.kind) {
    case "left":
      return s.state === "queued" ? { ...s, state: "left" } : s;
    case "answer":
      return ev.outcome === "taken"
        ? { ...s, state: "taken", why: undefined }
        : { ...s, state: "refused", why: ev.why || "refused" };
    case "unsent":
      return { ...s, state: "refused", why: ev.why };
  }
}

/** How a sent prompt reads now — the words under the line, and how it is
 *  drawn.
 *
 *  Four looks, and the fourth is the one a local prompt never needs.
 *  `pending` is the local word for the local fact — drawn, not yet anywhere
 *  but here — and wears the local dashed rule. `transit` is the new one: it
 *  **has left this wall and the other has not said it has it**, drawn with the
 *  dotted stitch the other wall's region wears, because that is where it now
 *  is. `failed` is a local failed send's rust. `plain` is arrived. The words
 *  name the machine in every case but the first, since which machine is the
 *  thing you would go and look at. */
export type SentLook = "plain" | "pending" | "transit" | "failed";
export type SentReading = { look: SentLook; words: string };

export function sentReading(s: Sent, host: string, now: number): SentReading {
  const over = now - s.at > GIVE_UP_MS;
  switch (s.state) {
    case "taken":
      return { look: "plain", words: `${host} has it` };
    case "refused":
      return { look: "failed", words: `not delivered — ${s.why ?? "refused"}` };
    case "queued":
      return over
        ? { look: "failed", words: "never left this wall" }
        : { look: "pending", words: "not left this wall yet" };
    case "left":
      return over
        ? {
            look: "transit",
            words: `${host} never answered — it may or may not have arrived`,
          }
        : { look: "transit", words: `left this wall · ${host} has not said it has it` };
  }
}

/** Where a prompt from another wall is to go, as the owning wall decides it.
 *
 *  Pure for the one decision there is: whether the card is still here. The
 *  far wall's switch — whether it takes work from other walls at all — is the
 *  link's to apply, since it gates spawns by the same reason and one place
 *  should say it. */
export function promptRefusal(cardHere: boolean, me: string): string | null {
  return cardHere
    ? null
    : `that card is not on ${me || "this wall"} any more — it may have been closed there`;
}

/* ── where they stand ───────────────────────────────────────────────── */

/** How many cards wide a wall's region is. Fixed rather than grown with the
 *  count, because a region that changes shape as cards open on a machine you
 *  are not looking at is the wall rearranging itself for a reason you cannot
 *  see. Four rather than a territory's two because one region holds a whole
 *  machine's cards, and two columns of eighty is a strip nobody can frame. */
export const ELSEWHERE_COLS = 4;

/** One region per other wall, in the wall's left margin.
 *
 *  **Left, because that is the edge that stays put.** Territories flow
 *  rightward from the origin and a new one is added on the right, so a region
 *  stood to the right of the wall would be pushed along every time a folder was
 *  opened. Nothing flows leftward; only a territory dragged further left than
 *  everything moves this, and then it moves once.
 *
 *  Laid out by `layout` itself, so a card from another wall sits on exactly the
 *  pitch a card from this one does and every density's `CARD_BOX` holds. The
 *  regions it returns are *not* territories — no row, no drag, no grouping
 *  verbs — and the caller draws them with none of a territory's handles.
 *  `beside` is everything already standing on the wall. */
export function standElsewhere<T extends { id: string; host: string; project: string }>(
  shadows: readonly T[],
  beside: readonly Box[],
): { regions: (Region & { host: string })[]; laid: Laid<T>[] } {
  const hosts = [...new Set(shadows.map((s) => s.host))].sort();
  if (!hosts.length) return { regions: [], laid: [] };
  const w = regionWidth(ELSEWHERE_COLS);
  const left = beside.length ? Math.min(...beside.map((b) => b.x)) : 0;
  const x = left - w - REGION_GAP * 2;
  let y = beside.length ? Math.min(...beside.map((b) => b.y)) : 0;

  const regions: (Region & { host: string })[] = [];
  const laid: Laid<T>[] = [];
  for (const host of hosts) {
    const id = `elsewhere:${host}`;
    const mine = shadows.filter((s) => s.host === host);
    const placed = layout(
      mine.map((s) => ({ id: s.id, cwd: id, project: s.project, projectId: id, territoryId: id, s })),
      {},
      [{ id, projectId: id, name: host, project: host, cwd: id, x, y, cols: ELSEWHERE_COLS }],
    );
    const r = placed.regions[0]!;
    regions.push({ ...r, host });
    for (const n of placed.laid) laid.push({ ...n, conv: n.conv.s });
    y += r.h + REGION_GAP;
  }
  return { regions, laid };
}
