/* The widgets standing on the wall.
 *
 * The same shape `Board` has for reference images — load, place, adjust, save
 * on a debounce, remove — because they are the same kind of thing to the wall:
 * hand-placed furniture that belongs to no project and never enters the
 * auto-layout. What differs is that a widget is *drawn* rather than loaded, so
 * what persists is a kind and a config rather than a path.
 *
 * All the vocabulary is in `widgets.ts`, which is pure. This file only owns the
 * copies on the wall and the round trip to SQLite. */

import { invoke } from "@tauri-apps/api/core";
import { nextBackZ, nextFrontZ } from "./layout";
import {
  duoIn,
  duoPatch,
  newWidget,
  normalizeWidget,
  runs,
  specFor,
  type Widget,
  type WidgetKind,
} from "./widgets";
import { bank, isRunning, settle, type Duo } from "./timing";
import { NO_SCRIBE, type Scribe } from "./undo";
import { NO_PICKS, type Picker } from "./pick";

/** How often a running timer's earned seconds are written down. Nothing writes
 *  to a widget's row while it merely runs — the reading is derived from an epoch
 *  — so a row saved when a timer started says nothing about how far it got. This
 *  bounds what a crash can lose to a minute rather than to however long the
 *  timer had been going. See `timing.ts::bank`. */
const BEAT_MS = 60_000;

export class Widgets {
  items = $state<Widget[]>([]);
  fault = $state<string | null>(null);

  /** What is picked on the wall. Injected for the reason `scribe` is: a widget
   *  you have just hung up is the thing you are holding, and there is one
   *  selection for the whole wall rather than one per registry — see the note
   *  over `Studio.picks`. */
  picks: Picker = NO_PICKS;

  /** The z of everything else standing on the wall — the reference images.
   *
   *  There is one stacking order for the whole wall (see `layout.ts`), so
   *  "bring to front" has to mean in front of *everything*, not in front of the
   *  other widgets. Injected rather than imported because the board and the
   *  widgets each hold their own list and neither may own the other. */
  others: () => number[] = () => [];

  /** Where an undoable change is written down. Set by the app; recording from
   *  in here rather than at the call sites means every route to a widget — the
   *  menu, a drag, the control surface — is undoable by existing, and there is
   *  no second path that quietly is not. See `undo.svelte.ts`. */
  scribe: Scribe = NO_SCRIBE;

  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When the running timers were last banked — see `beat`. */
  #beat = 0;

  async load() {
    try {
      const rows = await invoke<unknown[]>("list_widgets");
      /* Normalised on every read: a knob renamed or a variant retired since a
         row was written degrades to a widget that draws, and a kind this build
         has never heard of is left off the wall rather than guessed at. */
      this.items = rows
        .map(normalizeWidget)
        .filter((w): w is Widget => !!w)
        .map((w) => (runs(w.kind) ? this.#held(w) : w));
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** A timer left running when Skein last closed, brought back held.
   *
   *  The app not running is not the same as the timer running — a stopwatch here
   *  measures your attention on something, and that stopped when the window did.
   *  See `timing.ts::settle` for the full argument. Not written back: the row is
   *  already what `settle` returns except for the `since` it drops, and a launch
   *  that wrote to every timer on the wall would be a launch doing work nobody
   *  asked for. The next gesture or beat persists it. */
  #held(w: Widget): Widget {
    const duo = duoIn(w);
    if (!isRunning(duo.on) && !isRunning(duo.off)) return w;
    const settled: Duo = { on: settle(duo.on), off: settle(duo.off) };
    return { ...w, config: { ...w.config, ...duoPatch(settled) } };
  }

  /** Bring every running timer's earned seconds up to date, about once a minute.
   *
   *  Driven by the studio's existing one-second tick rather than a timer of its
   *  own — the wall has one wake-up a second and this does not add a second one.
   *  Cheap when nothing is running, which is the common case: it is a walk of a
   *  handful of widgets and a comparison. */
  beat(now: number) {
    if (now - this.#beat < BEAT_MS) return;
    this.#beat = now;
    for (const w of this.items) {
      if (!runs(w.kind)) continue;
      const duo = duoIn(w);
      if (!isRunning(duo.on) && !isRunning(duo.off)) continue;
      /* Unrecorded: nobody asked for this. A timer's earned seconds arriving on
         the undo stack once a minute would push every real gesture off it while
         the wall sat idle, and undoing one would rewind a clock. */
      this.#patch(w.id, {
        config: {
          ...w.config,
          ...duoPatch({ on: bank(duo.on, now), off: bank(duo.off, now) }),
        },
      });
    }
  }


  #stack(): number[] {
    return [...this.items.map((w) => w.z), ...this.others()];
  }

  /** Hang one on the wall, centred on a point in canvas space. */
  async add(kind: WidgetKind, atX: number, atY: number): Promise<Widget | null> {
    if (!specFor(kind)) {
      this.fault = `no such widget: ${kind}`;
      return null;
    }
    /* Behind the cards, for the reason a reference image is: the wall is a
       working surface first, and nothing hung on it should cover live work.
       The menu's "bring to front" is there for when you mean the opposite. */
    const w = newWidget(kind, atX, atY, nextBackZ(this.#stack()));
    this.items = [...this.items, w];
    this.picks.only("widget", w.id);
    /* An edit from nothing — see the shape note in `undo.ts`. Recorded before
       the write, so a save that fails still leaves an undoable widget on the
       wall rather than one the stack has never heard of. */
    this.scribe.did(`hanging up a ${specFor(kind)?.label ?? kind}`, [
      /* Config copied too, not shared: the object handed to the stack must not
         be one the wall can still reach. */
      { at: "widget", id: w.id, was: null, now: { ...w, config: { ...w.config } } },
    ]);
    await this.#save(w);
    return w;
  }

  update(id: string, patch: Partial<Widget>) {
    const was = this.items.find((w) => w.id === id);
    if (!was) return;
    const before = $state.snapshot(was);
    const next = this.#patch(id, patch);
    if (next) this.scribe.note("widget", id, before, next, patch);
  }

  /** The change itself, with nothing said about it.
   *
   *  Split out from `update` for the one caller that must not be remembered —
   *  see `beat`. Answers the widget as it now is, which is what `update` needs
   *  for the other side of its edit. */
  #patch(id: string, patch: Partial<Widget>): Widget | null {
    const i = this.items.findIndex((w) => w.id === id);
    if (i < 0) return null;
    const next = { ...this.items[i], ...patch };
    this.items[i] = next;
    this.#saveSoon(next);
    return $state.snapshot(next) as Widget;
  }

  /** Put one back exactly as it was — what undo needs, and the one write that
   *  has to cope with the widget not being there any more (an undone removal).
   *  Never recorded: this *is* the recording being played. */
  put(w: Widget) {
    const i = this.items.findIndex((x) => x.id === w.id);
    if (i < 0) this.items = [...this.items, { ...w }];
    else this.items[i] = { ...w };
    this.#saveSoon(w);
  }

  /** Turn one knob. Config is replaced whole rather than merged in place, so a
   *  `$state` array element is always a fresh object and the widget repaints. */
  set(id: string, key: string, value: string | number | boolean) {
    const w = this.items.find((w) => w.id === id);
    if (!w) return;
    this.update(id, { config: { ...w.config, [key]: value } });
  }

  bringToFront(id: string) {
    this.update(id, { z: nextFrontZ(this.#stack()) });
  }

  async remove(id: string) {
    /* Drop any queued save first, or it lands *after* the delete and puts the
       row straight back — the bug reference images shipped with, where taking
       one down brought it back on the next launch. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);

    const was = this.items.find((w) => w.id === id);
    if (was) {
      this.scribe.did(`taking down a ${specFor(was.kind)?.label ?? was.kind}`, [
        { at: "widget", id, was: $state.snapshot(was), now: null },
      ]);
    }
    this.items = this.items.filter((w) => w.id !== id);
    this.picks.drop("widget", id);
    try {
      await invoke("delete_widget", { id });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Is any widget of this kind on the wall? What tells the performance
   *  sampler whether anybody is asking. */
  has(kind: WidgetKind): boolean {
    return this.items.some((w) => w.kind === kind);
  }

  async #save(w: Widget) {
    try {
      await invoke("save_widget", { widget: $state.snapshot(w) });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Dragging one fires continuously; the database only needs where it came to
   *  rest. */
  #saveSoon(w: Widget) {
    clearTimeout(this.#saveTimers.get(w.id));
    this.#saveTimers.set(
      w.id,
      setTimeout(() => void this.#save(w), 250),
    );
  }
}
