/* Which cargo failures are a shared `target/debug` caught half-replaced, rather
 * than anything wrong with our code. Pure, so `test/stale.test.ts` can hold it.
 *
 * Another card's or a lab's build rewrites rlibs and `.rmeta` files while this
 * one reads them, and the two things rustc says about it are below. Match them
 * narrowly: a compile error or a failed test in our code must never read as
 * stale, or the gate would retry — and so hide — a real red. */

const SIGNATURES: [RegExp, string][] = [
  [/invalid metadata files? for crate `?\w+`?/, "invalid metadata files"],
  [/crate `[^`]+` required to be available in rlib format, but was not found in this form/, "rlib not found in this form"],
];

/** The signature name when `out` is a stale-artifact failure, else null. */
export function staleArtifact(out: string): string | null {
  for (const [re, name] of SIGNATURES) if (re.test(out)) return name;
  return null;
}
