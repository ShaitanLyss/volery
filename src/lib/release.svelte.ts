/* Whether a newer Volery is out, and getting onto it.
 *
 * The reader the header watches, on `ledger.svelte.ts`'s pattern and named the
 * same way — for what the subsystem *is* rather than for the module it serves.
 * `update.svelte.ts` is the name this wanted and cannot have: on a
 * case-insensitive filesystem it collides with anything called `Update.svelte`,
 * which is the trap `waterfall.svelte.ts` is named around and which `svelte-check`
 * refuses outright. There is no `Update.svelte` today; there is no reason to
 * leave the collision lying there for whoever writes one.
 *
 * `update.ts` beside it is pure and holds every judgement — is that tag newer,
 * can that file be installed, what is any of it called. What is here is only the
 * asking and the doing: one call to GitHub, one download, and an arming.
 *
 * ### Asked when you are looking at it, and not otherwise
 *
 * GitHub does not tell anybody a tag appeared, so this has to go and look. It
 * used to look exactly *once*, when the wall was painted, on the argument that
 * the answer only had to be right by tomorrow morning. That was true of the
 * answer and wrong about the wall: this app is left running for days, so "once
 * at launch" meant a release cut on Tuesday was invisible until something else
 * made you restart — and a wall opened with no network never checked again at
 * all, which is the failure that settled it.
 *
 * So it is asked again, and the shape is deliberately **not** a clock. Focus is
 * an event, `attention.focused` already folds it, and `App.svelte` hands it here
 * — so the common trigger is you coming back to the window, which is also the
 * moment the answer is worth having. Three bounds, and each is doing a job:
 *
 *   - **Only while the window is in front.** A wall left open on a second
 *     monitor for a week asks nothing. This is the whole of the cost argument:
 *     unauthenticated GitHub is sixty an hour from one address, and asking only
 *     while somebody is looking is what keeps a long-running wall from spending
 *     any of it.
 *   - **A floor between asks** (`FLOOR`), so alt-tabbing forty times costs one
 *     question rather than forty. The pending ask is rescheduled, never queued.
 *   - **It stops for good once there is something to say.** `unanswered` in
 *     `update.ts` is that rule, and it is the tightest bound of the three: not a
 *     saving, but the observation that no further ask can change the answer.
 *
 * `BACKSTOP` covers the wall you never look away from, where focus alone would
 * never fire again. It runs only while focused, so it is bounded by the first
 * rule rather than beside it.
 *
 * One thing this does not need, and it is worth knowing why: `latest_release` is
 * `async`, so it goes through `spawn_blocking` and cannot hold the main thread.
 * Were it not, repeating it would be the `azdo_runs` freeze all over again —
 * every card on the wall unpainted for the length of a network request. See
 * CLAUDE.md on `off_main` before making anything here more frequent.
 *
 * ### Every failure is silence on the wall
 *
 * No network, GitHub down, a rate limit, a tag nothing can order: all of it
 * leaves the header exactly as it was. `fault` is kept so a wall test can see
 * what happened, and nothing draws it — an app that reported its own inability
 * to check for updates, in the chrome, every launch, would be an app nagging
 * about its own plumbing. The one failure that *is* drawn is one you asked for:
 * a download that broke after you pressed the button. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  offerFrom,
  sayProgress,
  unanswered,
  type Latest,
  type Offer,
  type Stage,
} from "./update";

/* `Stage` lives in `update.ts` now, beside the rule that reads it. Re-exported
   because it is this class's vocabulary as far as everything above is
   concerned. */
export type { Stage };

/** The least time between two asks.
 *
 *  Five minutes, so coming back to the window is free however often you do it.
 *  It is a floor rather than a debounce: the pending ask is moved, not queued, so
 *  forty alt-tabs inside five minutes cost one question. */
const FLOOR = 5 * 60 * 1000;

/** And the backstop, for a window that is never left.
 *
 *  Fifteen minutes. It only runs while the window is in front, so the arithmetic
 *  that matters is four questions an hour against the sixty an hour
 *  unauthenticated GitHub allows one address — and only until there is something
 *  to say, at which point it stops for good. A release is not cut often enough
 *  for a tighter number to buy anything a person would notice. */
const BACKSTOP = 15 * 60 * 1000;

export class Releases {
  /** The update worth taking, or null — which is every launch but a few. */
  offer = $state<Offer | null>(null);
  stage = $state<Stage>("quiet");
  /** What the button says under itself while it works. */
  note = $state<string | null>(null);
  /** Kept for the control surface and never drawn. See the module note. */
  fault = $state<string | null>(null);

  #unlisten: UnlistenFn | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last question actually went out, for the floor to measure from.
   *  Zero means never, so the first call asks immediately. */
  #askedAt = 0;

  /** Tell this whether the window is in front. Everything follows from that.
   *
   *  Called from an `$effect` in `App.svelte` reading `attention.focused`, which
   *  means it runs once at mount and once per focus change — so there is no
   *  separate "start" and the class holds no idea of whether it has begun. That
   *  also makes it safe under a hot edit that mounts `App.svelte` twice: the
   *  second effect clears the first's timer before setting its own, where a
   *  `#started` guard would have had to be reset by hand.
   *
   *  Idempotent for the same focus value, because the pending ask is cleared and
   *  rescheduled rather than added to. */
  watch(focused: boolean) {
    this.#stop();
    if (!focused || !unanswered(this.stage)) return;
    /* Whatever is left of the floor, or nothing if it has already passed. A
       first call at launch therefore asks on this tick. */
    const wait = Math.max(0, FLOOR - (Date.now() - this.#askedAt));
    this.#timer = setTimeout(() => void this.#tick(), wait);
  }

  /** Ask, then arrange to ask again unless there is now something to say. */
  async #tick() {
    this.#timer = null;
    await this.check();
    if (!unanswered(this.stage)) return;
    this.#timer = setTimeout(() => void this.#tick(), BACKSTOP);
  }

  /** Ask GitHub. Public because the control surface and a hand may both want to
   *  ask *now* without waiting for a focus change or a backstop. */
  async check() {
    this.#askedAt = Date.now();
    try {
      const latest = await invoke<Latest | null>("latest_release");
      const offer = offerFrom(latest);
      /* Asked again after the reply went out, not before: this is the guard
         against a question in flight when the button is pressed. Without it an
         answer landing a moment later would put `offered` back over a download
         already three megabytes in. See `unanswered` in `update.ts`. */
      if (offer && unanswered(this.stage)) {
        this.offer = offer;
        this.stage = "offered";
      }
    } catch (e) {
      /* The stage is deliberately untouched, so the question stays open and the
         next ask picks it up — a wall opened with no network now recovers, which
         asking once a launch could never do. */
      this.fault = String(e);
    }
  }

  #stop() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Download the installer and arm it for the way out.
   *
   *  It does **not** close the window, and that is `update.rs`'s reasoning from
   *  this end: quitting can be refused, and an installer already running while
   *  somebody chooses to stay would be rewriting a live exe. So this arms, and
   *  the caller closes the window through the ordinary path — where the wall
   *  gets to ask about its own background work first, exactly as it does for a
   *  quit nobody is updating for. */
  async fetch(): Promise<boolean> {
    const offer = this.offer;
    if (!offer || this.stage === "fetching") return false;
    this.stage = "fetching";
    this.note = sayProgress(0, offer.size);
    /* Attached before the call and released whatever happens, or a download
       that failed leaves a subscription behind — the `Listeners` rule one layer
       down, in the one place here that takes one out. */
    this.#unlisten = await listen<{ got: number; total: number }>(
      "update:progress",
      (e) => {
        this.note = sayProgress(e.payload.got, e.payload.total);
      },
    );
    try {
      const path = await invoke<string>("fetch_update", { url: offer.url });
      await invoke("arm_update", { path });
      this.stage = "armed";
      this.note = null;
      return true;
    } catch (e) {
      /* Drawn, unlike everything else here: you pressed a button and it did not
         happen, and the version you are on is still the one you have. */
      this.stage = "failed";
      this.fault = String(e);
      this.note = String(e);
      return false;
    } finally {
      this.#unlisten?.();
      this.#unlisten = null;
    }
  }

  /** Released from `App.svelte`'s `onDestroy`, like everything else holding a
   *  Tauri subscription — and now a timer, which CLAUDE.md's `Listeners` note
   *  says needs the same care. A superseded instance still asking GitHub every
   *  quarter of an hour is exactly the leak that rule exists for. */
  release() {
    this.#unlisten?.();
    this.#unlisten = null;
    this.#stop();
  }
}

export const releases = new Releases();
