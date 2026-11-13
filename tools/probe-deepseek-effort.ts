/* DeepSeek effort probe.
 *
 * Run from a DeepSeek provider card: the shell holds ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN, so the key is never printed or moved.
 *
 * Two questions, one variable at a time:
 *
 * 1. Does DeepSeek's own `output_config.effort` (low/high/max) change the
 *    answer, the output tokens or the thinking? That is the provider's real
 *    depth control; `thinking.budget_tokens` is documented but ignored.
 * 2. Does the wall's `--effort` (low/medium/high/xhigh/max) reach that dial
 *    from the `claude` CLI? And does MAX_THINKING_TOKENS=0 suppress thinking?
 *
 * Bounded: two prompts for flash on the direct API, all four efforts; one
 * prompt for pro at the ends; the CLI on two prompts and the same levels.
 * Every call is written to `.scratch-ee6e4f71/deepseek-effort.json` as it
 * lands, so a slow machine does not lose what was measured.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.ANTHROPIC_BASE_URL;
const KEY = process.env.ANTHROPIC_AUTH_TOKEN;
if (!BASE || !KEY) {
  console.error("run this from a DeepSeek provider card (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)");
  process.exit(2);
}

const OUT_DIR = ".scratch-ee6e4f71";
const OUT = `${OUT_DIR}/deepseek-effort.json`;
mkdirSync(OUT_DIR, { recursive: true });
/* The provider's second lock: an empty credential store, so the nested CLI
   cannot fall back to the machine's own sign-in. */
const STORE = resolve(OUT_DIR, "empty-store");
mkdirSync(STORE, { recursive: true });

type Row = {
  mode: "direct" | "cli";
  model: string;
  prompt: string;
  effort: string;
  thinking_env: string | null;
  status: string;
  ms: number;
  out_tokens: number | null;
  in_tokens: number | null;
  think_chars: number;
  text: string;
  correct: boolean | null;
  error?: string;
};

const rows: Row[] = [];
function save() {
  writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), base: BASE, rows }, null, 2));
}

const prompts = [
  {
    id: "batball",
    text: "A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much does the ball cost? Answer with the number only.",
    check: (t: string) => /\b(0?\.05|5\s*cents?|five\s*cents?)\b/i.test(t),
  },
  {
    id: "zeros",
    text: "What is the smallest positive integer n such that n! has exactly 100 trailing zeros? Answer with the number only.",
    check: (t: string) => /\b405\b/.test(t),
  },
  {
    id: "palindrome",
    text: "Write a TypeScript function isPalindrome(s: string): boolean that ignores case and non-alphanumeric characters. Output only the function.",
    check: (t: string) => /function\s+isPalindrome/i.test(t),
  },
];

const directEfforts = ["none", "low", "medium", "high", "xhigh", "max"];
const cliEfforts = ["none", "low", "medium", "high", "xhigh", "max"];

async function direct(model: string, p: (typeof prompts)[number], effort: string): Promise<Row> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    thinking: { type: "enabled" },
    messages: [{ role: "user", content: [{ type: "text", text: p.text }] }],
  };
  if (effort !== "none") body.output_config = { effort };
  const t = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const j: any = await r.json();
    const blocks: any[] = Array.isArray(j.content) ? j.content : [];
    const think = blocks.filter((b) => b?.type === "thinking").map((b) => b?.thinking ?? "").join("");
    const text = blocks.filter((b) => b?.type === "text").map((b) => b?.text ?? "").join("").trim();
    return {
      mode: "direct",
      model,
      prompt: p.id,
      effort,
      thinking_env: null,
      status: String(r.status),
      ms: Date.now() - t,
      out_tokens: j.usage?.output_tokens ?? null,
      in_tokens: j.usage?.input_tokens ?? null,
      think_chars: think.length,
      text: text.slice(0, 120),
      correct: text ? p.check(text) : null,
      error: j.error?.message,
    };
  } catch (e: any) {
    return {
      mode: "direct", model, prompt: p.id, effort, thinking_env: null,
      status: "ERR", ms: Date.now() - t, out_tokens: null, in_tokens: null,
      think_chars: 0, text: "", correct: null, error: String(e?.message ?? e),
    };
  }
}

function cli(modelAlias: string, p: (typeof prompts)[number], effort: string, thinkingEnv: string | null): Row {
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", modelAlias];
  if (effort !== "none") args.push("--effort", effort);
  args.push(p.text);
  const env: Record<string, string | undefined> = { ...process.env };
  /* The provider card's exact isolation: the subscription and the machine's
     sign-in must not outrank the provider's token, and the CLI must not talk
     to Anthropic for anything else. */
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = STORE;
  if (thinkingEnv === "unset") delete env.MAX_THINKING_TOKENS;
  else if (thinkingEnv !== null) env.MAX_THINKING_TOKENS = thinkingEnv;
  const t = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    const proc = Bun.spawnSync(["claude", ...args], {
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    });
    stdout = proc.stdout.toString();
    stderr = proc.stderr.toString();
  } catch (e: any) {
    return {
      mode: "cli", model: modelAlias, prompt: p.id, effort, thinking_env: thinkingEnv,
      status: "ERR", ms: Date.now() - t, out_tokens: null, in_tokens: null,
      think_chars: 0, text: "", correct: null, error: String(e?.message ?? e),
    };
  }
  let think = "";
  let text = "";
  let out: number | null = null;
  let input: number | null = null;
  let status = "ok";
  let error: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && ev.message) {
      for (const b of ev.message.content ?? []) {
        if (b?.type === "thinking") think += b.thinking ?? "";
        if (b?.type === "text") text += b.text ?? "";
      }
      if (ev.message.usage?.output_tokens != null) out = ev.message.usage.output_tokens;
      if (ev.message.usage?.input_tokens != null) input = ev.message.usage.input_tokens;
    }
    if (ev.type === "result") {
      if (ev.is_error) { status = "result_error"; error = String(ev.result ?? "").slice(0, 160); }
      if (ev.usage?.output_tokens != null) out = ev.usage.output_tokens;
      if (ev.usage?.input_tokens != null) input = ev.usage.input_tokens;
      if (typeof ev.result === "string" && ev.result.trim()) text = ev.result;
    }
  }
  text = text.trim();
  return {
    mode: "cli", model: modelAlias, prompt: p.id, effort, thinking_env: thinkingEnv,
    status, ms: Date.now() - t, out_tokens: out, in_tokens: input,
    think_chars: think.length, text: text.slice(0, 120),
    correct: text ? p.check(text) : null,
    ...(error ? { error } : {}),
  };
}

async function main() {
  // 1. The provider's own dial: flash on two prompts at every level, plus the
  //    aliases medium/xhigh to see whether they really equal high.
  for (const p of [prompts[0], prompts[1]]) {
    for (const e of directEfforts) {
      const r = await direct("deepseek-flash", p, e);
      rows.push(r); save();
      console.log(`direct flash ${p.id} ${e}: out=${r.out_tokens} think=${r.think_chars} ${r.ms}ms ok=${r.correct} ${r.status}`);
    }
  }
  // 2. Pro at the ends, so the comparison has its other half.
  for (const e of ["none", "high", "max"]) {
    const r = await direct("deepseek-v4-pro", prompts[1], e);
    rows.push(r); save();
    console.log(`direct pro ${prompts[1].id} ${e}: out=${r.out_tokens} think=${r.think_chars} ${r.ms}ms ok=${r.correct} ${r.status} ${r.error ?? ""}`);
  }
  // 3. The wall's path: the CLI with the provider env. The reasoning-heavy
  //    prompt is enough to show whether the level moves anything; the direct
  //    API above covers the answer quality across prompts.
  for (const p of [prompts[1]]) {
    for (const e of cliEfforts) {
      const r = cli("sonnet", p, e, null);
      rows.push(r); save();
      console.log(`cli flash ${p.id} ${e}: out=${r.out_tokens} think=${r.think_chars} ${r.ms}ms ok=${r.correct} ${r.status} ${r.error ?? ""}`);
    }
  }
  for (const e of ["none", "high", "max"]) {
    const r = cli("opus", prompts[1], e, null);
    rows.push(r); save();
    console.log(`cli pro ${prompts[1].id} ${e}: out=${r.out_tokens} think=${r.think_chars} ${r.ms}ms ok=${r.correct} ${r.status} ${r.error ?? ""}`);
  }
  // 4. Does MAX_THINKING_TOKENS=0 actually suppress thinking?
  for (const env of ["0", "unset"]) {
    const r = cli("sonnet", prompts[1], "high", env);
    rows.push(r); save();
    console.log(`cli flash ${prompts[1].id} high MAX_THINKING_TOKENS=${env}: out=${r.out_tokens} think=${r.think_chars} ${r.ms}ms ok=${r.correct} ${r.status}`);
  }
  save();
  console.log(`\nwrote ${OUT}`);
}

await main();
