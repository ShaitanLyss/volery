/* Where the user is, and what piled up while they were not here.
 *
 * Rust owns the *fact* — `presence.rs`, because it is read on the thread
 * answering an `ask_user` with no webview in sight, and because it has to
 * survive a restart. This owns the wall's reading of it: the pile, the knobs,
 * and the one gesture that ends away mode.
 *
 * The knobs are localStorage, with the motion setting and the theme skin, per
 * this app's rule that per-machine and disposable lives there. That is also
 * what keeps `presence` in SQLite at one nullable column rather than growing
 * one per taste — see `store::migrate_v38`.
 *
 * Holds a subscription, so it owes `Listeners` and a `detach`. See the note in
 * CLAUDE.md on what a superseded instance goes on doing.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { normalizeAsk, blankAnswers } from "./asking";
import { Listeners } from "./listeners";
import {
  isAwayScreen,
  pileOf,
  waitingCount,
  type AwayScreen,
  type Deferred,
  type Pile,
} from "./presence";

const ANIMATE_KEY = "skein.away.animate";
const SCREEN_KEY = "skein.away.screen";
const TOYS_KEY = "skein.away.toys";

type DeferredRow = {
  id: string;
  conversation_id: string;
  ask: Record<string, unknown>;
  asked_at: number;
};

function stored(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a browser refusing storage is not a reason to refuse the setting */
  }
}

export class Presence {
  /** When you went away, in epoch ms, or `null` for here. */
  awaySince = $state<number | null>(null);
  /** What was said on the way out, where a card was the one told. */
  note = $state<string | null>(null);
  /** Who flipped it last — `"you"`, or a card's handle. */
  by = $state("you");

  /** Everything owed an answer. */
  asks = $state<Deferred[]>([]);

  /** Whether the wall animates while away. On by default: a dark window is
   *  indistinguishable from a crashed one, and the whole of what away mode
   *  gives back is that the machine is visibly still yours. */
  animate = $state(stored(ANIMATE_KEY, true));
  /** How much of the wall the away screen takes. */
  screen = $state<AwayScreen>("takeover");
  /** Whether a small puzzle stands between you and the wall on the way back. */
  toys = $state(stored(TOYS_KEY, true));

  /** The pile is open. Set when away ends with something waiting, and by the
   *  header button; cleared when the last question is answered or you shut it.
   *  Held here rather than in `App.svelte` because `endAway` is what opens it
   *  and that is a verb on this class. */
  showing = $state(false);

  #listeners = new Listeners();

  constructor() {
    try {
      const s = localStorage.getItem(SCREEN_KEY);
      if (isAwayScreen(s)) this.screen = s;
    } catch {}
    void this.#load();
    this.#wire();
  }

  detach() {
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  get away(): boolean {
    return this.awaySince !== null;
  }

  /** How long away mode has stood, in ms. Zero when you are here. */
  elapsed(now: number): number {
    return this.awaySince === null ? 0 : Math.max(0, now - this.awaySince);
  }

  pile = $derived<Pile>(pileOf(this.asks));
  waiting = $derived(waitingCount(this.asks));

  async #load() {
    try {
      const s = await invoke<{ away_since: number | null; note: string | null }>(
        "presence_read",
      );
      this.awaySince = s.away_since;
      this.note = s.note;
    } catch {
      /* A wall that cannot read its own presence is a wall that is here, which
         is how this app behaved for its whole life before away mode. The
         failure must not be able to silence the notifications. */
    }
    await this.refresh();
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);
    keep(
      listen<{ away_since: number | null; note: string | null; by: string }>(
        "presence:changed",
        (e) => {
          this.awaySince = e.payload.away_since;
          this.note = e.payload.note;
          this.by = e.payload.by;
          /* A card put the wall away — the pile is about to start filling, and
             nothing else would have told us. */
          if (e.payload.away_since !== null) void this.refresh();
        },
      ),
    );
    keep(
      listen<{ conversation_id: string; id: string; asked_at: number }>(
        "ask:deferred",
        () => void this.refresh(),
      ),
    );
  }

  /** Re-read the pile. Cheap — it is a table with tens of rows at worst, and
   *  the bound in `presence::MAX_PER_CARD` is what keeps that true. */
  async refresh() {
    try {
      const rows = await invoke<DeferredRow[]>("deferred_asks");
      /* Normalized here, exactly as a live `ask:opened` is: Rust decides
         nothing about what a question is, and a row written by an older build
         degrades rather than refusing. See `normalizeAsk`. */
      this.asks = rows.map((r) => {
        const questions = normalizeAsk(r.ask ?? {});
        const was = this.asks.find((a) => a.id === r.id);
        return {
          id: r.id,
          conversationId: r.conversation_id,
          questions,
          /* Answers already given survive a refresh — a card asking a new
             question while you are halfway through the pile must not clear
             the sheet you are standing in. */
          answers: was?.answers ?? blankAnswers(questions),
          askedAt: r.asked_at,
        };
      });
    } catch {
      /* Leave the pile as it was. An empty list here would read as "nothing
         was asked", which is the one wrong answer. */
    }
  }

  /** Everything this card asked while you were out. */
  forCard(id: string): Deferred[] {
    return this.asks.filter((a) => a.conversationId === id);
  }

  async goAway(note?: string) {
    try {
      const since = await invoke<number | null>("set_presence", {
        away: true,
        note: note ?? null,
      });
      this.awaySince = since;
      this.note = note ?? null;
      this.by = "you";
    } catch {
      /* Nothing silently half-on: if Rust refused, the wall is still here and
         the switch should read that way. */
      await this.#load();
    }
  }

  /** Come back. Returns whether there is a pile to read, which is what decides
   *  the gesture after the unlock gate. */
  async comeBack(): Promise<boolean> {
    try {
      await invoke("set_presence", { away: false, note: null });
      this.awaySince = null;
      this.note = null;
      this.by = "you";
    } catch {
      await this.#load();
    }
    await this.refresh();
    this.showing = this.asks.length > 0;
    return this.asks.length > 0;
  }

  /** Claim one, so it cannot be answered twice. The answer is sent *after*
   *  this returns true — `later::serve_due`'s ordering, and its reasoning: an
   *  interruption between the two loses an answer, where the other way round
   *  hands a card the same decision twice. */
  async claim(id: string): Promise<boolean> {
    try {
      const took = await invoke<boolean>("take_deferred_ask", { id });
      if (took) this.asks = this.asks.filter((a) => a.id !== id);
      if (!this.asks.length) this.showing = false;
      return took;
    } catch {
      return false;
    }
  }

  setAnimate(on: boolean) {
    this.animate = on;
    write(ANIMATE_KEY, on ? "1" : "0");
  }

  setScreen(s: AwayScreen) {
    this.screen = s;
    write(SCREEN_KEY, s);
  }

  setToys(on: boolean) {
    this.toys = on;
    write(TOYS_KEY, on ? "1" : "0");
  }
}
