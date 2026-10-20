/* What Skein does when it isn't the window you're looking at.
 *
 * Three layers, quietest first:
 *   1. the taskbar button asks for attention — cheap, native, ignorable
 *   2. the peek window slides in at the corner of the screen, in our design
 *   3. an optional chime, off by default
 *
 * Deliberately not an OS toast. A Windows toast would be the one part of this
 * app wearing somebody else's design, and it disappears before you've read it.
 *
 * A rung countdown is the one item on this ladder that is *not* about being
 * away, and it is the exception in both directions — see `#alarm`.
 *
 * All three go quiet when the user has said they are not here at all. That is
 * away mode (`presence.svelte.ts`), and it is the one thing that silences the
 * countdown as well — see `sync`. */

import { emit, listen } from "@tauri-apps/api/event";
import { askHeadline } from "./asking";
import {
  getCurrentWindow,
  primaryMonitor,
  UserAttentionType,
  Window,
} from "@tauri-apps/api/window";
import type { Conversation } from "./conversation.svelte";
import { clock } from "./conversation.svelte";
import { Listeners } from "./listeners";
import { nameBesideProject } from "./naming";
import { looking } from "./notice";
import { ring } from "./timing";
import {
  causeOf,
  coalesce,
  look,
  LOOKING,
  peekKey,
  toAnnounce,
  unseen,
  type PeekItem,
  type Sight,
} from "./peeking";

/* The item's shape and the two decisions about it — what you have already
   seen, and an account's swarm folded to one row — are pure, in `peeking.ts`. */
export type { PeekItem } from "./peeking";

/** Margin from the screen edge, in logical pixels. */
const EDGE = 18;
/** Matches the peek window size declared in tauri.conf.json. */
const PEEK_W = 420;
const PEEK_H = 210;

/** How finely `touchedAt` moves. Against `LOOK_MS`'s minute, five seconds is
 *  nothing, and it keeps a pointer sweeping the window from being a write per
 *  event. */
const TOUCH_STEP_MS = 5_000;

/** A card must want you for this long before the peek appears. Without it,
 *  every finished turn would throw a window at you the moment you looked away. */
const GRACE_S = 20;

export class Attention {
  /** Off by default: a sound is the most intrusive thing here, and it should
   *  be something you opt into rather than something you have to switch off.
   *
   *  Remembered, because it was not: it came back off on every launch, and the
   *  whole point of turning it on — walk away and come back when it rings — is
   *  lost on the morning you forget to turn it on again. localStorage, the
   *  house rule for what is per-machine: a chime is about this room. */
  #chime = $state(readChime());
  get chime(): boolean {
    return this.#chime;
  }
  set chime(on: boolean) {
    this.#chime = on;
    try {
      localStorage.setItem(CHIME_KEY, on ? "1" : "0");
    } catch {
      /* A setting that cannot be kept is still a setting for this session. */
    }
  }
  /** What has already rung, as `kind:id`, so a ring is news — see `sync`. */
  #rung = new Set<string>();
  enabled = $state(true);

  focused = $state(true);
  /** When the window was last touched — a key, a click, the wheel, the pointer
   *  moving — kept coarse (`TOUCH_STEP_MS`), since it is written from
   *  `pointermove` and every reader of it would otherwise re-run per pixel. */
  touchedAt = $state(Date.now());
  /** Somebody is looking: the window is in front and was touched within
   *  `LOOK_MS` (`notice.ts::looking`). Focus alone is the desk you walked
   *  away from. What decides that a finishing card was *watched* — and so
   *  raises no notice — and what lets reading settle one. */
  looking = $derived(looking({ focused: this.focused, touchedAt: this.touchedAt, now: clock.t }));
  #listeners = new Listeners();
  #peek: Window | null = null;
  #shown = false;
  /** Where you have been looking, folded on every pass — `peeking.ts::look`.
   *  What the peek may say is only what this says you have not seen. */
  #sight: Sight = LOOKING;
  /** What the peek has already announced since you last looked, by key — a
   *  window, a flash and a chime are spent once per piece of news, and a
   *  dismissal is that spending too. */
  #announced = new Set<string>();
  /** When the window last lost focus — `look` dates the leaving from the blur,
   *  not from whichever pass noticed it. */
  #blurredAt: number | null = null;
  /** What the latest unfocused pass would show, so a pass that awaited its way
   *  to `show()` can see that a later one found nothing and take it down again. */
  #latest: PeekItem[] = [];
  #placed = false;
  /** Which alarms have already sounded — see `#alarm`. */
  #sounded: string[] = [];
  /** When this ladder started watching, so an alarm that ran out before it can
   *  be told from one that ran out since. Read off the wall's own tick rather
   *  than `Date.now()`, which is the clock everything else here is compared
   *  against. */
  #watching = clock.t;

  constructor(
    private convs: () => Conversation[],
    private onGoto: (id: string) => void,
    /** Instruments on the wall that are asking for you — a countdown that has
     *  run out. Injected rather than imported for the reason `Widgets.others`
     *  is: the widgets and the conversations each own their own list and neither
     *  may own the other. Defaulted, so nothing that constructs an `Attention`
     *  without a wall has to invent one. */
    private instruments: () => PeekItem[] = () => [],
    /** Whether the user has said they are not here.
     *
     *  Injected for `instruments`' reason, and defaulted to "here" for a
     *  sharper one: every failure in `presence.svelte.ts` resolves to being at
     *  the wall, and a constructor that could not be given this must not be
     *  the thing that silences the ladder. */
    private isAway: () => boolean = () => false,
    /** Notices standing in the queue, one item each — `skein.noticeQueue`
     *  in the peek's words. Injected for `instruments`' reason. */
    private notices: () => PeekItem[] = () => [],
    /** Whether this wall is being driven from outside — the control surface is
     *  armed, which is the lab and `test:wall`. Nobody is at a driven wall, and
     *  somebody *is* at the screen it shares: its peek is an always-on-top
     *  window, so on 2026-10-08 the lab's test notices put a "waiting" panel
     *  over the user's own studio for a minute at a time. Silenced exactly as
     *  away mode silences it, bookkeeping kept. */
    private isDriven: () => boolean = () => false,
    /** Questions parked on cards on *other* walls, as `blocked` rows
     *  (`shadow.ts::remoteQuestions`). Injected for `instruments`' reason, and
     *  on this ladder rather than one of their own: a card on another machine
     *  that stops to ask is the same news as one here, and the whole point of
     *  the flyway is that you need not be looking at the wall to hear it. */
    private elsewhere: () => PeekItem[] = () => [],
  ) {
    this.#wire();
  }

  /** Stop listening — see ./listeners.ts. Without this, an edit in dev leaves a
   *  superseded Attention subscribed, and a single click on the peek asks the
   *  window to unminimise, show and take focus once per generation. */
  detach() {
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async #wire() {
    const main = getCurrentWindow();
    const keep = this.#listeners.keep.bind(this.#listeners);

    /* Registered before the first await, so nothing can slip past while we are
       asking the window whether it has focus. */
    keep(
      main.onFocusChanged(({ payload }) => {
        this.focused = payload;
        /* Bringing the window to the front is a touch of it. */
        if (payload) this.touchedAt = Date.now();
        this.#blurredAt = payload ? null : Date.now();
        /* Coming back to the studio is itself the acknowledgement. */
        if (payload) void this.hide();
      }),
    );

    keep(
      listen<{ id: string }>("peek:goto", async (e) => {
        await this.hide();
        const w = getCurrentWindow();
        await w.unminimize().catch(() => {});
        await w.show().catch(() => {});
        await w.setFocus().catch(() => {});
        this.onGoto(e.payload.id);
      }),
    );

    keep(
      listen("peek:dismiss", () => {
        /* Nothing to write down: everything the peek was showing is already
           in `#announced`, so it stays away until something new arrives. */
        this.#shown = false;
      }),
    );

    const touch = () => {
      const t = Date.now();
      if (t - this.touchedAt >= TOUCH_STEP_MS) this.touchedAt = t;
    };
    const kinds = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
    for (const k of kinds) window.addEventListener(k, touch, { capture: true, passive: true });
    keep(
      Promise.resolve(() => {
        for (const k of kinds) window.removeEventListener(k, touch, { capture: true });
      }),
    );

    this.focused = await main.isFocused().catch(() => true);
  }

  /** Everything that wants you, loudest first. Blocked outranks overdue,
   *  because a blocked agent is stopped rather than merely quiet. */
  items = $derived.by<PeekItem[]>(() => {
    const out: PeekItem[] = [];
    /* A card with a notice is said once, by the notice: its `failed` or
       `overdue` reading is the same news, older and vaguer. */
    const noticed = this.notices();
    const told = new Set(noticed.map((n) => n.id));
    out.push(...noticed);
    for (const c of this.convs()) {
      /* A card with no process cannot want anything. Restoring the wall from
         disk brings back whatever ending each card closed on, so without this a
         conversation that errored last week announces itself as failed the first
         time you look away — for a session that isn't even running. A card that
         died on us in *this* session is the exception, and the one case here
         worth a window: that is news, and nothing else reports it. */
      if (c.dormant && !c.died) continue;
      if (c.pendingAsk) {
        /* Keyed and dated by the *newest* ask, not the one drawn: a card can
           hold several (a subagent asking behind its parent's question), and a
           second question arriving after you left is news even though the card
           was already blocked on one you had seen. */
        const newest = c.asks[c.asks.length - 1] ?? c.pendingAsk;
        out.push({
          id: c.id,
          project: c.project,
          title: nameBesideProject(c.title),
          kind: "blocked",
          /* The peek's line is nowrap with an ellipsis, so a question body put
             here is a cut-off paragraph naming nothing — and a call carrying
             several would name only the first. `askHeadline` gives one question
             its own words and several the headers that exist for this. */
          detail: askHeadline(c.pendingAsk.questions),
          waitedSeconds: Math.floor((clock.t - c.pendingAsk.since) / 1000),
          key: newest.askId,
          since: newest.since,
        });
      } else if (told.has(c.id)) {
        continue;
      } else if (c.tier === "fail") {
        out.push({
          id: c.id,
          project: c.project,
          title: nameBesideProject(c.title),
          kind: "failed",
          detail: c.lastError ?? "stopped",
          waitedSeconds: c.idleSeconds,
          /* A card that died at rest is still counting idle from its last
             turn, so its death is dated by itself. */
          since: c.died && c.diedAt !== null ? c.diedAt : clock.t - c.idleSeconds * 1000,
          /* An allowance that ran out, which `coalesce` folds with every other
             card it caught on the same account. */
          cause: causeOf(c.lastFault, c.accountLabel),
        });
      } else if (c.tier === "ask" && c.idleSeconds >= GRACE_S) {
        out.push({
          id: c.id,
          project: c.project,
          title: nameBesideProject(c.title),
          kind: "overdue",
          detail: c.activity,
          waitedSeconds: c.idleSeconds,
          /* The rest it reports was on the wall `GRACE_S` before this row was
             on the ladder — which is the whole reason `since` exists. */
          since: clock.t - c.idleSeconds * 1000,
        });
      }
    }
    /* A question on another wall, already only the ones this wall may answer
       — none from a wall gone quiet, none whose answer is on its way. */
    out.push(...this.elsewhere());
    /* No grace period for an instrument, unlike an overdue card: you set the
       thing yourself and asked to be told, so waiting twenty seconds before
       saying so would be the wall second-guessing an explicit instruction. */
    out.push(...this.instruments());

    /* A crash is news and a rung timer is an appointment, so `failed` outranks
       it; a blocked agent outranks both, being genuinely stopped. */
    const rank = { blocked: 0, notice: 1, failed: 2, rang: 3, overdue: 4 } as const;
    return coalesce(out).sort(
      (a, b) => rank[a.kind] - rank[b.kind] || b.waitedSeconds - a.waitedSeconds,
    );
  });

  async #peekWindow(): Promise<Window | null> {
    if (this.#peek) return this.#peek;
    this.#peek = await Window.getByLabel("peek");
    return this.#peek;
  }

  /** Bottom-right, above the taskbar. Placed once, then left where it is. */
  async #place(w: Window) {
    if (this.#placed) return;
    try {
      const mon = await primaryMonitor();
      if (!mon) return;
      const s = mon.scaleFactor || 1;
      const sw = mon.size.width / s;
      const sh = mon.size.height / s;
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      await w.setPosition(
        new LogicalPosition(sw - PEEK_W - EDGE, sh - PEEK_H - EDGE - 48),
      );
      this.#placed = true;
    } catch {
      /* An unplaced peek in the wrong corner still beats no peek at all. */
    }
  }

  async hide() {
    this.#shown = false;
    const w = await this.#peekWindow();
    await w?.hide().catch(() => {});
  }

  /** Alarms that have sounded, so a wall test can see a bell that never rang.
   *  There is nothing in the DOM for a sound, and `chime` says only whether one
   *  is permitted — the same argument `meter.sampling` makes. */
  get sounded(): readonly string[] {
    return this.#sounded;
  }

  /** Sound a countdown that has just run out.
   *
   * The one thing on this ladder that happens **whether or not you are looking
   * at the wall**. Everything else here is a report of what you missed while
   * away, and the peek is right to stay hidden while you are here — the widget
   * going amber is that report, on screen, where you already are. A sound is
   * not: an alarm you only hear if you had wandered off is not an alarm, and
   * "tell me when this reaches zero" is the entire reason anybody sets one.
   *
   * It also ignores `chime`, which is the header switch for *cards*. A card
   * speaks on its own schedule and a sound for it is an interruption you opt
   * into; a countdown makes noise because you asked it to, the same argument
   * that already exempts one from `GRACE_S`. Not ringing something you set by
   * hand, on the grounds of a switch about something else, is the kind of quiet
   * that reads as broken.
   *
   * Both rules about *when* are in `timing.ts::ring`, where they are testable. */
  #alarm(items: PeekItem[], mute = false): boolean {
    const alarms = items
      .filter((i) => i.kind === "rang")
      .map((i) => ({ id: i.id, overrun: i.waitedSeconds }));
    const { fresh, sounded } = ring(
      alarms,
      this.#sounded,
      (clock.t - this.#watching) / 1000,
    );
    this.#sounded = sounded;
    /* One bell for however many went off together: two overlapping chimes is
       noise rather than two pieces of news. */
    if (!fresh.length) return false;
    if (!mute) sound("rang");
    return true;
  }

  /** Called on a tick from the studio. Idempotent — it only acts on change. */
  async sync() {
    const items = this.items;

    /* Where you have been looking, folded before anything can return early —
       ahead of `enabled` and of away mode both. `look` forgets a key the moment
       it leaves the ladder, and a pass that did not run would miss the leaving:
       a card answered and asking again would read as the question you saw
       before you left. See `peeking.ts`. */
    this.#sight = look(this.#sight, items, this.focused, Date.now(), this.#blurredAt);

    if (!this.enabled) return;

    /* Away mode, and it silences the whole ladder rather than one rung of it.
       `enabled` is a preference about whether Skein may interrupt you; this is
       a statement that there is nobody to interrupt — so it takes the rung
       countdown too, which `#alarm` is otherwise deliberately exempt from. That
       exemption is argued from "an alarm you only hear if you had wandered off
       is not an alarm", and the argument runs out here: away is not having
       wandered off, it is having gone home, and a bell in an empty room is
       noise for whoever *is* in the room.

       **It is muted rather than skipped**, which is the half that is not
       obvious. `ring` answers "what is newly overrun" by comparing against what
       has already sounded, so a pass that does not run leaves every alarm that
       went off overnight looking fresh — and the first tick after you come back
       would play all of them at once, hours late, which is the one thing worse
       than ringing in an empty room. Muting keeps the bookkeeping and drops
       only the sound. */
    const away = this.isAway() || this.isDriven();

    /* Before the focused early-return below, which is what makes an alarm
       audible while you are at the wall. */
    const rang = this.#alarm(items, away);

    /* What is new since the last ring, among the things that are news — a
       question parked or a notice raised. Kept current while away for
       `#alarm`'s reason: a pass that skipped the bookkeeping would come back
       to a pile of things that all look fresh, and ring them together. */
    const urgent = items.filter((i) => i.kind === "blocked" || i.kind === "notice" || i.rings);
    const keyOf = peekKey;
    /* And only what arrived since this ladder started watching: a notice that
       stood across a restart is not news on launch, and ringing for every one
       of them each time the wall opens is the bell crying wolf. */
    const since = (clock.t - this.#watching) / 1000 + 1;
    const fresh = urgent.filter((i) => !this.#rung.has(keyOf(i)) && i.waitedSeconds <= since);
    this.#rung = new Set(urgent.map(keyOf));

    if (away) {
      /* Hidden rather than merely not shown: going away with a peek on screen
         must take it down, or away mode begins with the exact thing it exists
         to prevent still sitting in the corner. */
      this.#latest = [];
      if (this.#shown) await this.hide();
      this.#announced = new Set();
      return;
    }

    // Focused, or nothing wants you: make sure the peek is away.
    if (this.focused || items.length === 0) {
      this.#latest = [];
      if (this.#shown) await this.hide();
      this.#announced = new Set();
      /* **The chime is not a peek, and focus is not presence.** The window is
         in front on the desk you walked away from — that is the ordinary way
         to leave it — so a bell that only rang when another app had focus
         rang for nobody in exactly the case it is for. The user's words: the
         chime is so they need not sit at the computer and can come back when
         it rings. So a new question or notice rings here too; the peek and the
         taskbar flash, which are for a window you cannot see, do not. */
      if (this.chime && !rang && fresh.length) {
        sound(fresh.some((i) => i.kind === "blocked") ? "blocked" : "overdue");
      }
      return;
    }

    /* **Only what you have not seen.** This used to be every item on the
       ladder, so going to another window threw the peek up at once with the
       wall's whole standing state in it — questions, failures and finished
       cards you had been looking at a moment before. Lyss: "nonsensical
       because I was already on the wall so I know what was going on". What it
       shows now is what arrived after you left, and only that; everything you
       left behind is still on the wall, which is where you will see it. */
    const shown = unseen(items, this.#sight);
    const { news, announced } = toAnnounce(shown, this.#announced);
    this.#announced = announced;
    this.#latest = shown;
    if (shown.length === 0) {
      if (this.#shown) await this.hide();
      return;
    }

    /* Kept current while it is up, so a row answered elsewhere leaves it. */
    void emit("peek:set", { items: shown });
    /* A window, a flash and a chime once per piece of news. What is already
       announced, or was dismissed, stays down until something new arrives. */
    if (!news.length) return;

    const w = await this.#peekWindow();
    if (!w) return;
    await this.#place(w);
    await w.show().catch(() => {});
    /* Never steal focus — the peek is a glance, not an interruption. */
    this.#shown = true;
    /* A later pass may have run while this one awaited — the window came back
       to the front, or the row was answered — and found nothing to show. It
       could not hide a peek that was not up yet, so this pass does. */
    if (this.#latest.length === 0) {
      await this.hide();
      return;
    }

    await getCurrentWindow()
      .requestUserAttention(UserAttentionType.Informational)
      .catch(() => {});

    /* Not when the alarm has just rung this same tick: a countdown that ran out
       while you were away is one piece of news, and it has already been said.
       And a question or notice only if it is fresh on the bell's own books,
       which is what keeps one that stood across a restart from ringing. */
    const freshKeys = new Set(fresh.map(keyOf));
    const rings = news.filter(
      (i) => (i.kind !== "blocked" && i.kind !== "notice" && !i.rings) || freshKeys.has(keyOf(i)),
    );
    if (this.chime && !rang && rings.length) {
      sound(rings.some((i) => i.kind === "blocked") ? "blocked" : "overdue");
    }
  }
}

/** The figure each kind of thing rings with.
 *
 * Soft sine tones synthesised on the spot rather than shipped as an asset, so
 * they read as a bell rather than a system alert. Three figures rather than one
 * because telling them apart *without looking* is the whole point of a sound —
 * and an alarm you set is a different piece of news from an agent that stopped.
 * `rang` is three notes and the only rising arpeggio: two soft tones is the
 * house chime, and a countdown finishing should not be mistakable for a card. */
const CHIME_KEY = "skein.chime";

function readChime(): boolean {
  try {
    return localStorage.getItem(CHIME_KEY) === "1";
  } catch {
    return false;
  }
}

const TONES: Record<"blocked" | "overdue" | "rang", number[]> = {
  blocked: [587.33, 880.0],
  overdue: [523.25, 783.99],
  rang: [783.99, 1046.5, 1318.51],
};

function sound(kind: keyof typeof TONES) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    /* A context built without a gesture behind it starts suspended, and an
       alarm is exactly the case where that happens — the wall may have been
       sitting untouched for the whole countdown. Nothing to await: resuming is
       a no-op when it is already running, and the notes are scheduled against
       `currentTime` either way. */
    void ctx.resume?.().catch(() => {});
    const now = ctx.currentTime;
    const notes = TONES[kind];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const at = now + i * 0.11;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.075, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1);
    });
    setTimeout(() => void ctx.close(), 1400);
  } catch {
    /* No audio device is not an error worth surfacing. */
  }
}
