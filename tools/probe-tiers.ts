/* Can one MCP server hold two tiers of tool — some always loaded, the rest
 * behind `ToolSearch` — and what does the tiering cost?
 *
 * `ask::mcp_config` sets `alwaysLoad` on the *server*, which is all-or-nothing:
 * every tool skein advertises is in the prompt of every card on every turn, and
 * `the_roster_stays_inside_what_alwaysLoad_costs` is nearly out of room. The
 * question this answers is whether the CLI will let a single server say
 * "these six always, the rest on request", and what comes off with the
 * server-level flag when it does.
 *
 * Read out of the 2.1.241 binary before writing it, which is what the arms are
 * shaped to check:
 *
 *   alwaysLoad: e.config.alwaysLoad===!0 || M._meta?.["anthropic/alwaysLoad"]===!0
 *   function lhe(e){ if(e.alwaysLoad===!0) return !1; ... if(e.isMcp===!0) return !0; ... }
 *   function iFa(e){ return e.name }                       // formatDeferredToolLine
 *   let c=Vk(t,(f)=>f.alwaysLoad===!0), u=Vk(t,(f)=>f.alwaysLoad!==!0)   // connect split
 *
 * So the claims to test are: (1) a per-tool `_meta` flag loads that tool and
 * only it; (2) a tool without it is reachable but deferred; (3) the deferred
 * line is *only* the name, so a deferred tool costs ~25 bytes a turn rather
 * than its schema; (4) the blocking connect is keyed on the **server** flag, so
 * taking that flag off to allow tiering also gives up the guarantee that the
 * tools are present when the turn-1 prompt is built.
 *
 *   bun tools/probe-tiers.ts               # per-tool _meta, no server flag
 *   bun tools/probe-tiers.ts --server-flag # today's shape, for the contrast
 *   bun tools/probe-tiers.ts --no-meta     # neither flag: everything deferred
 *   bun tools/probe-tiers.ts --slow 4000   # stall tools/list, to time the connect
 *   bun tools/probe-tiers.ts --slow 4000 --server-flag   # ...and whether the flag waits
 *
 * (4) is the one worth the money. Costs one real turn per run — there is no
 * `--help`, so a stray flag spawns one.
 *
 * ── what it returned, against 2.1.241 on 2026-08-27 ──────────────────────
 *
 * (1) and (2) hold. With no server-level flag and `_meta` on two of four tools,
 * the two arrived with full schemas and the other two as bare names. So a
 * single server can hold two tiers, and the tier is a property of the tool.
 *
 * (3) holds, verbatim — the listing is one bare name per line, no description,
 * no parameters. A deferred tool costs its prefixed name and a newline, ~25
 * bytes, against a roster average of ~1750.
 *
 * (4) **does not reproduce, which is the finding that mattered.** Stalling
 * `tools/list` for 6s and then 25s — 5x the 5s connect cap — left `board`'s
 * full schema in the turn-1 prompt every time, with the server-level flag off.
 * `MCP_CONNECTION_NONBLOCKING=0` (the `--blocking` arm) changed nothing
 * observable, so it is *not* needed to keep the guarantee and is not shipped.
 * What the server flag buys is a bounded wait skein was never using: its
 * listener is on loopback and `Asks::port` has already answered for it.
 *
 * Two things found on the way, neither of them what the probe was for:
 *
 *   - **`anthropic/searchHint` decides whether a deferred tool is findable at
 *     all**, and it is free — not rendered into the listing, only indexed.
 *     Controlled with `--search-only` against `--search-only --no-hint`, one
 *     query, everything else identical: with the hint, `carrier_pigeon` ranked
 *     **first**; without it, it did not make the top five at all. So a tool
 *     moved to the discoverable tier wants a hint, or it is not discoverable.
 *   - **A deferred MCP tool called directly still runs.** Three arms called one
 *     with no prior `ToolSearch` and got a normal result, not the
 *     `InputValidationError` the CLI's own notice promises. Probed with empty
 *     arguments only, so it may be validation passing vacuously rather than
 *     absent. Do not lean on it: an agent calling blind does not know what the
 *     arguments mean, which is the real cost of deferring a tool.
 */

const CWD = process.cwd();
const CLAUDE = Bun.which("claude") ?? "claude";

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
  /* `mcp_config` is passed with this, so a probe without it is probing a card
     that can also see whatever is in the user's own settings. */
  "--strict-mcp-config",
];

const FLAGS = Bun.argv.slice(2);
/** Today's shape: one flag on the server, exempting every tool on it. */
const SERVER_FLAG = FLAGS.includes("--server-flag");
/** Withhold the per-tool `_meta` too, so nothing on the server is exempt. */
const NO_META = FLAGS.includes("--no-meta");
/** Stall `tools/list` by this many ms. The whole of arm (4): a loopback
 *  listener answers instantly, so the race the server flag protects against
 *  cannot be observed without making the server slow on purpose. */
const SLOW = Number(FLAGS[FLAGS.indexOf("--slow") + 1] ?? 0) || 0;
/** `MCP_CONNECTION_NONBLOCKING=0`, the candidate replacement for what the
 *  server-level flag was buying. Read out of the 2.1.241 binary:
 *
 *    let a=!Wp(process.env.MCP_CONNECTION_NONBLOCKING); ... L_u(a,()=>n$s(u,"regular",…))
 *    function L_u(e,t,r){ if(e){ …"running fully async (nonblocking)"; return } …await… }
 *    function Wp(e){ if(e===void 0)return!1; … return ["0","false","no","off"].includes(t) }
 *
 *  So `Wp` is "explicitly disabled", the variable defaults to nonblocking, and
 *  `=0` is what turns the awaited connect back on for a server that is no
 *  longer in the alwaysLoad bucket. The name reads backwards; the value does not. */
const BLOCKING = FLAGS.includes("--blocking");
/** Withhold `anthropic/searchHint` from the tool that carries it. The control
 *  for the hint arm: same query, same two deferred tools, same descriptions —
 *  the hint is then the only thing that differs between the runs, which is what
 *  "the hint is what matched" needs in order to be a finding rather than a
 *  guess about one ranking. */
const NO_HINT = FLAGS.includes("--no-hint");
/** Ask only for the ToolSearch step. A whole report costs a long turn and the
 *  ranking is a `tool_result` this script reads directly, so the hint arms do
 *  not need the model to describe anything. */
const SEARCH_ONLY = FLAGS.includes("--search-only");

const CONV = crypto.randomUUID();
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

/** Every rpc the child made, with when — the connect timing is read off this. */
const seen: Array<{ t: number; method: string }> = [];
/** Which tools were actually invoked, so a claim in prose can be checked. */
const called: string[] = [];

/* ── the roster: one tool per tier, plus one to answer with ─────────────── */

/** A description long enough that its presence or absence in the prompt is a
 *  real cost — skein's average is ~1750 bytes and this is the same order. */
const filler = (what: string) =>
  `${what} This description exists to be expensive. ` +
  "It carries the reasoning a schema is the right place for: why the tool is " +
  "worth reaching for, what it costs the caller, which argument matters and " +
  "what happens when it is left out. Roughly the weight of a real one on the " +
  "skein server, so that whether it reaches the model is a question with a " +
  "number attached rather than a matter of taste. ".repeat(6);

const hot = (name: string, always: boolean) => ({
  name,
  description: filler(`Tool ${name}, in the tier that is always loaded.`),
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
  ...(always && !NO_META ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
});

const cold = (name: string, hint?: string) => ({
  name,
  description: filler(`Tool ${name}, in the tier that is meant to be deferred.`),
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
  ...(hint ? { _meta: { "anthropic/searchHint": hint } } : {}),
});

const TOOLS = [
  /* The one the model is told to call first. Always-loaded in every arm that
     has a per-tool flag at all, since a probe whose reporting tool is itself
     deferred cannot distinguish "deferred" from "broken". */
  hot("report", true),
  hot("board", true),
  cold("pinned"),
  /* Same tier as `pinned`, but carrying `anthropic/searchHint`. If the hint is
     free — not rendered into the deferred listing, only indexed — it is the
     cheap half of tiering: findable without being paid for. */
  cold(
    "carrier_pigeon",
    NO_HINT ? undefined : "attach an image to the wall beside this card; pin repin unpin",
  ),
];

/* ── the server, mirroring ask.rs ───────────────────────────────────────── */

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const rpc = await req.json().catch(() => null);
    if (!rpc) return new Response(null, { status: 400 });

    const method = rpc.method ?? "";
    seen.push({ t: Date.now() - t0, method });
    const hasId = rpc.id !== undefined;
    console.log(at(), `rpc ← ${method}${hasId ? ` (id ${rpc.id})` : " (notification)"}`);
    if (!hasId) return new Response(null, { status: 202 });

    const json = (body: unknown) => Response.json(body);

    switch (method) {
      case "initialize":
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "skein-probe", version: "0.0.0" },
          },
        });

      case "tools/list": {
        if (SLOW) {
          console.log(at(), `        stalling tools/list for ${SLOW}ms`);
          await Bun.sleep(SLOW);
          console.log(at(), "        ...answering tools/list now");
        }
        const bytes = JSON.stringify(TOOLS).length;
        console.log(at(), `        roster: ${TOOLS.length} tools, ${bytes} bytes`);
        return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: TOOLS } });
      }

      case "ping":
        return json({ jsonrpc: "2.0", id: rpc.id, result: {} });

      case "tools/call": {
        const name = rpc.params?.name ?? "?";
        called.push(name);
        console.log(at(), `!! ${name} was actually called`);
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: `${name} ran. Carry on.` }] },
        });
      }

      default:
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `no method ${method}` },
        });
    }
  },
});

const url = `http://127.0.0.1:${server.port}/mcp/${CONV}`;
console.log(at(), `endpoint: ${url}`);
console.log(
  at(),
  `arm: server flag ${SERVER_FLAG ? "SET" : "unset"} · per-tool _meta ` +
    `${NO_META ? "withheld" : "on report+board"} · tools/list stall ${SLOW}ms · ` +
    `MCP_CONNECTION_NONBLOCKING ${BLOCKING ? "=0 (blocking)" : "unset"}`,
);

const proc = Bun.spawn(
  [
    CLAUDE,
    ...ARGV,
    "--session-id", CONV,
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        skein: { type: "http", url, ...(SERVER_FLAG ? { alwaysLoad: true } : {}) },
      },
    }),
  ],
  {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: BLOCKING ? { ...process.env, MCP_CONNECTION_NONBLOCKING: "0" } : process.env,
  },
);

const write = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n") && proc.stdin.flush();

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s.slice(0, 400));
  }
})();

/* The three questions, in the order that keeps them independent: call the
   always-loaded one (proves the tier arrived), call a deferred one blind
   (proves it did not, and shows what the failure reads as), then report the
   system-reminder verbatim (shows what a deferred tool costs per turn). */
write({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: SEARCH_ONLY
          ? "Run the ToolSearch tool exactly once, with the query " +
            "`attach image to wall` and max_results 5. Then reply with only the " +
            "tool names it returned, in order, one per line. Do nothing else."
          : "This is a probe of tool loading. Do exactly these four things in order " +
          "and do not use any other tool.\n" +
          "1. Call `mcp__skein__board` with {} .\n" +
          "2. Call `mcp__skein__pinned` with {} DIRECTLY. Do not call ToolSearch " +
          "first — I need to see whether the direct call works or fails, so " +
          "attempt it even if you believe it will fail, and report the exact error.\n" +
          "3. Run ToolSearch with the query `attach image to wall` and say which " +
          "tool names it returned, in order.\n" +
          "4. Reply with a report containing: (a) which of board/pinned/" +
          "carrier_pigeon you could see full schemas for at the start of this " +
          "turn, (b) the VERBATIM text of any system-reminder listing deferred " +
          "tools, including whether each line was just a name or a name plus a " +
          "description, and (c) the exact error text from step 2 if it failed.",
      },
    ],
  },
});

const deadline = setTimeout(() => proc.kill(), 180_000);

const dec = new TextDecoder();
let buf = "";
let text = "";

for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(l);
    } catch {
      console.log(at(), "← unparseable:", l.slice(0, 300));
      continue;
    }
    if (ev.type === "stream_event") continue;
    if (ev.type === "user" || ev.type === "assistant" || ev.type === "system") {
      // no-op: handled below
    } else if (ev.type !== "result") {
      console.log(at(), `← ${ev.type ?? "?"}`);
    }

    /* `system/init` lists what the session came up with, which is the
       deterministic half of arm (4): under a stalled server, does skein's
       roster appear here at all? */
    if (ev.type === "system" && ev.subtype === "init") {
      const tools: string[] = ev.tools ?? [];
      const mine = tools.filter((t) => t.startsWith("mcp__skein__"));
      console.log(at(), `system/init lists ${tools.length} tools`);
      console.log(at(), `  skein tools in init: ${mine.length ? mine.join(", ") : "NONE"}`);
      continue;
    }

    const blocks = ev.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === "tool_use") console.log(at(), `← tool_use ${b.name}`);
        if (b.type === "tool_result") {
          const s = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          console.log(at(), `← tool_result${b.is_error ? " (ERROR)" : ""}: ${s.slice(0, 500)}`);
        }
        if (b.type === "text" && ev.type === "assistant") text += b.text;
      }
    }

    if (ev.type === "result") {
      console.log(at(), `result: ${ev.subtype}`);
      break;
    }
  }
}

clearTimeout(deadline);
console.log(at(), `child stdout closed; exit code ${await proc.exited}`);
proc.kill();
server.stop(true);

console.log("\n──────── what the model reported ────────\n");
console.log(text.trim());
console.log("\n──────── what the server saw ────────");
for (const s of seen) console.log(`  ${(s.t / 1000).toFixed(2)}s  ${s.method}`);
console.log(`  tools actually called: ${called.length ? called.join(", ") : "none"}`);
