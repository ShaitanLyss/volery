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

/** A setting the palette can open. App maps each to the panel it is. */
export type SettingId = "themes" | "accounts" | "guidance" | "keyring" | "carry" | "import";

export type Entry =
  | { kind: "conversation"; id: string; label: string; note: string }
  | { kind: "project"; name: string; label: string; note: string }
  | { kind: "chord"; keys: string; label: string; note: string }
  | { kind: "command"; name: string; label: string; note: string }
  | { kind: "setting"; id: SettingId; label: string; note: string }
  | { kind: "sink"; label: string; note: string };

/** The settings, each worded as what it is to somebody who has never seen the
 *  wall (§4.5). */
export const SETTINGS: readonly { id: SettingId; label: string; note: string }[] = [
  { id: "themes", label: "how the reading looks", note: "themes" },
  { id: "accounts", label: "accounts and allowance", note: "settings" },
  { id: "guidance", label: "what every conversation is told", note: "settings" },
  { id: "keyring", label: "tokens for other services", note: "settings" },
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
  chords: readonly { keys: string; label: string }[];
  commands: readonly { name: string; summary: string }[];
}): Entry[] {
  return [
    ...input.rows.map((r) => ({ kind: "conversation" as const, id: r.id, label: r.title, note: whereOf(r) })),
    ...input.projects.map((name) => ({ kind: "project" as const, name, label: name, note: "project" })),
    ...SETTINGS.map((s) => ({ kind: "setting" as const, ...s })),
    { kind: "sink" as const, label: "the sink", note: "what was noticed and set aside" },
    ...input.chords.map((c) => ({ kind: "chord" as const, keys: c.keys, label: c.label, note: keysSaid(c.keys) })),
    ...input.commands.map((c) => ({ kind: "command" as const, name: c.name, label: `/${c.name}`, note: c.summary })),
  ];
}

/** How far ahead of a tie each kind is: what you are likeliest to be looking
 *  for when two things answer equally well is a conversation. Small next to a
 *  real difference in how well the words match. */
const BIAS: Record<Entry["kind"], number> = {
  conversation: 6,
  project: 5,
  setting: 3,
  sink: 3,
  chord: 2,
  command: 1,
};

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
 *  - Everything else is the finder's fuzzy score on its label. */
export function rank(entries: readonly Entry[], rows: readonly ChatRow[], query: string, cap = 60): Entry[] {
  const q = query.trim();
  if (!q) return entries.slice(0, cap);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const slash = q.startsWith("/");
  const keys = slash ? null : asKeys(q);
  const scored: { e: Entry; s: number; i: number }[] = [];
  entries.forEach((e, i) => {
    let s: number | null = null;
    if (slash) {
      if (e.kind === "command") s = score(e.label, q)?.score ?? null;
    } else if (e.kind === "conversation") {
      const r = byId.get(e.id);
      if (r && matches(r, q)) s = Math.max(1, score(e.label, q)?.score ?? 0);
    } else if (e.kind === "project") {
      const words = q.toLowerCase().split(/\s+/);
      if (words.every((w) => e.label.toLowerCase().includes(w))) s = Math.max(1, score(e.label, q)?.score ?? 0);
    } else {
      s = score(e.label, q)?.score ?? null;
      if (e.kind === "chord" && keys !== null && e.keys === keys) s = 10_000;
    }
    if (s !== null) scored.push({ e, s: s + BIAS[e.kind], i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, cap).map((x) => x.e);
}
