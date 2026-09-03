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
  type Dogear,
  type Reading,
  FUSE_DEFAULT,
  KEEP_DEFAULT,
  clampFuse,
  clampKeep,
  drop as dropTab,
  keyOf,
  mark as markTab,
  reap as reapTabs,
  remember as rememberTab,
  reread as rereadTab,
  touch as touchTab,
} from "./dogears";
import {
  type FindMode,
  type Hit,
  type MediaKind,
  type Row,
  LAPSE_MS,
  chord,
  drawnAs,
  fileRows,
  grepRows,
  isMarkdown,
  moveIn,
} from "./finding";
import { type Doc, bytesOf, extOf, readDocument, readTable, sniff } from "./office";

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

/** Where the two knobs on the tab strip are kept.
 *
 *  localStorage, and the same seam `theme.svelte.ts` draws around its authored
 *  themes: `readKnobs`/`writeKnobs` are the only two functions that know where
 *  these live, so the day they become a schema rung nothing else in this file
 *  moves. It is the right home here rather than merely the available one — a
 *  tab is per-machine and disposable by construction, and two numbers about how
 *  long a pill stays on the bottom of *this* window are not authored work. */
const KNOBS_KEY = "skein.dogears.v1";

function readKnobs(): { keep: number; fuse: number } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KNOBS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { keep: KEEP_DEFAULT, fuse: FUSE_DEFAULT };
    const o = raw as Record<string, unknown>;
    /* Clamped on the way in as well as on the way out: what is on disk is a
       previous build's idea of a sensible number, and `clampKeep` answers with
       the default for anything it cannot read. */
    return { keep: clampKeep(o.keep), fuse: clampFuse(o.fuse) };
  } catch {
    return { keep: KEEP_DEFAULT, fuse: FUSE_DEFAULT };
  }
}

function writeKnobs(keep: number, fuse: number) {
  try {
    localStorage.setItem(KNOBS_KEY, JSON.stringify({ keep, fuse }));
  } catch {
    /* A full or blocked store loses the preference and nothing else. */
  }
}

/** A file the panel has read, for the preview and for the viewer. */
export type Sheet = {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  bytes: number;
  /** An image or a film, as a `data:` URL — see `find::read_media`.
   *
   *  On the same record as `text` rather than in a second cache, because the
   *  viewer's whole job is "the file you are looking at" and there is exactly
   *  one of those. `text` stays empty for these and `binary` stays false: it is
   *  not text, and it is also not the unreadable thing `binary` means, which is
   *  the case the viewer already had a sentence for. */
  media?: { kind: MediaKind; dataUrl: string; tooLarge: boolean };
  /** An Office document, parsed — see `office.ts`.
   *
   *  On the same record as `text` and `media` for the same reason they are on
   *  one: the viewer's whole subject is "the file you are looking at" and there
   *  is exactly one of those, so a third cache would be a third eviction policy
   *  and a third way to be stale.
   *
   *  A `.csv` carries **both** this and `text`, and that is not redundant — it
   *  is the whole of what makes its `raw` toggle mean something. Which is also
   *  the rule the toggle is decided by: see `toggleable`. */
  doc?: Doc;
  /** Why there is no document here, when there should have been one.
   *
   *  Per-sheet rather than in `Finder.fault`, because it is a fact about *this
   *  file* and it is cached with it: the panel-wide fault is cleared by the next
   *  gesture, and a `.docx` that is really a renamed zip of photographs should go
   *  on saying so every time you open it. */
  docFault?: string;
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

  /** The viewer was opened without a result list behind it — from a path in a
   *  transcript rather than from a search. It is what `back` reads to decide
   *  whether Escape steps back or closes; see the note there. */
  alone = $state(false);

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

  /** Whether the viewer is drawing a document rather than numbered lines.
   *
   *  Three kinds of document reach this now — a rendered markdown file, an
   *  Office document, and a `.csv` as a grid — and the branch below is the one
   *  place that difference matters. The `raw` half only applies where there *is*
   *  a source to fall back to; see `toggleable`. */
  get rendered(): boolean {
    const s = this.sheet;
    if (!s || s.docFault) return false;
    if (s.doc) return !(this.toggleable && this.raw);
    return !this.raw && isMarkdown(s.path);
  }

  /** Whether the two-readings toggle is worth offering at all.
   *
   *  **One rule, and it is a fact about the file rather than a fourth list:
   *  there are two readings when there is a document reading *and* a source.**
   *  A `.md` has both — the rendering and the markdown. A `.csv` has both, which
   *  is the whole reason it is drawn as a grid rather than left as text. A
   *  `.docx` has only the document, because its "source" is a zip of XML in
   *  fourteen parts and nobody wants to look at that in a code viewer; a `.pdf`
   *  has only the document for the same reason twice over.
   *
   *  Which falls out of `Sheet` without asking anything: `text` is empty for a
   *  file that came down the bytes path and full for one that came down the text
   *  path. A button that does nothing is worse than no button. */
  get toggleable(): boolean {
    const s = this.sheet;
    if (!s || s.binary || s.docFault) return false;
    return s.doc ? s.text.length > 0 : isMarkdown(s.path);
  }

  /** Whether `e` hands this file to the desktop rather than to nvim.
   *
   *  The same fact `toggleable` turns on, asked the other way round: a file with
   *  no source came down the bytes path, and nvim over the bytes of a `.xlsx` is
   *  a screenful of `PK` — whereas the application that owns it is one keypress
   *  away and is what you meant. A `.csv` is text, so `e` still edits it.
   *
   *  This is also the promise the media plate has been making since 2026-08-28
   *  and could not keep: "press `e` to open it outside" called `editor.edit`,
   *  which opened a PNG in nvim. */
  get outward(): boolean {
    const s = this.sheet;
    if (!s) return false;
    if (s.media) return true;
    return (!!s.doc || !!s.docFault) && s.text.length === 0;
  }

  /** Hand the open file to whatever the desktop uses for it.
   *
   *  Rust decides whether it may be — see `find::openable_file`, which is an
   *  allow-list because the front end naming the extension would be the front
   *  end being able to name `.exe`. */
  async openOutside() {
    const path = this.sheet?.path;
    if (!path) return;
    try {
      await invoke("open_file_outside", { root: this.root, path });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Source, or the document. Only ever reached from the viewer.
   *
   *  The open file's tab follows, and **forgets what it remembered** — the
   *  offsets and the scroll describe a DOM that is about to stop existing, and
   *  landing in the middle of a rendering with half as many lines as the source
   *  is worse than opening at the top. */
  toggleRaw() {
    this.raw = !this.raw;
    const path = this.sheet?.path;
    if (path) {
      this.tabs = rereadTab(this.tabs, keyOf({ root: this.root, path }), this.raw);
    }
  }

  /** What the preview shows — the selected row's file, or null. Kept apart from
   *  `sheet` so stepping through the list does not disturb an open viewer. */
  preview = $state<Sheet | null>(null);

  /* ── the files kept to hand ───────────────────────────────────────────── */

  /** The tabs above the dock, in the order they were opened — never in recency
   *  order, so a pill is twice in the same place. See `dogears.ts`. */
  tabs = $state<Dogear[]>([]);

  /** How many tabs are safe from the fuse, and how long the rest have, in
   *  minutes. Both are knobs on the strip itself rather than in a settings
   *  panel: there is no general settings panel in this app, and inventing one
   *  for two numbers puts them a panel away from the only thing they are about.
   *  `keep: 0` is the off switch. */
  keep = $state(KEEP_DEFAULT);
  fuse = $state(FUSE_DEFAULT);

  /** How to read where the viewer is. Installed by `Spyglass.svelte`, the same
   *  injection `where` is and for the same reason: a scroll offset and a
   *  `Selection` are facts only the component that drew them can see, and this
   *  class asking the DOM for them itself would be the one place in the finder
   *  that knew what it was rendered into. Null before the viewer has ever been
   *  on screen, which is a real state — nothing is captured then, because there
   *  is nothing to capture. */
  reader: (() => Reading | null) | null = null;

  /** A reading waiting to be put back, left by `resume` for the component to
   *  consume once.
   *
   *  A plain field rather than `$state`, and that is load-bearing. The effect
   *  that applies it keys on `sheet`; if this were reactive, clearing it on
   *  consumption would re-run that effect with nothing pending, which falls
   *  through to the open-at-the-line branch and scrolls away from the reading
   *  it had just restored. */
  #resume: Reading | null = null;

  constructor() {
    const k = readKnobs();
    this.keep = k.keep;
    this.fuse = k.fuse;
  }

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
    /* Before anything moves: this can be pressed with the viewer open, and the
       file it was showing keeps its place. */
    this.#keep();
    this.open = true;
    this.mode = mode;
    this.query = "";
    this.at = 0;
    this.hits = [];
    this.hitsTruncated = false;
    this.literal = false;
    this.sheet = null;
    this.sheetLine = null;
    this.alone = false;
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
    this.#keep();
    this.open = false;
    this.sheet = null;
    this.sheetLine = null;
    /* Cleared with the panel, not left standing: the next thing to open the
       viewer may well be a search, and a stale `alone` would make its Escape
       close the whole panel instead of stepping back to the list. */
    this.alone = false;
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
      const sheet = await this.#fetch(path);
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

  /** One file off Rust, as whichever of the readings it is.
   *
   *  Split out of `#read` so the cache above stays one shape: an image, a
   *  spreadsheet and a source file are the same kind of thing to the viewer —
   *  the file you are looking at — and giving each its own cache would mean
   *  three eviction policies and three ways to be stale.
   *
   *  **The name chooses the command; the bytes choose the reading.** `drawnAs`
   *  is a hint about which of three Rust calls to make, which is a question
   *  about saving a round trip. What is actually drawn is settled after the
   *  bytes arrive — by `office.sniff` for a document, and by Rust's own NUL
   *  test for everything else. The two can disagree, and when they do the file
   *  wins and says so: a `.docx` that is a renamed zip of photographs gets the
   *  sentence rather than an empty document. */
  async #fetch(path: string): Promise<Sheet> {
    const drawn = drawnAs(path);

    if (drawn === "image" || drawn === "video") {
      const out = await invoke<{
        dataUrl: string;
        kind: MediaKind;
        bytes: number;
        tooLarge: boolean;
      }>("read_file_media", { root: this.root, path });
      return {
        path,
        text: "",
        truncated: false,
        /* Not `binary`. That word means "this cannot be shown at all", and the
           viewer has a sentence for it; this is a file it shows very well. */
        binary: false,
        bytes: out.bytes,
        media: { kind: out.kind, dataUrl: out.dataUrl, tooLarge: out.tooLarge },
      };
    }

    if (drawn === "document") return this.#fetchDoc(path);

    const out = await invoke<{
      text: string;
      truncated: boolean;
      binary: boolean;
      bytes: number;
      head: string;
    }>("read_file_text", { root: this.root, path });
    const sheet: Sheet = {
      path,
      text: out.text,
      truncated: out.truncated,
      binary: out.binary,
      bytes: out.bytes,
    };

    /* A table is *text*, so it never needed bytes at all — which is why it is
       the one document reading with two honest views of the same file. */
    if (drawn === "table" && !out.binary) {
      try {
        const name = path.slice(path.lastIndexOf("/") + 1);
        sheet.doc = { kind: "sheet", sheets: [readTable(name, out.text)] };
      } catch (err) {
        sheet.docFault = String(err);
      }
      return sheet;
    }

    /* **The extensionless case, and the reason Rust hands back a head.** A file
       whose name promised nothing got no hint, so it came down the text path and
       Rust found a NUL in it — which before this was the end of the story and the
       sentence was "not a text file". Sixteen bytes is enough to know it is a PDF,
       and a second round trip for a file the panel could otherwise not open at all
       is a trade with only one side to it. Nothing is asked twice in the common
       case: a `.pdf` never reaches here. */
    if (out.binary && out.head) {
      try {
        if (sniff(bytesOf(out.head))) return this.#fetchDoc(path);
      } catch {
        /* An unreadable head is a file we simply know nothing about, which is
           the state the binary plate already describes. */
      }
    }
    return sheet;
  }

  /** A document's bytes, sniffed and parsed.
   *
   *  Parsed here rather than in the component, and that is the same call
   *  `Spyglass` makes about `parseMarkdown`: the result belongs on the `Sheet`
   *  so it is done once per file and not once per redraw — and a workbook is a
   *  great deal more work than a markdown parse. */
  async #fetchDoc(path: string): Promise<Sheet> {
    const out = await invoke<{ data: string; bytes: number; tooLarge: boolean }>(
      "read_file_doc",
      { root: this.root, path },
    );
    const sheet: Sheet = {
      path,
      text: "",
      truncated: false,
      /* Not `binary`, for the reason media is not: that word is the viewer's
         sentence for a file it cannot show at all, and `docFault` is the more
         specific one for a document it could not make sense of. */
      binary: false,
      bytes: out.bytes,
    };
    if (out.tooLarge) {
      sheet.docFault = `${(out.bytes / (1024 * 1024)).toFixed(1)} MB — too large to open here`;
      return sheet;
    }
    try {
      sheet.doc = await readDocument(bytesOf(out.data), extOf(path));
    } catch (err) {
      /* Every failure in `office.ts` throws with a sentence meant to be read.
         Kept on the sheet rather than in `fault` so it survives the next
         gesture, since it will be just as true next time. */
      sheet.docFault = String(err).replace(/^Error:\s*/, "");
    }
    return sheet;
  }

  /** Open the selected row — or a named one — in the viewer. */
  async look(row: Row | null = this.row) {
    if (!row) return;
    this.#keep();
    this.reading = true;
    try {
      const sheet = await this.#read(row.path);
      if (!sheet || this.#gone) return;
      this.alone = false;
      this.sheet = sheet;
      this.sheetLine = row.line;
      this.#remember(row.path, row.line);
    } finally {
      this.reading = false;
    }
  }

  /** Open a file straight from somewhere else on the wall — a path in a tool
   *  call, which is where you most often want to look at a file.
   *
   *  Two things it has to do that `look` does not. It **names its own root**,
   *  because the card whose transcript you are reading may not be the project
   *  the finder last searched, and the viewer reads `(root, relative)`; the
   *  caller has already reduced the path with `insideRoot`, so anything
   *  arriving here is inside. And it sets `alone`, which is the whole reason
   *  this is a second entry point rather than a call to `look` — see `back`. */
  async lookAt(root: string, path: string, line: number | null = null) {
    if (!root || !path) return;
    this.#keep();
    /* A file list from another project is every row being a path that is not
       there, so it goes with the root — the same clearing `show` does, for the
       same reason. The common case is the same root and nothing is thrown
       away. */
    if (root !== this.root) {
      this.root = root;
      this.files = [];
      this.filesTruncated = false;
      this.#sheets.clear();
      this.preview = null;
    }
    this.open = true;
    this.fault = null;
    this.reading = true;
    try {
      const sheet = await this.#read(path);
      if (!sheet || this.#gone) return;
      this.alone = true;
      this.sheet = sheet;
      this.sheetLine = line;
      this.#remember(path, line);
    } finally {
      this.reading = false;
    }
  }

  /** Back out of the viewer.
   *
   *  Where "back" goes depends on where you came from, and getting that wrong
   *  is the whole of why `alone` exists. Opened from a result, Escape returns
   *  to the list with the query and the selection where they were — free on
   *  purpose, because a step back that cost you your search is one that stops
   *  you using Enter to look at things. Opened from a path in a transcript
   *  there is no list behind it, and dropping you into an empty finder over a
   *  project you never searched would be one gesture answered with two. So that
   *  case closes the panel and gives you back what you were reading. */
  back() {
    this.#keep();
    if (this.alone) {
      this.hide();
      return;
    }
    this.sheet = null;
    this.sheetLine = null;
  }

  /* ── the files kept to hand ───────────────────────────────────────────── */

  /** Where the tabs are, for the strip: the tab whose file is on screen, or
   *  null. Asked rather than tracked, since it is one comparison. */
  get openKey(): string | null {
    const path = this.sheet?.path;
    return path ? keyOf({ root: this.root, path }) : null;
  }

  /** Go back to a tab, with the reading it was left at.
   *
   *  Not a call to `lookAt` with extra state, because the two differ in what
   *  they mean about the *line*: `lookAt` is "put me at line 900", and this is
   *  "put me back where I was", which is the reading and not the line the file
   *  was first opened at. */
  async resume(d: Dogear) {
    this.#keep();
    /* Where "back" goes, decided before the panel moves. Coming from the
       results list there is a list behind this and Escape should return to it;
       coming from a closed panel there is nothing behind it at all. And when
       the viewer was already showing another file, whatever was behind that one
       still is — so `alone` is left exactly as it was. */
    const fromList = this.open && !this.sheet;
    if (fromList) this.alone = false;
    else if (!this.open) this.alone = true;

    /* A file list from another project is every row being a path that is not
       there — the same clearing `show` and `lookAt` do, for the same reason. */
    if (d.root !== this.root) {
      this.root = d.root;
      this.files = [];
      this.filesTruncated = false;
      this.#sheets.clear();
      this.preview = null;
    }
    this.open = true;
    this.fault = null;
    this.reading = true;
    try {
      const sheet = await this.#read(d.path);
      if (this.#gone) return;
      if (!sheet) {
        /* The file has gone since the tab was made — renamed, or a branch
           switched under it. `#read` has put the reason in `fault`; the tab goes
           with it, because a pill that fails when pressed is the one outcome
           worse than no pill. Same argument `insideRoot` makes about not drawing
           a link it cannot open. */
        this.tabs = dropTab(this.tabs, keyOf(d));
        return;
      }
      /* The reading includes which of the two readings it was, so this writes
         the preference — the one place in the app other than the toggle that
         does. It is not the toggle becoming per-file: what `raw` decides is
         what a file opened *fresh* is drawn as, and resuming a tab is not
         opening a file fresh. See `.claude/rules/finding.md`. */
      this.raw = d.raw;
      this.sheet = sheet;
      this.sheetLine = d.line;
      this.#resume = d.read;
      this.tabs = touchTab(this.tabs, keyOf(d), Date.now());
    } finally {
      this.reading = false;
    }
  }

  /** The reading a `resume` left for the component to put back, once. */
  takeResume(): Reading | null {
    const r = this.#resume;
    this.#resume = null;
    return r;
  }

  /** Close a tab. */
  shut(key: string) {
    this.tabs = dropTab(this.tabs, key);
  }

  /** Close whatever has burned down.
   *
   *  Called from the strip on the wall's own one-second tick rather than from a
   *  timer of ours — expiry is time passing, `clock` is already an event every
   *  card folds, and `reap` answers with the same array when nothing has gone,
   *  so a second in which nothing expires is not a write. */
  reap(now: number) {
    const next = reapTabs(this.tabs, this.keep, this.fuse, now);
    /* The guard rather than a bare assignment, and it is not a micro-
       optimisation. This is called from an `$effect` that reads `tabs` to
       compute the answer, so a write is a re-run — and a write on every tick
       would be a re-run on every tick that writes again. `reap` returning the
       same array is what makes that terminate, and stating the comparison here
       means it terminates whatever `$state`'s equality does with an identical
       object reference. */
    if (next !== this.tabs) this.tabs = next;
  }

  setKeep(n: unknown) {
    this.keep = clampKeep(n);
    /* Zero is the off switch, and an off switch that leaves six pills standing
       on the wall is not one. */
    if (this.keep === 0) this.tabs = [];
    writeKnobs(this.keep, this.fuse);
  }

  setFuse(n: unknown) {
    this.fuse = clampFuse(n);
    writeKnobs(this.keep, this.fuse);
  }

  /** Note a file has been opened fresh, so it has somewhere to come back to. */
  #remember(path: string, line: number | null) {
    this.tabs = rememberTab(
      this.tabs,
      { root: this.root, path, line, raw: this.raw },
      Date.now(),
      this.keep,
    );
  }

  /** Capture where the viewer is and write it onto the open file's tab.
   *
   *  Called at the top of every gesture that stops showing the current file,
   *  rather than from a teardown in the component — and that is not a style
   *  choice. A Svelte `$effect`'s cleanup runs *after* the DOM has been updated
   *  for the change that triggered it, so by then the scroller is already
   *  showing the next file and `scrollTop` is the wrong number. The only moment
   *  a reading is true is before the state that draws it moves.
   *
   *  It is also where a *pending* restore is dropped, which belongs here rather
   *  than looking like it does: the set of gestures that leave the current file
   *  is exactly the set that invalidates a reading nobody has applied yet.
   *  Without it, resuming the tab that is already open can leave one standing —
   *  `sheet` is assigned the same cached object, so the effect that consumes it
   *  may not run — and the next `look` would then put that file's scroll into a
   *  different file. `resume` calls this before setting its own, so the clear
   *  cannot eat the one it means to leave. */
  #keep() {
    this.#resume = null;
    const path = this.sheet?.path;
    if (!path || !this.reader) return;
    const read = this.reader();
    if (!read) return;
    this.tabs = markTab(this.tabs, keyOf({ root: this.root, path }), read);
  }

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  /** Drop every timer. A superseded generation's debounce would otherwise fire
   *  a grep into a panel nobody can see — the same hazard a leaked subscription
   *  is, and Vite rebuilds this object on every front-end edit. */
  detach() {
    this.#gone = true;
    /* The component that installed this is going with it, and a reader holding
       a `bind:this` from a superseded generation would answer with the scroll
       offset of a node nothing is drawing. */
    this.reader = null;
    for (const t of [this.#lapse, this.#grepTimer, this.#previewTimer]) {
      if (t !== null) clearTimeout(t);
    }
    this.#lapse = null;
    this.#grepTimer = null;
    this.#previewTimer = null;
  }
}
