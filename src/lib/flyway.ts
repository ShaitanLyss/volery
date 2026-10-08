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

/** One wall on the roster, as `flyway_roster` and `flyway:roster` carry it —
 *  `link.rs`'s `RosterRow`. */
export type Wall = {
  host: string;
  me: boolean;
  quietMs: number;
  /** `Standing` in `fleet.rs`, kept four-way for its reason: a wall that has
   *  stopped talking and a wall that said it is busy want different things
   *  from a person. */
  standing: "open" | "full" | "closed" | "quiet";
  /** What an ask would be told, word for word, where it would be refused. */
  reason: string | null;
  cardsLive: number;
  cardsWorking: number;
  allowanceUsed: number | null;
  territories: string[];
  /** Answered only in the old language: its sink syncs, nothing else does. */
  older: boolean;
};

/** A duration as the roster says one. */
function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/** The other walls, in a stable order — this one is the panel's own heading. */
export function otherWalls(rows: Wall[]): Wall[] {
  return rows.filter((w) => !w.me).sort((a, b) => a.host.localeCompare(b.host));
}

/** One line about a wall, for somebody deciding where a card should run.
 *
 *  **Quiet comes first and hides the rest**, `Entry::standing`'s rule: what a
 *  quiet wall last said is history, and a machine that announced it was idle
 *  and then went to sleep is not idle. An older build says so ahead of
 *  everything, since nothing but its sink reaches it. */
export function wallLine(w: Wall): string {
  if (w.older) return "an older volery — its sink syncs, nothing else reaches it until it updates";
  if (w.standing === "quiet") return `quiet for ${ago(w.quietMs)} — asleep, or off the network`;
  const load = `${w.cardsWorking} of ${w.cardsLive} working`;
  const room = w.allowanceUsed === null ? "" : ` · allowance ${w.allowanceUsed}% used`;
  const where = w.territories.length ? ` · ${w.territories.join(", ")}` : " · no territories";
  switch (w.standing) {
    case "open":
      return `takes work · ${load}${room}${where}`;
    case "full":
      return `at its bound · ${load}${where}`;
    case "closed":
      return `not taking work from other walls · ${load}${where}`;
  }
}

/** What the switch says about this wall. */
export function acceptingReading(on: boolean | null): string {
  if (on === null) return "asking…";
  return on
    ? "other walls may open cards here — each one is drawn as theirs, and runs with this machine's shell"
    : "other walls may not open cards here";
}
