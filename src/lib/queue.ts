/* The dock's queue: everything waiting on you, of every kind, and which one of
 * it is in front of you.
 *
 * The dock draws one thing at a time out of a queue every card on the wall —
 * and every card on every other wall in the flyway — is writing to: a question
 * a card is parked on, a notice a card raised when it stopped, the same two
 * from another wall. Which one is drawn used to be decided per kind. A held
 * question, and separately a held notice, each kept against arrivals *of its
 * own kind* — and a question outranked every notice, so a question arriving
 * anywhere took the dock off the notice you were typing a reply into, and the
 * reply went with it. Lyss, 2026-10-14: *"I guess you only fixed it for
 * questions"* — the fix before this one (ask.md, "Nor does the question itself
 * change while you are answering it") was this rule, written once per kind.
 *
 * **So the rule is now one rule, and it knows no kinds:** the item in front of
 * you stays in front of you for as long as it exists. Nothing arriving moves
 * it — not a question, not a notice, not one from another wall, not the queue
 * being re-read or re-sorted. Only you do: answering it, taking it down,
 * deferring it, stepping to the next with "more", or moving the ring onto a
 * card that has something waiting. Everything else queues behind it and is
 * counted, never shown.
 *
 * This file knows nothing about what a question or a notice is. Each item is a
 * key that survives every re-read of the queue, the card it is about, and its
 * tier — and a new kind of waiting thing gets the hold by being put in the
 * list, with nothing here to remember. That is the whole defence against a
 * third "only fixed it for X": there is no per-kind branch left to forget. */

/** One thing waiting on you, as far as choosing between them goes. */
export type Waiting = {
  /** Stable across every re-read of the queue — a kind and the item's own id,
   *  never an index and never an object. The hold is this string, so a queue
   *  rebuilt from fresh objects keeps it. */
  key: string;
  /** The card it is about: a conversation here, or a shadow of one elsewhere.
   *  The ring is compared against it. */
  card: string;
  /** `0`: an agent is stopped mid-turn on it, against a clock — a question.
   *  `1`: a card that has already stopped — a notice. Only ever consulted to
   *  make a *fresh* choice; nothing already in front of you is ever displaced
   *  by a lower tier arriving. */
  tier: 0 | 1;
  /** On another wall. Behind this wall's own at the same tier, unless it is
   *  the card in the ring. */
  far: boolean;
};

/** What the dock is holding: the item, and the card it was about — kept so
 *  that when the item goes, the next one can be chosen from the same card
 *  first. */
export type Hold = { key: string; card: string };

/** The order a fresh choice is made in.
 *
 *  Questions before notices, since an agent is stopped on a question; within
 *  a tier, the card in the ring first — you went to it, so that is what you
 *  meant — then this wall's before another's, then the order the queue was
 *  given in. Stable, so two items that tie keep the caller's order.
 *
 *  **This is never the order something already drawn is kept in.** It decides
 *  only what to draw when nothing is held, when the held item has gone, or
 *  when you move the ring. */
export function queueOrder<T extends Waiting>(
  items: readonly T[],
  ring: string | null | undefined,
): T[] {
  const ringed = (t: T) => (ring ? t.card === ring : false);
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        a.item.tier - b.item.tier ||
        Number(ringed(b.item)) - Number(ringed(a.item)) ||
        Number(a.item.far) - Number(b.item.far) ||
        a.i - b.i,
    )
    .map(({ item }) => item);
}

function holdOf(t: Waiting): Hold {
  return { key: t.key, card: t.card };
}

/** What the dock holds after the wall changed.
 *
 *  `moved` is whether the ring moved since the last time this was asked — the
 *  one change here that is you choosing rather than the wall changing.
 *
 *  1. **You moved the ring onto a card with something waiting** — clicking a
 *     card, the waiting cycle, the panel's own "select it": that card's item
 *     is drawn. Unless what is already held is about that card, which is the
 *     "select it" case — you went to the card to answer the thing you were
 *     on, and handing you its other item instead would be the bug wearing a
 *     friendlier face.
 *  2. **Otherwise what is held stays held while it exists.** This is the rule.
 *     Moving the ring onto a card with *nothing* waiting does not re-decide
 *     either: you went to read a transcript, very likely the one you are
 *     answering about, and that is not a statement about the dock.
 *  3. **The held item has gone** — answered, taken down, deferred, its card
 *     closed, its wall gone quiet: the next is chosen deliberately, from the
 *     same card first (the question queued behind the one you just answered),
 *     then by `queueOrder`. With nothing held, the same rule picks the first
 *     thing to arrive, and from then on that is what is held.
 *
 *  Returns `held` itself when nothing changed, so a caller storing it in a
 *  rune does not invalidate anything on a re-read that moved nothing. */
export function settleHold<T extends Waiting>(
  items: readonly T[],
  ring: string | null | undefined,
  held: Hold | null,
  moved: boolean,
): Hold | null {
  const live = held ? items.find((t) => t.key === held.key) : undefined;
  if (moved && ring && !(live && live.card === ring)) {
    const ringed = queueOrder(
      items.filter((t) => t.card === ring),
      ring,
    )[0];
    if (ringed) return holdOf(ringed);
  }
  if (live) return held!.card === live.card ? held : holdOf(live);
  const sameCard = held
    ? queueOrder(
        items.filter((t) => t.card === held.card),
        ring,
      )[0]
    : undefined;
  const next = sameCard ?? queueOrder(items, ring)[0];
  return next ? holdOf(next) : null;
}

/** The item the dock draws: what `settleHold` would hold, without the ring
 *  having moved.
 *
 *  For the template to read, beside the effect that writes the hold — the two
 *  answer the same question, so the panel is right on the very frame an item
 *  goes, before the effect has re-settled anything. */
export function shownItem<T extends Waiting>(
  items: readonly T[],
  ring: string | null | undefined,
  held: Hold | null,
): T | null {
  const h = settleHold(items, ring, held, false);
  return h ? (items.find((t) => t.key === h.key) ?? null) : null;
}

/** The item "more waiting on you" steps to: the next after the one drawn,
 *  wrapping round, and never the one drawn. An explicit step, so it is the
 *  one way besides the ring that the hold changes hands.
 *
 *  In `queueOrder` with **no** ring, deliberately: the step moves the ring to
 *  the item's card, and an order that put the ring's card first would then
 *  hand the next press straight back to where it started — two cards
 *  ping-ponging and the third never reached. */
export function nextItem<T extends Waiting>(items: readonly T[], current: string | null): T | null {
  const order = queueOrder(items, null);
  if (!order.length) return null;
  const at = order.findIndex((t) => t.key === current);
  for (let step = 1; step <= order.length; step++) {
    const t = order[(at + step + order.length) % order.length];
    if (t.key !== current) return t;
  }
  return null;
}

/** The queue as rebuilt, with every item that has not changed handed back as
 *  the very object it was last time.
 *
 *  The queue is rebuilt whenever anything on the wall raises, takes or
 *  re-reads anything — a far wall's digest alone does it every few seconds —
 *  and a rebuilt item is a new object even when nothing about it moved. The
 *  hold is a key and does not care. But the panel is handed the item's parts
 *  as props, and Svelte wakes anything reading a prop whose source produced a
 *  *different object*: a question's panel reset its step and closed its
 *  gallery on traffic that had nothing to do with it. So identity is kept
 *  here, once, for every reader — an item is the same object for exactly as
 *  long as every field of it is the same. Shallow on purpose: the fields are
 *  the card, the question, the notice, whose own identity is the fact. */
export function steady<T extends Waiting>(was: ReadonlyMap<string, T>, now: readonly T[]): T[] {
  return now.map((t) => {
    const old = was.get(t.key);
    if (!old) return t;
    const a = old as Record<string, unknown>;
    const b = t as Record<string, unknown>;
    const keys = Object.keys(b);
    return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]) ? old : t;
  });
}
