/* A reply being written to something in the dock's queue — a follow-up to a
 * notice, the free-text answer to one step of a question — kept by the id of
 * what it answers, not in the field it is being typed into.
 *
 * The field is a component, and a component is the least durable place on the
 * wall to keep a sentence: it unmounts whenever the dock draws something else,
 * and the dock draws one thing out of a queue every card is writing to. A
 * notice's reply lived in `Notice.svelte`'s own `$state`, so the moment a
 * question arrived and took the panel (`queue.ts` has that half), what had
 * been typed was simply gone. The hold fixes *that* way in. This is so that no
 * other way in — a bug in the hold, a re-render, a reload, the webview
 * restarting — can eat it either.
 *
 * Keyed by field:
 *
 *     notice:<notice id>             a notice's reply
 *     ask:<ask id>:<step>            one question of a sheet
 *
 * and each entry says which item it belongs to, in words as well as by id, so
 * that a reply whose item has gone — expired, taken down, died with the
 * process — can still be shown back to you and say what it was for
 * (`orphans`). The item cannot be recovered from the key's spelling: a far
 * notice's id is `elsewhere:<host>:<card>:<id>`, colons and all.
 *
 * Pure, per the purity boundary; `replies.svelte.ts` holds the rune and the
 * storage. `localStorage` for the reason `drafts.ts` gives at length — it is
 * the one store here that is durable *synchronously*, and a reply written
 * through an `invoke` races the very crash it exists to survive. */

/** What a reply was written to. */
export type About = {
  /** The item: `notice:<id>` or `ask:<id>` — the dock's queue key. */
  item: string;
  /** In words, for the line that hands it back: "the notice from skein · x". */
  about: string;
  /** The card it was written to — a conversation here, or the shadow of one
   *  on another wall. Where "to its prompt" takes it. */
  card: string;
  /** Typed into the away pile, which keeps its questions itself and draws
   *  the reply back in place. Never an orphan. */
  pile?: boolean;
};

export type Reply = About & {
  text: string;
  /** When it was last written — what `decodeReplies` ages it out on. */
  at: number;
  /** Why it is still here, once something has said: a send that did not go
   *  through, a question you deferred. Cleared by the next keystroke. */
  why?: string;
};

export type Replies = Record<string, Reply>;

export const REPLIES_KEY = "skein.replies";

/** How long a reply nobody came back to is kept.
 *
 *  A reply outlives its item only when the item went before it was sent, and
 *  then the dock says so — so this is the floor under the one case it cannot:
 *  a reply to a card on another wall that has not been heard from since. A
 *  fortnight covers a holiday. */
export const REPLY_KEEP_MS = 14 * 24 * 60 * 60_000;

/** Roughly how many characters of replies are kept, in all. A bound, so a
 *  pasted build log cannot crowd the themes and the viewport out of the
 *  origin's few megabytes; past it the oldest go first, whole. */
export const REPLIES_BUDGET = 200_000;

/** The key for one field of an item. */
export function replyKey(item: string, part?: string | number): string {
  return part === undefined ? item : `${item}:${part}`;
}

/** Everything kept for an item, in field order — one entry for a notice, one
 *  per step written in for a question. */
export function under(all: Replies, item: string): [string, Reply][] {
  return Object.entries(all)
    .filter(([, r]) => r.item === item)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}

/** The text kept for an item, its fields joined as they would be read. Blank
 *  fields read as nothing. */
export function textUnder(all: Replies, item: string): string {
  return under(all, item)
    .map(([, r]) => r.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** `all` with one field written. Only an empty string takes the entry out —
 *  whitespace is kept as typed, or a field bound to this store would eat the
 *  space you had just pressed. Writing clears a standing `why`: you are back
 *  at it, so it is a draft again. */
export function withReply(
  all: Replies,
  key: string,
  text: string,
  now: number,
  about: About,
): Replies {
  const out = { ...all };
  if (text) out[key] = { ...about, text, at: now };
  else delete out[key];
  return out;
}

/** `all` with an item's every field gone. */
export function without(all: Replies, item: string): Replies {
  const out: Replies = {};
  for (const [k, r] of Object.entries(all)) if (r.item !== item) out[k] = r;
  return out;
}

/** `all` with a reason written on an item's fields. */
export function noted(all: Replies, item: string, why: string): Replies {
  const out: Replies = {};
  for (const [k, r] of Object.entries(all)) out[k] = r.item === item ? { ...r, why } : r;
  return out;
}

/** A reply whose item is not in front of anyone. */
export type Orphan = About & { text: string; why?: string; at: number };

/** The replies the dock should hand back: written to something that is no
 *  longer waiting, never sent.
 *
 *  `live` is every item still in the queue — a reply to one of those is
 *  simply a reply, waiting in its own panel. `sending` are replies on their
 *  way; drawing them would flash a "not sent" line for every send in flight.
 *  `ready` is the caller's say on whether the queue an entry would be found in
 *  has been read at all yet — at launch, before the notices are read or
 *  another wall is heard from, everything looks gone.
 *
 *  Derived from the store alone rather than from watching items leave, which
 *  is what makes a reload honest: a question that died with the process left
 *  its reply on disk, and nothing that started after it could have seen it go.
 *  Oldest first, since that is the one most likely forgotten. */
export function orphans(
  all: Replies,
  live: ReadonlySet<string>,
  sending: readonly string[],
  ready: (r: Reply) => boolean,
): Orphan[] {
  const out = new Map<string, Orphan>();
  for (const r of Object.values(all)) {
    if (r.pile || live.has(r.item) || sending.includes(r.item) || out.has(r.item)) continue;
    if (!ready(r)) continue;
    const text = textUnder(all, r.item);
    if (!text) continue;
    const fields = under(all, r.item).map(([, f]) => f);
    out.set(r.item, {
      item: r.item,
      about: r.about,
      card: r.card,
      text,
      why: fields.find((f) => f.why)?.why,
      at: Math.max(...fields.map((f) => f.at)),
    });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/** Newest first, then trimmed to the budget — whole replies, never a cut one:
 *  a half-kept answer that reads as complete is worse than an absent one,
 *  because you would send it (`drafts.ts::KEEP_BUDGET`'s argument). */
function bounded(entries: [string, Reply][]): Replies {
  const out: Replies = {};
  let used = 0;
  for (const [k, r] of [...entries].sort(([, a], [, b]) => b.at - a.at)) {
    if (used && used + r.text.length > REPLIES_BUDGET) continue;
    out[k] = r;
    used += r.text.length;
  }
  return out;
}

export function encodeReplies(all: Replies): string {
  return JSON.stringify(bounded(Object.entries(all)));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What was kept, out of whatever is in the store. Degrades rather than
 *  refuses — this is read at startup, and a reply that would not parse is not
 *  a reason for a wall not to open. Drops anything past `REPLY_KEEP_MS`, and
 *  anything with nothing but whitespace in it. */
export function decodeReplies(raw: string | null, now: number): Replies {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const kept: [string, Reply][] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const r = v as Record<string, unknown> | null;
    if (!r || typeof r.text !== "string" || !r.text.trim()) continue;
    const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : now;
    if (now - at > REPLY_KEEP_MS) continue;
    kept.push([
      k,
      {
        text: r.text,
        at,
        item: str(r.item) || k,
        about: str(r.about) || "something that was waiting on you",
        card: str(r.card),
        ...(r.pile === true ? { pile: true } : {}),
        ...(str(r.why) ? { why: str(r.why) } : {}),
      },
    ]);
  }
  return bounded(kept);
}
