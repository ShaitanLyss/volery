/* What the flyway panel says, as functions of what it knows.
 *
 * Pure so the sentences are a thing a test can read rather than something you
 * open the app to find out — the same bargain `integrations.ts`'s `checkReading`
 * strikes. Nothing here validates a phrase: `flyway_join` forgives case, spaces,
 * dashes and the confusable characters, and a second normaliser here would be a
 * second opinion about what a key looks like that could only ever be stricter and
 * so refuse a key the vault would have taken. */

/** A Tauri command rejects with whatever Rust returned, which for these five is
 *  a `String`; an `Error` or anything stranger is still worth a sentence. */
export function flywayError(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e ?? "");
  return s.trim() || "that did not work";
}

/** The one line the panel opens with. */
export function flywayReading(held: boolean | null, host: string): string {
  if (held === null) return "asking…";
  return held ? `linked — this machine is ${host || "unnamed"}` : "not in a flyway";
}

/** Whether a typed phrase is worth sending at all. Only emptiness: the rest is
 *  the vault's to judge, and its reason is what the person reads. */
export function worthJoining(typed: string): boolean {
  return typed.trim().length > 0;
}
