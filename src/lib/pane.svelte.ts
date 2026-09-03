/* The one connection behind however many browser widgets are on the wall.
 *
 * The same bargain `Meter`, `Ledger`, `DevOps` and `Board` strike: a widget asks
 * by attaching and stops asking by detaching, and with nobody attached nothing
 * is connected and no frames are asked for. A wall with no browser widget up
 * holds no socket.
 *
 * Unlike those four it **does not poll**, and this is the cleanest case of it in
 * the app. `Page.startScreencast` pushes a `Page.screencastFrame` for every
 * change and nothing for stillness — measured 0 frames in 1.2s on an idle page —
 * so there is an event for every change there is and a timer here would be a
 * poll for news that arrives on its own. The console and the network are the
 * same shape: `Runtime.consoleAPICalled` and `Network.*` are pushed.
 *
 * ### Why the socket is here and not in Rust
 *
 * `browser.rs` starts Chrome, waits for the port, and lists targets. It
 * deliberately does not carry a frame: a screencast frame is up to 95 kB of
 * base64, thirty times a second at worst, and every one of them crossing the
 * Tauri IPC would be a JSON envelope serialised on one side and parsed on the
 * other — on the main thread, which is the only thread that paints the wall.
 * The webview can open a WebSocket itself, so it does, and `CLAUDE.md`'s "Rust
 * folds nothing" holds for exactly the reason it was written.
 *
 * The one thing that makes this possible is on the Rust side and is easy to
 * lose: Chrome is launched with `--remote-allow-origins`, without which the
 * handshake from a webview is rejected for carrying an `Origin` header — and
 * the `/json/*` endpoints answer fine either way, so it fails after everything
 * appears to work.
 *
 * Named for what it holds rather than for its component. `browser.svelte.ts`
 * beside `Browser.svelte` is the *same import specifier* on this filesystem and
 * `svelte-check` refuses the program outright — the trap `journal.svelte.ts`,
 * `deck.svelte.ts` and `waterfall.svelte.ts` are each already named around.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  consoleRow,
  failedRow,
  frameUrl,
  networkRow,
  savedWhat,
  storageStateFrom,
  type FrameMeta,
  type KeyMsg,
} from "./browser";
import type { Row } from "./logface";

export type Status = {
  running: boolean;
  port: number;
  endpoint: string;
  version: string;
  procs: number;
};

export type Target = {
  id: string;
  kind: string;
  title: string;
  url: string;
  ws: string;
};

/** How many log rows are kept.
 *
 * The same number front and back as `applog.ts`'s ring, and for its reason: a
 * face that remembered more than the source can produce would shorten its own
 * history on a reload and read as data loss. Here the source is a socket that
 * keeps nothing at all, so this *is* the whole memory — and it is thrown away
 * when the last widget detaches, which is honest: the console of a page you
 * stopped looking at is not a record of anything.
 */
const KEEP = 400;

/** What one attached page is, while somebody is looking at it. */
type Live = {
  socket: WebSocket;
  /** Widget ids watching this page. The last one out closes the socket. */
  watchers: Set<string>;
  /** Whether anybody wants the picture. Kept apart from `watchers` because a
   *  log-only widget attaches to the same page and must not pay for frames. */
  seeing: Set<string>;
  next: number;
  /** Replies still owed, by request id. Most of this file is fire-and-forget —
   *  a frame needs no answer and an input event has none — but reading the
   *  session out of a browser is a question, so those few calls need their
   *  answers matched back. */
  owed: Map<number, (v: unknown) => void>;
};

export class Pane {
  status = $state<Status>({
    running: false,
    port: 9222,
    endpoint: "",
    version: "",
    procs: 0,
  });
  targets = $state<Target[]>([]);
  /** What went wrong, drawn on the face rather than swallowed — the same call
   *  `Board.fault` makes. */
  fault = $state<string | null>(null);
  /** Whether a start is in flight, so the face can say so rather than looking
   *  like a button that did nothing for ten seconds. */
  starting = $state(false);

  /** The latest frame per target, as a data url. */
  frames = $state<Record<string, string>>({});
  /** What that frame says about the page it pictures — the CSS viewport size,
   *  which is the unit input is dispatched in and is *not* the frame's own
   *  pixel size. */
  metas = $state<Record<string, FrameMeta>>({});
  /** Console and network lines per target, oldest first. */
  rows = $state<Record<string, Row[]>>({});

  #live = new Map<string, Live>();

  /* ── the browser itself ──────────────────────────────────────────────── */

  async refresh() {
    try {
      this.status = await invoke<Status>("browser_status");
      this.targets = this.status.running
        ? (await invoke<Target[]>("browser_targets")).filter((t) => t.kind === "page")
        : [];
      this.fault = null;
    } catch (e) {
      this.fault = String(e);
    }
  }

  async start() {
    if (this.starting) return;
    this.starting = true;
    this.fault = null;
    try {
      this.status = await invoke<Status>("browser_start", {});
      await this.refresh();
    } catch (e) {
      this.fault = String(e);
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    /* Every socket first. Chrome going away closes them anyway, but a close
       we did not ask for arrives as an error on the face — and "the browser you
       just stopped has stopped" is not news. */
    for (const id of [...this.#live.keys()]) this.#drop(id);
    try {
      this.status = await invoke<Status>("browser_stop");
      this.targets = [];
      this.frames = {};
      this.metas = {};
      this.rows = {};
    } catch (e) {
      this.fault = String(e);
    }
  }

  async open(url: string): Promise<Target | null> {
    try {
      const t = await invoke<Target>("browser_open", { url });
      await this.refresh();
      return t;
    } catch (e) {
      this.fault = String(e);
      return null;
    }
  }

  /* ── attaching ───────────────────────────────────────────────────────── */

  /** Say a widget is looking at a page, and whether it wants the picture.
   *
   * Idempotent in both arguments, because a widget re-attaches whenever its
   * variant or its target knob changes and re-opening the socket for that would
   * drop every frame and every log line each time somebody used the menu.
   */
  attach(widgetId: string, target: Target, seeing: boolean) {
    /* Anything this widget was watching before and is not now. A widget only
       ever looks at one page, so this is how the target knob moving detaches
       the old one without the component having to remember what it was. */
    for (const [id, live] of this.#live) {
      if (id !== target.id && live.watchers.has(widgetId)) this.#leave(id, widgetId);
    }

    const live = this.#live.get(target.id) ?? this.#join(target);
    if (!live) return;
    live.watchers.add(widgetId);
    const wanted = live.seeing.size > 0;
    if (seeing) live.seeing.add(widgetId);
    else live.seeing.delete(widgetId);
    /* Only on a change, since `attach` is called on every knob turn and
       `startScreencast` twice is a second stream of the same frames. */
    if (!wanted && live.seeing.size > 0) this.#screencast(live, true);
    if (wanted && live.seeing.size === 0) this.#screencast(live, false);
  }

  detach(widgetId: string) {
    for (const id of [...this.#live.keys()]) this.#leave(id, widgetId);
  }

  get watched(): boolean {
    return this.#live.size > 0;
  }

  #leave(targetId: string, widgetId: string) {
    const live = this.#live.get(targetId);
    if (!live) return;
    live.watchers.delete(widgetId);
    live.seeing.delete(widgetId);
    if (live.watchers.size === 0) this.#drop(targetId);
    else if (live.seeing.size === 0) this.#screencast(live, false);
  }

  #drop(targetId: string) {
    const live = this.#live.get(targetId);
    if (!live) return;
    this.#live.delete(targetId);
    /* `onclose` is cleared before closing, or tearing down deliberately would
       report itself as the connection being lost. */
    live.socket.onclose = null;
    live.socket.onerror = null;
    try {
      live.socket.close();
    } catch {
      /* Already closing. Nothing to do and nothing worth saying. */
    }
  }

  #join(target: Target): Live | null {
    if (!target.ws) {
      this.fault = "that page offers no debugger socket — something else is attached to it";
      return null;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(target.ws);
    } catch (e) {
      this.fault = String(e);
      return null;
    }
    const live: Live = {
      socket,
      watchers: new Set(),
      seeing: new Set(),
      next: 0,
      owed: new Map(),
    };
    this.#live.set(target.id, live);

    socket.onopen = () => {
      /* Page for the screencast and for navigation; Runtime for the console;
         Network for requests. All three are cheap to enable and none of them
         sends anything until there is something to send. */
      this.#send(live, "Page.enable");
      this.#send(live, "Runtime.enable");
      this.#send(live, "Network.enable");
      if (live.seeing.size > 0) this.#screencast(live, true);
    };
    socket.onmessage = (e) => this.#ingest(target.id, live, e.data);
    socket.onerror = () => {
      this.fault = "lost the connection to that page";
    };
    socket.onclose = () => {
      /* The page went away — navigated to a different target, or closed. Drop
         it rather than leaving widgets attached to a socket that is gone. */
      this.#live.delete(target.id);
      void this.refresh();
    };
    return live;
  }

  /* ── the wire ────────────────────────────────────────────────────────── */

  #send(live: Live, method: string, params: Record<string, unknown> = {}) {
    if (live.socket.readyState !== WebSocket.OPEN) return;
    live.socket.send(JSON.stringify({ id: ++live.next, method, params }));
  }

  #screencast(live: Live, on: boolean) {
    if (on) {
      /* jpeg at 70 and capped at 1600×1000: the cap is what keeps a frame in
         the tens of kilobytes on a large monitor, and quality is the knob that
         costs the least legibility per byte. Measured ~6 kB on a simple page
         and ~95 kB for a full 1280×800 view of a real app at 80. */
      this.#send(live, "Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: 1600,
        maxHeight: 1000,
        everyNthFrame: 1,
      });
    } else {
      this.#send(live, "Page.stopScreencast");
    }
  }

  #ingest(targetId: string, live: Live, data: unknown) {
    if (typeof data !== "string") return;
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    /* A reply rather than an event: it carries an id and no method. Resolved
       and returned, since nothing below has a case for it. */
    const id = (msg as { id?: number }).id;
    if (typeof id === "number" && live.owed.has(id)) {
      live.owed.get(id)!((msg as { result?: unknown }).result ?? {});
      live.owed.delete(id);
      return;
    }

    const p = (msg.params ?? {}) as Record<string, never>;

    switch (msg.method) {
      case "Page.screencastFrame": {
        const meta = p["metadata"] as unknown as FrameMeta | undefined;
        const raw = p["data"] as unknown as string | undefined;
        if (raw) this.frames = { ...this.frames, [targetId]: frameUrl(raw) };
        if (meta) this.metas = { ...this.metas, [targetId]: meta };
        /* Chrome stops sending frames until the last one is acknowledged, which
           is what stops a slow reader building a queue it can never drain — so
           a missing ack is not a slow widget, it is a frozen picture. */
        const sessionId = p["sessionId"];
        if (sessionId !== undefined) {
          this.#send(live, "Page.screencastFrameAck", { sessionId });
        }
        break;
      }
      case "Runtime.consoleAPICalled":
        this.#push(targetId, consoleRow(p as never));
        break;
      case "Runtime.exceptionThrown": {
        const d = (p["exceptionDetails"] ?? {}) as { text?: string; exception?: { description?: string } };
        this.#push(targetId, {
          mark: "error",
          tone: "fail",
          text: d.exception?.description ?? d.text ?? "uncaught exception",
        });
        break;
      }
      case "Network.responseReceived":
        this.#push(targetId, networkRow(p as never));
        break;
      case "Network.loadingFailed":
        this.#push(targetId, failedRow(p as never));
        break;
      case "Page.frameNavigated":
        /* A navigation is worth a line in the log — it is the boundary every
           other line is read against, and without it a console that suddenly
           empties looks like a log that broke. */
        {
          const f = (p["frame"] ?? {}) as { url?: string; parentId?: string };
          if (!f.parentId && f.url) {
            this.#push(targetId, { mark: "go", tone: "plain", text: f.url });
            void this.refresh();
          }
        }
        break;
    }
  }

  #push(targetId: string, row: Row) {
    const had = this.rows[targetId] ?? [];
    const next = had.length >= KEEP ? [...had.slice(had.length - KEEP + 1), row] : [...had, row];
    this.rows = { ...this.rows, [targetId]: next };
  }

  /* ── driving a page ──────────────────────────────────────────────────── */

  /** Send a mouse event to a page, in that page's own CSS pixels.
   *
   * Synthesized inside the renderer, so it needs no real window focus — which
   * is the fact this whole feature rests on. The wall keeps the pointer, Chrome
   * does not come to the front, and nothing competes with the canvas for
   * gestures.
   */
  mouse(
    targetId: string,
    type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
    params: Record<string, unknown>,
  ) {
    const live = this.#live.get(targetId);
    if (live) this.#send(live, "Input.dispatchMouseEvent", { type, ...params });
  }

  /** Send the one or two messages a keystroke takes — see `keyMessages`, and
   *  note that a printable key without its `char` is a keystroke that fires
   *  every listener and inserts nothing. */
  keys(targetId: string, msgs: KeyMsg[]) {
    const live = this.#live.get(targetId);
    if (!live) return;
    for (const m of msgs) this.#send(live, "Input.dispatchKeyEvent", m as never);
  }

  navigate(targetId: string, url: string) {
    const live = this.#live.get(targetId);
    if (live) this.#send(live, "Page.navigate", { url });
  }

  reload(targetId: string) {
    const live = this.#live.get(targetId);
    if (live) this.#send(live, "Page.reload", {});
  }

  /* ── the session vault ───────────────────────────────────────────────── */

  /** What the last save wrote, so the widget can say it back. */
  saved = $state<string | null>(null);
  saving = $state(false);

  /** Ask one question of a socket and wait for the answer. */
  #call(live: Live, method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => {
      if (live.socket.readyState !== WebSocket.OPEN) return resolve({});
      const n = ++live.next;
      live.owed.set(n, resolve as (v: unknown) => void);
      /* A reply that never comes must not hang the save. Five seconds is far
         past a loopback round trip, and resolving empty degrades to "that page
         contributed nothing" rather than to a promise nobody settles. */
      setTimeout(() => {
        if (live.owed.delete(n)) resolve({});
      }, 5000);
      live.socket.send(JSON.stringify({ id: n, method, params }));
    });
  }

  /** Open a socket, ask, close.
   *
   * Every open page is read, not only the ones a widget happens to be attached
   * to — you sign in on one tab and the vault should carry it whether or not
   * you were watching that tab through a widget. So this borrows a socket for
   * the length of one question rather than reusing `#live`, and takes care not
   * to disturb it: a page already attached keeps its own connection, and this
   * one is closed the moment it has answered.
   */
  async #ask(target: Target, method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!target.ws) return {};
    let socket: WebSocket;
    try {
      socket = new WebSocket(target.ws);
    } catch {
      return {};
    }
    const live: Live = {
      socket,
      watchers: new Set(),
      seeing: new Set(),
      next: 0,
      owed: new Map(),
    };
    try {
      await new Promise<void>((res, rej) => {
        socket.onopen = () => res();
        socket.onerror = () => rej(new Error("no"));
        setTimeout(() => rej(new Error("timeout")), 4000);
      });
      socket.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data));
          if (typeof m.id === "number" && live.owed.has(m.id)) {
            live.owed.get(m.id)!(m.result ?? {});
            live.owed.delete(m.id);
          }
        } catch {
          /* Not JSON. Nothing on this socket answers to that. */
        }
      };
      return await this.#call(live, method, params);
    } catch {
      return {};
    } finally {
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* Already closing. */
      }
    }
  }

  /** Save every sign-in the shared browser is holding, for seeded browsers.
   *
   * The point of the whole vault: you sign into rise, nova, mikano and sdp once,
   * here, and every card that wants its *own* browser gets those sessions
   * without signing in again.
   *
   * Local storage is read with `Runtime.evaluate` rather than through the
   * `DOMStorage` domain, and that is a version-proofing choice rather than a
   * shortcut: `DOMStorage.getDOMStorageItems` is keyed by `securityOrigin` in
   * older Chromes and by `storageKey` in newer ones, so the domain needs to
   * know which Chrome it is talking to. `Object.entries(localStorage)` has
   * meant one thing for fifteen years.
   *
   * Cookies come from one page's socket because they are browser-wide — asking
   * every tab would return the same jar each time.
   */
  async saveSession(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.saved = null;
    this.fault = null;
    try {
      await this.refresh();
      if (this.targets.length === 0) {
        this.saved = "nothing to save — no page is open";
        return;
      }

      const jar = await this.#ask(this.targets[0], "Network.getAllCookies");

      const origins: { origin: string; entries: [string, string][] }[] = [];
      for (const t of this.targets) {
        let origin = "";
        try {
          origin = new URL(t.url).origin;
        } catch {
          continue; /* about:blank and friends have no origin to key on. */
        }
        const got = await this.#ask(t, "Runtime.evaluate", {
          expression: "JSON.stringify(Object.entries(localStorage))",
          returnByValue: true,
        });
        const raw = got?.result?.value;
        if (typeof raw !== "string") continue;
        try {
          const entries = JSON.parse(raw);
          if (Array.isArray(entries)) origins.push({ origin, entries });
        } catch {
          /* A page that would not serialise its own storage. Skipped rather
             than failing the save — one hostile page must not cost the other
             three their sign-ins. */
        }
      }

      const state = storageStateFrom(
        Array.isArray(jar?.cookies) ? jar.cookies : [],
        origins,
        Math.floor(Date.now() / 1000),
      );
      await invoke<string>("browser_save_session", { state: JSON.stringify(state) });
      this.saved = savedWhat(state);
    } catch (e) {
      this.fault = String(e);
    } finally {
      this.saving = false;
    }
  }

  /** Where the vault is, for the widget to show. */
  async sessionFile(): Promise<string> {
    try {
      return await invoke<string>("browser_session_file");
    } catch {
      return "";
    }
  }

  /** Drop every socket. Called from `App.svelte`'s `onDestroy` for the reason
   *  `Listeners` exists: a superseded instance that kept its sockets would go
   *  on acknowledging frames for a wall nobody is looking at. */
  release() {
    for (const id of [...this.#live.keys()]) this.#drop(id);
  }
}
