/* The finder behind the space-leader chords, and the viewer it opens into.
 *
 * Lifted from telescope, which is the gesture these hands already have
 * (nvchad): `<space>ff` for a file by name, `<space>fw` for a word anywhere in
 * the project. Two things about the shape are worth knowing before reading it.
 *
 * **The file list is fetched once and filtered here.** That is the whole reason
 * the panel feels instant: `rg --files` costs about 100ms on this repo and a
 * second on an Unreal tree, and paying it per keystroke would make the panel a
 * thing you wait for rather than a thing you type into. So files mode is one
 * subprocess per *open* and pure scoring per keystroke, which also puts the
 * interesting half in `finding.ts` where it can be tested. Grep mode cannot
 * work that way — nobody has the project's contents in memory — so it does run
 * ripgrep per query, debounced, with a generation guard for the answers that
 * come back out of order.
 *
 * **The panel and the viewer are one panel, one step apart.** Enter on a result
 * opens the file where it is; Escape steps back to the list with the query and
 * the selection exactly where they were; Escape again puts the whole thing away.
 * There is no editor on this wall, so a file that has been found wants
 * somewhere to be *read* — and the step back has to be free, or you stop using
 * Enter to look at things.
 *
 * Holds timers and no subscriptions, so `App.svelte`'s `onDestroy` releases it
 * — a superseded generation's debounce firing a grep into a panel nobody can
 * see is the same hazard a leaked listener is, one layer down.
 */

import { invoke } from "@tauri-apps/api/core";

import {
  type FindMode,
  type Hit,
  type Row,
  LAPSE_MS,
  chord,
  fileRows,
  grepRows,
  isMarkdown,
  moveIn,
} from "./finding";

/** How long after the last keystroke the grep goes out.
 *
 *  Short enough to feel like it is keeping up, long enough that typing a
 *  six-letter word is one subprocess rather than six. Measured against the
 *  alternative rather than tuned: with no debounce at all, `off_main`'s pool
 *  ends up holding a `rg` per character, and the first four answers are all
 *  discarded by the generation guard the moment they land. */
const GREP_MS = 120;

/** And the same for the preview, which is a file read per selection. Shorter,
 *  because holding Down through a list should not read forty files but a single
 *  arrow press should show you something immediately. */
const PREVIEW_MS = 60;

/** How many previewed files are kept. Small, and it earns its place in grep
 *  mode above all: twenty hits in one file means twenty selections that are the
 *  same read, and without this each of them is an IPC round trip and a
 *  `fs::read`. */
const CACHED = 8;

/** A file the panel has read, for the preview and for the viewer. */
export type Sheet = {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  bytes: number;
};

export class Finder {
  /** Whether the panel is on screen. */
  open = $state(false);
  /** Which of the two things it is doing. Swapped with ctrl+F without losing
   *  the query, which is the reason the modes are one panel. */
  mode = $state<FindMode>("files");
  /** The project being searched. */
  root = $state("");

  /** Where to look, asked rather than reached for.
   *
   *  Injected the way `devops.roots` and `pomodoro.watched` are, and it keeps
   *  this class unable to see the wall. `App.svelte` answers with the same
   *  reading the shell uses for which shell to show, because it is the same
   *  question — which tree are you working in — and it is sticky for the same
   *  reason: deselecting a card is not a statement about where you wanted to
   *  search. Asked at the moment a chord fires rather than tracked, since that
   *  is the only moment the answer is used. */
  where: () => string = () => "";
  query = $state("");
  /** Which row is selected. An index into `rows`, clamped by every write. */
  at = $state(0);

  /* ── files mode ───────────────────────────────────────────────────────── */

  files = $state<string[]>([]);
  /** The project has more files than we asked for, so this is a head of it.
   *  Said out loud: a finder that quietly cannot see a file is worse than one
   *  that admits its bound. */
  filesTruncated = $state(false);
  /** `rg --files` is in flight. The old list stays on screen while it is, so
   *  reopening the panel is never a blank one. */
  listing = $state(false);

  /* ── grep mode ────────────────────────────────────────────────────────── */

  hits = $state<Hit[]>([]);
  hitsTruncated = $state(false);
  /** ripgrep would not take the query as a pattern and it was re-run as a
   *  literal. Drawn, because a search that means something other than what you
   *  typed is the kind of thing you only notice when it is wrong. */
  literal = $state(false);
  searching = $state(false);

  fault = $state<string | null>(null);

  /* ── the viewer ───────────────────────────────────────────────────────── */

  /** The file being read, or null when the list is showing. */
  sheet = $state<Sheet | null>(null);
  /** The line to put in the middle of it, if the row said one. */
  sheetLine = $state<number | null>(null);
  reading = $state(false);

  /** Show a document's source instead of the document.
   *
   *  A markdown file opens *rendered*, because that is what it is — half the
   *  files worth finding in this repo are `.claude/rules/*.md` and a rule read
   *  as a wall of `##` and backticks is a rule nobody reads. The toggle is
   *  there because the other half of the time you are looking at a `.md` to
   *  find out what is actually written in it, and a reader that will not show
   *  you the source of a source file is a reader arguing with you.
   *
   *  It is a **preference and not a per-file switch**, which is the one part
   *  worth arguing. Resetting it per file would mean pressing ctrl+R again for
   *  every rule you opened once you had decided you wanted the source — the
   *  first press is you correcting a default, and a default you have to correct
   *  repeatedly is not a default. So: rendered until you say otherwise, and
   *  then as you said, for as long as the wall is up. */
  raw = $state(false);

  /** Whether the viewer is drawing a document. Both halves have to hold: it is
   *  a markdown file, and you have not asked for the source. */
  get rendered(): boolean {
    return !!this.sheet && !this.raw && isMarkdown(this.sheet.path);
  }

  /** Whether the toggle is worth offering at all — there is nothing to render
   *  about a `.ts`, and a button that does nothing is worse than no button. */
  get markdown(): boolean {
    return !!this.sheet && isMarkdown(this.sheet.path);
  }

  /** Source, or the document. Only ever reached from the viewer. */
  toggleRaw() {
    this.raw = !this.raw;
  }

  /** What the preview shows — the selected row's file, or null. Kept apart from
   *  `sheet` so stepping through the list does not disturb an open viewer. */
  preview = $state<Sheet | null>(null);

  /* ── the leader ───────────────────────────────────────────────────────── */

  /** The letters typed since the leader, or null when no sequence is open.
   *  Drawn as a hint — a chord is the one gesture on this wall with no
   *  affordance at all, so the panel offers what it is waiting for. */
  pending = $state<string | null>(null);

  #pressedAt = 0;
  #lapse: ReturnType<typeof setTimeout> | null = null;
  #grepTimer: ReturnType<typeof setTimeout> | null = null;
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Answers can land out of the order they were asked in — a grep for `f` may
   *  outlive one for `find`. Only the newest generation is allowed to write. */
  #gen = 0;
  #sheets = new Map<string, Sheet>();
  #gone = false;

  /** The rows on screen. One list for both modes on purpose: the keyboard, the
   *  preview and the viewer should not have to know which mode produced a row,
   *  and that is what let grep mode answer with file names as well as contents
   *  without a second code path. */
  rows = $derived.by((): Row[] =>
    this.mode === "files"
      ? fileRows(this.files, this.query)
      : grepRows(this.hits, this.files, this.query),
  );

  get row(): Row | null {
    return this.rows[this.at] ?? null;
  }

  /** Whether anything is in flight, for the one word the header spends on it. */
  get busy(): boolean {
    return this.listing || this.searching || this.reading;
  }

  /* ── the leader machine ───────────────────────────────────────────────── */

  /** Feed a keydown to the leader, and say whether the key was ours.
   *
   *  `false` means the key belongs to whoever would have had it — which is the
   *  case that makes this worth a return value rather than a side effect. A
   *  second key that completes no chord abandons the sequence and *falls
   *  through*, the way `<space>q` in nvim leaves you with a `q`; a finder that
   *  ate it would be a wall where a letter occasionally vanished.
   *
   *  Time is read here rather than in `finding.ts` so the rule itself stays
   *  pure and testable. */
  press(key: string): boolean {
    const since = this.pending === null ? 0 : Date.now() - this.#pressedAt;
    const step = chord(this.pending, key, since);
    /* A modifier on its own changed nothing, and must not be allowed to change
       anything here either — including the stopwatch. A held Shift repeats its
       keydown, so restarting the clock on it would keep a forgotten sequence
       alive for as long as a finger rested on the key. */
    if (step.kind === "held") return false;
    this.pending = step.open;
    this.#pressedAt = Date.now();

    /* The hint has to go away on its own, or a sequence you thought better of
       sits under the wall until the next thing you type. It is the same lapse
       the machine applies to the *next* key; this one is only about the
       drawing, which is why it is a timer here and not a rule there. */
    if (this.#lapse !== null) clearTimeout(this.#lapse);
    this.#lapse = null;
    if (step.open !== null && !this.#gone) {
      this.#lapse = setTimeout(() => {
        this.#lapse = null;
        this.pending = null;
      }, LAPSE_MS + 50);
    }

    if (step.kind === "fire") void this.show(step.mode, this.where());
    return step.swallow;
  }

  /* ── opening and closing ──────────────────────────────────────────────── */

  /** Show the panel in a mode, over a project.
   *
   *  The query is cleared, which is telescope's behaviour and the right one: a
   *  chord is you starting a search, and finding the last one's text still in
   *  the box means your first keystroke lands in the middle of a word you have
   *  forgotten typing. `swap` is the case that keeps a query, because that is
   *  the same search asked a different way.
   *
   *  The file list is re-fetched every time, and the old one stays on screen
   *  while it is — a file created two minutes ago has to be findable, and the
   *  alternative (a cache with an age) is a finder that is right most of the
   *  time about the one thing it exists to know. */
  async show(mode: FindMode, root: string) {
    this.open = true;
    this.mode = mode;
    this.query = "";
    this.at = 0;
    this.hits = [];
    this.hitsTruncated = false;
    this.literal = false;
    this.sheet = null;
    this.sheetLine = null;
    this.fault = null;
    /* A list from another project is worse than no list: every row of it is a
       path that is not there. */
    if (root && root !== this.root) {
      this.root = root;
      this.files = [];
      this.filesTruncated = false;
      this.#sheets.clear();
      this.preview = null;
    }
    await this.list();
    this.#schedulePreview();
  }

  /** Put it away. Nothing was running, so there is nothing to leave running —
   *  which is the one way this panel is unlike the shell. */
  hide() {
    this.open = false;
    this.sheet = null;
    this.sheetLine = null;
    this.pending = null;
    if (this.#lapse !== null) clearTimeout(this.#lapse);
    this.#lapse = null;
  }

  /** The other mode, same query.
   *
   *  This is the gesture that makes the two modes one panel: you type a word
   *  looking for a file, do not find it, and want to know where the word is
   *  instead — without retyping it. Both directions, since the same is true
   *  coming back. */
  async swap() {
    this.mode = this.mode === "files" ? "grep" : "files";
    this.at = 0;
    this.literal = false;
    if (this.mode === "grep") this.#scheduleGrep();
    else {
      this.hits = [];
      this.hitsTruncated = false;
    }
    this.#schedulePreview();
  }

  /* ── typing ───────────────────────────────────────────────────────────── */

  /** What the field says. Everything downstream hangs off this one write. */
  type(text: string) {
    this.query = text;
    /* Back to the top: the best answer for what you have now typed is row one,
       and staying on row seven means the selection is on whatever happens to
       have landed there. */
    this.at = 0;
    if (this.mode === "grep") this.#scheduleGrep();
    this.#schedulePreview();
  }

  /** Move the selection. */
  step(by: number) {
    const next = moveIn(this.rows.length, this.at, by);
    if (next === this.at) return;
    this.at = next;
    this.#schedulePreview();
  }

  /** Put the selection on a row by index — what a click does. Through here
   *  rather than by writing `at` from the panel, so the preview is scheduled
   *  either way and there is one place that knows a selection moving means a
   *  file wants reading. */
  pick(at: number) {
    if (at === this.at) return;
    this.at = Math.max(0, Math.min(this.rows.length - 1, at));
    this.#schedulePreview();
  }

  /* ── asking ───────────────────────────────────────────────────────────── */

  /** Fetch the project's file list. */
  async list() {
    if (!this.root) return;
    this.listing = true;
    const gen = ++this.#gen;
    try {
      const out = await invoke<{ files: string[]; truncated: boolean }>("find_files", {
        root: this.root,
      });
      if (gen !== this.#gen || this.#gone) return;
      this.files = out.files;
      this.filesTruncated = out.truncated;
    } catch (err) {
      if (gen !== this.#gen || this.#gone) return;
      this.fault = String(err);
    } finally {
      if (gen === this.#gen) this.listing = false;
    }
  }

  #scheduleGrep() {
    if (this.#grepTimer !== null) clearTimeout(this.#grepTimer);
    if (this.#gone) return;
    /* An emptied box is answered immediately and without a subprocess — there
       is nothing to ask, and waiting 120ms to clear the list reads as lag. */
    if (!this.query.trim()) {
      this.#grepTimer = null;
      this.#gen++;
      this.hits = [];
      this.hitsTruncated = false;
      this.literal = false;
      this.searching = false;
      return;
    }
    this.searching = true;
    this.#grepTimer = setTimeout(() => {
      this.#grepTimer = null;
      void this.#grep();
    }, GREP_MS);
  }

  async #grep() {
    if (!this.root) return;
    const gen = ++this.#gen;
    const asked = this.query;
    try {
      const out = await invoke<{ hits: Hit[]; truncated: boolean; literal: boolean }>(
        "find_grep",
        { root: this.root, query: asked },
      );
      /* The generation guard is the whole of the ordering: a grep for `f` takes
         longer than one for `finding`, so answers do land out of order, and
         without this the list would flick back to the broader one. */
      if (gen !== this.#gen || this.#gone) return;
      this.hits = out.hits;
      this.hitsTruncated = out.truncated;
      this.literal = out.literal;
      this.fault = null;
    } catch (err) {
      if (gen !== this.#gen || this.#gone) return;
      this.hits = [];
      this.fault = String(err);
    } finally {
      if (gen === this.#gen) {
        this.searching = false;
        this.#schedulePreview();
      }
    }
  }

  /* ── reading a file ───────────────────────────────────────────────────── */

  #schedulePreview() {
    if (this.#previewTimer !== null) clearTimeout(this.#previewTimer);
    this.#previewTimer = null;
    if (this.#gone || !this.open) return;
    const path = this.row?.path ?? null;
    if (!path) {
      this.preview = null;
      return;
    }
    /* Already read: show it now rather than in 60ms. Stepping through twenty
       hits in one file is twenty selections and one read, which is what the
       cache is for. */
    const held = this.#sheets.get(path);
    if (held) {
      this.preview = held;
      return;
    }
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = null;
      void this.#loadPreview(path);
    }, PREVIEW_MS);
  }

  async #loadPreview(path: string) {
    const sheet = await this.#read(path);
    if (!sheet || this.#gone) return;
    /* The selection may have moved while this was in flight, and a preview of
       a row you are no longer on is worse than a slow one. */
    if (this.row?.path !== path) return;
    this.preview = sheet;
  }

  /** Read a file, through a small cache. Faults are reported and not thrown —
   *  a file that has been deleted since `rg` walked it is an ordinary thing to
   *  find, and it should put a line in the panel rather than a red bar across
   *  the app. */
  async #read(path: string): Promise<Sheet | null> {
    const held = this.#sheets.get(path);
    if (held) return held;
    try {
      const out = await invoke<{
        text: string;
        truncated: boolean;
        binary: boolean;
        bytes: number;
      }>("read_file_text", { root: this.root, path });
      const sheet: Sheet = { path, ...out };
      /* Oldest out first — a Map keeps insertion order, so the first key is the
         least recently *added*. Not strictly an LRU, and it does not need to be
         at eight entries. */
      this.#sheets.set(path, sheet);
      if (this.#sheets.size > CACHED) {
        const oldest = this.#sheets.keys().next().value;
        if (oldest !== undefined) this.#sheets.delete(oldest);
      }
      return sheet;
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Open the selected row — or a named one — in the viewer. */
  async look(row: Row | null = this.row) {
    if (!row) return;
    this.reading = true;
    try {
      const sheet = await this.#read(row.path);
      if (!sheet || this.#gone) return;
      this.sheet = sheet;
      this.sheetLine = row.line;
    } finally {
      this.reading = false;
    }
  }

  /** Back to the list, with the query and the selection where they were. Free
   *  on purpose: a step back that cost you your search is one that stops you
   *  using Enter to look at things. */
  back() {
    this.sheet = null;
    this.sheetLine = null;
  }

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  /** Drop every timer. A superseded generation's debounce would otherwise fire
   *  a grep into a panel nobody can see — the same hazard a leaked subscription
   *  is, and Vite rebuilds this object on every front-end edit. */
  detach() {
    this.#gone = true;
    for (const t of [this.#lapse, this.#grepTimer, this.#previewTimer]) {
      if (t !== null) clearTimeout(t);
    }
    this.#lapse = null;
    this.#grepTimer = null;
    this.#previewTimer = null;
  }
}
