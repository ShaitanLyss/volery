/* Following the tail.
 *
 * Anything that grows at the bottom while you read it — a transcript, a dev
 * server's output, the shell's scrollback — wants the same two behaviours, and
 * they pull against each other. Parked at the bottom, new lines should carry the
 * view down: a log you have to scroll to see the newest line of is a log you
 * cannot watch a build in. Scrolled back to read something, nothing may move:
 * a panel that yanks you to the bottom every time a server prints is a panel
 * you cannot read a stack trace in.
 *
 * So the rule everywhere is *near the bottom means stuck to it*, and the whole
 * of the difficulty is deciding what "near" means when the bottom itself is
 * moving — and then, because that turned out not to be enough, deciding which
 * scroll events are entitled to answer the question at all. This module is both
 * of those decisions, once, plus the standard wiring for them —
 * because it had been made three times: correctly and at length in
 * `Transcript.svelte`, naively in `Console.svelte` (the late-event bug below,
 * unfixed), and not at all in `Servers.svelte`, whose `pre.log` was a plain
 * `overflow: auto` box that opened at the oldest of its last hundred lines and
 * stayed there while the group talked.
 *
 * `Tail` is the state, and it is a plain class over a plain `View` — no runes,
 * no DOM — so the judgement is unit-tested. `stickToTail` is the attachment
 * that feeds it a real element and is the whole of what a consumer needs:
 *
 *     <pre class="log" {@attach stickToTail}>…</pre>
 *
 * Growth is heard from the element rather than declared by the component
 * (`hearGrowth`), which is what makes the attachment complete on its own:
 * appended lines are `childList`, a `{#each}` over a sliding window rewrites the
 * text of nodes it already has (`characterData`), a resize rewraps all of it,
 * and none of the three is something the panel would have to remember to
 * announce. `Transcript.svelte` keeps its own `$effect` — it has a rail carrying
 * the view, a keyboard ladder and a `following` that its effect graph depends on
 * being `$state` — but it hears the column through `hearGrowth` and judges it
 * with `stillFollowing`, both from here. It spent a long time declaring its own
 * growth instead, as four conversation signals, and what that cost was every
 * height change with no signal behind it: a fold opened, the panel dragged
 * narrower, a `!` run writing into a line that already existed. The view was
 * left above the tail with `following` still true and nothing to take it back.
 */

/** The three numbers every one of these decisions is made from. */
export type View = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** How far from the bottom still counts as being stuck to it. One line of slack,
 *  so a rounding error mid-stream is not read as having scrolled away. */
export const STICK_PX = 32;

/** How much of the column is below the fold. */
export function slack(view: View): number {
  return view.scrollHeight - view.scrollTop - view.clientHeight;
}

/** How long after a real gesture a scroll event is still attributable to it.
 *
 *  A wheel notch, a key and a pointer all dispatch their scroll in the same frame,
 *  so this only has to outlast a frame. It is wider than that because the
 *  continuous gestures — a scrollbar dragged, a trackpad's momentum, a held
 *  PageDown — refresh it with every event they send, and the cost of erring long
 *  is only that the panel behaves for another quarter second the way it behaved
 *  before any of this. Erring short is a panel that will not let go. */
export const GESTURE_MS = 300;

/** Whether a gesture last seen at `at` is still in play at `now`. `-1` is "none
 *  since this scroller was attached", which is not merely stale but *never*. */
export function gestureLive(at: number, now: number): boolean {
  return at >= 0 && now - at <= GESTURE_MS;
}

/** Whether a scroll event that just arrived means the tail has been let go of.
 *
 *  In here rather than in the panel because it is the panel's most consequential
 *  few lines, and it has now been wrong twice in the same direction: **it kept
 *  trying to identify our own writes, when the question it needed to ask was
 *  whether the event came from a hand at all.**
 *
 *  The first version asked only "are we still at the bottom?". A write to
 *  `scrollTop` does not dispatch its scroll event synchronously — the event lands
 *  a beat later, and a turn writing in bursts moves the bottom inside that beat,
 *  so the answer was about a column that had grown rather than about anything you
 *  did. The panel decided you had scrolled away and stayed stopped; a card roused
 *  at launch stranded the reading two thirds of the way down its own transcript.
 *  `pinned` was the fix: where the follow last put the view, or `-1` for "not
 *  ours", compared rather than trusted as a flag, because content landing *below*
 *  the view does not change `scrollTop` — so the event reporting our own write
 *  reports exactly the number we wrote.
 *
 *  **That identifies the follow's writes and nothing else's, and the follow is not
 *  the only thing in a browser that moves a scroller.** Two others do it with no
 *  hand anywhere near the wheel, both arriving as ordinary scroll events:
 *
 *  - **the clamp.** `scrollTop` is bounded by `scrollHeight - clientHeight`, so a
 *    column that gets shorter — a card switched to, a fold closed, an `{#each}`
 *    sliding its window — has the browser move the view for you.
 *  - **scroll anchoring.** `overflow-anchor` is `auto` by default in Chromium: when
 *    content *above* the viewport changes height the browser adjusts `scrollTop` to
 *    hold the anchor node still. A scroll event nobody made, reporting a number the
 *    follow never wrote.
 *
 *  Both land in the rendering update's scroll steps, which run *before* animation
 *  frame callbacks — so they arrive in front of the very frame the follow queued to
 *  re-pin, and that frame then finds `following` false and declines. Which is the
 *  bug as it was reported: "I put a card at the end, look at another card, come
 *  back, and sometimes it jumps way up". Nothing was scrolled. The column settled
 *  in two passes and the panel read the second pass as a decision.
 *
 *  So the rule is no longer "was this ours" but **only a gesture may let go of the
 *  tail**, which is the honest shape of it: *releasing* the tail is a claim about
 *  your intent, and the only events that can carry intent are the ones a hand
 *  made. Every content-driven event — the clamp, the anchoring, the late-delivered
 *  write, a rewrap — is then unable to strand the reading *by construction*, rather
 *  than by out-guessing them one producer at a time. `pinned` is kept as the
 *  positive proof it always was, since it needs no bookkeeping to be right.
 *
 *  **It is deliberately asymmetric, and the asymmetry is load-bearing.** A scroll
 *  event with no gesture behind it may still *re-arm* the tail by landing on it,
 *  because arriving at the bottom is a claim about where the view *is* rather than
 *  about what you want — measurable, and true however it got there. That is what
 *  keeps `unfolded`'s promise in the panel: closing a fold while parked at the
 *  bottom shortens the column, the clamp puts the view back on the tail, and the
 *  follow takes it up again with nothing having been touched.
 *
 *  Returns what `following` should become. The caller keeps the flag; this only
 *  answers the question, which is what makes it testable with no DOM. */
export function stillFollowing(
  view: View & {
    /** Where the follow last wrote, or -1 if the last movement was not ours. */
    pinned: number;
    /** Whether the panel was following before this event. */
    following: boolean;
    /** Whether a hand is on the wheel — a gesture within `GESTURE_MS`. Required
     *  rather than defaulted: a caller that forgot to wire the listeners would
     *  otherwise get a panel that never lets go, and no error saying so. */
    gestured: boolean;
  },
): boolean {
  /* Ours, reported late. Keep the tail rather than re-deciding it: the bottom may
     have moved since, and the next follow run aims at the new one. */
  if (view.pinned >= 0 && view.scrollTop === view.pinned) return true;
  /* On the tail is on the tail, however the view got there. */
  if (slack(view) <= STICK_PX) return true;
  /* Off the tail, and nothing asked to be: the column moved, not you. */
  if (!view.gestured) return view.following;
  return false;
}

/** One scroller's follow state: whether it is on the tail, and where the follow
 *  last put it. Deliberately not reactive — the two panels that use it read it
 *  nowhere but from the handlers below, and keeping it a plain class is what
 *  keeps it testable without a DOM. */
export class Tail {
  /** Whether new content should carry the view down. Starts armed: a log you
   *  have just opened is showing you its newest line. */
  following = true;

  #pinned = -1;

  /** When the last gesture arrived, or `-1` for none. */
  #gesturedAt = -1;

  /** The clock, injectable for the tests — which have to be able to sit a
   *  gesture more than `GESTURE_MS` in the past without waiting for it. */
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** A hand touched this scroller. Every gesture goes through here, and what it
   *  buys is the right to let go of the tail for the next `GESTURE_MS` — see
   *  `stillFollowing`, which is where the argument for that is written. */
  gestured(): void {
    this.#gesturedAt = this.#now();
  }

  /** A scroll event arrived. */
  scrolled(view: View): void {
    const was = this.#pinned;
    this.following = stillFollowing({
      ...view,
      pinned: this.#pinned,
      following: this.following,
      gestured: gestureLive(this.#gesturedAt, this.#now()),
    });
    /* Consumed: the next event is either ours again (and re-pinned by the follow)
       or a hand on the wheel. */
    if (was >= 0 && view.scrollTop !== was) this.#pinned = -1;
  }

  /** The follow just wrote `top`. Every programmatic trip to the bottom goes
   *  through here, or the next one to be added is the next one to be read as
   *  you scrolling away. */
  landed(top: number): void {
    this.#pinned = top;
  }

  /** Something else is carrying the view; stop following until told otherwise. */
  release(): void {
    this.following = false;
    this.#pinned = -1;
  }

  /** Back on the tail because it was asked for — a command sent, a jump taken.
   *  Not the same as landing there by accident, which `scrolled` decides. */
  resume(): void {
    this.following = true;
    this.#pinned = -1;
    /* And the gesture that came before it is spent. Sending a command in the
       shell is nearly always preceded by scrolling back to read the last one, so
       without this the snap's own scroll event arrives inside the window that
       scroll opened — and if the column grew in between, it is off the tail with
       a gesture vouching for it, which is a resume that releases on the spot. */
    this.#gesturedAt = -1;
  }
}

/* Per-element, so `snapToTail` can find the state belonging to a scroller the
   caller only has a `bind:this` on. Weak because the entry has to go when the
   element does, and a log inside an `{#if}` comes and goes all afternoon. */
const tails = new WeakMap<Element, Tail>();

/** Hear a scroller change shape, from the scroller rather than from whoever
 *  changed it.
 *
 *  Both observers, because a follow needs both halves and they are asked
 *  differently: content arriving moves the bottom away from you, and the
 *  viewport changing rewraps every line of what is already there. The second is
 *  the one nothing in an app's own state announces — a panel dragged narrower is
 *  a taller column, and no signal was written to say so.
 *
 *  `subtree` and `characterData` as well as `childList`, because text arriving is
 *  not always an appended node: a log drawn as an `{#each}` over the last N
 *  lines rewrites the text of the nodes it already has once it is full, so past
 *  that point nothing is ever appended again, and a streaming answer rewrites
 *  the block it is in the middle of.
 *
 *  Returns the teardown. `resized` is separate only because the two can cost
 *  different amounts to answer: a panel that re-measures every mark in itself on
 *  a resize cannot afford to do it once per token. */
export function hearGrowth(
  el: Element,
  grew: () => void,
  resized: () => void = grew,
): () => void {
  const mutated = new MutationObserver(grew);
  mutated.observe(el, { childList: true, subtree: true, characterData: true });
  const sized =
    typeof ResizeObserver === "function" ? new ResizeObserver(resized) : null;
  sized?.observe(el);
  return () => {
    mutated.disconnect();
    sized?.disconnect();
  };
}

/** Stick a scrolling element to its own tail: `{@attach stickToTail}`.
 *
 *  The element is put on its tail once as it mounts, then kept there for as long
 *  as it is near it. Nothing else is required of the component — no state, no
 *  effect, no handler — which is the point, since three panels had three
 *  different partial versions of exactly this. */
export function stickToTail(el: HTMLElement): () => void {
  const tail = new Tail();
  tails.set(el, tail);

  let frame = 0;

  /* On the next frame rather than the moment growth is heard, for two reasons:
     a burst of lines is one write instead of one per line, and `following` is
     asked again when the frame fires, because a frame is long enough to have let
     go of the tail — a wheel event landing between the two would otherwise have
     its decision carried out backwards. */
  const pin = () => {
    frame = 0;
    if (!tail.following) return;
    el.scrollTop = el.scrollHeight;
    tail.landed(el.scrollTop);
  };
  const soon = () => {
    if (!frame && tail.following) frame = requestAnimationFrame(pin);
  };

  const onScroll = () => tail.scrolled(el);
  el.addEventListener("scroll", onScroll, { passive: true });

  /* What a hand on this scroller looks like, which is the whole of what
     `stillFollowing` now needs from the DOM. Capture phase, so a gesture
     answered by something inside the log — a button in a line, a fold — is still
     seen; passive, because none of these is being prevented, only witnessed.

     `pointerdown` covers the scrollbar, whose track and thumb are part of the
     element, and the start of a selection dragged past the edge. `pointermove`
     continues both, and is the one that needs a guard: it fires on every hover,
     which would hold the window permanently open for a cursor resting over the
     panel. A held button is what makes a move a drag. */
  const onGesture = (e: Event) => {
    if (e.type === "pointermove" && (e as PointerEvent).buttons === 0) return;
    tail.gestured();
  };
  const GESTURES = [
    "wheel",
    "keydown",
    "pointerdown",
    "pointermove",
    "touchstart",
    "touchmove",
  ] as const;
  for (const k of GESTURES) {
    el.addEventListener(k, onGesture, { capture: true, passive: true });
  }

  /* Growth and rewrapping both, and neither declared by the component: the
     viewport growing shortens the column below it, and a log dragged taller
     while parked at the bottom should still be at the bottom. */
  const stop = hearGrowth(el, soon);

  el.scrollTop = el.scrollHeight;
  tail.landed(el.scrollTop);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener("scroll", onScroll);
    for (const k of GESTURES) {
      el.removeEventListener(k, onGesture, { capture: true });
    }
    stop();
    tails.delete(el);
  };
}

/** Put a scroller back on its tail and re-arm the follow, because something was
 *  asked for rather than printed — sending a command in the shell is the case:
 *  you want to watch what it does even if you had scrolled back to read what the
 *  last one did. Safe on an element that was never attached.
 *
 *  `snap` rather than `to`, because it is instant: `Transcript.toTail` is the
 *  other kind, a glide you watch, and the two are not interchangeable. A jump you
 *  asked for wants to be seen; a jump that only puts you back where the printing
 *  is wants to be over. */
export function snapToTail(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const tail = tails.get(el);
  tail?.resume();
  el.scrollTop = el.scrollHeight;
  tail?.landed(el.scrollTop);
}
