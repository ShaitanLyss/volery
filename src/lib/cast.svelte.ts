/* Every screen on the wall, and the one thing that knows which are being seen.
 *
 * The bargain `Pane`, `Meter` and `Ledger` strike, one subject over: a screen
 * widget attaches and detaches, and with nothing attached there is no worker,
 * no socket and nothing asked of the host. What differs is that each screen is
 * its own stream, so where `Pane` keeps one socket per page this keeps one
 * **worker** per widget — the worker holds the socket and the decoder
 * (`cast.worker.ts`), and this side holds only what the face draws: a state
 * word, a stats line, the remote cursor's CSS while driving.
 *
 * **A module singleton rather than a holder threaded down**, the arrangement
 * `deck` and `chronicle` already have. Three surfaces reach it — the tile on the
 * wall, the focused overlay at the window's root, and chat view's list — and
 * they sit in three unrelated subtrees. Threading it through `Canvas` and
 * `WidgetNode` for one of them and importing it in the other two would be the
 * prop CLAUDE.md warns about: a capability one surface has to remember.
 *
 * **What a tile wants is decided here, from three facts the face cannot see
 * together**: whether it is on screen (one `IntersectionObserver` for every
 * tile, which also answers chat view, since the wall is `display: none` there),
 * whether a focused screen is covering the whole window, and its size in device
 * pixels. `cast.ts::want` turns those into the adaptive table; a want that
 * compares equal to the last is not sent, so panning the wall costs nothing.
 *
 * Named `cast.svelte.ts` after what it holds; there is no `Cast.svelte` for it
 * to collide with on this filesystem (the trap `journal.svelte.ts` is named
 * around).
 */

import { untrack } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { view } from "./view.svelte";
import { keyInput } from "./castinput";
import {
  parseScreen,
  resolveMonitor,
  screenKey,
  sameWant,
  EscapeHold,
  want,
  type CastState,
  type Config,
  type FromWorker,
  type Monitor,
  type Paint,
  type Stats,
  type ToWorker,
  type Want,
} from "./cast";

/** What a face draws for one session. */
export type Showing = {
  state: CastState;
  why: string;
  config: Config | null;
  hardware: boolean;
  stats: Stats | null;
  dropped: number;
  paintMs: number;
  /** Direct or through the relay, for a far screen; null for this machine's. */
  path: "direct" | "relay" | null;
  /** The remote cursor as CSS, while driving. */
  cursor: string;
};

const FRESH: Showing = {
  state: "connecting",
  why: "",
  config: null,
  hardware: true,
  stats: null,
  dropped: 0,
  paintMs: 0,
  path: null,
  cursor: "default",
};

/** A far wall's screens, as its roster row announces them. Empty until the
 *  flyway lane lands `Facts.screens`; the picker is built for both already. */
export type Elsewhere = { host: string; name: string; monitors: Monitor[] };

/** Where a tile stands. A `wall` tile is offstage under chat view and asks
 *  for nothing there, whatever the observer last said; one drawn in chat
 *  view's sheet or a root overlay is seen in whichever room put it up. */
export type Room = "wall" | "any";

type Live = {
  worker: Worker;
  key: string;
  room: Room;
  calm: boolean;
  driving: boolean;
  /** What the tile last reported about itself. */
  box: { w: number; h: number; scale: number };
  intersecting: boolean;
  sent: Want | null;
  /** The size the current surface was last told, so a resize that changes
   *  nothing is not posted. */
  size: string;
  el: HTMLElement | null;
  /** The tile's own box while the focused overlay has borrowed `box`. */
  tileBox: { w: number; h: number; scale: number } | null;
  /** Bumped by every open, so an invoke that comes back after a newer one
   *  started cannot dial a stale url. */
  epoch: number;
};

/** Which painter the tile uses. `2d` unless measured otherwise — see the
 *  measurement in `cast.worker.ts`'s comment and `tools/castlab.ts`. */
const PAINT: Paint = "2d";

class Casts {
  /** This machine's monitors, from `cast_monitors`. */
  monitors = $state<Monitor[]>([]);
  /** Other walls' screens. */
  elsewhere = $state<Elsewhere[]>([]);
  /** Per widget id. */
  showing = $state<Record<string, Showing>>({});
  /** The session whose screen fills the window, if any. */
  focused = $state<string | null>(null);
  /** What chat view's sheet shows instead of a conversation: one screen, by
   *  key, or `all` for the grid. Held here rather than in `ChatView` so the
   *  sidebar, the sheet and the leader reach one value. */
  sheet = $state<string | null>(null);
  /** The grid of every screen, over the wall (`space r a`). */
  grid = $state(false);
  /** Screens kept floating over chat view's conversation, each where it was
   *  last put — Lyss: *"it's nice to be able to have floating vignettes"*.
   *  Chat view's own: on the wall the same thing is a screen widget stuck to
   *  the glass, which the wall already has. Kept per machine, beside the
   *  view itself (`view.svelte.ts`), since where a vignette sits is about
   *  this window and not about the wall. */
  floats = $state<Float[]>(readFloats());
  /** Every screen widget that is up, so chat view can list them without
   *  reaching into the widget registry. id → its key. */
  up = $state<Record<string, string>>({});

  /** Who is watching *this* machine's screens from another wall, by the
   *  host's session id — `cast:watched`, for the quiet mark the contract
   *  owes the person at this machine. */
  watched = $state<Record<number, { viewer: string | null; monitor: string; driven: boolean }>>({});

  #live = new Map<string, Live>();
  #peeks = new Map<number, (png: Blob | null) => void>();
  #peekN = 0;
  #unlisten: UnlistenFn[] = [];
  #started = false;
  #io: IntersectionObserver | null = null;
  #byEl = new WeakMap<Element, string>();
  #monitorsAsked = 0;

  constructor() {
    /* Chat view hides the wall with `display: none`, which the observer reads
       as leaving the viewport — but say it outright as well, since an observer
       only fires on a change and a view switch must take effect now. */
    $effect.root(() => {
      $effect(() => {
        void view.current;
        void this.focused;
        /* Only those two: `#push` reads every session's reading, and a stats
           line twice a second is not a reason to recompute every want. */
        untrack(() => {
          for (const id of this.#live.keys()) this.#push(id);
        });
      });
    });
  }

  /** Ask this machine for its monitors, at most every few seconds. Called by
   *  a tile attaching and by the menu opening — a monitor plugged in mid-
   *  session turns up the next time somebody looks for one. */
  async loadMonitors(force = false): Promise<Monitor[]> {
    const now = Date.now();
    if (!force && now - this.#monitorsAsked < 5000) return this.monitors;
    this.#monitorsAsked = now;
    const fake = fakeRelay();
    if (fake) {
      this.monitors = [FAKE_MONITOR];
      return this.monitors;
    }
    try {
      this.monitors = await invoke<Monitor[]>("cast_monitors");
    } catch {
      /* Not in this build yet, or not on this OS: an empty list, and the tile
         says why when it tries to open. */
    }
    return this.monitors;
  }

  /** The monitor a key names, if it can be resolved here. */
  monitorOf(key: string): Monitor | null {
    const { host, monitor } = parseScreen(key);
    const list = host ? (this.elsewhere.find((e) => e.host === host)?.monitors ?? []) : this.monitors;
    return resolveMonitor(list, monitor);
  }

  /** The name of the machine a key is on, for the label. */
  machineOf(key: string): string {
    const { host } = parseScreen(key);
    if (!host) return "this machine";
    return this.elsewhere.find((e) => e.host === host)?.name ?? host;
  }

  /** Every screen this wall could show: this machine's, then each other
   *  wall's that announces any — which a wall does only while it takes work
   *  from other walls (`docs/SCREENS.md`), so everything here would open. */
  get every(): { key: string; machine: string; monitor: Monitor; all: Monitor[] }[] {
    return [
      ...this.monitors.map((m) => ({ key: screenKey(null, m.id), machine: "this machine", monitor: m, all: this.monitors })),
      ...this.elsewhere.flatMap((e) =>
        e.monitors.map((m) => ({ key: screenKey(e.host, m.id), machine: e.name, monitor: m, all: e.monitors })),
      ),
    ];
  }

  /** A tile comes up: start its worker, hand it the tile's two canvases, and
   *  dial. Returns the detach. */
  attach(
    id: string,
    key: string,
    video: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    room: Room = "wall",
  ): () => void {
    if (this.#live.has(id)) this.detach(id);
    let surface;
    try {
      surface = {
        video: video.transferControlToOffscreen(),
        overlay: overlay.transferControlToOffscreen(),
      };
    } catch {
      /* Already handed away — `synth.svelte.ts`'s guard, for its reason. */
      return () => {};
    }
    const worker = new Worker(new URL("./cast.worker.ts", import.meta.url), { type: "module" });
    const live: Live = {
      worker,
      key,
      room,
      calm: false,
      driving: false,
      box: { w: 0, h: 0, scale: 1 },
      intersecting: false,
      sent: null,
      size: "",
      el: null,
      tileBox: null,
      epoch: 0,
    };
    this.#live.set(id, live);
    this.showing[id] = { ...FRESH };
    this.up[id] = key;
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.#heard(id, e.data);
    worker.onerror = () => this.#patch(id, { state: "ended", why: "the decoder did not start" });
    this.#post(id, { t: "tile", surface, paint: PAINT }, [surface.video, surface.overlay]);
    void this.#open(id);
    return () => this.detach(id);
  }

  detach(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    if (live.el) {
      this.#io?.unobserve(live.el);
    }
    live.worker.postMessage({ t: "close" } satisfies ToWorker);
    /* `close` lets the worker shut its socket cleanly; terminate is the
       backstop for a worker wedged in a decode. */
    setTimeout(() => live.worker.terminate(), 1000);
    this.#live.delete(id);
    delete this.showing[id];
    delete this.up[id];
    if (this.focused === id) this.focused = null;
  }

  /** The tile now shows a different screen. */
  retarget(id: string, key: string) {
    const live = this.#live.get(id);
    if (!live || live.key === key) return;
    live.key = key;
    live.sent = null;
    this.up[id] = key;
    this.#patch(id, { ...FRESH });
    void this.#open(id);
  }

  /** Dial again, after an `ended`. */
  reconnect(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    live.sent = null;
    this.#patch(id, { state: "connecting", why: "" });
    void this.#open(id);
  }

  async #open(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    const epoch = ++live.epoch;
    const { host, monitor } = parseScreen(live.key);
    if (!host && this.monitors.length === 0) await this.loadMonitors(true);
    /* The role is resolved here rather than by the host: "primary" is a word
       about *this* list, and a host asked for "primary" would answer with its
       own idea of one — the same one today, and a different one the day a dock
       is plugged in on one side and not the other. */
    const m = this.monitorOf(live.key);
    const id_ = m?.id ?? monitor;
    if (m) this.#post(id, { t: "native", w: m.w, h: m.h });
    try {
      const fake = fakeRelay();
      const { url } = fake
        ? { url: `${fake}/view` }
        : await invoke<{ url: string }>("cast_open", { host, monitor: id_ });
      if (this.#live.get(id) !== live || live.epoch !== epoch) return;
      this.#post(id, { t: "open", url });
      this.#push(id);
    } catch (err) {
      if (this.#live.get(id) !== live || live.epoch !== epoch) return;
      const why = String(err);
      this.#patch(id, {
        state: /not found|unknown command/i.test(why) ? "ended" : /refus/i.test(why) ? "refused" : "ended",
        why: /not found|unknown command/i.test(why) ? "screens are not in this build yet" : why,
      });
    }
  }

  /** The tile's element, so one observer can say whether it is on screen. */
  observe(id: string, el: HTMLElement): () => void {
    const live = this.#live.get(id);
    if (!live) return () => {};
    this.#io ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const which = this.#byEl.get(e.target);
          const l = which ? this.#live.get(which) : null;
          if (!which || !l) continue;
          l.intersecting = e.isIntersecting;
          this.#push(which);
        }
      },
      /* A margin, so a tile panned on screen has its keyframe asked for a
         moment before it arrives rather than the moment after. */
      { rootMargin: "64px" },
    );
    live.el = el;
    this.#byEl.set(el, id);
    this.#io.observe(el);
    return () => {
      this.#io?.unobserve(el);
      if (live.el === el) live.el = null;
    };
  }

  /** The tile's box in wall units and the wall's zoom. */
  size(id: string, w: number, h: number, scale: number) {
    const live = this.#live.get(id);
    if (!live) return;
    if (this.focused === id && live.tileBox) live.tileBox = { w, h, scale };
    else live.box = { w, h, scale };
    this.#push(id);
  }

  /** Fill the window with this screen. `ScreenFocus` is drawn while this is
   *  set and hands its canvases over through `present`. */
  focus(id: string) {
    if (this.#live.has(id)) this.focused = id;
  }

  /** Leave the focused screen. */
  unfocus() {
    this.focused = null;
  }

  /** The focused overlay's canvases: the worker paints there until the
   *  returned cleanup runs, and then goes back to the tile. */
  present(id: string, video: HTMLCanvasElement, overlay: HTMLCanvasElement): () => void {
    const live = this.#live.get(id);
    if (!live) return () => {};
    let surface;
    try {
      surface = {
        video: video.transferControlToOffscreen(),
        overlay: overlay.transferControlToOffscreen(),
      };
    } catch {
      return () => {};
    }
    this.#post(id, { t: "focus", surface }, [surface.video, surface.overlay]);
    live.size = "";
    live.tileBox = live.box;
    return () => {
      if (!this.#live.has(id)) return;
      this.#post(id, { t: "unfocus" });
      live.size = "";
      live.box = live.tileBox ?? live.box;
      live.tileBox = null;
      this.#push(id);
    };
  }

  /** The focused overlay's size, in CSS pixels. */
  focusSize(id: string, w: number, h: number) {
    const live = this.#live.get(id);
    if (!live || this.focused !== id) return;
    live.box = { ...live.box, w, h, scale: 1 };
    this.#push(id);
  }

  /** Input events, as `castinput.ts` encodes them. Transferred, not copied. */
  input(id: string, bytes: Uint8Array | null) {
    if (!bytes || bytes.length === 0) return;
    const buf =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    this.#post(id, { t: "input", bytes: buf }, [buf]);
  }

  /** The widget's reading: `calm` asks for a frame a second while watched. */
  setCalm(id: string, calm: boolean) {
    const live = this.#live.get(id);
    if (!live || live.calm === calm) return;
    live.calm = calm;
    this.#push(id);
  }

  drive(id: string, on: boolean) {
    const live = this.#live.get(id);
    if (live) {
      live.driving = on;
      this.#push(id);
    }
    this.#post(id, { t: "drive", on });
    if (!on) this.#patch(id, { cursor: "default" });
  }

  /** Hear the roster's screens and the host's mark. Called once by `App`;
   *  `release` lets go. The roster is heard here rather than read off
   *  `Elsewhere` because the holder is a module singleton and `Elsewhere` is
   *  App's — one listener more is cheaper than a prop every screen surface
   *  would have to be handed. */
  start() {
    if (this.#started) return;
    this.#started = true;
    type Row = { host: string; me: boolean; screens?: Monitor[] };
    const take = (rows: Row[]) => {
      if (!Array.isArray(rows)) return;
      this.elsewhere = rows
        .filter((r) => !r.me && Array.isArray(r.screens) && r.screens.length > 0)
        .map((r) => ({ host: r.host, name: r.host, monitors: r.screens ?? [] }));
    };
    void invoke<Row[]>("flyway_roster").then(take).catch(() => {});
    const keep = (p: Promise<UnlistenFn>) =>
      void p.then((un) => (this.#started ? this.#unlisten.push(un) : un())).catch(() => {});
    keep(listen<Row[]>("flyway:roster", (e) => take(e.payload)));
    keep(
      listen<{ viewer: string | null; monitor: string; sid: number; on: boolean; driven: boolean }>(
        "cast:watched",
        (e) => {
          const w = e.payload;
          if (w.on) this.watched[w.sid] = { viewer: w.viewer, monitor: w.monitor, driven: w.driven };
          else delete this.watched[w.sid];
        },
      ),
    );
  }

  /** Float a screen over chat view, or stop floating it. */
  toggleFloat(key: string) {
    const at = this.floats.findIndex((f) => f.key === key);
    if (at >= 0) this.floats.splice(at, 1);
    else this.floats.push({ key, ...nextFloatSpot(this.floats) });
    saveFloats(this.floats);
  }

  moveFloat(key: string, x: number, y: number) {
    const f = this.floats.find((f) => f.key === key);
    if (!f) return;
    f.x = x;
    f.y = y;
    saveFloats(this.floats);
  }

  /** The session's picture as it stands, as a PNG, or null. For the control
   *  surface only (`screen.peek`): one frame crosses to this thread because a
   *  test asked, never per frame. */
  peek(id: string): Promise<Blob | null> {
    if (!this.#live.has(id)) return Promise.resolve(null);
    const nonce = ++this.#peekN;
    return new Promise((done) => {
      this.#peeks.set(nonce, done);
      this.#post(id, { t: "peek", nonce });
      setTimeout(() => {
        if (this.#peeks.delete(nonce)) done(null);
      }, 5000);
    });
  }

  /** Every session's id, for the control surface. */
  get sessions(): string[] {
    return [...this.#live.keys()];
  }

  /** Everything, for the window going away. */
  release() {
    this.#started = false;
    for (const un of this.#unlisten.splice(0)) un();
    for (const id of [...this.#live.keys()]) this.detach(id);
    this.#io?.disconnect();
    this.#io = null;
  }

  /* ── inside ──────────────────────────────────────────────────────────── */

  #post(id: string, m: ToWorker, transfer: Transferable[] = []) {
    this.#live.get(id)?.worker.postMessage(m, transfer);
  }

  #patch(id: string, p: Partial<Showing>) {
    const cur = this.showing[id];
    if (!cur) return;
    this.showing[id] = { ...cur, ...p };
  }

  #heard(id: string, m: FromWorker) {
    switch (m.t) {
      case "state":
        this.#patch(id, { state: m.state, why: m.why });
        break;
      case "config":
        this.#patch(id, { config: m.config, hardware: m.hardware });
        this.#push(id);
        break;
      case "stats": {
        const path = m.host?.path === "direct" || m.host?.path === "relay" ? m.host.path : null;
        this.#patch(id, { stats: m.stats, dropped: m.dropped, paintMs: m.paintMs, path });
        break;
      }
      case "cursor":
        this.#patch(id, { cursor: m.css });
        break;
      case "peek": {
        const done = this.#peeks.get(m.nonce);
        this.#peeks.delete(m.nonce);
        done?.(m.png);
        break;
      }
    }
  }

  /** Recompute what this tile wants, and say so if it changed. */
  #push(id: string) {
    const live = this.#live.get(id);
    if (!live) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const focused = this.focused === id;
    /* A focused screen covers the window, so every other tile is behind it and
       asks for nothing; the focused one is visible in either view. */
    const visible = focused
      ? true
      : this.focused === null && (live.room === "any" || view.current === "wall") && live.intersecting;
    const m = this.monitorOf(live.key);
    const cfg = this.showing[id]?.config ?? null;
    const src = m ? { w: m.w, h: m.h } : cfg ? { w: cfg.w, h: cfg.h } : null;

    const size = `${Math.round(live.box.w * live.box.scale * dpr)}x${Math.round(live.box.h * live.box.scale * dpr)}`;
    if (size !== live.size) {
      live.size = size;
      this.#post(id, {
        t: "size",
        w: live.box.w * live.box.scale * dpr,
        h: live.box.h * live.box.scale * dpr,
        dpr,
      });
    }
    if (live.box.w <= 0) return;
    const next = want({
      boxW: live.box.w,
      boxH: live.box.h,
      scale: live.box.scale,
      dpr,
      src,
      hz: m?.hz ?? cfg?.fps ?? 60,
      visible,
      focused,
      calm: live.calm,
      driving: live.driving,
    });
    if (sameWant(next, live.sent)) return;
    live.sent = next;
    this.#post(id, { t: "want", want: next });
  }
}

/** A vignette: which screen, and where its top-left sits, in pixels from the
 *  window's bottom-right — so a window made smaller keeps them in reach rather
 *  than leaving them stranded past an edge. */
export type Float = { key: string; x: number; y: number };

const FLOATS_KEY = "skein.cast.floats.v1";

function readFloats(): Float[] {
  try {
    const v = JSON.parse(localStorage.getItem(FLOATS_KEY) ?? "[]");
    return Array.isArray(v)
      ? v.filter((f) => f && typeof f.key === "string" && Number.isFinite(f.x) && Number.isFinite(f.y))
      : [];
  } catch {
    return [];
  }
}

function saveFloats(fs: Float[]) {
  try {
    localStorage.setItem(FLOATS_KEY, JSON.stringify(fs));
  } catch {
    /* A full or refused store loses where a vignette sat, not the vignette. */
  }
}

/** Where a new vignette goes: stacked up the right edge above the last. */
function nextFloatSpot(fs: Float[]): { x: number; y: number } {
  return { x: 24, y: 120 + fs.length * 210 };
}

/** A development stand-in for this machine's screens: `tools/cast-relay.ts`
 *  carrying `tools/castlab.ts`'s encoder, which speaks the same wire. Set by
 *  `VITE_CAST_RELAY` in the environment a lab's vite runs in, or by hand —
 *  `localStorage["skein.cast.relay"] = "ws://127.0.0.1:14399"` — and only
 *  honoured by a debug build, so an installed wall never dials a relay
 *  somebody left a key for. */
const FAKE_KEY = "skein.cast.relay";
const FAKE_MONITOR: Monitor = {
  id: "castlab:0",
  name: "castlab",
  w: 1920,
  h: 1080,
  x: 0,
  y: 0,
  hz: 60,
  primary: true,
};
function fakeRelay(): string | null {
  if (!import.meta.env.DEV) return null;
  /* Or for a whole lab at once, from the environment vite was started in:
     `VITE_CAST_RELAY=ws://127.0.0.1:14399 bun run lab <name>`. */
  const env = import.meta.env.VITE_CAST_RELAY as string | undefined;
  if (env) return env;
  try {
    return localStorage.getItem(FAKE_KEY) || null;
  } catch {
    return null;
  }
}

export const casts = new Casts();

/** Escape on a screen you are driving, as a tap the machine gets or a hold
 *  that leaves (`cast.ts::EscapeHold`). Reactive `holding`, so the face can
 *  draw the ring filling while you hold. The tile and the immersive overlay
 *  both use it, so the gesture cannot mean two things in two places. */
export function useEscapeHold(sid: () => string, leave: () => void) {
  let holding = $state(false);
  const hold = new EscapeHold({
    tap: () => {
      casts.input(sid(), keyInput({ code: "Escape", type: "keydown" }));
      casts.input(sid(), keyInput({ code: "Escape", type: "keyup" }));
    },
    hold: leave,
    change: (h) => (holding = h),
  });
  return {
    get holding() {
      return holding;
    },
    down: () => hold.down(),
    up: () => hold.up(),
    cancel: () => hold.cancel(),
  };
}
