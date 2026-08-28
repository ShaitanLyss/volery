/**
 * The deck: the one Spotify session, behind however many faces look at it.
 *
 * Named for what it is rather than for what it talks to, which is the house
 * convention (`beacon` for the status page, `ledger` for usage, `devops` for
 * Azure) and here it is also forced: a `spotify.svelte.ts` beside
 * `Spotify.svelte` differs only in casing, and on this filesystem TypeScript
 * refuses to have both in one program.
 *
 * The same shape as `beacon.svelte.ts` and for the same reason: there is one
 * player, and hanging three widgets on the wall must not open three sessions.
 * A face starts looking by attaching and stops by detaching; with nobody
 * attached this holds a folded state and no subscription at all.
 *
 * All the thinking is in `spotify.ts`, which is pure and tested. What is here
 * is the subscription, the refcount, and the verbs a face can press.
 *
 * **The listener is released.** `Anything holding a Tauri subscription needs
 * releasing` — an unreleased `listen` keeps folding events into a holder
 * nothing draws, and on a wall left open all day that is a leak with a
 * heartbeat. The unlisten is kept and called when the last reader lets go.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  applyEvent,
  emptyState,
  volumeToWire,
  worthSearching,
  type SpotifyEvent,
  type SpotifyHit,
  type SpotifyState,
} from "./spotify";

/** What `spotify_status` answers — see `Status` in `spotify.rs`. */
type Wire = {
  linked: boolean;
  running: boolean;
  device: string;
  replay: SpotifyEvent[];
};

export class Deck {
  /** The folded state every face draws. */
  state = $state<SpotifyState>(emptyState());
  /** Whether there is a credential in the vault — not whether it still works. */
  linked = $state(false);
  /** Set while a verb is in flight, so a face can stop offering it twice. */
  busy = $state(false);

  #readers = new Set<string>();
  #unlisten: UnlistenFn | null = null;
  #wiring = false;

  /* ── coming and going ────────────────────────────────────────────────────*/

  attach(id: string) {
    const first = this.#readers.size === 0;
    this.#readers.add(id);
    if (first) void this.#wire();
  }

  detach(id: string) {
    this.#readers.delete(id);
    /* The session deliberately stays up. A widget scrolled off the edge of the
       wall is not a reason to stop the music — that is the one thing a player
       must not do on its own. Only the subscription goes. */
    if (this.#readers.size === 0) this.release();
  }

  release() {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  async #wire() {
    if (this.#wiring || this.#unlisten) return;
    this.#wiring = true;
    try {
      this.#unlisten = await listen<SpotifyEvent>("spotify:event", (e) => {
        this.state = applyEvent(this.state, e.payload, Date.now());
      });
      await this.refresh();
    } catch {
      /* Nothing to say: a face with no session draws "not signed in", which is
         what an app that cannot reach its own backend should look like. */
    } finally {
      this.#wiring = false;
    }
  }

  /**
   * Catch up a face that mounted mid-track.
   *
   * The replay is folded through exactly the same `applyEvent` the live stream
   * uses, so there is no second description of what a state is — the thing that
   * would otherwise drift apart. See the note in `spotify.rs`.
   */
  async refresh() {
    const wire = await invoke<Wire>("spotify_status");
    this.linked = wire.linked;
    let next = emptyState();
    const at = Date.now();
    for (const ev of wire.replay ?? []) next = applyEvent(next, ev, at);
    this.state = next;
  }

  /* ── searching ───────────────────────────────────────────────────────────*/

  /** The rows the face draws, and what the search is doing. */
  hits = $state<SpotifyHit[]>([]);
  searching = $state<"idle" | "searching" | "done" | "failed">("idle");
  searchFault = $state<string | null>(null);

  /** Rising, so a slow answer cannot land on top of a faster later one.
   *
   *  Type "bon", then "bonobo": two searches are in flight and the first may
   *  come back second. Without this the list would settle on the answer to a
   *  query nobody is still looking at, which reads as the search being wrong
   *  rather than late. */
  #searchId = 0;

  async search(query: string) {
    if (!worthSearching(query)) {
      this.hits = [];
      this.searching = "idle";
      this.searchFault = null;
      return;
    }
    const mine = ++this.#searchId;
    this.searching = "searching";
    this.searchFault = null;
    try {
      const hits = await invoke<SpotifyHit[]>("spotify_search", { query });
      if (mine !== this.#searchId) return; /* a later query owns the list */
      this.hits = hits;
      this.searching = "done";
    } catch (e) {
      if (mine !== this.#searchId) return;
      this.hits = [];
      this.searching = "failed";
      this.searchFault = String(e);
    }
  }

  clearSearch() {
    this.#searchId++;
    this.hits = [];
    this.searching = "idle";
    this.searchFault = null;
  }

  /** Put a result on, because the *user* asked.
   *
   *  `spotify_play` rather than the `put_on` a card reaches — that one refuses
   *  while something is playing, which is the guard protecting this person from
   *  an agent and would be nonsense applied to the person themselves. See its
   *  comment in `spotify.rs`. */
  async play(uri: string) {
    try {
      await invoke("spotify_play", { uri });
      return true;
    } catch (e) {
      this.searchFault = String(e);
      this.searching = "failed";
      return false;
    }
  }

  /* ── the verbs ───────────────────────────────────────────────────────────*/

  /**
   * Sign in, then bring the receiver up. Two legs, and the face is told which
   * one it is on by `spotify.rs` rather than by this class: `spotify_link`
   * emits `linking` and `spotify_start` emits `opening`, so a face that never
   * pressed the button follows along too. That is the fix for the bug this
   * chain caused — `busy` covered all three awaits and the only label it had
   * was "waiting for the browser…", which a widget went on showing for the four
   * minutes the *session* leg took to fail.
   *
   * The browser leg is unbounded because the wait is a person; everything after
   * it is bounded in `spotify.rs`, so `busy` can no longer be held for the life
   * of the process by a network that is not answering.
   */
  async link() {
    await this.#guard(async () => {
      await invoke("spotify_link");
      await invoke("spotify_start", {});
      await this.refresh();
    });
  }

  async forget() {
    await this.#guard(async () => {
      await invoke("spotify_forget");
      await this.refresh();
    });
  }

  async start() {
    await this.#guard(async () => {
      await invoke("spotify_start", {});
      await this.refresh();
    });
  }

  async stop() {
    await this.#guard(async () => {
      await invoke("spotify_stop");
      await this.refresh();
    });
  }

  /**
   * One door to the transport, matching `spotify_command`. Nothing is folded
   * optimistically: librespot answers with an event either way, and a face that
   * moved before the player did is a face that lies when the player refuses.
   */
  async command(verb: string, value?: number) {
    try {
      await invoke("spotify_command", { verb, value: value ?? null });
    } catch (e) {
      this.state = { ...this.state, phase: "fault", fault: String(e) };
    }
  }

  playPause() {
    return this.command("playpause");
  }
  next() {
    return this.command("next");
  }
  prev() {
    return this.command("prev");
  }
  seek(ms: number) {
    return this.command("seek", Math.max(0, Math.round(ms)));
  }
  /** Takes 0..1, because that is what a face has; the wire wants a u16. */
  setVolume(v: number) {
    return this.command("volume", volumeToWire(v));
  }

  async #guard(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    try {
      await work();
    } catch (e) {
      this.state = { ...this.state, phase: "fault", fault: String(e) };
    } finally {
      this.busy = false;
    }
  }
}

/**
 * The wall has one of these. A module-level singleton rather than something
 * `App.svelte` threads through `WidgetNode`, because that file is somebody
 * else's and a widget is the only thing that ever wants this — if a second
 * subsystem ever needs it, promote it to a prop then and not before.
 */
export const deck = new Deck();
