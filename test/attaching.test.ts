import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

/* Every input that sends text to an agent attaches pictures and files by
 * construction — because it *is* a `PromptBox`, not because somebody wired a
 * paste and a drop into it (sink fd7ef025). Pictures were the dock's for months
 * and every other agent-bound box silently lacked them, which is CLAUDE.md's
 * "a capability every surface should have is not a prop" in its plainest form.
 *
 * So the assertion is about every text field in the app, not a list of the
 * agent-bound ones: **a `<textarea>` or an `<input>` anywhere is a failure
 * unless the file is named below with the reason its text reaches no agent.**
 * A new input fails here until somebody decides which it is, which is the
 * whole point — the default is the one that cannot quietly lose pictures. */

const SRC = join(import.meta.dir, "../src");

function components(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...components(p));
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

/** Text fields whose words go to no agent, and where they go instead. */
const NOT_AGENT_BOUND: Record<string, string> = {
  "lib/PromptBox.svelte": "the primitive itself",
  "lib/Accounts.svelte": "account names and settings",
  "lib/Away.svelte": "search terms over sketches",
  "lib/Basin.svelte": "the sink's own fields, written to the store",
  "lib/Billboard.svelte": "a notice on the board, written to the store",
  "lib/Canvas.svelte": "a territory's name and a branch name",
  "lib/Console.svelte": "a line for the local shell, not a card",
  "lib/Dogears.svelte": "a dog-ear's label",
  "lib/Drop.svelte": "a sink item, written to the store",
  "lib/Effects.svelte": "ambience knobs",
  "lib/Flyway.svelte": "an invitation string",
  "lib/Gate.svelte": "a toy's answer",
  "lib/Guidance.svelte": "standing instructions, applied at spawn rather than sent",
  "lib/HuntBar.svelte": "a word to find in the transcript",
  "lib/Import.svelte": "a filter over recorded sessions",
  "lib/Kanban.svelte": "an Asana task's title",
  "lib/Keyring.svelte": "a credential",
  "lib/Servers.svelte": "a dev server's command",
  "lib/Sieve.svelte": "a filter over the sink",
  "lib/Spotify.svelte": "a search for music",
  "lib/Spyglass.svelte": "the finder's query",
  "lib/Themes.svelte": "a theme's name and values",
};

/** The inputs that do speak to an agent, each of which must mount the box. */
const AGENT_BOUND = ["lib/Dock.svelte", "lib/Ask.svelte", "lib/Notice.svelte"];

const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");

describe("every input that speaks to an agent can be handed a file", () => {
  test("a text field anywhere is a PromptBox, or says why its words reach no agent", () => {
    const offenders: string[] = [];
    for (const f of components(SRC)) {
      const src = readFileSync(f, "utf8");
      if (/<textarea\b|<input\b/.test(src) && !(rel(f) in NOT_AGENT_BOUND)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  test("each agent-bound surface mounts the box and holds no field of its own", () => {
    for (const f of AGENT_BOUND) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect({ f, mounts: /<PromptBox\b/.test(src) }).toEqual({ f, mounts: true });
      expect({ f, bare: /<textarea\b|<input\b/.test(src) }).toEqual({ f, bare: false });
    }
  });

  /* The list above names files, and a field can move out from under it — a
     stale entry is an exemption nobody is using, waiting for a new input to
     inherit it by name. A file that is not there at all is passed over, so an
     entry can be written ahead of the file it is for. */
  test("every exemption that names a file names one with a text field", () => {
    for (const f of Object.keys(NOT_AGENT_BOUND)) {
      let src: string;
      try {
        src = readFileSync(join(SRC, f), "utf8");
      } catch {
        continue;
      }
      expect({ f, has: /<textarea\b|<input\b/.test(src) }).toEqual({ f, has: true });
    }
  });

  /* No surface wires a drop or a paste of its own: the drop handler asks the
     DOM which box is under the point, and a box registers itself. Two ways a
     surface could slip back to the old shape, both refused. */
  test("App finds a drop's target by asking for a box, never by a surface's class", () => {
    const app = readFileSync(join(SRC, "App.svelte"), "utf8");
    expect(app).toContain("boxAt(");
    expect(app).not.toMatch(/closest\("\.dock"\)/);
    expect(app).not.toContain("field.shots.fromPaths");
    expect(app).not.toContain("field.shots.fromFiles");
  });
});
