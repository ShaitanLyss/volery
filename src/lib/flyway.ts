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

/** The one line the panel opens with.
 *
 *  **It takes `linked` because holding a key is not being on the flyway**, and
 *  the heading said "linked" off `held` alone while the section below it said
 *  "the link is not up — nothing is syncing". A panel that contradicts itself
 *  in two lines is worse than either sentence on its own: the heading is what
 *  gets read, and it was the one that could not be true. `linked` is read only
 *  when a key is held, since a wall with no key has no link to be down. */
export function flywayReading(held: boolean | null, host: string, linked: boolean): string {
  if (held === null) return "asking…";
  if (!held) return "not in a flyway";
  const me = host || "unnamed";
  return linked ? `linked — this machine is ${me}` : `${me} — the link is not up`;
}

/** Why the roster is empty, likeliest first.
 *
 *  An empty roster is the state Lyss is most likely to meet on a machine she
 *  has only just pasted a key into, and "none heard from yet" is true and
 *  useless: it names no next move. These do.
 *
 *  **Ordered by how likely each is rather than how alarming.** A laptop with
 *  its lid shut is the common case and a gateway eating the link is the one
 *  that costs a five-minute errand to establish, so naming the network first
 *  would send somebody to `docs/FLYWAY-PROBE.md` about a machine that is merely
 *  asleep. A wall that *has* been heard from and then went quiet is not this
 *  reading at all — `wallLine` says so in its own words, with how long. */
export function nothingHeard(linked: boolean): string[] {
  if (!linked)
    return [
      "this machine has no place on the flyway yet, so nothing can arrive until it has — restarting volery is the first thing to try",
    ];
  return [
    "the other wall is not running — a laptop asleep, or volery closed on it",
    "this network will not let the link out, which an office gateway may well do — the flyway probe is what settles it",
    "the other wall holds a different key",
  ];
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

/** Whether this wall may be taken off the roster.
 *
 *  **Quiet only**, and the bound is what keeps the gesture honest. `Fleet::forget`
 *  holds against *gossip* — a peer's stale copy of a forgotten wall does not
 *  bring it back — but it cannot hold against the wall itself, which
 *  re-announces on its own thirty-second tick. So a control offered for a live
 *  wall would appear to work and silently undo itself within half a minute,
 *  which is worse than no control: the roster's whole value is that every row
 *  on it means something, and a row you removed that came back means less than
 *  one you never touched.
 *
 *  It is drawn absent rather than disabled on the others. A greyed button
 *  invites "why not", and the honest answer — *it would not stick* — is not a
 *  reason a person can act on; there is nothing to fix, the wall is simply
 *  there. An older wall is no different: quiet is quiet whatever it is running.
 *
 *  Pure and shared with `Flyway.svelte` so the drawing and `link.rs`'s refusal
 *  are one rule read twice rather than two that have to agree. */
export function forgettable(w: Wall): boolean {
  return !w.me && w.standing === "quiet";
}
