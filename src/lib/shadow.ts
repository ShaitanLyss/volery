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

import type { Line } from "./conversation.svelte";
import { spanOf, UNACKNOWLEDGED_LINE, type Ending, type Tier } from "./classify";
import { layout, REGION_GAP, regionWidth, type Box, type Laid, type Region } from "./layout";
import { askHeadline, type AskQuestion } from "./asking";
import { nameBesideProject } from "./naming";
import type { Notice } from "./notice";
import {
  noticesOf,
  readNotices,
  readClosings,
  closingsOf,
  readConfirms,
  confirmsOf,
  readRemovals,
  removalsOf,
  type DigestNotice,
  type DigestClosing,
  type DigestConfirm,
  type DigestRemoval,
  type Closing,
  type Confirm,
  type Removal,
} from "./afar";
import type { Spot } from "./glass";

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
/** `later.rs`'s `MAX_ARMED` and one of the CLI's beside it. */
export const WAKES_CAP = 4;
/** A wake's note is a tooltip, and `waiting.ts` cuts it shorter still. */
export const WAKE_NOTE_CAP = 300;

export type DigestWake = { at: number | null; note: string; from: "wall" | "session" };
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
  /** Which model, how hard it is asked to think, which account pays for it and
   *  whether it is ignoring that account's caps — as the owning wall has them.
   *  Words and a flag, read by nothing in Rust: a newer build's value costs no
   *  migration, and an older wall sends none of them, which reads as unknown.
   *  Published so a shadow's panel can state them the way a local card's does. */
  model: string | null;
  effort: string | null;
  account: string | null;
  bypassCaps: boolean;
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
  /** The wakes the card is waiting on, soonest first — `Conversation.pendingWakes`,
   *  at most `WAKES_CAP`. `at` is **on the owning wall's clock**, the moment and
   *  never the countdown: constant for as long as the wake is armed, so the
   *  digest does not change every second, and moved onto the far side's clock
   *  by `waiting.ts::hereAt` so no two clocks are compared. Empty from a wall
   *  before 2026-10-15, which reads as waiting on nothing — `at rest`, as that
   *  wall would have drawn it itself. */
  wakes: DigestWake[];
  /** Questions the card is parked on, oldest first — what lets a card asking
   *  on one machine be answered from another. See `DigestAsk`. */
  asks: DigestAsk[];
  /** Volery's own removal confirmations the card is parked on, each with the
   *  evidence a person at another machine needs (`afar.ts`). A field of its own rather than part of
   *  `asks`, so a wall from before it sees nothing rather than a bare path. */
  removals: DigestRemoval[];
  /** Volery's own close confirmations the card is parked on — the same
   *  arrangement, for the same reason (`afar.ts`). */
  closings: DigestClosing[];
  /** **Every other** confirmation Volery composed that the card is parked on —
   *  a pull request, an Asana write, a credential lent — each in the generic
   *  block every confirmation carries (`ask::Confirm`, sink `a02ecd0e`). The
   *  field a confirmation written next month crosses in with nothing changed.
   *  An older wall reads nothing here, which is the question staying where it
   *  was asked, as it always did. */
  confirms: DigestConfirm[];
  /** The card's notices standing in its wall's queue, oldest first. */
  notices: DigestNotice[];
  /** The card that opened this one, or null if a person did. `host` is the
   *  wall that card runs on, and **null means this card's own wall** — so the
   *  owner describes a local spawn without needing to know its own flyway
   *  name. What lets another wall draw the root (`lineage.ts::kinAcross`).
   *  An older wall sends nothing here, which reads as null: no root, never a
   *  parent called "". */
  parent: DigestParent | null;
};

export type DigestParent = { host: string | null; card: string };

/** A parked `ask_user` question, as it travels.
 *
 *  **A card stopped on a question on a machine nobody is sitting at is stuck
 *  for good** — it waits out the whole window and then proceeds without you.
 *  "Control them from my work laptop" is not true while a question strands a
 *  card, so the question rides the snapshot and the answer rides the prompt
 *  wire back into the parked call (sink `16864f3d`). Rust carries this as part
 *  of the opaque snapshot and reads only `askId`, when an answer names it.
 *
 *  What rides the snapshot is the words: each question, its header and its
 *  options — a snapshot is re-sent on every change, so a mockup or a
 *  screenshot in it would be sent dozens of times an hour. `shows` says a
 *  design or a file is on the question, and a wall that reads it pulls the
 *  whole call once (`flyway/look.rs`) and draws it as a local question is
 *  drawn. Until then, and if the pull fails, the words say what is missing. */
export type DigestAsk = {
  askId: string;
  /** When it was asked, on the owning wall's clock — subtracted only from the
   *  snapshot's own `at`, as `restingSince` is. */
  since: number;
  questions: {
    header: string;
    question: string;
    options: { label: string; detail: string | null }[];
    shows: boolean;
  }[];
};

/* Generous for what a question is, and there so one wall cannot make another
   hold an unbounded sheet: a question is read in a dock panel. */
export const QUESTION_CAP = 2_000;
export const OPTION_CAP = 300;
export const OPTIONS_CAP = 24;
export const QUESTIONS_CAP = 12;
export const ASKS_CAP = 6;

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
  /** The accounts the owning wall can put a card on, by label — what a
   *  shadow's `put it on…` offers, since the choice is spent there. Labels
   *  only. An older wall sends none, which offers no choice. */
  accounts: string[];
};

/** The most account labels a snapshot carries. A wall has a handful. */
export const ACCOUNTS_CAP = 16;

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
  /** Optional, so a caller with none to hand says nothing. */
  model?: string | null;
  effort?: string | null;
  accountLabel?: string | null;
  bypassCaps?: boolean;
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
  /** `Conversation.pendingWakes` — off no clock, which is why it rather than
   *  `waiting`. */
  pendingWakes: readonly DigestWake[];
  /** `Conversation.asks`. Volery's own questions (`ours`) never travel as
   *  asks — their prose is written from the owning machine's point of view —
   *  but in fields of their own carrying their evidence, composed again on the
   *  far wall: `removals`, `closings`, and `confirms` for every other kind. One
   *  made under `ask::Stay` carries no evidence and stays where it was asked;
   *  the link refuses an answer to it. */
  asks: readonly {
    askId: string;
    since: number;
    ours: boolean;
    questions: readonly AskQuestion[];
    /** A removal's evidence (`remove::evidence`), on Volery's own. */
    remove?: Removal | null;
    /** A close's evidence (`spawn::close_evidence`), on Volery's own. */
    close?: Closing | null;
    /** The generic block every confirmation carries (`ask::Confirm`). */
    confirm?: Confirm | null;
  }[];
  /** The wall's notice queue — this card's are picked out of it. */
  notices?: readonly Notice[];
  /** Who opened it: `Skein.kin` for a card here, `flyway_birth` for one another
   *  wall asked for. Optional so a caller with no lineage to hand says nothing. */
  parent?: DigestParent | null;
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
    model: c.model ? capText(c.model, MODEL_CAP) : null,
    effort: c.effort ? capText(c.effort, MODEL_CAP) : null,
    account: c.accountLabel ? capText(c.accountLabel, TITLE_CAP) : null,
    bypassCaps: c.bypassCaps === true,
    doing: capText(steadyDoing(c), DOING_CAP),
    restingSince: c.working ? null : c.restingSince,
    ctx: Math.round(clamp01(c.ctx) * 1000) / 1000,
    said: capText(lastSaid(c.lines), SAID_CAP),
    jobs: c.jobs.length,
    wakes: c.pendingWakes
      .slice(0, WAKES_CAP)
      .map((w) => ({ at: w.at, note: capText(w.note, WAKE_NOTE_CAP), from: w.from })),
    asks: c.asks
      .filter((a) => !a.ours)
      .slice(0, ASKS_CAP)
      .map((a) => ({
        askId: a.askId,
        since: a.since,
        questions: a.questions.slice(0, QUESTIONS_CAP).map((q) => ({
          header: capText(q.header, TITLE_CAP),
          question: capText(q.question, QUESTION_CAP),
          options: q.options.slice(0, OPTIONS_CAP).map((o) => ({
            label: capText(o.label, OPTION_CAP),
            detail: o.detail ? capText(o.detail, OPTION_CAP) : null,
          })),
          shows: !!(q.preview || q.file || q.options.some((o) => o.preview || o.file)),
        })),
      })),
    removals: removalsOf(c.asks).slice(0, ASKS_CAP),
    closings: closingsOf(c.asks).slice(0, ASKS_CAP),
    confirms: confirmsOf(c.asks).slice(0, ASKS_CAP),
    notices: noticesOf(c.notices ?? [], c.id),
    parent: c.parent?.card
      ? { host: c.parent.host ? capText(c.parent.host, TITLE_CAP) : null, card: capText(c.parent.card, ID_CAP) }
      : null,
  };
}

/** A model id or an effort word as it travels: a bound, not a format. */
const MODEL_CAP = 64;

/** A card id as it travels. Ids are uuids; this is a bound, not a format. */
const ID_CAP = 64;

/** Unique on this wall: the host and the card's own id. What a shadow is keyed
 *  on, and what a root to or from one is addressed by. */
export function shadowKey(host: string, card: string): string {
  return `elsewhere:${host}:${card}`;
}

/** Is this id a `shadowKey` — a card on another wall — rather than a card
 *  here? For an id whose shadow is not on the wall to be asked, as one is
 *  before its wall has been heard from. */
export function isShadowKey(id: string): boolean {
  return id.startsWith("elsewhere:");
}

/** A parent off the wire, or null. A card id that is empty after scrubbing is
 *  no parent at all — the brief's one hard rule for an older or broken wall. */
function readParent(raw: unknown): DigestParent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const card = typeof r.card === "string" ? scrub(r.card).trim().slice(0, ID_CAP) : "";
  if (!card) return null;
  const host = typeof r.host === "string" ? str(r.host, TITLE_CAP).trim() : "";
  return { host: host || null, card };
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

function readWakes(v: unknown): DigestWake[] {
  if (!Array.isArray(v)) return [];
  const out: DigestWake[] = [];
  for (const w of v.slice(0, WAKES_CAP)) {
    if (!w || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    /* Null is a schedule naming no moment; anything else that is not a number
       is not evidence of one, and reading it as "on a schedule" would be a
       claim the other wall never made. */
    if (r.at !== null && stamp(r.at) === null) continue;
    out.push({ at: stamp(r.at), note: str(r.note, WAKE_NOTE_CAP), from: r.from === "session" ? "session" : "wall" });
  }
  return out;
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
    model: str(r.model, MODEL_CAP) || null,
    effort: str(r.effort, MODEL_CAP) || null,
    account: str(r.account, TITLE_CAP) || null,
    bypassCaps: r.bypassCaps === true,
    doing: str(r.doing, DOING_CAP),
    restingSince: stamp(r.restingSince),
    ctx: clamp01(typeof r.ctx === "number" ? r.ctx : 0),
    said: str(r.said, SAID_CAP),
    jobs: Math.min(99, Math.max(0, Math.floor(jobs))),
    wakes: readWakes(r.wakes),
    asks: readAsks(r.asks),
    removals: readRemovals(r.removals),
    closings: readClosings(r.closings),
    confirms: readConfirms(r.confirms),
    notices: readNotices(r.notices),
    parent: readParent(r.parent),
  };
}

/** The parked questions off the wire. A question with no words and an ask with
 *  no id or no questions are dropped — there is nothing to answer — and an
 *  older wall that sends no `asks` at all is a card asking nothing. */
function readAsks(raw: unknown): DigestAsk[] {
  if (!Array.isArray(raw)) return [];
  const out: DigestAsk[] = [];
  for (const a of raw.slice(0, ASKS_CAP)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const askId = typeof r.askId === "string" ? scrub(r.askId).trim().slice(0, 80) : "";
    const since = stamp(r.since);
    if (!askId || since === null || !Array.isArray(r.questions)) continue;
    const questions: DigestAsk["questions"] = [];
    for (const q of r.questions.slice(0, QUESTIONS_CAP)) {
      if (!q || typeof q !== "object") continue;
      const x = q as Record<string, unknown>;
      const question = str(x.question, QUESTION_CAP).trim();
      if (!question) continue;
      const options = Array.isArray(x.options)
        ? x.options.slice(0, OPTIONS_CAP).flatMap((o) => {
            if (!o || typeof o !== "object") return [];
            const y = o as Record<string, unknown>;
            const label = str(y.label, OPTION_CAP).trim();
            if (!label) return [];
            const detail = str(y.detail, OPTION_CAP).trim();
            return [{ label, detail: detail || null }];
          })
        : [];
      questions.push({ header: str(x.header, TITLE_CAP), question, options, shows: x.shows === true });
    }
    if (questions.length) out.push({ askId, since, questions });
  }
  return out;
}

/** A travelled question as the ask panel draws one **from its words alone** —
 *  which is how every question arrives, and for one that shows nothing, how it
 *  stays. One that does show something is pulled whole the moment it arrives
 *  (`shows`, `flyway/look.rs`) and redrawn from the call's own arguments by
 *  `normalizeAsk`, the function a question asked here goes through; this is
 *  what stands until it lands, and what stands if it cannot.
 *
 *  `shows` becomes a sentence on the question rather than a flag the panel
 *  must remember to read: a question asked over a design is an approval, and
 *  answering it without the design is answering something else. Saying so in
 *  the words is the one form no surface can omit. `failed` is why the pull
 *  did not land, said in the same place. */
export function askHere(a: DigestAsk, host: string, failed?: string): AskQuestion[] {
  const note = failed
    ? `*(a design or a file goes with this question, and it could not be brought over from ${host}: ${failed})*`
    : `*(a design or a file goes with this question — bringing it over from ${host}…)*`;
  return a.questions.map((q) => ({
    header: q.header || q.question.slice(0, 48),
    question: q.shows ? `${q.question}\n\n${note}` : q.question,
    options: q.options.map((o) => ({ label: o.label, detail: o.detail })),
  }));
}

/** Whether a travelled question has anything to pull — a design or a file
 *  somewhere on it. A wall from before `shows` sends none, so its questions
 *  are words, as they always were. */
export function shows(a: DigestAsk): boolean {
  return a.questions.some((q) => q.shows);
}

/** A sheet's answers carried onto the same call redrawn whole from its own
 *  arguments.
 *
 *  By position: the digest's questions are the call's first `QUESTIONS_CAP`,
 *  in order, so the first answers line up and any past the cap are new and
 *  unanswered. An answer that was an option is moved to the option at the same
 *  place, because the digest cut long labels at `OPTION_CAP` and a cut label
 *  would otherwise read as free text the user typed. **The same array comes
 *  back when nothing changed**, so a redraw that moves no answer writes none —
 *  the panel's draft is keyed on what was answered, and an equal sheet must
 *  not look like a new one. */
export function carryAnswers(
  was: readonly AskQuestion[],
  answers: readonly (string | null)[],
  now: readonly AskQuestion[],
): (string | null)[] {
  const next = now.map((q, i) => {
    const said = answers[i] ?? null;
    if (said === null || i >= was.length) return null;
    const j = was[i]!.options.findIndex((o) => o.label === said);
    return j >= 0 && q.options[j] ? q.options[j]!.label : said;
  });
  const same = next.length === answers.length && next.every((a, i) => a === answers[i]);
  return same ? (answers as (string | null)[]) : next;
}

/** When a question was asked, on this wall's clock — by the same arithmetic as
 *  `idleOf`, so no term compares two machines' clocks. Without the owner's
 *  `at`, the snapshot's arrival is the best this wall knows. */
export function askedAt(a: Pick<DigestAsk, "since">, at: number | null, madeAt: number): number {
  return at === null ? madeAt : madeAt - Math.max(0, at - a.since);
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
  return { v: typeof r.v === "number" ? r.v : DIGEST_V, at: stamp(r.at), cards, accounts: readAccounts(r.accounts) };
}

/** Account labels off the wire: strings, scrubbed and capped, non-empty, once
 *  each. Anything else reads as none, which offers no choice. */
export function readAccounts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const a of raw) {
    if (out.length >= ACCOUNTS_CAP) break;
    if (typeof a !== "string") continue;
    const l = capText(a, TITLE_CAP).trim();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
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
  /** When this is an answer to a question the card is parked on: which ask,
   *  and the question's header, so the line can say what it answered. */
  askId?: string;
  about?: string;
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

/** How many cards wide each project's section is. Fixed rather than grown with
 *  the count, because a section that changes shape as cards open on a machine
 *  you are not looking at is the wall rearranging itself for a reason you
 *  cannot see.
 *
 *  Still four, not a territory's two, though a section now holds one project
 *  rather than a whole machine. The sections stack down one margin, so their
 *  cost is paid in *height*: a busy project on the other laptop — the one this
 *  repo is, with dozens of cards — at two columns is a strip taller than any
 *  screen, and the whole column has to be framed to be read. Width is the
 *  cheap direction here, and every section the same width keeps the column's
 *  edges straight. */
export const ELSEWHERE_COLS = 4;

/** The room above a wall's sections for its name. Not a region's head
 *  (`REGION_HEAD`, which is inside the box): this sits over the first one. */
export const HOST_HEAD = 34;

/** What a section is called when its cards carry no project at all — a digest
 *  from a build that did not send one, or one that sent "". Never a section
 *  called "", which would be a box with nothing on its handle. */
export const NO_PROJECT = "no project";

/** A section of another wall's cards: one project of one host. `moved` is
 *  whether somebody has put it somewhere other than its place in the column. */
export type Elsewhere = Region & { host: string; moved: boolean };

/** Where sections have been put, by `sectionId`, in the wall's own units.
 *  Absent is "in line", which is where every section stood until it could be
 *  dragged. Persisted on this machine only (`Elsewhere.sections`): a section is
 *  this window's furniture, and the other wall has no say in where it stands. */
export type Placed = Record<string, { x: number; y: number }>;

/** What a stored blob says about where sections stand, with anything that is not
 *  a pair of finite numbers dropped: a corrupt blob puts everything in line
 *  rather than at NaN. */
export function placedOf(raw: unknown): Placed {
  const out: Placed = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    const a = at as { x?: unknown; y?: unknown } | null;
    if (a && typeof a.x === "number" && typeof a.y === "number" && Number.isFinite(a.x) && Number.isFinite(a.y))
      out[id] = { x: a.x, y: a.y };
  }
  return out;
}
/** The name over a wall's sections, in canvas units. */
export type HostHead = { host: string; x: number; y: number; w: number };

/** Which section a card stands in, by its project — the empty one folded into
 *  `NO_PROJECT`. */
export function sectionOf(project: string): string {
  return project.trim() || NO_PROJECT;
}

/** A wall's sections in the order they stand: by name, case folded, and the
 *  one with no project last since it is the leftovers rather than a project.
 *
 *  **By name, not by what moved last.** Most-recently-active is the useful
 *  order for a list you read once; this is a place you come back to, and a
 *  section that jumped to the top because a card in it spoke would move every
 *  section under it — the position-is-memory rule `layout.ts` is built on.
 *  Alphabetical is also the order the owner's own territories are easiest to
 *  find in when you know what you are looking for, which is the only way
 *  anybody looks for something on another machine. */
export function sectionOrder(projects: readonly string[]): string[] {
  return [...new Set(projects.map(sectionOf))].sort((a, b) => {
    if (a === NO_PROJECT || b === NO_PROJECT) return a === NO_PROJECT ? 1 : b === NO_PROJECT ? -1 : 0;
    return a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
  });
}

/** The id a section is known by. Host and project are both free text, so they
 *  go in as a JSON pair rather than joined by a separator either may contain. */
export function sectionId(host: string, project: string): string {
  return `elsewhere:${JSON.stringify([host, project])}`;
}

/** One region per project per other wall, in the wall's left margin.
 *
 *  **A section per project**, because that is the organising idea of the whole
 *  wall: here every project is a territory, and a machine's cards read as one
 *  undivided grid was the one place that reading broke down (Lyss: *"they
 *  should be sectioned by projects"*). The digest already carries `project`,
 *  so nothing new crosses the link.
 *
 *  **The host is a heading, not a prefix.** Every section of a wall stacks
 *  under one name (`heads`), so `lab · skein` is not spelled out down the
 *  column eight times. The heading is drawn over the first section, in the
 *  `HOST_HEAD` of room left above it, and a wall's sections sit a project gap
 *  apart while two walls sit a wider one apart — so the grouping is read off
 *  the spacing before the words.
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
 *  `beside` is everything already standing on the wall. Hosts stand in name
 *  order; within one, `sectionOrder`. */
export function standElsewhere<T extends { id: string; host: string; project: string }>(
  shadows: readonly T[],
  beside: readonly Box[],
  placed: Placed = {},
): { regions: Elsewhere[]; heads: HostHead[]; laid: Laid<T>[] } {
  const hosts = [...new Set(shadows.map((s) => s.host))].sort();
  if (!hosts.length) return { regions: [], heads: [], laid: [] };
  const w = regionWidth(ELSEWHERE_COLS);
  const left = beside.length ? Math.min(...beside.map((b) => b.x)) : 0;
  const x = left - w - REGION_GAP * 2;
  let y = beside.length ? Math.min(...beside.map((b) => b.y)) : 0;

  const regions: Elsewhere[] = [];
  const heads: HostHead[] = [];
  const laid: Laid<T>[] = [];
  for (const host of hosts) {
    const theirs = shadows.filter((s) => s.host === host);
    heads.push({ host, x, y, w });
    y += HOST_HEAD;
    for (const project of sectionOrder(theirs.map((s) => s.project))) {
      const id = sectionId(host, project);
      const mine = theirs.filter((s) => sectionOf(s.project) === project);
      /* Where it was put, if it was: the column's slot is still reserved, so
         dragging one section away does not slide every section under it up. */
      const at = placed[id] ?? { x, y };
      const stood = layout(
        mine.map((s) => ({ id: s.id, cwd: id, project, projectId: id, territoryId: id, s })),
        {},
        [{ id, projectId: id, name: project, project, cwd: id, x: at.x, y: at.y, cols: ELSEWHERE_COLS }],
      );
      const r = stood.regions[0]!;
      regions.push({ ...r, host, moved: !!placed[id] });
      for (const n of stood.laid) laid.push({ ...n, conv: n.conv.s });
      y += r.h + REGION_GAP;
    }
    /* A wall apart from the next by more than a project is from its neighbour,
       so the two levels of grouping read off the spacing. */
    y += REGION_GAP;
  }
  return { regions, heads, laid };
}

/* ── on the glass ───────────────────────────────────────────────────── */

/** Where each shadow stuck to the glass sits, by shadow id (`shadowKey` — the
 *  host and the card's id on it, so two walls' cards can never share a spot).
 *
 *  **Persisted, per screen arrangement, like a card's** — but without a row:
 *  `arrange.rs` keeps it in `glass_spot` under its own kind and nowhere else,
 *  and the room switching, the shifted copy for a room never seen and the
 *  write-through are the very ones every other kind gets. This module holds
 *  only the current room's spots, as `adopt_arrangement` last answered them.
 *
 *  It used to be session-only, on the argument that a spot outlives what it
 *  points at. That is answered by `keepHost`: a wall that has just been heard
 *  lets go of the spots of the cards it no longer carries. See
 *  `.claude/rules/elsewhere.md`. */
export type Spots = Record<string, Spot>;

export const NO_SPOTS: Spots = {};

/** What `adopt_arrangement` answered for shadows, as `Spots`. Anything not
 *  shaped like a point is dropped — a newer build's row is not this build's
 *  problem. */
export function spotsOf(raw: unknown): Spots {
  const out: Spots = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(at)) continue;
    const [x, y] = at;
    if (Number.isFinite(x) && Number.isFinite(y)) out[id] = { x, y };
  }
  return out;
}

/** Stick one shadow to the glass in the room in front of you, or take it off. */
export function stickShadow(spots: Spots, id: string, at: Spot | null): Spots {
  const next = { ...spots };
  if (at) next[id] = { x: at.x, y: at.y };
  else delete next[id];
  return next;
}

/** Let go of the spots of one wall's cards that its latest snapshot no longer
 *  carries. Scoped to the host and asked only when that wall has just been
 *  heard: a wall that is silent says nothing about its cards, and a laptop that
 *  shut its lid finds them where you stuck them. Answers the same object when
 *  nothing went, so a snapshot that moved only a card's activity writes
 *  nothing. */
export function keepHost(spots: Spots, host: string, alive: ReadonlySet<string>): Spots {
  const prefix = `elsewhere:${host}:`;
  const gone = Object.keys(spots).filter((id) => id.startsWith(prefix) && !alive.has(id));
  if (!gone.length) return spots;
  const next = { ...spots };
  for (const id of gone) delete next[id];
  return next;
}

/* ── getting your attention ─────────────────────────────────────────── */

/** A question parked on another wall, in the attention ladder's words — one
 *  row per card, its oldest open question, exactly as a local card is one row
 *  for its `pendingAsk`.
 *
 *  **The dashboard's claim is that you can look away from it.** A question
 *  that only reached the dock reached you only while you were looking at
 *  Volery; in another window nothing said a card on the other machine had
 *  stopped, which is the failure this whole feature exists to prevent, at
 *  exactly the distance the flyway added. So these feed `attention.svelte.ts`'s
 *  own ladder — taskbar flash, peek, chime — as `blocked` items, rather than a
 *  second ladder growing beside it: one answer to "how does the wall get your
 *  attention".
 *
 *  `open` is the shadow's own reading, so a question whose answer is on its
 *  way, or whose wall has gone quiet, is not news either. `key` is the ask, so
 *  a card that asks again after being answered rings again. `waitedSeconds` is
 *  from the question's estimated asking on this wall's clock (`askedAt`), which
 *  is what lets the ladder tell a question that arrived with a wall it had just
 *  met — old, not news — from one asked a moment ago. */
export function remoteQuestions(
  shadows: readonly {
    id: string;
    host: string;
    project: string;
    title: string;
    open: readonly { askId: string; questions: AskQuestion[]; since: number }[];
  }[],
  now: number,
): {
  id: string;
  key: string;
  project: string;
  title: string;
  kind: "blocked";
  detail: string;
  waitedSeconds: number;
}[] {
  return shadows.flatMap((s) => {
    const a = s.open[0];
    if (!a) return [];
    return [
      {
        id: s.id,
        key: a.askId,
        project: `${s.project} · on ${s.host}`,
        title: nameBesideProject(s.title),
        kind: "blocked" as const,
        detail: askHeadline(a.questions),
        waitedSeconds: Math.max(0, Math.floor((now - a.since) / 1000)),
      },
    ];
  });
}

/* ── the conversation itself ──────────────────────────────────────────────── */

/* A digest is the tier, not the conversation — that is this file's first
 * sentence, and it was the right place to stop while the question was whether
 * two walls could see each other at all. It is the wrong place to stay. Lyss,
 * reading a card on her home wall from the office: "I can only see a fraction
 * of what was last said at the top, and then only my messages sent from this
 * machine." Which is precisely what a card face is, opened as a panel.
 *
 * So the conversation travels too. Four decisions shape what follows.
 *
 * **It is pulled, not gossiped.** A digest goes to every peer on every tick
 * because it is small and the wall draws it whether or not anybody is looking.
 * A transcript is none of those things: it is large, it is wanted one card at a
 * time, and it is wanted the moment a panel opens. Putting it in the snapshot
 * would multiply every tick by the *size of the conversations* rather than by
 * the number of cards, to carry something nobody has asked to see. `link.rs`
 * already has the shape — anything somebody is waiting on goes at once, as a
 * one-shot exchange.
 *
 * **It is the same `Line`s, capped.** Not a second vocabulary. The owning wall
 * already holds `Line[]`, this wall already has a component that draws them,
 * and anything in between would be a third fold to keep in step with the other
 * two. `history.ts` made this argument first, and it is why a restored card has
 * no seam in the middle of its column.
 *
 * **What is cut is said.** Every cap marks what it took (`capText`), for the
 * reason the panel's own result cap does: a transcript that truncates quietly
 * has to be distrusted for everything it did show.
 *
 * **A tool result crosses, capped hard.** The tempting economy is to drop it —
 * it is far and away the bulk — and it is the wrong one. Opening a call is the
 * one gesture whose entire purpose is seeing what came back, so a fold that
 * opens onto nothing is worse than a fold that cannot be opened at all.
 */

/** How many lines of a conversation cross. Enough to read the round you are in
 *  and the one before it, which is what somebody opening a remote card wants;
 *  not a scrollback, which is what the owning wall is for. */
export const TAIL_LINES = 120;

/** How much of one line's text crosses. Generous, because what it is really
 *  bounding is a *summary* or a *skill* — 16k–25k characters apiece — and an
 *  ordinary message is nowhere near it. */
export const TAIL_TEXT_CAP = 6_000;

/** How much of a tool result crosses. Much tighter than the panel's own cap,
 *  since this is paid per line over a network rather than once into memory. */
export const TAIL_RESULT_CAP = 2_000;

/** The ceiling on one whole tail, in code points. `MAX_FRAME` is 8 MB and this
 *  is far under it on purpose: the bound that matters is the one on somebody's
 *  patience while a panel fills, not the one the wire would refuse. */
export const TAIL_BUDGET = 400_000;

/** One line of a conversation, as it crosses.
 *
 *  Deliberately a subset of `Line` rather than a restatement of it: the fields a
 *  remote reader can do something with. What is left behind is bookkeeping that
 *  only means anything beside a live process — `awaited`, and the echo's claim —
 *  which a shadow has no wire to settle and must not pretend to. */
export type WireLine = {
  kind: string;
  text: string;
  note?: string;
  state?: "pending" | "failed";
  narration?: true;
  /** The call, flattened. `input` arrives as a *string*: it is an unknown JSON
   *  value on the far side, and a string is the only shape both ends can assert
   *  anything about. */
  call?: { name: string; input?: string; result?: string; failed?: true };
};

/** What a tail is made from — `Line`, structurally, so this file imports no
 *  runes and a test can hand it plain objects. */
export type TailSource = {
  kind: string;
  text: string;
  note?: string;
  state?: "pending" | "failed";
  narration?: true;
  call?: {
    name?: string;
    input?: unknown;
    result?: { text?: string; failed?: boolean } | null;
  } | null;
};

/** The tail of a conversation, ready to cross.
 *
 *  Taken from the end, because the end is what a conversation is about. The
 *  budget is spent walking **backwards** for the same reason: one enormous
 *  compaction summary near the start must not eat the room the last twenty
 *  exchanges needed. */
export function tailOf(lines: readonly TailSource[]): WireLine[] {
  const out: WireLine[] = [];
  let spent = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < TAIL_LINES; i--) {
    const l = lines[i];
    if (!l || typeof l.kind !== "string") continue;
    const w: WireLine = { kind: l.kind, text: capText(l.text ?? "", TAIL_TEXT_CAP) };
    if (l.note) w.note = capText(l.note, TITLE_CAP);
    if (l.state) w.state = l.state;
    if (l.narration) w.narration = true;
    if (l.call && typeof l.call.name === "string") {
      const c: NonNullable<WireLine["call"]> = { name: capText(l.call.name, TITLE_CAP) };
      if (l.call.input !== undefined) {
        /* `JSON.stringify` answers undefined for a few values, so the absence
           is handled rather than becoming the string "undefined" in a fold. */
        let text: string | undefined;
        try {
          text = JSON.stringify(l.call.input);
        } catch {
          text = undefined;
        }
        if (text !== undefined) c.input = capText(text, TAIL_RESULT_CAP);
      }
      if (l.call.result?.text) c.result = capText(l.call.result.text, TAIL_RESULT_CAP);
      if (l.call.result?.failed) c.failed = true;
      w.call = c;
    }
    const cost = w.text.length + (w.call?.result?.length ?? 0) + (w.call?.input?.length ?? 0);
    /* The budget **stops the walk** rather than skipping a line. Everything
       past it is older, so stopping keeps the tail contiguous; skipping would
       leave a hole, and a hole reads as a conversation that missed a round. */
    if (spent + cost > TAIL_BUDGET && out.length) break;
    spent += cost;
    out.push(w);
  }
  return out.reverse();
}

/** Read a tail back, degrading to something drawable.
 *
 *  The bargain `readSnapshot` strikes, for its reason: two walls are never
 *  upgraded at the same moment, so a field a newer build adds must cost neither
 *  a Rust change nor a lockstep between machines. Anything unreadable is
 *  **dropped rather than guessed at** — a line invented here is a line of a
 *  conversation that never happened. */
export function readTail(raw: unknown): WireLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WireLine[] = [];
  for (const r of raw.slice(0, TAIL_LINES)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.kind !== "string" || typeof o.text !== "string") continue;
    const w: WireLine = { kind: o.kind, text: capText(o.text, TAIL_TEXT_CAP) };
    if (typeof o.note === "string") w.note = capText(o.note, TITLE_CAP);
    if (o.state === "pending" || o.state === "failed") w.state = o.state;
    if (o.narration === true) w.narration = true;
    const c = o.call;
    if (c && typeof c === "object") {
      const co = c as Record<string, unknown>;
      if (typeof co.name === "string") {
        const call: NonNullable<WireLine["call"]> = { name: capText(co.name, TITLE_CAP) };
        if (typeof co.input === "string") call.input = capText(co.input, TAIL_RESULT_CAP);
        if (typeof co.result === "string") call.result = capText(co.result, TAIL_RESULT_CAP);
        if (co.failed === true) call.failed = true;
        w.call = call;
      }
    }
    out.push(w);
  }
  return out;
}

/** A line of the drawn column: the far wall's, or one of ours still in flight.
 *
 *  `sent` on a `there` line is the send that line turned out to *be* — which is
 *  what lets the receipt stay under your own words once they have arrived. */
export type Woven =
  | { at: "there"; line: WireLine; sent?: Sent }
  | { at: "here"; sent: Sent };

/** Put the far wall's conversation and this wall's sends into one column.
 *
 *  **This is the one piece with no counterpart in a local card**, and it exists
 *  because a prompt to a remote card is drawn here the instant you send it,
 *  travels, and then comes back inside the far wall's own transcript. Left
 *  alone that is your message twice: once as this wall's copy with its receipt,
 *  once as theirs.
 *
 *  Which is `trimOverlap`'s problem exactly — the session file's copy of a
 *  prompt against the live one — and `#claimEcho`'s before it. So it is solved
 *  the way those are, by **matching on trimmed text**, and it inherits their
 *  hard-won rule: a match is *consumed*. Two identical prompts sent twice are
 *  two lines, and letting both claim one far-side line is how a card drew a
 *  prompt once and swallowed the other.
 *
 *  The receipt is kept rather than dropped on a match, and that is the point of
 *  weaving at all instead of simply trimming: `${host} has it` under your own
 *  words is the only thing distinguishing *the other wall has this* from *this
 *  wall is still holding it*, and a transcript that quietly dropped it would
 *  make a failed send look delivered. Lyss asked for it by name.
 *
 *  Sends with no line to claim are still travelling, or were refused, and go
 *  below in the order they were made — which is where they already were. */
export function weave(tail: readonly WireLine[], sent: readonly Sent[], now?: number): Woven[] {
  const mine = [...sent].sort((a, b) => a.at - b.at);
  const claimed = new Set<number>();
  const taken = new Map<number, Sent>();
  for (const s of mine) {
    const want = s.text.trim();
    if (!want) continue;
    /* From the end, like `#claimEcho`: the newest unclaimed match is the one a
       send just made is likeliest to be. */
    for (let i = tail.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue;
      const l = tail[i];
      if (l.kind !== "you" && l.kind !== "answer") continue;
      if (l.text.trim() !== want) continue;
      claimed.add(i);
      taken.set(i, s);
      break;
    }
  }
  const out: Woven[] = tail.map((line, i) => {
    const s = taken.get(i);
    return s ? { at: "there" as const, line, sent: s } : { at: "there" as const, line };
  });
  const landed = new Set(taken.values());
  for (const s of mine) {
    if (landed.has(s)) continue;
    /* A send the far wall has taken and that no line of the tail claims is not
       travelling — it is either older than the tail's window or worded
       differently there, and in both cases the far copy (if the tail holds it)
       is already drawn in its place. Left here it would be drawn *below the
       newest thing the card said* for the rest of the session, which reads as
       the conversation arriving out of order. A fresh one stays: the tail may
       simply not have been refreshed since. */
    if (now !== undefined && s.state === "taken" && now - s.at > TAKEN_SETTLES_MS) continue;
    out.push({ at: "here", sent: s });
  }
  return out;
}

/** How long a taken send may wait for its line to turn up in the tail before it
 *  is taken to have scrolled out of it (`weave`). The tail is re-read whenever
 *  the card moves, so a send that has been taken for this long and is still not
 *  in it is not coming. */
export const TAKEN_SETTLES_MS = 60_000;

/** A woven column as lines the transcript can draw.
 *
 *  The last step of the reuse, and the whole of what makes a shadow's panel the
 *  *same* panel: `Transcript.svelte` takes `Line`s, so this produces `Line`s and
 *  nothing downstream learns that this card is on another machine. The host
 *  marker belongs on the card's face and the panel's header — where Lyss asked
 *  for it, and where it says something — not sprinkled through the conversation.
 *
 *  A send still in flight becomes a `you` line with `state`, which is exactly
 *  what a local card's unacknowledged prompt is, so the dashed rule and the
 *  dimming come for free. What it gains over a local one is `receipt`: the far
 *  wall's word, in words. `refused` is the one that must not read as pending —
 *  it is `failed`, because it is. */
export function asLines(woven: readonly Woven[], host: string, now: number): Line[] {
  const out: Line[] = [];
  for (const w of woven) {
    if (w.at === "there") {
      const l = w.line;
      const line: Line = { kind: l.kind as Line["kind"], text: l.text };
      if (l.note) line.note = l.note;
      if (l.state) line.state = l.state;
      if (l.narration) line.narration = true;
      if (l.call) {
        /* `input` crossed as a string and `ToolCall.input` is `unknown`, so the
           JSON is put back where it parses and left as the string where it does
           not. A fold showing the raw text beats a fold showing nothing, and
           `toolcall.ts` draws an unknown shape rather than refusing it. */
        let input: unknown = l.call.input;
        if (typeof l.call.input === "string") {
          try {
            input = JSON.parse(l.call.input);
          } catch {
            input = l.call.input;
          }
        }
        line.call = {
          name: l.call.name,
          input,
          ...(l.call.result === undefined
            ? {}
            : { result: { text: l.call.result, failed: l.call.failed === true } }),
        } as Line["call"];
      }
      /* The receipt rides the far wall's own copy of your words — which is the
         point of weaving rather than trimming. See `weave`. */
      if (w.sent) {
        const r = sentReading(w.sent, host, now);
        line.receipt = r.words;
        if (r.look === "failed") line.state = "failed";
      }
      out.push(line);
      continue;
    }
    const r = sentReading(w.sent, host, now);
    out.push({
      kind: w.sent.askId ? "answer" : "you",
      text: w.sent.text,
      receipt: r.words,
      /* `transit` is neither: it left this wall and may yet land, so drawing it
         failed would be this wall claiming to know something it does not. It
         stays pending, and the receipt is what says where it actually is. */
      state: r.look === "failed" ? "failed" : "pending",
    });
  }
  return out;
}

/* ── opening a card on another wall, from a section ─────────────────── */

/** What a section's menu needs to know about the wall it stands for — a
 *  roster row's fields, structurally, so this file needs no runes. */
export type Opener = {
  host: string;
  me?: boolean;
  standing?: string;
  reason?: string;
  territories?: string[];
  older?: boolean;
  opens?: boolean;
};

/** Why a card cannot be opened in this section from here, or `null` when the
 *  presets may be offered. The rows are offered only where the click would get
 *  as far as the far wall deciding — heard lately, new enough, taking work,
 *  holding a project by this name — which is the card menu's `move` filter
 *  plus the one word an empty card needs (`flyway/opening.rs`). What it would
 *  have done instead is said in the menu, so a section with nothing to offer
 *  says why rather than showing nothing. The far wall still weighs its switch
 *  and its bounds again when it decides; this is what can be known here. */
export function openRefusal(row: Opener | undefined, host: string, project: string): string | null {
  if (!row || row.me) return `${host} has not been heard from on this flyway`;
  if (row.standing === "quiet")
    return `${host} has not been heard from lately — a card is never queued for a wall that is away`;
  if (row.older || !row.opens) return `${host} needs updating to open a card from here`;
  if (row.standing === "closed" || row.standing === "full")
    return row.reason ?? `${host} is not taking work from other walls`;
  if (row.standing !== "open") return `${host} is not taking work from other walls`;
  const want = project.trim().toLowerCase();
  if (project === NO_PROJECT || !(row.territories ?? []).some((t) => t.toLowerCase() === want))
    return `${host} has no project called ${project}`;
  return null;
}

/** How long after asking a card that arrives still takes the focus. A card
 *  that turns up later — a slow wall, a late answer — is drawn in its section
 *  and left alone: the focus is where the person is working, and something
 *  arriving a minute on and taking it would be the wall moving under their
 *  hands. */
export const LAND_WITHIN_MS = 30_000;

/** A card asked for from here, waiting to arrive so it can take the focus.
 *  `focusWas` is what had the focus when it was asked for: anything else
 *  taking it since means the person has moved on, and the card is not owed it. */
export type Landing = { key: string; until: number; focusWas: string | null };

/** Whether the card a person just asked for takes the focus now, should be
 *  waited for, or is no longer owed it. */
export function landingNow(
  l: Landing,
  present: boolean,
  focused: string | null,
  now: number,
): "focus" | "wait" | "drop" {
  if (focused !== l.focusWas || now > l.until) return "drop";
  return present ? "focus" : "wait";
}
