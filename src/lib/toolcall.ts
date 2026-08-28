/* A tool call, laid out for reading.
 *
 * The transcript used to draw a call as one line of prose — `reading
 * conversation.svelte.ts`, `searching for describeTool` — and that line is a
 * good answer to "what is it doing", which is the question the *card* asks. It
 * is a poor answer to "what did it actually do", which is the question you open
 * the panel for: which path, which pattern, which flags, and what came back.
 * All of that was on the wire and thrown away.
 *
 * So a `tool` line now carries the call itself (`Line.call`) and this file is
 * what turns the raw arguments the model wrote into something set on a page:
 * which of them lead, what each one *is* — a path, a command, a block of code,
 * a sentence — and, for an edit, the before and after as a diff rather than as
 * two walls of text you are invited to compare by eye.
 *
 * Pure on purpose, tested directly (test/toolcall.test.ts). Nothing here knows
 * what a DOM is; `ToolCall.svelte` is the half that draws it.
 *
 * The vocabulary is Claude's — tool names, argument keys — which is
 * `classify.ts`'s remit, and this file is deliberately the exception to it in
 * the way `usage.ts`'s price table is: `classify.ts` answers *what a stream
 * means*, and every name below is instead a statement about how an argument
 * should be **set on the page**. `file_path` being a path is not knowledge
 * about an event; it is typography.
 */

/* `Picture` is type-only and erased at build, which is what keeps this file
 * free of runtime imports — the same bargain `transcript.ts` strikes with
 * `Line`. The wire shape of an image block is `classify.ts`'s knowledge;
 * what a *result* is made of is this file's. */
import type { Picture } from "./classify";


/** The most of one string this will hold on to.
 *
 *  A call and its result are kept for as long as the line is — up to 300 live
 *  lines and 400 of history — where before they were read once and dropped. A
 *  `Write` of a large file and a `Read` of one are each a few hundred
 *  kilobytes, and three hundred of those is the panel's whole memory budget
 *  several times over. 20k characters is about 250 lines of code, which is more
 *  than anybody reads in a fold and enough that clipping is rare; what is cut
 *  is *said*, and the whole of it is always in the session file on disk.
 *
 *  Applied to arguments and to results alike, and applied when the line is
 *  written rather than when it is drawn — a cap that only bites at render time
 *  is not a memory bound at all. */
export const VALUE_CAP = 20_000;

/** How much of a result stands in the fold before you ask for the rest.
 *
 *  Opening a call should show you what came back, not replace the conversation
 *  with it — and a `Read` answers in hundreds of lines, so without a clamp the
 *  first call you open buries the round you opened it from. Twenty-four is
 *  about a screenful of the panel at its usual width with the arguments still
 *  above it, and the button under it says exactly how much more there is and
 *  fetches all of it in one click. */
export const RESULT_LINES = 24;

/** Beyond this many lines on either side, an edit is not diffed.
 *
 *  The diff is an O(n·m) LCS table, which is the right algorithm at the size
 *  edits actually are and the wrong one at the size they occasionally are — a
 *  whole-file replacement of two 4000-line strings is 16 million cells inside a
 *  render. Past the guard the two sides are drawn as they arrived, which is
 *  what the panel did for every edit before any of this existed. */
export const DIFF_MAX_LINES = 600;

/** How an argument is set. */
export type Form =
  /** A filesystem path: the directory recedes, the basename does not. */
  | "path"
  /** A command line. */
  | "shell"
  /** Source, or anything else read as lines: monospaced, unwrapped, preserved. */
  | "code"
  /** A sentence somebody wrote to be read — a description, a prompt. */
  | "text"
  /** Short enough to sit on the same line as its label. */
  | "scalar"
  /** An array of short values. */
  | "list"
  /** Anything with structure: pretty-printed. */
  | "json";

export type Arg = {
  /** The key exactly as the model wrote it — what a reader would grep for. */
  key: string;
  /** The same key set as words, since the panel's prose is lowercase. */
  label: string;
  form: Form;
  /** The value, capped. Empty for `list`, which carries `items` instead. */
  value: string;
  items?: string[];
  /** Characters this had to drop to fit `VALUE_CAP`. */
  clipped?: number;
};

/** One line of an edit's before-and-after. */
export type DiffRow = { sign: " " | "-" | "+"; text: string };

/** One before-and-after within a call. Several when the call carried several
 *  edits; the label says which, and is absent when there is only one. */
export type Hunk = { label?: string; rows: DiffRow[] };

/* ── names ──────────────────────────────────────────────────────────────── */

/** What to stamp the call with.
 *
 *  The raw tool name, which is short, exact and the thing you would search the
 *  session file for — set beside the prose rather than instead of it, because
 *  the prose says what it was *for* and this says what it *was*.
 *
 *  An MCP tool arrives as `mcp__<server>__<tool>`, which is thirty characters of
 *  which two matter. It is split back into its two halves; the double
 *  underscore is the delimiter the CLI actually uses, and a server whose own
 *  name contains one is why the split is bounded to three parts rather than
 *  greedy. */
export function toolBadge(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}·${mcp[2]}`;
  return name;
}

/** A path split where the eye wants it: everything up to the last separator,
 *  and the name itself. Both separators, since an agent on this machine writes
 *  either and a result quotes back whichever it was given. */
export function splitPath(p: string): { dir: string; base: string } {
  const at = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (at < 0) return { dir: "", base: p };
  return { dir: p.slice(0, at + 1), base: p.slice(at + 1) };
}

/* ── arguments ──────────────────────────────────────────────────────────── */

/** The arguments that lead, per tool, in the order they should be read.
 *
 *  Object key order is insertion order, which is the order the *model* emitted
 *  them in — near enough to arbitrary, and it changes between calls to the same
 *  tool. The subject of the call should be first every time: which file, which
 *  command, which pattern. Anything not named here follows in the order it
 *  arrived, so a tool this table has never heard of still shows everything. */
const LEAD: Record<string, string[]> = {
  Read: ["file_path", "offset", "limit", "pages"],
  Edit: ["file_path", "replace_all", "old_string", "new_string"],
  Write: ["file_path", "content"],
  NotebookEdit: ["notebook_path", "cell_id", "edit_mode", "new_source"],
  Bash: ["command", "description", "timeout", "run_in_background"],
  PowerShell: ["command", "description", "timeout", "run_in_background"],
  Glob: ["pattern", "path"],
  Grep: [
    "pattern", "path", "glob", "type", "output_mode",
    "-i", "-n", "-o", "-A", "-B", "-C", "multiline", "head_limit", "offset",
  ],
  Agent: ["description", "subagent_type", "model", "isolation", "prompt"],
  Task: ["description", "subagent_type", "model", "isolation", "prompt"],
  Skill: ["skill", "args"],
  WebFetch: ["url", "prompt"],
  WebSearch: ["query", "allowed_domains", "blocked_domains"],
  TaskCreate: ["subject", "activeForm", "description"],
  TaskUpdate: ["taskId", "status"],
  Monitor: ["description", "command", "timeout"],
  /* The script is the whole of a workflow and it is also four hundred lines, so
     everything that says what the run *is* has to stand above it — otherwise
     opening the call to see which workflow this was means scrolling past it. */
  Workflow: ["description", "name", "scriptPath", "resumeFromRunId", "args", "script"],
  SendMessage: ["to", "message"],
};

/** Keys whose value is a place on disk. */
const PATHS = new Set([
  "file_path", "notebook_path", "path", "cwd", "output_path", "outputPath",
  "scriptPath", "filePath", "directory", "dir",
]);

/** Keys whose value is a command line. */
const SHELLS = new Set(["command", "cmd"]);

/** Keys whose value is source, or is read like source.
 *
 *  `script` was in `SHELLS` on the assumption that a thing called a script is a
 *  thing you type at a prompt. On this machine the only tool that has ever
 *  carried one is `Workflow` (5 calls of 5, read 2026-08-21) and its script is
 *  four hundred lines of JavaScript — which was being drawn with a `›` in front
 *  of it, as though somebody had typed the whole of it at a shell. */
const CODES = new Set([
  "content", "new_source", "old_string", "new_string", "source", "body",
  "patch", "diff", "text", "script",
]);

/** Keys whose value is a sentence written to be read by somebody. */
const PROSE = new Set([
  "prompt", "description", "question", "instructions", "message", "subject",
  "activeForm", "summary", "reason", "query", "task", "detail", "title",
]);

/** Past this, a single-line string is a paragraph rather than a value, and is
 *  set to wrap instead of being pinned beside its label. */
const SCALAR_MAX = 72;

/** Clip a string to the cap, saying how much went.
 *
 *  Exported because both halves of the bargain use it: this file caps what a
 *  line *holds*, and the two ingest paths cap what they put there. */
export function capValue(s: string, cap = VALUE_CAP): { text: string; clipped: number } {
  if (s.length <= cap) return { text: s, clipped: 0 };
  return { text: s.slice(0, cap), clipped: s.length - cap };
}

/** The same cap, applied through a whole argument object.
 *
 *  Called once, where the line is written. Returns a plain structure that
 *  shares nothing with the event it came from — an event is transient and this
 *  is kept for the life of the card, so holding a reference into one would pin
 *  the whole message. */
export function capInput(input: unknown, cap = VALUE_CAP): unknown {
  if (typeof input === "string") return capValue(input, cap).text;
  if (Array.isArray(input)) return input.map((v) => capInput(v, cap));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = capInput(v, cap);
    }
    return out;
  }
  return input;
}

/** `file_path` → `file path`, `activeForm` → `active form`. A flag keeps its
 *  dashes: `-A` set as "a" would be a different flag. */
export function labelOf(key: string): string {
  if (key.startsWith("-")) return key;
  return key
    .replace(/[_.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

/** How to set one value: asked of the key first, then of the value's shape.
 *
 *  The key first, because the key is the only thing that knows *meaning* — a
 *  path and a search pattern are both short strings, and only one of them wants
 *  its last segment picked out. The shape second, so a tool nobody has heard of
 *  still gets a multi-line value set as lines rather than run together as a
 *  sentence. */
export function formOf(key: string, value: unknown): Form {
  if (Array.isArray(value)) {
    return value.every((v) => v === null || typeof v !== "object") ? "list" : "json";
  }
  if (value !== null && typeof value === "object") return "json";
  if (typeof value !== "string") return "scalar";
  if (PATHS.has(key)) return "path";
  if (SHELLS.has(key)) return "shell";
  if (CODES.has(key)) return "code";
  if (PROSE.has(key)) return "text";
  if (value.includes("\n")) return "code";
  return value.length > SCALAR_MAX ? "text" : "scalar";
}

/** Keys whose value is the line a call started reading at.
 *
 *  Only `offset`, which is `Read`'s, and it is a set rather than a comparison so
 *  a second tool spelling it differently is one entry. `Grep`'s `offset` is a
 *  count of *results* to skip rather than a line in a file — but `Grep` carries
 *  no path-form argument to attach a line to, so the two cannot collide.
 *
 *  1-based, as `Read` counts and as every editor does, so it is used exactly as
 *  it arrives. */
const STARTS = new Set(["offset", "start_line", "startLine", "line"]);

/** Which line a call was pointed at, if it said.
 *
 *  For the one gesture that wants it: a path in a tool call is clickable into
 *  the file viewer, and a `Read` with an offset knows where in the file you were
 *  looking. An `Edit` does not — it names the text it replaced rather than where
 *  — and guessing by searching the file for `old_string` would be a viewer that
 *  is confidently in the wrong place whenever the string occurs twice. So the
 *  honest answer there is null, and the viewer opens at the top.
 *
 *  Pure and separate from `argsOf` because it is a question about a call rather
 *  than a thing to draw, and because it is the sort of arithmetic that is worth
 *  a test rather than a line inside a component. */
export function startLine(args: Arg[]): number | null {
  for (const a of args) {
    if (!STARTS.has(a.key)) continue;
    const n = Number(a.value);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** Every argument the call carried, in reading order.
 *
 *  Every one of them: a call is machinery, and the reason to open it is that
 *  something in it is not what you assumed. An argument this file has no
 *  opinion about is still drawn — as JSON if it has to be — because the
 *  alternative is a panel that quietly decides what you meant to check.
 *
 *  `skip` is how the edit diff avoids being printed twice: the two strings it
 *  is built from are dropped from the list, since a diff is what they are *for*
 *  and the raw pair below it would be the same content a third time. */
export function argsOf(name: string, input: unknown, skip: string[] = []): Arg[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (input === undefined || input === null) return [];
    /* A tool called with a bare value rather than an object. Nothing on this
       machine has ever emitted one, but the panel must not go blank if one
       arrives. */
    return [{ key: "input", label: "input", form: formOf("input", input), value: String(input) }];
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const lead = LEAD[name] ?? [];
  const rank = (k: string) => {
    const i = lead.indexOf(k);
    return i === -1 ? lead.length + 1 : i;
  };
  const ordered = entries
    .filter(([k]) => !skip.includes(k))
    .map((e, i) => ({ e, i }))
    /* Stable within a rank: everything the table does not name keeps the order
       it arrived in, which is the model's own. */
    .sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i)
    .map(({ e }) => e);

  const out: Arg[] = [];
  for (const [key, value] of ordered) {
    if (value === undefined) continue;
    const form = formOf(key, value);
    const label = labelOf(key);
    if (form === "list") {
      out.push({ key, label, form, value: "", items: (value as unknown[]).map(String) });
      continue;
    }
    const raw =
      form === "json"
        ? JSON.stringify(value, null, 2)
        : typeof value === "string"
          ? value
          : String(value);
    const { text, clipped } = capValue(raw);
    out.push(clipped ? { key, label, form, value: text, clipped } : { key, label, form, value: text });
  }
  return out;
}

/* ── the edit diff ──────────────────────────────────────────────────────── */

/** The pairs of strings a call is asking to swap, in the order it asks.
 *
 *  Two shapes: the single `old_string`/`new_string` of an `Edit`, and the
 *  `edits` array a multi-edit carries. Both are matched, because the second
 *  costs four lines and the first is what this build emits. */
function pairsOf(name: string, input: any): Array<{ from: string; to: string }> {
  const one = (o: any) =>
    typeof o?.old_string === "string" && typeof o?.new_string === "string"
      ? { from: o.old_string, to: o.new_string }
      : null;
  if (Array.isArray(input?.edits)) {
    return input.edits.map(one).filter(Boolean) as Array<{ from: string; to: string }>;
  }
  if (name === "Edit" || name === "NotebookEdit" || name === "MultiEdit") {
    const p = one(input);
    return p ? [p] : [];
  }
  return [];
}

/** The keys a diff has already spoken for, so `argsOf` can be told to leave
 *  them out. */
function diffedKeys(input: unknown): string[] {
  return Array.isArray((input as any)?.edits)
    ? ["edits"]
    : ["old_string", "new_string"];
}

/** Line-level LCS. The classic table, and the reason for `DIFF_MAX_LINES`.
 *
 *  Written out rather than pulled in: a dependency for forty lines of dynamic
 *  programming is a dependency to keep updated, and this one has a fixed job. */
function lcs(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  /* One flat array rather than an array of arrays — the table is the whole cost
     of this function and (n+1)·(m+1) numbers is the smallest it can be. */
  const t = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[at(i, j)] =
        a[i] === b[j]
          ? t[at(i + 1, j + 1)] + 1
          : Math.max(t[at(i + 1, j)], t[at(i, j + 1)]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (t[at(i + 1, j)] >= t[at(i, j + 1)]) {
      rows.push({ sign: "-", text: a[i] });
      i++;
    } else {
      rows.push({ sign: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ sign: "-", text: a[i++] });
  while (j < m) rows.push({ sign: "+", text: b[j++] });
  return rows;
}

/** What an edit changed, as lines.
 *
 *  A diff rather than the two strings, because comparing two adjacent walls of
 *  near-identical code by eye is the thing a diff was invented to stop anybody
 *  having to do. Unchanged lines are kept — an `old_string` is already the
 *  minimum context the edit needed to be unambiguous, so there is nothing here
 *  to elide.
 *
 *  Null when the call is not an edit, or when either side is past the guard —
 *  the caller then falls back to `argsOf`, which will draw both strings whole
 *  because `diffedKeys` also comes back empty. */
export function hunksOf(name: string, input: unknown): Hunk[] | null {
  const pairs = pairsOf(name, input);
  if (!pairs.length) return null;
  const hunks: Hunk[] = [];
  for (const [i, p] of pairs.entries()) {
    const from = p.from.split("\n");
    const to = p.to.split("\n");
    if (from.length > DIFF_MAX_LINES || to.length > DIFF_MAX_LINES) return null;
    hunks.push({
      ...(pairs.length > 1 ? { label: `edit ${i + 1} of ${pairs.length}` } : {}),
      rows: lcs(from, to),
    });
  }
  return hunks;
}

/** Everything the fold draws above the result: the stamp, the diff if there is
 *  one, and every argument the diff did not already account for.
 *
 *  One function rather than three, because the third depends on the second in a
 *  way that is easy to get subtly wrong from outside: the strings an edit is
 *  built from are dropped from the argument list *only when a diff was actually
 *  produced*. Past `DIFF_MAX_LINES` there is no diff, and dropping them anyway
 *  would be a fold that shows an edit's file path and nothing about the edit.
 *  Asked separately that is two calls that have to agree; asked here it is one
 *  branch. */
export function callView(
  name: string,
  input: unknown,
): { badge: string; hunks: Hunk[] | null; args: Arg[] } {
  const hunks = hunksOf(name, input);
  return {
    badge: toolBadge(name),
    hunks,
    args: argsOf(name, input, hunks ? diffedKeys(input) : []),
  };
}

/** How much an edit moved, for the head of the fold: `+7 −2`. Nothing when the
 *  call is not an edit. */
export function diffTally(hunks: Hunk[] | null): string | null {
  if (!hunks) return null;
  let plus = 0;
  let minus = 0;
  for (const h of hunks) {
    for (const r of h.rows) {
      if (r.sign === "+") plus++;
      else if (r.sign === "-") minus++;
    }
  }
  if (!plus && !minus) return null;
  return `+${plus} −${minus}`;
}

/* ── the result ─────────────────────────────────────────────────────────── */

/** What came back from a call. `undefined` on the line until it lands, which is
 *  a state the panel draws rather than hides — a call still in flight is the
 *  most interesting one on the page. */
export type ToolResult = {
  text: string;
  /** The call answered with an error. */
  failed?: true;
  /** Characters dropped to `VALUE_CAP`. */
  clipped?: number;
  /** Pictures that came back with it, as validated data URLs.
   *
   *  Absent rather than empty when there are none, so nothing in the panel has
   *  to distinguish "no images" from "images not read yet" — every other
   *  optional field here strikes the same bargain. */
  pictures?: Picture[];
  /** How many more came back than are being drawn — see `RESULT_PICTURES`. */
  unshown?: number;
};

/** How many pictures one call may keep.
 *
 *  Four. A `Read` of one file answers with one; the case that produces more is a
 *  screenshot harness handing back a set, and past four the fold stops being a
 *  round you can read. This is a cap on *drawing*, not on the wire — the ones
 *  past it are counted and said so, because "3 more not shown" is a fact about
 *  the call, and silently keeping the first four is the quiet truncation this
 *  codebase keeps having to learn not to do. */
export const RESULT_PICTURES = 4;

/** A tool call as the transcript holds it, hung off the `tool` line that draws
 *  it (`Line.call`).
 *
 *  `id` is the `tool_use` id, and is the only thing tying the call to the
 *  result that answers it — the same bargain `Seat` and `Job` strike, and for
 *  the same reason: there is nothing to correlate, only to route. Optional
 *  because a call with no id can still be drawn; it just never lands.
 *
 *  `input` is capped (`capInput`) and structurally its own, sharing nothing
 *  with the event it was read out of. */
export type ToolCall = {
  id?: string;
  name: string;
  input: unknown;
  result?: ToolResult;
};

/** A result off the wire, ready to hang on a call. Both ingest paths go through
 *  here, so the cap and the failure flag cannot be applied one way live and
 *  another way off disk. */
export function landed(
  text: string,
  failed = false,
  pictures: Picture[] = [],
): ToolResult {
  const { text: kept, clipped } = capValue(text);
  const shown = pictures.slice(0, RESULT_PICTURES);
  return {
    text: kept,
    ...(failed ? { failed: true as const } : {}),
    ...(clipped ? { clipped } : {}),
    ...(shown.length > 0 ? { pictures: shown } : {}),
    ...(pictures.length > shown.length
      ? { unshown: pictures.length - shown.length }
      : {}),
  };
}

/** A result's size, for the head of the fold — so a call says how much came
 *  back without being opened. Lines, because that is the unit a `Read` and a
 *  `Grep` and a test run all answer in; characters only when it is one line,
 *  where "1 line" says nothing. */
export function resultSize(r: ToolResult): string {
  const text = r.text;
  /* A picture before an emptiness. An image result carries no text at all — the
     block beside it *is* the image — so this used to answer "empty" about a call
     that had come back with a screenshot in it, which is the whole of what sink
     28cb1c5d was reporting from the outside. */
  const shots = (r.pictures?.length ?? 0) + (r.unshown ?? 0);
  if (shots > 0) {
    const said = shots === 1 ? "1 image" : `${shots} images`;
    return text ? `${said}, ${text.split("\n").length} lines` : said;
  }
  if (!text) return "empty";
  const lines = text.split("\n").length;
  if (lines === 1) return `${text.length} char${text.length === 1 ? "" : "s"}`;
  return `${lines} lines`;
}

/** The first screenful, and how much is behind the button.
 *
 *  Split on lines rather than characters because a result is read as lines and
 *  a character cut lands mid-token, which reads as corruption rather than as a
 *  clip. */
export function clampLines(
  text: string,
  max = RESULT_LINES,
): { head: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { head: text, hidden: 0 };
  return { head: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** What the clip note says, when a value or a result had to be cut to fit.
 *
 *  Said in the panel rather than left silent, and it names where the whole of
 *  it still is: a fold that quietly truncates is a fold that has to be
 *  distrusted for everything else it shows. */
export function clipNote(chars: number): string {
  // "en-US" and not the host's locale: the sentence around the figure is
  // English, and a bare `toLocaleString()` groups by whatever the machine is
  // set to — so the same build read "1,234" here and "1 234" (a narrow
  // no-break space) on a box set to French, which is what turned the test red.
  return `${chars.toLocaleString("en-US")} more characters — the whole of it is in the session file`;
}
