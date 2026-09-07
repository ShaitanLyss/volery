/* What does the CLI say about its own vocabulary, and when does it say it?
 *
 * The dock's palette offers Volery's own commands and then everything the
 * *agent* answers to — the built-ins, a project's `.claude/commands/`, every
 * skill from every plugin. None of that is something this window could work out:
 * it depends on the directory, on which plugins are installed and scoped to it,
 * and on the build of Claude Code behind it. This probe is what settled where to
 * ask, after two designs that reconstructed the answer instead.
 *
 *   bun tools/probe-skills.ts initialize   # the whole vocabulary, with descriptions
 *   bun tools/probe-skills.ts              # what a `system/init` publishes
 *   bun tools/probe-skills.ts silent       # whether an init arrives with no prompt
 *   bun tools/probe-skills.ts seeded       # either of the first two, with three
 *                                          # `.claude/commands/` files in place
 *
 * `seeded` composes: `bun tools/probe-skills.ts initialize seeded`. Costs
 * nothing either way — `initialize` is answered locally, and the `/model opus`
 * the init arm sends is a command the CLI answers itself (`num_turns: 0`, no
 * cost, no model asked anything).
 *
 * ── the answer: ask, on the control route ──────────────────────────────────
 *
 * `control_request { subtype: "initialize" }` on stdin, 2026-09-07, claude
 * 2.1.233, before any prompt:
 *
 *   1.22s  57 commands   stdin left open, trusted directory
 *   1.32s  57 commands   stdin closed straight after the write
 *   1.24s  57 commands   a fresh directory nobody has ever trusted, no flags
 *
 * The reply's `commands` array carries `{ name, description, argumentHint,
 * aliases }` for every one of them, and the envelope also holds `agents`,
 * `models`, `output_style`, `account` and the current permission mode.
 *
 *   {"name":"bare","description":"No frontmatter at all. (project)","argumentHint":""}
 *   {"name":"deep:nested","description":"a command in a subdirectory (project)","argumentHint":"branch"}
 *   {"name":"code-review","description":"Review the current diff.","argumentHint":"[low|medium|high]","aliases":["review"]}
 *   {"name":"tx-toolkit:committee","description":"(tx-toolkit) Convene a panel.","aliases":["committee"]}
 *
 * Four things fall out, and each of them killed something:
 *
 * - **Descriptions for everything**, the CLI's own built-ins included — which
 *   live inside a 320MB binary and are on disk nowhere. A palette that walked
 *   directories could only ever say where a row *came from*.
 * - **Provenance is tagged into the description** (`(project)`, `(tx-toolkit)`,
 *   `(dynamic workflow)`), so it needs no deriving from the shape of a name.
 * - **`.claude/commands/` is already in there**, `deep/nested.md` reported as
 *   `deep:nested` with its `argument-hint:` as `argumentHint` and a
 *   frontmatter-less file given a description off its first line. `slash.rs` used
 *   to walk and parse that itself, worse, in 400 lines.
 * - **It needs no turn and no storing.** 1.2 seconds, before the first prompt.
 *   The skills list was briefly a schema column (v31) because `system/init` only
 *   arrives after a card's first message; a request this cheap needs no column,
 *   and the rung was reverted.
 *
 * What the reply does **not** carry is which names are skills, and the palette
 * needs that — a skill is invoked by the model out of the prose and so may sit
 * anywhere in a line, where everything else is parsed by the CLI at the head of
 * a prompt. That is what the `init` arm below is still for.
 *
 * ── `system/init`, which is where the skill label lives ────────────────────
 *
 * Carries about two dozen keys, and the *set* moves between builds — 23 on
 * 2026-09-06 and 25 an hour later, once `messaging_socket_path` and
 * `powershell_path` appeared — so nothing here counts them. Three are catalogues
 * of what the agent answers to by name:
 *
 *   slash_commands (60)  every name, project commands first, then the skills,
 *                        then the built-ins. Names only.
 *   skills         (23)  the skills alone, a contiguous run inside the above.
 *                        **The only authoritative label of which is which.**
 *   agents          (8)  subagent types, a different vocabulary again
 *
 * `bun tools/probe-skills.ts silent` spawns with the same argv and sends
 * *nothing*: fifteen seconds later there is still no init. The CLI emits one only
 * after the first message lands, which is the same thing `CLAUDE.md` records
 * about a freshly spawned card not being dormant — and the reason
 * `paletteExtras` degrades toward offering *more* until one arrives.
 */

const CWD = new URL("../.scratch/probe-skills", import.meta.url).pathname.slice(1);
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
];

/** How long the silent run waits before concluding that nothing is coming. */
const SILENT_WAIT_MS = 15_000;

/** How long the `initialize` run waits. It answers in about 1.2s; `slash.rs`
 *  allows twenty seconds for a cold start and this matches it. */
const ASK_WAIT_MS = 20_000;

const modes = new Set(Bun.argv.slice(2));
const silent = modes.has("silent");
const asking = modes.has("initialize");
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

await Bun.$`mkdir -p ${CWD}`.quiet();

/* The three shapes `slash.rs`'s tests are written against, written into the
   probe's own scratch project so the project-command half can be repeated rather
   than only read. Removed again at the end of the run: not the default, because
   the other interesting question — what a project with none of its own publishes
   — is what every ordinary run answers. */
if (modes.has("seeded")) {
  const commands = `${CWD}/.claude/commands`;
  await Bun.$`mkdir -p ${commands}/deep`.quiet();
  await Bun.write(
    `${commands}/hello.md`,
    "---\ndescription: say hello in the project's voice\n---\nSay hello.\n",
  );
  await Bun.write(`${commands}/bare.md`, "No frontmatter at all, just a body.\n");
  await Bun.write(
    `${commands}/deep/nested.md`,
    "---\ndescription: a command in a subdirectory\nargument-hint: [branch]\n---\nGo.\n",
  );
  console.log(at(), "seeded bare.md, hello.md and deep/nested.md");
  /* Only its own subdirectory, which is the whole of what this probe owns —
     `.scratch/` is shared by every card on this wall. */
  process.on("exit", () => {
    try {
      require("node:fs").rmSync(`${CWD}/.claude`, { recursive: true, force: true });
    } catch {
      /* leaving three markdown files behind is not worth a failing probe */
    }
  });
}

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

if (asking) {
  /* The control route, before any prompt at all — which is the whole point. */
  console.log(at(), "→ control_request initialize");
  proc.stdin.write(
    JSON.stringify({
      type: "control_request",
      request_id: "probe-initialize",
      request: { subtype: "initialize" },
    }) + "\n",
  );
  proc.stdin.flush();
  /* And EOF, to show the answer still arrives — this is what `slash.rs` does,
     so that anything which ever wanted to ask a question reads the end of its
     input instead of parking on a prompt nobody can see. */
  await proc.stdin.end();
  setTimeout(() => {
    console.log(at(), `no answer after ${ASK_WAIT_MS / 1000}s`);
    proc.kill();
    process.exit(1);
  }, ASK_WAIT_MS);
} else if (silent) {
  console.log(at(), "sending nothing at all");
  setTimeout(() => {
    console.log(at(), `no system/init after ${SILENT_WAIT_MS / 1000}s`);
    proc.kill();
    process.exit(0);
  }, SILENT_WAIT_MS);
} else {
  /* A command the CLI answers itself: it opens the process and costs no turn,
     and the init still comes first. */
  const say = "/model opus";
  console.log(at(), "→", say);
  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: say }] },
    }) + "\n",
  );
  proc.stdin.flush();
}

const dec = new TextDecoder();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk);
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    if (asking) {
      if (ev?.type !== "control_response") continue;
      const r = ev.response?.response ?? {};
      console.log(at(), "control_response —", ev.response?.subtype);
      console.log("  envelope keys:", Object.keys(r).join(", "));
      const cmds: any[] = r.commands ?? [];
      console.log(`  commands (${cmds.length}), and the fields each one carries:`);
      console.log(
        "   ",
        [...new Set(cmds.flatMap((c) => Object.keys(c)))].join(", ") || "(none)",
      );
      let described = 0;
      for (const c of cmds) {
        if ((c.description ?? "").trim()) described += 1;
        const extra = [
          c.argumentHint ? `hint=${JSON.stringify(c.argumentHint)}` : "",
          c.aliases?.length ? `aliases=${JSON.stringify(c.aliases)}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.log("   ", String(c.name).padEnd(34), extra);
        const said = (c.description ?? "").trim();
        if (said) console.log("     ", said.slice(0, 150));
      }
      /* The claim the palette rests on, checked rather than assumed: every row
         says what it does, including the built-ins that are on no disk. */
      console.log(`  described: ${described} of ${cmds.length}`);
      proc.kill();
      process.exit(0);
    }

    if (ev?.type !== "system" || ev.subtype !== "init") {
      console.log(at(), ev?.type, ev?.subtype ?? "");
      continue;
    }
    console.log(at(), "system/init —", Object.keys(ev).length, "keys");
    console.log("  keys:", Object.keys(ev).join(", "));
    for (const k of ["skills", "slash_commands", "agents", "plugins"]) {
      const v = ev[k];
      if (!Array.isArray(v)) {
        console.log(`  ${k}: (absent)`);
        continue;
      }
      console.log(`  ${k} (${v.length}):`);
      for (const one of v) console.log("    ", JSON.stringify(one));
    }
    /* The question this arm is still here to answer: the label, and the fact
       that it is only ever a name. */
    const odd = (ev.skills ?? []).filter((s: unknown) => typeof s !== "string");
    console.log(
      "  skills carrying anything but a name:",
      odd.length ? JSON.stringify(odd) : "none",
    );
    proc.kill();
    process.exit(0);
  }
}
