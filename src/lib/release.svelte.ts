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
 *     monitor for a week asks nothing.
 *   - **A floor between asks** (`FLOOR`), so a burst of focus events is one
 *     question. The pending ask is rescheduled, never queued.
 *   - **It stops for good once there is something to say.** `unanswered` in
 *     `update.ts` is that rule, and it is the tightest bound of the three: not a
 *     saving, but the observation that no further ask can change the answer.
 *
 * `BACKSTOP` covers the wall you never look away from, where focus alone would
 * never fire again. It runs only while focused, so it is bounded by the first
 * rule rather than beside it.
 *
 * ### What made the numbers small, and it was not nerve
 *
 * Those bounds were once doing a second job: paying for a request. Unauthenticated
 * `api.github.com` is sixty an hour **from one address**, so a quarter of an hour
 * between asks was the cost argument rather than a guess about how fast anybody
 * needed telling. It was reported as too slow and it was — 0.14.4 was published
 * at 10:18 and reached the header around 10:38.
 *
 * The way out was not to spend more of the budget but to stop spending it.
 * `latest_tag` asks **github.com**, not the API: `HEAD /{repo}/releases/latest`
 * answers `302` with the tag in `Location`, and costs none of the sixty. So the
 * common tick — no newer tag — is free, and `latest_release` is spent only once
 * something has actually changed. That is what pays for a sixty-second backstop.
 *
 * It matters more here than the arithmetic suggests, because that budget is not
 * this app's alone: measured 2026-08-28, the egress this runs behind is a
 * corporate Netskope address with 42 of its 60 already spent by other traffic.
 * On a bucket somebody else keeps emptying, **every failure here is silence by
 * design** — so a rate limit and "no update" look identical, and polling harder
 * would have made the reported symptom worse rather than better.
 *
 * One thing this does not need, and it is worth knowing why: both asks are
 * `async`, so they go through `spawn_blocking` and cannot hold the main thread.
 * Were they not, repeating them would be the `azdo_runs` freeze all over again —
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
  isNewer,
  offerFrom,
  sayProgress,
  unanswered,
  type Latest,
  type Offer,
  type Peek,
  type Stage,
} from "./update";

/* `Stage` lives in `update.ts` now, beside the rule that reads it. Re-exported
   because it is this class's vocabulary as far as everything above is
   concerned. */
export type { Stage };

/** The least time between two asks.
 *
 *  Twenty seconds, and it is only still here to stop a burst of focus events
 *  becoming a burst of requests. It used to be five minutes, because an ask
 *  spent one of sixty API requests an hour; the ask is now github.com's
 *  redirect, which costs none of them, so the floor no longer has a budget to
 *  protect. It is a floor rather than a debounce: the pending ask is moved, not
 *  queued. */
const FLOOR = 20 * 1000;

/** And the backstop, for a window that is never left.
 *
 *  **Sixty seconds, down from fifteen minutes**, and the reason it can be is
 *  that the question got cheap rather than that the old number was timid. See
 *  `latest_tag` in `update.rs`: the tag comes off a `302` from github.com and
 *  spends nothing of the API's per-address budget, so asking once a minute costs
 *  what asking four times an hour used to.
 *
 *  Fifteen minutes was reported, correctly, as too long — 0.14.4 was published
 *  at 10:18 and appeared in the header at about 10:38, because the ticks from
 *  that launch fell at 10:01, 10:16 and 10:31 and only the last of them could
 *  have seen it. Averaging seven and a half minutes late is not what "asked when
 *  you are looking at it" ought to feel like.
 *
 *  Still only while the window is in front, and still stopping for good once
 *  there is something to say. */
const BACKSTOP = 60 * 1000;

/** How often the *expensive* question may be asked, when the cheap one says
 *  there is a reason to.
 *
 *  This is the one budget left to protect, and it protects it in the case that
 *  actually threatens it: a newer tag exists, so every tick wants to resolve it,
 *  and the API is refusing. Without a floor of its own that is sixty API
 *  requests an hour into a bucket that is already empty — pinning it there for
 *  everyone else behind the same address, and for no gain, since the answer that
 *  is failing is the same answer each time.
 *
 *  Measured 2026-08-28: the egress this was written on is a Netskope address
 *  shared company-wide, with 42 of its 60 already spent by other traffic minutes
 *  into the window. The budget is real and it is not ours alone. */
const RESOLVE_FLOOR = 5 * 60 * 1000;

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
  /** And when the *expensive* one last did, which is a separate clock because it
   *  is a separate budget. See `RESOLVE_FLOOR`. */
  #resolvedAt = 0;

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
      /* The cheap question first, and on the overwhelmingly common launch it is
         the only one asked: there is no newer tag, so no API request is spent
         and the next tick is free too. `latest_tag` is a `302` from github.com
         rather than anything on `api.github.com` — see its comment for why that
         distinction is the whole of why this can be asked once a minute. */
      const peek = await invoke<Peek | null>("latest_tag");
      if (!peek || !isNewer(peek.tag, peek.running)) return;

      /* There is something newer. Only now is the API worth spending, because
         only the API knows whether there is an installer this app can drive —
         a tag is a version, not an offer, and `offerFrom` still refuses one
         with no `-setup.exe` beside it. */
      if (Date.now() - this.#resolvedAt < RESOLVE_FLOOR) return;
      this.#resolvedAt = Date.now();

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
