/* The timelines cards have drawn, and the archive behind them.
 *
 * Every write goes through `timeline.rs`, which emits `timeline:changed` with
 * the row as it now stands — so this folds events rather than re-reading, and
 * nothing here polls. The one full read is at load, archive included: the
 * header offers the archive only when it holds something, so its count has to
 * be known before anybody opens it.
 *
 * Where a timeline is *drawn* is not here any more. A plate is a widget
 * (`plates.ts`), and its spot on the glass, its place on the wall and the knobs
 * it wears are the widget's — so this holds the plans, and `Widgets` holds the
 * plates that draw them. What is still here is what a plate asks of a plan: the
 * row, the owner as the wall knows it, where a clicked step was written, and
 * the quiet clock that takes a finished one in the stack to the archive.
 *
 * Fed by `Skein`, for `Board`'s reason: it is the only place that listens to
 * Rust, and a second `listen()` is a second thing to release in `onDestroy`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Tier } from "./classify";
import { timelineOf, type Timeline } from "./timeline";
import { isAfarTimeline } from "./gist";
import { archiveDue, type Hang } from "./plates";

/** `Array.prototype.with`, which ES2022 does not have. */
function swap<T>(list: T[], at: number, value: T): T[] {
  return list.map((x, i) => (i === at ? value : x));
}

/** How long a plate takes to fade before it is archived by itself. Matched by
 *  the transition in `Frise.svelte` — the archive is the second of a finished
 *  plan's two moments, and it is a quiet one. */
export const FADE_MS = 600;

/** A gap between two ticks longer than this is time the wall was not running —
 *  a sleep, a closed lid — rather than a slow tick. */
const GAP_MS = 5_000;

export class Timelines {
  /** This wall's plans on the glass — live and complete, not yet archived — in
   *  the order they were drawn, which is the order the stack reads in. */
  here = $state<Timeline[]>([]);
  /** The live plans of cards on other walls, as their digests carry them
   *  (`gist.ts::afarTimeline`). A function the flyway hands in
   *  (`Elsewhere`), held as state so handing it in is heard. */
  #afar = $state<() => Timeline[]>(() => []);
  #afarOwner = $state<(ownerId: string) => { tier: Tier } | null>(() => null);
  /** Everything a plate, the plan strip and the pane can draw: this wall's,
   *  then every other wall's live ones. One list, so a card elsewhere's plan is
   *  housed, drawn and found (`liveFor`) by the very code a card here's is —
   *  Lyss, 2026-10-19: *"I noticed timelines don't seem to travel across the
   *  flyway."* Only this wall's are ever written, archived or swept. */
  shown = $derived.by((): Timeline[] => [...this.here, ...this.#afar()]);

  /** Where other walls' plans come from, and how their owning cards read. */
  fromElsewhere(read: () => Timeline[], owner: (ownerId: string) => { tier: Tier } | null) {
    this.#afar = read;
    this.#afarOwner = owner;
  }

  /** The owning card's reading, wherever it runs — the plate's colour and the
   *  handle it names. A card here through `ownerOf`, one elsewhere through
   *  what the flyway handed in. */
  readingOf(ownerId: string): { tier: Tier } | null {
    return this.ownerOf(ownerId) ?? this.#afarOwner(ownerId);
  }
  /** The archive, newest first. Read once at load and then folded like the
   *  glass, so the header knows whether there is anything to offer. */
  archived = $state<Timeline[]>([]);
  /** How many are in the archive, so the header can offer it only when there
   *  is something to see — counted off the events rather than read. */
  archivedCount = $state(0);
  fault = $state<string | null>(null);
  /** The rows have been read, and read whole. What putting plates up and
   *  taking them down waits for — never true after a read that failed, so a
   *  store that could not be read is not read as a glass with no plans on it,
   *  which would take every plate down. */
  loaded = $state(false);
  /** Plates fading on their way to the archive by themselves, by timeline id. */
  leaving = $state<string[]>([]);

  /** The owning card's reading, or null when it is not on the wall. Injected
   *  by the app, which is where the cards are. */
  ownerOf: (ownerId: string) => { tier: Tier } | null = () => null;
  /** Land on the card and carry its transcript to the write a step names — the
   *  receipt (`timeline.rs::receipt`). Injected, because the panel is the app's. */
  jumpTo: (ownerId: string, timelineId: string, rev: number) => void = () => {};
  /** Land on the card that drew a plan. */
  pick: (ownerId: string) => void = () => {};

  /** Which plates are under the pointer now, by timeline id — attention, for
   *  the clock below. Not `$state`: nothing is drawn from it. */
  #hovered = new Set<string>();
  /** When each finished plan last had attention. A plain map, and empty at
   *  every launch, which is what makes the clock restart then: a plan that
   *  finished while the app was closed is given its whole delay again rather
   *  than archived the moment the wall comes up, unseen. */
  #seen = new Map<string, number>();
  /** Where each finished plate stood at the last tick, so arriving in the stack
   *  can be told from having been there all along. */
  #hung = new Map<string, Hang>();
  /** When the last tick came, so a gap between two can be told from neglect. */
  #tick = 0;

  async load() {
    try {
      const [shown, archived] = await Promise.all([
        invoke<unknown[]>("read_timelines"),
        invoke<unknown[]>("archived_timelines"),
      ]);
      this.here = shown.map(timelineOf).filter((t): t is Timeline => !!t);
      this.archived = archived.map(timelineOf).filter((t): t is Timeline => !!t);
      this.archivedCount = this.archived.length;
      this.fault = null;
      this.loaded = true;
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** One row as it now stands, or its id alone when it has gone. */
  ingest(payload: { row: unknown; id: string }) {
    const t = timelineOf(payload?.row);
    const id = t?.id ?? payload?.id;
    if (!id) return;
    const onGlass = !!t && t.archivedAt === null;
    const at = this.here.findIndex((x) => x.id === id);
    if (onGlass) {
      this.here = at === -1 ? [...this.here, t!] : swap(this.here, at, t!);
    } else if (at !== -1) {
      this.here = this.here.filter((x) => x.id !== id);
    }
    const was = this.archived.findIndex((x) => x.id === id);
    if (t && !onGlass) {
      this.archived = was === -1 ? [t, ...this.archived] : swap(this.archived, was, t);
    } else if (was !== -1) {
      this.archived = this.archived.filter((x) => x.id !== id);
    }
    this.archivedCount = this.archived.length;
    /* A plan that has left the glass is not fading any more, and one hung back
       up starts its clock afresh. */
    if (!onGlass) {
      if (this.leaving.includes(id)) this.leaving = this.leaving.filter((x) => x !== id);
      this.#seen.delete(id);
      this.#hung.delete(id);
      this.#hovered.delete(id);
    }
  }

  /** The timeline with this id on the glass, if there is one. */
  byId(id: string | null): Timeline | null {
    if (!id) return null;
    return this.shown.find((t) => t.id === id) ?? null;
  }

  /** The card's live timeline, if it has one. */
  liveFor(convId: string): Timeline | null {
    return this.shown.find((t) => t.ownerId === convId && t.state === "live") ?? null;
  }

  async archive(id: string) {
    /* Another wall's plan is its card's to finish: archiving it from here
       would be writing it, and only the owner writes. Its plate comes down when
       the card finishes or closes and its digest stops carrying it. */
    if (isAfarTimeline(id)) {
      const t = this.byId(id);
      this.fault = `that plan is drawn by a card on another wall — it comes down when ${t ? `“${t.source || t.title}”` : "the card"} finishes it or is closed`;
      return;
    }
    await this.#call("archive_timeline", { id });
  }

  /** Hang a finished one back up out of the archive — the press that makes a
   *  plate going there by itself safe. */
  async unarchive(id: string): Promise<string | null> {
    return this.#call("unarchive_timeline", { id });
  }

  /** Hand a left timeline to the card that has just adopted its session. */
  async resume(id: string, ownerId: string): Promise<string | null> {
    return this.#call("resume_timeline", { id, ownerId });
  }

  /** A plate's pointer came or went. */
  hover(id: string, on: boolean) {
    if (on) this.#hovered.add(id);
    else this.#hovered.delete(id);
  }

  /** The finished plates in the stack that have waited long enough go to the
   *  archive — a quiet fade, then the archive. Driven by the wall's one-second
   *  tick, so it is no second wake-up, and cheap when nothing is finished: a
   *  walk of the plates on the glass and a comparison. See `plates.ts::archiveDue`
   *  for when, and why it is counted from the last attention.
   *
   *  `plates` is every plate up, with where it stands, whether it was ever kept,
   *  its knob, and whether it has attention by the wall's own account —
   *  selected, or you away, which holds every clock. Under the pointer is this
   *  registry's to know. */
  sweep(
    now: number,
    plates: readonly {
      timeline: string;
      hang: Hang;
      kept: boolean;
      after: number | null;
      attended: boolean;
    }[],
  ) {
    /* A gap between two ticks is time nobody spent looking — a closed lid, a
       sleep, a debugger — and must not be counted as neglect: every clock moves
       forward by it, so a wall woken in front of you does not archive the
       finished plans on it the second it comes back (found in review). */
    const gap = this.#tick ? now - this.#tick : 0;
    this.#tick = now;
    if (gap > GAP_MS) for (const [id, at] of this.#seen) this.#seen.set(id, at + gap);
    for (const p of plates) {
      const t = this.byId(p.timeline);
      if (!t || t.state !== "complete") continue;
      const held = p.attended || this.#hovered.has(t.id);
      /* Arriving in the stack starts the clock afresh — put back there by
         hand, or by an undo of the drag that took it out. */
      const arrived = p.hang === "stack" && this.#hung.get(t.id) !== "stack";
      this.#hung.set(t.id, p.hang);
      if (held || arrived || !this.#seen.has(t.id)) this.#seen.set(t.id, now);
      const due = archiveDue({
        state: t.state,
        endedAt: t.endedAt,
        updatedAt: t.updatedAt,
        hang: p.hang,
        kept: p.kept,
        after: p.after,
        seen: this.#seen.get(t.id) ?? now,
        now,
      });
      if (this.leaving.includes(t.id)) {
        /* Reached for, moved or kept while it faded: it stays. */
        if (!due) this.leaving = this.leaving.filter((x) => x !== t.id);
        continue;
      }
      if (!due) continue;
      this.leaving = [...this.leaving, t.id];
      setTimeout(() => void this.#retire(t.id), FADE_MS);
    }
  }

  /** The end of a fade: archived, unless somebody reached for it meanwhile.
   *  A failure gives the plate back rather than leaving it faded out and still
   *  pressable, and starts its clock again, so it is not asked for every second. */
  async #retire(id: string) {
    if (!this.leaving.includes(id)) return;
    if (this.#hovered.has(id)) {
      this.leaving = this.leaving.filter((x) => x !== id);
      this.#seen.set(id, Date.now());
      return;
    }
    const failed = await this.#call("archive_timeline", { id });
    if (failed) {
      this.leaving = this.leaving.filter((x) => x !== id);
      this.#seen.set(id, Date.now());
    }
  }

  async #call(cmd: string, args: Record<string, unknown>): Promise<string | null> {
    try {
      await invoke(cmd, args);
      this.fault = null;
      return null;
    } catch (err) {
      this.fault = String(err);
      return String(err);
    }
  }
}
