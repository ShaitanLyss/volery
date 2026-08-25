/* The editor's sessions — one nvim per project, and the panel's reading of it.
 *
 * Two shapes worth knowing before reading this, both borrowed from
 * `shell.svelte.ts` because they were right there and are right here.
 *
 * **The panel leaving edit mode does not close the editor.** The finder's panel
 * has three readings — the list, the file, and this — and switching back to one
 * of the others leaves nvim exactly where it was, with your buffers open, your
 * undo history, your unsaved changes and your language servers warm. That is
 * not a nicety: a real config takes about five seconds to start (measured on
 * this machine by `tools/probe-nvim.ts`), and an editor that paid that every
 * time you glanced at a search result would be one nobody opened twice.
 *
 * **There is one nvim per project, keyed on its root.** Same as the shell, and
 * for the stronger reason: an editor's working directory is what its LSP roots
 * itself on, what its file pickers search, and what `:Git` talks to. One nvim
 * across four repositories would be wrong about all three.
 *
 * ### The screen is not `$state`, and that is deliberate
 *
 * A hundred-by-forty grid is four thousand cells, rewritten on every keystroke.
 * Wrapping that in a `$state` proxy means Svelte tracking four thousand objects
 * and diffing them at the speed you type — the same shape of mistake
 * `shell.svelte.ts` made once by pushing a line at a time instead of batching to
 * a frame, which put the scheduler in front of the reader thread. So the screen
 * is plain data folded by `nvim.ts`, and the only reactive thing here is a
 * version number bumped once per animation frame. `Quill.svelte` reads the
 * version to know it must redraw, and then reads the screen.
 *
 * Holds Tauri subscriptions and has no lifecycle of its own, so `App.svelte`'s
 * `onDestroy` releases it — see ./listeners.ts for what a leaked one costs.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Listeners } from "./listeners";
import {
  type Screen,
  applyRedraw,
  cellAt,
  emptyScreen,
  gridSize,
  mouseMods,
  nvimKey,
  wheelDir,
} from "./nvim";

/** One project's editor. */
export class EditorSession {
  /** The project root: the id Rust files this nvim under, the directory it was
   *  started in, and what the panel looks it up by — deliberately one string,
   *  so a front end rebuilt by a Vite edit *finds* the session rather than
   *  spawning a second one beside it. */
  readonly key: string;

  /** Plain, not `$state` — see the note at the top of this file. */
  screen: Screen = emptyScreen();

  /** Bumped once per frame in which nvim said the screen was consistent. The
   *  only thing the component subscribes to. */
  version = $state(0);
  /** A session has been asked for and has not exited. */
  live = $state(false);
  /** Asked for and not yet answered — a real config is about five seconds of
   *  this, and it is the whole reason the panel says anything at all. */
  starting = $state(false);
  fault = $state<string | null>(null);
  /** What nvim calls the mode it is in. Drawn, because in an editor with no
   *  chrome of Volery's own it is the one thing you cannot infer by looking. */
  mode = $state("normal");
  /** The file it was last asked to open, for the bar above the grid. */
  path = $state("");

  /** The size last agreed with nvim, so a resize that changes nothing is not
   *  sent — the panel measures on every layout pass and nvim repaints the whole
   *  screen for each `try_resize`. */
  cols = 0;
  rows = 0;

  constructor(key: string) {
    this.key = key;
  }
}

export class Editor {
  /** Whether the finder's panel is showing the editor rather than a file or the
   *  list. Not whether an nvim is running, and not which one. */
  on = $state(false);
  sessions = $state<EditorSession[]>([]);
  /** The project whose editor the panel is showing. */
  activeKey = $state("");

  /** Measured from the panel's own font, and needed by every pointer gesture
   *  and every resize. Held here rather than in the component so the arithmetic
   *  stays in one place. */
  cellW = 0;
  cellH = 0;

  #listeners = new Listeners();
  #frame: number | null = null;
  #dirty = new Set<string>();
  #gone = false;

  constructor() {
    this.#wire();
  }

  detach() {
    this.#gone = true;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  get active(): EditorSession | null {
    return this.sessions.find((s) => s.key === this.activeKey) ?? null;
  }

  get live(): boolean {
    return this.active?.live ?? false;
  }
  get starting(): boolean {
    return this.active?.starting ?? false;
  }
  get fault(): string | null {
    return this.active?.fault ?? null;
  }
  get mode(): string {
    return this.active?.mode ?? "normal";
  }

  /** The editors running in other projects. Drawn as a count in the panel's
   *  header for the same reason the shell's is: once there is one per project,
   *  "something is still open elsewhere" is a fact with nowhere else to
   *  appear — and here it also means unsaved buffers. */
  get others(): EditorSession[] {
    return this.sessions.filter((s) => s.live && s.key !== this.activeKey);
  }

  #session(key: string): EditorSession {
    const found = this.sessions.find((s) => s.key === key);
    if (found) return found;
    const made = new EditorSession(key);
    this.sessions = [...this.sessions, made];
    return made;
  }

  /* ── opening ──────────────────────────────────────────────────────────── */

  /** Switch the panel into edit mode on `path`, starting this project's nvim if
   *  it has not got one.
   *
   *  `line` is 1-based and may be null, which is the honest answer when the
   *  viewer was opened from an `Edit` tool call — that names the text it
   *  replaced rather than where it was, and finding the text again would put
   *  the cursor confidently in the wrong place whenever it occurs twice. */
  async edit(root: string, path: string, line: number | null) {
    if (!root || !path) return;
    const session = this.#session(root);
    this.activeKey = root;
    session.path = path;
    this.on = true;

    if (!session.live) {
      await this.start(root);
      if (!session.live) return;
    }
    try {
      await invoke("editor_open", { id: root, path, line });
    } catch (err) {
      session.fault = String(err);
    }
  }

  /** Start (or reattach to) the nvim for a project.
   *
   *  A reattach is the normal case rather than an error: leaving edit mode does
   *  not close the editor, and in dev every front-end edit rebuilds the object
   *  holding these sessions. Rust answers one by replaying the attribute table
   *  and repainting — without which a rebuilt front end draws a correct grid in
   *  no colours at all, because `hl_attr_define` is sent once and it was sent
   *  to a generation that is gone. */
  async start(key: string) {
    const session = this.#session(key);
    this.activeKey = key;
    session.starting = true;
    session.fault = null;
    /* Whatever the panel last measured. `open_editor` clamps it, so a panel
       that has not been laid out yet asks for something nvim will accept
       rather than for zero. */
    const { cols, rows } = this.#want();
    try {
      await invoke<{ started: boolean }>("open_editor", { id: key, cwd: key, cols, rows });
      session.live = true;
      session.cols = cols;
      session.rows = rows;
    } catch (err) {
      session.fault = String(err);
      session.live = false;
    } finally {
      session.starting = false;
    }
  }

  /** Leave edit mode. nvim keeps running — see the note at the top. */
  rest() {
    this.on = false;
  }

  /** End this project's session. Everything unsaved in it becomes a swap file,
   *  which is what nvim's swap files are for and what the next session will
   *  offer to recover from in its own words. */
  async close() {
    const session = this.active;
    if (!session) return;
    try {
      await invoke("close_editor", { id: session.key });
    } catch {
      /* Nothing to close is the state we were asking for. */
    }
    session.live = false;
    session.screen = emptyScreen();
    session.cols = 0;
    session.rows = 0;
    session.version++;
    this.on = false;
  }

  /* ── driving it ───────────────────────────────────────────────────────── */

  /** A key, if it is one nvim should have. Returns whether it was sent, so the
   *  component knows whether to swallow the event. */
  key(e: KeyboardEvent): boolean {
    const session = this.active;
    if (!session?.live) return false;
    const keys = nvimKey(e);
    if (keys === null) return false;
    void invoke("editor_input", { id: session.key, keys }).catch(
      (err) => (session.fault = String(err)),
    );
    return true;
  }

  /** Keys in nvim's own notation, straight through.
   *
   *  What `key` produces, but from a caller that already has it — the control
   *  surface, which cannot make a real keypress reach a focused element and so
   *  addresses the process one layer below the thing a person presses. Kept
   *  beside `key` rather than folded into it: `key` is a translation and this
   *  is not, and a single function taking either would have to guess which. */
  keyIn(keys: string) {
    const session = this.active;
    if (!session?.live || !keys) return;
    void invoke("editor_input", { id: session.key, keys }).catch(
      (err) => (session.fault = String(err)),
    );
  }

  /** Paste, as one insertion rather than as a key each.
   *
   *  `nvim_input` would work and would be wrong: every character would run
   *  through mappings and autopairs, so pasting a function into insert mode
   *  arrives re-indented into a staircase and with half its brackets doubled.
   *  This is what `:help paste` exists for. */
  paste(text: string) {
    const session = this.active;
    if (!session?.live || !text) return;
    void invoke("editor_paste", { id: session.key, text }).catch(
      (err) => (session.fault = String(err)),
    );
  }

  /** A press, a drag or a release, in pixels relative to the grid. */
  pointer(e: MouseEvent, action: "press" | "drag" | "release", x: number, y: number) {
    const session = this.active;
    if (!session?.live) return;
    const { row, col } = cellAt(x, y, this.cellW, this.cellH, session.screen);
    const button = e.button === 1 ? "middle" : e.button === 2 ? "right" : "left";
    void invoke("editor_mouse", {
      id: session.key,
      button,
      action,
      modifier: mouseMods(e),
      row,
      col,
    }).catch(() => {});
  }

  /** The wheel. nvim scrolls by its own `scrolloff` and `mousescroll`, which is
   *  the point of sending it the gesture rather than a line count. */
  wheel(e: WheelEvent, x: number, y: number) {
    const session = this.active;
    if (!session?.live) return;
    const { row, col } = cellAt(x, y, this.cellW, this.cellH, session.screen);
    void invoke("editor_mouse", {
      id: session.key,
      button: "wheel",
      action: wheelDir(e.deltaX, e.deltaY),
      modifier: mouseMods(e),
      row,
      col,
    }).catch(() => {});
  }

  /** Tell nvim the panel changed shape, if it actually did.
   *
   *  Guarded because the panel measures on every layout pass and nvim repaints
   *  its entire screen for each `try_resize` — an unguarded call from a
   *  `ResizeObserver` is a full repaint per frame while a window is being
   *  dragged. */
  resize(width: number, height: number) {
    const session = this.active;
    if (!session) return;
    const { cols, rows } = gridSize(width, height, this.cellW, this.cellH);
    if (cols === session.cols && rows === session.rows) return;
    session.cols = cols;
    session.rows = rows;
    if (!session.live) return;
    void invoke("editor_resize", { id: session.key, cols, rows }).catch(() => {});
  }

  /** What to ask for, from what the panel last measured. */
  #want(): { cols: number; rows: number } {
    const session = this.active;
    if (session?.cols && session?.rows) return { cols: session.cols, rows: session.rows };
    return { cols: 80, rows: 24 };
  }

  /* ── the wire ─────────────────────────────────────────────────────────── */

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      listen<{ id: string; events: unknown[] }>("nvim:redraw", (e) => {
        /* Not `#session`: unlike the shell, a redraw for a project this window
           has never named cannot be adopted — the grid arriving would be
           painted for a size nobody agreed and the panel has nowhere to put
           it. Rust only ever sends to an id it was asked to open. */
        const session = this.sessions.find((s) => s.key === e.payload.id);
        if (!session) return;
        const before = session.screen.seq;
        applyRedraw(session.screen, e.payload.events);
        session.mode = session.screen.mode;
        /* Only a `flush` is nvim saying the screen is consistent. Redrawing on
           anything less means drawing a half-painted line. */
        if (session.screen.seq !== before) this.#paint(session.key);
      }),
    );

    keep(
      listen<{ id: string }>("nvim:exit", (e) => {
        const session = this.sessions.find((s) => s.key === e.payload.id);
        if (!session) return;
        session.live = false;
        session.starting = false;
        session.fault = "nvim exited";
        session.version++;
      }),
    );
  }

  /** Redraw at most once a frame.
   *
   *  nvim flushes per keystroke, which is fine, but it also flushes per line of
   *  a `:%s` over a big file and per frame of a plugin's animation — and those
   *  arrive faster than the screen can be drawn. One frame is the right unit
   *  here for the same reason 50ms is the right unit for the shell's lines: it
   *  is about how often the wall may be repainted, not about how often the
   *  process spoke. */
  #paint(key: string) {
    this.#dirty.add(key);
    if (this.#frame !== null || this.#gone) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      for (const k of this.#dirty) {
        const session = this.sessions.find((s) => s.key === k);
        if (session) session.version++;
      }
      this.#dirty.clear();
    });
  }
}
