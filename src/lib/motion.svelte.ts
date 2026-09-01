/* The one rune behind `motion.ts`, and the attribute the stylesheets read.
 *
 * Shaped like `theme.svelte.ts`'s `Ink` and kept in the same place for the same
 * reason it gives: localStorage is for what is per-machine and disposable, and a
 * setting about *this* machine's GPU is the clearest case of that in the app —
 * carrying it to another machine in the database would be carrying the wrong
 * answer. It holds no subscription, so it needs no place in `Listeners`; if
 * anything is ever added to it that listens, that stops being true.
 *
 * Two windows mean two copies, and the peek re-reads storage every time it
 * appears, so a divergence cannot outlive one notification — the same trade
 * `Ink` documents and for the same reason. */

import { FULL, motionFor, nextMotion, type MotionId } from "./motion";

const MOTION_KEY = "skein.motion";

/** Written on the root element rather than passed down, because the answer is
 *  read by stylesheets in five components and a prop threaded through all of
 *  them is five chances to forget one. */
function paint(id: MotionId) {
  document.documentElement.dataset.motion = id;
}

export class Motion {
  id = $state<MotionId>(FULL);

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MOTION_KEY);
    } catch {
      /* a browser refusing storage is not a reason to start motionless */
    }
    this.id = motionFor(stored);
    paint(this.id);
  }

  set(id: unknown) {
    this.id = motionFor(id);
    paint(this.id);
    /* Written on the switch, not deferred: choosing this is one discrete
       gesture and there is no pointerup afterwards to hang a save on. */
    try {
      localStorage.setItem(MOTION_KEY, this.id);
    } catch {}
  }

  cycle(dir: number = 1) {
    this.set(nextMotion(this.id, dir));
  }
}
