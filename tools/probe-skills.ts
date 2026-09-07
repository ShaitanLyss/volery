/* What does the CLI say about its own skills, and when does it say it?
 *
 * The dock's palette offers skills beside Volery's own commands, and which
 * skills a card has is not something this window could work out for itself: it
 * depends on the directory, on which plugins are installed and which of those
 * are scoped to that project, and on the build of Claude Code behind it. This
 * probe is what settled that it does not have to.
 *
 *   bun tools/probe-skills.ts          # what `system/init` publishes
 *   bun tools/probe-skills.ts silent   # whether an init arrives with no prompt
 *   bun tools/probe-skills.ts seeded   # the same, with three `.claude/commands/`
 *                                      # files in place, which is how the
 *                                      # project-command half below was measured
 *
 * Costs nothing. The prompt it sends is `/model opus`, which the CLI answers
 * itself — `num_turns: 0`, no cost, no model asked anything — and an init
 * arrives ahead of it like it does ahead of any prompt.
 *
 * ── what it answered, 2026-09-06, claude 2.1.233, Skein's exact argv ────────
 *
 * `system/init` carries about two dozen keys and the *set* moves between builds
 * — 23 on 2026-09-06 and 25 an hour later, once `messaging_socket_path` and
 * `powershell_path` appeared — so nothing here counts them. Three of them are
 * catalogues of what the agent can be asked for by name:
 *
 *   slash_commands (52)  every name a prompt beginning with `/` might mean —
 *                        anything in `.claude/commands/`, then the skills, then
 *                        the built-ins, all in one list
 *   skills         (22)  the skills alone, a contiguous run inside the above
 *   agents          (8)  subagent types, which is a different vocabulary again
 *
 * and one that says where the plugins live (`name`, `path`, `source`, and a
 * `version` where there is one).
 *
 * **Names only.** No description anywhere, on any of the three, and no path per
 * skill. So a palette row's summary has to be derived from the name or invented,
 * and `commands.ts` derives it: `tx-toolkit:committee` announces its plugin,
 * a bare `dataviz` announces that it has none. Reading the descriptions off disk
 * was considered and dropped — a plugin's `SKILL.md` is findable from
 * `plugins[].path`, and a project's from the cwd, but the CLI's own built-ins
 * (16 of the 22 here) are inside a 320MB binary and on disk nowhere at all. Half
 * a palette with summaries is worse than none.
 *
 * The shapes among the 22, which are what `test/commands.test.ts` is written
 * against:
 *
 *   tx-toolkit:committee              a plugin's, named `plugin:skill`
 *   frontend-design:frontend-design   a plugin whose name repeats its skill's
 *   dataviz, code-review, loop        bare
 *
 * ── and the timing, which is why any of it is stored ───────────────────────
 *
 * `bun tools/probe-skills.ts silent` spawns with the same argv and sends
 * **nothing**. Fifteen seconds later there is still no `system/init` — the CLI
 * emits one only after the first message lands, which is the same thing
 * `CLAUDE.md` records about a freshly spawned card not being dormant.
 *
 * So a card that has been roused but not spoken to has no skills on the wire to
 * fold, and that is exactly the moment somebody opens the palette to write their
 * first prompt of the session. Hence `store::migrate_v31`: the list is stored on
 * the row and restored with it, the same argument `permission_mode` makes one
 * column over.
 *
 * ── and where a project's own commands sit in all that ─────────────────────
 *
 * `bun tools/probe-skills.ts seeded`, 2026-09-07, same build. Three files put
 * into the scratch project first — `hello.md` with a `description:`, `bare.md`
 * with no frontmatter at all, and `deep/nested.md` one directory down — and
 * `slash_commands` came back **60** names long, opening with:
 *
 *   "bare", "deep:nested", "hello", "deep-research", "tx-toolkit:committee", …
 *
 * Two things settled there, and `slash.rs` rests on both. A subdirectory is
 * named with a **colon**, the same spelling a plugin's skills use. And the
 * project's own commands come **first**, ahead of the skills, which is the
 * ordering `paletteExtras` reproduces — but is *not* something `slash.rs` reads,
 * because a prefix of an undocumented array is a dependency that breaks without
 * saying so. The module walks the directory instead, and this probe is what it
 * is checked against. See `.claude/rules/commands.md`.
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

const mode = Bun.argv[2] ?? "all";
const silent = mode === "silent";
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

await Bun.$`mkdir -p ${CWD}`.quiet();

/* The three shapes `slash.rs` is checked against, written into the probe's own
   scratch project so the project-command measurement above can be repeated
   rather than only read. Removed again at the end of the run: they are not the
   default because the interesting *other* question — what a project with no
   commands of its own publishes — is the one every ordinary run answers. */
if (mode === "seeded") {
  const commands = `${CWD}/.claude/commands`;
  await Bun.$`mkdir -p ${commands}/deep`.quiet();
  await Bun.write(
    `${commands}/hello.md`,
    "---\ndescription: say hello in the project's voice\n---\nSay hello.\n",
  );
  await Bun.write(`${commands}/bare.md`, "No frontmatter at all, just a body.\n");
  await Bun.write(
    `${commands}/deep/nested.md`,
    "---\ndescription: a command in a subdirectory\n---\nDo the nested thing.\n",
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

if (silent) {
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
    /* The whole question the palette turns on: is there anything on any of these
       beyond a name. */
    const described = (ev.skills ?? []).filter((s: unknown) => typeof s !== "string");
    console.log(
      "  skills carrying anything but a name:",
      described.length ? JSON.stringify(described) : "none",
    );
    proc.kill();
    process.exit(0);
  }
}
