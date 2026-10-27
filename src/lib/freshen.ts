/* Claude Code and its plugins kept current — the pure half.
 *
 * `freshen.rs` runs the CLI's own update commands and reports each step; this
 * decides what any of it is called, and which cards an update has left on the
 * old copy. Pure for the reason `update.ts` and `limits.ts` are: what counts as
 * stale is the part that will be argued about, and an argument is worth having
 * against tests.
 *
 * ### Which cards are on the old copy
 *
 * Every card is a long-lived `claude` process, and a process keeps the CLI and
 * the plugin copy it started with until it goes — an update reaches the *next*
 * process, never the running one. So the question is asked of each card's own
 * `system/init`, which names both: `claude_code_version`, and `plugins` with the
 * per-commit cache `path` each one is read from. An update that moved
 * tx-toolkit to a new commit installed it under a new directory, so a card still
 * reading the old directory is on the old skills — exact, with no clock in it.
 *
 * **A process that has not spoken yet has no init** (the CLI emits it only
 * after the first message), and most live cards on a wall are that: rousing
 * and `stir` hand out processes ahead of any prompt. For those the only
 * evidence is age — a process started before the last update that moved
 * anything is one that loaded what was there before it. That reading can be
 * wrong in one direction only (a process started before an update to a plugin
 * it never loads), and the cost of that is one lossless stand-down.
 *
 * A dormant card is never stale: it has no process, and its next one starts on
 * whatever is installed then. */

export type ItemState = "waiting" | "running" | "updated" | "current" | "skipped" | "failed";

export type Item = {
  kind: "cli" | "marketplace" | "plugin";
  name: string;
  scope: string | null;
  project: string | null;
  state: ItemState;
  from: string | null;
  to: string | null;
  said: string | null;
};

export type Run = {
  trigger: "auto" | "button" | "card";
  startedAt: number;
  finishedAt: number | null;
  items: Item[];
};

export type Install = {
  key: string;
  scope: string;
  project: string | null;
  path: string;
  version: string | null;
};

export type Settings = { auto: boolean; everyHours: number };

export type Snapshot = {
  settings: Settings;
  last: Run | null;
  changedAt: number | null;
  running: boolean;
  autoAllowed: boolean;
  nextDue: number | null;
  installs: Install[];
};

/** What a card says about its own process, read off `Conversation`. */
export type CardFacts = {
  id: string;
  name: string;
  dormant: boolean;
  awakeSince: number | null;
  cliVersion?: string;
  runningPlugins: { name: string; path: string; source?: string }[];
  /** Has something a stand-down would take — a turn, a question, background
   *  work. Only for saying how many will wait; `Skein.restartStale` asks the
   *  reaper's own `keptFrom`, which is the authority. */
  busy?: boolean;
};

/** The choices the panel offers, in hours; 0 is off. */
export const EVERY_CHOICES = [0, 1, 3, 6, 12, 24] as const;

/** A path as Windows means it: case and separator do not distinguish two. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** The CLI version this machine is on now, by the best evidence to hand: the
 *  last run's CLI step (what it became, or what it already was), and otherwise
 *  what the launch-time lookup found. Null when neither says. */
export function currentCli(last: Run | null, found?: string | null): string | null {
  const cli = last?.items.find((i) => i.kind === "cli");
  const said = cli && cli.state !== "failed" ? (cli.to ?? cli.from) : null;
  if (said) return said;
  /* `find_claude` answers `2.1.311 (Claude Code)`; the init says `2.1.311`. */
  const bare = found?.match(/\d+\.\d+\.\d+/)?.[0];
  return bare ?? null;
}

/** The sentinels the init uses for plugins no marketplace installed — a
 *  `--plugin-dir`, `.claude/skills`, claude.ai's sync, the built-ins. No update
 *  here moves them, so none of them can be stale. */
const NOT_INSTALLED = /@(inline|skills-dir|synced|builtin)$/;

/** Why this card is on the old copy, one phrase per thing — or an empty list
 *  when it is not. */
export function staleOf(
  card: CardFacts,
  snap: Pick<Snapshot, "installs" | "changedAt">,
  cli: string | null,
): string[] {
  if (card.dormant || card.awakeSince === null) return [];
  if (card.cliVersion === undefined) {
    return snap.changedAt !== null && card.awakeSince < snap.changedAt
      ? ["started before the last update"]
      : [];
  }
  const why: string[] = [];
  if (cli && card.cliVersion !== cli) why.push(`claude code ${card.cliVersion}`);
  for (const p of card.runningPlugins) {
    if (p.source && NOT_INSTALLED.test(p.source)) continue;
    const key = p.source ?? null;
    const installs = snap.installs.filter((i) =>
      key ? i.key === key : i.key.startsWith(`${p.name}@`),
    );
    /* Uninstalled since, or never installed through a marketplace: nothing
       newer exists for it to be behind. */
    if (!installs.length) continue;
    if (!installs.some((i) => samePath(i.path, p.path))) why.push(p.name);
  }
  return why;
}

export type Stale = { id: string; name: string; why: string[]; busy: boolean };

export function staleCards(
  cards: readonly CardFacts[],
  snap: Pick<Snapshot, "installs" | "changedAt">,
  cli: string | null,
): Stale[] {
  return cards
    .map((c) => ({ id: c.id, name: c.name, why: staleOf(c, snap, cli), busy: c.busy === true }))
    .filter((s) => s.why.length > 0);
}

/** A plugin key without its marketplace, which is how a person says it. */
export function pluginName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

/** A version short enough for a row. Commit-shaped versions are twelve hex
 *  characters already; anything longer is cut to that. */
function v(s: string | null): string {
  if (!s) return "?";
  return /^[0-9a-f]{13,}$/i.test(s) ? s.slice(0, 12) : s;
}

function where(i: Item): string {
  if (i.kind !== "plugin" || !i.scope) return "";
  if (i.scope === "user" || !i.project) return ` (${i.scope})`;
  const leaf = i.project.split(/[\\/]/).filter(Boolean).pop() ?? i.project;
  return ` (${i.scope}, ${leaf})`;
}

/** The thing a row is about, in words. */
export function sayWhat(i: Item): string {
  if (i.kind === "cli") return "claude code";
  if (i.kind === "marketplace") return `${i.name} marketplace`;
  return `${pluginName(i.name)}${where(i)}`;
}

/** What happened to it, in words. */
export function sayCame(i: Item): string {
  switch (i.state) {
    case "waiting":
      return "waiting";
    case "running":
      return i.kind === "marketplace" ? "refreshing…" : "checking…";
    case "updated":
      if (i.kind === "marketplace") return "refreshed";
      return `${v(i.from)} → ${v(i.to)}`;
    case "current":
      if (i.kind === "marketplace") return "refreshed";
      /* The CLI's word and its own install record can disagree about a scope
         (`freshen.rs::settle`); both are said, since neither is ours to mend. */
      if (i.from && i.to && i.from !== i.to) return `current · ${v(i.to)} (record: ${v(i.from)})`;
      return `current${i.to ? ` · ${v(i.to)}` : ""}`;
    case "skipped":
      return `skipped — ${i.said ?? "left as it was"}`;
    case "failed":
      return `failed — ${i.said ?? "it said nothing"}`;
  }
}

/** How long ago, in the house's short form. */
export function sayAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Counts across a run: what moved, what failed. Marketplaces refreshed are
 *  not counted as moved — no card runs on a marketplace clone. */
export function tally(run: Run): { moved: Item[]; failed: Item[]; skipped: Item[] } {
  return {
    moved: run.items.filter((i) => i.state === "updated" && i.kind !== "marketplace"),
    failed: run.items.filter((i) => i.state === "failed"),
    skipped: run.items.filter((i) => i.state === "skipped"),
  };
}

/** One line for the last run: when, and what it came to. */
export function sayRun(run: Run | null, now: number): string {
  if (!run) return "not checked yet";
  if (run.finishedAt === null) {
    const done = run.items.filter((i) => i.state !== "waiting" && i.state !== "running").length;
    return `updating — ${done} of ${run.items.length}`;
  }
  const { moved, failed } = tally(run);
  const by = run.trigger === "auto" ? "" : run.trigger === "card" ? " (asked by a card)" : " (by hand)";
  const when = `checked ${sayAgo(run.finishedAt, now)}${by}`;
  const parts: string[] = [];
  if (moved.length) parts.push(sayMoved(moved));
  if (failed.length) parts.push(`${failed.length} failed`);
  return `${when} — ${parts.length ? parts.join(", ") : "everything current"}`;
}

/** What moved, as a phrase: the CLI by its versions, plugins by name. */
export function sayMoved(moved: readonly Item[]): string {
  const bits: string[] = [];
  const cli = moved.find((i) => i.kind === "cli");
  if (cli) bits.push(`claude code ${v(cli.from)} → ${v(cli.to)}`);
  const names = [...new Set(moved.filter((i) => i.kind === "plugin").map((i) => pluginName(i.name)))];
  if (names.length) bits.push(names.join(", "));
  return `updated ${bits.join(" and ")}`;
}

/** The interval, said back. */
export function sayEvery(s: Settings, allowed: boolean): string {
  if (!allowed) return "a development build never checks by itself";
  if (!s.auto) return "never checks by itself";
  return `checks by itself every ${s.everyHours === 1 ? "hour" : `${s.everyHours} hours`}`;
}

/** What the stale cards are owed, in a line: how many, and how many of those
 *  can be stood down now. */
export function sayStale(stale: readonly Stale[], ready: number): string {
  if (!stale.length) return "";
  const n = stale.length;
  const cards = `${n} card${n === 1 ? "" : "s"}`;
  const held = n - ready;
  const tail = held > 0 ? ` — ${held} busy, left alone until ${held === 1 ? "it rests" : "they rest"}` : "";
  return `${cards} still on the old copy${tail}`;
}

/** The chronicle row a finished run is worth, or null when it moved nothing
 *  and failed nothing — an automatic run every six hours that says "current"
 *  is noise. The stale cards ride in the detail, named, because the person
 *  reading the row is the one who decides when to restart them. */
export function runRow(
  run: Run,
  stale: readonly Stale[],
): { level: "good" | "bad" | "note"; mark: string; detail: string } | null {
  if (run.finishedAt === null) return null;
  const { moved, failed } = tally(run);
  if (!moved.length && !failed.length) return null;
  const bits: string[] = [];
  if (failed.length) {
    bits.push(
      failed
        .map((i) => `${sayWhat(i)} failed: ${i.said ?? "it said nothing"}`)
        .join("; "),
    );
  }
  if (stale.length) {
    const names = stale.slice(0, 6).map((s) => s.name).join(", ");
    const more = stale.length > 6 ? ` and ${stale.length - 6} more` : "";
    bits.push(
      `${stale.length} card${stale.length === 1 ? "" : "s"} still on the old copy (${names}${more}) — restart them from the accounts panel (space then a)`,
    );
  }
  const mark = moved.length
    ? sayMoved(moved)
    : `claude code / plugin update: ${failed.length} failed`;
  return { level: failed.length ? "bad" : "good", mark, detail: bits.join(" · ") };
}

/** A snapshot off the wire, made drawable whatever arrived. */
export function normalSnapshot(raw: any): Snapshot {
  const hours = Number(raw?.settings?.everyHours);
  return {
    settings: {
      auto: raw?.settings?.auto !== false,
      everyHours: Number.isFinite(hours) && hours > 0 ? hours : 6,
    },
    last: raw?.last && Array.isArray(raw.last.items) ? raw.last : null,
    changedAt: typeof raw?.changedAt === "number" ? raw.changedAt : null,
    running: raw?.running === true,
    autoAllowed: raw?.autoAllowed !== false,
    nextDue: typeof raw?.nextDue === "number" ? raw.nextDue : null,
    installs: Array.isArray(raw?.installs) ? raw.installs : [],
  };
}
