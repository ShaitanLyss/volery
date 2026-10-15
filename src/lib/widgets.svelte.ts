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
import { Z_PLAN, nextBackZ, nextFrontZ } from "./layout";
import {
  duoIn,
  duoPatch,
  isView,
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
import { TETHER, goneFrom, strays, tetherOf, tetheredTo } from "./tether";
import {
  KEPT,
  PLAN,
  evicted,
  keepOnSpot,
  planOf,
  seedOf,
  toGlass,
  toStack,
  toWall,
  unhoused,
  type Hang,
} from "./plates";

/** How often a running timer's earned seconds are written down. Nothing writes
 *  to a widget's row while it merely runs — the reading is derived from an epoch
 *  — so a row saved when a timer started says nothing about how far it got. This
 *  bounds what a crash can lose to a minute rather than to however long the
 *  timer had been going. See `timing.ts::bank`. */
const BEAT_MS = 60_000;

/** Where each thing on the glass sits in the arrangement just adopted, by id.
 *  Anything absent is on the wall there. See `arrange.svelte.ts`. */
export type Spots = Record<string, [number, number]>;

export class Widgets {
  items = $state<Widget[]>([]);
  fault = $state<string | null>(null);
  /** The rows have been read, and read whole. What the launch's sweep of pins
   *  whose card did not come back waits for (`keepCards`) — never true after a
   *  read that failed, so a store that could not be read is not read as a wall
   *  with no pins on it. */
  loaded = $state(false);

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

  /** Whether a card — here or on another wall — is still standing. The one
   *  question a widget that is a view of a card asks of the wall, injected for
   *  `others`' reason: the cards are not this registry's to hold. Answers yes
   *  until somebody says otherwise, so a registry with no wall behind it (a
   *  test, the first frames of a launch) never refuses a pin. */
  stands: (card: string) => boolean = () => true;

  /** Whether a timeline is on the glass — the question a plate asks of the
   *  wall, injected for `stands`' reason. Yes until somebody says otherwise. */
  shows: (timeline: string) => boolean = () => true;

  /** What taking a plate down *means*: archiving its plan. A plate is a view of
   *  a timeline, and a timeline leaves the glass by going to the archive — so
   *  the grip, Delete, the menu and the control surface's `widget.remove` all
   *  archive the plan, and the plate comes down with the event that follows
   *  (`evict`). Injected, because the plans are not this registry's. */
  retire: (timeline: string) => void = () => {};

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
      this.loaded = true;
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
    /* Not offered from any menu, and refused here for the one route that does
       not go through a menu (the control surface): a view of a card is hung
       up from the card, through `tether`, and a plan by the wall, through
       `house`. */
    if (isView(kind)) {
      this.fault = specFor(kind)?.plan
        ? `a ${specFor(kind)?.label} is put up by the card that draws it`
        : `a ${specFor(kind)?.label} is hung up from the card it reads`;
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
    /* A spot written onto a plate is a keep, whichever gesture wrote it — a
       drag out of the stack is a carry, not a `hangAt`, and must count the
       same (`plates.ts::KEPT`). Nothing for any other widget. */
    next.config = keepOnSpot(next.config, patch);
    this.items[i] = next;
    this.#saveSoon(next);
    return $state.snapshot(next) as Widget;
  }

  /** Hang a card's last message up beside it — or, if it already has one, hand
   *  that one back.
   *
   *  One per card, for the reason `pin.rs` refuses a second copy of the same
   *  picture: two views of one card are two rectangles saying the same words,
   *  and the second is never the one you meant to look at. Asking again finds
   *  the one already up, and the caller moves it to where it was asked for.
   *
   *  Recorded, like any widget hung up by hand: taking it back is taking down
   *  something you put up. What is *not* recorded is the card closing under it
   *  — see `untether`. Answers the widget, or why not in words: there is no
   *  fault line drawn for this registry, so the caller says it where it will be
   *  seen. */
  async tether(
    kind: WidgetKind,
    card: string,
    atX: number,
    atY: number,
    /** Where on the glass, for one hung up straight onto it — written in the
     *  same record as the widget, so the gesture is one undo. */
    glass: { x: number; y: number } | null = null,
  ): Promise<Widget | string> {
    const spec = specFor(kind);
    if (!spec?.tether) return `a ${kind} is not a view of a card`;
    const had = this.items.find((w) => w.kind === kind && tetherOf(w) === card);
    if (had) {
      this.picks.only("widget", had.id);
      return had;
    }
    if (!this.stands(card)) return "that card is no longer on the wall";
    /* Behind the cards, as every widget is hung: it is placed clear of its
       card's grouping, and where it lands over somebody else's, the card is
       the live work and the pin is only reading it. */
    const w = {
      ...newWidget(kind, atX, atY, nextBackZ(this.#stack()), card),
      glassX: glass?.x ?? null,
      glassY: glass?.y ?? null,
    };
    this.items = [...this.items, w];
    this.picks.only("widget", w.id);
    this.scribe.did(`hanging up a ${spec.label}`, [
      { at: "widget", id: w.id, was: null, now: { ...w, config: { ...w.config } } },
    ]);
    await this.#save(w);
    return w;
  }

  /** Take down every view of a card that has just left the wall.
   *
   *  Called from `Skein.close`, on the same synchronous run that takes the card
   *  out of `convs` — not after an `await`, and not by an effect noticing a
   *  frame later. A pin that outlived its card by even a frame would be a
   *  widget pointing at an id the wall no longer has, which is
   *  `restore.md`'s close-fade argument one object over.
   *
   *  **Unrecorded.** Closing a card is not taking down its pin; it is ending
   *  the thing the pin was a view of. Answers the ids it took down so the undo
   *  stack can let go of them too (`Undo.drop`), or an undo of the move you
   *  made an hour ago would put a pin back onto a card that is gone. */
  untether(card: string): string[] {
    return this.#takeDown(tetheredTo(this.items, card));
  }

  /** One wall has just been heard, and these are the cards it still holds:
   *  take down the views of its cards that are not among them. Never asked of
   *  a wall that is quiet — see `tether.ts::goneFrom`. */
  keepHost(host: string, alive: ReadonlySet<string>): string[] {
    return this.#takeDown(goneFrom(this.items, host, alive));
  }

  /** At launch, once the wall has been read: take down the views of cards here
   *  that did not come back — a pin whose card closed in a session that ended
   *  before its row could be deleted. See `tether.ts::strays`. */
  keepCards(alive: ReadonlySet<string>): string[] {
    return this.#takeDown(strays(this.items, alive));
  }

  /** Put a plate up for every timeline on the glass that nothing draws yet.
   *
   *  **Unrecorded.** An agent drew the plan; nobody hung it — so there is
   *  nothing for undo to take back, and a plate the stack could take down
   *  would be a plan with no plate while its card is still writing it. Each
   *  arrives in the stack at the plates' own height, unless its timeline
   *  carries a spot of its own from before plates were widgets (`seedOf`), in
   *  which case it is still where it was dragged to. Answers the ids put up. */
  house(shown: readonly { id: string; glassX: number | null; glassY: number | null }[]): string[] {
    const lacking = unhoused(
      shown.map((t) => t.id),
      this.items,
    );
    if (!lacking.length) return [];
    const made = lacking.map((id) => {
      const t = shown.find((s) => s.id === id)!;
      const w = { ...newWidget("timeline", 0, 0, Z_PLAN, id), ...seedOf(t) };
      /* A plan the old layer had at a spot was dragged there by hand. */
      return w.glassX !== null ? { ...w, config: { ...w.config, [KEPT]: 1 } } : w;
    });
    this.items = [...this.items, ...made];
    for (const w of made) void this.#save(w);
    return made.map((w) => w.id);
  }

  /** Take down every plate whose timeline is no longer on the glass — archived
   *  by hand or by itself, left by a closing card, gone from the store — and
   *  any second plate of one timeline. Unrecorded, for `untether`'s reason: the
   *  plan going is not somebody taking its plate down. Answers the ids, so the
   *  undo stack can let go of what it knew about them. Asked only after the
   *  timelines have been read whole — see `plates.ts::evicted`. */
  evict(shown: ReadonlySet<string>): string[] {
    return this.#takeDown(evicted(this.items, shown));
  }

  /** Move a plate to the stack, onto the wall at `at`, or onto the glass at
   *  `at`. Recorded, like any move you make: these are the menu's three
   *  verbs, and taking one back puts the plate where it stood. */
  hangAt(id: string, to: Hang, at?: { x: number; y: number }) {
    const w = this.items.find((w) => w.id === id);
    if (!w || planOf(w) === null) return;
    if (to !== "stack" && !at) return;
    const move = to === "stack" ? toStack(w) : to === "wall" ? toWall(w, at!) : toGlass(w, at!);
    /* On the wall it goes behind the cards like every widget hung there — the
       plan band is for the glass, where a card stuck at the top must not hide
       the stack — and back on the glass it rides at the plan band again,
       unless it had been brought to the front. */
    const z = to === "wall" ? nextBackZ(this.#stack()) : Math.max(w.z, Z_PLAN);
    this.update(id, { ...move, z } as Partial<Widget>);
  }

  /** The removal a tether's lifecycle shares: synchronous on the wall, the
   *  row after. Not `remove`, which records — see `untether`. */
  #takeDown(gone: readonly Widget[]): string[] {
    if (!gone.length) return [];
    const ids = new Set(gone.map((w) => w.id));
    for (const id of ids) {
      clearTimeout(this.#saveTimers.get(id));
      this.#saveTimers.delete(id);
      this.picks.drop("widget", id);
    }
    this.items = this.items.filter((w) => !ids.has(w.id));
    for (const id of ids) {
      invoke("delete_widget", { id }).catch((err) => (this.fault = String(err)));
    }
    return [...ids];
  }

  /** Put one back exactly as it was — what undo needs, and the one write that
   *  has to cope with the widget not being there any more (an undone removal).
   *  Never recorded: this *is* the recording being played.
   *
   *  The one thing it refuses is a view of a card that has gone: a redo of
   *  hanging one up, after its card closed, would otherwise put a pin on the
   *  wall pointing at nothing. `untether` drops what the stack knew about the
   *  pins it took down; this is the backstop for one that was not up then. */
  put(w: Widget) {
    const card = tetherOf(w);
    if (card !== null && !this.stands(card)) return;
    /* Nor a second view of one card: an undo can reach a pin taken down by
       hand after another was hung up for the same card, and one per card is
       `tether`'s rule whichever way a pin arrives. */
    if (card !== null && this.items.some((x) => x.id !== w.id && tetherOf(x) === card)) return;
    /* The same two refusals for a plate: none for a plan that has left the
       glass, and never a second one of a plan. `evict` drops what the stack
       knew about a plate it took down; this is the backstop behind it. */
    const plan = planOf(w);
    if (plan !== null && !this.shows(plan)) return;
    if (plan !== null && this.items.some((x) => x.id !== w.id && planOf(x) === plan)) return;
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
    /* Which card a pin reads is what it *is*, not a knob — re-pointed, it
       would be one card's view wearing another's lifecycle. A plate's plan
       the same. */
    if (key === TETHER && tetherOf(w) !== null) return;
    if (key === PLAN && planOf(w) !== null) return;
    this.update(id, { config: { ...w.config, [key]: value } });
  }

  bringToFront(id: string) {
    this.update(id, { z: nextFrontZ(this.#stack()) });
  }

  /** Move every widget to where it stands in the arrangement just adopted.
   *
   *  Unrecorded, for the reason `beat` is: nobody asked for this, it is one
   *  gesture about the *screens* rather than about any widget, and an undo that
   *  rewound half of it would leave the wall in a room that does not exist.
   *  Answers the ids it actually moved, so the stack can forget what it knows
   *  about them — their history is in another room's coordinates now.
   *
   *  It goes through `#patch`, so it supersedes a drag's queued save rather
   *  than racing it: `#saveSoon` clears the timer it finds. The write it
   *  schedules is redundant — Rust wrote these columns itself — and that is
   *  cheaper than the alternative, which is a stale debounced save landing
   *  after the switch and writing the last room's spot into this one. */
  adoptGlass(spots: Spots): string[] {
    const moved: string[] = [];
    for (const w of [...this.items]) {
      const at = spots[w.id];
      const x = at ? at[0] : null;
      const y = at ? at[1] : null;
      if (w.glassX === x && w.glassY === y) continue;
      moved.push(w.id);
      this.#patch(w.id, { glassX: x, glassY: y });
    }
    return moved;
  }

  async remove(id: string) {
    const was = this.items.find((w) => w.id === id);
    /* A plate is taken down by archiving its plan, and nothing else — see
       `retire`. Not recorded: the archive is where a plan goes back from
       (`Timelines.unarchive`, `resume`), not the undo stack, which never held
       a timeline. */
    const plan = was ? planOf(was) : null;
    if (plan !== null) {
      this.retire(plan);
      return;
    }

    /* Drop any queued save first, or it lands *after* the delete and puts the
       row straight back — the bug reference images shipped with, where taking
       one down brought it back on the next launch. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);

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
