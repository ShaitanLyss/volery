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

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
    file: "src-tauri/src/supervisor.rs",
    items: ["const MCP_PREFIX", "fn append_prompt", "fn system_prompt"],
  },
];

/** The assertions, per file. Helpers first — they are declared inside the test
 *  module and are found the same way. */
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
      "named_tools",
      "advertised",
      "the_prompt_names_only_tools_the_server_advertises",
      "the_prompt_names_only_tools_whose_schemas_are_loaded",
      "no_tool_is_named_without_its_server_prefix",
      "a_chat_card_is_told_only_about_the_question",
      /* The last-one-wins collision that made guidance inert. */
      "everything_appended_to_the_prompt_survives_being_composed",
      "either_half_of_the_prompt_can_be_missing",
    ],
  },
];

/** The per-file machinery, closed over one file's lines. */
function reader(file: string) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  /** Where a declaration starts, including the doc comments and attributes
   *  above it — a lift that dropped `#[test]` would compile into a file with
   *  nothing to run, and say so by passing. */
  const startOf = (i: number): number => {
    let from = i;
    while (from > 0) {
      const prev = lines[from - 1].trim();
      if (prev.startsWith("///") || prev.startsWith("//") || prev.startsWith("#[")) {
        from--;
        continue;
      }
      break;
    }
    return from;
  };

  const block = (i: number): string => {
    const head = lines[i];
    if (/;\s*$/.test(head) && !head.includes("{")) {
      return lines.slice(startOf(i), i + 1).join("\n");
    }
    let depth = 0;
    let seen = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          seen = true;
        } else if (ch === "}") depth--;
      }
      if (seen && depth === 0) return lines.slice(startOf(i), j + 1).join("\n");
    }
    throw new Error(`unterminated block at ${file}:${i + 1}`);
  };

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

  const findTest = (name: string): string => {
    for (let i = testsAt(); i < lines.length; i++) {
      if (new RegExp(`^\\s*fn ${name}\\s*[(<]`).test(lines[i])) return block(i);
    }
    throw new Error(`could not find test "${name}" in ${file} — has it been renamed?`);
  };

  return { find, findTest };
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
  "later",
  "limits",
  "pin",
  "relay",
  "selector",
  "servers",
  "sink",
  "smith",
  "spawn",
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
