import { dropToken, type Attachment } from "./attach";

/** What you have typed and not yet sent, per card — the words and the pictures.
 *
 *  The dock is one field over a wall of cards, and it used to be one draft too:
 *  half a prompt written at one card was still sitting there after you clicked
 *  another, pointed at the new one, one Enter away from being said to whoever
 *  you happened to land on. That is the failure this exists to stop — a draft
 *  belongs to the card it was written at, and the field is only where it is
 *  being held.
 *
 *  So the field's text is parked under the card that is losing the focus and
 *  the next card's is handed back, which makes leaving a card and coming back
 *  to it a round trip rather than a loss.
 *
 *  **And it outlives the window, which it did not.** "an unsent line is a
 *  thought in progress, and it lives as long as the window does" is what stood
 *  here, and it was a nice sentence about the wrong thing. Lyss's machine
 *  crashed while she was writing a long feature request into a card and the
 *  text was simply gone (sink `b7a08d5e`) — and the sentence had been read as
 *  an argument when it was only a description of what had been built. A thought
 *  in progress is not less valuable than a sent one; it is the same words, a
 *  keystroke earlier, and the ten minutes that went into it are the ten minutes
 *  that went into it. What the crash costs is the one thing on this wall nobody
 *  can reconstruct, because unlike everything else here it was never anywhere
 *  but in a person's head and this box.
 *
 *  So the whole keeping — every card's parked draft *and* whatever is in the
 *  field right now — is written to `localStorage` behind a short debounce, and
 *  read back at startup. See `encodeKept` for what travels and what does not.
 *
 *  **A draft with no card in hand is a draft too**, which is why the wall gets a
 *  bucket of its own rather than being a special case. Two states really have
 *  one: a marquee gathering, which is several cards selected with none focused
 *  and a live field aimed at all of them; and the moment after the card you were
 *  writing at is closed. Both leave text in the field belonging to no card — and
 *  with nowhere to park it, either the next card you click inherits it (the
 *  carry-over this class exists to stop) or it goes on the floor. Neither, now.
 *
 *  **The images go with the words, in one value.** An attachment is written
 *  *into* the sentence — `look at [shot 1]` — so parking the two apart would
 *  mean two maps that can disagree, and the way they would disagree is a picture
 *  arriving at whichever card you clicked next. That is exactly the carry-over
 *  above, made worse by being silent: the token would still be in the other
 *  card's text, so the draft would read as though the image were there. One
 *  object, mutated through the same three methods, cannot drift.
 *
 *  Pure, per the purity boundary — this is the bookkeeping, and `App.svelte`
 *  owns the field, the focus and the one effect that calls `switchTo`. */

/** An unsent prompt: what is typed, and what is attached to it. */
export type Draft = {
  text: string;
  /** Only ever the attachments the text still mentions —
   *  `Attachments.prune` holds that invariant on every keystroke, which is what
   *  lets `empty` ask about the text alone. */
  shots: Attachment[];
};

export const NOTHING: Draft = { text: "", shots: [] };

/** Is there anything here to keep?
 *
 *  Both halves are asked even though the invariant above makes the second
 *  redundant, because a bucket that quietly held a picture with no words would
 *  be a leak nothing on the wall could see — and the cost of asking is a
 *  property read. */
function empty(d: Draft): boolean {
  return !d.text && d.shots.length === 0;
}

/** The bucket for "no card in hand". Not an id and cannot collide with one:
 *  every conversation id is a non-empty uuid. */
const WALL = "";

/** Where the keeping lives.
 *
 *  `localStorage` rather than SQLite, and the reason is the usual one on this
 *  wall plus one that is specific: it is per-machine and disposable, like the
 *  viewport and the compaction calibration — *and* it is the only store here
 *  that is durable **synchronously**. A draft written through an `invoke` is a
 *  draft racing the process it is trying to survive, which is the entire event
 *  this exists for. The thing that makes SQLite the better home for real data
 *  is the thing that makes it the wrong home for this. */
export const KEPT_KEY = "skein.drafts";

/** How long after the last keystroke the keeping is written.
 *
 *  Long enough that typing is not a write per character, short enough that what
 *  a crash takes is a word rather than a paragraph. A `localStorage` write of a
 *  few kilobytes is well under a millisecond, so this is about write *churn*
 *  rather than about cost. */
export const KEEP_AFTER_MS = 400;

/** Roughly how much text is kept across every card, in characters.
 *
 *  A bound rather than a budget: `localStorage` is a handful of megabytes for
 *  the whole origin and the themes, the viewport and the ambience profiles all
 *  live in it too, so a wall of forty cards each holding a pasted build log
 *  must not be able to evict them.
 *
 *  **Nothing is truncated.** Past the bound whole drafts are dropped from the
 *  end, and the one in your hand is never the one dropped — a half-kept
 *  paragraph that reads as complete is worse than one that is plainly absent,
 *  because you would send it. */
export const KEEP_BUDGET = 2_000_000;

/** Every card's unsent text, by id, with the wall's own under `""`. */
export type Kept = Record<string, string>;

/** The words of a draft with its pictures taken out of the sentence.
 *
 *  **The images do not travel, and that is a line rather than an omission.**
 *  An attachment is megabytes of pixels held in memory for exactly as long as
 *  the draft is being written, and `attach.md` is explicit that nothing of it
 *  is written to disk. Keeping them would put screenshots of whatever was on
 *  screen into a file on this machine, indefinitely, as a side effect of a
 *  feature about not losing typed words.
 *
 *  Which leaves their tokens, and a token with no picture behind it is the one
 *  failure `Attachments.prune` exists to prevent, arriving from the other
 *  direction: a restored sentence reading `look at [shot 1]` with nothing
 *  attached is a prompt referring to something the agent will never receive.
 *  So the tokens come out with the images, through the same `dropToken` the
 *  `✕` on a chip uses — the restored draft is the sentence you wrote, minus
 *  the pictures, and says nothing about pictures that are not there. */
function withoutShots(d: Draft): string {
  let text = d.text;
  for (const s of d.shots) text = dropToken(text, s.name);
  return text;
}

/** The keeping, as the one string the browser holds.
 *
 *  Takes the entries in the order they should survive the bound, which
 *  `Drafts.keeping` puts the held one at the head of. */
export function encodeKept(entries: readonly (readonly [string, Draft])[]): string {
  const kept: Kept = {};
  let used = 0;
  for (const [id, d] of entries) {
    const text = withoutShots(d);
    /* A draft that was nothing but a picture is nothing once the picture is
       out of it, and an empty entry is a restore that overwrites a field with
       a blank. */
    if (!text) continue;
    if (used && used + text.length > KEEP_BUDGET) break;
    kept[id] = text;
    used += text.length;
  }
  return JSON.stringify(kept);
}

/** What was kept, out of whatever is in the store.
 *
 *  A normalizer that degrades rather than refuses, which is the bargain every
 *  opaque blob on this wall strikes: this is read at startup, before anything
 *  is drawn, and a parse that threw would be a wall that did not open because
 *  of a half-written draft. Anything unrecognisable is simply not a draft. */
export function decodeKept(raw: string | null): Kept {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Kept = {};
  for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof text === "string" && text) out[id] = text;
  }
  return out;
}

export class Drafts {
  /** Card id (or `WALL`) → the unsent draft. Only non-empty ones are kept, so a
   *  wall you have clicked across all afternoon holds nothing.
   *
   *  The held bucket's entry goes stale the moment a send clears the field, and
   *  deliberately so: nothing reads it until the next `switchTo`, which parks
   *  the field's real contents over it first. */
  #parked = new Map<string, Draft>();
  #holding = WALL;

  /** Is the field holding this card's draft? `null` asks about the wall.
   *
   *  The dock asks before swapping, because a swap is also where the palette and
   *  `!` dismissals are dropped — and dropping those on a focus that did not
   *  actually move would undo an Escape you had just pressed. */
  holds(id: string | null): boolean {
    return this.#holding === (id ?? WALL);
  }

  /** What a card has waiting, without disturbing anything. `null` is the wall's
   *  own. */
  peek(id: string | null): Draft {
    return this.#parked.get(id ?? WALL) ?? NOTHING;
  }

  /** Hand the field from whoever holds it to `id` — a card, or `null` for the
   *  wall: park what is in it, answer with what that one had.
   *
   *  `draft` is the field's current contents and the return is what it should
   *  now say — the caller assigns it, so this stays a function of its inputs. */
  switchTo(id: string | null, draft: Draft): Draft {
    const to = id ?? WALL;
    if (to === this.#holding) return draft;
    this.#park(this.#holding, draft);
    this.#holding = to;
    return this.peek(to);
  }

  /** The card is gone — closed, and closing deletes the row, so the id will
   *  never come round again.
   *
   *  Its parked draft goes with it, since there is nowhere left that text could
   *  ever be shown. A line still *in the field* does not: closing the card you
   *  were writing at is not a statement about the sentence you were writing, so
   *  the wall takes ownership of it and the focus landing on the next card parks
   *  it there rather than carrying it in.
   *
   *  Which leaves two lines wanting one bucket, when the wall already had a
   *  draft of its own. Answered the same way `switchTo` is, and for the same
   *  reason it takes the draft as an argument: an empty field has nothing to
   *  hand over, so the wall keeps what it had and the field is given it to show
   *  — and a field with something in it hands that over, because it is the line
   *  you were writing a moment ago and the wall's was set down before it. */
  release(id: string, draft: Draft): Draft {
    this.#parked.delete(id);
    if (this.#holding !== id) return draft;
    this.#holding = WALL;
    if (empty(draft)) return this.peek(WALL);
    this.#park(WALL, draft);
    return draft;
  }

  /** Everything unsent, in the order it should survive `KEEP_BUDGET`.
   *
   *  `held` is the field's current contents, taken as an argument for the same
   *  reason `switchTo` and `release` take one: this class never reads the
   *  field, so it stays a function of its inputs and stays testable.
   *
   *  **The held one is first, and that is the whole of the ordering.** It is
   *  the draft being written *now* — the one with the keystroke in it, and the
   *  one a crash would take mid-sentence. Everything else was set down
   *  deliberately by moving away from it. */
  keeping(held: Draft): [string, Draft][] {
    const out: [string, Draft][] = [];
    if (!empty(held)) out.push([this.#holding, held]);
    for (const [id, d] of this.#parked) {
      if (id !== this.#holding) out.push([id, d]);
    }
    return out;
  }

  /** Put a keeping back. Startup only.
   *
   *  Refuses once anything is parked, which is what makes it safe to call from
   *  a place that might run twice: a restore landing over a live wall would
   *  overwrite what you have been typing with what you were typing last week.
   *  The pictures are gone — see `withoutShots` — so every restored draft is
   *  words alone, which is exactly what `Draft` with an empty `shots` is. */
  restore(kept: Kept): void {
    if (this.#parked.size) return;
    for (const [id, text] of Object.entries(kept)) {
      if (text) this.#parked.set(id, { text, shots: [] });
    }
  }

  /** Forget the drafts of cards that are not on the wall any more.
   *
   *  A card closed while Volery was shut takes its draft with it the way
   *  `release` would have, and without this the keeping grows a row per card
   *  ever closed, for ever, each holding text that can never be shown.
   *
   *  The wall's own bucket is never pruned: it belongs to no card by
   *  definition, which is the entire reason it exists. */
  prune(live: ReadonlySet<string>): void {
    for (const id of [...this.#parked.keys()]) {
      if (id !== WALL && !live.has(id)) this.#parked.delete(id);
    }
  }

  #park(id: string, draft: Draft): void {
    if (empty(draft)) this.#parked.delete(id);
    else this.#parked.set(id, draft);
  }
}
