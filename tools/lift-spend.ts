/* Run `spend.rs`'s pure rules on a machine with no MSVC, and, more to the
 * point, run them **against `usage.ts`**.
 *
 *     bun tools/lift-spend.ts
 *
 * `spend.rs` is the one place Rust prices anything (§20's decision entry): a
 * `usd` watch is enforced during ingest, inside this process, so the arithmetic
 * cannot live in the front end. The two halves read one `pricing.json`, which
 * makes drift impossible by construction, but reading the same data is not the
 * same as computing the same number, and the parts that are still two
 * implementations are the three rate rungs, the peak clock, and the five-term
 * sum. This script executes the Rust half and compares it to `usage.ts` at
 * instants inside and outside DeepSeek's peak window, which is the failure the
 * brief named: a mirror that skips the clock rule prices every DeepSeek card at
 * double all night.
 *
 * **It reads the JSON once and embeds it in the lifted file**, because
 * `include_str!`'s path is relative to the file it is written in and the lift is
 * compiled somewhere else. The data is identical either way; only the location
 * moves.
 *
 * Everything it generates comes from the two real sources. Nothing here restates
 * a table. */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt, depsDir, rustEnv, newestRlib } from "./lift-scan.ts";
import { CACHE_READ, RATES, WRITE_1H, WRITE_5M, deepseekPeak, rateAt, rateFor } from "../src/lib/usage.ts";

const SPEND = "src-tauri/src/spend.rs";
const PRICING = "src/lib/pricing.json";

const lines = readFileSync(SPEND, "utf8").split(/\r?\n/);
const pricing = readFileSync(PRICING, "utf8");

function find(what: string): string {
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*mod tests\s*\{/.test(lines[i])) break;
    if (re.test(lines[i])) return blockAt(lines, i, SPEND);
  }
  throw new Error(`could not find "${what}" in ${SPEND}, has it been renamed?`);
}

/* ── the cases, computed by the front end's own arithmetic ────────────────*/

const HOUR = 3_600_000;
/* A Thursday inside DeepSeek's peak (02:00 UTC) and one outside it (05:00),
   plus a Saturday, which is never peak whatever the hour. */
const PEAK_AT = Date.UTC(2026, 10, 12, 2, 0, 0);
const OFF_AT = Date.UTC(2026, 10, 12, 5, 0, 0);
const SAT_AT = Date.UTC(2026, 10, 14, 2, 0, 0);

const TOK = { input: 1000, output: 100, cacheRead: 10_000, write5m: 2000, write1h: 500 };

function priced(model: string, at: number): number | null {
  const r = rateAt(model, at);
  if (!r) return null;
  return (
    (TOK.input * r.input +
      TOK.output * r.output +
      TOK.cacheRead * r.input * (r.cacheRead ?? CACHE_READ) +
      TOK.write5m * r.input * WRITE_5M +
      TOK.write1h * r.input * WRITE_1H) /
    1e6
  );
}

function rustNum(n: number): string {
  return Number.isFinite(n) ? n.toPrecision(17) : "f64::NAN";
}

const priceCases = Object.keys(RATES)
  .flatMap((model) => [PEAK_AT, OFF_AT, SAT_AT].map((at) => ({ model, at, expected: priced(model, at) })));

const priceArms = priceCases
  .map(
    (c) =>
      `        (${JSON.stringify(c.model)}, ${c.at}i64, ${c.expected === null ? "None" : `Some(${rustNum(c.expected)})`}),`,
  )
  .join("\n");

/* The peak clock over a week of hours, which is the whole of the rule: a
   weekday check, two windows, and UTC rather than local. */
const peakCases: { at: number; peak: boolean }[] = [];
for (let d = 0; d < 7; d++) {
  for (let h = 0; h < 24; h++) {
    const at = Date.UTC(2026, 10, 9 + d, h, 0, 0); /* 9 Nov 2026 is a Monday */
    peakCases.push({ at, peak: deepseekPeak(at) });
  }
}
const peakArms = peakCases.map((c) => `        (${c.at}i64, ${c.peak}),`).join("\n");

/* The three rungs of `rateFor`, sampled where they can disagree: an exact id, a
   dated id that must price as *its* model, a family this build has never seen,
   and one it cannot name at all. */
const probeIds = [
  "claude-opus-5-5",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001",
  "claude-opus-9",
  "deepseek-flash",
  "a-model-from-nowhere",
];
const rateArms = probeIds
  .map((id) => {
    const r = rateFor(id);
    return `        (${JSON.stringify(id)}, ${r === null ? "None" : `Some(${rustNum(r.input)})`}),`;
  })
  .join("\n");

const tests = `
#[cfg(test)]
mod agrees_with_the_front_end {
    use super::rules;

    const PRICING: &str = r#"${pricing}"#;

    /// Every model, at an instant inside DeepSeek's peak, outside it, and on a
    /// Saturday. Expected values are \`usage.ts\`'s own arithmetic, computed by
    /// the lift from the table it reads.
    #[test]
    fn every_rate_and_instant_prices_the_same_as_usage_ts() {
        let b = rules::parse_book(PRICING).expect("pricing.json parses");
        let cases: &[(&str, i64, Option<f64>)] = &[
${priceArms}
        ];
        assert!(!cases.is_empty(), "the table matched no models");
        for (model, at, expected) in cases {
            let got = rules::price(&b, model, *at, ${TOK.input}, ${TOK.output}, ${TOK.cacheRead}, ${TOK.write5m}, ${TOK.write1h});
            match (got, expected) {
                (None, None) => {}
                (Some(g), Some(e)) => assert!(
                    (g - e).abs() <= e.abs() * 1e-12,
                    "{model} at {at}: rust {g} vs usage.ts {e}"
                ),
                pairs => panic!("{model} at {at}: one side priced it and the other did not: {pairs:?}"),
            }
        }
    }

    /// The clock rule, every hour of a week. A mirror that skipped it would
    /// price every DeepSeek card at double all night.
    #[test]
    fn the_peak_clock_is_the_front_end_s() {
        let b = rules::parse_book(PRICING).unwrap();
        let cases: &[(i64, bool)] = &[
${peakArms}
        ];
        assert_eq!(cases.len(), 168, "a week of hours");
        for (at, peak) in cases {
            assert_eq!(rules::peak_hour(&b.peak, *at), *peak, "at {at}");
        }
        let flash_peak = rules::rate_at(&b, "deepseek-flash", ${PEAK_AT}).unwrap();
        let flash_off = rules::rate_at(&b, "deepseek-flash", ${OFF_AT}).unwrap();
        assert_eq!(flash_peak.input, 0.3);
        assert_eq!(flash_off.input, 0.15, "off-peak is half, and Rust must know it");
    }

    /// The three rungs, at the ids that tell them apart.
    #[test]
    fn a_model_is_found_by_the_same_three_rungs() {
        let b = rules::parse_book(PRICING).unwrap();
        let cases: &[(&str, Option<f64>)] = &[
${rateArms}
        ];
        for (id, input) in cases {
            let got = rules::rate_for(&b, id).map(|r| r.input);
            match (got, input) {
                (None, None) => {}
                (Some(g), Some(e)) => assert!((g - e).abs() < 1e-12, "{id}: {g} vs {e}"),
                pairs => panic!("{id}: {pairs:?}"),
            }
        }
    }
}
`;

const body = [
  "//! GENERATED by tools/lift-spend.ts, do not edit, do not keep.",
  find("mod rules"),
  tests,
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-spend-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    [
      "--test",
      "--edition",
      "2021",
      "-A",
      "dead_code",
      "--extern",
      `serde_json=${newestRlib("serde_json")}`,
      "-L",
      `dependency=${depsDir()}`,
      file,
      "-o",
      exe,
    ],
    { encoding: "utf8", env: rustEnv() },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file}, it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
