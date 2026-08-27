/* Whether the tree builds, and whose fault it is if not.
 *
 * Sink 3ebe1d59. On 2026-08-27 a `vergen`/`vergen_lib` conflict under
 * `librespot-core` broke `cargo check` for every card in one tree at once, with
 * an error naming nobody's `src/*.rs`. Three cards diagnosed it independently —
 * one broadcast to the whole wall and then had to retract an hour later, one
 * assumed its own new code was at fault, one was quietly fixing it the whole
 * time — and a fourth ran `git stash` in the shared checkout, wiping four
 * cards' uncommitted work, while trying to answer *"is this error pre-existing
 * or mine?"*
 *
 * Volery knew everything about the cards and nothing about the health of the
 * work they were doing. This is the missing fact, and it is one fact with two
 * readers: the user opens a widget, and a card is told unprompted. See
 * `.claude/rules/gates.md`.
 *
 * ── Why this is not the fourth poller ────────────────────────────────────────
 *
 * `CLAUDE.md` allows exactly three places that go and look and demands an
 * argument from anything proposing to be the fourth. This is not one, and it is
 * not even the "fold an adjacent event" compromise that rule offers as the
 * fallback: **it folds the exact event.** Every gate a card runs arrives in the
 * stream this app is already ingesting — a `tool_use` block naming the command,
 * and a `tool_result` carrying `is_error` — and `conversation.svelte.ts` has
 * been folding both for other purposes since before this existed. Nothing is
 * run, nothing is asked, and no clock is involved. A wall where no card runs a
 * gate records nothing, which is correct rather than a gap.
 *
 * A hook was the obvious design and was measured out of the way rather than
 * argued out of it — `tools/probe-gates.ts` has the whole of it. The short
 * version is that a hook would have had to become a **second writer** to the
 * database, which `hooks.rs` deliberately is not (`store::open_readonly`, and
 * the reasoning in `hooks.md`), and it could not have emitted the event the
 * widget needs because a hook is a different process. The stream fold has
 * neither problem and sees strictly more: a failing tool call produces no
 * `PostToolUse` at all, so a hook could never have read the failure text that
 * `tool_result` hands this fold for free.
 *
 * The hook is still the *reader* for the card-facing half — `hooks.rs` already
 * injects `additionalContext` on `UserPromptSubmit` and stays read-only.
 *
 * ── What this file is allowed to claim ───────────────────────────────────────
 *
 * Only what it saw. Three limits, stated here because a reading that overstates
 * is worse than no reading — it is what a broadcast that needed retracting was:
 *
 *   1. **Only cards on this wall.** A gate run in a terminal beside Volery is
 *      invisible, exactly as it is to `file_touch` and to `hooks.rs`'s index
 *      guard. So "last seen green" is never "is green".
 *   2. **Only the gate that ran.** `bun test test/gates.test.ts` is not
 *      `bun run test`, and `bash tools/check-gnu.sh` is `cargo check --lib`,
 *      which does not look at `#[cfg(test)]` code at all. `scope` carries that
 *      and a partial pass never clears a whole gate's red — see `settle`.
 *   3. **Only the exit status.** A gate whose failure is swallowed
 *      (`cargo check || true`) reports a pass, because that is what the tool
 *      result says. `guard` refuses the commonest spellings of that rather than
 *      pretending to catch all of them.
 */

/** What a gate run turned out to be.
 *
 *  `unknown` is not decoration and not a failure: it is a run whose result this
 *  window never saw — the process died mid-gate, the card was interrupted, or
 *  Volery was closed. `hooks.md` records the same distinction being got wrong
 *  twice in `mark_interrupted`, both times by widening "interrupted" to
 *  something easier to ask, and both times the cost was the whole wall claiming
 *  its last turn was cut off. A gate nobody saw the end of is not a red gate. */
export type GateOutcome = "passed" | "failed" | "unknown";

/** How much of its own name a run actually covered.
 *
 *  The distinction exists because this repository has already written two rules
 *  about it: `bash tools/check-gnu.sh` is `cargo check --lib` and says nothing
 *  whatever about a test module (`.claude/rules/build.md`), and a green
 *  `check --tests` "reads like a green test run and is not one". A reading that
 *  let `bun test test/one.test.ts` clear the red left by `bun run test` would be
 *  manufacturing exactly that lie. */
export type GateScope = "whole" | "partial";

/** A command recognised as a gate, before it has an outcome. */
export interface Gate {
  /** The canonical thing being verified, not the command that did it — so
   *  `bash tools/check-gnu.sh` and `cargo check --lib` are one gate, because on
   *  a machine with no MSVC they are literally the same run. */
  gate: string;
  scope: GateScope;
  /** Why it is partial, in a few words, for a face to draw. `null` when whole. */
  narrowed: string | null;
  /** The segment that actually matched, not the whole line — `cd src-tauri &&
   *  cargo check` is recorded as `cargo check`, since the `cd` is not the gate. */
  command: string;
}

/** One observed run of one gate. What the store keeps and both faces read. */
export interface GateRun {
  /** The `tool_use` id. The pairing key between the call and its result, and
   *  the same identity the `job` table already uses for the same reason. */
  toolId: string;
  /** Which card ran it. Provenance, and the whole of "is this red mine". */
  card: string;
  /** What the card was called at the time, since it may be gone by the time
   *  anybody reads this — the argument `sink_item.from_id` already makes. */
  cardName: string | null;
  /** The tree it ran in. Not the project: two cards on different worktrees of
   *  one project share a project and share no files, which is the distinction
   *  `hooks.rs::perilous` had to learn (`worktree.md`). */
  root: string;
  gate: string;
  scope: GateScope;
  /** Why the run was partial, in a few words, or `null` when it was whole.
   *  Carried on the row rather than re-derived from `command` on the way out:
   *  the recogniser is the only thing that knows why it narrowed, and asking a
   *  face to work it back out of the command string would be the same fact
   *  written down twice — which is the failure this codebase has already paid
   *  for in `hooks.rs`'s matcher. */
  narrowed: string | null;
  command: string;
  /** When the call went out. */
  startedAt: number;
  /** When its result landed, or `null` for a run nothing ever settled. */
  settledAt: number | null;
  outcome: GateOutcome;
  /** The tail of what a failing gate said, or `null`. Bounded hard: this is a
   *  compiler's whole opinion and the reading wants the first thing that broke.
   */
  detail: string | null;
}

/** The most of a failure's output that is worth keeping.
 *
 *  A red `cargo check` on this tree is 186 lines and the useful part is the
 *  first error and the count. Kept small deliberately: the reading's job is to
 *  say *that* it is red and roughly why, and the card that wants the whole of
 *  it can run the gate — which it was going to do anyway. A reading that tried
 *  to replace the gate's own output would be a second copy of a compiler
 *  message, going stale in a database. */
export const MAX_DETAIL = 600;

/* ── what counts as a gate ───────────────────────────────────────────────────
 *
 * One table, in one file, and it is the only place in the codebase that knows
 * what a verification command looks like. Deliberately not in `classify.ts`,
 * which is knowledge about an *agent* — its tool names, model ids and event
 * vocabulary. A gate is knowledge about a *repository*, which is the same
 * division `azdo.ts` already draws for a forge and `usage.ts` for a price.
 */

/** A gate recogniser: a pattern over one command segment, and what it means.
 *
 *  **Widening and narrowing are orthogonal, and conflating them was a bug.**
 *  They were one list, with a widening entry breaking out of the loop — so
 *  `cargo check -p skein_lib --all-targets` was read as covering the whole
 *  workspace, because `--all-targets` matched first and the `-p` was never
 *  looked at. A run can perfectly well be *wider in one axis and narrower in
 *  another*: all targets, of one package. Two fields, asked separately. */
interface Recogniser {
  gate: string;
  /** Matched against a normalised segment — collapsed whitespace, lowercased. */
  re: RegExp;
  /** An argument that makes the run cover *more* than its bare form does.
   *  Without it the run is partial and `withoutWidening` says why. */
  widens?: RegExp;
  /** What a run of this gate is missing when `widens` does not match. Named
   *  here rather than as a `narrows` entry because it is the *absence* of an
   *  argument, and a pattern cannot match an absence without asserting the
   *  whole rest of the line. */
  withoutWidening?: string;
  /** Arguments that narrow the run to less than the gate's whole name. When one
   *  of these matches, the run is `partial` and this is what it is called. */
  narrows?: { re: RegExp; as: string }[];
}

/** The whole vocabulary. Ordered: the first match wins, so the more specific
 *  pattern goes first — `cargo test` before `cargo check` matters less than
 *  `bun run check` before a bare `bun run`, but the rule is one rule. */
const RECOGNISERS: Recogniser[] = [
  /* Rust. `tools/check-gnu.sh` IS `cargo check --lib` — it exists because this
     machine has no MSVC toolchain and sets six environment variables around the
     same invocation (`.claude/rules/build.md`), so treating it as a different
     gate would split one fact across two names on the one machine where it is
     the only route. `--profile test` / `--tests` is the *wider* run rather than
     a narrowing one, so it is not in `narrows`: plain `check-gnu.sh` is the
     partial one, because it does not look at `#[cfg(test)]` code at all. */
  {
    gate: "cargo-check",
    re: /\b(cargo\s+check|check-gnu\.sh)\b/,
    /* A bare `cargo check` is `--lib`, which typechecks no test module at all.
       This repository has written that down twice — `.claude/rules/build.md`
       and `hooks.md` — because a clean run there reads exactly like a clean
       test run and is not one. */
    widens: /--profile\s+test|--tests|--all-targets/,
    withoutWidening: "no test modules",
    narrows: [{ re: /\s-p\s+\S+|--package\s+\S+/, as: "one package" }],
  },
  {
    gate: "cargo-test",
    re: /\bcargo\s+test\b/,
    /* A bare filter, not a flag: `cargo test --release` is the whole suite
       compiled differently, where `cargo test gates` is a slice of it. */
    narrows: [{ re: /\bcargo\s+test\s+(?!-)\S/, as: "one filter" }],
  },
  { gate: "cargo-build", re: /\bcargo\s+build\b/ },
  { gate: "cargo-clippy", re: /\bcargo\s+clippy\b/ },

  /* The JS side. `bun run check` is svelte-check + tsc over `src/**` here, and
     `bun run test` names its files explicitly in `package.json` — which is why
     a new test file has to be added there, and why `bun test <file>` is a
     genuinely narrower thing than `bun run test`. */
  { gate: "check", re: /\b(bun|pnpm|npm|yarn)\s+run\s+check\b|\b(pnpm|npm|yarn)\s+check\b/ },
  { gate: "check", re: /\btsc\b(?!.*--watch)/, narrows: [{ re: /\S+\.tsx?\b/, as: "some files" }] },
  { gate: "check", re: /\bsvelte-check\b/ },
  {
    gate: "test",
    re: /\b(bun|pnpm|npm|yarn)\s+run\s+test\b|\b(pnpm|npm|yarn)\s+test\b/,
    /* `--` then a path, or a `-t`, is one file or one name out of a suite whose
       whole point is that it names its files explicitly. */
    narrows: [{ re: /\s--?t\s|\s--\s+\S|\s\S*\.test\.[tj]sx?\b/, as: "part of the suite" }],
  },
  {
    gate: "test",
    re: /\b(bun\s+test|vitest\s+run|vitest(?!\s+\S)|jest)\b/,
    narrows: [
      { re: /\s-t\s/, as: "one name" },
      { re: /\s\S*\.test\.[tj]sx?\b|\s\S*\/\S+\.[tj]sx?\b/, as: "one file" },
    ],
  },
  { gate: "build", re: /\b(bun|pnpm|npm|yarn)\s+run\s+build\b|\bvite\s+build\b/ },
  { gate: "lint", re: /\b(bun|pnpm|npm|yarn)\s+run\s+lint\b|\beslint\b/ },

  /* Python, for `asset_extraction` next door. */
  {
    gate: "pytest",
    re: /\b(uv\s+run\s+)?pytest\b/,
    narrows: [
      { re: /\s-k\s/, as: "one name" },
      { re: /\s\S*tests?\/\S+/, as: "some files" },
    ],
  },
];

/** Commands that *contain* a gate and must not be read as one.
 *
 *  Each of these is a live failure mode rather than a hypothetical:
 *
 *  - **A watcher never settles.** `vitest --watch` and `cargo watch` produce one
 *    `tool_result` when they are finally killed, and its status is about the
 *    kill. `bun run dev` is the same shape.
 *  - **A swallowed failure reports a pass.** `cargo check || true` exits 0 and
 *    the tool result says so. This cannot be caught in general — the
 *    interesting spellings are `||`, `; true`, `-` and a trailing `|| :` — so
 *    what is refused is the commonest ones, and limit 3 in this file's header
 *    is the honest statement of the rest.
 *  - **A gate being talked about is not a gate being run.** `grep "cargo check"`
 *    and `echo bun run test` are how this would have picked up its own
 *    documentation, and the sink is full of cards writing rules that quote gate
 *    commands.
 *  - **A gate whose output is thrown away** was not run to learn anything. */
const DISQUALIFIERS: RegExp[] = [
  /--watch\b|\bcargo\s+watch\b|\bnodemon\b/,
  /\|\|/,
  /;\s*(true|:)\s*$/,
  /\bgrep\b|\brg\b|\becho\b|\bcat\b|\bsed\b|\bawk\b/,
  />\s*\/dev\/null/,
];

/** Split a shell line into the segments that could each be a command.
 *
 *  Deliberately crude, and the crudeness is bounded by `guard`: this splits on
 *  `&&`, `;` and `|` without understanding quoting, so a `;` inside a string
 *  makes two segments where there was one. That direction is safe — a fragment
 *  matches no recogniser and is dropped — where the other direction is not,
 *  which is why `cd src-tauri && cargo check` has to be split at all rather
 *  than matched whole. `hooks.rs::commands` does the careful version in Rust
 *  for a guard that must not be wrong; a reading may be approximate. */
export function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalise a segment for matching: one space between words, lowercased. */
function normalise(segment: string): string {
  return segment.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Whether this whole command line disqualifies itself from being read as a
 *  gate run, whatever its segments look like. Asked of the **whole line**, not
 *  of a segment, because `cargo check || true` is only a lie when the two
 *  halves are read together. */
export function guard(command: string): boolean {
  const line = normalise(command);
  return DISQUALIFIERS.some((re) => re.test(line));
}

/** The gate this command runs, or `null` for the overwhelming majority of
 *  commands, which run none.
 *
 *  `input` rather than a command string, so the shape check lives here: **a
 *  shell tool is one carrying a `command`, never one carrying a name.** That is
 *  `hooks.rs`'s hardest-won rule — its `PreToolUse` matcher was `"Bash"`, the
 *  Windows shell tool is called `PowerShell` on a fresh `claude`, and the
 *  mismatch made every hook in that module a silent no-op for an unknowable
 *  number of versions. Both names are live on this machine at once. */
export function recognise(input: unknown): Gate | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || !command.trim()) return null;

  /* A backgrounded gate is not observable here and must not be recorded as one.
     Its `tool_result` is a launch receipt that arrives immediately and says
     nothing about the run — probed: `backgroundTaskId`, an empty stdout, and
     `is_error` false while the gate is still going. Reading that as a pass
     would put a green on the wall for a run that had not started producing
     output yet, which is the worst failure this feature could have. The `job`
     table is the route for those and already exists. */
  if ((input as { run_in_background?: unknown }).run_in_background === true) return null;

  if (guard(command)) return null;

  for (const segment of segments(command)) {
    const line = normalise(segment);
    for (const r of RECOGNISERS) {
      if (!r.re.test(line)) continue;
      let scope: GateScope = "whole";
      let narrowed: string | null = null;
      /* Widening first, narrowing second, and the order is what makes
         `cargo check -p one --all-targets` come out as "one package": all
         targets *of one package* is genuinely partial, and the narrowing is the
         more specific thing to say about it. */
      if (r.withoutWidening && !r.widens?.test(line)) {
        scope = "partial";
        narrowed = r.withoutWidening;
      }
      for (const n of r.narrows ?? []) {
        if (!n.re.test(line)) continue;
        scope = "partial";
        narrowed = n.as;
      }
      return { gate: r.gate, scope, narrowed, command: segment.trim() };
    }
  }
  return null;
}

/** The tail of a failing gate's output, bounded and tidied.
 *
 *  The **tail** rather than the head, because a compiler puts its summary last
 *  — `error: could not compile \`skein\` (lib) due to 10 previous errors` is
 *  the line a reader wants and it is the final one. Blank runs are collapsed so
 *  the budget is spent on words. */
export function detailOf(text: string): string | null {
  const tidy = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!tidy) return null;
  if (tidy.length <= MAX_DETAIL) return tidy;
  return "…" + tidy.slice(tidy.length - MAX_DETAIL + 1);
}

/* ── the reading ─────────────────────────────────────────────────────────────
 *
 * One record, and this is the face the user gets. The card's face is
 * `hooks.rs::standing_gates`, which composes a sentence from the same rows —
 * two callers, two questions, one table, which is the arrangement `job` already
 * has (`store::jobs_of` serving both `rouse` and `standing`).
 */

/** Where one gate in one tree currently stands. */
export interface GateState {
  gate: string;
  /** The most recent run of it that settled, whatever the outcome. */
  last: GateRun | null;
  /** The most recent run that *passed the whole gate*, which is the only thing
   *  that can honestly be called "green". A partial pass leaves this alone. */
  lastWhole: GateRun | null;
  /** Runs of this gate, newest first, bounded by the caller. */
  runs: GateRun[];
  /** True when the gate has gone from green to red and back more than once in
   *  the window. This is the reading that answers the third waste in sink
   *  3ebe1d59 — the pin applied and lost three times, with each card assuming a
   *  sibling had undone its fix when all three were losing to cargo. Flapping
   *  is visible here in a way it was not visible to anybody that day. */
  flapping: boolean;
}

/** Fold the rows for one tree into one state per gate, newest first.
 *
 *  Rows may arrive in any order and from any card. Sorted here rather than
 *  trusted, because the two writers — the fold as it happens, and a restore
 *  reading the table — have no reason to agree on order. */
export function reading(rows: GateRun[], root?: string): GateState[] {
  const mine = (root ? rows.filter((r) => sameTree(r.root, root)) : rows)
    .slice()
    .sort((a, b) => (b.settledAt ?? b.startedAt) - (a.settledAt ?? a.startedAt));

  const byGate = new Map<string, GateRun[]>();
  for (const r of mine) {
    const list = byGate.get(r.gate);
    if (list) list.push(r);
    else byGate.set(r.gate, [r]);
  }

  const out: GateState[] = [];
  for (const [gate, runs] of byGate) {
    const settled = runs.filter((r) => r.outcome !== "unknown");
    out.push({
      gate,
      last: settled[0] ?? null,
      lastWhole: settled.find((r) => r.outcome === "passed" && r.scope === "whole") ?? null,
      runs,
      flapping: flaps(settled) > 1,
    });
  }
  /* Red first, then by how recently anything was heard — a wall glanced at
     wants the broken gate at the top, and among green ones the freshest
     observation is the one worth trusting. Ties on the name so the order is
     stable rather than incidental, which is what stops a widget reshuffling
     itself on every read. */
  return out.sort((a, b) => {
    const bad = (s: GateState) => (s.last?.outcome === "failed" ? 0 : 1);
    if (bad(a) !== bad(b)) return bad(a) - bad(b);
    const at = (s: GateState) => s.last?.settledAt ?? 0;
    if (at(a) !== at(b)) return at(b) - at(a);
    return a.gate.localeCompare(b.gate);
  });
}

/** How many times the outcome changed across these runs, newest first. */
function flaps(settled: GateRun[]): number {
  let n = 0;
  for (let i = 1; i < settled.length; i++) {
    if (settled[i]!.outcome !== settled[i - 1]!.outcome) n++;
  }
  return n;
}

/** Whether two roots are the same tree.
 *
 *  Compared case-insensitively with separators folded, because these are
 *  Windows paths arriving from two sources — a `cwd` off a stream event and a
 *  `cwd` off a conversation row — and `C:\a\b` and `C:/a/b` are one directory.
 *  Not canonicalised: that needs the filesystem, this is pure, and the cost of
 *  a miss is two entries where there should be one rather than a wrong answer.
 */
export function sameTree(a: string, b: string): boolean {
  const f = (s: string) => s.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return f(a) === f(b);
}

/** The one-line reading of a gate's state, for a face with a row of pixels.
 *
 *  Lowercase and sentence-shaped, per the house convention, and it says *when*
 *  rather than only what — a green with no time on it is the stale-green that
 *  made a broadcast need retracting. */
export function sentence(s: GateState, now: number): string {
  if (!s.last) return `${s.gate} — not seen run`;
  const when = ago(now - (s.last.settledAt ?? s.last.startedAt));
  if (s.last.outcome === "failed") {
    const part = s.last.scope === "partial" ? ` (${s.last.narrowed ?? "part of it"})` : "";
    return `${s.gate} red ${when}${part}`;
  }
  if (s.last.scope === "partial") {
    /* A partial pass with a whole red behind it is the most misleading state
       this feature can be in, so it is the one spelled out longest. */
    const stale = s.lastWhole ? "" : " — the whole gate has not passed here";
    return `${s.gate} — only part of it passed ${when}${stale}`;
  }
  return `${s.gate} green ${when}`;
}

/** A duration as the wall says them — the same vocabulary `hooks.rs::ago` uses,
 *  because a card and a widget describing the same row differently is a thing
 *  somebody has to reconcile by hand. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
