import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import {
  GLASS_CHROME_KEY,
  GLASS_SCALE_KEY,
  NO_ARRANGEMENT,
  ancestorFor,
  chromesFor,
  frameOf,
  framePlan,
  glassScaleFor,
  restChrome,
  roomKey,
  screenOf,
  type Chromes,
  type Frame,
  type FramePlan,
  type GlassScale,
  type Known,
  type Screen,
} from "./arrange";
import { span } from "./span.svelte";

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
  /** Cards on other walls, by shadow id. Optional: an older build's answer
   *  has none, which reads as nothing stuck. */
  shadows?: Record<string, [number, number]>;
};

type Row = { key: string; screens: string; seenAt: number; frame?: [number, number] | null };

/** What each thing on the glass is drawn at, by kind (`arrange.rs`'s spelling)
 *  and id, `"*"` standing for every id of a kind. `arrange.rs::Sizes`. */
export type SizeBook = Record<string, Record<string, [number, number]>>;

/** What `settle` needs from the canvas to say what a pane is on this screen:
 *  what the window draws that the pane is not, where the dock is moored (the
 *  chrome is remembered per mooring — see `arrange.ts::Chromes`), and what
 *  everything on the glass is drawn at. Null before the pane has been
 *  measured. */
export type Measure = () => { chrome: Frame; site: string; sizes: SizeBook } | null;

class Arrangements {
  /** The fingerprint of the room the glass is in, or `NO_ARRANGEMENT` before
   *  the monitors have answered. */
  key = $state(NO_ARRANGEMENT);
  /** Its shape, for anybody who wants to say something about it. */
  screens = $state<Screen[]>([]);
  /** CSS pixels per physical pixel on the glass while spread — the home
   *  screen's scale, which `window.rs::rezoom` zooms the page to — or null
   *  unspread, where nothing is ever rescaled. Part of "has anything changed",
   *  since the same room under a new unit still has to be told. */
  unit = $state<number | null>(null);
  /** The one screen the glass is on, as `screenOf` names it — its size and
   *  scale — or the key itself while spread. Part of "has anything changed",
   *  since a landscape screen of another size is the same room and still has
   *  to be told: its spots are carried onto the new pane. */
  screen = $state(NO_ARRANGEMENT);
  /** The pane this room's spots were last carried onto, for anybody looking
   *  from outside (`snapshot.arrangement`). Null while spread. */
  frame = $state<Frame | null>(null);
  /** Scaled or per size. See `arrange.ts::GlassScale`. */
  scale = $state<GlassScale>(readScale());
  /** The room the screens in front of you call for, whether or not the store
   *  has been pointed at it yet — which it is not, for a one-screen room,
   *  until the pane has been measured (an empty wall draws no canvas at all).
   *  What the panel and the dock moor by (`berth.svelte.ts`): a mooring needs
   *  no frame, and keying it on the last *adopted* room left an empty wall
   *  unspread using the moorings of the spread desk it had just left. */
  wanted = $state(NO_ARRANGEMENT);
  /** The chrome at rest, per dock mooring. */
  #chromes: Chromes = readChromes();
  /** The last thing that went wrong looking, so a failure is visible rather
   *  than a glass that quietly stopped following the screens. */
  fault = $state<string | null>(null);
  /** Monitors to answer instead of the real ones, for the control surface's
   *  `screens` op — the one input to all of this that a test on one desk has
   *  no other way to reach. Everything after `look` runs as it would. */
  pretend: Screen[] | null = null;
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
   *  first, and that is right: the room the glass is in did not change. Nor
   *  does moving the window to another landscape screen, which `roomKey`
   *  reduces to its orientation.
   *
   *  An empty answer rather than a throw: a monitor enumeration that fails is
   *  a reason to leave the arrangement alone, not a reason for anything to
   *  stop. */
  async look(spread: boolean): Promise<Screen[]> {
    if (this.pretend) return spread ? this.pretend : this.pretend.slice(0, 1);
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
          /* What a maximised window gets of it — the frame a glass on this
             screen is a share of (`frameOf`). Absent from an older Tauri,
             which `frameOf` reads as the whole screen. */
          work: m.workArea?.size
            ? { w: m.workArea.size.width, h: m.workArea.size.height }
            : undefined,
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
      const key = roomKey(screens, spread, this.scale);
      /* Spread over a desk whose screens are at different scales, the page is
         zoomed to the home screen's, so a glass spot in CSS pixels lands in a
         different *physical* place depending on which screen the window was
         spread from. The store keeps the unit each room's spots were written in
         and rescales them when it changes, so moving the chrome to another
         screen moves the chrome and nothing on the glass. Read live here, like
         `spread`, because the second pass of `#again` exists to catch exactly
         the spread that changed under the first. */
      const unit = spread ? (span.view?.scale ?? null) : null;
      const screen = spread ? key : screenOf(screens);
      /* Nothing usable, or the same room as last time. The early return is on
         the *key* rather than on the monitor list, so a screen that reports a
         pixel differently between two calls does not fork an arrangement — and
         on the unit beside it, so a re-spread from another home that arrives
         while this was busy (and so never passes through the unspread room)
         still has its spots put back where they physically were — and on the
         one screen's size, since the laptop and the monitor beside it are one
         room whose spots still have to be carried from one to the other. */
      if (key === NO_ARRANGEMENT) return null;
      if (key === this.key && unit === this.unit && screen === this.screen) {
        this.wanted = key;
        return null;
      }
      /* One screen's room is never adopted blind. What its spots are a share of
         is the pane, and before the pane has been measured there is no saying
         — adopting anyway would record a room as being on this screen with no
         frame to show for it, and the next settle would then believe the
         spots were already laid out here. The canvas measuring itself is what
         asks again (`App.svelte`'s effect on `paneReady`).

         Measured *before* `wanted` moves, and that order is the point: the
         moorings follow `wanted`, so the moment it names the new room the
         dock's mooring is the new room's while the pane on screen is still
         the old one's — and a reading taken then was filed under the wrong
         mooring, a floating dock's header-only height kept as a moored one's
         rest for good (red-team, 2026-10-15). Before it moves, the pane and
         the mooring are the same room's, so the reading is a true one. */
      const measured = spread ? null : (this.measure?.() ?? null);
      if (measured) this.#restChrome(measured.site, measured.chrome.h);
      this.wanted = key;
      if (!spread && !measured) return null;
      /* And the frame is built from the chrome at rest *for the mooring this
         room will be drawn with* — which is the memory's, not this reading's,
         when the two rooms are moored differently. A mooring never seen at
         rest is one there is no honest number for yet: the dock re-moors under
         the new room, the canvas hands in what that measures, and the next
         focus, move or resize asks again with it. */
      const site = measured ? (this.mooring?.() ?? measured.site) : null;
      const rest = site !== null ? (this.#chromes[site] ?? null) : null;
      if (!spread && rest === null) return null;

      let known: Known[] = [];
      let knew = false;
      try {
        const rows = await invoke<Row[]>("known_arrangements");
        known = rows.map((r) => ({
          key: r.key,
          screens: parse(r.screens),
          seenAt: r.seenAt,
          frame: r.frame ? { w: r.frame[0], h: r.frame[1] } : null,
        }));
        knew = true;
      } catch (err) {
        /* Spread, a first sighting with no ancestor named falls back to
           whatever is on the glass right now, which is a worse answer than the
           nearest room but a much better one than refusing to follow the
           screens at all. */
        this.fault = String(err);
      }
      /* One screen, it is a reason not to adopt at all. Without the rows there
         is no telling whether this room is known or what its spots are a share
         of, and adopting anyway writes this screen into the room's
         `screens_json` beside a frame from another — after which every settle
         believes the spots were laid out here and nothing is ever carried. The
         next focus asks again. */
      if (!spread && !knew) return null;

      const ancestor = ancestorFor({ key, screens, spread, scale: this.scale, known });
      /* The chrome at rest rather than as it is this instant: a question open
         in the dock right now would otherwise be baked into the frame the whole
         glass is carried onto. */
      const live =
        measured && rest !== null ? frameOf(screens[0], { w: measured.chrome.w, h: rest }) : null;
      /* And a pane that cannot be made into a frame is the same refusal as one
         not measured yet, for the same reason. */
      if (!spread && !live) return null;
      const plan: FramePlan = framePlan({ key, spread, screens, live, known, ancestor });
      const pair = (f: Frame | null) => (f ? [f.w, f.h] : null);

      const spots = await invoke<GlassSpots | null>("adopt_arrangement", {
        key,
        screens: JSON.stringify(screens),
        origin,
        unit,
        cloneFrom: ancestor?.key ?? null,
        frame: pair(plan.frame),
        fromFrame: pair(plan.fromFrame),
        cloneFrame: pair(plan.cloneFrame),
        sizes: plan.fromFrame || plan.cloneFrame ? (measured?.sizes ?? null) : null,
      });
      this.key = key;
      this.screens = screens;
      this.unit = unit;
      this.screen = screen;
      this.frame = spread ? null : (plan.frame ?? known.find((k) => k.key === key)?.frame ?? live);
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
  rerun: (() => Promise<void> | void) | null = null;

  /** A settle in flight, or one owed as soon as it lands — what a caller that
   *  asked for one (the control surface's `screens`) waits out. */
  get busy(): boolean {
    return this.#busy || this.#again;
  }

  /** What the canvas says about the pane and the things on it — set by
   *  `App.svelte` from `Canvas`, which is the one place that knows what each
   *  thing is drawn at. Null leaves every one-screen room unadopted, which is
   *  the honest state for a canvas that is not up. */
  measure: Measure | null = null;

  /** Where the dock is moored in the room being drawn — `berths.dock.site`,
   *  set by `App.svelte` beside `measure`. Asked after `wanted` has moved, so
   *  it names the mooring the room being adopted will be drawn with. */
  mooring: (() => string) | null = null;

  /** Fold one reading of the chrome into the memory of it at rest, and say
   *  what that memory now is. Every pane the canvas measures is a reading
   *  (`App.svelte` hands them in), not only the ones a settle happens to take,
   *  so the dock has had every chance to have been seen at rest. Written to
   *  storage only when the least seen goes down, which after the first few
   *  readings is never. */
  observeChrome(site: string, h: number): number | null {
    return this.#restChrome(site, h);
  }

  /** The chrome at rest as remembered, per mooring — for a reading from
   *  outside (`snapshot.arrangement.chromes`). A copy. */
  get chromes(): Chromes {
    return { ...this.#chromes };
  }

  #restChrome(site: string, h: number): number | null {
    const { chrome, seen } = restChrome(this.#chromes, site, h);
    if (seen !== this.#chromes) {
      this.#chromes = seen;
      try {
        localStorage.setItem(GLASS_CHROME_KEY, JSON.stringify(seen));
      } catch {
        /* Forgotten at the next launch, which costs one launch's readings. */
      }
    }
    return chrome;
  }

  /** Scaled or per size, from now on. Kept, and then the glass is asked to
   *  follow — which, the first time, copies the room you are in, so nothing
   *  moves until the screen does. */
  setScale(scale: GlassScale) {
    this.scale = scale;
    try {
      localStorage.setItem(GLASS_SCALE_KEY, scale);
    } catch {
      /* This machine forgets the choice and the default stands, as
         `setReawaken` does. */
    }
    this.rerun?.();
  }
}

function readChromes(): Chromes {
  try {
    return chromesFor(localStorage.getItem(GLASS_CHROME_KEY));
  } catch {
    return {};
  }
}

function readScale(): GlassScale {
  try {
    return glassScaleFor(localStorage.getItem(GLASS_SCALE_KEY));
  } catch {
    return "scaled";
  }
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
