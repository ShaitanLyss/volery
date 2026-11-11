/* Ctrl+K in chat view: search and everything (`docs/chat-mode.md` §10.1, §4.5).
 *
 * One list, ranked here: the conversations and projects (matched by
 * `chatview.ts::matches`, the sidebar's own rule), every leader chord with its
 * keys beside it — so a chord forgotten, or one wanted while the message box
 * has text in it, is still one search away — Volery's own slash commands, the
 * settings, and the sink. Pure: `Lookup.svelte` draws the answer and App runs
 * what is picked.
 */

import { matches, whereOf, type ChatRow } from "./chatview";
import { score } from "./finding";
import type { Verb as ChordVerb } from "./leader";
import type { Can, Verb as CardVerb } from "./handle";
import type { IconName } from "./icons";

/** A setting the palette can open. App maps each to the panel it is. */
export type SettingId = "themes" | "accounts" | "guidance" | "keyring" | "carry" | "import";

export type Entry =
  | { kind: "conversation"; id: string; label: string; note: string }
  | { kind: "project"; name: string; label: string; note: string }
  | { kind: "chord"; keys: string; label: string; note: string; verb?: ChordVerb }
  /** `chord` when a chord stands for the command — its keys, as `CHORDS` spells them. */
  | { kind: "command"; name: string; label: string; note: string; chord?: string }
  | { kind: "setting"; id: SettingId; label: string; note: string }
  | { kind: "sink"; label: string; note: string };

/** The settings, each worded as what it is to somebody who has never seen the
 *  wall (§4.5). */
export const SETTINGS: readonly { id: SettingId; label: string; note: string }[] = [
  { id: "themes", label: "how the reading looks", note: "themes" },
  { id: "accounts", label: "accounts and allowance", note: "settings" },
  { id: "guidance", label: "what every conversation is told", note: "settings" },
  { id: "keyring", label: "tokens and event sources", note: "settings" },
  { id: "carry", label: "carry the layout to another machine", note: "settings" },
  { id: "import", label: "pick up a conversation from claude code", note: "settings" },
];

/** A chord's keys as the hint and the titles write them: `space v v`. */
export function keysSaid(keys: string): string {
  return `space ${keys.split("").join(" ")}`;
}

/** Everything the palette can offer, in its resting order — what an empty
 *  query lists: the conversations as the sidebar orders them, then the
 *  projects, the settings, the sink, the chords and the commands. */
export function entriesOf(input: {
  rows: readonly ChatRow[];
  projects: readonly string[];
  chords: readonly { keys: string; label: string; verb?: ChordVerb }[];
  /** `chord`, where a command is one a chord already stands for: the chord's
   *  row is that command everywhere but under a `/`, where the command's own
   *  name is what was typed (`/close`), so it is kept and offered there only. */
  commands: readonly { name: string; summary: string; chord?: string }[];
}): Entry[] {
  return [
    ...input.rows.map((r) => ({ kind: "conversation" as const, id: r.id, label: r.title, note: whereOf(r) })),
    ...input.projects.map((name) => ({ kind: "project" as const, name, label: name, note: "project" })),
    ...SETTINGS.map((s) => ({ kind: "setting" as const, ...s })),
    { kind: "sink" as const, label: "the sink", note: "what was noticed and set aside" },
    ...input.chords.map((c) => ({
      kind: "chord" as const,
      keys: c.keys,
      label: c.label,
      note: keysSaid(c.keys),
      ...(c.verb ? { verb: c.verb } : {}),
    })),
    ...input.commands.map((c) => ({
      kind: "command" as const,
      name: c.name,
      label: `/${c.name}`,
      note: c.summary,
      ...(c.chord ? { chord: c.chord } : {}),
    })),
  ];
}

/** One entry's identity, for the list's keys and for remembering what was
 *  taken lately. Stable across launches for everything but a conversation,
 *  whose id is stable anyway. */
export function entryKey(e: Entry): string {
  switch (e.kind) {
    case "conversation":
      return `conversation:${e.id}`;
    case "project":
      return `project:${e.name}`;
    case "chord":
      return `chord:${e.keys}`;
    case "command":
      return `command:${e.name}`;
    case "setting":
      return `setting:${e.id}`;
    case "sink":
      return "sink";
  }
}

/** What a row is, as the palette draws its thumbnail: the thing you would
 *  *see* if you took it. A reading, a panel, something done to the focused
 *  conversation, the window, the machine, a toy — and the conversations,
 *  projects and commands, which are themselves. The palette tints by this and
 *  picks a glyph by `glyphOf`; both read the verb, so a chord added later
 *  arrives drawn. */
export type Family =
  | "reading"
  | "panel"
  | "card"
  | "window"
  | "machine"
  | "toy"
  | "find"
  | "conversation"
  | "project"
  | "command";

export function familyOf(e: Entry): Family {
  switch (e.kind) {
    case "conversation":
    case "project":
    case "command":
      return e.kind;
    case "setting":
    case "sink":
      return "panel";
    case "chord":
      break;
  }
  const v = e.verb;
  if (!v) return "command";
  switch (v.kind) {
    case "reading":
      return "reading";
    case "open":
    case "sink":
      return "panel";
    case "card":
    case "dock":
      return "card";
    case "window":
    case "grouping":
    case "plan":
    case "bright":
    case "screen":
    case "elsewhere":
      return "window";
    case "machine":
    case "presence":
      return "machine";
    case "toy":
      return "toy";
    case "find":
      return "find";
  }
}

/** The glyph a row is drawn with — an `icons.ts` name. One per reading and
 *  panel, where telling them apart at a glance is the point; one per family
 *  elsewhere, where the label does the work. */
export function glyphOf(e: Entry): IconName {
  if (e.kind === "conversation") return "chat";
  if (e.kind === "project") return "folder";
  if (e.kind === "command") return "term";
  if (e.kind === "sink") return "sink";
  if (e.kind === "setting") return SETTING_GLYPH[e.id];
  const v = e.verb;
  if (!v) return "term";
  switch (v.kind) {
    case "reading":
      return READING_GLYPH[v.widget] ?? "gauge";
    case "open":
      return OPEN_GLYPH[v.what];
    case "sink":
      return v.act === "drop" ? "plus" : "sink";
    case "find":
      return v.mode === "grep" ? "quote" : "search";
    case "card":
      return v.act === "close" ? "x" : v.act.startsWith("copy") ? "copy" : "chat";
    case "dock":
      return "bell";
    case "window":
      return v.act === "view" ? "wall" : "side";
    case "screen":
      return "screen";
    case "presence":
      return "moon";
    case "machine":
      return "gear";
    case "toy":
      return "wave";
    case "bright":
      return "sun";
    case "plan":
      return "plan";
    case "grouping":
    case "elsewhere":
      return "wall";
  }
}

const SETTING_GLYPH: Record<SettingId, IconName> = {
  themes: "sun",
  accounts: "gauge",
  guidance: "quote",
  keyring: "key",
  carry: "up",
  import: "down",
};
const OPEN_GLYPH: Record<Extract<ChordVerb, { kind: "open" }>["what"], IconName> = {
  timelines: "plan",
  pile: "bell",
  flyway: "globe",
  themes: "sun",
  accounts: "gauge",
  integrations: "key",
  showcase: "bird",
  analytics: "wave",
  analyticspage: "file",
  analyticstrace: "quote",
};
const READING_GLYPH: Partial<Record<Extract<ChordVerb, { kind: "reading" }>["widget"], IconName>> = {
  pipelines: "pipe",
  reviews: "branch",
  asana: "board",
  asanatasks: "check",
  asanahealth: "pulse",
  billboard: "pin",
  chronicle: "list",
  gates: "gate",
  usage: "gauge",
  burn: "flame",
  performance: "pulse",
  status: "globe",
};

/** The card verb a row asks of the focused conversation, when it asks one —
 *  `handle.ts`'s vocabulary, so the palette refuses exactly as `can()` does. */
export function cardVerbOf(e: Entry): CardVerb | null {
  if (e.kind !== "chord" || e.verb?.kind !== "card") return null;
  const act = e.verb.act;
  if (act === "menu" || act === "glance") return null;
  if (act === "keep-glass") return "keep";
  return act;
}

/** Whether a row is about the focused conversation at all — a card verb, its
 *  menu, what it last said. Such a row says which conversation it would reach,
 *  and with none in front of you it is refused rather than guessed at. */
export function wantsCard(e: Entry): boolean {
  return e.kind === "chord" && e.verb?.kind === "card";
}

/** The conversation a row would act on, as the palette needs it: its title
 *  for the note, and its handle's own `can`. */
export type Target = { title: string; can: (v: CardVerb) => Can };

/** What the palette says beside a row that reaches the focused conversation:
 *  which one, and — if the handle would refuse — why, in the handle's words.
 *  Null for a row that reaches no conversation. */
export function standingOf(e: Entry, target: Target | null): { on: string | null; refused: string | null } | null {
  if (!wantsCard(e)) return null;
  if (!target) return { on: null, refused: "no conversation is in front of you" };
  const v = cardVerbOf(e);
  const can = v ? target.can(v) : "yes";
  return { on: target.title, refused: can === "yes" ? null : can.no };
}

/** Which half of the list leads.
 *
 *  `search` is Ctrl+K as it always was: what you are likeliest to be looking
 *  for when two things answer equally well is a conversation. `actions` is
 *  the same list opened by the space bar or the header's button — Lyss's
 *  *"I press spacebar, type 'pipe', the first item … is pipeline"* — where
 *  what you came for is somewhere to go or something to do, so a reading, a
 *  panel or a chord comes ahead of a conversation that merely mentions the
 *  word. One list either way; only the ties move. */
export type Lead = "search" | "actions";

/** How far ahead of a tie each kind is, per lead. Small next to a real
 *  difference in how well the words match (the scorer answers in tens), and
 *  large enough in `actions` that a reading whose name *starts* with what was
 *  typed beats a conversation title that has it somewhere in the middle. */
const BIAS: Record<Lead, Record<Entry["kind"], number>> = {
  search: { conversation: 6, project: 5, setting: 3, sink: 3, chord: 2, command: 1 },
  actions: { conversation: 0, project: 1, setting: 8, sink: 8, chord: 8, command: 3 },
};

/** How much having taken a thing lately is worth: a tie-breaker, never a
 *  reason to answer. The newest is worth most and the fifth almost nothing. */
const RECENT_MOST = 5;
export const RECENT_KEEP = 8;
function recency(key: string, recent: readonly string[]): number {
  const i = recent.indexOf(key);
  return i < 0 ? 0 : Math.max(0, RECENT_MOST - i);
}

/** The resting order for `actions`, before anything is typed: what you took
 *  lately, then the places to look — the readings and the panels — then the
 *  conversations and projects, then every other chord and the commands. The
 *  list is the one `entriesOf` made; only the order is the lead's. */
function restingActions(entries: readonly Entry[], recent: readonly string[]): Entry[] {
  const byKey = new Map(entries.map((e) => [entryKey(e), e]));
  const lately = recent.map((k) => byKey.get(k)).filter((e): e is Entry => !!e);
  const seen = new Set(lately);
  const tier = (e: Entry): number => {
    const f = familyOf(e);
    if (f === "reading") return 0;
    if (f === "panel") return 1;
    if (f === "conversation" || f === "project") return 2;
    if (f === "command") return 4;
    return 3;
  };
  const rest = entries
    .map((e, i) => ({ e, i }))
    .filter((x) => !seen.has(x.e))
    .sort((a, b) => tier(a.e) - tier(b.e) || a.i - b.i)
    .map((x) => x.e);
  return [...lately, ...rest];
}

/** The finder's scorer, on a label rather than a path. It treats the last
 *  `/` as where a file's name begins and pays thirty for landing after it —
 *  right for `src/lib/theme.ts`, and wrong for a label, where `away / back`
 *  and `set it aside / pick it back up` are prose: `pip` answered with the
 *  aside before the pipelines because "pick it back up" read as a file name.
 *  A slash is swapped one-for-one for a mark the scorer does not know, so the
 *  spans still index the label as drawn. */
function said(label: string, q: string) {
  return score(label.replace(/[/\\]/g, "|"), q.replace(/[/\\]/g, "|"));
}

/** The query, if it is a chord typed as keys — `vv`, `space v v`, `sp v v`. */
function asKeys(q: string): string | null {
  const bare = q.toLowerCase().replace(/^(space|spc|sp)\b/, "").replace(/\s+/g, "");
  return /^[a-z]{1,3}$/.test(bare) ? bare : null;
}

/** Rank the entries against what was typed. Empty is the resting order.
 *
 *  - A conversation or project is offered only when `matches` says so — every
 *    word somewhere in its title, its place or its last words — so the palette
 *    and the sidebar's search can never disagree about whether a conversation
 *    is found. Among those, a title the words also fuzzily hit comes first.
 *  - A chord's keys typed as keys (`vv`, `space v v`) put that chord first:
 *    the palette is where a forgotten chord is looked up, and the other way
 *    round too.
 *  - A query starting with `/` asks for commands, as it does in the message
 *    box.
 *  - Everything else is the finder's fuzzy score on its label.
 *
 *  Then the lead's bias, and recency as a tie-breaker (`recent` is entry
 *  keys, newest first — `remember`). */
export function rank(
  entries: readonly Entry[],
  rows: readonly ChatRow[],
  query: string,
  cap = 60,
  opts: { lead?: Lead; recent?: readonly string[] } = {},
): Entry[] {
  const lead = opts.lead ?? "search";
  const recent = opts.recent ?? [];
  const bias = BIAS[lead];
  const q = query.trim();
  /* A command a chord stands for is that chord's row, except under a `/`. */
  const shadowed = (e: Entry) => e.kind === "command" && !!e.chord;
  if (!q) return (lead === "actions" ? restingActions(entries, recent) : entries).filter((e) => !shadowed(e)).slice(0, cap);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slash = q.startsWith("/");
  const keys = slash ? null : asKeys(q);
  const scored: { e: Entry; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    let s: number | null = null;
    if (slash) {
      if (e.kind === "command") s = said(e.label, q)?.score ?? null;
    } else if (shadowed(e)) {
      s = null;
    } else if (e.kind === "conversation") {
      const r = byId.get(e.id);
      if (r && matches(r, q)) s = Math.max(1, said(e.label, q)?.score ?? 0);
    } else if (e.kind === "project") {
      const words = q.toLowerCase().split(/\s+/);
      if (words.every((w) => e.label.toLowerCase().includes(w))) s = Math.max(1, said(e.label, q)?.score ?? 0);
    } else {
      s = said(e.label, q)?.score ?? null;
      if (e.kind === "chord" && keys !== null && e.keys === keys) s = 10_000;
    }
    if (s !== null) scored.push({ e, s: s + bias[e.kind] + recency(entryKey(e), recent), i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, cap).map((x) => x.e);
}

/** `recent` with `key` taken just now: newest first, no repeats, bounded. */
export function remember(recent: readonly string[], key: string): string[] {
  return [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_KEEP);
}
