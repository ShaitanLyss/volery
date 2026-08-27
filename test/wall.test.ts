/* The wall, driven from outside.
 *
 * Every other test in this repo checks a pure function. This one checks the
 * running app: it talks to the control surface over loopback and asserts on what
 * the studio actually holds and actually renders. That distinction earned its
 * keep immediately — the first two bugs it found were an op that silently
 * spawned two agents, and a wall whose DOM disagreed with its own model.
 *
 * Excluded from the default `bun test` run: it needs a Skein to be running.
 *
 *   $env:SKEIN_CONTROL="1"; bun run tauri dev      # in one terminal
 *   bun run test:wall                              # in another
 *
 * Add SKEIN_CONTROL_INPUT="1" to also run the two tests that move the real
 * cursor. They are skipped by default, because they steal focus and click
 * wherever the card happens to be — fine when you are watching, hostile when
 * you are typing in another window.
 *
 * SAFETY: every conversation this suite creates lives under .scratch, and
 * afterAll closes anything open there. Nothing outside .scratch is touched, so
 * running this cannot disturb real work on the wall.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.env.APPDATA ?? "", "dev.skein.studio");
const CONTROL = join(DIR, "control.json");
const DB = join(DIR, "skein.db");

/** The checkout this suite is driving. Named once rather than three times: two
 *  constants below already assumed it, and the file-viewer tests need it a third
 *  time to open a real file — a wrong spelling in one of three places is a
 *  failure that reads as the app rather than as the path. */
const REPO = "C:\\atelier\\skein";
/** The only place this suite is allowed to create anything. */
const SCRATCH = join(REPO, ".scratch");
const WALL = join(SCRATCH, "wall");
/** A real image, already in the repo from the icon work. */
const IMAGE = join(REPO, "src-tauri", "icons", "128x128.png");

type Reply = Record<string, any>;

let ep: { port: number; token: string } | null = null;
let health: Reply | null = null;

if (existsSync(CONTROL)) {
  ep = await Bun.file(CONTROL).json();
  health = await fetch(`http://127.0.0.1:${ep!.port}/health`)
    .then((r) => r.json() as Promise<Reply>)
    /* A stale control.json is exactly what `cleanup()` on exit is meant to
       prevent, but an older build may still have left one behind. */
    .catch(() => null);
}

const live = !!health?.attached;
const armed = live && !!health?.inputArmed;

if (!live) {
  console.log(
    "\n  Skein is not running with a control surface, so these are skipped.\n" +
      '    $env:SKEIN_CONTROL="1"; bun run tauri dev\n',
  );
} else if (!armed) {
  console.log(
    "\n  Real-input tests skipped. To include them:\n" +
      '    $env:SKEIN_CONTROL_INPUT="1"   (with SKEIN_CONTROL=1)\n',
  );
}

/** Runs when a Skein is there to answer. */
const t = live ? test : test.skip;
/** Runs only when the mouse has been explicitly lent to us. */
const ti = armed ? test : test.skip;

async function ctl(op: string, body: Reply = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${ep!.port}/op`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Skein-Token": ep!.token },
    body: JSON.stringify({ op, ...body }),
  });
  const v = (await res.json()) as Reply;
  /* Refuse to assert on a ghost. If a superseded studio answered, the app has
     been hot-reloaded and every number in this reply describes a component tree
     that is no longer on screen. */
  if (v.gen !== undefined && health!.generation !== undefined && v.gen !== health!.generation) {
    throw new Error(
      `${op} was answered by studio generation ${v.gen}, but the newest is ` +
        `${health!.generation}. The front end was hot-reloaded — restart it.`,
    );
  }
  if (v.ok === false) throw new Error(`${op}: ${v.error}`);
  return v;
}

/** Poll until a predicate holds, so a test never sleeps longer than it must. */
async function until<T>(
  what: string,
  get: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T;
  for (;;) {
    last = await get();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last was ${JSON.stringify(last)}`);
    }
    await Bun.sleep(120);
  }
}

const snapshot = () => ctl("snapshot");
const cardOf = async (id: string) => (await ctl("card", { id })).card;

/** Conversation rows the studio would restore, straight from SQLite. The point
 *  of going behind the app is that "one card appeared" and "one row was written"
 *  are different claims, and the bug this suite was built for satisfied one. */
function openRows(under = SCRATCH): { id: string; cwd: string }[] {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .query(
        `SELECT id, cwd FROM conversation
          WHERE closed_at IS NULL AND cwd LIKE ?1 ORDER BY born_at`,
      )
      .all(`${under}%`) as { id: string; cwd: string }[];
  } finally {
    db.close();
  }
}

/** The shared scratch card, for tests that only need something to talk to. */
let card = "";
const opened: string[] = [];
const placed: string[] = [];
const hung: string[] = [];

async function newCard(): Promise<string> {
  const { id } = await ctl("open", { dir: WALL });
  expect(id).toBeTruthy();
  opened.push(id);
  return id;
}

beforeAll(async () => {
  if (!live) return;
  mkdirSync(WALL, { recursive: true });
  card = await newCard();
});

afterAll(async () => {
  if (!live) return;
  for (const id of placed) await ctl("image.remove", { id }).catch(() => {});
  /* Instruments are hung on the real wall, not under `.scratch`, so they are the
     one thing this suite leaves standing if it forgets them. */
  for (const id of hung) await ctl("widget.remove", { id }).catch(() => {});
  /* Close everything under .scratch, not just what we opened — that also sweeps
     up any leftovers from an earlier run that died before its afterAll. */
  const snap = await snapshot().catch(() => null);
  for (const c of snap?.cards ?? []) {
    if (typeof c.cwd === "string" && c.cwd.startsWith(SCRATCH)) {
      await ctl("close", { id: c.id }).catch(() => {});
    }
  }
  /* And take the territories with them. A project now outlives its last card
     on purpose, which means a suite that only closed its cards would leave a
     `.scratch` territory on the real wall after every run. */
  const after = await snapshot().catch(() => null);
  for (const p of after?.projects ?? []) {
    if (typeof p.root === "string" && p.root.startsWith(SCRATCH)) {
      await ctl("forget", { cwd: p.root }).catch(() => {});
    }
  }
});

/* ── the harness telling the truth about itself ───────────────────────── */

t("only the newest studio answers, so a reply describes what is on screen", async () => {
  expect(health!.attached).toBe(true);
  const snap = await snapshot();
  /* ctl() already fails on a mismatch; asserting it here names the guarantee. */
  expect(snap.gen).toBe(health!.generation);
  if (health!.attachments > 1) {
    console.log(
      `  note: ${health!.attachments} studios have attached this session ` +
        `(hot reloads); generation ${health!.generation} is serving.`,
    );
  }
});

t("every card in the model is a card on the wall", async () => {
  const snap = await snapshot();
  const model = snap.cards.map((c: Reply) => c.id).sort();
  const painted = snap.dom.cardNodes.map((n: Reply) => n.id).sort();
  /* The assertion that would have caught the hot-reload fork in one line: a
     forked app keeps two models and renders only one of them. */
  expect(painted).toEqual(model);
});

/* ── opening ─────────────────────────────────────────────────────────── */

t("one open makes exactly one card and exactly one row", async () => {
  const rowsBefore = openRows().length;
  const cardsBefore = (await snapshot()).cards.length;

  await newCard();

  expect((await snapshot()).cards.length).toBe(cardsBefore + 1);
  /* The regression: a duplicated op handler spawned two agents and wrote two
     rows while reporting one card, because only the first reply was accepted. */
  expect(openRows().length).toBe(rowsBefore + 1);
});

t("a freshly opened card is awake, with nothing to resume", async () => {
  const c = await cardOf(card);
  /* Left dormant, `send` would try to wake an already-running process and the
     first message to every new conversation would be undeliverable. */
  expect(c.dormant).toBe(false);
  expect(c.everSpoke).toBe(false);
  expect(c.activity).toBe("ready");
  expect(c.interrupted).toBe(false);
});

/* ── the context ring ────────────────────────────────────────────────── */

t("context occupancy is the last assistant usage, never the cumulative result", async () => {
  const held = 182_000;
  await ctl("feed", {
    id: card,
    event: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "most of the way through the window" }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 180_000,
          cache_creation_input_tokens: 1_000,
          output_tokens: 900,
        },
      },
    },
  });

  let c = await cardOf(card);
  expect(c.ctxTokens).toBe(held);
  expect(c.ctx).toBeCloseTo(held / c.contextWindow, 5);

  /* `result.usage` sums every iteration of the turn — a probe measured 51,140
     cache_read across a turn whose final request held 29,128. Reading it here
     would peg the ring, so the fold must ignore it. */
  await ctl("feed", {
    id: card,
    event: {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.42,
      usage: { input_tokens: 5, cache_read_input_tokens: 900_000, output_tokens: 4_000 },
    },
  });

  c = await cardOf(card);
  expect(c.ctxTokens).toBe(held);
  expect(c.costUsd).toBeCloseTo(0.42, 5);
  expect(c.turns).toBe(1);
  expect(c.everSpoke).toBe(true);
});

t("a 1M session is not reported as a 200k one", async () => {
  const wide = await newCard();

  /* The wire says two different things about one session. `system/init` reports
     the configured model, tier and all; every assistant message then reports
     the bare API name, because `[1m]` is Claude Code's notation for the beta
     window rather than part of the model's name. Probed against 2.1.227. */
  await ctl("feed", {
    id: wide,
    event: { type: "system", subtype: "init", model: "claude-opus-5[1m]" },
  });
  expect((await cardOf(wide)).contextWindow).toBe(1_000_000);

  await ctl("feed", {
    id: wide,
    event: {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "a while into the work" }],
        usage: { input_tokens: 81, cache_read_input_tokens: 92_000 },
      },
    },
  });

  const c = await cardOf(wide);
  expect(c.ctxTokens).toBe(92_081);
  /* The bug: the bare id narrowed the window to 200k, so 92,081 tokens read as
     46% of a session that was really 9% full. */
  expect(c.contextWindow).toBe(1_000_000);
  expect(c.ctx).toBeCloseTo(0.092, 3);

  /* A genuinely different model *is* adopted — a fallback taking the request is
     real news about the window, unlike a dropped tier suffix. */
  await ctl("feed", {
    id: wide,
    event: {
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "fell back" }],
        usage: { input_tokens: 1_000 },
      },
    },
  });
  expect((await cardOf(wide)).contextWindow).toBe(200_000);
});

/* ── your half of the conversation ───────────────────────────────────── */

t("what you said is in the transcript, and the turn starts when it lands", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  /* The acknowledgement: --replay-user-messages re-emits what went to stdin,
     flagged isReplay. Nothing was sent from this window, so no drawn line is
     waiting for it — which is also the shape of a prompt typed into a terminal
     against the same session, and it lands in the transcript either way. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "read package.json" }] },
      parent_tool_use_id: null,
      isReplay: true,
    },
  });

  const c = await cardOf(mine);
  expect(c.lines.at(-1)).toEqual({ kind: "you", text: "read package.json" });
  /* The card goes live the moment your words land, not seconds later when the
     first token comes back. */
  expect(c.working).toBe(true);

  /* And it is on screen, distinguishable from what the agent said. */
  const painted = await ctl("dom", { selector: ".detail .line.you" });
  expect(painted.count).toBe(1);
  expect(painted.nodes[0].text).toBe("read package.json");

  /* A tool result arrives as a user message too, and is not speech. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_nothing", content: "1\t{...}" }],
      },
      parent_tool_use_id: null,
    },
  });
  expect((await cardOf(mine)).lines.at(-1)).toEqual({ kind: "you", text: "read package.json" });
});

t("your words are on the wall before the process has them", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  /* Dormant, so delivery has a process to spawn and a session to resume before
     anything can be written to stdin. That second is precisely what the
     transcript used to swallow. */
  await ctl("exit", { id: mine, code: 0 });
  expect((await cardOf(mine)).dormant).toBe(true);

  const text = "Reply with the single word: ok";
  /* Deliberately not awaited: what is being asserted is what the panel holds
     while the send is still in flight. The control surface answers each request
     on its own thread, so `card` gets a look in. */
  const sending = ctl("send", { id: mine, text });

  const mid = await until(
    "your words to appear before the send has landed",
    () => cardOf(mine),
    (c: Reply) => c.lines.some((l: Reply) => l.kind === "you" && l.text === text),
    4000,
  );
  const drawn = mid.lines.filter((l: Reply) => l.kind === "you" && l.text === text);
  expect(drawn.length).toBe(1);
  /* Drawn, and drawn as unacknowledged. Both halves are reported together: a
     settled line here would mean the spawn beat the first poll (milliseconds
     against hundreds of them), not that the early draw had been skipped. */
  expect({ state: drawn[0].state, dormant: mid.dormant }).toEqual({
    state: "pending",
    dormant: true,
  });
  const painted = await ctl("dom", { selector: ".detail .line.you.pending" });
  expect(painted.count).toBe(1);

  await sending;

  /* The echo claims the line already standing there rather than pushing a
     second copy of it — which is the whole risk of drawing early. */
  const after = await until(
    "the prompt to be acknowledged",
    () => cardOf(mine),
    (c: Reply) =>
      c.lines.some((l: Reply) => l.kind === "you" && l.text === text && !l.state),
    15_000,
  );
  expect(
    after.lines.filter((l: Reply) => l.kind === "you" && l.text === text).length,
  ).toBe(1);
});

/* ── what the agent said, folded into markdown ────────────────────────── */

t("the agent's markdown is rendered as elements, not printed as punctuation", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  const said = [
    "## the plan",
    "",
    "read `store.rs`, then **stop**.",
    "",
    "- one",
    "- two",
    "",
    "```rust",
    "let x = 1;",
    "```",
    "",
    "| file | what |",
    "| --- | --- |",
    "| a.ts | one |",
  ].join("\n");

  await ctl("feed", {
    id: mine,
    event: { type: "assistant", message: { content: [{ type: "text", text: said }] } },
  });

  const sel = ".detail .line.md";
  await until("the folded line to paint", () => ctl("dom", { selector: sel }), (r) => r.count > 0);

  /* Every shape it contains, on screen as itself. The bug this replaces: all of
     it arrived as one pre-wrap block of literal hashes, asterisks and pipes. */
  for (const child of [".h", "p", "ul li", "pre code", "table td", "strong", "p code"]) {
    const found = await ctl("dom", { selector: `${sel} ${child}` });
    expect([child, found.count > 0]).toEqual([child, true]);
  }

  /* And the punctuation is gone from the text — the marks became the shapes. */
  const line = (await ctl("dom", { selector: sel })).nodes[0];
  expect(line.text).not.toContain("##");
  expect(line.text).not.toContain("**");
  expect(line.text).toContain("the plan");

  /* A code fence keeps its contents verbatim, including the marks. */
  const code = await ctl("dom", { selector: `${sel} pre code` });
  expect(code.nodes[0].text).toContain("let x = 1;");
});

t("a link is a button, so following one cannot navigate the studio away", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  await ctl("feed", {
    id: mine,
    event: {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "see [the docs](https://example.com/x) and also <script>x</script>" },
        ],
      },
    },
  });

  const links = await until(
    "the link to paint",
    () => ctl("dom", { selector: ".detail .line.md button.link" }),
    (r) => r.count > 0,
  );
  expect(links.nodes[0].text).toBe("the docs");
  /* An `<a href>` in an undecorated window with no address bar is a one-way
     trip out of the app, so there must not be one. */
  expect((await ctl("dom", { selector: ".detail .line.md a" })).count).toBe(0);
  /* Nodes, not html: a transcript is not a document anybody chose to trust. */
  expect((await ctl("dom", { selector: ".detail .line.md script" })).count).toBe(0);
  expect((await ctl("dom", { selector: ".detail .line.md" })).nodes[0].text).toContain(
    "<script>",
  );
});

t("the ring warms to the failing colour as the window fills", async () => {
  const root = await ctl("dom", { selector: ":root", styles: ["--st-fail", "--st-work"] });
  const fail = root.nodes[0].styles["--st-fail"];
  const work = root.nodes[0].styles["--st-work"];
  expect(fail).not.toBe(work);

  const ring = async () => {
    const r = await ctl("dom", {
      selector: `[data-conv="${card}"] .ring .fill`,
      styles: ["stroke"],
    });
    expect(r.count).toBe(1);
    return r.nodes[0].styles.stroke;
  };

  /* The previous test left this card at 91%, which is past the 0.85 threshold. */
  const hot = await ring();

  const fresh = await newCard();
  await ctl("feed", {
    id: fresh,
    event: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "barely started" }],
        usage: { input_tokens: 4_000 },
      },
    },
  });
  const cool = await ctl("dom", {
    selector: `[data-conv="${fresh}"] .ring .fill`,
    styles: ["stroke"],
  });

  /* Colour, not a number in a corner: a card at 91% must not look like one at
     2%, whatever the tokens say. */
  expect(hot).not.toBe(cool.nodes[0].styles.stroke);
});

/* ── the committee ───────────────────────────────────────────────────── */

t("a committee takes seats, thinks aloud, then collapses to one line", async () => {
  const seat = await newCard();
  const personas = ["skeptic", "architect", "user-advocate"];

  /* One `Task` block per seat, exactly as the stream carries it. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "assistant",
      message: {
        content: personas.map((p, i) => ({
          type: "tool_use",
          id: `toolu_${i}`,
          name: "Task",
          input: { subagent_type: p, description: `ask the ${p}` },
        })),
        usage: { input_tokens: 2_000 },
      },
    },
  });

  let c = await cardOf(seat);
  expect(c.seats.map((s: Reply) => s.persona)).toEqual(personas);
  expect(c.seats.every((s: Reply) => s.state === "spawning")).toBe(true);

  /* A seat is only rendered above the card once it exists, so this is where the
     thought bubbles either appear or quietly don't. */
  const painted = await ctl("dom", { selector: `[data-conv="${seat}"] [data-seat]` });
  expect(painted.count).toBe(personas.length);

  /* `--forward-subagent-text` re-emits a subagent's words tagged with the
     parent tool call, which is the only thing tying a thought to a seat. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "text", text: "The seam is in the wrong place." }] },
    },
  });

  c = await cardOf(seat);
  const architect = c.seats.find((s: Reply) => s.persona === "architect");
  expect(architect.state).toBe("thinking");
  expect(architect.thought).toContain("seam");
  /* The others have not spoken, so they stay dim rather than inventing a line. */
  expect(c.seats.find((s: Reply) => s.persona === "skeptic").state).toBe("spawning");

  /* A tool_result addressed to a seat is that subagent reporting in. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Move it behind the parser." },
        ],
      },
    },
  });
  c = await cardOf(seat);
  const done = c.seats.find((s: Reply) => s.persona === "architect");
  expect(done.state).toBe("done");
  expect(done.verdict).toContain("parser");

  /* The arc dissolves back into the card, leaving one line behind. */
  await ctl("feed", { id: seat, event: { type: "result", subtype: "success" } });
  c = await cardOf(seat);
  expect(c.seats).toHaveLength(0);
  expect(c.lastLine).toContain("seats · synthesised");
  expect((await ctl("dom", { selector: `[data-conv="${seat}"] [data-seat]` })).count).toBe(0);
});

/* ── the question that actually blocks ───────────────────────────────── */

t("a question parked over MCP blocks the card, raises the peek, and resumes on an answer", async () => {
  const asked = await newCard();
  const answer = "Take the second one.";

  /* The real round trip: this is a `tools/call` to the same endpoint every
     conversation gets pointed at with --mcp-config, and it must stay open. */
  const call = fetch(`http://127.0.0.1:${health!.mcpPort}/mcp/${asked}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: {
          question: "Fold the parser into the classifier, or keep the seam?",
          options: [{ label: "Keep the seam" }, { label: "Fold it in" }],
        },
      },
    }),
  });

  const blocked = await until(
    "the card to report a parked question",
    () => cardOf(asked),
    (c) => !!c.pendingAsk,
  );
  expect(blocked.pendingAsk.question).toContain("seam");
  expect(blocked.pendingAsk.options).toEqual(["Keep the seam", "Fold it in"]);
  /* The agent asked this one, so it is not Skein's. Pinned here because the two
     kinds of parked call are otherwise identical from outside and they differ in
     where the answer ends up: an agent's `ask_user` is answered into the
     transcript, and a question Skein composed — `close` wanting approval for a
     card the caller did not open — is answered into the tool result instead,
     with no line drawn. A flipped default would send a test looking in the
     wrong one of the two places. */
  expect(blocked.pendingAsk.ours).toBe(false);
  /* Loudest thing a card can be: not an inference from silence, a fact. */
  expect(blocked.tier).toBe("ask");

  const snap = await snapshot();
  expect(snap.blocked).toContain(asked);
  expect(snap.dom.askOpen).toBe(true);

  /* The peek only exists for when you are somewhere else, so it can only be
     tested from somewhere else — which is exactly where this suite runs. */
  if (snap.attention.windowFocused) {
    console.log("  note: Skein is the focused window, so the peek is not asserted.");
  } else {
    const peek = await until(
      "the peek window to appear",
      () => ctl("peek"),
      (p) => p.visible === true,
    );
    expect(peek.exists).toBe(true);
  }

  await ctl("answer", { id: asked, text: answer });

  /* The turn resumes from where it stopped: same request, answered. */
  const body = (await call.then((r) => r.json())) as Reply;
  expect(body.result.content[0].text).toBe(answer);

  const after = await cardOf(asked);
  expect(after.pendingAsk).toBeNull();
  expect(after.tier).not.toBe("ask");
  /* And the decision is on the page. The question is asked in the dock and goes
     the moment it is answered, so without this line the transcript carries the
     agent asking and then acting with what you said nowhere between them. */
  expect(after.lines).toContainEqual({ kind: "answer", text: answer });
  if (!snap.attention.windowFocused) {
    await until("the peek to withdraw", () => ctl("peek"), (p) => p.visible === false, 4000);
  }
});

t("several questions in one call are stepped through and answered together", async () => {
  const asked = await newCard();

  /* One `tools/call` carrying two independent decisions — the shape that
     previously forced the agent to fuse them into a cross-product of options
     and silently omit half the combinations. */
  const call = fetch(`http://127.0.0.1:${health!.mcpPort}/mcp/${asked}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: {
          questions: [
            {
              header: "shape",
              question: "One widget with variants, or two separate ones?",
              options: [{ label: "two widgets" }, { label: "one widget" }],
            },
            {
              header: "attention",
              question: "Should a finished timer join the attention ladder?",
              options: [{ label: "yes" }, { label: "keep it silent" }],
            },
          ],
        },
      },
    }),
  });

  const blocked = await until(
    "the card to report a parked question",
    () => cardOf(asked),
    (c) => !!c.pendingAsk,
  );
  expect(blocked.pendingAsk.count).toBe(2);
  expect(blocked.pendingAsk.headers).toEqual(["shape", "attention"]);
  /* The panel shows one at a time, and it starts on the first. */
  expect(blocked.pendingAsk.step).toBe(0);
  expect(blocked.pendingAsk.question).toContain("One widget with variants");
  expect(blocked.tier).toBe("ask");

  /* Out of order, because there is no order: these two decisions are
     independent, which is why they were asked in one call rather than two.
     Answering the second first must simply work. */
  const jumped = await ctl("answer", { id: asked, at: 1, text: "yes" });
  expect(jumped.sent).toBe(false);
  expect(jumped.answers).toEqual([null, "yes"]);
  /* The first is still outstanding, so that is where the panel sits. */
  expect(jumped.step).toBe(0);

  const mid = await cardOf(asked);
  expect(mid.pendingAsk).not.toBeNull();
  expect(mid.pendingAsk.question).toContain("One widget with variants");
  /* Half answered is still genuinely blocked: one `tools/call` is one reply,
     so the turn stays stopped until every question has one. */
  expect(mid.tier).toBe("ask");

  /* Answering the last outstanding one does not send either — it lands on the
     review, where every pair is on screen together and any can still be
     changed. Reading one question is often what changes your mind about
     another, so the send is its own act. */
  const second = await ctl("answer", { id: asked, text: "two widgets" });
  expect(second.sent).toBe(false);
  expect(second.reviewing).toBe(true);
  expect(second.answers).toEqual(["two widgets", "yes"]);

  /* And the revision genuinely works: go back to the first and change it. */
  const revised = await ctl("answer", { id: asked, at: 0, text: "one widget" });
  expect(revised.sent).toBe(false);
  expect(revised.answers).toEqual(["one widget", "yes"]);

  const sent = await ctl("answer", { id: asked, send: true });
  expect(sent.sent).toBe(true);

  /* Composed with each question's header, so the model cannot mis-pair an
     answer with the decision it belongs to. */
  const body = (await call.then((r) => r.json())) as Reply;
  const text = body.result.content[0].text;
  /* In the order they were asked, whatever order they were answered in. */
  expect(text).toContain("1. shape: one widget");
  expect(text).toContain("2. attention: yes");
  /* The answer that was revised away is not still in there. */
  expect(text).not.toContain("two widgets");

  const after = await cardOf(asked);
  expect(after.pendingAsk).toBeNull();
  expect(after.tier).not.toBe("ask");
  /* The pairs, kept in the transcript without the preamble the model is sent —
     the sheet is one reply, so it is one line under the call that asked. */
  expect(after.lines).toContainEqual({
    kind: "answer",
    text: "1. shape: one widget\n2. attention: yes",
  });
});

/* ── reference images ────────────────────────────────────────────────── */

t("a dropped image lands where it was aimed", async () => {
  const before = (await snapshot()).images.length;

  /* Where the drop is aimed, in CSS pixels. The op converts to the physical
     pixels the OS payload actually carries, so the 1.5x on a 150% display is
     under test rather than assumed. */
  const at = { x: 520, y: 360 };
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  const view = (await snapshot()).viewport;

  const res = await ctl("drop", { path: IMAGE, ...at });
  expect(res.fault).toBeNull();
  expect(res.images).toBe(before + 1);

  const snap = await snapshot();
  expect(snap.images).toHaveLength(before + 1);
  const img = snap.images[snap.images.length - 1];
  placed.push(img.id);

  /* An image is dropped centred on the cursor: you aimed at a spot, not a
     corner. Off by devicePixelRatio, this lands a third of a screen away. */
  const want = {
    x: (at.x - surface.x - view.x) / view.scale,
    y: (at.y - surface.y - view.y) / view.scale,
  };
  expect(img.x + img.w / 2).toBeCloseTo(want.x, 0);
  expect(img.y + img.h / 2).toBeCloseTo(want.y, 0);

  /* It arrives at its own aspect ratio rather than a guessed box. */
  expect(img.w).toBe(img.h);
  expect(img.w).toBeGreaterThan(0);
  expect((await ctl("dom", { selector: `[data-image="${img.id}"]` })).count).toBe(1);
});

t("a pasted image lands under the cursor", async () => {
  const before = (await snapshot()).images.length;

  /* Ctrl+V carries no position of its own, so the cursor is the whole of the
     answer — which is why the op moves it with a real pointermove first rather
     than handing the coordinates to the paste. Offsets here are inside the
     surface, as `wheel`'s are. */
  const at = { x: 300, y: 220 };
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  const view = (await snapshot()).viewport;

  const res = await ctl("image.paste", at);
  expect(res.fault).toBeNull();
  expect(res.added).toBe(1);

  const snap = await snapshot();
  expect(snap.images).toHaveLength(before + 1);
  const img = snap.images[snap.images.length - 1];
  placed.push(img.id);

  const want = { x: (at.x - view.x) / view.scale, y: (at.y - view.y) / view.scale };
  expect(img.x + img.w / 2).toBeCloseTo(want.x, 0);
  expect(img.y + img.h / 2).toBeCloseTo(want.y, 0);
  expect(surface.width).toBeGreaterThan(at.x);

  /* The bytes really became a file the asset protocol will serve: the node is
     on the wall, and it was sized from the decoded image rather than from the
     fallback box a failed decode gives. */
  expect((await ctl("dom", { selector: `[data-image="${img.id}"]` })).count).toBe(1);
  expect(img.w).toBe(1);
  expect(img.h).toBe(1);
});

t("pasting text into the draft is still pasting text", async () => {
  const before = (await snapshot()).images.length;

  /* Copying from a web page puts an image *and* text on the clipboard. Into the
     draft that means the words — a picture pinned to the wall instead would be
     an ordinary ctrl+V doing something nobody asked for. */
  const res = await ctl("image.paste", { into: "draft", text: "some words" });
  expect(res.added).toBe(0);
  expect((await snapshot()).images).toHaveLength(before);
});

/* ── waking ──────────────────────────────────────────────────────────── */

t("a card that believes it is dormant recovers when the supervisor disagrees", async () => {
  const sleeper = await newCard();
  /* Convince the card its process is gone. The process is in fact still there,
     which is precisely the state that used to deadlock: `send` called `wake`,
     `wake` spawned again, and the supervisor refused because it was already
     open — so the message was never delivered. */
  await ctl("exit", { id: sleeper, code: 0 });
  expect((await cardOf(sleeper)).dormant).toBe(true);

  const sent = await ctl("send", { id: sleeper, text: "Reply with the single word: ok" });
  expect(sent.fault).toBeNull();
  expect((await cardOf(sleeper)).dormant).toBe(false);
});

/* ── real input ──────────────────────────────────────────────────────── *
 *
 * A dispatched `pointerdown` proves the handlers are wired to each other. It
 * cannot see Chromium retargeting a *real* click after setPointerCapture, which
 * is the bug that shipped here twice: first the close button stopped working,
 * then clicking a card stopped focusing it. Only the real cursor finds that. */

ti("a real click on the close control removes the card", async () => {
  const doomed = await newCard();
  const sel = `[data-conv="${doomed}"]`;

  /* The control is opacity 0 until the card is hovered, so it has no business
     being clicked before the mouse is actually over the card. */
  await ctl("real.hover", { selector: sel });
  /* The control fades in over 150ms, and getComputedStyle mid-transition returns
     the interpolated value — so read it after the transition, not during. */
  await Bun.sleep(250);
  const shut = await ctl("dom", { selector: `${sel} .shut`, styles: ["opacity"] });
  expect(shut.count).toBe(1);
  expect(Number(shut.nodes[0].styles.opacity)).toBeGreaterThan(0.5);

  await ctl("real.click", { selector: `${sel} .shut` });

  await until(
    "the card to leave the wall",
    () => snapshot(),
    (s) => !s.cards.some((c: Reply) => c.id === doomed),
  );
  expect((await ctl("dom", { selector: sel })).count).toBe(0);
});

ti("a nudge focuses the card, a real drag pins it", async () => {
  const moved = await newCard();
  const sel = `[data-conv="${moved}"]`;

  /* Opening a card focuses it, so focus has to go elsewhere first or the
     assertion below passes without the click having done anything. */
  const other = (await snapshot()).cards.find((c: Reply) => c.id !== moved);
  await ctl("focus", { id: other.id });
  expect((await snapshot()).focusedId).not.toBe(moved);

  /* Under the 4px slop this is a click, not a drag — and a click focuses. */
  await ctl("real.drag", { selector: sel, dx: 3, dy: 0, steps: 3 });
  let snap = await snapshot();
  expect(snap.focusedId).toBe(moved);
  expect(snap.cards.find((c: Reply) => c.id === moved).placement).toBeNull();

  const from = (await ctl("dom", { selector: sel })).nodes[0].rect;
  await ctl("real.drag", { selector: sel, dx: 140, dy: 60 });

  snap = await snapshot();
  const placement = snap.cards.find((c: Reply) => c.id === moved).placement;
  /* Past the slop it is a drag: the card earns a pin and keeps the position. */
  expect(placement).not.toBeNull();
  expect(placement.pinned).toBe(true);

  const to = (await ctl("dom", { selector: sel })).nodes[0].rect;
  expect(to.x - from.x).toBeCloseTo(140, -1);
  expect(to.y - from.y).toBeCloseTo(60, -1);

  /* And the pin outlives the app, so it has to have reached SQLite. */
  const db = new Database(DB, { readonly: true });
  const row = db
    .query("SELECT x, y, pinned FROM placement WHERE conversation_id = ?1")
    .get(moved) as Reply | null;
  db.close();
  expect(row).not.toBeNull();
  expect(row!.pinned).toBe(1);
});

t("a card's transcript is read for it, without being asked", async () => {
  const fresh = await newCard();
  /* Nothing focused, no panel opened, no agent woken: reading a transcript
     spawns nothing, so the wall does it as it loads rather than waiting for a
     click. `none` here is the right answer — a session that has never spoken
     has no file — and what matters is that it is no longer `unread`. */
  const c = await until(
    "the card to have been read for",
    () => cardOf(fresh),
    (c: Reply) => c.historyState !== "unread",
    4000,
  );
  expect(["none", "ready"]).toContain(c.historyState);
});

/* ── starting a card over ────────────────────────────────────────────── */

t("clearing keeps the card and swaps the session behind it", async () => {
  const id = await newCard();
  /* Give it a turn to have something to clear — fed rather than spoken, so
     this costs no tokens and no seconds. */
  await ctl("feed", {
    id,
    event: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "some work happened here" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 60_000 },
      },
    },
  });
  await ctl("feed", {
    id,
    event: { type: "result", subtype: "success", total_cost_usd: 0.2 },
  });
  await ctl("send", { id, text: "name this card" }).catch(() => {});

  const before = await cardOf(id);
  expect(before.everSpoke).toBe(true);
  expect(before.ctxTokens).toBeGreaterThan(0);
  expect(before.sessionId).toBe(id);

  const cleared = await ctl("clear", { id });
  expect(cleared.was).toBe(id);
  expect(cleared.sessionId).not.toBe(id);
  expect(cleared.sessionId).toMatch(/^[0-9a-f-]{36}$/);

  const after = await cardOf(id);
  /* The card is the thing that survives: same id, so its placement, its turns
     and its file touches all still point at it. Only the conversation it is
     holding was replaced. */
  expect(after.id).toBe(id);
  expect(after.sessionId).toBe(cleared.sessionId);
  expect(after.ctxTokens).toBe(0);
  expect(after.costUsd).toBe(0);
  expect(after.title).toBe("untitled");
  expect(after.ending).toBeNull();
  /* False is what makes the next send spawn with `--session-id`: there is no
     transcript to `--resume` yet, and resuming an unwritten id is an error. */
  expect(after.everSpoke).toBe(false);
  expect(after.dormant).toBe(true);
  /* Not a crash. Killing the child gives it a non-zero exit code, and read as
     news that put "process exited with code 1" and a rust ending on the fresh
     session that had just replaced it. */
  expect(after.died).toBe(false);
  expect(after.lastError).toBeNull();

  /* And the row followed, so this survives a restart. */
  const db = new Database(DB, { readonly: true });
  try {
    const row = db
      .query("SELECT agent_session_id AS s, title, last_ending AS e FROM conversation WHERE id = ?1")
      .get(id) as Reply;
    expect(row.s).toBe(cleared.sessionId);
    expect(row.title).toBe("untitled");
    expect(row.e).toBeNull();
  } finally {
    db.close();
  }
});

t("a cleared card wakes into its new session, not the old one", async () => {
  const id = await newCard();
  await ctl("feed", { id, event: { type: "result", subtype: "success" } });
  const { sessionId } = await ctl("clear", { id });

  /* The card is dormant, so this spawns — with `--session-id <new>`. If the
     card id were still being handed to the CLI this would collide with the
     transcript the old session already wrote. */
  await ctl("send", { id, text: "hello" });
  const c = await until(
    "the cleared card to wake",
    () => cardOf(id),
    (c: Reply) => !c.dormant,
    15000,
  );
  expect(c.sessionId).toBe(sessionId);
  expect(c.lastError).toBeNull();
});

t("the dock runs a slash command instead of sending it, and only its own", async () => {
  const id = await newCard();
  await ctl("feed", { id, event: { type: "result", subtype: "success" } });
  await ctl("focus", { id });

  /* Typing a slash opens the palette; typing past what Skein knows closes it
     again. That closing is the whole safety property: `claude` has slash
     commands of its own — the built-ins, and everything in `.claude/commands/`
     — and they work in `--print` mode, so an unrecognised one has to reach the
     agent as the prompt it is. */
  await ctl("type", { text: "/" });
  expect((await snapshot()).commands).toContain("clear");
  await ctl("type", { text: "/cl" });
  expect((await snapshot()).commands).toEqual(["clear"]);
  await ctl("type", { text: "/commit" });
  expect((await snapshot()).commands).toEqual([]);

  /* Submitted with the palette lit, the key runs the command rather than
     sending the text — and the draft goes, as a sent prompt's would. */
  await ctl("type", { text: "/clear" });
  await ctl("submit", {});
  const c = await until(
    "the card to be cleared by the dock",
    () => cardOf(id),
    (c: Reply) => c.sessionId !== id,
    5000,
  );
  expect(c.everSpoke).toBe(false);
  expect((await snapshot()).draft).toBe("");
  /* Nothing was said to the agent: a command is not a prompt. */
  expect(c.lineCount).toBe(1);
  expect(c.lastLine).toContain("cleared");
});

t("a command that takes a value opens its values instead of running", async () => {
  const id = await newCard();
  await ctl("feed", { id, event: { type: "result", subtype: "success" } });
  await ctl("focus", { id });

  /* `/model` names a command and settles nothing: there is no such thing as
     running it. So the palette's first stage offers the name, and submitting
     it hands over to the second stage rather than doing anything to the card. */
  await ctl("type", { text: "/model" });
  let s = await snapshot();
  expect(s.commands).toEqual(["model"]);
  expect(s.choices).toEqual([]);

  await ctl("submit", {});
  s = await snapshot();
  /* The draft carries its space, which is what puts it in the second stage —
     and the card was not spoken to. */
  expect(s.draft).toBe("/model ");
  expect(s.commands).toEqual([]);
  expect(s.choices).toContain("opus[1m]");
  expect((await cardOf(id)).lineCount).toBe(0);

  /* The values narrow the way the names do, prefixes first. */
  await ctl("type", { text: "/model son" });
  expect((await snapshot()).choices).toEqual(["sonnet", "sonnet[1m]"]);

  /* And past the value the choosing really is over: `/model sonnet please` is
     a sentence, and the palette must not sit over it claiming otherwise. */
  await ctl("type", { text: "/model sonnet please" });
  s = await snapshot();
  expect(s.commands).toEqual([]);
  expect(s.choices).toEqual([]);

  /* Deliberately not submitted: sending one of the CLI's own commands spawns a
     real agent and spends a real turn, and the path it would take from here is
     the ordinary prompt path every other test already drives. */
  await ctl("type", { text: "" });
});

t("the CLI's own commands are offered but never intercepted", async () => {
  const id = await newCard();
  await ctl("feed", { id, event: { type: "result", subtype: "success" } });
  await ctl("focus", { id });

  /* The distinction `by` draws, seen from outside. `/compact` is listed — this
     window knows its shape and helps you type it — but carrying it out *is*
     sending it, so nothing here takes custody of it. What proves that is the
     absence of any Skein-side effect: `/clear` repoints the session, and
     `/compact` must leave the card exactly as it found it. */
  await ctl("type", { text: "/comp" });
  expect((await snapshot()).commands).toEqual(["compact"]);

  const before = await cardOf(id);
  await ctl("type", { text: "/compact focus on the auth work" });
  const s = await snapshot();
  /* Prose after the name closes the palette, as it always did. */
  expect(s.commands).toEqual([]);
  expect(s.choices).toEqual([]);
  const after = await cardOf(id);
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.lineCount).toBe(before.lineCount);

  await ctl("type", { text: "" });
});

/* ── adopting what claude recorded elsewhere ─────────────────────────── */

t("the adopt panel offers only sessions no card already points at", async () => {
  /* The chip toggles, so open by state rather than by clicking once and
     hoping — a suite that assumed the direction would pass or fail on whatever
     the previous test left behind. */
  if ((await ctl("dom", { selector: ".panel" })).count === 0) {
    await ctl("click", { selector: "[data-adopt]" });
  }
  await until(
    "the adopt panel",
    () => ctl("dom", { selector: ".panel" }),
    (r) => r.count === 1,
    4000,
  );
  const panel = await ctl("dom", { selector: ".panel .row" });

  /* Hermetic on any machine: the assertion is about the *relationship* between
     the list and the wall, not about which transcripts happen to exist here.
     Offering a session that is already a card is how you get two cards writing
     to one transcript.

     By `sessionId`, not `id`: they are the same for every card that has never
     been cleared, and for one that has, the id is not a session at all while
     the session it was cleared away from is *rightly* still on offer — putting
     it back is how a clear is undone. */
  const onWall = new Set((await snapshot()).cards.map((c: Reply) => c.sessionId));
  const offered = panel.nodes.map((n: Reply) => n.data.session);
  expect(offered.filter((id: string) => onWall.has(id))).toEqual([]);

  /* Every row is a real session id, not a placeholder. */
  for (const id of offered) expect(id).toMatch(/^[0-9a-f-]{36}$/);

  await ctl("key", { selector: ".panel", key: "Escape" });
  await until(
    "the panel to withdraw",
    () => ctl("dom", { selector: ".panel" }),
    (r) => r.count === 0,
    3000,
  );
});

/* ── navigating the wall ─────────────────────────────────────────────── */

t("the bare wheel zooms at the cursor, and shift pans", async () => {
  /* Put the camera back where it was found. The real-input tests below aim the
     OS cursor at whatever is under a selector, so a suite that left the wall
     somewhere else would have them clicking a neighbour's card. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  const inward = await ctl("wheel", { dy: -240, x: 300, y: 200 });
  expect(inward.viewport.scale).toBeGreaterThan(1);
  /* Zooming at a point moves the origin — anchoring at the cursor is the whole
     difference between this and a scale slider. */
  expect(inward.viewport.x).not.toBe(0);

  const outward = await ctl("wheel", { dy: 240, x: 300, y: 200 });
  expect(outward.viewport.scale).toBeLessThan(inward.viewport.scale);

  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  const panned = await ctl("wheel", { dy: 120, dx: 60, shift: true });
  expect(panned.viewport.scale).toBe(1);
  expect(panned.viewport).toMatchObject({ x: -60, y: -120 });

  await ctl("viewport", was);
});

t("the transformed layer covers the whole wall", async () => {
  /* Which is why "the ground" cannot mean the surface element alone: at rest
     the layer is exactly the viewport, so `e.target === surface` was true
     nowhere at all. Asserting the geometry names what made the bug possible. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  const layer = (await ctl("dom", { selector: ".layer" })).nodes[0].rect;
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  expect(layer).toMatchObject({ x: surface.x, y: surface.y, w: surface.w, h: surface.h });

  await ctl("viewport", was);
});

ti("the ground pans on the middle and right buttons, wherever the press lands", async () => {
  /* It read as "dragging works in some places" — the places being wherever the
     layer had been translated off, which is why the original bug survived so
     long. `.layer` is the whole viewport, so aiming at it is aiming at the case
     that used to be inert.

     Both of the buttons that pan, and neither of them is decoration: the left
     one now draws a selection band, so panning is *only* these two and a run
     that could make one of the gestures and not the other would be a run that
     could not tell whether the wall was still readable. The middle button is
     the harder of the two to be sure of by hand, because Windows also wants it
     for autoscroll. */
  const was = (await snapshot()).viewport;

  for (const button of ["right", "middle"]) {
    await ctl("viewport", { x: 0, y: 0, scale: 1 });
    await ctl("real.drag", { selector: ".layer", dx: 100, dy: 60, button });
    expect((await snapshot()).viewport).toMatchObject({ x: 100, y: 60 });
  }

  /* And the left button does not pan, which is the other half of the same
     claim — it drew the band instead, and the view has not moved. */
  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  await ctl("real.drag", { selector: ".layer", dx: 100, dy: 60 });
  expect((await snapshot()).viewport).toMatchObject({ x: 0, y: 0 });

  await ctl("deselect", {});
  await ctl("viewport", was);
});

ti("a left-drag over a card gathers it, and does not gather its territory", async () => {
  /* The band, with a real cursor, because everything interesting about it is
     the timing: it must not exist until the press has travelled 4px, and its
     moves arrive on window listeners rather than on any one element. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  await ctl("deselect", {});

  /* Aimed by measurement. A card is 208×78 in a 248×116 slot, so the point just
     past its bottom-right corner is bare wall inside its own gutter — which
     makes the band small enough that it can only reach this one card, whatever
     else the suite has opened. */
  const r = (await ctl("dom", { selector: `[data-conv="${card}"]` })).nodes[0].rect;
  await ctl("real.drag", {
    x: r.x + r.w + 8,
    y: r.y + r.h + 8,
    dx: -(r.w / 2 + 8),
    dy: -(r.h / 2 + 8),
  });

  let snap = await snapshot();
  expect(snap.picks).toContain(`card:${card}`);
  /* The gathering is the same fact narrowed to cards, so both readings agree. */
  expect(snap.selected).toContain(card);
  /* The band began and ended inside the territory without enclosing it, and a
     territory is an area rather than a thing standing on the wall: one you have
     merely reached into is one you were reaching into to get at what is standing
     in it. Held, it would move the whole project on the next drag. */
  expect(snap.picks).not.toContain(`region:${WALL}`);
  /* Selecting a card by band does not open it — that is what a click is for. */
  expect(snap.focusedId).not.toBe(card);

  /* A band that catches nothing replaces the selection with nothing, which is
     what makes it a selection rather than an accumulation. Drawn in the gutter
     alone, away from the card. */
  await ctl("real.drag", {
    x: r.x + r.w + 8,
    y: r.y + r.h + 8,
    dx: 20,
    dy: 20,
  });
  snap = await snapshot();
  expect(snap.picks).not.toContain(`card:${card}`);

  await ctl("deselect", {});
  await ctl("viewport", was);
});

ti("a band with shift held adds, and dragging one member carries the rest", async () => {
  /* The two halves that make more than one selected thing worth having. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  const second = await newCard();
  /* Both cards and a widget, arranged through the surface rather than by
     drawing three rectangles — `pick` is the handle a hand has and this op does
     not. The widget is hung on the real wall, so it is remembered for the
     sweep in afterAll. */
  const w = (await ctl("widget.add", { kind: "clock", x: 4000, y: 4000 })).id as string;
  hung.push(w);
  await ctl("pick", { picks: [`card:${card}`, `card:${second}`, `widget:${w}`] });

  const before = await snapshot();
  expect(before.picks).toEqual([`card:${card}`, `card:${second}`, `widget:${w}`]);
  const at = (id: string) =>
    before.cards.find((c: Reply) => c.id === id).placement ?? null;
  const box = before.widgets.find((x: Reply) => x.id === w);

  /* Carry the group by one of its cards. Everything held moves by the same
     delta, in canvas units, which at scale 1 is the screen delta — and the
     press does not collapse the selection to the card it landed on, which is
     the subtlety the whole thing rests on. */
  const r0 = (await ctl("dom", { selector: `[data-conv="${card}"]` })).nodes[0].rect;
  await ctl("real.drag", {
    x: r0.x + r0.w / 2,
    y: r0.y + r0.h / 2,
    dx: 60,
    dy: 40,
  });

  const after = await snapshot();
  expect(after.picks).toEqual(before.picks);
  /* Both cards are pinned where they were plus the delta. A flowing card had no
     placement before, so what is checked is where it ended up against where the
     layout had drawn it. */
  for (const id of [card, second]) {
    const p = at(id);
    const q = after.cards.find((c: Reply) => c.id === id).placement;
    expect(q).not.toBeNull();
    if (p) {
      expect(Math.abs(q.x - p.x - 60)).toBeLessThan(2);
      expect(Math.abs(q.y - p.y - 40)).toBeLessThan(2);
    }
  }
  const moved = after.widgets.find((x: Reply) => x.id === w);
  expect(Math.abs(moved.x - box.x - 60)).toBeLessThan(2);
  expect(Math.abs(moved.y - box.y - 40)).toBeLessThan(2);

  /* One press, one act — a group that came back in pieces would be a torn wall
     to put right by hand with the same key that tore it. */
  expect(after.undo.acts.at(-1)).toBe("moving 3 things");
  await ctl("undo", {});
  const back = await snapshot();
  expect(Math.abs(back.widgets.find((x: Reply) => x.id === w).x - box.x)).toBeLessThan(2);

  await ctl("widget.remove", { id: w });
  await ctl("deselect", {});
  await ctl("viewport", was);
});

t("escape lets go of the card, and the panel goes with it", async () => {
  await ctl("focus", { id: card });
  let snap = await snapshot();
  expect(snap.focusedId).toBe(card);
  expect(snap.selected).toEqual([card]);

  /* Dispatched at the wall, not at the field: Escape with the caret in the
     draft means "give the wall the key back" and deliberately keeps the card,
     or a prompt you had already written would be left aiming at nothing. */
  await ctl("key", { selector: ".surface", key: "Escape" });

  snap = await snapshot();
  /* All three, because the ring, the gathering and the panel were three
     different halves of being held: the ground click cleared only the
     gathering, so a card stayed lit with its transcript open and there was no
     way back to a bare wall short of closing a conversation. */
  expect(snap.focusedId).toBeNull();
  expect(snap.selected).toEqual([]);
  expect(snap.targets).toEqual([]);
  expect(snap.dom.transcriptOpen).toBe(false);
});

ti("a click on the ground lets go of the card; a drag across it does not", async () => {
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  /* Two cards in hand, so a pan has something to lose. */
  const ids = (await snapshot()).cards
    .filter((c: Reply) => String(c.cwd).startsWith(SCRATCH))
    .map((c: Reply) => c.id)
    .slice(0, 2);
  await ctl("focus", { id: ids[0] });
  await ctl("select", { ids });
  expect((await snapshot()).selected).toEqual(ids);

  /* Somewhere on the surface that is bare wall — everything `handleOf` rules
     out, avoided by measurement rather than by hope, since where the cards and
     the territory handles are depends on what the suite has already opened.
     Measured again after the pan, because it moves everything it measured. */
  async function bare(): Promise<{ x: number; y: number }> {
    const s = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
    const taken = (
      await ctl("dom", {
        selector: "[data-conv], [data-image], .name, .surface button",
        limit: 200,
      })
    ).nodes.map((n: Reply) => n.rect);
    for (let y = s.y + s.h - 16; y > s.y + 16; y -= 24) {
      for (let x = s.x + 16; x < s.x + s.w - 16; x += 24) {
        const clear = taken.every(
          (r: Reply) => x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h,
        );
        if (clear) return { x, y };
      }
    }
    throw new Error("no bare wall left to press — too much on the scratch wall");
  }

  /* Panning is how this wall is read, not how you change your mind about what
     is in hand — the clearing used to happen on pointerdown, so dragging the
     wall to look at something dropped the gathering on the way. The right
     button, because that is what pans now: the left one draws a band, and a
     band *is* how you change your mind about what is in hand. */
  await ctl("real.drag", { ...(await bare()), dx: 90, dy: 50, button: "right" });
  let snap = await snapshot();
  expect(snap.viewport).toMatchObject({ x: 90, y: 50 });
  expect(snap.selected).toEqual(ids);
  expect(snap.focusedId).toBe(ids[0]);

  await ctl("real.click", await bare());
  snap = await snapshot();
  expect(snap.selected).toEqual([]);
  expect(snap.focusedId).toBeNull();

  await ctl("viewport", was);
});

ti("a right-drag pans the wall without leaving a menu behind", async () => {
  /* The right button pans as readily as the left; what it must not do is
     open a menu when it comes up, because the gesture was "move the wall".
     Only a real button can show this — the whole question is what Chromium
     does between pointerup and contextmenu. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  await ctl("real.drag", { selector: ".layer", dx: 90, dy: 50, button: "right" });
  expect((await snapshot()).viewport).toMatchObject({ x: 90, y: 50 });
  expect((await ctl("dom", { selector: ".menu" })).count).toBe(0);

  /* A right-click that stays put still opens a menu — the suppression is
     about the drag, not the button. That half is covered synthetically by the
     `menu` op, which is the same handler this one had to get past. */

  /* And it starts on a card, which is the whole of why this exists: the wall
     is read by panning, so a full territory must not be able to take the
     gesture away. It used to refuse the press outright. The card has
     to stay exactly where it was — the right button carries nothing — and the
     menu must still not appear, which is the harder half here: the
     `contextmenu` is aimed at the card rather than at the surface, so the
     suppression cannot live on the surface any more. */
  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  const before = (await snapshot()).cards.find(
    (c: Reply) => c.id === card,
  ).placement;
  await ctl("real.drag", {
    selector: `[data-conv="${card}"]`,
    dx: 70,
    dy: 30,
    button: "right",
  });
  const after = await snapshot();
  expect(after.viewport).toMatchObject({ x: 70, y: 30 });
  expect((await ctl("dom", { selector: ".menu" })).count).toBe(0);
  expect(after.cards.find((c: Reply) => c.id === card).placement).toEqual(before);

  await ctl("viewport", was);
});

ti("dragging a card carries it rather than selecting its text", async () => {
  /* The bug: .surface had no `user-select`, so a real press-and-move started a
     text selection over the card's title and the highlight outlived the drop.
     A synthetic pointer never sees this — only Chromium's own hit testing
     does — which is why this test is down here with the real cursor. */
  const sel = `[data-conv="${card}"]`;
  await ctl("real.drag", { selector: sel, dx: 120, dy: 40 });

  const snap = await snapshot();
  expect(snap.dom.selectionChars).toBe(0);
  expect(snap.cards.find((c: Reply) => c.id === card).placement).not.toBeNull();
});

/* ── where a new conversation lands ──────────────────────────────────── */

t("a new card takes free wall, not the slot a pinned card is sitting on", async () => {
  /* The bug, from the wall rather than from layout.ts: a card pinned near the
     top of its territory kept its slot in the flow as well, so every
     conversation opened afterwards appeared underneath it in the same corner. */
  const rectOf = async (id: string) =>
    (await snapshot()).dom.cardNodes.find((n: Reply) => n.id === id);

  const first = await newCard();
  const a = await rectOf(first);

  /* Pin it exactly where it already sits — the common case, and the one that
     used to leave its slot claimable. Screen back to canvas by hand, which
     means subtracting the surface's own origin as `toCanvas` does: the header
     is 47px tall, and skipping that put the pin most of a slot out of place. */
  const v = (await snapshot()).viewport;
  const origin = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  await ctl("pin", {
    id: first,
    x: (a.x - origin.x - v.x) / v.scale,
    y: (a.y - origin.y - v.y) / v.scale,
  });

  const next = await newCard();
  const c = await rectOf(next);
  expect(c).toBeDefined();
  expect({ x: c.x, y: c.y }).not.toMatchObject({ x: a.x, y: a.y });

  /* The general form, and the one that does not care how many cards the suite
     has already put in this territory: nothing is stacked on anything. */
  const here = (await snapshot()).cards
    .filter((x: Reply) => String(x.cwd).startsWith(SCRATCH))
    .map((x: Reply) => x.id);
  const spots = (await snapshot()).dom.cardNodes
    .filter((n: Reply) => here.includes(n.id))
    .map((n: Reply) => `${n.x},${n.y}`);
  expect(new Set(spots).size).toBe(spots.length);
});

/* ── where a territory lands, and where it can be carried ────────────── */

t("every territory has a place of its own, and can be carried elsewhere", async () => {
  /* Territories ran along one line off the origin and were never recorded, so
     there was nothing to move and nothing to remember. Both halves matter: the
     position has to be *written down* (otherwise it depends on the project list,
     and forgetting one in the middle slides every later territory a cell along,
     leaving the cards pinned inside them behind), and it has to be movable. */
  const here = await newCard();
  const project = async () =>
    (await snapshot()).projects.find((p: Reply) => p.root === WALL);

  const p0 = await project();
  expect(p0.x).not.toBeNull();
  expect(p0.y).not.toBeNull();

  const sel = '.region[data-cwd$="wall"]';
  const box = async () => (await ctl("dom", { selector: sel })).nodes[0].rect;
  const cardBox = async () =>
    (await snapshot()).dom.cardNodes.find((n: Reply) => n.id === here);

  const wasRegion = await box();
  const wasCard = await cardBox();
  const { scale } = (await snapshot()).viewport;

  await ctl("place", { cwd: WALL, x: p0.x + 400, y: p0.y + 240 });

  const moved = await box();
  expect(Math.abs(moved.x - wasRegion.x - 400 * scale)).toBeLessThan(2);
  expect(Math.abs(moved.y - wasRegion.y - 240 * scale)).toBeLessThan(2);

  /* The cards standing in it came along — this one flows, so it moves because
     its slot is measured off the territory's origin. */
  const carried = await cardBox();
  expect(Math.abs(carried.x - wasCard.x - 400 * scale)).toBeLessThan(2);
  expect(Math.abs(carried.y - wasCard.y - 240 * scale)).toBeLessThan(2);

  /* Having been moved, it offers the way back — the territory's equivalent of a
     card's "let it flow again". */
  expect((await ctl("menu", { selector: sel })).items).toContain("reflow");
  await ctl("key", { key: "Escape" });

  /* Settling it back packs it in among the others again — against their real
     heights, so where it lands depends on the wall, not on a fixed pitch. What
     has to hold is that it is somewhere, and no longer where we put it. */
  await ctl("place", { cwd: WALL });
  const back = await project();
  expect(back.x).not.toBeNull();
  expect(back.y).not.toBeNull();
  expect([back.x, back.y]).not.toEqual([p0.x + 400, p0.y + 240]);
});

ti("a territory is carried by its name, not by its whole area", async () => {
  /* The area has to keep panning — a press anywhere on a region being inert is
     the bug `isGround` exists to have fixed — so the handle is the name. Only a
     real cursor can show that Chromium routes the press to it rather than
     starting a text selection over the label. */
  const p0 = (await snapshot()).projects.find((p: Reply) => p.root === WALL);
  const { scale } = (await snapshot()).viewport;

  await ctl("real.drag", { selector: '.name[data-cwd$="wall"]', dx: 90, dy: 70 });

  const after = (await snapshot()).projects.find((p: Reply) => p.root === WALL);
  expect(Math.abs(after.x - p0.x - 90 / scale)).toBeLessThan(2);
  expect(Math.abs(after.y - p0.y - 70 / scale)).toBeLessThan(2);
  expect((await snapshot()).dom.selectionChars).toBe(0);

  await ctl("place", { cwd: WALL, x: p0.x, y: p0.y });
});

t("a project outlives its last card, and can be dismissed on purpose", async () => {
  /* Closing everything and starting again in the same place is ordinary, and
     the territory is where the "+" that starts it lives. */
  const dir = `${SCRATCH}\\outlives`;
  mkdirSync(dir, { recursive: true });
  const only = (await ctl("open", { dir })).id as string;
  opened.push(only);

  const territories = async () =>
    (await ctl("dom", { selector: ".region" })).nodes.map((n: Reply) => n.data.name);
  expect(await territories()).toContain("outlives");

  await ctl("close", { id: only });
  expect(await territories()).toContain("outlives");

  /* Which is why it also has to be possible to say you are done with it —
     otherwise every folder ever opened stays on the wall for good. */
  const sel = '.region[data-cwd$="outlives"]';
  expect((await ctl("menu", { selector: sel })).items).toContain("forget");
  await ctl("click", { selector: '[data-menu="forget"]' });

  await until(
    "the territory to leave the wall",
    () => territories(),
    (names: string[]) => !names.includes("outlives"),
    3000,
  );
  expect((await snapshot()).fault).toBeNull();
});

/* ── the right-click ─────────────────────────────────────────────────── */

t("the wall answers a right-click itself, and Chromium never does", async () => {
  const ground = await ctl("menu", { selector: ".surface" });
  expect(ground.defaultPrevented).toBe(true);
  expect(ground.items).toEqual([
    "open",
    "adopt",
    "image",
    /* Off the widget catalogue, so a new kind of instrument appears here by
       existing rather than by being listed again — which is also why this list
       has to grow with `WIDGETS` and in its order. */
    "widget:clock",
    "widget:performance",
    "widget:timer",
    "widget:pomodoro",
    "widget:usage",
    "fit",
    "tidy",
    /* The ground is what the ambience is drawn on, so this is where asking
       about it belongs. */
    "ambience",
  ]);

  const onCard = await ctl("menu", { selector: `[data-conv="${card}"]` });
  /* The session id is what `--resume` takes and this is the only place the UI
     parts with it, so losing this item would quietly close the one bridge
     between a card and a terminal. */
  expect(onCard.items).toContain("copy-resume");
  expect(onCard.items).toContain("close");

  /* Nothing worth offering: no menu, and still no native one. Both halves
     matter — "shows nothing" is the requirement, not "shows an empty box". */
  const bar = await ctl("menu", { selector: ".bar" });
  expect(bar.defaultPrevented).toBe(true);
  expect(bar.open).toBe(false);
  expect(bar.items).toEqual([]);

  await ctl("key", { key: "Escape" });
  expect((await ctl("dom", { selector: ".menu" })).count).toBe(0);
});

t("typing with a card in hand goes to the field, keystroke and all", async () => {
  await ctl("focus", { id: card });
  await ctl("type", { text: "" });

  /* Dispatched at the wall, not at the field — the point is that the field is
     not where the keystroke landed. */
  await ctl("key", { selector: ".surface", key: "h" });
  await ctl("key", { selector: ".surface", key: "i" });

  const snap = await snapshot();
  expect(snap.draft).toBe("hi");
  expect(snap.dom.focusedTag).toBe("TEXTAREA");

  await ctl("type", { text: "" });
});

t("an image brought to the front is in front of the cards", async () => {
  /* It never was: cards sat at 1000 and territory chips at 1001 in CSS, while
     an image's z-index was its own small z, so `bringToFront` only reordered
     images among themselves. */
  /* At `field` density the wall draws neither chips nor image nodes, so this
     needs a known camera rather than whatever the last test left. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  /* `drop` reports counts, not ids — the id comes off the wall afterwards. */
  expect((await ctl("drop", { path: IMAGE, x: 200, y: 200 })).fault).toBeNull();
  const shots = (await snapshot()).images;
  const img = shots[shots.length - 1].id as string;
  expect(img).toBeTruthy();
  placed.push(img);

  const zOf = async (selector: string) =>
    Number(
      (await ctl("dom", { selector, styles: ["z-index"] })).nodes[0].styles["z-index"],
    );

  const behind = await zOf(`[data-image="${img}"]`);
  const cardZ = await zOf(`[data-conv="${card}"]`);
  expect(behind).toBeLessThan(cardZ); // a reference starts out of the way

  await ctl("menu", { selector: `[data-image="${img}"]` });
  await ctl("click", { selector: '[data-menu="front"]' });

  const front = await zOf(`[data-image="${img}"]`);
  expect(front).toBeGreaterThan(cardZ);
  expect(front).toBeGreaterThan(await zOf(".chips"));

  await ctl("viewport", was);
});

/* ── the instruments ──────────────────────────────────────────────────── */

/** Widgets straight from SQLite. Same argument as `openRows`: "the wall shows
 *  a clock" and "the row says so" are different claims, and only the second one
 *  survives a restart. */
function widgetRows(): { id: string; kind: string; config: string; z: number }[] {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .query("SELECT id, kind, config_json AS config, z FROM widget")
      .all() as { id: string; kind: string; config: string; z: number }[];
  } finally {
    db.close();
  }
}

/** Hang one up and take it down again whatever happens.
 *
 * Immediately, not in `afterAll`: unlike a card, a widget stands on the *real*
 * wall — there is no `.scratch` to keep it in — so one left up for the rest of
 * the run is furniture every later test has to walk around. It cost three of
 * them: a clock dropped near a territory swallowed the press meant for the
 * territory's handle, and one left *selected* ate the Escape that the deselect
 * test was about, since a held widget is a step on that ladder. */
async function withWidget(kind: string, at: { x: number; y: number }, body: (id: string) => Promise<void>) {
  const { id } = await ctl("widget.add", { kind, ...at });
  expect(id).toBeTruthy();
  hung.push(id as string);
  try {
    await body(id as string);
  } finally {
    await ctl("widget.remove", { id }).catch(() => {});
    const i = hung.indexOf(id as string);
    if (i >= 0) hung.splice(i, 1);
  }
}

t("a clock is hung up, switched, moved and written down", async () => {
  let mine = "";
  await withWidget("clock", { x: 320, y: 320 }, async (id) => {
    mine = id;
    const shown = async () =>
      (await snapshot()).widgets.find((w: Reply) => w.id === id);
    expect((await shown()).variant).toBe("analog");
    expect((await ctl("dom", { selector: `[data-widget="${id}"] .clock` })).count).toBe(1);

    /* Through the menu, not through the op: the variants are the whole reason
       to right-click a widget, and an op that set the config directly would
       prove nothing about the path a hand takes. */
    await ctl("menu", { selector: `[data-widget="${id}"]` });
    const items = await ctl("dom", { selector: '.menu [data-menu^="set:"]' });
    expect(items.count).toBe(5);
    /* The one in force is marked rather than labelled — a dot drawn in CSS,
       since a tick glyph falls through to an emoji font here and comes out
       blue. */
    const marked = items.nodes.filter((n: Reply) => n.classes.includes("on"));
    expect(marked).toHaveLength(1);
    expect(marked[0].data.menu).toBe("set:analog");

    await ctl("click", { selector: '[data-menu="set:words"]' });
    expect((await shown()).variant).toBe("words");
    /* Every face is a different reading of the same instant, so the worded one
       genuinely says something. */
    const said = await ctl("dom", { selector: `[data-widget="${id}"] .said` });
    expect(said.nodes[0].text.length).toBeGreaterThan(4);

    await ctl("widget.update", { id, x: 900, y: 640, w: 240, h: 240 });

    /* Saves are debounced: dragging one fires continuously and the database
       only wants where it came to rest. */
    const row = await until(
      "the clock to reach SQLite",
      async () => widgetRows().find((r) => r.id === id),
      (r) => !!r && JSON.parse(r.config).variant === "words",
    );
    expect(row!.kind).toBe("clock");
    /* One row, not one per drag frame. */
    expect(widgetRows().filter((r) => r.id === id)).toHaveLength(1);
  });

  /* Taken down, it is gone from the database and stays gone — not put back by
     a save that was still in flight, which is the bug reference images shipped
     with, where deleting one brought it back on the next launch. */
  await until(
    "the row to go with it",
    async () => widgetRows().filter((r) => r.id === mine),
    (rows) => rows.length === 0,
  );
});

t("a widget starts behind the work and comes to the front when asked", async () => {
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  try {
    await withWidget("clock", { x: 240, y: 240 }, async (id) => {
      const zOf = async (selector: string) =>
        Number(
          (await ctl("dom", { selector, styles: ["z-index"] })).nodes[0].styles["z-index"],
        );

      /* The wall is a working surface first: nothing hung on it covers live
         work until you say so. */
      const behind = await zOf(`[data-widget="${id}"]`);
      const cardZ = await zOf(`[data-conv="${card}"]`);
      expect(behind).toBeLessThan(cardZ);

      /* And in front means in front of everything, not of the other clocks —
         one stacking order for the whole wall. */
      await ctl("menu", { selector: `[data-widget="${id}"]` });
      await ctl("click", { selector: '[data-menu="front"]' });
      expect(await zOf(`[data-widget="${id}"]`)).toBeGreaterThan(cardZ);
    });
  } finally {
    await ctl("viewport", was);
  }
});

t("the sampler runs only while something is reading it", async () => {
  /* Nothing on this wall polls; a process meter is the one honest exception,
     and it is bounded at both ends. Counted against whatever is already up
     rather than against zero: this runs on the *real* wall, and somebody's own
     meter hanging on it is not a failure. */
  const base = (await snapshot()).meter.watchers;

  await withWidget("performance", { x: 600, y: 320 }, async (id) => {
    const meter = await until(
      "the first reading",
      async () => (await snapshot()).meter,
      (m) => !!m.sampling,
    );
    expect(meter!.watchers).toBe(base + 1);
    expect(meter!.fault).toBeNull();

    /* The studio knows which of the machine's identical `claude.exe` are its
       own — the whole reason this lives in here rather than in the taskbar. */
    const rows = await until(
      "a row about this studio",
      async () => await ctl("dom", { selector: `[data-widget="${id}"] .perf` }),
      (r) => r.nodes[0]?.text.includes("skein"),
    );
    expect(rows!.nodes[0].text).toContain("this studio");
  });

  /* And it stops dead when the last widget comes off the wall — the whole
     bargain: no meter up, nothing enumerating anything. */
  const after = await until(
    "the sampler to let go",
    async () => (await snapshot()).meter,
    (m) => m.watchers === base,
  );
  if (base === 0) expect(after!.sampling).toBe(false);
});

/* ── the wall's ambience ──────────────────────────────────────────────── */

/** Ambience profiles straight from SQLite. Same argument as `openRows`: "the
 *  panel says the layer is off" and "the row says so" are different claims. */
function ambienceRows(): { id: string; name: string; layers: string; active: number }[] {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .query("SELECT id, name, layers_json AS layers, active FROM ambience_profile")
      .all() as { id: string; name: string; layers: string; active: number }[];
  } finally {
    db.close();
  }
}

t("the backdrop covers the wall exactly and takes no events", async () => {
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  const back = (
    await ctl("dom", {
      selector: "canvas.backdrop",
      styles: ["pointer-events", "position"],
    })
  ).nodes[0];

  /* It once grew to twenty-two million pixels across: a canvas is a replaced
     element, so `inset: 0` does not size it, and measuring `clientWidth` to set
     `el.width` multiplied by the device pixel ratio on every resize the observer
     reported — which was every one it caused. */
  expect(back.rect.w).toBe(surface.w);
  expect(back.rect.h).toBe(surface.h);
  /* The wall pans and the cards are pressed. Nothing here may take an event. */
  expect(back.styles["pointer-events"]).toBe("none");
});

t("a wall with nothing on it stops drawing, and starts again", async () => {
  const was = (await snapshot()).ambience.activeId;
  try {
    await ctl("ambience.use", { id: null });
    let amb = (await snapshot()).ambience;
    /* The frame loop is stopped, not left clearing sixty times a second for
       nothing — nothing on this wall polls. The canvas stays; only the loop goes. */
    expect(amb.drawing).toBe(false);
    expect(amb.canvas).toBe(true);
    expect(amb.activeId).toBeNull();
    /* Having none showing is a state the database keeps, not the absence of one. */
    expect(ambienceRows().filter((r) => r.active).length).toBe(0);

    await ctl("ambience.use", { id: was });
    amb = (await snapshot()).ambience;
    expect(amb.activeId).toBe(was);
    expect(amb.drawing).toBe(true);
  } finally {
    await ctl("ambience.use", { id: was });
  }
});

t("a stack is built, reordered, and written down", async () => {
  const was = (await snapshot()).ambience.activeId;
  const { id: mine } = await ctl("ambience.profile", { do: "create", name: "wall test" });
  try {
    await ctl("ambience.layer", { do: "add", kind: "leaves" });
    await ctl("ambience.layer", { do: "add", kind: "footsteps" });

    const kinds = async () =>
      (await snapshot()).ambience.profiles
        .find((p: Reply) => p.id === mine)
        .layers.map((l: Reply) => l.kind);
    expect(await kinds()).toEqual(["leaves", "footsteps"]);

    /* Order is paint order, and it is what puts the leaves in front. */
    await ctl("ambience.layer", { do: "move", layer: "footsteps", by: -1 });
    expect(await kinds()).toEqual(["footsteps", "leaves"]);

    /* A layer switched off is kept, with everything it was set to — much better
       than deleting it to see the wall without it. */
    await ctl("ambience.layer", { do: "param", layer: "leaves", key: "count", value: 33 });
    await ctl("ambience.layer", { do: "set", layer: "leaves", on: false });

    const leaves = async () =>
      (await snapshot()).ambience.profiles
        .find((p: Reply) => p.id === mine)
        .layers.find((l: Reply) => l.kind === "leaves");
    expect((await leaves()).on).toBe(false);
    expect((await leaves()).params.count).toBe(33);

    /* Out of range is pulled back in rather than honoured — the slider's own
       bounds are the effect's, and the renderer must never see past them. */
    await ctl("ambience.layer", { do: "param", layer: "leaves", key: "count", value: 9999 });
    expect((await leaves()).params.count).toBeLessThanOrEqual(80);

    /* Saves are debounced, as every drag of a slider fires one. */
    const row = await until(
      "the stack to reach SQLite",
      async () => ambienceRows().find((r) => r.id === mine),
      (r) => !!r && JSON.parse(r.layers).length === 2,
    );
    const stored = JSON.parse(row!.layers);
    expect(stored.map((l: Reply) => l.kind)).toEqual(["footsteps", "leaves"]);
    expect(stored.find((l: Reply) => l.kind === "leaves").on).toBe(false);

    /* Exactly one profile is ever showing, whatever else has happened. */
    expect(ambienceRows().filter((r) => r.active).map((r) => r.id)).toEqual([mine]);
  } finally {
    /* Nothing this suite made may outlive it — the same rule the cards and the
       scratch territories follow. */
    await ctl("ambience.profile", { do: "delete", id: mine });
    await ctl("ambience.use", { id: was });
  }
});

/* ── the rails beside the transcript ─────────────────────────────────── */

t("the contents rail is one answer's shape, and clicking an entry goes there", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  /* Far taller than the panel, or there is nowhere for a click to take us. */
  const filler = (what: string) =>
    Array.from({ length: 22 }, (_, i) => `${what} ${i}`).join("\n\n");

  await ctl("feed", {
    id: mine,
    event: {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: [
              "the opening words of the answer",
              "",
              "## the first section",
              "",
              filler("first"),
              "",
              "- alpha, an item",
              "- beta, an item",
              "",
              "## the second section",
              "",
              filler("second"),
            ].join("\n"),
          },
        ],
      },
    },
  });

  const rail = 'nav[aria-label^="contents"] button';
  const shown = await until(
    "the contents rail to paint",
    () => ctl("dom", { selector: rail, styles: ["padding-left"] }),
    (r) => r.count >= 5,
  );

  /* Everything an answer is navigable by: where it starts, its headings, and
     the start of each of its list items. */
  expect(shown.nodes.map((n: Reply) => n.text)).toEqual([
    "the opening words of the answer",
    "the first section",
    "alpha, an item",
    "beta, an item",
    "the second section",
  ]);

  /* A list written under an h2 sits deeper than the h2 — the indent is carried
     along the run rather than read off the tag, which is the whole of `nest`. */
  const pad = (n: Reply) => parseFloat(n.styles["padding-left"]);
  expect(pad(shown.nodes[2])).toBeGreaterThan(pad(shown.nodes[1]));

  /* The panel is parked at the tail, so the first section is well above it. */
  const box = (await ctl("dom", { selector: ".detail .lines" })).nodes[0].rect;
  const heads = () => ctl("dom", { selector: ".detail .line.md .h" });
  expect((await heads()).nodes[0].rect.y).toBeLessThan(box.y);

  await ctl("click", { selector: rail, index: 1 });

  /* And it is carried to the top of the column. This is the whole gesture, and
     it failed silently once: the first scroll event of the animation still read
     as "parked at the tail", so the follow dragged the panel straight back down
     and clicking a rail entry did nothing at all. */
  const after = await until(
    "the panel to arrive at the section",
    heads,
    (r) => Math.abs(r.nodes[0].rect.y - box.y) < 40,
  );
  expect(after.nodes[0].rect.y).toBeGreaterThan(box.y - 40);

  /* The rail says where that left us, and says it about an entry it is showing. */
  const lit = await ctl("dom", { selector: `${rail}.on` });
  expect(lit.count).toBe(1);
  expect(lit.nodes[0].text).toBe("the first section");
  /* Longer than the default five seconds: this one spawns a card late in a run
     that has already spawned a dozen, and then waits on an animation. */
}, 20_000);

t("a second answer replaces the contents rail rather than lengthening it", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  for (const [n, head] of [["one", "the older answer"], ["two", "the newer answer"]]) {
    await ctl("feed", {
      id: mine,
      event: {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: [`## ${head}`, "", Array.from({ length: 22 }, (_, i) => `${n} ${i}`).join("\n\n")].join("\n"),
            },
          ],
        },
      },
    });
  }

  /* Parked at the tail, so the answer being read is the newer one — and the
     rail is that answer, not the transcript over again in a narrow column. */
  const rail = 'nav[aria-label^="contents"] button';
  const shown = await until(
    "the rail to follow the reader",
    () => ctl("dom", { selector: rail }),
    (r) => r.count > 0 && r.nodes.at(-1).text === "the newer answer",
  );
  expect(shown.nodes.map((n: Reply) => n.text)).not.toContain("the older answer");

  /* Which one, of how many — a scoped rail that says nothing about being scoped
     reads as an answer that lost half its headings. */
  const cap = await ctl("dom", { selector: 'nav[aria-label^="contents"] .cap' });
  expect(cap.nodes[0].text).toBe("contents · 2/2");

  /* What you said, by contrast, is the whole conversation and stays put. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "and what about the other one" }] },
      parent_tool_use_id: null,
      isReplay: true,
    },
  });
  const said = await until(
    "the conversation rail to carry it",
    () => ctl("dom", { selector: 'nav[aria-label="you said"] button' }),
    (r) => r.count > 0,
  );
  expect(said.nodes.at(-1).text).toBe("and what about the other one");
}, 20_000);

/* ── stopping a turn ─────────────────────────────────────────────────── */

/** A turn mid-answer, without spending anything on one. */
async function startAnswering(id: string) {
  await ctl("feed", {
    id,
    events: [
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "1 — one, where every count" },
        },
      },
    ],
  });
}

/** What the CLI actually sends back after an interrupt, in its own order — the
 *  half-written answer, its own note, and a result wearing every mark of a
 *  failure. Shapes verbatim from `tools/probe-interrupt.ts` against 2.1.229. */
async function feedTheStop(id: string) {
  await ctl("feed", {
    id,
    events: [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "1 — one, where every count starts" }],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: null,
        terminal_reason: "aborted_streaming",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      },
    ],
  });
}

t("a turn you stopped is not a turn that broke", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  await startAnswering(mine);
  expect((await cardOf(mine)).working).toBe(true);

  /* The button exists only while there is a turn to end, and it stands beside
     the readout naming the card it aims at. */
  const chip = await until(
    "the stop button to appear",
    () => ctl("dom", { selector: ".targets .stop" }),
    (r) => r.count === 1,
  );
  expect(chip.nodes[0].text).toStartWith("stop");

  await feedTheStop(mine);

  const c = await cardOf(mine);
  expect(c.ending).toBe("stopped");
  /* Not rust. Every field on that result says failure and one says otherwise. */
  expect(c.tier).toBe("rest");
  expect(c.activity).toBe("stopped");
  /* What it had written by then is kept — stopping costs you nothing you had
     already read — and the CLI's note is a note, not a line you appear to have
     typed. */
  expect(c.lines.at(-2)).toEqual({ kind: "text", text: "1 — one, where every count starts" });
  expect(c.lines.at(-1)).toEqual({ kind: "meta", text: "stopped" });

  /* And this is not `close` under another name: the card is still on the wall
     with its process, ready for the next thing you say to it. */
  expect(c.working).toBe(false);
  expect(c.dormant).toBe(false);
  expect((await ctl("dom", { selector: ".targets .stop" })).count).toBe(0);
});

t("escape reaches the running turn first, and lets go on the next press", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  await startAnswering(mine);

  /* Dispatched at the wall rather than the dock's field: Escape with the caret
     in the draft is a step of its own and gives the key back to the wall. */
  await ctl("key", { key: "Escape", selector: ".surface" });

  /* One step, and it is the innermost one — the card is still in hand. */
  const stopping = await until(
    "the stop to be on its way",
    () => cardOf(mine),
    (c) => c.activity === "stopping…" || c.activity === "stopped",
  );
  expect(stopping.id).toBe(mine);
  expect((await snapshot()).focusedId).toBe(mine);

  /* With the turn over, the same key means what it always did. */
  await feedTheStop(mine);
  await ctl("key", { key: "Escape", selector: ".surface" });
  await until(
    "the card to be let go of",
    () => snapshot(),
    (s) => s.focusedId === null,
  );
  expect((await snapshot()).dom.transcriptOpen).toBe(false);
});

/* ── letting go of the tail, and taking it back ───────────────────────── *
 *
 * The one behaviour on the panel whose whole point is that it happens while
 * nobody is watching — which is exactly why it shipped doing nothing at all for
 * two months. `watching` was declared with a default of `true` so the panel
 * renders without a studio around it, and `App.svelte` mounted `<Transcript>`
 * without the prop, so the re-arm was unreachable. Nothing on the wall said so:
 * the symptom is not a view that stayed put, it is a view that reads as *near
 * the start of the conversation*, because a pixel offset three quarters of the
 * way down a short column is a tenth of the way down the long one an agent
 * spends ten minutes writing underneath it.
 *
 * The blur is real and nothing has to be poked to get it: the terminal running
 * this suite is what has focus, which is the condition itself rather than a
 * simulation of one. So this test steals nothing and needs no second opt-in — it
 * only needs the studio to be where `test:wall` always leaves it, in the
 * background. */

t("a panel nobody is looking at comes back to the newest thing said", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  const filler = (what: string, n = 40) =>
    Array.from(
      { length: n },
      (_, i) => `${what}, line ${i} — enough prose to take a row of the column.`,
    ).join("\n\n");
  const say = (text: string) =>
    ctl("feed", {
      id: mine,
      event: { type: "assistant", message: { content: [{ type: "text", text }] } },
    });

  /* Just the panel, not the whole snapshot: `until` prints its last reading when
     it gives up, and the interesting failure here is two numbers. */
  const reading = async () => (await snapshot()).panel;

  await say(filler("the answer you were reading"));
  /* Both numbers, because either alone is unreadable from out here: a panel that
     does not overflow is at `scrollTop` 0 and correctly so. */
  const parked = await until(
    "the panel to fill and park at the tail",
    reading,
    (p) => p.scrollMax > 400 && p.scrollTop >= p.scrollMax - 40,
  );

  /* Let go of it the way a reader does. ctrl+PageUp is the panel's own gesture
     and writes `scrollTop` through the same path the wheel does, so `following`
     is dropped by `onScroll` rather than by anything reaching in here. */
  for (let i = 0; i < 6; i += 1) await ctl("key", { key: "PageUp", ctrl: true });
  const held = await snapshot();
  expect(held.panel.scrollTop).toBeLessThan(parked.scrollMax - 200);

  /* The precondition, asserted rather than assumed: with the studio focused
     there is no re-arm to observe and every number below would be the follow
     doing its ordinary job. */
  expect(held.attention.windowFocused).toBe(false);

  /* And the agent gets on with it — four rounds of it, which is what you left
     the card alone to get on with. */
  for (const n of ["the first round you missed", "the second", "the third", "the fourth"]) {
    await say(filler(n));
  }

  /* Back at the tail, not back where you were holding: the column is five times
     the length it was, so the place you had is now the top of it. Unfixed, this
     reports `scrollTop` 0 against a `scrollMax` near 7000. */
  const back = await until(
    "the panel to take the tail back up",
    reading,
    (p) => p.scrollMax > parked.scrollMax * 2 && p.scrollTop >= p.scrollMax - 40,
  );
  expect(back.scrollTop).toBeGreaterThan(held.panel.scrollTop);
}, 30_000);

/* The other half of the tail — a turn writing in bursts shaking the panel off it
 * — is deliberately *not* tested from here, and the reason is worth writing down.
 * This suite runs with the studio in the background, which is exactly where the
 * `watching` re-arm sets `following` true on every arriving event. It therefore
 * rescues the panel from any other way of losing the tail, and a burst test run
 * from here reads AT THE TAIL whether the bug is present or not. Measured: unfixed
 * and unfocused, six rounds of eight concurrent events came back gap 0 every time;
 * the same rounds with the re-arm held inert stranded the panel 70890px above the
 * tail. A guard that cannot fail is worse than no guard, being the same mistake as
 * the prop that was never passed. The judgement lives in `stillFollowing`
 * (follow.ts) and is tested there instead, with no DOM to arrange. */

/* ── how big the reading is ──────────────────────────────────────────── */

t("ctrl+wheel over the panel sets how big the reading is", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  await until(
    "the panel to open",
    () => snapshot(),
    (s) => s.dom.transcriptOpen === true,
  );

  const start = await snapshot();
  expect(start.panel.reading).toBe(1);
  const base = start.panel.linePx;
  expect(base).toBeGreaterThan(0);

  /* Away from you is larger — the same sense the wall's own zoom reads the
     wheel in, and the modifier is what keeps a bare wheel scrolling. */
  const up = await ctl("wheel", { target: "panel", ctrl: true, dy: -100 });
  expect(up.reading).toBeCloseTo(1.05, 5);

  /* And it reached the column. This is the half a multiplier in state cannot
     show: a `--read` no rule consumed would leave `reading` moving and the
     drawn line exactly where it was. */
  const drawn = await until(
    "the column to be redrawn larger",
    () => snapshot(),
    (s) => s.panel.linePx > base,
  );
  expect(drawn.panel.linePx / base).toBeCloseTo(1.05, 2);

  /* The range has ends, and a notch past one is a no-op rather than an error. */
  for (let i = 0; i < 25; i += 1) await ctl("wheel", { target: "panel", ctrl: true, dy: -100 });
  expect((await snapshot()).panel.reading).toBe(2);

  /* ctrl+0 is the way back, and it is aimed here from the wall rather than the
     panel: the reset is on the window, not on the thing being resized. */
  await ctl("key", { key: "0", ctrl: true, selector: ".surface" });
  const back = await until(
    "the reading to go back to the size it always was",
    () => snapshot(),
    (s) => s.panel.reading === 1,
  );
  expect(back.panel.linePx).toBeCloseTo(base, 2);
}, 30_000);

/* ── the glass ────────────────────────────────────────────────────────── *
 *
 * A pane in front of the wall, in screen space. The claim worth testing from
 * outside is not that a thing can be stuck to it — that is visible — but the
 * two invisible halves: that sticking it changed nothing about where it *is*,
 * and that the pane cannot reach the dock or the title bar. */

t("a card stuck to the glass keeps its place on the wall", async () => {
  const id = await newCard();
  const before = (await snapshot()).cards.find((c: Reply) => c.id === id);

  const on = await ctl("glass", { kind: "card", card: id });
  expect(on.glass).not.toBeNull();
  expect(typeof on.glass.x).toBe("number");

  const stuck = (await snapshot()).cards.find((c: Reply) => c.id === id);
  /* Not pinned, and not moved: the wall is laid out as though nothing were on
     the pane, so its slot is still its slot and taking it off puts it back. */
  expect(stuck.placement?.pinned ?? false).toBe(before?.placement?.pinned ?? false);

  /* It is drawn once, and on the pane rather than on the wall. */
  const where = await ctl("dom", { selector: `.glass [data-conv="${id}"]` });
  expect(where.count).toBe(1);
  expect((await ctl("dom", { selector: `.layer [data-conv="${id}"]` })).count).toBe(0);

  /* Moved about on the pane, which writes the glass spot and nothing else. */
  const moved = await ctl("glass", { kind: "card", card: id, x: 140, y: 90 });
  expect(moved.glass).toEqual({ x: 140, y: 90 });
  expect(moved.placement.x).toBe(stuck.placement?.x ?? 0);

  /* And back on the wall, in the layer it started in. */
  const off = await ctl("glass", { kind: "card", card: id });
  expect(off.glass).toBeNull();
  await until(
    "the card to be back in the wall's own layer",
    () => ctl("dom", { selector: `.layer [data-conv="${id}"]` }),
    (d) => d.count === 1,
  );
  expect((await ctl("dom", { selector: `.glass [data-conv="${id}"]` })).count).toBe(0);
}, 30_000);

/* The whole of "over the transcript, never over the dock or the header" is that
   the pane is a box inside `main.wall`. It is worth asserting rather than
   trusting, because a z-index added anywhere else could not break it and a
   reparenting silently would. */
t("the pane covers the wall and the panel, and nothing else", async () => {
  const snap = await snapshot();
  const g = snap.glass;
  expect(g).not.toBeNull();

  const bar = (await ctl("dom", { selector: ".bar" })).nodes[0].rect;
  const dock = (await ctl("dom", { selector: ".dock" })).nodes[0].rect;
  expect(g.y).toBeGreaterThanOrEqual(bar.y + bar.h);
  expect(g.y + g.h).toBeLessThanOrEqual(dock.y + 1);

  /* And it does reach across the transcript, which is the one thing it is
     allowed to cover. */
  const wall = (await ctl("dom", { selector: ".wall" })).nodes[0].rect;
  expect(g.w).toBe(wall.w);
  expect(g.x).toBe(wall.x);
});

/* ── the floating shell ──────────────────────────────────────────────── */

/** Wait out whatever the shell is doing. The first one of these is the profile
 *  loading, which on this machine is about four seconds — the whole reason the
 *  panel draws a `starting` state at all. */
const shellSettled = () =>
  until(
    "the shell to finish what it was given",
    () => snapshot(),
    (s) => s.shell.live && !s.shell.busy,
    30_000,
  );

/** Whatever the scrollback says now, colour already stripped. */
async function shellLines(tail = 40): Promise<{ kind: string; failed: boolean; text: string }[]> {
  const r = await ctl("shell", { do: "show", tail });
  return r.shell.lines;
}

t("alt+I opens a shell, and it starts where the wall is", async () => {
  await ctl("shell", { do: "close" });
  await ctl("shell", { do: "hide" });
  await ctl("shell", { do: "clear" });

  /* Through the real global handler, not through `show` — the binding is half
     of what was asked for, and an op that opened the panel directly would
     prove the panel and nothing about the key. */
  const pressed = await ctl("key", { key: "i", alt: true });
  expect(pressed.defaultPrevented).toBe(true);

  const snap = await until(
    "the shell to come up",
    () => snapshot(),
    (s) => s.shell.open && s.shell.live,
    15_000,
  );
  /* pwsh where there is one, powershell where there is not. Never neither. */
  expect(["pwsh", "powershell"]).toContain(snap.shell.program);
  expect((await ctl("dom", { selector: ".pane[aria-label='shell']" })).count).toBe(1);
}, 40_000);

t("a command runs, and its output comes back", async () => {
  await shellSettled();
  await ctl("shell", { do: "clear" });
  await ctl("shell", { do: "send", text: "Write-Output 'skein-wall-probe'" });
  await shellSettled();

  const lines = await shellLines();
  /* Echoed by us, because the shell echoes nothing back over a pipe. */
  expect(lines.some((l) => l.kind === "you" && l.text.includes("skein-wall-probe"))).toBe(true);
  expect(lines.some((l) => l.kind === "out" && l.text === "skein-wall-probe")).toBe(true);
}, 40_000);

t("cd moves the prompt, because the shell says where it is", async () => {
  await shellSettled();
  const before = (await snapshot()).shell.cwd;
  await ctl("shell", { do: "send", text: `Set-Location '${SCRATCH}'` });
  await shellSettled();

  /* The marker is the only thing that could have told us — nothing here parses
     what was typed, which is the point: `cd` is a thing you type, and so is a
     script that changes directory forty times without saying so. */
  const after = (await snapshot()).shell.cwd;
  expect(after).not.toBe(before);
  expect(after.toLowerCase()).toBe(SCRATCH.toLowerCase());
}, 40_000);

t("a command that failed is marked at the command, not in its output", async () => {
  await shellSettled();
  await ctl("shell", { do: "clear" });
  await ctl("shell", { do: "send", text: "thiscommanddoesnotexist" });
  await shellSettled();

  const lines = await shellLines();
  const you = lines.find((l) => l.kind === "you");
  expect(you?.failed).toBe(true);
  /* And what it complained about is kept, on the stream it complained on. */
  expect(lines.some((l) => l.kind === "err")).toBe(true);
}, 40_000);

t("putting the panel away does not end the session", async () => {
  await shellSettled();
  const was = (await snapshot()).shell.cwd;

  await ctl("key", { key: "i", alt: true });
  const hidden = await until(
    "the panel to go",
    () => snapshot(),
    (s) => !s.shell.open,
  );
  /* The whole shape of the thing: a build you started keeps building while you
     go back to the wall and read what an agent said about it. */
  expect(hidden.shell.live).toBe(true);
  expect((await ctl("dom", { selector: ".pane[aria-label='shell']" })).count).toBe(0);

  await ctl("key", { key: "i", alt: true });
  const back = await until(
    "the panel to come back",
    () => snapshot(),
    (s) => s.shell.open,
  );
  /* Same session, same directory — not a fresh shell at the project root. */
  expect(back.shell.cwd).toBe(was);
  expect(back.shell.lines).toBeGreaterThan(0);
}, 40_000);

t("closing it ends the process, and the next command starts another", async () => {
  await ctl("shell", { do: "show" });
  await ctl("shell", { do: "close" });
  expect((await snapshot()).shell.live).toBe(false);

  await ctl("shell", { do: "send", text: "Write-Output 'second'" });
  await shellSettled();
  expect((await shellLines()).some((l) => l.kind === "out" && l.text === "second")).toBe(true);

  await ctl("shell", { do: "close" });
  await ctl("shell", { do: "hide" });
}, 60_000);

t("each project keeps its own shell, and switching does not disturb it", async () => {
  await ctl("shell", { do: "show", cwd: SCRATCH });
  await shellSettled();
  await ctl("shell", { do: "clear" });
  await ctl("shell", { do: "send", text: "Write-Output 'in-scratch'" });
  await shellSettled();

  /* A second project, and the panel goes with it: a fresh shell, a fresh
     scrollback, and the first one still standing behind it. */
  await ctl("shell", { do: "select", cwd: WALL });
  const there = await until(
    "the second project's shell to come up",
    () => snapshot(),
    (s) => s.shell.active === WALL && s.shell.live && !s.shell.busy,
    30_000,
  );
  expect(there.shell.cwd.toLowerCase()).toBe(WALL.toLowerCase());
  /* Not the other project's output. This is the whole of what one-per-project
     buys, and a shared shell would have shown `in-scratch` here. */
  expect((await shellLines()).some((l) => l.text.includes("in-scratch"))).toBe(false);

  /* The one you are not looking at is still alive, which is why the header
     counts them: a build running in a project off screen is otherwise a fact
     with nowhere left to appear. */
  const scratch = there.shell.sessions.find(
    (x: { key: string }) => x.key.toLowerCase() === SCRATCH.toLowerCase(),
  );
  expect(scratch?.live).toBe(true);

  /* And going back is going back — the same session, with what it printed. */
  await ctl("shell", { do: "select", cwd: SCRATCH });
  const back = await until(
    "the first project's shell to come back",
    () => snapshot(),
    (s) => s.shell.active === SCRATCH,
    15_000,
  );
  expect(back.shell.live).toBe(true);
  expect((await shellLines()).some((l) => l.text.includes("in-scratch"))).toBe(true);

  await ctl("shell", { do: "close" });
  await ctl("shell", { do: "select", cwd: WALL });
  await ctl("shell", { do: "close" });
  await ctl("shell", { do: "hide" });
}, 90_000);

/* ── the undo stack ──────────────────────────────────────────────────── *
 *
 * The undo stack is the one thing on this wall whose correctness is entirely
 * about *sequences* of gestures — that a drag is one step, that a redo comes
 * back to the same place, that a removal can be undone at all — and a sequence
 * of real gestures is what this suite is for. `test/undo.test.ts` has the state
 * machine; what these check is the wiring: that the app's own paths report to
 * it, and that a step applied really does put the record back.
 *
 * Every one starts from `undo.clear`, so a test is only ever about its own
 * gestures rather than about whatever the test before it left standing. */

const undoState = async () => (await snapshot()).undo;

t("hanging up an instrument is one step, and the step names it", async () => {
  await ctl("undo.clear");
  const { id } = await ctl("widget.add", { kind: "clock", x: 260, y: 260 });
  hung.push(id as string);

  const past = await undoState();
  expect(past.back).toBe(1);
  /* Named off the catalogue, so a new kind of widget says its own name with
     nothing to wire. */
  expect(past.undoing).toBe("hanging up a clock");
  expect(past.redoing).toBeNull();

  /* And the way back takes it off the wall *and* out of the database — the
     second is the claim that survives a restart. */
  expect((await ctl("undo")).undid).toBe("hanging up a clock");
  expect((await snapshot()).widgets.some((w: Reply) => w.id === id)).toBe(false);
  await until(
    "the widget row to go",
    async () => widgetRows().some((r) => r.id === id),
    (there) => !there,
  );

  /* Forward again, and it is the same widget rather than a new one. */
  expect((await ctl("redo")).redid).toBe("hanging up a clock");
  const again = await until(
    "the widget to come back",
    () => snapshot(),
    (s) => s.widgets.some((w: Reply) => w.id === id),
  );
  const back = again.widgets.find((w: Reply) => w.id === id);
  expect(back.x).toBe(260);
  expect(back.y).toBe(260);
  /* Written down too, or it comes back for this session only. */
  await until(
    "the widget row to come back",
    async () => widgetRows().some((r) => r.id === id),
    (there) => there,
  );

  await ctl("widget.remove", { id });
});

t("taking an instrument down can be taken back, with its knobs", async () => {
  await ctl("undo.clear");
  const { id } = await ctl("widget.add", { kind: "clock", x: 300, y: 320 });
  hung.push(id as string);
  /* A knob turned, so what comes back has something to be wrong about. */
  await ctl("widget.set", { id, key: "variant", value: "digital" });
  const before = (await snapshot()).widgets.find((w: Reply) => w.id === id);

  await ctl("widget.remove", { id });
  expect((await snapshot()).widgets.some((w: Reply) => w.id === id)).toBe(false);

  expect((await ctl("undo")).undid).toBe("taking down a clock");
  const after = (
    await until(
      "the widget to come back",
      () => snapshot(),
      (s) => s.widgets.some((w: Reply) => w.id === id),
    )
  ).widgets.find((w: Reply) => w.id === id);
  expect(after.variant).toBe(before.variant);
  expect(after.config).toEqual(before.config);

  await ctl("widget.remove", { id });
});

t("turning a knob and turning it again comes home, however it fused", async () => {
  await ctl("undo.clear");
  await withWidget("clock", { x: 340, y: 380 }, async (id) => {
    const first = (await snapshot()).widgets.find((w: Reply) => w.id === id).variant;
    await ctl("widget.set", { id, key: "variant", value: "digital" });
    await ctl("widget.set", { id, key: "variant", value: "analog" });

    /* Whether those two fused into one act depends on how fast this machine got
       round the loop, which is not a thing to assert on — so the claim is the
       one that holds either way: stepping back until there is nothing left comes
       home, and never overshoots into the widget being gone. */
    for (let i = 0; i < 5; i++) {
      if ((await undoState()).back === 0) break;
      await ctl("undo");
    }
    expect((await undoState()).back).toBe(0);
    const home = (await snapshot()).widgets.find((w: Reply) => w.id === id);
    expect(home).toBeTruthy();
    expect(home.variant).toBe(first);
  });
});

t("an image removed comes back, and its file was still there to come back to", async () => {
  await ctl("undo.clear");
  expect((await ctl("drop", { path: IMAGE, x: 420, y: 260 })).fault).toBeNull();
  const shots = (await snapshot()).images;
  const img = shots[shots.length - 1];
  placed.push(img.id as string);
  const path = String(img.path);
  expect(await Bun.file(path).exists()).toBe(true);

  await ctl("image.remove", { id: img.id });
  expect((await snapshot()).images.some((i: Reply) => i.id === img.id)).toBe(false);
  /* The whole point of `delete_image` no longer taking the file with the row: a
     step back that restored a row pointing at a file we had just deleted would
     put a broken rectangle on the wall — the failure `Board.remove`'s own note is
     about, arriving by a new route. */
  expect(await Bun.file(path).exists()).toBe(true);

  expect((await ctl("undo")).undid).toBe("removing an image");
  await until(
    "the image to come back",
    () => snapshot(),
    (s) => s.images.some((i: Reply) => i.id === img.id),
  );
  /* Drawn, not merely in the model. */
  expect((await ctl("dom", { selector: `[data-image="${img.id}"]` })).count).toBe(1);
});

t("moving a card is one step, and stepping back puts it back to flowing", async () => {
  await ctl("undo.clear");
  const before = (await snapshot()).cards.find((c: Reply) => c.id === card);
  expect(before).toBeTruthy();

  await ctl("pin", { id: card, x: 900, y: 640 });
  const pinned = await undoState();
  expect(pinned.back).toBe(1);
  expect(pinned.undoing).toBe("moving a card");
  expect((await snapshot()).cards.find((c: Reply) => c.id === card).placement)
    .toMatchObject({ x: 900, y: 640, pinned: true });

  expect((await ctl("undo")).undid).toBe("moving a card");
  /* Back to whatever it was, which for a card never dragged is *no record at
     all* rather than a pin at the old coordinates — null is a real answer, and
     half a record put back is what `Studio.forget` exists for. */
  const home = (await snapshot()).cards.find((c: Reply) => c.id === card);
  expect(home.placement).toEqual(before.placement);
});

t("a new gesture closes the way forward", async () => {
  await ctl("undo.clear");
  await withWidget("clock", { x: 380, y: 420 }, async (id) => {
    await ctl("widget.update", { id, x: 400, y: 440 });
    await ctl("undo");
    expect((await undoState()).forward).toBeGreaterThan(0);

    /* Something new, and the branch stepped past is gone — there is one history
       here, not a tree. */
    await ctl("widget.update", { id, x: 420, y: 460 });
    expect((await undoState()).forward).toBe(0);
  });
});

t("a press with nothing behind it says so and changes nothing", async () => {
  await ctl("undo.clear");
  const before = await snapshot();
  const res = await ctl("undo");
  expect(res.undid).toBeNull();
  expect(res.back).toBe(0);
  expect((await ctl("redo")).redid).toBeNull();
  const after = await snapshot();
  expect(after.widgets).toHaveLength(before.widgets.length);
  expect(after.images).toHaveLength(before.images.length);
});

/* The gesture must not be taken from a field. A textarea's undo is the
   browser's, it is what your hands expect while a prompt is half written, and
   there is nothing on this wall worth taking it for. */
t("ctrl+Z in the draft is the field's, not the wall's", async () => {
  await ctl("undo.clear");
  await withWidget("clock", { x: 460, y: 300 }, async (id) => {
    await ctl("widget.update", { id, x: 480, y: 320 });
    const depth = (await undoState()).back;
    expect(depth).toBeGreaterThan(0);

    await ctl("key", { selector: "textarea", key: "z", ctrl: true });

    /* Untouched: the key never reached the wall. */
    expect((await undoState()).back).toBe(depth);
    expect((await snapshot()).widgets.find((w: Reply) => w.id === id).x).toBe(480);
  });
});

t("the ground's own menu offers the way back, named", async () => {
  await ctl("undo.clear");
  await withWidget("clock", { x: 500, y: 340 }, async (id) => {
    await ctl("widget.update", { id, x: 520, y: 360 });
    await ctl("menu", { selector: ".surface" });
    const items = await ctl("dom", { selector: "[data-menu]" });
    const labels = items.nodes.map((n: Reply) => String(n.text ?? ""));
    /* Named rather than a bare "undo" — a stack you cannot see is a gesture you
       have to guess at. */
    expect(labels.some((l: string) => l.startsWith("undo moving a widget"))).toBe(true);
    await ctl("key", { selector: ".surface", key: "Escape" });
  });
});

/* ── the pointer ladder, and a scroller that was moved ────────────────── */

/* Four tests over the two gaps this suite had, and they are arranged as the
 * ladder `control.md` describes rather than as four independent checks: the
 * first two run in every run and prove the app's own bookkeeping, the last two
 * need the mouse lent to them and prove that a gesture reaches the thing it was
 * aimed at. Neither pair is redundant with the other, and the rule says why. */

/** A long file, so `.sheet` has something below the fold. This one, because a
 *  test that scrolls a scroller needs overflow and a file in the repo is the
 *  cheapest reliable source of it — and the control surface's own module is
 *  three thousand lines, which no theme or reading size is going to shrink into
 *  one panel. */
const LONG = "src\\lib\\control.svelte.ts";
const OTHER = "src\\lib\\follow.ts";

/** How far the viewer is scrolled, without moving it. */
const sheetAt = async () => (await ctl("scroll", { selector: ".sheet" })).scrollTop;

t("a dog-ear remembers where you were reading, not the line it was opened at", async () => {
  /* The sink item this test exists for (59f00bee): the tabs remember a reading,
     and from outside there was no way to build a state where the restored
     reading *differs* from the open-at-the-line fallback — because a tab's line
     and its remembered place always agree until something scrolls. The only
     scroll the surface could cause was the app's own `scrollIntoView` on that
     same line, so "restored your reading" and "re-centred the line" were one
     observation. This is that state, built. */
  await ctl("find", { do: "look-at", cwd: REPO, path: LONG, line: 40 });
  const centred = await until(
    "the viewer to open and centre line 40",
    async () => (await ctl("scroll", { selector: ".sheet" })).scrollTop,
    (n) => n > 0,
  );

  /* Somewhere else entirely — the far end of the file, which is nowhere near
     line 40 whatever the font is doing. A written `scrollTop` is a real scroll:
     it fires the same `scroll` event a wheel does, and `Spyglass.reading` takes
     `el.scrollTop` without caring which. */
  const parked = await ctl("scroll", { selector: ".sheet", to: "bottom" });
  expect(parked.atBottom).toBe(true);
  expect(parked.scrollTop).toBeGreaterThan(centred);

  /* Away to another file, which is what turns the first one into a tab carrying
     a reading. */
  await ctl("find", { do: "look-at", cwd: REPO, path: OTHER });
  const away = await snapshot();
  const tab = away.finder.tabs.find((d: Reply) => d.path === LONG);
  expect(tab).toBeTruthy();
  /* The tab says it kept a place, but deliberately not what the place was — a
     scroll offset in pixels is a fact about a font. Which is exactly why the
     assertion below is two readings of the same scroller against each other. */
  expect(tab.read).toBe(true);
  expect(tab.line).toBe(40);

  /* And back. */
  await ctl("find", { do: "resume", path: LONG });
  const back = await until(
    "the viewer to come back to the tab's own reading",
    async () => (await ctl("scroll", { selector: ".sheet" })).scrollTop,
    (n) => n > centred,
  );

  /* The whole distinction, in two lines. Where we parked, not where the line is:
     with `putBack` inert this comes back at `centred` and passes every other
     assertion in this test. A few pixels of slack because coming back re-renders
     the column and `putBack` writes after a `tick`. */
  expect(Math.abs(back - parked.scrollTop)).toBeLessThan(8);
  expect(back).toBeGreaterThan(centred + 100);

  await ctl("find", { do: "hide" });
});

t("a press dismisses the viewer where a click cannot reach it", async () => {
  /* The other half of 59f00bee. `click` is `el.click()`, which fires exactly one
     event — and every dismissible thing on this wall closes on `pointerdown`, on
     the stated argument that the panel should be gone before whatever is
     underneath decides what the press meant. So the one gesture those components
     exist to get right was the one gesture this suite could not make. */
  await ctl("find", { do: "look-at", cwd: REPO, path: OTHER });
  expect((await snapshot()).finder.sheet).toContain("follow.ts");

  /* Rung one is not enough, and this asserts that rather than assuming it: a
     click on the wall leaves the viewer standing, because there is no `click`
     handler anywhere in the dismissal. If this ever starts closing the panel,
     the `press` op below has stopped being the only way in and the rule wants
     revisiting. */
  await ctl("click", { selector: ".surface" });
  expect((await snapshot()).finder.open).toBe(true);

  /* Rung two. The same target, the whole ladder. */
  const press = await ctl("press", { selector: ".surface" });
  /* Nothing threw on the way through. A synthetic gesture that trips
     `setPointerCapture` shows up here rather than as a quietly incomplete one. */
  expect(press.errors).toEqual([]);

  const after = await snapshot();
  expect(after.finder.open).toBe(false);
  /* And it left a pill behind, which is the whole reason a stray press is
     allowed to mean this: leaving no longer costs you the file. */
  expect(after.finder.tabs.some((d: Reply) => d.path === OTHER)).toBe(true);
});

ti("a real wheel over the viewer scrolls the file and not the wall", async () => {
  /* Rung three, and it proves the half the other two assume. `scroll` writes
     `scrollTop` and therefore cannot see *which* scroller a gesture lands on —
     and the viewer sits over a wall whose bare wheel zooms, so "the wheel went
     to the file" is a real claim with a real way to be wrong. */
  await ctl("find", { do: "look-at", cwd: REPO, path: LONG, line: 1 });
  await until(
    "the viewer to open",
    async () => (await snapshot()).finder.sheet,
    (p) => typeof p === "string" && p.endsWith("control.svelte.ts"),
  );
  const before = await ctl("scroll", { selector: ".sheet" });
  const view = (await snapshot()).viewport;

  await ctl("real.wheel", { selector: ".sheet", notches: 6 });

  const after = await ctl("scroll", { selector: ".sheet" });
  /* Positive notches scroll down, which is `deltaY`'s sense and the synthetic
     `wheel` op's. Win32 means the opposite by a positive wheel and `control.rs`
     does the flip once — so a regression there lands here as a scroll upward
     from a scroller already at the top, i.e. as no movement at all. */
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop);

  /* And the wall did not zoom under it. The pane is not inside `.surface`, but
     nothing stops a wheel from reaching the window's own listeners. */
  const now = (await snapshot()).viewport;
  expect(now.scale).toBe(view.scale);
  expect(now.y).toBe(view.y);

  await ctl("find", { do: "hide" });
});

ti("End reaches the bottom of the file, because the sheet holds the keyboard", async () => {
  /* `.sheet` is `tabindex="-1"` on purpose — the comment above it says "so the
     arrows scroll the file rather than doing nothing" — and that was a claim
     nothing could check. A dispatched keydown moves no scroller: there is no
     default action on a synthetic event to be taken, so End over the control
     surface did nothing and the app's own handler correctly ignores it ("arrows,
     page keys, Home and End all mean in a file exactly what they mean in a
     file"). Only a trusted key can demonstrate the arrangement works. */
  await ctl("find", { do: "look-at", cwd: REPO, path: LONG, line: 1 });
  const start = await until(
    "the viewer to open at the top",
    async () => await ctl("scroll", { selector: ".sheet" }),
    (v) => v.max > 0 && v.scrollTop < 40,
  );

  /* The precondition, asserted rather than assumed — and this is what
     `focusedClass` is for. `focusedTag` alone answers "DIV", which is every
     other box on the wall as well. */
  const focus = await snapshot();
  expect(focus.dom.focusedTag).toBe("DIV");
  expect(focus.dom.focusedClass).toContain("sheet");

  await ctl("real.key", { key: "End" });

  const end = await until(
    "End to carry the reading to the bottom",
    async () => await ctl("scroll", { selector: ".sheet" }),
    (v) => v.atBottom,
  );
  expect(end.scrollTop).toBeGreaterThan(start.scrollTop);

  /* And Home comes back, so what was measured was the key and not a scroller
     that had drifted. */
  await ctl("real.key", { key: "Home" });
  const home = await until(
    "Home to bring it back",
    async () => await ctl("scroll", { selector: ".sheet" }),
    (v) => v.atTop,
  );
  expect(home.scrollTop).toBe(0);

  await ctl("find", { do: "hide" });
});

/* ── nothing broke on the way past ───────────────────────────────────── */

t("the page threw nothing while all of that happened", async () => {
  const snap = await snapshot();
  /* Silent front-end errors are the one class a screenshot cannot show, so the
     surface taps window.onerror and console.error and carries them along. */
  expect(snap.errors).toEqual([]);
  expect(snap.fault).toBeNull();
});
