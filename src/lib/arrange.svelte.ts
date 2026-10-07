import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import { NO_ARRANGEMENT, fingerprint, nearest, type Known, type Screen } from "./arrange";

/* Which screen arrangement the glass is currently being arranged in.
 *
 * One for the window, so a module-level instance — `span.svelte.ts` next door
 * is the same shape and for the same reason: the thing that toggles the spread
 * and the thing that lays itself out by it are not parent and child.
 *
 * What an arrangement *is* and which known one a new one is most like are
 * `arrange.ts`, pure and tested. What is on the glass in one is `arrange.rs`.
 * This is only the three questions in between: what is in front of me, has it
 * changed, and what did the store say about it.
 *
 * Holds no subscription, so it has nothing to release. */

/** A spot per id, for each of the five things that can stand on the glass.
 *  `arrange.rs::GlassSpots`. */
export type GlassSpots = {
  cards: Record<string, [number, number]>;
  territories: Record<string, [number, number]>;
  images: Record<string, [number, number]>;
  widgets: Record<string, [number, number]>;
  timelines: Record<string, [number, number]>;
};

type Row = { key: string; screens: string; seenAt: number };

class Arrangements {
  /** The fingerprint of the room the glass is in, or `NO_ARRANGEMENT` before
   *  the monitors have answered. */
  key = $state(NO_ARRANGEMENT);
  /** Its shape, for anybody who wants to say something about it. */
  screens = $state<Screen[]>([]);
  /** The last thing that went wrong looking, so a failure is visible rather
   *  than a glass that quietly stopped following the screens. */
  fault = $state<string | null>(null);
  /** A settle in flight. Two at once would race to be current, and the loser
   *  would leave the columns holding one arrangement and the flag naming the
   *  other — which nothing afterwards could tell apart. */
  #busy = false;
  /** Somebody asked while one was in flight, so ask again when it lands.
   *
   *  **Dropping the second call was wrong, and the dropped one is the one that
   *  matters.** `settle` is asked from an effect that only re-fires on focus or
   *  on the spread, and `span.count()` runs `toggle()` from *inside* a focus —
   *  so the spread flips while a focus-triggered settle is three IPC round
   *  trips deep, the call that would have noticed is thrown away, and nothing
   *  asks again until something happens to change focus. Until then
   *  `arrangement.current` names the room you just left while the pane is the
   *  other room's geometry, and every drag writes this room's coordinates into
   *  that one's rows. That is exactly the corruption the per-arrangement design
   *  exists to prevent, reached from the front end instead of the debounce. */
  #again = false;

  /** The screens the glass is actually spread across.
   *
   *  Spread, that is every monitor; unspread, it is the one the window is on
   *  and only that one — which is the whole distinction being drawn. Plugging
   *  a second screen in therefore changes nothing while the window sits on the
   *  first, and that is right: the room the glass is in did not change.
   *
   *  An empty answer rather than a throw: a monitor enumeration that fails is
   *  a reason to leave the arrangement alone, not a reason for anything to
   *  stop. */
  async look(spread: boolean): Promise<Screen[]> {
    try {
      const ms = spread ? await availableMonitors() : [await currentMonitor()];
      return ms
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({
          x: m.position.x,
          y: m.position.y,
          w: m.size.width,
          h: m.size.height,
          scale: m.scaleFactor,
        }));
    } catch (err) {
      this.fault = String(err);
      return [];
    }
  }

  /** Make sure the store is pointed at the room in front of you, and answer
   *  what is on the glass there — or null when nothing has changed, which is
   *  almost every call, since this is asked on every return to the window.
   *
   *  The ancestor is chosen here rather than in Rust so the metric lives in the
   *  one file with the tests around it; the store is told which arrangement to
   *  copy and does the copying.
   *
   *  `origin` is where the pane's own top-left sits inside the glass — zero on
   *  one screen, the home screen's offset while spread. The store keeps it per
   *  arrangement and shifts a *copied* arrangement by the difference, so the
   *  first spread finds the glass where it already was rather than piled onto
   *  whichever monitor the union starts at. Nothing else reads it. */
  async settle(spread: boolean, origin: [number, number]): Promise<GlassSpots | null> {
    if (this.#busy) {
      /* Remembered rather than queued: the answer a second caller wants is
         "whatever the screens are once this has landed", and that is one more
         pass rather than one per caller. The arguments are not kept either —
         `#rerun` reads the live ones, since a stale `spread` is the thing this
         is here to stop believing. */
      this.#again = true;
      return null;
    }
    this.#busy = true;
    try {
      const screens = await this.look(spread);
      const key = fingerprint(screens);
      /* Nothing usable, or the same room as last time. The early return is on
         the *key* rather than on the monitor list, so a screen that reports a
         pixel differently between two calls does not fork an arrangement. */
      if (key === NO_ARRANGEMENT || key === this.key) return null;

      let known: Known[] = [];
      try {
        const rows = await invoke<Row[]>("known_arrangements");
        known = rows.map((r) => ({
          key: r.key,
          screens: parse(r.screens),
          seenAt: r.seenAt,
        }));
      } catch (err) {
        /* A first sighting with no ancestor named falls back to whatever is on
           the glass right now, which is a worse answer than the nearest room
           but a much better one than refusing to follow the screens at all. */
        this.fault = String(err);
      }

      const spots = await invoke<GlassSpots | null>("adopt_arrangement", {
        key,
        screens: JSON.stringify(screens),
        origin,
        cloneFrom: nearest(screens, known)?.key ?? null,
      });
      this.key = key;
      this.screens = screens;
      this.fault = null;
      return spots;
    } catch (err) {
      this.fault = String(err);
      return null;
    } finally {
      this.#busy = false;
      if (this.#again) {
        this.#again = false;
        /* Out of this call's stack, so a caller awaiting the first settle is
           not also awaiting the second — and so a pathological flapping
           arrangement cannot recurse. `rerun` is what `App.svelte` registered
           at startup; with nothing registered the catch-up is simply not
           available, which is the honest state for a module nobody has wired. */
        queueMicrotask(() => void this.rerun?.());
      }
    }
  }

  /** Ask the thing that knows the live arguments to settle again.
   *
   *  Set once by `App.svelte`. It is a hook rather than a stored argument list
   *  because the whole point of the second pass is that the first pass's
   *  `spread` and `origin` are the ones that went stale. */
  rerun: (() => void) | null = null;
}

/** A stored shape, or nothing. Opaque to Rust and written by us, so the only
 *  way it is malformed is a build that wrote it differently — in which case an
 *  arrangement that scores zero against everything is the right outcome, not a
 *  throw out of a focus handler. */
function parse(json: string): Screen[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Screen[]) : [];
  } catch {
    return [];
  }
}

export const arrangements = new Arrangements();
