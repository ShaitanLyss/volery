/* What does a card cost to keep awake, and what does it cost to wake?
 *
 * The question behind `processes.md`'s "a card at rest" section: a card that
 * has been spoken to and gone quiet keeps a `claude` process for as long as the
 * wall is up. Whether it should go back to dormant on its own turns on two
 * numbers, and this measures both on this machine:
 *
 *   - what an idle process holds, and whether that grows with the session it
 *     resumed (a card at 80% context costing twice one at 10% would make the
 *     cards most worth sleeping the most expensive to wake);
 *   - what a wake costs in wall-clock: spawn → `system/init` → the answer,
 *     on `--resume` of a *long* transcript rather than a fresh one.
 *
 * It costs no tokens by default. The message sent is `/cost`, which the CLI
 * answers locally (`model: "<synthetic>"`, `duration_api_ms: 0`) — so the
 * timing is the process and the session load, and no model is asked anything.
 * That is the right split rather than a shortcut: a card asleep longer than the
 * prompt cache's TTL pays the same cold first request whether its process
 * stayed up or not, so the only thing sleeping *adds* is what this times.
 *
 *   bun tools/probe-sleep.ts                    # fresh + every resume arm, twice
 *   bun tools/probe-sleep.ts real               # + two real Haiku turns, cold then warm
 *
 * Transcripts are COPIED under a new session id into this probe's own project
 * directory, with the id rewritten inside, so `--resume` can never append to
 * a real card's history — the CLI finds a session by id beyond its cwd's
 * directory (`probe-migrate.ts`), and reusing the id would risk exactly that.
 * Owns `.scratch/sleep-probe/` and the matching `~/.claude/projects/<slug>/`,
 * and deletes only those.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CWD = join(REPO, ".scratch", "sleep-probe");
const CLAUDE = Bun.which("claude") ?? "claude";
const REAL = process.argv.includes("real");
/* Windows PowerShell rather than pwsh: the latter is a WindowsApps alias Git
   Bash's PATH does not carry, and 5.1 has everything used here. */
const PS = Bun.which("pwsh") ?? Bun.which("powershell") ?? "powershell";

/** Skein's shipped flags, verbatim (`spawn_now`). */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
];

/* A card's MCP shape: `browser` is an HTTP entry (here at a port nothing
   listens on, so the probe never becomes a session on the wall's real shared
   server), and whatever user-scope stdio servers this machine has still load —
   which is what a real project card gets, since only chat cards are strict. */
const CARD_MCP = ["--mcp-config", JSON.stringify({ mcpServers: { browser: { type: "http", url: "http://127.0.0.1:9/mcp" } } })];
const STRICT = ["--strict-mcp-config"];

const slug = (p: string) => Array.from(p, (ch) => (/[a-zA-Z0-9]/.test(ch) ? ch : "-")).join("");
const PROJECTS = join(homedir(), ".claude", "projects");
const OURS = join(PROJECTS, slug(CWD));
const SOURCE = join(PROJECTS, slug(REPO));

type Tree = { claudePriv: number; claudeWs: number; treePriv: number; procs: number; parts: string[] };

/** Private commit of the child and everything under it, by parent walk. */
function treeOf(pid: number): Tree {
  const ps = `
    $all=@{}; Get-CimInstance Win32_Process | % { $all[[int]$_.ProcessId]=$_ }
    $perf=@{}; Get-CimInstance Win32_PerfRawData_PerfProc_Process | % { $perf[[int]$_.IDProcess]=$_ }
    $kids=@{}; foreach($p in $all.Values){ $pp=[int]$p.ParentProcessId; if(-not $kids.ContainsKey($pp)){$kids[$pp]=@()}; $kids[$pp]+=$p }
    $root=${pid}; $stack=@($root); $tot=0; $n=0; $parts=@()
    while($stack.Count){ $x=$stack[0]; $stack=@($stack|Select-Object -Skip 1); $n++
      $mb=if($perf.ContainsKey($x)){[math]::Round($perf[$x].PrivateBytes/1MB,0)}else{0}; $tot+=$mb
      $parts+=('{0}:{1}' -f $all[$x].Name,$mb)
      foreach($k in @($kids[$x])){ if($k -and $k.CreationDate -ge $all[$x].CreationDate){ $stack+=[int]$k.ProcessId } } }
    $c=$perf[$root]
    @{ claudePriv=[math]::Round($c.PrivateBytes/1MB,0); claudeWs=[math]::Round($c.WorkingSetPrivate/1MB,0); treePriv=$tot; procs=$n; parts=$parts } | ConvertTo-Json -Compress`;
  try {
    return JSON.parse(execFileSync(PS, ["-NoProfile", "-Command", ps], { encoding: "utf8" }));
  } catch {
    return { claudePriv: 0, claudeWs: 0, treePriv: 0, procs: 0, parts: [] };
  }
}

const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

type Arm = {
  name: string;
  args: string[];
  /** what to say, in order; each waits for its `result` */
  say: string[];
  transcriptMb?: number;
  occupancy?: number;
  /** Where to run it, when not the probe's own directory. */
  cwd?: string;
  /** Skip the at-rest reading — the cache arms want the turn and nothing else. */
  quick?: boolean;
};

type Outcome = {
  arm: string;
  init?: number;
  firstEvent?: number[];
  results: number[];
  /** Per turn: what the request read from the prompt cache and what it wrote. */
  usage: { read: number; wrote: number; fresh: number }[];
  rest: Tree;
  err?: string;
};

async function run(arm: Arm): Promise<Outcome> {
  const t0 = performance.now();
  const proc = Bun.spawn([CLAUDE, ...ARGV, ...arm.args], { cwd: arm.cwd ?? CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out: Outcome = { arm: arm.name, results: [], usage: [], firstEvent: [], rest: { claudePriv: 0, claudeWs: 0, treePriv: 0, procs: 0, parts: [] } };
  let errText = "";
  (async () => { errText = await new Response(proc.stderr).text(); })();

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let turn = 0;
  let sentAt = performance.now();
  let sawEvent = false;
  const send = (text: string) => { sentAt = performance.now(); sawEvent = false; proc.stdin.write(userLine(text)); proc.stdin.flush(); };
  send(arm.say[0]);

  const deadline = performance.now() + 180_000;
  while (turn < arm.say.length && performance.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 180_000)),
    ]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      const at = Math.round(performance.now() - (turn === 0 ? t0 : sentAt));
      if (ev.type === "system" && ev.subtype === "init" && out.init === undefined) out.init = at;
      if (ev.type === "stream_event" && !sawEvent) { sawEvent = true; out.firstEvent!.push(at); }
      if (ev.type === "result") {
        out.results.push(at);
        const u = ev.usage ?? {};
        out.usage.push({ read: u.cache_read_input_tokens ?? 0, wrote: u.cache_creation_input_tokens ?? 0, fresh: u.input_tokens ?? 0 });
        turn++;
        if (turn < arm.say.length) {
          /* Let the first turn's tail settle so the second is a warm process
             answering, not one still writing its transcript. */
          await Bun.sleep(3000);
          send(arm.say[turn]);
        }
      }
    }
  }
  /* At rest: give the MCP servers and the GC a moment, then read the tree. */
  if (!arm.quick) {
    await Bun.sleep(8000);
    out.rest = treeOf(proc.pid);
  }
  if (turn < arm.say.length) out.err = errText.trim().split("\n").slice(-2).join(" | ") || "timed out";
  proc.kill();
  await proc.exited;
  return out;
}

/** Copy a real transcript under a fresh id, rewriting the id inside it. */
function borrow(file: string): { id: string; mb: number; occupancy: number } {
  const oldId = file.replace(/\.jsonl$/, "");
  const id = crypto.randomUUID();
  const text = readFileSync(join(SOURCE, file), "utf8").split(oldId).join(id);
  writeFileSync(join(OURS, `${id}.jsonl`), text);
  let occupancy = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const r = JSON.parse(line);
      const u = r?.message?.usage;
      if (r.type === "assistant" && u) {
        const o = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (o > 0) occupancy = o;
      }
    } catch { /* a line cut short */ }
  }
  return { id, mb: statSync(join(SOURCE, file)).size / 1048576, occupancy };
}

/** One transcript nearest each target size, from sessions not on the wall now. */
function pickTranscripts(targetsMb: number[], avoid: Set<string>): string[] {
  const all = readdirSync(SOURCE)
    .filter((f) => f.endsWith(".jsonl") && !avoid.has(f.slice(0, 8)))
    .map((f) => ({ f, mb: statSync(join(SOURCE, f)).size / 1048576 }));
  return targetsMb.map((t) => all.reduce((a, b) => (Math.abs(b.mb - t) < Math.abs(a.mb - t) ? b : a)).f);
}

mkdirSync(CWD, { recursive: true });
mkdirSync(OURS, { recursive: true });

/* ── cache: does a wake cost the prompt cache? ─────────────────────────────
 *
 * The CLI writes its prompt cache with a one-hour TTL and nothing else (every
 * `cache_creation` on this machine is `ephemeral_1h_input_tokens`). So a card
 * idle past an hour pays a cold first request whether its process lived or
 * not, and sleeping it costs nothing in tokens. Inside the hour the question
 * is whether a *resumed* process sends the same prefix the live one would have
 * — if it does, a wake inside the hour is still warm; if anything in it is
 * recomputed at spawn (the git status the CLI puts in front of the
 * conversation is the obvious suspect), every early wake rewrites the whole
 * context at cache-write prices.
 *
 * Three arms, two real Haiku turns each, in a throwaway git repo of the probe's
 * own so its status can be changed without touching the shared tree:
 *   warm         both turns in one process — the baseline
 *   wake         turn, kill, --resume, turn
 *   wake+status  turn, kill, a file changes in the repo, --resume, turn */
if (process.argv.includes("cache")) {
  const repo = join(CWD, "repo");
  const repoDir = join(PROJECTS, slug(repo));
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=probe@local", "-c", "user.name=probe", "commit", "-qm", "one");
  const model = ["--model", "haiku"];
  /* The first message of each session is unique and long, and that is the
     whole design of the arm. With a short one shared by every session, the
     system prompt and that message are cached by whichever session ran first,
     so "the resumed request read N from cache" proves nothing about the
     resumed *conversation*. A nonce and ~8k tokens of its own mean the only
     cache entry that can serve this message is the one its own session wrote. */
  const filler = Array.from({ length: 900 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog.`).join("\n");
  const first = (s: string) => `${crypto.randomUUID()}\n${filler}\nignore the lines above. reply with the single word: ${s}`;
  const say = (s: string) => `reply with the single word: ${s}`;
  const turn = (name: string, args: string[], words: string[]) =>
    run({ name, args: [...CARD_MCP, ...model, ...args], say: words, cwd: repo, quick: true });
  const show = (label: string, o: Outcome) =>
    console.log(
      `${label.padEnd(30)} ` +
        o.usage.map((u, i) => `turn ${i + 1}: read ${u.read}, wrote ${u.wrote}, fresh ${u.fresh}`).join("  |  ") +
        (o.err ? `  !! ${o.err}` : ""),
    );
  try {
    show("warm (one process)", await turn("warm", ["--session-id", crypto.randomUUID()], [first("ok"), say("again")]));

    const s1 = crypto.randomUUID();
    show("wake: before", await turn("wake 1", ["--session-id", s1], [first("ok")]));
    show("wake: after --resume", await turn("wake 2", ["--resume", s1], [say("again")]));

    const s2 = crypto.randomUUID();
    show("wake+status: before", await turn("ws 1", ["--session-id", s2], [first("ok")]));
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    show("wake+status: after --resume", await turn("ws 2", ["--resume", s2], [say("again")]));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(OURS, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
  }
  process.exit(0);
}

/* ── timers: what a card's own schedules look like on the wire ─────────────
 *
 * `CronCreate` says of itself "Jobs live only in this Claude session — nothing
 * is written to disk, and the job is gone when Claude exits", and
 * `ScheduleWakeup` is the same kind of thing for `/loop`. So a card holding one
 * loses it when its process is stood down, exactly as a card holding a
 * `wake_me` would — and nothing on the wall knew about either. This arm asks a
 * Haiku card to arm each, then watches the stream until it fires, printing every
 * event that is not a token delta: the tool's receipt (what the fold has to
 * read) and the shape the firing arrives in (whether anything says it fired). */
if (process.argv.includes("timers")) {
  const proc = Bun.spawn(
    [CLAUDE, ...ARGV, ...CARD_MCP, "--model", "haiku", "--session-id", crypto.randomUUID()],
    { cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const t0 = performance.now();
  const at = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  const soon = new Date(Date.now() + 2 * 60_000);
  const ask =
    `It is now ${new Date().toLocaleString()}. Do exactly two things, then reply "done". ` +
    `1) Call CronCreate with cron "${soon.getMinutes()} ${soon.getHours()} ${soon.getDate()} ${soon.getMonth() + 1} *", ` +
    `recurring false, prompt "reply with the single word: cronfired". ` +
    `2) Call ScheduleWakeup with delaySeconds 90, prompt "reply with the single word: wakefired", reason "probe", noop false.`;
  proc.stdin.write(userLine(ask));
  proc.stdin.flush();
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const end = performance.now() + 5 * 60_000;
  const fired = new Set<string>();
  try {
    while (performance.now() < end && fired.size < 2) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), end - performance.now())),
      ]);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { console.log(at(), "(not json)", line.slice(0, 160)); continue; }
        if (ev.type === "stream_event") continue;
        const blocks = ev.message?.content;
        const text = typeof blocks === "string" ? blocks : Array.isArray(blocks)
          ? blocks.map((b: any) => b.type === "text" ? b.text : b.type === "tool_use" ? `tool_use ${b.name} ${JSON.stringify(b.input)}` : b.type === "tool_result" ? `tool_result ${JSON.stringify(b.content).slice(0, 400)}` : b.type).join(" ¦ ")
          : "";
        const sub = ev.subtype ? `/${ev.subtype}` : "";
        const flags = [ev.isReplay && "replay", ev.isSynthetic && "synthetic", ev.parent_tool_use_id && "sub"].filter(Boolean).join(",");
        console.log(at(), `${ev.type}${sub}${flags ? ` [${flags}]` : ""}`, (text || JSON.stringify(ev).slice(0, 300)).slice(0, 500));
        /* Off the agent's prose only — the words are also in the tool calls'
           own arguments, and matching those ends the watch before anything
           has fired. */
        const said = Array.isArray(blocks) ? blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
        if (ev.type === "assistant" && /cronfired/.test(said)) fired.add("cron");
        if (ev.type === "assistant" && /wakefired/.test(said)) fired.add("wake");
      }
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(OURS, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
  }
  console.log("fired:", [...fired].join(", ") || "nothing");
  process.exit(0);
}

/* Live cards' sessions are read off the process table so the probe never
   borrows a transcript somebody is appending to as it reads. */
const live = new Set<string>(
  execFileSync(PS, ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | % { if ($_.CommandLine -match '--(resume|session-id) ([0-9a-f]{8})') { $Matches[2] } }"],
    { encoding: "utf8" }).split(/\s+/).filter(Boolean),
);

const picks = pickTranscripts([1, 3, 7, 15], live);
const arms: Arm[] = [
  { name: "fresh, no MCP", args: [...STRICT, "--session-id", crypto.randomUUID()], say: ["/cost"] },
  { name: "fresh, card MCP", args: [...CARD_MCP, "--session-id", crypto.randomUUID()], say: ["/cost"] },
];
for (const f of picks) {
  const b = borrow(f);
  arms.push({
    name: `resume ${b.mb.toFixed(1)} MB / ${Math.round(b.occupancy / 1000)}k`,
    args: [...CARD_MCP, "--resume", b.id],
    say: ["/cost"],
    transcriptMb: b.mb,
    occupancy: b.occupancy,
  });
}
if (REAL) {
  arms.push({
    name: "real turn, cold then warm (haiku)",
    args: [...CARD_MCP, "--model", "haiku", "--session-id", crypto.randomUUID()],
    say: ["reply with the single word: ok", "reply with the single word: again"],
  });
}

const rows: Outcome[] = [];
try {
  for (const pass of [1, 2]) {
    for (const arm of arms) {
      /* A resumed arm's second pass must not resume what the first appended,
         or it measures a different file — re-borrow under a new id. */
      const a = pass === 2 && arm.args.includes("--resume")
        ? { ...arm, args: arm.args.map((x, i, xs) => (xs[i - 1] === "--resume" ? borrowAgain(arm) : x)) }
        : pass === 2 && arm.args.includes("--session-id")
          ? { ...arm, args: arm.args.map((x, i, xs) => (xs[i - 1] === "--session-id" ? crypto.randomUUID() : x)) }
          : arm;
      if (pass === 2 && arm.name.startsWith("real")) continue;
      const o = await run(a);
      rows.push(o);
      const ev = o.firstEvent?.length ? ` first token ${o.firstEvent.map((x) => x + "ms").join(" / ")}` : "";
      console.log(
        `pass ${pass}  ${a.name.padEnd(36)} init ${String(o.init ?? "-").padStart(6)}ms  result ${o.results.map((x) => x + "ms").join(" / ").padStart(8)}${ev}` +
          `  | claude ${o.rest.claudePriv} MB priv, ${o.rest.claudeWs} MB ws; tree ${o.rest.treePriv} MB in ${o.rest.procs}` +
          (o.err ? `  !! ${o.err}` : ""),
      );
      if (pass === 1) console.log(`         parts: ${o.rest.parts.join(" ")}`);
    }
  }
} finally {
  rmSync(OURS, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
}

function borrowAgain(arm: Arm): string {
  const f = picks[arms.indexOf(arm) - 2];
  return borrow(f).id;
}
