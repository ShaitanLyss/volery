/* Whether the card kit (`src-tauri/kit/volery`, laid out by `kit.rs`) reaches a
 * card the way Volery passes it, and what it costs per request.
 *
 *     bun tools/probe-kit.ts            # initialize: is the skill listed, are the agents
 *     bun tools/probe-kit.ts invoke     # one Haiku turn: /volery:coordinate loads the body
 *     bun tools/probe-kit.ts cost       # two Haiku turns, without and with: input tokens
 *
 * Spawns with `--plugin-dir` pointed straight at the source folder, which is
 * byte for byte what `kit::lay` writes, plus an `--agents` of its own so the
 * merge with `supervisor::agents` is part of what is checked. Runs in its own
 * scratch git repo under `.scratch/probe-kit/`, which it owns.
 *
 * What it answered on claude 2.1.318, 2026-11-06:
 *
 *   initialize  commands: volery:coordinate "(volery) Coordinate a queue of work …"
 *               agents:   … scout, … volery:red-team, volery:verifier, web-fetch
 *   invoke      the skill's body was loaded (a canary in it came back)
 *   cost        61,126 input tokens without, 61,482 with: 356 a request,
 *               three repeats identical
 *
 * And that nothing under `~/.claude` was written: compare the mtimes of
 * `~/.claude/plugins/installed_plugins.json` and `~/.claude/settings.json`
 * before and after, which this prints.
 */

import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const KIT = resolve("src-tauri/kit/volery");
const CWD = resolve(".scratch/probe-kit");
mkdirSync(CWD, { recursive: true });
await Bun.$`git -C ${CWD} init -q`.quiet().nothrow();

const mode = Bun.argv[2] ?? "initialize";
const watched = [
  join(homedir(), ".claude", "plugins", "installed_plugins.json"),
  join(homedir(), ".claude", "settings.json"),
];
const mtimes = () => watched.map((p) => { try { return statSync(p).mtimeMs; } catch { return 0; } });
const before = mtimes();

function spawn(withKit: boolean) {
  const argv = [
    "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions", "--model", "haiku",
    "--agents", JSON.stringify({ scout: { description: "probe scout", prompt: "x", tools: ["Read"], model: "haiku" } }),
    ...(withKit ? ["--plugin-dir", KIT] : []),
    "--session-id", crypto.randomUUID(),
  ];
  return Bun.spawn(["claude", ...argv], { cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
}

async function events(proc: ReturnType<typeof spawn>, on: (e: any) => boolean) {
  const dec = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => { console.log("no answer after 120s"); proc.kill(); process.exit(1); }, 120_000);
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (on(e)) { clearTimeout(timer); proc.kill(); return; }
    }
  }
}

function say(proc: ReturnType<typeof spawn>, text: string) {
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  proc.stdin.flush();
}

if (mode === "initialize") {
  const p = spawn(true);
  p.stdin.write(JSON.stringify({ type: "control_request", request_id: "kit", request: { subtype: "initialize" } }) + "\n");
  p.stdin.flush();
  await events(p, (e) => {
    if (e.type !== "control_response") return false;
    const r = e.response.response;
    console.log("commands:", r.commands.filter((c: any) => c.name.startsWith("volery:")));
    console.log("agents:  ", r.agents.map((a: any) => a.name).join(", "));
    return true;
  });
} else if (mode === "invoke") {
  const p = spawn(true);
  say(p, "/volery:coordinate Reply with only the first heading of the method you were just given.");
  await events(p, (e) => {
    if (e.type === "assistant") for (const b of e.message.content) if (b.type === "text") console.log("said:", b.text);
    return e.type === "result";
  });
} else if (mode === "cost") {
  for (const withKit of [false, true]) {
    const p = spawn(withKit);
    say(p, "Reply with the single word ok.");
    await events(p, (e) => {
      if (e.type !== "result") return false;
      const u = e.usage;
      const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      console.log(withKit ? "with the kit:   " : "without the kit:", total, "input tokens");
      return true;
    });
  }
} else {
  console.log(`unknown mode ${mode}: initialize, invoke or cost`);
  process.exit(2);
}

const after = mtimes();
console.log(
  watched.map((p, i) => `${before[i] === after[i] ? "untouched" : "CHANGED"}  ${p}`).join("\n"),
);
