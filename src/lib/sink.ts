/* The sink, as the wall reads it.
 *
 * `sink.rs` owns what an item *means* — who may take one, when a hold stops
 * being believed, whether two titles are the same finding. This is the reading:
 * normalizing a row into something drawable, putting it in the order a pile of
 * waiting things is read in, and saying in a few words what state each one is
 * in.
 *
 * `normalize` strikes the same bargain `normalizeAsk`, `normalizeNotice` and the
 * widget configs do (see `store.rs::migrate_v5`): a row from a newer build, a
 * field renamed, a null where a string belongs — all of it degrades to something
 * that draws rather than refusing. An item that fails to draw is a finding lost,
 * which is the one failure this feature cannot have, since not losing findings
 * is the entire point of it.
 *
 * Pure — no runes — so the ordering and the labels are tested directly.
 */

/** The four an agent may set. Kept in step with `sink.rs::KINDS`, and the
 *  `test/sink.test.ts` case that asserts it is the only thing holding them
 *  together — nothing on the wire carries the vocabulary. */
export const KINDS = ["bug", "idea", "chore", "note"] as const;
export type Kind = (typeof KINDS)[number];

export type Item = {
  id: string;
  /** Null for an item about the studio rather than about one project. */
  projectId: string | null;
  kind: Kind;
  title: string;
  body: string;
  /** Files it concerns. Empty means it is about no file in particular. */
  paths: string[];
  /** The card that dropped it, or null when you did. */
  from: string | null;
  droppedAt: number;
  touchedAt: number;
  /** How many separate cards have met this same thing. */
  voices: number;
  heldBy: string | null;
  heldAt: number | null;
  /** Computed in Rust off `HOLD_STALE_MS`, never here — the reading an agent
   *  gets and the reading you get must not disagree about whether a hold
   *  stands. */
  holdStale: boolean;
  settledAt: number | null;
  settledNote: string | null;
  /** When you last reworded it, or null for an item still in the words it was
   *  dropped in. See `store.rs::migrate_v22`. */
  editedAt: number | null;
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function maybeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isKind(v: unknown): v is Kind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

export function normalize(raw: unknown): Item | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  /* The two an item cannot be drawn without. Everything else has a sensible
     absence; a row with no id could not be settled and a row with no title is a
     blank line in the pile. */
  if (!id || !title) return null;
  return {
    id,
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    /* An unknown kind falls to `note` rather than being refused — a newer build
       writing `question` must not make the item invisible here. */
    kind: isKind(r.kind) ? r.kind : "note",
    title,
    body: str(r.body),
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [],
    from: typeof r.from === "string" ? r.from : null,
    droppedAt: num(r.droppedAt),
    touchedAt: num(r.touchedAt),
    voices: Math.max(1, num(r.voices, 1)),
    heldBy: typeof r.heldBy === "string" ? r.heldBy : null,
    heldAt: maybeNum(r.heldAt),
    holdStale: r.holdStale === true,
    settledAt: maybeNum(r.settledAt),
    settledNote: typeof r.settledNote === "string" ? r.settledNote : null,
    editedAt: maybeNum(r.editedAt),
  };
}

export function normalizeAll(raw: unknown): Item[] {
  return Array.isArray(raw) ? raw.map(normalize).filter((i): i is Item => i !== null) : [];
}

/** Whether anybody is actually on this.
 *
 *  A hold that has gone stale is not a hold — the same call `sink.rs::free`
 *  makes, off the same flag, so the widget cannot draw an item as taken that an
 *  agent would be allowed to take. */
export function held(item: Item): boolean {
  return item.heldBy !== null && !item.holdStale;
}

/** The one word for what state an item is in. */
export type State = "held" | "lapsed" | "waiting" | "settled";

export function stateOf(item: Item): State {
  if (item.settledAt !== null) return "settled";
  if (item.heldBy === null) return "waiting";
  return item.holdStale ? "lapsed" : "held";
}

/** The order a sink is read in.
 *
 *  **Oldest first within each group**, which is the opposite of everything else
 *  on this wall and the one decision here worth arguing about. A transcript, a
 *  board, an inbox are all read newest-first because you are catching up. A pile
 *  of things nobody has done is read to find what has been waiting longest —
 *  newest-first would put the item dropped a minute ago above the one that has
 *  been ignored for three weeks, which is precisely the item the pile exists to
 *  keep in front of you.
 *
 *  Waiting first, then lapsed, then held. Held last because it is the group with
 *  nothing for you to decide: somebody is on it. Lapsed above it because a hold
 *  nobody honoured is a thing that *looks* handled and is not, so it is the
 *  reading most likely to be wrong if it is buried. */
export function reading(items: Item[]): Item[] {
  const rank: Record<State, number> = { waiting: 0, lapsed: 1, held: 2, settled: 3 };
  return [...items].sort(
    (a, b) => rank[stateOf(a)] - rank[stateOf(b)] || a.droppedAt - b.droppedAt,
  );
}

/** How long this has been sitting there, in the register the rest of the wall
 *  uses. */
export function waiting(item: Item, now: number): string {
  const mins = Math.floor(Math.max(0, now - item.droppedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** What the files line says, clipped — the widget's rows are one line each and
 *  an item with eight globs on it would otherwise be the whole face. */
export function about(item: Item, max = 3): string {
  if (item.paths.length === 0) return "";
  const shown = item.paths.slice(0, max).join(", ");
  const rest = item.paths.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** Who dropped it, for a face that has the roster to hand.
 *
 *  `names` maps a conversation id to what that card is called. Unlike the
 *  billboard's `author`, a miss here is *ordinary* rather than a race: an item
 *  outlives the card that found it on purpose, so most of what a long-lived sink
 *  holds was dropped by conversations that are no longer on the wall. It says
 *  "an agent" rather than showing eight characters of a dead uuid, which would
 *  read as data you could go and look up. */
export function finder(item: Item, names: Map<string, string>): string {
  if (item.from === null) return "you";
  return names.get(item.from) ?? "an agent";
}

/** Who is on it, or empty for an item nobody has taken. */
export function holder(item: Item, names: Map<string, string>): string {
  if (item.heldBy === null) return "";
  return names.get(item.heldBy) ?? "a closed card";
}

/** The pile, in the order it is read, optionally narrowed to one kind. */
export function pile(items: Item[], kind: Kind | "all" = "all"): Item[] {
  return reading(kind === "all" ? items : items.filter((i) => i.kind === kind));
}

/** What the face says when there is nothing to draw.
 *
 *  Three different absences, and telling them apart is the difference between a
 *  widget that looks broken and one that is telling you good news. */
export function nothing(kind: Kind | "all", settled: boolean): string {
  if (settled) return "nothing settled yet";
  if (kind === "all") return "the sink is empty";
  return `no ${kind}s waiting`;
}

/* ── rewording one ─────────────────────────────────────────────────────────── */

/** The caps, mirroring `sink.rs`'s `MAX_TITLE` / `MAX_BODY` / `MAX_GLOBS`.
 *
 *  Here so the field you are typing in stops where the write will clip, rather
 *  than letting you write two hundred characters of title and find out
 *  afterwards that eighty of them were dropped. Rust clips regardless — this is
 *  the reading, not the rule. */
export const MAX_TITLE = 120;
export const MAX_BODY = 1_200;
export const MAX_PATHS = 8;

/** What is in the fields while you are typing. `paths` is one line, because that
 *  is what you type; `Edit` is what gets sent. */
export type Draft = { title: string; body: string; kind: Kind; paths: string };

/** What goes on the wire. */
export type Edit = { title: string; body: string; kind: Kind; paths: string[] };

/** May you reword this one?
 *
 *  Pending and unheld — `may_edit` in `sink.rs` is where that policy is argued,
 *  and this is the same call off the same two fields so the face does not offer
 *  a verb the write would refuse. **The face does not offer it rather than
 *  offering it and erroring**: a button that is there and does not work teaches
 *  you to distrust the ones that do.
 *
 *  A lapsed hold is not a hold, which is `held`'s call and therefore the same
 *  one an agent's `take` gets. */
export function editable(item: Item): boolean {
  return item.settledAt === null && !held(item);
}

/** The fields, filled from the item as it stands. An editor that opened empty
 *  would be a second `drop` wearing an edit's clothes. */
export function opening(item: Item): Draft {
  return {
    title: item.title,
    body: item.body,
    kind: item.kind,
    paths: item.paths.join(", "),
  };
}

/** What you typed, as the write wants it.
 *
 *  The paths line is split the way `sink.rs::globs_from` splits it — on newlines
 *  *and* commas, trimmed, empties dropped — because that is the spelling an
 *  agent's `drop` is parsed with and one field cannot have two grammars. */
export function proposed(d: Draft): Edit {
  return {
    title: d.title.trim().slice(0, MAX_TITLE),
    body: d.body.trim().slice(0, MAX_BODY),
    kind: d.kind,
    paths: d.paths
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .slice(0, MAX_PATHS),
  };
}

/** Did anything actually change?
 *
 *  Opening an item, reading it and closing it again must not stamp `edited_at` —
 *  that stamp is what tells an agent the words it is reading are no longer the
 *  ones the finder wrote, and a stamp that also fires on "you looked at it"
 *  means nothing. So a save that moved nothing is not a write. */
export function moved(item: Item, e: Edit): boolean {
  return (
    e.title !== item.title ||
    e.body !== item.body ||
    e.kind !== item.kind ||
    e.paths.join("\n") !== item.paths.join("\n")
  );
}

/** Why this cannot be saved, in the words the face will draw, or null.
 *
 *  Only what is decidable from what you typed. The other three refusals — held,
 *  settled, and a title another item already has — need the table, so they come
 *  back from Rust as a sentence; these two are the same bar `do_drop` sets and
 *  are said here so the answer is instant. An item with no body is one nobody
 *  will be able to act on in a month, which is the whole span this table is
 *  built for. */
export function refusal(e: Edit): string | null {
  if (!e.title) return "an item needs a title";
  if (!e.body) {
    return "an item needs a body — a title on its own is a thing nobody will be able to act on in a month";
  }
  return null;
}

/** The count a collapsed face carries: what is waiting, not what is in the
 *  table. An item somebody is already dealing with is not a thing asking for
 *  your attention, and counting it would make the badge stop meaning anything
 *  on a busy wall. */
export function pending(items: Item[]): number {
  return items.filter((i) => i.settledAt === null && !held(i)).length;
}
