/* Can a small model turn a spoken sentence into an ordered plan of wall ops,
 * with its referents resolved against a known wall?
 *
 * This is the probe `docs/VOICE.md` names as the one that decides whether the
 * decided shape is the right one, and it is the cheap half of the feature: no
 * audio, no microphone, no app, no Rust. Thirty written utterances — the five
 * the user actually asked for, plus compound ones, ambiguous ones, and several
 * built to be misread — against a fixture wall whose contents are known, so a
 * resolved referent can be checked rather than admired.
 *
 *   bun tools/probe-steward.ts --dry            # the prompt and the table, spends nothing
 *   bun tools/probe-steward.ts                  # haiku and sonnet, all thirty
 *   bun tools/probe-steward.ts --model haiku    # one model
 *   bun tools/probe-steward.ts --only 9,13,27   # a few, by id
 *
 * ### What it isolates, and what it therefore cannot see
 *
 * It asks for **JSON in a reply** rather than giving the model real MCP tools.
 * That is deliberate and it is the one variable held apart: the question here is
 * whether the *parse* is any good — whether "select the auth work and open
 * image.png in caravan" comes back as two steps in the right order with the
 * right referents — and wiring an MCP server to find out would mix parse quality
 * with tool-schema plumbing and with the roster's own attention budget.
 *
 * So what it cannot see, stated plainly because `probe-guidance.ts` was green
 * for a fortnight while the feature it attested to was inert:
 *
 *  - **Whether the same quality holds with real tools.** A steward with thirty
 *    MCP tools in front of it is answering a different question from one filling
 *    in a JSON shape, and tool-use decoding is not the same decoder as text.
 *  - **Whether it holds on the app's own argv.** This builds its own, per
 *    `probe-context.ts`'s pattern, so it proves a mechanism and not a
 *    configuration. The lesson from `probe-guidance.ts`: where the argv is the
 *    thing in question, the argv has to come from where the app's comes from.
 *  - **Anything about speech.** Every utterance here is already text. The
 *    transcription is a separate probe with a separate failure mode, and the
 *    spoken-path cases below (`image dot png`, `source slash lib`) are written
 *    the way an engine would hand them over rather than the way a person talks.
 *
 * ### The one thing it is built to test that is a *design* claim, not a model one
 *
 * `docs/VOICE.md` decides that **a step's disposition is a table and not a
 * judgement** — the model returns steps, and whether the plan needs confirming
 * is computed here, from the op names, by the complement of the undo stack. So
 * `needs` below is never read out of the reply. `voice.ts`'s `IMMEDIATE` is that
 * table, imported rather than copied, and a wrong entry in it is a worse bug
 * than any misparse.
 *
 * **`stop` is the entry to argue about.** By the rule it confirms: it holds a
 * process, so the undo stack refuses it, so voice asks first. But Escape stops a
 * turn today with no confirmation at all, and "stop" is the one thing you want
 * to be instant when a card is going wrong. The counter-argument is that a
 * misheard "stop" is possible where a pressed Escape is not. Utterance 23 exists
 * to put a real answer under that; the table's current entry is a position, not
 * a finding.
 */


/* ── the wall these utterances are spoken at, and the utterances ──────────────
 *
 * Both live in `test/fixtures/wall.ts`, because `test/voice.test.ts` scores the
 * grammar rung against them and this scores the model rung, and a ladder whose
 * two rungs were measured on two different walls has produced two numbers that
 * cannot be compared. The traps in the fixture are documented there.
 */

import { CASES, CARDS, FOCUSED, TERRITORIES, type Case } from "../test/fixtures/wall";

/* ── the disposition table, which is the design's and not the model's ─────────
 *
 * Imported rather than restated. `docs/VOICE.md` decides that **a step's
 * disposition is a table and not a judgement** — the model returns steps, and
 * whether the plan needs confirming is computed from the op names by the
 * complement of the undo stack. So `needs` below is never read out of the reply,
 * and the table it is computed from is the one that ships. A second copy here
 * would be a probe attesting to a table nobody uses.
 */

import { dispositionOf } from "../src/lib/voice";

/* ── the prompt, and the reading of the reply ─────────────────────────────────
 *
 * Both imported, and until this file existed neither was. The prompt lived here,
 * which meant **this probe scored a prompt only this probe had** — a number
 * about nothing, and the sort of gap `probe-guidance.ts` was green for a
 * fortnight over. `stewardPrompt(wall)` is now what the app sends, so 28/30 is a
 * claim about the product.
 *
 * `understand()` came with it, and it changes what a run means. It re-checks
 * every referent against the wall, every path against the territory's own file
 * list, and every payload against the transcript — so `usable` below is not
 * another rubric, it is **the gate the app will actually put a reply through**.
 * A reply can be graded right by the columns beside it and still be refused
 * there, and the interesting runs are the ones where those two disagree.
 *
 * **What is unmeasured, stated because it is a prediction and not a result:**
 * the verbatim check is stricter than the `text` column ever was — that one
 * looked for a chosen fragment as a substring, this one requires the whole
 * payload to appear in the utterance. The prompt tells the model to resolve
 * spoken separators ("dot" → "."), which is meant for paths, and a model that
 * applies it to a *payload* — sending "markdown.ts" where "markdown dot ts" was
 * said — will fail the check while looking entirely sensible. Utterance 29 is
 * the one that would show it. The prompt is deliberately left byte-identical to
 * what scored 28/30 rather than pre-emptively reworded: if the run shows this,
 * the change is motivated; if it does not, the wording is fine and nothing was
 * spent finding out.
 */

import { replyIn, stewardPrompt, understand, type Reply } from "../src/lib/steward";
import type { Wall } from "../src/lib/voice";

const WALL: Wall = { cards: CARDS, territories: TERRITORIES, focusedId: FOCUSED };
const systemPrompt = () => stewardPrompt(WALL);

/* ── running one ─────────────────────────────────────────────────────────────── */

const CWD = import.meta.dir + "/../.scratch/steward-probe";
const CLAUDE = "claude";

async function ask(model: string, say: string): Promise<{ said: string; ms: number; model: string }> {
  const args = [
    "--print",
    "--output-format", "json",
    "--model", model,
    /* Nothing to reach for. The parse is the whole question, and a steward that
       went off to read a file would be answering a different one — and spending
       an allowance on it. `aside.rs` passes the same for the same reason. */
    "--tools", "",
    /* **`--tools ""` does not stop the servers from starting**, and measured
       here that is 1.4s of the wait: a default `claude --print` on this machine
       loads the whole MCP roster — blender, two Houdinis, both browsers, skein —
       before it answers anything. Measured 2026-09-05 with a one-word prompt:
       ~2000ms default, ~640ms with these two flags. A steward booting Blender to
       parse "select card A" is absurd on its face, and it is also the single
       cheapest latency win available, so it is not merely a probe convenience —
       the shipped steward owes the same pair. */
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    /* **`--tools` and `--mcp-config` are variadic, and the prompt is a
       positional — so neither may be the last flag.** Both are `<x...>` in the
       CLI's own help, and commander goes on collecting until it meets something
       beginning with `-`. Put either immediately before the prompt and it eats
       it, which fails in two different disguises:

         claude … --mcp-config '{"mcpServers":{}}' "say this"
           → Invalid MCP configuration: MCP config file not found: …/say this
         claude … --tools "" "say this"
           → Input must be provided either through stdin or as a prompt argument

       The first cost three bad measurements on 2026-09-05: it exits in ~600ms,
       and a timing harness reads that as *fast* rather than as *failed*, so
       "MCP loading costs 1.4s" was recorded off a run that never made a
       request. **A wrong argv here does not look like a wrong argv; it looks
       like a result.** `--append-system-prompt` sits last on purpose — it takes
       exactly one value, which terminates whatever was collecting above it. */
    "--append-system-prompt", systemPrompt(),
  ];

  const began = Date.now();
  const child = Bun.spawn([CLAUDE, ...args, say], {
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  const ms = Date.now() - began;

  let said = "";
  /* The configured id as the CLI reports it, rather than the alias asked for —
     `--model haiku` is a request and `system/init` is the answer. Reported
     because a probe that assumed which model ran would be attesting to the
     wrong one. */
  let ran = model;
  try {
    const v = JSON.parse(out);
    said = String(v.result ?? "");
    /* **`modelUsage` carries more than one model, and the first key is not the
       one that answered.** Measured 2026-09-05 on `--model sonnet`: the object
       holds `claude-haiku-4-5-20251001` (523 in, 12 out) *and*
       `claude-sonnet-5` (28k in) — the CLI runs a small Haiku side-task of its
       own per invocation, and it sorts first. Taking `keys()[0]` therefore
       labelled a whole sonnet run as haiku, which is the sort of error that
       makes a comparison worse than not having run it. The busiest model is the
       one that did the work. */
    if (v.modelUsage) {
      const weigh = (u: any) =>
        (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0);
      ran =
        Object.entries(v.modelUsage as Record<string, unknown>).sort(
          (a, b) => weigh(b[1]) - weigh(a[1]),
        )[0]?.[0] ?? model;
    }
  } catch {
    said = out;
  }
  if (!said && err) said = `<stderr> ${err.slice(0, 300)}`;
  return { said, ms, model: ran };
}

/* ── scoring ─────────────────────────────────────────────────────────────────── */

type Score = {
  shape: boolean;       // plan / ask / decline / question, as expected
  ops: boolean;         // the op sequence, in order
  refs: boolean;        // every expected referent present, resolved
  text: boolean;        // payloads carried verbatim
  needs: boolean;       // the computed disposition matches the table
  parsed: boolean;
  fenced: boolean;
  /** How many steps came back. The danger check reads this rather than the
   *  shape, because an utterance answered with a question produced no steps and
   *  is therefore safe however far it is from what was expected. */
  steps: number;
  /** True when the second acceptable answer was the one that matched. Counted
   *  apart so "right, on the reading I did not write down first" never hides
   *  inside a plain pass. */
  viaAlt: boolean;
  /** What `understand()` — the gate the app will actually put this reply through
   *  — made of it, and why if it refused.
   *
   *  Reported *beside* the columns above rather than folded into them, because
   *  the two are different questions and the interesting runs are the ones where
   *  they disagree. A reply can be graded right by every column and still be
   *  refused here (a payload the model tidied, a path it adjusted), and it can be
   *  graded wrong and still pass here (a defensible reading of an ambiguous
   *  sentence). Folding them would hide exactly the cases worth reading. */
  gate: string;
  got: string;
};

function argsText(step: { args: Record<string, unknown> }): string {
  return JSON.stringify(step.args ?? {});
}

function grade(c: Case, reply: Reply | null, fenced: boolean): Score {
  const bad: Score = { shape: false, ops: false, refs: false, text: false, needs: false, parsed: false, fenced, steps: 0, viaAlt: false, gate: "unusable", got: "—" };
  if (!reply) return bad;

  /* The shipped gate, on the real utterance and the real wall. */
  const u = understand(reply, c.say, WALL);
  const gate = u.kind === "unusable" ? `unusable: ${u.why}` : u.kind;

  const shapeGot: Case["want"] = reply.steps.length
    ? "plan"
    : reply.question
      ? "question"
      : reply.ask
        ? "ask"
        : "decline";

  const gotOps = reply.steps.map((s) => String(s.op));
  const fits = (w: Case["want"], want?: string[]) =>
    shapeGot === w && (want ? gotOps.length === want.length && gotOps.every((o, i) => o === want[i]) : true);

  /* The primary reading, then the second acceptable one. Two of these
     utterances have a defensible answer I did not write down first — "select
     caravan" and "open in caravan" — and scoring them as failures made the
     model look worse than it is while teaching me nothing. A case that needs an
     `also` is usually a case whose *sentence* is ambiguous, which is a finding
     about the sentence rather than about the parser. */
  const primary = fits(c.want, c.ops);
  const viaAlt = !primary && !!c.also && fits(c.also.want, c.also.ops);
  const as = viaAlt ? c.also! : { want: c.want, ops: c.ops, refs: c.refs };

  const shape = shapeGot === as.want;
  const ops = as.ops ? gotOps.length === as.ops.length && gotOps.every((o, i) => o === as.ops![i]) : shape;

  /* Every expected referent must appear in some step's arguments. Deliberately
     not position-checked: which step carries which id is the ops check's job,
     and an over-specified assertion here would fail on a correct plan that
     ordered two selects differently. */
  const all = reply.steps.map(argsText).join(" ");
  const refs = as.refs ? as.refs.every((r) => all.includes(r)) : true;

  /* Verbatim, case-insensitively — an engine's capitalisation is not the
     model's fault, but a rewording is. */
  const low = all.toLowerCase();
  const text = c.text ? c.text.every((t) => low.includes(t.toLowerCase())) : true;

  const needs = as.want === "plan" ? dispositionOf(gotOps) === dispositionOf(as.ops ?? gotOps) : true;

  return {
    shape,
    ops,
    refs,
    text,
    needs,
    parsed: true,
    fenced,
    steps: reply.steps.length,
    viaAlt,
    gate,
    got:
      shapeGot === "plan"
        ? gotOps.join(" → ") || "empty plan"
        : shapeGot === "question"
          ? `question: ${reply.question}`
          : shapeGot === "ask"
            ? `ask: ${reply.ask}`
            : `decline: ${reply.decline}`,
  };
}

/* ── the run ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry");
const MODELS = flag("--model") ? [flag("--model")!] : ["haiku", "sonnet"];
const ONLY = flag("--only")?.split(",").map((s) => Number(s.trim()));
const PICK = ONLY ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
/* Four at a time. Each is a process and a round trip; sequential is minutes and
   unbounded is a fleet of `claude` children on a machine that has work to do. */
const LANES = Number(flag("--lanes") ?? 4);

if (DRY) {
  console.log("=== system prompt ===\n");
  console.log(systemPrompt());
  console.log(`\n=== ${PICK.length} utterances ===\n`);
  for (const c of PICK) {
    console.log(
      `${String(c.id).padStart(2)}  ${c.want.padEnd(7)}  ${c.ops?.join(" → ") ?? ""}\n` +
        `    say:  ${c.say}\n    why:  ${c.why}\n`,
    );
  }
  console.log(
    `disposition per the table: ${PICK.filter((c) => c.ops && dispositionOf(c.ops) === "confirmation").length}` +
      ` of ${PICK.filter((c) => c.ops).length} plans would be confirmed`,
  );
  process.exit(0);
}

await Bun.$`mkdir -p ${CWD}`.quiet();

for (const model of MODELS) {
  console.log(`\n╔═ ${model} ${"═".repeat(Math.max(0, 60 - model.length))}`);

  const rows: { c: Case; s: Score; ms: number; ran: string }[] = [];
  const queue = [...PICK];
  await Promise.all(
    Array.from({ length: Math.min(LANES, queue.length) }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        const { said, ms, model: ran } = await ask(model, c.say);
        const { reply, fenced } = replyIn(said);
        rows.push({ c, s: grade(c, reply, fenced), ms, ran });
      }
    }),
  );
  rows.sort((a, b) => a.c.id - b.c.id);

  for (const { c, s, ms } of rows) {
    const mark = (ok: boolean, ch: string) => (ok ? ch : ch.toUpperCase().replace(/[a-z]/, "·"));
    const flags =
      (s.shape ? "shape " : "SHAPE ") +
      (s.ops ? "ops " : "OPS  ") +
      (s.refs ? "refs " : "REFS ") +
      (s.text ? "text " : "TEXT ") +
      (s.needs ? "needs" : "NEEDS");
    const all = s.parsed && s.shape && s.ops && s.refs && s.text && s.needs;
    console.log(
      `${all ? "  ok " : "FAIL "}${String(c.id).padStart(2)}  ${String(ms).padStart(5)}ms  ${flags}` +
        `${s.fenced ? "  (fenced)" : ""}${s.parsed ? "" : "  (unparseable)"}\n` +
        `        say  ${c.say}\n` +
        `        got  ${s.got}\n` +
        `        gate ${s.gate}` +
        (all ? "" : `\n        want ${c.want}${c.ops ? `: ${c.ops.join(" → ")}` : ""}${c.refs ? `  refs ${c.refs.join(", ")}` : ""}`),
    );
  }

  const n = rows.length;
  const tally = (f: (s: Score) => boolean) => rows.filter((r) => f(r.s)).length;
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const clean = rows.filter((r) => r.s.parsed && r.s.shape && r.s.ops && r.s.refs && r.s.text && r.s.needs).length;
  /** Acted on something that was not an instruction.
   *
   *  **Asking is not acting**, and conflating the two is a bug this check had:
   *  it was `want === "decline" && !shape`, which fired on a remark the model
   *  answered by *asking what to do about it* — the safe outcome — and printed
   *  "ACTED ON A REMARK" over it. A probe that cries wolf about its own best
   *  case is worse than one with no check, because the headline is what gets
   *  read. The test is whether there are **steps**. */
  const dangerous = rows.filter(
    (r) => (r.c.want === "decline" || r.c.want === "question") && r.s.steps > 0,
  );

  console.log(
    `\n  ─ ${rows[0]?.ran ?? model} ─\n` +
      `  wholly right    ${clean}/${n}\n` +
      `  parsed          ${tally((s) => s.parsed)}/${n}   (clean JSON: ${tally((s) => s.parsed && !s.fenced)})\n` +
      `  right shape     ${tally((s) => s.shape)}/${n}\n` +
      `  right ops       ${tally((s) => s.ops)}/${n}\n` +
      `  referents       ${tally((s) => s.refs)}/${n}\n` +
      `  payload verbatim${tally((s) => s.text)}/${n}\n` +
      /* What the app would have done with these replies, which is the only
         column that is about the product rather than about the model. A gap
         between this and `wholly right` is the thing to read: replies the rubric
         liked and the gate refused are either a check that is too strict or a
         prompt that needs a clause, and the `gate` line on each case says which
         check bit. */
      `  the gate allowed ${tally((s) => !s.gate.startsWith("unusable"))}/${n}` +
      `   (as a plan: ${tally((s) => s.gate === "plan")})\n` +
      `  latency         median ${times[Math.floor(times.length / 2)]}ms, worst ${times[times.length - 1]}ms\n` +
      (dangerous.length
        ? `  ⚠ ACTED ON A REMARK: ${dangerous.map((r) => r.c.id).join(", ")} — read these before anything else\n`
        : `  ✓ declined every remark and question\n`),
  );
}
