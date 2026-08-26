/* What a project can be *asked to do*, decided away from the app.
 *
 * A territory on the wall is a project, and a project has a small vocabulary of
 * things you want from it all day: build it, test it, open its editor, ship it,
 * push it. Those verbs are the same words in every project; what they *mean* is
 * not, and working that out is the whole of this file.
 *
 * Pure, and out here rather than inside Canvas.svelte, for the reason
 * `classify.ts` is: this is where the toolchain knowledge lives — package
 * managers, UnrealBuildTool's argv, what a Live Coding compile prints when it
 * succeeds — and it should be testable without a window. The runtime half is
 * `actions.svelte.ts`; the facts come from `project.rs`.
 *
 * Steps carry **argv, never a shell string**. Every command ends up going
 * through `cmd /C call …` (see actions.rs), and cmd does not understand the
 * `\"` escaping that a Windows argv is quoted with — so a path with a space in
 * it, which is where every engine install lives, would arrive in pieces. An
 * argv array is quoted once, correctly, at the point of spawn.
 */

export type Manager = "pnpm" | "npm" | "yarn" | "bun";

/** Everything Unreal-shaped that `project.rs` could find on disk. */
export type UnrealFacts = {
  /** Full path to the `.uproject`. */
  uproject: string;
  /** `Caravan` — the project name UBT targets are built from. */
  name: string;
  /** Engine root, resolved from `EngineAssociation`. Null when the lookup
   *  failed, which is worth saying out loud rather than hiding the chips. */
  engine: string | null;
  /** The port this repo's committed `.mcp.json` declares, if any. */
  mcpPort: number | null;
  /** `Saved/Logs/<Name>.log` — where a running editor answers from. */
  log: string;
};

/** What a project *is*, read once when it appears on the wall. */
export type ProjectFacts = {
  root: string;
  /** Which of the four to type. Lockfile first, `packageManager` field before
   *  that, and pnpm when a package.json exists with nothing to say either way. */
  manager: Manager;
  /** package.json's script names, empty when there is no package.json. */
  scripts: string[];
  node: boolean;
  /** A Tauri app: `src-tauri/tauri.conf.json`, or a `tauri` script. */
  tauri: boolean;
  /** A `Cargo.toml` at the root — not the one inside `src-tauri`, which is
   *  part of a Tauri project rather than a project of its own. */
  cargo: boolean;
  git: boolean;
  unreal: UnrealFacts | null;
  /** Every file at or under the root that declares a version, verbatim —
   *  including things that are not versions at all. Whether any of it adds up
   *  to a project worth offering a bump to is decided here rather than by
   *  `project.rs`; see `bumpable`. */
  versions: VersionFile[];
};

/** What a project is *doing*, re-read on a slow poll. */
export type ProjectStatus = {
  /** This project's editor, if one is up. Its own, not any UnrealEditor.exe —
   *  another project's must never receive our compile and test triggers. */
  editorPid: number | null;
  branch: string | null;
  /** Whether the branch is tracking anything, which decides what push means. */
  upstream: boolean;
  ahead: number;
  /** Commits on the upstream that are not here. Measured against the
   *  remote-tracking ref, so it is only ever as current as the last fetch —
   *  which is why there is a periodic one. */
  behind: number;
  dirty: boolean;
  /** How many files are in conflict. */
  conflicts: number;
  /** The first few of them, for a tooltip — capped in `project.rs`. */
  conflictPaths: string[];
  /** What is half-done, when something is. `null` either means nothing is or
   *  means the markers were gone by the time we looked. */
  operation: Operation | null;
  /** The annotated tags a push would carry with it, by name — exactly what
   *  `--follow-tags` would send, worked out locally in `project.rs` and capped
   *  there. Empty unless the branch has an upstream to measure against. */
  unpushedTags: string[];
};

/** The operations that can stop on a conflict. */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert";

export const NO_STATUS: ProjectStatus = {
  editorPid: null,
  branch: null,
  upstream: false,
  ahead: 0,
  behind: 0,
  dirty: false,
  conflicts: 0,
  conflictPaths: [],
  operation: null,
  unpushedTags: [],
};

/** One thing an action does. Most are a command; the Unreal ones that talk to a
 *  *running* editor are not commands at all, which is why this is a union. */
export type Step =
  /** Spawn argv under a PTY and read its output. */
  | { kind: "run"; argv: string[] }
  /** Ask the open editor to Live-Coding-compile itself, and read the answer out
   *  of its log. */
  | { kind: "live-coding" }
  /** Run automation tests inside the open editor, same way. */
  | { kind: "automation"; filter: string }
  /** Set the version in every file that declares one, commit it and tag the
   *  commit. Everything decided is in the plan; see `bumpPlan`. */
  | { kind: "bump"; plan: BumpPlan }
  | { kind: "launch-editor" }
  | { kind: "focus-editor" }
  /** WM_CLOSE to the editor's own window, then wait for it to go. Graceful on
   *  purpose: the editor must get to ask about unsaved work. */
  | { kind: "close-editor" };

export type Action = {
  id: string;
  /** What the chip says. Lowercase, like the rest of the wall's prose. */
  label: string;
  title: string;
  steps: Step[];
  /** Drawn, but with nothing to do — an Unreal project whose engine would not
   *  resolve, which is worth saying rather than hiding. */
  quiet?: boolean;
  /** The id of the chip this action hangs off, when it is one choice on that
   *  chip's arc rather than a chip of its own.
   *
   *  The row never draws these — `chipsFor` gathers them onto their opener,
   *  which is what the arc fans out. They are ordinary actions otherwise: they
   *  carry steps, they run through the same `run`, they key their own `Run`, and
   *  so the control surface can press one by id without knowing an arc exists. */
  arc?: string;
};

/* ── package managers ──────────────────────────────────────────────────────
 *
 * pnpm is the default when a package.json says nothing, rather than npm. Only
 * npm needs `--` to forward arguments through a script, which is the whole of
 * the difference that matters here. */

const MANAGERS: Manager[] = ["pnpm", "npm", "yarn", "bun"];

/** `pnpm@9.1.0` in package.json's `packageManager` field → `pnpm`. */
export function managerFromField(field: string | null | undefined): Manager | null {
  if (!field) return null;
  const name = field.split("@")[0].trim().toLowerCase();
  return (MANAGERS as string[]).includes(name) ? (name as Manager) : null;
}

/** `pnpm run build`, and the one dialect difference that bites. */
export function scriptArgv(m: Manager, script: string, args: string[] = []): string[] {
  /* npm treats everything after the script name as its own; a `--` is how you
     hand arguments to the script. pnpm, yarn and bun forward them as typed, and
     pnpm in particular treats a stray `--` as an argument in its own right. */
  if (m === "npm" && args.length) return ["npm", "run", script, "--", ...args];
  return [m, "run", script, ...args];
}

/* ── Unreal ────────────────────────────────────────────────────────────────
 *
 * The shape of all of this is lifted from a working nvim setup (`unreal.lua`),
 * which had already paid for the two facts that make it non-obvious:
 *
 * - While the editor is up with Live Coding, UBT *refuses* an external build of
 *   the editor target — it probes the Live Coding mutex and throws. So `build`
 *   means two different things depending on whether the editor is open, and the
 *   open case is a console command sent to the editor rather than a process.
 * - A headless test run boots a second editor, ~30s before the first
 *   assertion. With one already open, the tests run inside it instantly. */

/** Where a running editor listens. Loopback, fixed, and shared by every editor
 *  on the machine — which is exactly why a compile is only ever sent after the
 *  poll has confirmed the open editor is *this* project's. */
export const REMOTE_CONTROL_PORT = 30010;

function ueBuildArgv(u: UnrealFacts, engine: string): string[] {
  return [
    `${engine}\\Engine\\Build\\BatchFiles\\Build.bat`,
    `${u.name}Editor`,
    "Win64",
    "Development",
    `-Project=${u.uproject}`,
    /* Wait rather than fail if another UBT holds the mutex, and emit the
       `@progress` markers `progressFrom` reads. */
    "-WaitMutex",
    "-Progress",
  ];
}

function ueTestArgv(u: UnrealFacts, engine: string, filter: string): string[] {
  return [
    `${engine}\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe`,
    u.uproject,
    `-ExecCmds=Automation RunTests ${filter}; Quit`,
    "-unattended",
    "-nopause",
    "-nosplash",
    "-nullrhi",
    /* An engine formatting test breaks under fr-FR, and a headless run has no
       reason to inherit the machine's culture. */
    "-culture=en",
    "-LogCmds=LogAutomationTest Log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-NoLogTimes",
  ];
}

function ueShipArgv(u: UnrealFacts, engine: string, root: string): string[] {
  return [
    `${engine}\\Engine\\Build\\BatchFiles\\RunUAT.bat`,
    "BuildCookRun",
    `-project=${u.uproject}`,
    "-noP4",
    "-platform=Win64",
    "-clientconfig=Shipping",
    "-cook",
    "-build",
    "-stage",
    "-pak",
    "-archive",
    `-archivedirectory=${root}\\Build`,
    "-utf8output",
    "-unattended",
  ];
}

/* ── versions ──────────────────────────────────────────────────────────────
 *
 * Bumping a version is arithmetic, and arithmetic belongs here rather than
 * anywhere that can see a file. `project.rs` reads what each file says and
 * knows where to write it back; this decides what the new number is, which
 * files get it, what the commit says and what the tag is called. Everything
 * below is a pure function of what was read.
 *
 * **Vite is not a shape.** A Vite app's version *is* its package.json's — the
 * config has no version field, and the `__APP_VERSION__` define people write
 * there reads package.json at build time. So "supports vite" is the package.json
 * case, and there is nothing else to support.
 *
 * **"Actively" is a real qualifier and it is enforced twice.** A project with no
 * version is offered nothing, obviously. But a project sitting on `0.0.0` is
 * offered nothing either: that is the value `npm init` writes and the value every
 * private app that has never released still carries, and it is the one number
 * that says the field was never used rather than saying anything about a
 * release. `0.1.0` is not excluded — `cargo new`'s default is also a perfectly
 * real first release, and there is no telling them apart. The asymmetry is
 * deliberate: a chip offered to a project that never presses it costs a chip,
 * where a chip withheld from a project that wants it costs the feature. */

/** Where in a file the version lives — the shape, not the filename. Matches
 *  `project::VersionFile.kind`, and `project::set_version` switches on it. */
export type VersionShape = "json" | "toml" | "ini" | "lock";

/** One file that declares a version, and what it says. Verbatim, so it may not
 *  be a version at all: Tauri lets `version` be a *path* to a package.json, and
 *  a Cargo crate can inherit one from its workspace. */
export type VersionFile = { path: string; kind: VersionShape; version: string };

export type BumpLevel = "major" | "minor" | "patch";

/** In the order they read left to right along the arc: biggest step first, the
 *  way a version number itself reads. */
export const BUMP_LEVELS: readonly BumpLevel[] = ["major", "minor", "patch"];

/** A version, as three numbers and how many the file wrote.
 *
 *  `arity` is 3 everywhere but Unreal, whose `ProjectVersion` is conventionally
 *  four — `1.0.0.4`, the fourth being a build number. The project's version is
 *  the first three whatever the file carries; the fourth is *kept* as a position
 *  and always written as zero, because resetting the build number is what a
 *  version bump means. */
export type Version = { major: number; minor: number; patch: number; arity: number };

/* Whole numbers only, three of them or four, and nothing else.
 *
 * A prerelease is rejected on purpose. Bumping *from* `1.2.0-rc.1` is a
 * decision, not an increment — patch could mean `1.2.0`, or `1.2.1-rc.1`, or
 * `1.2.0-rc.2`, and which one is a release plan rather than arithmetic. A chip
 * that guessed would be worse than one that is not offered, so a project on a
 * prerelease simply has no bump verb until it is on a number again. */
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?$/;

export function parseVersion(text: string): Version | null {
  const m = text.trim().match(VERSION);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    arity: m[4] === undefined ? 3 : 4,
  };
}

/** Three numbers, or four when the file it is going into wants four. The tag
 *  and the commit message always take the three-part form. */
export function formatVersion(v: Version, arity = 3): string {
  return [v.major, v.minor, v.patch, 0].slice(0, arity === 4 ? 4 : 3).join(".");
}

/** One step up, everything to the right of it back to zero. */
export function bumpedTo(v: Version, level: BumpLevel): Version {
  const next =
    level === "major"
      ? { major: v.major + 1, minor: 0, patch: 0 }
      : level === "minor"
        ? { major: v.major, minor: v.minor + 1, patch: 0 }
        : { major: v.major, minor: v.minor, patch: v.patch + 1 };
  return { ...next, arity: v.arity };
}

/** Ordering, ignoring arity — `1.0.0` and `1.0.0.0` are the same version. */
export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** What a project's version is, across however many files declare one. */
export type Bumpable = {
  /** The highest of them, and what a bump counts from. */
  from: Version;
  /** Every file carrying a version that parses, with what it parsed to. */
  files: { file: VersionFile; parsed: Version }[];
  /** False when two of them declare different numbers. */
  agreed: boolean;
};

/** Whether this project has a version to bump, and what it is.
 *
 *  Files can disagree — three files in this very repository declare the same
 *  number and nothing enforces it — and the **highest** is the one bumped from.
 *  Not a precedence between shapes, and not a refusal:
 *
 *  - A refusal would be a dead end. If package.json says 0.6.1 while
 *    `tauri.conf.json` says 0.7.0, the only way out of "they disagree" is a
 *    terminal, and the chip exists precisely to save that.
 *  - The lowest, or a favoured shape, can go *backwards over a tag that already
 *    exists*: bumping 0.6.1 by patch gives 0.6.2 while `v0.7.0` is already
 *    released. The highest can never do that.
 *
 *  Every file is written either way, so the disagreement heals on the first
 *  press — and the chip's tooltip says there was one, because a press that
 *  silently reconciled two numbers is a press you would want to have been told
 *  about.
 *
 *  `f.git` is required: without a repository there is nothing to commit the
 *  change into and nothing to hang a tag on, and a verb that wrote three files
 *  and stopped is not the verb this is. */
export function bumpable(f: ProjectFacts): Bumpable | null {
  if (!f.git) return null;

  const files = f.versions.flatMap((file) => {
    const parsed = parseVersion(file.version);
    return parsed ? [{ file, parsed }] : [];
  });
  if (!files.length) return null;

  const from = files.reduce(
    (best, x) => (compareVersions(x.parsed, best) > 0 ? x.parsed : best),
    files[0].parsed,
  );
  /* The one value that says the field was never used. See the note above. */
  if (from.major === 0 && from.minor === 0 && from.patch === 0) return null;

  return {
    from,
    files,
    agreed: files.every((x) => compareVersions(x.parsed, from) === 0),
  };
}

/** A root's last segment — what to call the project in a commit message.
 *
 *  Not the wall's own project label, which is keyed by project id rather than by
 *  path; this whole file is keyed by root. */
export function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

/** Everything one press of one arc choice will do.
 *
 *  Handed whole to `bump_version`, which decides nothing and only refuses.
 *
 *  The message is `<project>: <version>`, which is the shape this repository's
 *  own log already uses for a release (`skein: 0.7.0`) and reads sensibly
 *  anywhere else. The folder name is the project's name as far as this file is
 *  concerned, and a release commit wants to say which product it is releasing —
 *  a message of just the number is unreadable in a log of anything else.
 *
 *  Each file's `to` is rendered at *that file's* arity, so an Unreal
 *  `ProjectVersion` keeps its fourth number where a package.json beside it has
 *  three. The tag and the message always take three. */
export function bumpPlan(b: Bumpable, level: BumpLevel, root: string): BumpPlan {
  const next = bumpedTo(b.from, level);
  const to = formatVersion(next);
  return {
    level,
    from: formatVersion(b.from),
    to,
    tag: `v${to}`,
    message: `${folderName(root)}: ${to}`,
    files: b.files.map(({ file, parsed }) => ({
      path: file.path,
      kind: file.kind,
      /* Verbatim, not the parsed form: this is an identity check against what
         the file says now, and `project.rs` will compare it byte for byte. A
         reading that has gone stale must refuse rather than overwrite. */
      from: file.version,
      to: formatVersion(next, parsed.arity),
    })),
  };
}

export type VersionEdit = { path: string; kind: VersionShape; from: string; to: string };

export type BumpPlan = {
  level: BumpLevel;
  /** Three-part, and what the tag and the message say. */
  from: string;
  to: string;
  tag: string;
  message: string;
  files: VersionEdit[];
};

/** The chip that opens the arc, and the three choices on it.
 *
 *  Four actions rather than one, so that a level is an ordinary action with
 *  ordinary steps: it runs through the same `run`, keys its own `Run` so the
 *  chip can say how the last bump went, and can be pressed by id from the
 *  control surface without anything there knowing what an arc is. The opener
 *  carries no steps because pressing it is a gesture rather than a verb — see
 *  `chipsFor`, which is what gathers the three onto it. */
function bumpActions(f: ProjectFacts): Action[] {
  const b = bumpable(f);
  if (!b) return [];

  const from = formatVersion(b.from);
  const paths = b.files.map((x) => x.file.path);
  const where = paths.length === 1 ? paths[0] : `${paths.length} files — ${paths.join(", ")}`;

  const out: Action[] = [
    {
      id: "bump",
      /* The number is on the chip rather than only in the arc: which version a
         project is on is worth reading off the wall at rest, and it means the
         three choices can each be one word. */
      label: `bump ${from}`,
      title:
        (b.agreed
          ? `${from}, in ${where}`
          : `${paths.join(", ")} do not agree — ${from} is the highest and is what gets bumped`) +
        "\npick major, minor or patch — it writes them all, commits and tags. nothing is pushed",
      steps: [],
    },
  ];

  for (const level of BUMP_LEVELS) {
    const plan = bumpPlan(b, level, f.root);
    out.push({
      id: `bump:${level}`,
      label: level,
      title: `${plan.from} → ${plan.to} — commit "${plan.message}" and tag ${plan.tag}. nothing is pushed`,
      steps: [{ kind: "bump", plan }],
      arc: "bump",
    });
  }

  return out;
}

/* ── the vocabulary ────────────────────────────────────────────────────── */

/** Everything this project offers right now, in the order the chips read.
 *
 *  Order is deliberate and stable: the editor first because it is the thing you
 *  are looking at, then the loop you run all day (build, cycle, test), then the
 *  ones that leave the machine (ship, pull, push). Three of these come and go
 *  with the state of things — `cycle` with a running editor, `pull` and `push`
 *  with the remote — and what moves under the cursor when one arrives is the
 *  cost of that, which is why the two that change most often are at the end
 *  where only each other is behind them. */
export function actionsFor(f: ProjectFacts, s: ProjectStatus = NO_STATUS): Action[] {
  const out: Action[] = [];
  const u = f.unreal;

  if (u) {
    if (!u.engine) {
      /* Saying so beats silently offering a project with no verbs. Every Unreal
         command is `<engine>\Engine\...`, so without the engine root there is
         nothing honest to draw. */
      out.push({
        id: "engine",
        label: "no engine",
        title: `could not resolve the engine for ${u.name} — check the .uproject's EngineAssociation`,
        steps: [],
        quiet: true,
      });
    } else {
      const engine = u.engine;
      const open = s.editorPid !== null;

      out.push({
        id: "editor",
        label: open ? "focus" : "editor",
        title: open
          ? `bring ${u.name}'s editor to the front`
          : `open ${u.name} in the Unreal editor${u.mcpPort ? ` (MCP on :${u.mcpPort})` : ""}`,
        steps: [open ? { kind: "focus-editor" } : { kind: "launch-editor" }],
      });

      out.push({
        id: "build",
        label: "build",
        title: open
          ? "live coding — patch the running editor in place"
          : `build ${u.name}Editor Win64 Development`,
        steps: [
          open ? { kind: "live-coding" } : { kind: "run", argv: ueBuildArgv(u, engine) },
        ],
      });

      /* Only while the editor is up: with it closed, `build` already is the
         whole of what cycle would do. */
      if (open) {
        out.push({
          id: "cycle",
          label: "cycle",
          title:
            "close the editor, build, reopen — the loop for changes Live Coding cannot patch",
          steps: [
            { kind: "close-editor" },
            { kind: "run", argv: ueBuildArgv(u, engine) },
            { kind: "launch-editor" },
          ],
        });
      }

      out.push({
        id: "test",
        label: "test",
        title: open
          ? `run ${u.name}'s automation tests in the open editor`
          : `run ${u.name}'s automation tests headless (~30s of editor boot first)`,
        steps: [
          open
            ? { kind: "automation", filter: u.name }
            : { kind: "run", argv: ueTestArgv(u, engine, u.name) },
        ],
      });

      out.push({
        id: "ship",
        label: "ship",
        title: `cook and package Win64 Shipping into ${f.root}\\Build`,
        steps: [{ kind: "run", argv: ueShipArgv(u, engine, f.root) }],
      });
    }
  } else if (f.node) {
    const m = f.manager;
    const has = (s: string) => f.scripts.includes(s);

    if (has("build")) {
      out.push({
        id: "build",
        label: "build",
        title: `${m} run build`,
        steps: [{ kind: "run", argv: scriptArgv(m, "build") }],
      });
    }
    if (has("test")) {
      out.push({
        id: "test",
        label: "test",
        title: `${m} run test`,
        steps: [{ kind: "run", argv: scriptArgv(m, "test") }],
      });
    }
    /* A Tauri app's "ship" is the bundle, which is a different and much longer
       thing than `build` — the same distinction Unreal draws between compiling
       and packaging, so it gets the same word. */
    if (f.tauri && has("tauri")) {
      out.push({
        id: "ship",
        label: "ship",
        title: `${m} run tauri build — the installer, not the front end`,
        steps: [{ kind: "run", argv: scriptArgv(m, "tauri", ["build"]) }],
      });
    }
  } else if (f.cargo) {
    out.push({
      id: "build",
      label: "build",
      title: "cargo build",
      steps: [{ kind: "run", argv: ["cargo", "build"] }],
    });
    out.push({
      id: "test",
      label: "test",
      title: "cargo test",
      steps: [{ kind: "run", argv: ["cargo", "test"] }],
    });
    out.push({
      id: "ship",
      label: "ship",
      title: "cargo build --release",
      steps: [{ kind: "run", argv: ["cargo", "build", "--release"] }],
    });
  }

  /* After the toolchain and before the two that leave the machine, which is
     where it belongs in both readings of the row: cutting a release is the last
     thing you do to a project rather than part of the loop you run all day, and
     what it *produces* is the push chip immediately to its right — a bump leaves
     the branch one commit ahead, so `push ↑1` appears within a tick. That is the
     whole of how a release leaves this machine, and it stays a separate,
     deliberate click. */
  out.push(...bumpActions(f));

  if (f.git) {
    /* Both git chips are drawn only when there is something to do, which makes
       their *presence* the news: a pull chip on a territory means somebody
       pushed to that remote, and it is legible from across the wall without
       reading a single label. A row of verbs that are always there and usually
       inert is a toolbar, and a toolbar has to be read.
       Movement is the price — these two sit at the end for that reason, so what
       appears and disappears is never in front of something you are aiming at. */
    if (s.behind > 0) {
      out.push({
        id: "pull",
        label: `pull ↓${s.behind}`,
        title:
          `${commits(s.behind)} to pull${where(s)}` +
          (s.ahead > 0 ? ` — diverged, ${commits(s.ahead)} of yours as well` : ""),
        /* `--ff-only`, deliberately. This wall is full of agents editing these
           repos with `--dangerously-skip-permissions`, and a chip that can stop
           halfway through a merge is a chip that eventually does — leaving a
           conflicted tree for whatever is mid-turn in it. A refusal is a
           message you read; a conflict is an afternoon. Rebasing or merging a
           divergence is a decision, and decisions belong in a terminal. */
        steps: [{ kind: "run", argv: ["git", "pull", "--ff-only"] }],
      });
    }

    /* Nothing tracking this branch yet is the one case where push has to say
       *where*, and getting it wrong is a push to the wrong place — so it is
       decided here from what the poll saw, not left to git's own guess. It is
       also the one case where the chip shows with nothing counted: with no
       upstream there is no `branch.ab` to count against, so "nothing to push"
       is not something git has told us.
       It needs a *named* branch, and that carries two things at once. A
       detached HEAD has none, and `push -u origin HEAD` there would publish a
       branch named after wherever you happened to be standing. And an
       unanswered poll has none either — `NO_STATUS` is what every territory
       holds for the moment between appearing and its first poll, so without
       this the wall would flash a publish chip over every repo on it, which is
       a chip somebody eventually presses. */
    if (!s.upstream && s.branch) {
      out.push({
        id: "push",
        label: "publish",
        title: `publish ${s.branch} to origin — it is not tracking anything yet`,
        /* No `--follow-tags` here, deliberately, and it is the one place the two
           push chips differ. With no upstream there is no ref to measure "not
           pushed yet" against, so `project.rs` reads no tags and this chip
           cannot name what it would send — and a chip that reaches another
           machine with something it did not say it was sending is the one thing
           this row must not do. Nothing is stranded by the omission: publishing
           gives the branch an upstream, and a tag left behind draws its own
           `push +v…` chip on the very next poll. Two clicks, both labelled. */
        steps: [{ kind: "run", argv: ["git", "push", "-u", "origin", "HEAD"] }],
      });
    } else if (s.branch && s.upstream && (s.ahead > 0 || s.unpushedTags.length > 0)) {
      /* `s.branch` is new here and is belt-and-braces rather than a fix: a
         detached HEAD reports no `# branch.upstream`, so `upstream` was already
         doing this work. It is stated anyway because the guard now protects a
         *second* reason to draw — a tag — and "you cannot push what you are not
         standing on" is too load-bearing to leave resting on a coincidence in
         another file. The publish branch above makes the same argument at
         length, for a case where getting it wrong publishes a branch named
         after wherever you happened to be. */
      /* Tags alone are enough to draw this, which is why the condition is not
         just `ahead > 0`. Probed: `git push --follow-tags` sends an annotated
         tag even when the branch is up to date, so a tag on an already-pushed
         commit — `bump`'s output after somebody pushed the commit from a
         terminal, or any tag written by hand — is genuinely pushable from here.
         Without this the chip is absent and the tag has no way off the wall. */
      const tags = s.unpushedTags;
      out.push({
        id: "push",
        label: `push${s.ahead > 0 ? ` ↑${s.ahead}` : ""}${tagMark(tags)}`,
        title:
          (s.ahead > 0 ? `${commits(s.ahead)} to push${where(s)}` : `nothing to push${where(s)}`) +
          (tags.length ? `, carrying ${tags.join(", ")}` : "") +
          (s.behind > 0 ? ` — ${commits(s.behind)} behind, so pull first` : ""),
        /* `--follow-tags` rather than `--tags`: it sends the annotated tags
           reachable from what is being pushed and nothing else, so a local tag
           on some other branch — or a scratch one somebody made on an old
           commit — is not swept along with a release. `project.rs` computes the
           same set for the label, so the chip says exactly what the flag does. */
        steps: [{ kind: "run", argv: ["git", "push", "--follow-tags"] }],
      });
    }
  }

  return out;
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** What rides along, on the label. One tag is named — that is the whole point,
 *  since the tag you are about to publish is nearly always the one `bump` just
 *  wrote and seeing `v0.11.3` is the confirmation. Several are counted, because
 *  three names do not fit on a chip and a chip that grows to fit its contents
 *  is a row that reflows every time you commit. */
export function tagMark(tags: string[]): string {
  if (!tags.length) return "";
  return tags.length === 1 ? ` +${tags[0]}` : ` +${tags.length} tags`;
}
const where = (s: ProjectStatus) => (s.branch ? ` on ${s.branch}` : "");

/* ── a torn territory ──────────────────────────────────────────────────────
 *
 * A conflict is not a verb the project offers, so it is not an `Action`: it is
 * something that happened to the project and is still happening, and the wall
 * draws it as a state — the territory's own dashed boundary comes apart. What
 * follows is the label on it, and the thing it opens.
 *
 * `ours` and `theirs` are the whole reason any of this is worth being careful
 * about. In a merge they mean what you would guess. In a **rebase** they are
 * the other way round — git replays your commits onto the other branch, so the
 * *other* branch is the one being built on and gets called "ours", and your own
 * work arrives as "theirs". An agent told to resolve a conflict without being
 * told which it is standing in will take the wrong side with total confidence,
 * which is exactly the failure this feature exists to avoid. */

const conflicted = (n: number) => `${n} conflict${n === 1 ? "" : "s"}`;

/** The words for what is half-done, for prose that reads as a sentence. */
const HALF_DONE: Record<Operation, string> = {
  merge: "a merge",
  rebase: "a rebase",
  "cherry-pick": "a cherry-pick",
  revert: "a revert",
};

/** What the badge on a torn territory says, or `null` when it is whole. */
export function conflictBadge(s: ProjectStatus): { label: string; title: string } | null {
  if (s.conflicts < 1) return null;

  /* The paths are capped, so the tooltip has to say when it is not showing all
     of them — a list that silently stops at eight reads as a list of eight. */
  const shown = s.conflictPaths.slice(0, 3);
  const rest = s.conflicts - shown.length;
  const names = shown.length
    ? ` — ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`
    : "";

  return {
    label: conflicted(s.conflicts),
    title:
      `${conflicted(s.conflicts)} from ${s.operation ? HALF_DONE[s.operation] : "an operation"} ` +
      `that did not finish${names}\nclick to open a card on it`,
  };
}

/** What to say to a fresh card opened on a conflicted repo.
 *
 *  The ask is not "fix the markers" — anything can delete a marker. It is to
 *  work out what each side was *for*, which is the part a person does by
 *  remembering why they wrote it and an agent has to do by reading. So the
 *  prompt spends its length on method rather than on the mechanics: where to
 *  find each side's intent, that the answer is usually neither side verbatim,
 *  and what to do when the two genuinely cannot both be true (stop, rather than
 *  pick — a conflict resolved by coin toss is worse than one left standing,
 *  because it looks finished).
 *
 *  It deliberately stops short of committing. Every card on this wall spawns
 *  with `--dangerously-skip-permissions`, and a merge is exactly the thing you
 *  want to read before it becomes history. */
export function conflictPrompt(s: ProjectStatus): string {
  const op = s.operation;
  const from = op ? `${HALF_DONE[op]} that stopped part-way` : "an operation that did not finish";

  /* Which is which, in the words of the operation actually in progress. Wrapped
     by hand like everything else here: the panel renders GFM, where a single
     newline is a line break, so a paragraph that arrives as one long line stays
     one long line beside four that don't. */
  const sides =
    op === "rebase"
      ? [
          "- in a rebase git replays your commits onto the other branch, so it calls the",
          "  *other* branch `ours` and your own work `theirs` — the opposite of a merge.",
          "  keep that straight, and name both sides explicitly in what you tell me,",
          "  rather than saying ours and theirs.",
        ]
      : [
          `- \`ours\` is ${s.branch ? `\`${s.branch}\`, where you are standing` : "the branch you are on"};` +
            ` \`theirs\` is what the ${op ?? "operation"} is`,
          "  bringing in. name both sides explicitly in what you tell me, rather than",
          "  saying ours and theirs.",
        ];

  const dontFinish = op
    ? [
        `do **not** commit, and do not \`git ${op} --continue\`.`,
        "leave it staged for me to read.",
      ]
    : ["do **not** commit — leave it staged for me to read."];

  /* "the 1 conflict" is not a sentence anybody writes. */
  const what = s.conflicts === 1 ? "the conflict" : `the ${conflicted(s.conflicts)}`;

  return [
    `resolve ${what} in this repository — ${from}.`,
    "",
    "`git diff --name-only --diff-filter=U` is the full list. read before you write:",
    "",
    ...sides,
    "- for each file, work out what each side was *trying to do*, not just what it",
    "  says. `git log --merge -p -- <file>` shows the commits behind both sides, and",
    "  the code around the markers usually carries more of the intent than the",
    "  conflicting lines themselves do.",
    "- a conflict is two intents that overlapped, so the resolution is usually",
    "  neither side verbatim. keep both where they are compatible. taking one side",
    "  wholesale is right only where the other has genuinely been superseded — and",
    "  when you do that, say which and why.",
    "- where the two intents genuinely contradict, so that satisfying one means",
    "  breaking the other, stop and ask me. do not pick.",
    "",
    "then: no markers left anywhere, every file still parses, and the project still",
    "builds. `git add` what you have resolved, and stop there —",
    ...dontFinish,
    "",
    "finish by telling me, per file, what each side wanted and what you did with it.",
  ].join("\n");
}

/* ── reading progress out of build output ──────────────────────────────────
 *
 * A build with no sign of life is indistinguishable from a hung one, and the
 * three toolchains here all say where they are — in three different dialects,
 * none of them a percentage on its own line. So a line is folded into either a
 * fraction, a short note, or nothing at all.
 *
 * `pct` is only ever set from something that genuinely counts to a known total.
 * A note with no number is not a failure of this function: for cargo and vite
 * there is no total, and "compiling serde" is still the difference between a
 * build working and a build stuck. */

export type Progress = { pct: number | null; note: string | null };

/** `[12/345] Compile Foo.cpp` — UBT, and ninja, and a few others. */
const COUNTED = /^\s*\[(\d+)\/(\d+)\]\s*(.*)$/;
/** UBT's machine-readable markers, emitted because of `-Progress`. */
const UBT_PROGRESS = /^@progress\s+(.*)$/;
const QUOTED = /'([^']*)'/;
const TRAILING_PCT = /(\d{1,3})%\s*$/;
/** The cook's own counter, which is the long half of a package. */
const COOK = /Cooked packages\s+(\d+)\s+Packages Remain\s+(\d+)\s+Total\s+(\d+)/;
/** vite, tsc, rollup and friends: no total, but plenty of life. */
const NOTES = [
  /^\s*(?:✓|√)?\s*(\d+ modules transformed.*)$/,
  /^\s*(transforming\b.*)$/,
  /^\s*(rendering chunks.*)$/,
  /^\s*(computing gzip size.*)$/,
  /^\s*(built in .*)$/,
  /^\s*(Compiling \S+.*)$/,
  /^\s*(Finished\b.*)$/,
  /^\s*(Building \d+ actions?.*)$/,
  /LogLiveCoding:\s+\w+:\s+(.*)$/,
  /LogCook:\s+\w+:\s+(.*)$/,
];

/** What this line says about how far along a run is, or null if nothing. */
export function progressFrom(line: string): Progress | null {
  const ubt = line.match(UBT_PROGRESS);
  if (ubt) {
    const rest = ubt[1].trim();
    /* `push`/`pop`/`increment` scope a *sub*-range — the number on them is a
       share of the whole, not a position in it, and reading it as absolute made
       a bar that jumped to 5% and stayed there. Only the plain form counts. */
    if (/^(push|pop|increment)\b/.test(rest)) {
      const msg = rest.match(QUOTED);
      return msg ? { pct: null, note: msg[1] } : null;
    }
    const msg = rest.match(QUOTED);
    const pct = rest.match(TRAILING_PCT);
    if (!msg && !pct) return null;
    return {
      pct: pct ? clampPct(Number(pct[1])) : null,
      note: msg ? msg[1] : null,
    };
  }

  const counted = line.match(COUNTED);
  if (counted) {
    const done = Number(counted[1]);
    const total = Number(counted[2]);
    return {
      pct: total > 0 ? clampPct((done / total) * 100) : null,
      note: counted[3].trim() || null,
    };
  }

  const cook = line.match(COOK);
  if (cook) {
    const done = Number(cook[1]);
    const total = Number(cook[3]);
    return {
      pct: total > 0 ? clampPct((done / total) * 100) : null,
      note: `cooked ${done}/${total}`,
    };
  }

  for (const re of NOTES) {
    const m = line.match(re);
    if (m) return { pct: null, note: m[1].trim() };
  }

  return null;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ── the two things a running editor answers with ──────────────────────────
 *
 * Neither Live Coding nor an in-editor test run has an exit code to read: the
 * trigger is an HTTP call that returns the moment the editor accepts it, and
 * the result appears some seconds later in the editor's log. So both are folds
 * over log lines, and both are here rather than in the runtime so that the
 * marker vocabulary can be tested against real captured output. */

export type LiveCoding = {
  started: boolean;
  done: boolean;
  ok: boolean;
  note: string | null;
  /** Set when the compile succeeded but changed data types — the patch is in,
   *  and it is not to be trusted until the editor has been cycled. */
  stale: boolean;
};

export const LIVE_CODING: LiveCoding = {
  started: false,
  done: false,
  ok: false,
  note: null,
  stale: false,
};

/** Fold one line of the editor's log into a Live Coding verdict. */
export function liveCodingStep(prev: LiveCoding, line: string): LiveCoding {
  if (prev.done) return prev;
  const m = line.match(/LogLiveCoding:\s+\w+:\s+(.*?)\s*$/);
  if (!m) return prev;
  const say = m[1];

  if (say.includes("Starting Live Coding compile")) {
    return { ...prev, started: true, note: "compiling…" };
  }
  if (say.includes("Live coding succeeded")) {
    const stale = say.includes("data type changes");
    return {
      ...prev,
      done: true,
      ok: true,
      stale,
      note: say.includes("no code changes detected")
        ? "no code changes"
        : stale
          ? "patched, but data types changed — cycle before trusting it"
          : "patched the running editor",
    };
  }
  if (
    say.includes("Live coding failed") ||
    say.includes("Live coding canceled") ||
    say.includes("Unable to start live coding")
  ) {
    return { ...prev, done: true, ok: false, note: say };
  }
  return prev;
}

export type Tally = {
  total: number;
  passed: number;
  failed: string[];
  /** `file(line): message`, ready to read. */
  errors: string[];
  done: boolean;
};

export const NO_TALLY: Tally = {
  total: 0,
  passed: 0,
  failed: [],
  errors: [],
  done: false,
};

/** Fold one line of automation output into a tally. Works on both paths: the
 *  editor's log and a headless run's stdout carry the same sentences. */
export function automationStep(prev: Tally, line: string): Tally {
  if (prev.done) return prev;
  let next = prev;

  const found = line.match(/Found (\d+) automation tests/);
  if (found) next = { ...next, total: Number(found[1]) };

  if (line.includes("Test Completed. Result={Success}")) {
    next = { ...next, passed: next.passed + 1 };
  }

  const failed = line.match(/Test Completed\. Result=\{Fail\}.*?Path=\{(.*?)\}/);
  if (failed) next = { ...next, failed: [...next.failed, failed[1]] };

  const err = line.match(/LogAutomationController:\s+Error:\s+(.*?)\s+\[(.*?)\((\d+)\)\]\s*$/);
  if (err) {
    next = { ...next, errors: [...next.errors, `${err[2]}(${err[3]}): ${err[1]}`] };
  }

  if (line.includes("Automation Test Queue Empty")) next = { ...next, done: true };

  return next;
}

/** How a finished tally reads on a chip. */
export function tallyNote(t: Tally): string {
  if (t.total === 0) return "no tests matched";
  const failed = t.failed.length || Math.max(0, t.total - t.passed);
  return failed === 0
    ? `${t.passed}/${t.total} passed`
    : `${failed}/${t.total} failed`;
}

/* ── coming back to the window ─────────────────────────────────────────────
 *
 * A project's facts are probed once, when it comes onto the wall, and the rule
 * that says so is about the eight-second poll rather than about the facts: what
 * a project *is* changes when you edit package.json, not while you are looking
 * at it. Which is true, and is exactly why the bump chip went stale — a pull
 * that brings in somebody else's release, or a version edited in an editor,
 * both happen while you are looking at something else, and the arc came back
 * offering a bump that had already been made.
 *
 * Nothing emits an event when a file changes underneath us. Focus is the event
 * that already exists nearby: coming back to the window is the boundary of
 * having been away, which is the whole of when it can have changed. The gate is
 * here and pure because it is two easy mistakes in three lines — firing on the
 * way *out* of focus as well as in, and a floor that measures from the wrong
 * end. See `Actions.refocus`.
 */

/** What the gate remembers between asks. */
export type FocusGate = {
  /** Whether the window was in front when it last heard. */
  focused: boolean;
  /** When it last said yes — not when it last heard, which would let a burst of
   *  alt-tabs push the floor out ahead of itself forever. Zero means never, so
   *  the first transition is never held behind a floor it has not met; the same
   *  convention `release.svelte.ts` uses for `#askedAt`. */
  at: number;
};

export const NO_FOCUS: FocusGate = { focused: false, at: 0 };

/** Fold one focus reading into the gate.
 *
 *  Yes only on the *transition* into focus, and only if the floor has passed.
 *  Losing focus is never a yes and never touches the clock — it is the thing
 *  that arms the next one. */
export function refocusStep(
  prev: FocusGate,
  focused: boolean,
  now: number,
  floorMs: number,
): { next: FocusGate; ask: boolean } {
  if (!focused) return { next: { ...prev, focused: false }, ask: false };
  if (prev.focused) return { next: prev, ask: false };
  if (prev.at !== 0 && now - prev.at < floorMs) {
    return { next: { ...prev, focused: true }, ask: false };
  }
  return { next: { focused: true, at: now }, ask: true };
}
