/* The one reader behind however many claude-status widgets are on the wall.
 *
 * Named for the class rather than for the module it serves, which is the
 * convention `meter.svelte.ts` and `ledger.svelte.ts` set and which here is
 * forced: `status.svelte.ts` beside `Status.svelte` is the *same import
 * specifier* on this filesystem, and `svelte-check` refuses it outright. That is
 * the trap `release.svelte.ts` is named around. A beacon is a light you look at
 * to find out whether the way is clear, which is the whole of what this is.
 *
 * The same bargain `Board`, `Ledger`, `Meter` and `DevOps` strike: a widget asks
 * by attaching and stops asking by detaching, and with nobody attached nothing
 * is read. A wall with no status widget on it never touches the network — which
 * is what makes this cost nothing to have in the catalogue.
 *
 * ### Why this goes and looks, and what bounds it
 *
 * The reasoning is in `status.ts`'s head and in `.claude/rules/widgets.md`; what
 * is here is the mechanism. Statuspage emits nothing this process can hear
 * (`status.rs` lists the four subscription options and why none of them is a way
 * to be told), so this is the fourth thing on the wall that goes and asks, and
 * it owes CLAUDE.md's shape: fold an event that already exists near the fact,
 * then bound the residue.
 *
 * Two events are folded, and the second is the one this has that the update
 * check does not:
 *
 * - **`watch(focused)`** — you coming back to the window, off `attention.focused`,
 *   exactly as `release.svelte.ts` does it. Called from an `$effect` in
 *   `App.svelte`, so it runs once at mount and once per focus change and this
 *   class holds no idea of whether it has begun.
 * - **`rouse()`** — a card's turn ended in an error. That is a `result` event
 *   already folded into `Conversation.ending`, and it is the moment somebody
 *   actually wants this answered: "is it me or is it them?" is the whole
 *   question the widget exists for. It goes through the same floor as a focus,
 *   so a territory of six cards failing in the same second is one ask.
 *
 * And the residue is bounded three ways, of which the third is the one that
 * differs from the update check — see `PACE` in `status.ts`. Briefly: only while
 * the window is in front; never twice inside `FLOOR`; and the backstop *tightens
 * with the news* rather than stopping, because an outage resolves and a widget
 * latched on amber would be worse than none.
 *
 * ### A failure is a reading, not silence
 *
 * The deliberate opposite of `release.svelte.ts`, where every failure leaves the
 * header exactly as it was. An update nobody could check for is a fact about
 * plumbing and nagging about it would be the app talking about itself. A status
 * page nobody could reach is *evidence about the thing you are asking about* —
 * so it is kept, and drawn, in the achromatic `unknown` rung that is deliberately
 * not one of the five status colours. What must never happen is a failed ask
 * silently leaving the last green reading on the wall, which is why `Reading`
 * carries `got` and the face reads it. */

import { invoke } from "@tauri-apps/api/core";
import {
  delayFor,
  gradeOfReading,
  paceFor,
  type Health,
  type Reading,
} from "./status";

/** What Rust answers with, before the names are made ours. */
type Wire = {
  indicator: string;
  description: string;
  updated_at: string;
  components: {
    name: string;
    status: string;
    position: number;
    group: boolean;
    hidden_when_well: boolean;
  }[];
  incidents: WireIncident[];
  maintenances: WireIncident[];
};

type WireIncident = {
  id: string;
  name: string;
  status: string;
  impact: string;
  url: string;
  started_at: string;
  notes: { status: string; body: string; at: string }[];
  affects: string[];
};

/** Serde's snake_case into the camelCase the rest of the front end speaks.
 *
 * Total, and every field defaulted: this is the same bargain `normalizeWidget`
 * strikes with `config_json`. A field Statuspage renames, or a Volery that has
 * been rolled back under a newer Rust, degrades to something drawable rather
 * than to `undefined` inside a sort comparator. */
function healthFrom(w: Wire): Health {
  const incidents = (list: WireIncident[] | undefined) =>
    (list ?? []).map((i) => ({
      id: i.id ?? "",
      name: i.name ?? "",
      status: i.status ?? "",
      impact: i.impact ?? "",
      url: i.url ?? "",
      startedAt: i.started_at ?? "",
      notes: (i.notes ?? []).map((n) => ({
        status: n.status ?? "",
        body: n.body ?? "",
        at: n.at ?? "",
      })),
      affects: i.affects ?? [],
    }));
  return {
    indicator: w.indicator ?? "",
    description: w.description ?? "",
    updatedAt: w.updated_at ?? "",
    components: (w.components ?? []).map((c) => ({
      name: c.name ?? "",
      status: c.status ?? "",
      position: Number.isFinite(c.position) ? c.position : 0,
      group: c.group === true,
      hiddenWhenWell: c.hidden_when_well === true,
    })),
    incidents: incidents(w.incidents),
    maintenances: incidents(w.maintenances),
  };
}

export class Beacon {
  /** The last answer, good or bad, or null for a wall that has not asked yet.
   *  Those are three states and the face draws three things. */
  reading = $state<Reading | null>(null);
  /** Bumped on every settled ask, so a wall test and a `$derived` can both tell
   *  "asked and got nothing" from "not asked yet" without a second flag —
   *  `Board.read`'s trick. */
  read = $state(0);

  #watchers = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  /** When the last question actually went out, for the floor to measure from.
   *  Zero means never, so the first trigger asks on this tick. */
  #askedAt = 0;
  /** The last focus this was told about, so `rouse` and `attach` know whether
   *  they are allowed to schedule anything at all. */
  #focused = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  get watched(): boolean {
    return this.#watchers.size > 0;
  }

  attach(id: string) {
    const fresh = !this.#watchers.has(id);
    this.#watchers.add(id);
    /* The first widget to go up pays for the first ask; a second one drawn a
       moment later reads what the first already fetched. */
    if (fresh) this.#plan(delayFor(this.#since()));
  }

  detach(id: string) {
    this.#watchers.delete(id);
    /* The last one off the wall stops the asking. Nothing is thrown away —
       hang another up an hour later and it draws the old reading, marked stale,
       while the fresh one is in flight. */
    if (!this.watched) this.#stop();
  }

  /** Tell this whether the window is in front. Everything follows from that.
   *
   *  Idempotent for the same value, because the pending ask is cleared and
   *  rescheduled rather than added to — which also makes it safe under a hot
   *  edit that mounts `App.svelte` twice. */
  watch(focused: boolean) {
    this.#focused = focused;
    this.#plan(delayFor(this.#since()));
  }

  /** A card's turn ended badly, so the question is worth re-asking now.
   *
   *  The fold that makes this more than a clock — see the head of this file.
   *  Through the same floor as a focus, so an outage that takes six cards down
   *  together costs one ask rather than six. */
  rouse() {
    this.#plan(delayFor(this.#since()));
  }

  /** Ask now, whoever is looking. Public for the control surface and for a hand
   *  that wants the answer without waiting out a floor. */
  async check() {
    if (this.#busy) return;
    this.#busy = true;
    this.#askedAt = Date.now();
    try {
      const wire = await invoke<Wire>("claude_status");
      this.reading = { got: true, health: healthFrom(wire), at: Date.now() };
    } catch (err) {
      /* Kept and drawn rather than swallowed, and the old reading is *replaced*
         rather than left standing: a green dot over a failed ask is the one
         dishonest thing this widget could do. */
      this.reading = {
        got: false,
        fault: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
    } finally {
      this.#busy = false;
      this.read += 1;
    }
  }

  #since(): number {
    return this.#askedAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - this.#askedAt;
  }

  /** Arrange the next ask, or none. The one gate every trigger goes through. */
  #plan(wait: number) {
    this.#stop();
    if (!this.#focused || !this.watched) return;
    this.#timer = setTimeout(() => void this.#tick(), wait);
  }

  /** Ask, then arrange the next one at whatever the news deserves. */
  async #tick() {
    this.#timer = null;
    await this.check();
    /* Re-read after the answer, not before: the pace is a function of what we
       now know, which is the whole of the "tightens with the news" bound. */
    this.#plan(paceFor(this.reading ? gradeOfReading(this.reading) : "unknown"));
  }

  #stop() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Released from `App.svelte`'s `onDestroy` along with everything else that
   *  holds a timer — CLAUDE.md's `Listeners` rule. A superseded instance still
   *  asking the status page every two minutes is exactly the leak it exists
   *  for. */
  release() {
    this.#stop();
    this.#watchers.clear();
  }
}
