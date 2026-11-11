/* The tour's content, as data.
 *
 * Pure and tested directly (`test/showcase.test.ts`), for the same reason
 * `widgets.ts` and `integrations.ts` are: the copy is the part somebody
 * reviews, and it should not be reachable only by running the app. The
 * component draws what is here and decides nothing about what it says.
 *
 * The tour spends no allowance. Every conversation in it is a constant below,
 * so opening it on a plane works, and a room full of people clicking through
 * it costs nothing. That is the same reason the pictures are drawn from the
 * wall's own tokens rather than captured: a screenshot goes stale, and a
 * demo that needs a live agent is a demo that fails in front of an audience.
 *
 * Copy rules for whoever edits this: lowercase openings, no em dashes, no
 * "not just X but Y", no paragraph that exists only to sound conclusive. Say
 * the specific thing. The humanizer notes in tx-toolkit's presentation skill
 * are the checklist.
 */

export type ChapterId =
  | "why"
  | "wall"
  | "card"
  | "ask"
  | "relay"
  | "desk"
  | "compare"
  | "security"
  | "next";

export type Chapter = {
  id: ChapterId;
  /** The rail's word for it. */
  title: string;
  /** The heading over the chapter, which is a sentence rather than a label. */
  head: string;
  /** One sentence under the heading. */
  lede: string;
  /** What the reader is meant to do in this chapter, said plainly. */
  do?: string;
};

/** The order is the argument, so it is one array and not a map. */
export const CHAPTERS: readonly Chapter[] = [
  {
    id: "why",
    title: "why volery exists",
    head: "Nine agents do not fit in nine tabs.",
    lede: "Claude Code is good at one task. The trouble starts when you have nine of them running.",
    do: "step through the three states.",
  },
  {
    id: "wall",
    title: "the wall",
    head: "The whole flock, on one surface.",
    lede: "Every conversation on one surface. Colour is the state, so you can read the room without opening anything.",
    do: "drag to pan, wheel to zoom, click a card.",
  },
  {
    id: "card",
    title: "inside a card",
    head: "Every tool call is kept, down to the diff.",
    lede: "The same events a terminal prints, arranged as prose, and folded so a round of thirty calls still reads as a conversation.",
    do: "open the run of tool calls.",
  },
  {
    id: "ask",
    title: "when an agent asks",
    head: "An agent that needs an answer stops, and says so.",
    lede: "A question parks the turn. Answering it resumes the same turn, in the same session.",
    do: "pick an option.",
  },
  {
    id: "relay",
    title: "agents working together",
    head: "A card can open a card.",
    lede: "A card can open another card, send it a message, and read what it said without costing it a turn.",
    do: "send a message, then open a worker.",
  },
  {
    id: "desk",
    title: "the rest of the desk",
    head: "The things around the agents.",
    lede: "Pipelines, pull requests, Asana, a browser, your editor, a shell, music, and your other machines.",
    do: "click a thing to see what it needs.",
  },
  {
    id: "compare",
    title: "compared with your tools",
    head: "Each of these is good at something Volery is not.",
    lede: "A terminal, an IDE extension, Claude Desktop, ChatGPT and Codex all do something better than Volery. Here is what each is for.",
    do: "hover a row to read the whole line.",
  },
  {
    id: "security",
    title: "security and trust",
    head: "What is protected, and what is still exposed.",
    lede: "Volery keeps its own data on this machine. The flyway is the one thing that leaves, and it is where the risk is.",
    do: "take the key, then add the second factor.",
  },
  {
    id: "next",
    title: "what comes next",
    head: "What is not built yet.",
    lede: "Parity with the apps you already use, a wall with depth, and models on Azure so allowance stops being the ceiling.",
  },
] as const;

export function chapterIndex(id: ChapterId): number {
  return CHAPTERS.findIndex((c) => c.id === id);
}

/** The chapter after this one, wrapping. The tour is a loop because the last
 *  chapter offers the first thing to try, and a dead end at the end of a
 *  presentation is a room waiting for you to find the close button. */
export function nextChapter(at: number): number {
  return (at + 1) % CHAPTERS.length;
}

export function previousChapter(at: number): number {
  return (at - 1 + CHAPTERS.length) % CHAPTERS.length;
}

/** 0 at the first chapter, 1 at the last. The rail's progress line. */
export function progress(at: number): number {
  return CHAPTERS.length < 2 ? 0 : at / (CHAPTERS.length - 1);
}

/* ── the wall ───────────────────────────────────────────────────────────── */

export type Status = "work" | "ask" | "rest" | "fail" | "idle";

export type WallCard = {
  id: string;
  project: string;
  title: string;
  status: Status;
  /** What the card says about itself under its title. */
  said: string;
  /** How full its context is, 0..1. */
  ctx: number;
  model: string;
  /** In the demo's own coordinates. The plane is 900 wide and 470 tall. */
  x: number;
  y: number;
};

export type Territory = { name: string; x: number; y: number; w: number; h: number };

/** The demo wall's own coordinate space, and the box a card occupies in it.
 *  `test/showcase.test.ts` holds every card inside the plane, so a title that
 *  grows cannot push a card off the edge of the drawing unnoticed. */
export const PLANE_W = 900;
export const PLANE_H = 372;
export const SHOW_CARD_W = 168;
export const SHOW_CARD_H = 80;

export const WALL_TERRITORIES: readonly Territory[] = [
  { name: "portfolio", x: 34, y: 46, w: 350, h: 286 },
  { name: "paperwork", x: 404, y: 46, w: 250, h: 176 },
  { name: "just chat", x: 404, y: 238, w: 250, h: 100 },
  { name: "nova", x: 674, y: 46, w: 196, h: 176 },
] as const;

export const WALL_CARDS: readonly WallCard[] = [
  {
    id: "sync",
    project: "portfolio",
    title: "Refactor the price sync to a queue",
    status: "work",
    said: "editing 4 files",
    ctx: 0.42,
    model: "opus 5.5",
    x: 56,
    y: 74,
  },
  {
    id: "migration",
    project: "portfolio",
    title: "Split the billing migration",
    status: "ask",
    said: "waiting on you: 3 questions",
    ctx: 0.67,
    model: "sonnet 5.5",
    x: 226,
    y: 74,
  },
  {
    id: "notes",
    project: "portfolio",
    title: "Write the release notes for 0.104",
    status: "rest",
    said: "finished 12 minutes ago",
    ctx: 0.31,
    model: "sonnet 5.5",
    x: 56,
    y: 190,
  },
  {
    id: "assets",
    project: "portfolio",
    title: "Bump the asset pipeline to 5.6",
    status: "fail",
    said: "stopped: it gave up",
    ctx: 0.54,
    model: "haiku 5.5",
    x: 226,
    y: 190,
  },
  {
    id: "invoices",
    project: "paperwork",
    title: "Reconcile the Q3 invoice batch",
    status: "work",
    said: "reading 9 files",
    ctx: 0.19,
    model: "opus 5.5",
    x: 424,
    y: 74,
  },
  {
    id: "vendor",
    project: "paperwork",
    title: "Draft the vendor summary",
    status: "rest",
    said: "finished 3 hours ago",
    ctx: 0.24,
    model: "sonnet 5.5",
    x: 424,
    y: 164,
  },
  {
    id: "article",
    project: "just chat",
    title: "Summarise the HNSW article",
    status: "idle",
    said: "dormant, will wake on send",
    ctx: 0.08,
    model: "sonnet 5.5",
    x: 424,
    y: 256,
  },
  {
    id: "shader",
    project: "nova",
    title: "Find why the water shader flickers",
    status: "work",
    said: "running a test",
    ctx: 0.73,
    model: "opus 5.5",
    x: 694,
    y: 74,
  },
] as const;

/** The one-line reading of a status, used by the legend and by the card. */
export const STATUS_SAID: Record<Status, string> = {
  work: "working, a turn is running",
  ask: "asking, it needs an answer",
  rest: "at rest, nothing was lost",
  fail: "failed, and it says why",
  idle: "dormant, it wakes when you send",
};

/* ── the transcript ─────────────────────────────────────────────────────── */

/** What the terminal shows. Not a real JSONL dump (that would be unreadable in
 *  a demo) but the shape of it: one event per line, keys and all, with the
 *  prose buried inside. This is what `--output-format stream-json` looks like
 *  before anything folds it. */
export const TERMINAL_LINES: readonly string[] = [
  `{"type":"system","subtype":"init","tools":["Read","Edit","Bash"],...}`,
  `{"type":"assistant","message":{"content":[{"type":"text",`,
  `  "text":"I'll start by reading the retry logic and the queue."}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use",`,
  `  "id":"toolu_01Q","name":"Read",`,
  `  "input":{"file_path":"src/queue/retry.ts"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result",`,
  `  "tool_use_id":"toolu_01Q","content":[{"type":"text",`,
  `  "text":"export function retry(…\\n  const delay = …"}]}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use",`,
  `  "id":"toolu_02R","name":"Edit",`,
  `  "input":{"file_path":"src/queue/retry.ts","old_string":"…"}}]}}`,
  `{"type":"assistant","message":{"content":[{"type":"tool_use",`,
  `  "id":"toolu_03S","name":"Bash",`,
  `  "input":{"command":"bun test test/retry.test.ts"}}]}}`,
  `{"type":"user","message":{"content":[{"type":"tool_result",`,
  `  "tool_use_id":"toolu_03S","content":"14 pass, 0 fail"}]}}`,
  `{"type":"result","subtype":"success","num_turns":7,`,
  `  "total_cost_usd":0.31,"session_id":"b2f1…"}`,
] as const;

/** What the card says, in the same order. The prose is markdown because the
 *  panel renders markdown, and because a demonstration of a markdown reader
 *  that is not itself markdown would be a poor demonstration. */
export const CARD_PROSE = `I read the retry helper and the queue in front of it. The retry is not the problem: it backs off correctly. The queue calls it inside the same transaction that claims the job, so a retry re-claims a row the first attempt already wrote.

**What I changed.** The claim and the work are now separate transactions, and the retry wraps only the second one.`;

export const CARD_PROSE_AFTER = `The suite is green, and the queue no longer double-writes on a retry. Two things I did not touch: the dead-letter path is still untested, and \`maxAttempts\` is read from two places. Say if you want either.`;

export type FoldCall = {
  tool: string;
  /** The subject, picked out of the arguments. */
  subject: string;
  /** The result, one line. */
  result: string;
  /** A diff, when the call was an edit. */
  diff?: readonly { sign: "+" | "-" | " "; text: string }[];
};

export const CARD_RUN: readonly FoldCall[] = [
  {
    tool: "Read",
    subject: "src/queue/retry.ts",
    result: "44 lines",
  },
  {
    tool: "Read",
    subject: "src/queue/claim.ts",
    result: "61 lines",
  },
  {
    tool: "Grep",
    subject: "maxAttempts",
    result: "3 files",
  },
  {
    tool: "Edit",
    subject: "src/queue/claim.ts",
    result: "+18 −7",
    diff: [
      { sign: " ", text: "export async function claim(id: string) {" },
      { sign: "-", text: "  return db.tx(async (tx) => {" },
      { sign: "-", text: "    const row = await tx.claim(id);" },
      { sign: "-", text: "    return retry(() => work(row));" },
      { sign: "+", text: "  const row = await db.tx((tx) => tx.claim(id));" },
      { sign: "+", text: "  return retry(() => db.tx(() => work(row)));" },
      { sign: " ", text: "};" },
    ],
  },
  {
    tool: "Bash",
    subject: "bun test test/retry.test.ts",
    result: "14 passed",
  },
] as const;

/* ── the question ───────────────────────────────────────────────────────── */

export type AskOption = { label: string; detail: string; answer: string };

export const ASK = {
  asked: "Which order should the two migrations land in?",
  why: "The billing split touches the same table as the audit backfill. Landing them in the wrong order leaves a window where a row has no audit entry, and backfilling it afterwards is a half hour of SQL.",
  options: [
    {
      label: "billing first, then audit",
      detail: "Short window, no orphan rows. The audit backfill has to wait for the deploy.",
      answer: "billing first, then audit",
    },
    {
      label: "audit first, then billing",
      detail: "No deploy ordering. The backfill runs against the old shape and needs a second pass after.",
      answer: "audit first, then billing",
    },
    {
      label: "land both in one release",
      detail: "One window, one rollback. The two authors have to coordinate the cut.",
      answer: "land both in one release",
    },
  ] as readonly AskOption[],
  /** What the card says once it has the answer. */
  resumed:
    "billing first, then audit. I'll put the audit backfill behind the deploy and check that no row was written in between.",
};

/** The second decision in the same call. Two questions arrive together
 *  because they are independent; the panel asks them one at a time and sends
 *  one reply, which is the part worth showing. */
export const ASK_SECOND = {
  asked: "Open the backfill pull request now, or after the deploy?",
  why: "Opening it now gives reviewers a head start and leaves a pull request that cannot merge until the billing split is out. Opening it after the deploy is tidier and slower.",
  options: [
    {
      label: "open it after the deploy",
      detail: "Nobody can merge it early by accident. Review starts tomorrow.",
      answer: "open it after the deploy",
    },
    {
      label: "open it now, as a draft",
      detail: "Review can start today. The draft blocks a merge until you mark it ready.",
      answer: "open it now, as a draft",
    },
  ] as readonly AskOption[],
};

export const ASK_REVIEW = "Two decisions, one reply. Nothing is sent until the last one is answered.";

export const ASK_FILED =
  "Filed until you are back. The card stays parked, and the question is waiting in the pile with the answers you had already given.";

/* ── the desk ───────────────────────────────────────────────────────────── */

export type DeskThing = {
  id: string;
  name: string;
  line: string;
  /** What has to exist before it works. */
  needs: string;
  /** What it spends, and what it can reach. */
  cost: string;
  /** `machine` is this computer, `wire` is another one, `service` is outside. */
  where: "machine" | "wire" | "service";
};

export const DESK: readonly DeskThing[] = [
  {
    id: "flyway",
    name: "the flyway",
    line: "Your other machines as one roster. A card runs where the repo, the toolchain and the credentials already are.",
    needs: "a wall key on each machine.",
    cost: "one sealed connection per wall. Work crosses it; tokens never do.",
    where: "wire",
  },
  {
    id: "screens",
    name: "screens",
    line: "A machine's display on the wall, or every display on the flyway at once.",
    needs: "a wall on the flyway, and a person there to allow it.",
    cost: "video, sealed per connection and consent per session.",
    where: "wire",
  },
  {
    id: "phone",
    name: "the phone",
    line: "See what the flock is doing and answer a question from your pocket.",
    needs: "the flyway key and a phone build.",
    cost: "text: a question, an answer, a card's state. Not a transcript.",
    where: "wire",
  },
  {
    id: "browser",
    name: "a browser",
    line: "One Chrome the wall owns. A card drives it and you can watch, or take the wheel.",
    needs: "nothing. It starts on demand.",
    cost: "your signed-in profile on this machine, which is the point and the risk.",
    where: "machine",
  },
  {
    id: "editor",
    name: "your editor",
    line: "nvim attached over pipes as a UI, not a terminal. The panel's third reading.",
    needs: "nvim on PATH.",
    cost: "your own config and your own keybindings, with one key kept back.",
    where: "machine",
  },
  {
    id: "shell",
    name: "a shell",
    line: "Alt+I floats one over the wall. A line starting with ! runs in the dock and lands in the transcript.",
    needs: "PowerShell.",
    cost: "the rights you already have. It is your shell.",
    where: "machine",
  },
  {
    id: "pipelines",
    name: "pipelines and reviews",
    line: "Builds and pull requests from Azure DevOps and GitHub in one list, with the run openable in the app.",
    needs: "a repository remote, and gh or a token.",
    cost: "two polls, only while a widget or a sheet is up.",
    where: "service",
  },
  {
    id: "asana",
    name: "asana",
    line: "Boards as columns and tasks as cards, and an agent that can file one for you.",
    needs: "a token. Asana has no CLI on this machine.",
    cost: "one poll while a board is open. Every write asks first.",
    where: "service",
  },
  {
    id: "spotify",
    name: "music",
    line: "The wall is the player. A card can choose what plays and cannot silence you.",
    needs: "a Spotify sign-in.",
    cost: "one loopback tunnel so the player has an address that answers.",
    where: "service",
  },
  {
    id: "timers",
    name: "timers",
    line: "A pomodoro that takes its breaks rather than offering them.",
    needs: "nothing.",
    cost: "one tick a second, which the wall already runs.",
    where: "machine",
  },
] as const;

/* ── the comparison ─────────────────────────────────────────────────────── */

export type Verdict = "yes" | "partly" | "no";

export type Tool = { id: string; name: string; sub: string };

export const TOOLS: readonly Tool[] = [
  { id: "terminal", name: "claude code", sub: "terminal" },
  { id: "vscode", name: "claude code", sub: "vs code" },
  { id: "desktop", name: "claude", sub: "desktop" },
  { id: "chatgpt", name: "chatgpt", sub: "web and app" },
  { id: "codex", name: "codex", sub: "cli and ide" },
  { id: "volery", name: "volery", sub: "this app" },
] as const;

export type CompareRow = {
  label: string;
  cells: readonly { v: Verdict; said: string }[];
};

export const COMPARE: readonly CompareRow[] = [
  {
    label: "many agents at once",
    cells: [
      { v: "yes", said: "one tab each" },
      { v: "partly", said: "one panel per session" },
      { v: "partly", said: "projects, one chat in front" },
      { v: "no", said: "one chat" },
      { v: "partly", said: "sessions, one at a time" },
      { v: "yes", said: "one wall" },
    ],
  },
  {
    label: "who needs you, without opening one",
    cells: [
      { v: "no", said: "scroll the tabs" },
      { v: "no", said: "scroll the list" },
      { v: "partly", said: "a badge per project" },
      { v: "no", said: "none" },
      { v: "no", said: "none" },
      { v: "yes", said: "colour on the card" },
    ],
  },
  {
    label: "survives closing the app",
    cells: [
      { v: "yes", said: "--resume, by id" },
      { v: "partly", said: "resume, by hand" },
      { v: "yes", said: "in the cloud" },
      { v: "yes", said: "in the cloud" },
      { v: "yes", said: "sessions" },
      { v: "yes", said: "one click to rouse" },
    ],
  },
  {
    label: "a transcript you can read later",
    cells: [
      { v: "no", said: "the scrollback" },
      { v: "partly", said: "a chat panel" },
      { v: "yes", said: "rendered" },
      { v: "yes", said: "rendered" },
      { v: "partly", said: "a diff view" },
      { v: "yes", said: "rendered, folded, kept" },
    ],
  },
  {
    label: "one agent opening another",
    cells: [
      { v: "partly", said: "subagents, same turn" },
      { v: "partly", said: "subagents" },
      { v: "no", said: "none" },
      { v: "no", said: "none" },
      { v: "partly", said: "subagents" },
      { v: "yes", said: "a card with its own session" },
    ],
  },
  {
    label: "work on several machines",
    cells: [
      { v: "no", said: "ssh, or nothing" },
      { v: "no", said: "none" },
      { v: "yes", said: "cloud" },
      { v: "yes", said: "cloud" },
      { v: "yes", said: "cloud" },
      { v: "yes", said: "the flyway" },
    ],
  },
  {
    label: "your editor",
    cells: [
      { v: "yes", said: "it is a terminal" },
      { v: "yes", said: "it is the editor" },
      { v: "no", said: "none" },
      { v: "no", said: "none" },
      { v: "yes", said: "the IDE" },
      { v: "partly", said: "attaches to your nvim" },
    ],
  },
  {
    label: "which account, which model, per card",
    cells: [
      { v: "partly", said: "one config" },
      { v: "partly", said: "one config" },
      { v: "no", said: "one account" },
      { v: "partly", said: "one account, model picker" },
      { v: "partly", said: "one account" },
      { v: "yes", said: "per card, with a waterfall" },
    ],
  },
  {
    label: "allowance and spend",
    cells: [
      { v: "partly", said: "/cost" },
      { v: "partly", said: "/cost" },
      { v: "no", said: "none" },
      { v: "no", said: "none" },
      { v: "no", said: "none" },
      { v: "yes", said: "windows, resets, today" },
    ],
  },
  {
    label: "pipelines, pull requests, tickets",
    cells: [
      { v: "no", said: "shell out" },
      { v: "partly", said: "extensions" },
      { v: "partly", said: "connectors" },
      { v: "partly", said: "connectors" },
      { v: "no", said: "shell out" },
      { v: "yes", said: "widgets and MCP tools" },
    ],
  },
  {
    label: "keyboard first",
    cells: [
      { v: "yes", said: "all of it" },
      { v: "yes", said: "most of it" },
      { v: "partly", said: "the box" },
      { v: "no", said: "the box" },
      { v: "yes", said: "most of it" },
      { v: "yes", said: "a chord for every verb" },
    ],
  },
  {
    label: "your data stays on this machine",
    cells: [
      { v: "yes", said: "it is a local process" },
      { v: "yes", said: "a local process" },
      { v: "no", said: "cloud" },
      { v: "no", said: "cloud" },
      { v: "no", said: "cloud" },
      { v: "yes", said: "SQLite and a vault" },
    ],
  },
] as const;

/** The honest paragraph under the table, because a matrix that only says
 *  "yes" is an advertisement. */
export const COMPARE_NOTE =
  "If you run one agent at a time, a terminal is faster to start and nothing here beats it. Volery earns its place at about five conversations, when the tabs stop telling you anything. Codex and Claude Desktop are also better than Volery at things this app does not try to do: browsing for an answer, and being the same app on a phone.";

/* ── security ───────────────────────────────────────────────────────────── */

/** Flip this when the second factor ships. Both drafts are below, so the
 *  chapter changes by one word and the copy that is no longer true does not
 *  have to be rewritten from memory. */
export const SECURITY_STAGE: "current" | "hardened" = "current";

export type Trust = { label: string; value: string; tone: "ok" | "warn" | "gap" };

export const SECURITY_FACTS: readonly Trust[] = [
  {
    label: "where the wall lives",
    value:
      "one SQLite file in %APPDATA%\\dev.skein.studio, plus Claude Code's own transcripts under ~/.claude/projects. No Volery account, no server of ours.",
    tone: "ok",
  },
  {
    label: "where credentials live",
    value:
      "the Windows Credential Manager, one entry per service, listed under names you can read in Control Panel. Never in the database, and no command hands one back to the window.",
    tone: "ok",
  },
  {
    label: "what crosses the flyway",
    value:
      "work: transcripts, card state, questions, screens. A frame is sealed with ChaCha20-Poly1305 under a key derived from the wall key, and the room id is authenticated so a frame cannot be moved between rooms. No token ever crosses.",
    tone: "ok",
  },
  {
    label: "the wall key",
    value:
      "one 32-byte secret, generated on this machine, held in the vault, and shown only when you press to see it. Holding it is full membership: anyone with the key can join the flyway and read what it carries.",
    tone: "warn",
  },
  {
    label: "what a card can do",
    value:
      "a project card runs with --dangerously-skip-permissions, so it can edit and delete anything you can. That is the same authority a terminal gives it. A chat card is spawned with WebSearch and WebFetch only.",
    tone: "warn",
  },
  {
    label: "the browser",
    value:
      "the shared Chrome keeps a profile on this machine and is seeded from your own sign-ins. A card driving it acts as you on any site you are signed into.",
    tone: "warn",
  },
  {
    label: "what the vault protects",
    value:
      "secrets at rest against another Windows account, and against a copy of the database. It does not protect against code running as you, which is what an agent already is.",
    tone: "gap",
  },
  {
    label: "the job object",
    value:
      "every process a card starts dies with the wall, by ordinary means. A process created through WMI reparents out of the job and is outside the wall's reach.",
    tone: "gap",
  },
] as const;

export type Plan = { title: string; body: string; status: "shipped" | "planned" };

export const SECURITY_PLANS: Record<"current" | "hardened", readonly Plan[]> = {
  current: [
    {
      title: "a second factor for the flyway",
      body:
        "A wall key on its own should not be enough to join a flyway or drive another wall. The plan is a second factor at the two moments that matter: joining, and accepting work from another machine. A stolen key would then be a key to a locked door.",
      status: "planned",
    },
    {
      title: "credentials bound to this machine",
      body:
        "A vault entry copied to another laptop should not work there. The plan is to wrap each stored secret with a machine-bound key before it reaches Credential Manager, so the entry is useless anywhere else.",
      status: "planned",
    },
    {
      title: "a smaller blast radius per card",
      body:
        "Project cards are spawned bypassed because that is what makes them useful. The hardening is per-card scope for the things the wall can gate: which accounts a card may spend, which services it may write to, and which folders a spawn may open.",
      status: "planned",
    },
    {
      title: "one record of what happened",
      body:
        "A chronicle row already names the host for every remotely born card. The plan is to extend that to every cross-machine verb, so a question about who did what has an answer that is not a scroll through five transcripts.",
      status: "planned",
    },
  ],
  hardened: [
    {
      title: "a second factor for the flyway",
      body:
        "Joining a flyway, and accepting work from another machine, now ask for a second factor. The wall key alone opens nothing, so a copied key is a key to a locked door.",
      status: "shipped",
    },
    {
      title: "credentials bound to this machine",
      body:
        "Each stored secret is wrapped with a machine-bound key before it reaches Credential Manager. Copying the vault to another laptop yields an entry that cannot be opened there.",
      status: "shipped",
    },
    {
      title: "a smaller blast radius per card",
      body:
        "Every card declares what it may reach, and the wall enforces it at spawn: accounts, services it may write to, folders it may open. The bypass flag still applies to the repository, and not to everything else.",
      status: "shipped",
    },
    {
      title: "one record of what happened",
      body:
        "Every cross-machine verb writes a chronicle row naming the host, the card and the person who answered. The record is the audit trail, not a second log.",
      status: "shipped",
    },
  ],
};

/** The wording above the facts, which changes with the stage. */
export const SECURITY_HEADLINE: Record<"current" | "hardened", string> = {
  current:
    "The model today is one key per flyway. That is the part to be honest about, and the next section is what replaces it.",
  hardened:
    "The flyway key is no longer enough on its own. Membership needs the key and a second factor, and a copied vault does not open on another machine.",
};

/** What the stolen-key demo says in each state. Pure, so the two halves of the
 *  story cannot drift from the drawing. */
export type TheftStep = { title: string; body: string };

export function theftStory(stage: "current" | "hardened", stolen: boolean, secondFactor: boolean): TheftStep {
  const guarded = stage === "hardened" || secondFactor;
  if (!stolen) {
    return {
      title: "nothing is stolen",
      body:
        "Every frame on the wire is sealed. The relay routes it by a room id it cannot read, and a machine that does not hold the key cannot open what it carries.",
    };
  }
  if (!guarded) {
    return {
      title: "the key is enough",
      body:
        "Anyone holding it can join the flyway, open a conversation, and ask any machine that accepts work to open a card. A card spawns with the permissions its project has, which is all of them.",
    };
  }
  return {
    title: "the key is not enough",
    body:
      "The key still opens the frames, and the join is refused without the second factor. The attacker has ciphertext and no membership, so joining, reading and spawning all stop at the door.",
  };
}

/* ── what comes next ────────────────────────────────────────────────────── */

export type NextItem = {
  title: string;
  body: string;
  when: string;
  tone: "now" | "next" | "later";
};

export const NEXT: readonly NextItem[] = [
  {
    title: "plugins",
    body:
      "Widgets, panels, skills and tool servers that a project can ship without a Volery release. The wall already knows how to draw a widget from a config and how to give a card a skill. The missing piece is a registry and a signature, which is designed in .claude/rules/roster.md and not built.",
    when: "designed",
    tone: "next",
  },
  {
    title: "skills, connectors and MCPs from the app",
    body:
      "A card can be given a skill and a project can share an MCP server today, but both are files somebody edits. The next step is a panel: add a skill, add a connector, add an MCP server, see what it may reach, and turn it off. The wall already knows how to carry the capability; what is missing is a way to choose it from inside the app, and a registry so other people can publish one.",
    when: "next",
    tone: "next",
  },
  {
    title: "volery as an MCP server",
    body:
      "The same tools a card calls today, offered to anything that speaks MCP. Codex, an IDE agent, a phone, or a script could read the wall, send a prompt, ask a question and wait for the answer. Volery stops being the only place the flock can be driven from.",
    when: "next",
    tone: "next",
  },
  {
    title: "models on azure",
    body:
      "A card already rides whichever Anthropic-compatible endpoint its provider points at, which is how DeepSeek works today. An Azure-hosted model is the next row in that table: per-card provider and model, billed to the organisation, with the Claude allowance no longer the ceiling. It needs an endpoint that speaks the same API, or an adapter if it does not.",
    when: "next",
    tone: "next",
  },
  {
    title: "more surfaces",
    body:
      "The phone already links the flyway core and can answer a question. Screens go the other way: a machine's display on the wall. Both are the same wire, so the next surface costs a client rather than a protocol.",
    when: "in progress",
    tone: "now",
  },
  {
    title: "a wall you can stand in",
    body:
      "A 3D mode gives the wall depth: territories as layers, cards at different distances, plans as strands in space. VR is the same scene with a headset as the display, through WebXR where the runtime exists. Neither changes what a card is; both change how much of the flock you can hold in view at once.",
    when: "later",
    tone: "later",
  },
];

/* ── the opening demo ───────────────────────────────────────────────────── */

/** What a terminal does to nine conversations, said in three beats. Each beat
 *  is a state the opening demo can be clicked through, so the claim is shown
 *  once and then left alone. */
export const TABS_STORY: readonly { title: string; body: string }[] = [
  {
    title: "nine tabs",
    body:
      "Every agent is a tab. The tab tells you the session is open and nothing else: not whether it is working, not whether it asked you something, not whether it is waiting on a lock.",
  },
  {
    title: "one at a time",
    body:
      "Reading a tab means leaving the one you were in. Checking on nine costs nine switches, and the one that asked a question twenty minutes ago looks exactly like the one that finished an hour ago.",
  },
  {
    title: "the wall",
    body:
      "The same nine processes, laid out and coloured by state. Anything amber needs you. Anything celadon is moving. You can see that from across the room, and you can still open any of them.",
  },
] as const;
