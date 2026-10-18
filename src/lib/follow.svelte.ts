/* The transcript's follow, as one object any scroller of a conversation can
 * wear: `{@attach follow.attach}`.
 *
 * `follow.ts` holds the judgement and `stickToTail` is the whole of what a plain
 * scroller needs. A conversation's column is not a plain scroller, and the
 * difference is everything in here: it is *carried* (a rail's smooth jump, the
 * run back to the end), a fold opened at the foot of a live turn has to let go
 * of the tail, its `following` is `$state` a mounter's effects read, and a
 * keyboard ladder outside it steps it. All of that was the panel's alone, in
 * `Transcript.svelte`, for as long as there was one reading of a conversation.
 * Chat view is the second (`docs/chat-mode.md` §7.2), and a follow it rebuilt
 * from `stickToTail` would carry you straight past every fold you opened — so
 * the panel's follow moved here whole, and both mount it.
 *
 * Every rule below is the panel's, argued in `.claude/rules/panel.md` and in
 * the comments that came with it. What changed is only where it lives:
 *
 * - **A hand on the column is heard here**, through `witness`, and is the only
 *   thing allowed to let go of the tail (`stillFollowing`'s `gestured`).
 * - **Growth is heard, never declared** (`hearGrowth`), so a rewrap, a fold, a
 *   picture decoding and a `!` run writing into a line all re-pin.
 * - **The thread says when it moved the view on purpose.** Opening a fold, a
 *   find landing on a match, a timeline step revealing its write: each is you
 *   choosing where to read, and the thread raises `RELEASE` on its own element
 *   rather than calling back through a prop. The event bubbles to whatever
 *   scroller the thread is mounted in, so no mounter can forget to wire it.
 */

import { untrack } from "svelte";
import { gestureLive, hearGrowth, stillFollowing, STICK_PX, witness } from "./follow";

/** What a thread raises when it has moved the view on purpose, and the tail
 *  should be let go of. Bubbles to the scroller wearing the follow. */
export const RELEASE = "thread:release";

/** How long after the last scroll event a view being carried counts as having
 *  arrived. Chromium's smooth scroll emits all the way to the end, so this is
 *  measured from the last of them, not from the click. */
export const SETTLE_MS = 120;

/** How long the run back to the tail takes, whatever the distance.
 *
 *  Fixed, which is why `toTail` is hand-run rather than `behavior: "smooth"`:
 *  Chromium scales that duration with the distance, so on a transcript of any
 *  length the way back is a long slow ride to somewhere you asked to be now.
 *  Not instant either — landing at the bottom of a column that looks nothing
 *  like the one you left reads as having been moved rather than having
 *  travelled, and the point of the button is to know where you went. */
export const TAIL_MS = 300;

export class Follow {
  /** Whether the view is parked at the tail. Recomputed on every scroll, so
   *  scrolling back down by hand resumes following without a control to click. */
  following = $state(true);

  #el: HTMLElement | null = null;

  /** Where the follow last put the view, or `-1`.
   *
   *  A write to `scrollTop` does not dispatch its scroll event synchronously: the
   *  event arrives a beat later, and the judgement then asks whether the view is
   *  at the tail. A burst of deltas landing inside that beat moves the bottom out
   *  from under the write, so the answer is about a column that has grown past
   *  the place we aimed at, and the panel silently stopped following.
   *
   *  Measured, not a flag: content landing *below* the view does not change
   *  `scrollTop`, so the event that reports our own write reports exactly the
   *  number we wrote, and anything else is you. */
  #pinned = -1;

  /** When a hand was last on this column, or `-1` for never.
   *
   *  `#pinned` identifies the follow's *own* writes, and that is the smaller
   *  half: the browser moves a scroller too — the clamp when a column gets
   *  shorter, and scroll anchoring when content above the view changes height.
   *  Both arrive as ordinary scroll events in the rendering update's scroll
   *  steps, *before* animation-frame callbacks, so they land in front of the
   *  frame `keepTail` queued. So only a gesture may let go of the tail. */
  #gesturedAt = -1;

  /** The follow's pending frame: one write however many reasons land in it. */
  #holding = 0;
  /** Non-zero while a rail or the run back is carrying the view somewhere. */
  #carrying = 0;
  /** Non-zero while the run back to the tail is in flight. */
  #gliding = 0;

  #resized: () => void;

  /** `resized` is what the mounter does when the viewport changes size, beyond
   *  re-pinning: the panel re-measures its rails, since a rewrap moves every
   *  mark. Separate from growth because a mutation arrives once per token and
   *  a walk of every mark cannot. */
  constructor(resized: () => void = () => {}) {
    this.#resized = resized;
  }

  /** `{@attach follow.attach}` on the scroller. Untracked throughout: nothing
   *  read while wiring the column up may make the wiring depend on it, or every
   *  scroll that lets go of the tail would tear the observers down and build
   *  them again. */
  attach = (el: HTMLElement) =>
    untrack(() => {
      this.#el = el;
      this.keepTail();
      const deaf = hearGrowth(
        el,
        () => this.keepTail(),
        () => {
          this.keepTail();
          this.#resized();
        },
      );
      /* Capture phase and passive, on the scroller and never the window: a
         click on a card is what switches cards, and counting that as a gesture
         in here would read the new card's own settling as a decision. */
      const blind = witness(el, this);
      const onScroll = () => this.#heard();
      /* The wheel outranks a run in progress: without this the frame loop would
         write its next position straight over yours. */
      const onWheel = () => this.stopGlide();
      const onRelease = () => this.release();
      el.addEventListener("scroll", onScroll);
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener(RELEASE, onRelease);
      return () => {
        deaf();
        blind();
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener(RELEASE, onRelease);
        clearTimeout(this.#carrying);
        this.#carrying = 0;
        cancelAnimationFrame(this.#gliding);
        this.#gliding = 0;
        cancelAnimationFrame(this.#holding);
        this.#holding = 0;
        if (this.#el === el) this.#el = null;
      };
    });

  /** A hand was on the column. `witness` calls it; so does anything that moves
   *  the view for a hand the column cannot hear (`stepped`). */
  gestured() {
    this.#gesturedAt = performance.now();
  }

  /** Put the view on the tail, and remember where that turned out to be. Every
   *  programmatic trip to the bottom goes through here, or the next one to be
   *  added is the next one to be read as you scrolling away. */
  pin() {
    const el = this.#el;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    this.#pinned = el.scrollTop;
  }

  /** Put the view back on the tail, if that is still where it belongs.
   *
   *  On the next frame rather than now, because every caller is *inside* the
   *  change: mid-effect and mid-mutation-callback the column still has its old
   *  height. And asked again when the frame fires, not only when it was
   *  scheduled — a frame is long enough to have let go.
   *
   *  `following` is read untracked, so an effect that calls this does not
   *  thereby depend on it: in an effect a condition and a trigger are the same
   *  act unless you separate them (`panel.md`). */
  keepTail() {
    if (this.#holding || !untrack(() => this.following)) return;
    this.#holding = requestAnimationFrame(() => {
      this.#holding = 0;
      if (this.#el && this.following) this.pin();
    });
  }

  /** You chose where to read: a fold worked, a match landed on, a write
   *  revealed. Lets go of the tail for as long as that is true — a shorter
   *  column that clamps the view back onto the tail takes it up again, because
   *  arriving at the bottom is a claim about where the view *is*. */
  release() {
    this.stopGlide();
    this.#pinned = -1;
    this.following = false;
  }

  /** A carried move is starting — a rail's smooth jump. Its own scroll events
   *  say nothing about where you want to be, so they are not judged until
   *  `SETTLE_MS` after the last of them, and `settle` takes the reading then. */
  carry() {
    this.following = false;
    this.#pinned = -1;
    clearTimeout(this.#carrying);
    this.#carrying = window.setTimeout(() => this.#settle(), SETTLE_MS);
  }

  /** The view was moved for a hand the column could not hear — a key read by
   *  the window's ladder with the caret in a field. Said out loud, or the step
   *  could not let go of a live turn; and `#pinned` cleared, so a step landing
   *  exactly on the tail is still read as yours. */
  stepped() {
    this.stopGlide();
    this.gestured();
    this.#pinned = -1;
  }

  /** A different conversation in the same scroller: a fresh view, which starts
   *  at the tail and has no history of gestures or of where the follow pinned.
   *  The gesture is the one that matters — wheel the column and switch inside
   *  `GESTURE_MS`, and the new column's own clamp would arrive with your scroll
   *  of the previous one still vouching for it. */
  fresh() {
    this.stopGlide();
    this.#pinned = -1;
    this.#gesturedAt = -1;
    this.following = true;
  }

  stopGlide() {
    if (!this.#gliding) return;
    cancelAnimationFrame(this.#gliding);
    this.#gliding = 0;
  }

  /** Run back to the tail and take the tail up again on arrival. */
  toTail() {
    const el = this.#el;
    if (!el) return;
    this.stopGlide();
    /* Same carry as the rail's: `following` off so the follow does not teleport
       us there mid-run, and the settle timer to take the reading once the
       movement stops. */
    this.following = false;
    clearTimeout(this.#carrying);
    this.#carrying = window.setTimeout(() => this.#settle(), SETTLE_MS);

    const from = el.scrollTop;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TAIL_MS);
      /* The target is read every frame, not once: a turn streaming while you
         travel moves the bottom. */
      const to = el.scrollHeight - el.clientHeight;
      el.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) {
        this.#gliding = requestAnimationFrame(step);
        return;
      }
      this.#gliding = 0;
      /* Taking the tail back up is the entire gesture, so it is said rather than
         re-derived: `settle` would ask about a column a streaming turn has
         already grown, and answer that the button had not worked. */
      this.pin();
      clearTimeout(this.#carrying);
      this.#carrying = 0;
      this.following = true;
    };
    this.#gliding = requestAnimationFrame(step);
  }

  /** Take the reading once a carried movement stops. */
  #settle() {
    this.#carrying = 0;
    const el = this.#el;
    if (el) this.following = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }

  #heard() {
    const el = this.#el;
    if (!el) return;
    /* A carried view's own scroll events say nothing about where you want to
       be: the first event of a smooth scroll fires with the column barely
       moved, so a column parked at the tail would read as still following and
       be dragged straight back down. */
    if (this.#carrying) {
      clearTimeout(this.#carrying);
      this.#carrying = window.setTimeout(() => this.#settle(), SETTLE_MS);
      return;
    }
    /* The follow's own write, reported a beat after it happened, plus every
       scroll the browser made with no hand behind it. The judgement is
       `stillFollowing`, pure and tested. */
    const was = this.#pinned;
    this.following = stillFollowing({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      pinned: this.#pinned,
      following: this.following,
      gestured: gestureLive(this.#gesturedAt, performance.now()),
    });
    /* Consumed: the next event is either ours again (and re-pinned) or a hand. */
    if (was >= 0 && el.scrollTop !== was) this.#pinned = -1;
  }
}
