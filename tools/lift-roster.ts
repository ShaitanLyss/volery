/* Actually run the MCP roster's contract on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why. So `bash tools/check-gnu.sh --tests` *typechecks* these assertions and
 * cannot execute one of them.
 *
 *     bun tools/lift-roster.ts
 *
 * ### Why this file, out of forty-two with test modules
 *
 * Because the roster is where this crate's assertions are **exhaustive** — they
 * speak for every tool at once — and an exhaustive assertion in a suite nobody
 * can run is documentation rather than a guard. Sink `0b97adde` is that
 * finding, and it was written after `the_roster_tools_are_advertised_beside_the_question`
 * had rotted twice: once when the forge's three tools were registered without a
 * line there (`f4765ce`), and again, harder, when the tiering reordered six of
 * them. Both times it went on compiling, because a `vec!` missing three
 * elements is perfectly good Rust. The second time the first thing that could
 * say so was the release workflow, which it failed — for tidiness, several
 * commits after the change that caused it.
 *
 * That assertion has since been rewritten to *derive* its expectation, which is
 * the better half of the answer and the one to reach for first: a derived
 * expectation cannot restate a registry wrongly, because it does not restate
 * it. This is the other half, for what is left over.
 * `every_deferred_tool_can_be_found` is exhaustive and cannot be derived —
 * there is no second list of hints to check against — and the loaded tier's
 * byte budget is a number that means nothing until something computes it.
 *
 * ### The result guards, and why they were added late
 *
 * `no_tool_result_names_a_tool_a_card_cannot_call` and its pair read the prose
 * of *thirteen* source files looking for a backticked tool name in a tool
 * **result**, where a bare name cannot be resolved because a result arrives on
 * its own. They were not lifted at first, and that omission cost the v0.29.0
 * release build.
 *
 * The failure is worth knowing because neither commit involved was wrong.
 * `pin.rs` had said "`remove` to take it down" about its own boolean argument
 * for months. Then `remove.rs` landed a *tool* called `remove` — one that
 * deletes a path from this machine — and that sentence became a result telling
 * a card to call something that would delete the image file. **An interaction
 * between two changes, each fine alone**, which is the class of bug an
 * exhaustive assertion exists for and the class no reviewer catches.
 *
 * Lifting them needed one thing beyond the usual: `SPEAKING_SOURCES` is a list
 * of `include_str!("ask.rs")`, resolved against the including file, so the
 * thirteen sources are **copied into the temp directory beside `lifted.rs`**.
 * That is not editing the lifted text — it is giving it the environment its text
 * expects, the same move `MODULES` makes for `crate::x::y`. The file list is
 * parsed out of the const rather than written here, or it would go stale the
 * first time somebody added a source and the assertion would then pass while
 * covering less than it claims.
 *
 * ### The technique
 *
 * Variant 2 of build.md's ladder: the schemas are `serde_json::json!`, so this
 * borrows the `serde_json` rlib cargo has already built rather than being
 * limited to dependency-free code. It finds the rlib by hash rather than being
 * told one, since the hash moves with the dependency graph.
 *
 * `CARGO_PKG_VERSION` goes into *rustc's own* environment, because `dispatch`
 * answers `initialize` with `env!("CARGO_PKG_VERSION")` — a compile-time read
 * of the compiler's environment. Nothing here asserts the version, so the value
 * is arbitrary; supplying one is what lets the function be lifted verbatim
 * rather than edited until it compiles.
 *
 * **It regenerates from the source files on every run and keeps nothing.**
 */

import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";

/** What to lift, per file, in the order it has to be declared.
 *
 *  Listing what comes *in* rather than what stays out, as every other lift here
 *  argues. The direction of failure is what makes it safe: a new tool whose
 *  schema is not added here is simply not asserted about, while `roster()`
 *  naming a function this list omits breaks the build loudly. */
const SOURCES: Array<{ file: string; items: string[] }> = [
  /* `PLACES` is the only constant any schema function reaches for that is not a
     tool name — `pin`'s `enum` of where an image may go. */
  {
    file: "src-tauri/src/pin.rs",
    items: [
      "const PLACES",
      "const PIN_TOOL",
      "const REPIN_TOOL",
      "const PINNED_TOOL",
      "fn pin_schema",
      "fn repin_schema",
      "fn pinned_schema",
    ],
  },
  {
    file: "src-tauri/src/board.rs",
    items: [
      "const BOARD_TOOL",
      "const POST_TOOL",
      "const UNPOST_TOOL",
      "fn board_schema",
      "fn post_schema",
      "fn unpost_schema",
    ],
  },
  {
    file: "src-tauri/src/sink.rs",
    items: [
      "const SINK_TOOL",
      "const DROP_TOOL",
      "const TAKE_TOOL",
      "const DONE_TOOL",
      "fn sink_schema",
      "fn drop_schema",
      "fn take_schema",
      "fn done_schema",
    ],
  },
  {
    file: "src-tauri/src/relay.rs",
    items: [
      "const LIST_TOOL",
      "const SEND_TOOL",
      "const TOUCHED_TOOL",
      "const RECALL_TOOL",
      "fn list_schema",
      "fn send_schema",
      "fn touched_schema",
      "fn recall_schema",
    ],
  },
  { file: "src-tauri/src/later.rs", items: ["const WAKE_TOOL", "fn wake_schema"] },
  { file: "src-tauri/src/limits.rs", items: ["const ALLOWANCE_TOOL", "fn allowance_schema"] },
  {
    file: "src-tauri/src/spawn.rs",
    items: ["const SPAWN_TOOL", "const CLOSE_TOOL", "fn spawn_schema", "fn close_schema"],
  },
  {
    file: "src-tauri/src/servers.rs",
    items: [
      "const SERVERS_TOOL",
      "const SERVER_LOG_TOOL",
      "const SERVER_TOOL",
      "fn servers_schema",
      "fn server_log_schema",
      "fn server_schema",
    ],
  },
  {
    file: "src-tauri/src/smith.rs",
    items: [
      "const PIPELINES_TOOL",
      "const REVIEWS_TOOL",
      "const PULL_REQUEST_TOOL",
      "fn pipelines_schema",
      "fn reviews_schema",
      "fn pull_request_schema",
    ],
  },
  {
    file: "src-tauri/src/status.rs",
    items: ["const STATUS_TOOL", "fn status_schema"],
  },
  {
    file: "src-tauri/src/chronicle.rs",
    items: ["const WISP_TOOL", "const CHRONICLE_TOOL", "fn wisp_schema", "fn chronicle_schema"],
  },
  {
    file: "src-tauri/src/remove.rs",
    items: ["const REMOVE_TOOL", "fn remove_schema"],
  },
  /* Not a tool of ours at all — `mcp_config` hands Playwright's own server to a
     card that has the shared browser, and the roster assertions reach
     `mcp_config`, so the lift needs the function even though nothing here
     asserts about what it returns. */
  {
    file: "src-tauri/src/browser.rs",
    items: ["fn mcp_server"],
  },
  {
    file: "src-tauri/src/docket.rs",
    items: [
      "const TASKS_TOOL",
      "const TASK_TOOL",
      "const TOKEN_TOOL",
      "fn tasks_schema",
      "fn task_schema",
      "fn token_schema",
    ],
  },
  {
    file: "src-tauri/src/selector.rs",
    items: ["const RECORDS_TOOL", "const PUT_ON_TOOL", "fn records_schema", "fn put_on_schema"],
  },
  {
    file: "src-tauri/src/ask.rs",
    items: [
      "const ANSWER_MAX",
      "fn client_timeout_ms",
      "fn preview_schema",
      "fn option_schema",
      "fn tool_schema",
      "fn always",
      "fn found_by",
      "fn roster",
      "fn mcp_config",
      "enum Dispatch",
      "fn dispatch",
    ],
  },
  {
    /* `Selfhood` and the `Provenance` inside it are types rather than
       assertions, and they are here because `append_prompt` takes one — a lift
       that omits a parameter's type does not fail at the assertion, it fails to
       compile, which is how this script went quiet after 664f375 added the
       argument. Lifting them keeps the roster contract runnable on a machine
       with no MSVC, which is the only reason any of this exists. */
    file: "src-tauri/src/store.rs",
    items: ["struct Provenance"],
  },
  {
    file: "src-tauri/src/supervisor.rs",
    items: [
      "const MCP_PREFIX",
      "struct Selfhood",
      "fn append_prompt",
      "fn system_prompt",
    ],
  },
];

/** The assertions, per file. Helpers first — they are declared inside the test
 *  module and are found the same way. */
/** Declarations inside a test module that the assertions are written against.
 *
 *  `SPEAKING_SOURCES` is the only one so far, and it is why the two result
 *  guards below can be run here at all. */
const TEST_ITEMS: Array<{ file: string; items: string[] }> = [
  { file: "src-tauri/src/supervisor.rs", items: ["const SPEAKING_SOURCES"] },
];

const TESTS: Array<{ file: string; names: string[] }> = [
  {
    file: "src-tauri/src/ask.rs",
    names: [
      /* Exhaustive, and the one the sink item is about. */
      "the_roster_tools_are_advertised_beside_the_question",
      /* Exhaustive and underivable: nothing else holds a list of hints. */
      "every_deferred_tool_can_be_found",
      /* A budget means nothing until something computes it. */
      "the_loaded_tier_is_what_every_turn_pays_for",
      /* Absent, not false — and every other test stays green if it is wrong. */
      "the_server_claims_no_tier_of_its_own",
      "reading_the_dev_servers_is_offered_before_running_them",
      "the_tool_that_runs_things_says_that_it_runs_things",
    ],
  },
  {
    file: "src-tauri/src/supervisor.rs",
    names: [
      /* Helpers first, per the note above — these three build the `Selfhood`
         the prompt assertions are written against. */
      "fullest",
      "selves",
      "fullest_and_none",
      "named_tools",
      "advertised",
      "the_prompt_names_only_tools_the_server_advertises",
      "the_prompt_names_only_tools_whose_schemas_are_loaded",
      "no_tool_is_named_without_its_server_prefix",
      "a_chat_card_is_told_only_about_the_question",
      /* The paragraph that contradicts the client's own notice — the only one
         here whose subject is something already in the prompt. */
      "a_connector_that_needs_authorizing_is_not_the_last_word",
      /* The last-one-wins collision that made guidance inert. */
      "everything_appended_to_the_prompt_survives_being_composed",
      "either_half_of_the_prompt_can_be_missing",
      /* The two that read tool *results* rather than the prompt, and the pair
         that made this worth extending.

         `no_tool_result_names_a_tool_a_card_cannot_call` broke the v0.29.0
         release build, and it broke it on an interaction rather than on either
         change alone: `pin.rs` had said "`remove` to take it down" about its own
         boolean argument for months, and then `remove.rs` landed a *tool* named
         `remove` that deletes a path from this machine. Neither commit is wrong
         by itself. Nothing before `cargo test` could say so, and `cargo test`
         does not run here — so the first thing that could was the release. That
         is the exact failure this whole script exists to stop, arriving in a
         test the script did not cover.

         Both are exhaustive over thirteen source files, which is the other half
         of the argument in the head comment: an exhaustive assertion in a suite
         nobody can run is documentation. */
      "schema_spans",
      "literals",
      "no_tool_result_names_a_tool_a_card_cannot_call",
      "every_prefixed_name_in_a_result_is_a_tool_the_server_advertises",
    ],
  },
];

/** The per-file machinery, closed over one file's lines. */
function reader(file: string) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  const block = (i: number): string => blockAt(lines, i, file);

  const testsAt = (): number => {
    const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
    return at < 0 ? lines.length : at;
  };

  /** Declarations are searched only *above* the test module, so a fixture
   *  sharing a name with a function is never the match. */
  const find = (what: string): string => {
    const stop = testsAt();
    const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
    for (let i = 0; i < stop; i++) if (re.test(lines[i])) return block(i);
    throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
  };

  /** A declaration inside the test module, by name.
   *
   *  `find` searches only *above* `mod tests` and `findTest` matches `fn` only,
   *  so a `const` that the assertions are written against — `SPEAKING_SOURCES`
   *  is the one — is reachable by neither. `blockAt` already delimits a const by
   *  its semicolon, so this is only about where to start looking. */
  const findTestItem = (decl: string): string => {
    const re = new RegExp(`^\\s*(pub\\s+)?${decl.replace(/ /g, "\\s+")}\\b`);
    for (let i = testsAt(); i < lines.length; i++) if (re.test(lines[i])) return block(i);
    throw new Error(`could not find "${decl}" in the tests of ${file} — has it been renamed?`);
  };

  const findTest = (name: string): string => {
    for (let i = testsAt(); i < lines.length; i++) {
      if (new RegExp(`^\\s*fn ${name}\\s*[(<]`).test(lines[i])) return block(i);
    }
    throw new Error(`could not find test "${name}" in ${file} — has it been renamed?`);
  };

  return { find, findTest, findTestItem };
}

/** The `serde_json` rlib cargo already built, found by hash rather than named.
 *
 *  The hash is a function of the whole dependency graph, so writing one down
 *  would make this script wrong the first time anything moved. */
function serdeJsonRlib(): string {
  let names: string[];
  try {
    names = readdirSync(DEPS);
  } catch {
    throw new Error(
      `${DEPS} does not exist — run \`bash tools/check-gnu.sh\` once so cargo builds the rlibs this borrows.`,
    );
  }
  const hit = names.filter((n) => /^libserde_json-[0-9a-f]+\.rlib$/.test(n));
  if (hit.length === 0) {
    throw new Error(`no libserde_json-*.rlib in ${DEPS} — run tools/check-gnu.sh first`);
  }
  /* More than one means two graphs' worth of artefacts are sitting there. The
     newest wins, and it says so rather than choosing silently. */
  if (hit.length > 1) {
    console.error(`note: ${hit.length} serde_json rlibs in deps, using ${hit[hit.length - 1]}`);
  }
  return join(DEPS, hit[hit.length - 1]);
}

/** The module paths the lifted code still spells out.
 *
 *  `roster()` says `crate::board::board_schema()` and the supervisor tests say
 *  `crate::ask::dispatch(…)`, and the whole point of a lift is that the text is
 *  taken verbatim rather than edited until it compiles — an edited lift is
 *  evidence about the edit. So the *file* grows the shape the text expects: a
 *  module per source file, each re-exporting the flattened root, so every
 *  `crate::x::y` resolves to the `y` sitting beside it. `crate::` is this
 *  file's own root here, which is what makes it work at all. */
const MODULES = [
  "ask",
  "board",
  "chronicle",
  "browser",
  "later",
  "limits",
  "pin",
  "relay",
  "remove",
  "selector",
  "servers",
  "sink",
  "docket",
  "smith",
  "spawn",
  "status",
  "store",
  "supervisor",
];

const body: string[] = [
  "//! GENERATED by tools/lift-roster.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  "use std::time::Duration;",
  ...MODULES.map((m) => `pub mod ${m} { pub use super::*; }`),
];
for (const { file, items } of SOURCES) {
  const { find } = reader(file);
  body.push(`// ---- ${file} ----`);
  for (const it of items) body.push(find(it));
}
body.push("#[cfg(test)]", "mod tests {", "    use super::*;");
for (const { file, items } of TEST_ITEMS) {
  const { findTestItem } = reader(file);
  body.push(`    // ---- ${file} (test-module items) ----`);
  for (const it of items) body.push(findTestItem(it));
}
for (const { file, names } of TESTS) {
  const { findTest } = reader(file);
  body.push(`    // ---- ${file} ----`);
  for (const n of names) body.push(findTest(n));
}
body.push("}");

const dir = mkdtempSync(join(tmpdir(), "lift-roster-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body.join("\n\n"));

/* `SPEAKING_SOURCES` is a list of `include_str!("ask.rs")`, resolved relative to
   the file doing the including — so the lifted file needs those thirteen sources
   sitting beside it or it does not compile.
 *
 * **The list is read out of the const rather than written here**, which is not
 * tidiness: a hard-coded copy would go stale the first time somebody added a
 * file to `SPEAKING_SOURCES`, and the assertion would then still pass while
 * silently not covering the new one. That is precisely the bug this lift was
 * extended to catch — a guard that goes quiet instead of red — so writing it
 * down twice here would be reintroducing it one layer up.
 *
 * They are copied verbatim, which is the whole point: the assertion reads the
 * real prose out of the real files. */
const speaking = [...body.join("\n").matchAll(/include_str!\("([A-Za-z0-9_]+\.rs)"\)/g)].map(
  (m) => m[1],
);
if (speaking.length === 0) {
  throw new Error(
    "no include_str! sources found in the lift — has SPEAKING_SOURCES changed shape? " +
      "Without them the result guards compile against nothing and pass by covering no files.",
  );
}
for (const name of new Set(speaking)) {
  copyFileSync(join("src-tauri", "src", name), join(dir, name));
}

try {
  const build = spawnSync(
    "rustc",
    [
      "--test",
      "--edition",
      "2021",
      "-A",
      "dead_code",
      "--extern",
      `serde_json=${serdeJsonRlib()}`,
      "-L",
      `dependency=${DEPS}`,
      file,
      "-o",
      exe,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies
           on `link: extra operand`, which names nothing that points at the
           cause. Sink b282b54c and 276f26ca, found independently. */
        RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu",
        /* `dispatch` answers `initialize` with `env!("CARGO_PKG_VERSION")`,
           read from the *compiler's* environment. Nothing here asserts the
           version, so the value is arbitrary — supplying one is what lets the
           function be lifted verbatim instead of edited to compile. */
        CARGO_PKG_VERSION: process.env.CARGO_PKG_VERSION ?? "0.0.0-lift",
      },
    },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  /* Nothing is kept on success. A `lifted.rs` left on disk is the stale copy
     this script exists to make impossible. */
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
