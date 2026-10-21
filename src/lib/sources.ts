/**
 * Event sources: a stream a card can subscribe to by name.
 *
 * A card calls `mcp__skein__subscribe(source, filter, note)` and ends its turn;
 * the wall holds the connection and hands it a turn only when an event on that
 * source matches. What the card names is a *word* — `nova-feedback` — and this
 * is the vocabulary of what a word may be and what the Integrations panel says
 * about the stream behind it. Lyss configures them there; nothing else does.
 *
 * Azure Event Hubs first (a Fabric Eventstream's custom endpoint is one), so a
 * source is a connection string, which is a secret and goes to the vault under
 * `dev.skein.studio/source/<name>` — `integrations.md`'s family — and a
 * consumer group, which is not. **The connection string never comes back**:
 * `sources_list` sends the namespace and entity Rust parsed out of it and a
 * `held` boolean, the same bargain the token rows strike, so pasting over is
 * how one is replaced.
 *
 * ### No subscribers, no connection
 *
 * `idle` is a state rather than a fault: a source nobody is subscribed to is
 * not connected, by design, because a connection held open for nothing is a
 * socket and a retry loop against somebody else's namespace. So an idle row is
 * grey, and *check it* is how you find out a source works before any card
 * leans on it — one round trip, when you ask, never on a clock.
 *
 * ### Colour
 *
 * Status only, as everywhere: celadon connected, amber while it is connecting
 * or failing and retrying, rust where nothing will come of it — a check that
 * was refused, or cards subscribed to a source with no connection string to
 * open it with. Not having configured something is not a status.
 *
 * Pure: no runes, no invoke. `sources.svelte.ts` is the store.
 */

import type { Check } from "./integrations";

export type SourceState = "idle" | "connecting" | "connected" | "failing";

/** One source as `sources_list` sends it. */
export type SourceRow = {
  name: string;
  kind: "eventhub";
  consumer_group: string;
  /** Parsed out of the connection string by Rust — not secret. */
  namespace: string;
  entity: string;
  /** Whether the vault holds a connection string for it. */
  held: boolean;
  /** How many subscriptions name it. */
  subscribers: number;
  state: SourceState;
  /** What the last attempt said, in the service's own words. */
  fault: string;
};

/** What a source may be called: what a card types, so a word rather than a
 *  phrase, and the tail of a vault target, so nothing a path would trip on.
 *  Must match `sources.rs`. */
export const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Event Hubs' own default, and what nearly everybody has. */
export const DEFAULT_GROUP = "$Default";

/** Why a name cannot be added, or null when it can.
 *
 *  A name already in the list is refused here rather than overwritten: the add
 *  form is for a new source, and replacing a connection string is a gesture on
 *  that source's own row, where you can see what it was. */
export function nameFault(name: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return "a source needs a name — it is what a card subscribes to";
  if (!SOURCE_NAME.test(n)) {
    return "a name is lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, up to 64";
  }
  if (existing.includes(n)) return `${n} is already a source — change it on its own row`;
  return null;
}

/** The consumer group a field means: what was typed, or the default. */
export function groupOf(typed: string): string {
  return typed.trim() || DEFAULT_GROUP;
}

/** Which status colour a reading wears — `rest` is none. */
export type Tone = "rest" | "work" | "soft" | "ask" | "fail";

export type Reading = { line: string; tone: Tone };

/** What the stream is doing, in a line. */
export function sourceReading(row: SourceRow): Reading {
  if (!row.held) {
    return row.subscribers > 0
      ? { line: `no connection string — ${subscribed(row.subscribers)} cannot be woken`, tone: "fail" }
      : { line: "no connection string held", tone: "rest" };
  }
  switch (row.state) {
    case "idle":
      return { line: "idle — nothing subscribed, so not connected", tone: "rest" };
    case "connecting":
      return { line: "connecting…", tone: "soft" };
    case "connected":
      return { line: "connected", tone: "work" };
    case "failing":
      return { line: row.fault ? `failing, retrying — ${row.fault}` : "failing, retrying", tone: "ask" };
  }
}

/** What the last *check it* said, or null when there is nothing to say. */
export function checkLine(check: Check): Reading | null {
  switch (check.at) {
    case "unasked":
      return null;
    case "asking":
      return { line: "checking…", tone: "rest" };
    case "good":
      return { line: check.who ? `reachable — ${check.who}` : "reachable", tone: "rest" };
    case "bad":
      return { line: check.said, tone: "fail" };
  }
}

function subscribed(n: number): string {
  return n === 1 ? "the subscription on it" : `the ${n} subscriptions on it`;
}

/** The row's second line: where it points, which group it reads as, and who
 *  is listening. */
export function whereLine(row: SourceRow): string {
  const at = row.entity && row.namespace ? `${row.entity} on ${row.namespace}` : row.entity || row.namespace;
  const subs =
    row.subscribers === 0 ? "nothing subscribed" : row.subscribers === 1 ? "1 subscription" : `${row.subscribers} subscriptions`;
  return [at, `consumer group ${row.consumer_group || DEFAULT_GROUP}`, subs].filter(Boolean).join(" · ");
}

/** A row off the wire, or null if it has no name to address it by. Degrades
 *  everything else, so a newer build's row still draws. */
export function readSource(v: unknown): SourceRow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const name = s(r.name);
  if (!name) return null;
  const state = r.state;
  return {
    name,
    kind: "eventhub",
    consumer_group: s(r.consumer_group),
    namespace: s(r.namespace),
    entity: s(r.entity),
    held: r.held === true,
    subscribers: typeof r.subscribers === "number" && Number.isFinite(r.subscribers) ? Math.max(0, r.subscribers) : 0,
    state: state === "connecting" || state === "connected" || state === "failing" ? state : "idle",
    fault: s(r.fault),
  };
}

/** Rows as the panel lists them: by name, so a state change never reorders
 *  the list under the caret. */
export function readSources(v: unknown): SourceRow[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(readSource)
    .filter((r): r is SourceRow => r !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Where the selection goes on j/k: clamped, never wrapping — the last row
 *  holding still is how you know it is the last. */
export function step(at: number, by: number, count: number): number {
  if (count === 0) return -1;
  return Math.min(count - 1, Math.max(0, (at < 0 ? (by > 0 ? -1 : count) : at) + by));
}
