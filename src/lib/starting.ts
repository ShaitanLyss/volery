/* Starting a conversation in chat view: where it works, what it opens as, and
 * whether this machine can start one at all (`docs/chat-mode.md` §6.3, §5.9).
 *
 * Pure. The empty state (`NewChat.svelte`) draws these answers and
 * `starting.svelte.ts` keeps the choices; nothing here touches the store, the
 * CLI or the clock it is not handed.
 */

import { PRESETS, presetById, type Preset } from "./presets";
import { effortForModel } from "./commands";
import { wallRefusal, type Opener } from "./shadow";

/* ── where a conversation works ──────────────────────────────────────────── */

/** A place a new conversation can open in. A project is a folder Volery
 *  already knows; a folder is one picked with *open a folder…* that becomes a
 *  project on the first send (`ensure_project`); chat is no folder at all —
 *  web search and nothing on this computer (`chat.md`). */
export type Place =
  | { kind: "project"; name: string; dir: string }
  | { kind: "folder"; dir: string }
  | { kind: "chat" };

/** One row of the place menu. */
export type PlaceOption = {
  place: Place;
  label: string;
  /** The line under it, where it has one — the path of the place in use, and
   *  what *just chat* means. */
  note: string;
  /** How many conversations it holds. */
  count: number;
};

/** What the place menu needs to know about a project. */
export type Known = { name: string; dir: string };
/** And about a conversation: its project (null for chat), when it last did
 *  anything, and whether it is on another wall (whose projects are not here). */
export type Seen = { project: string | null; lastAt: number; host?: string | null };

/** The last word of a path, which is what a folder is called. */
export function baseName(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || dir;
}

export function placeLabel(p: Place): string {
  return p.kind === "chat" ? "just chat" : p.kind === "project" ? p.name : baseName(p.dir);
}

export const CHAT_NOTE = "no folder — it can search the web, and nothing on this computer";

/** When each project was last used: the newest of its conversations here. */
function lastUse(projects: readonly Known[], seen: readonly Seen[]): Map<string, number> {
  const at = new Map<string, number>(projects.map((p) => [p.name, 0]));
  for (const s of seen) {
    if (s.host || s.project === null || !at.has(s.project)) continue;
    at.set(s.project, Math.max(at.get(s.project) ?? 0, s.lastAt));
  }
  return at;
}

/** The place menu, in its order: the projects, most recently used first (so the
 *  one you are likeliest to want is under the pointer), then *just chat*. *Open
 *  a folder…* is a gesture rather than a place and the menu draws it last. */
export function placesOf(projects: readonly Known[], seen: readonly Seen[], current: Place): PlaceOption[] {
  const at = lastUse(projects, seen);
  const count = (name: string) => seen.filter((s) => !s.host && s.project === name).length;
  const rows: PlaceOption[] = [...projects]
    .sort((a, b) => (at.get(b.name) ?? 0) - (at.get(a.name) ?? 0) || a.name.localeCompare(b.name))
    .map((p) => ({
      place: { kind: "project", name: p.name, dir: p.dir },
      label: p.name,
      note: current.kind === "project" && current.name === p.name ? p.dir : "",
      count: count(p.name),
    }));
  if (current.kind === "folder") rows.unshift({ place: current, label: baseName(current.dir), note: current.dir, count: 0 });
  rows.push({ place: { kind: "chat" }, label: "just chat", note: CHAT_NOTE, count: seen.filter((s) => !s.host && s.project === null).length });
  return rows;
}

/** What the place chip remembers between launches: the project's name, or
 *  chat. A picked folder is not remembered — after its first send it is a
 *  project, and remembered as one. */
export type StoredPlace = { project: string } | "chat";

/** The place a new conversation starts in: the last one you started from, if it
 *  still exists — so a returning person types and sends (§6.3) — then the
 *  project you used most recently, then *just chat* when there are no projects
 *  at all, which is a newcomer's first launch (§5.9 step 3). */
export function startingPlace(stored: StoredPlace | null, projects: readonly Known[], seen: readonly Seen[]): Place {
  if (stored === "chat") return { kind: "chat" };
  if (stored) {
    const p = projects.find((k) => k.name === stored.project);
    if (p) return { kind: "project", name: p.name, dir: p.dir };
  }
  const at = lastUse(projects, seen);
  let best: Known | null = null;
  for (const p of projects) if (!best || (at.get(p.name) ?? 0) > (at.get(best.name) ?? 0)) best = p;
  return best ? { kind: "project", name: best.name, dir: best.dir } : { kind: "chat" };
}

export function storedOf(p: Place): StoredPlace | null {
  return p.kind === "chat" ? "chat" : p.kind === "project" ? { project: p.name } : null;
}

export function samePlace(a: Place, b: Place): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "chat") return true;
  if (a.kind === "project" && b.kind === "project") return a.name === b.name;
  return a.kind === "folder" && b.kind === "folder" && a.dir === b.dir;
}

/** Three suggestions per kind of place (§6.3). Written as a person would type
 *  them, because a suggestion is put into the message box to be sent or edited,
 *  never sent on its own. Followed cheaply: people expect them (§2.3). */
export function ideasFor(p: Place): readonly string[] {
  if (p.kind === "chat")
    return ["help me write a hard email", "explain something i keep forgetting", "plan a weekend away"];
  return ["explain how this project fits together", "find what is slowest in it", "add tests for what has none"];
}

/* ── which machine it works on ───────────────────────────────────────────── */

/* A new conversation can open on another of your machines over the flyway, in a
 * project that machine announces (`flyway/opening.rs`). Never in a chat or an
 * arbitrary folder: another wall opens cards only in the territories it holds,
 * so those two places stay on this machine and the menu does not draw them
 * under another one. The machine is chosen as a host name, `null` for here —
 * the wall's own word for itself (`Elsewhere.roster`'s `me` row). */

/** Walls that would take a card from here: heard from lately, new enough,
 *  taking work from other walls, and holding something to open it in. The same
 *  test the section menu's presets are offered under (`shadow.ts::openRefusal`),
 *  less the project, which this choice makes. */
export function ableWalls(roster: readonly Opener[]): Opener[] {
  return roster.filter((r) => !r.me && wallRefusal(r, r.host) === null && (r.territories ?? []).length > 0);
}

/** Whether the machine chip is drawn at all. One machine — or others that
 *  cannot take work — is nothing to choose between, and offering nothing is a
 *  real answer. */
export function choosesMachine(roster: readonly Opener[]): boolean {
  return ableWalls(roster).length > 0;
}

/** The machine a choice still means: `host` while that wall can take work, and
 *  here the moment it cannot — a lid shut, its switch turned off. A conversation
 *  must never be sent to a wall it would only be refused by. */
export function machineNow(host: string | null, roster: readonly Opener[]): string | null {
  return host !== null && ableWalls(roster).some((r) => r.host === host) ? host : null;
}

/** Whether a wall announces a project by this name (case folded, as the
 *  section menu and `opening.rs::territory_named` match it). */
export function holds(row: Pick<Opener, "territories">, name: string): boolean {
  const want = name.trim().toLowerCase();
  return !!want && (row.territories ?? []).some((t) => t.toLowerCase() === want);
}

/** One row of the machine menu. */
export type MachineOption = {
  /** `null` is this machine. */
  host: string | null;
  label: string;
  note: string;
  /** Whether it can be chosen. A wall that cannot is still drawn, with why, so
   *  a machine that is missing is not a mystery. */
  ok: boolean;
};

/** The menu: this machine first, then every other wall the flyway has, those
 *  that can take the work first. The note says what the choice does to the
 *  place — where the wall holds the project in use, that it does; where it
 *  does not, which it opens in instead. */
export function machineOptions(roster: readonly Opener[], place: Place): MachineOption[] {
  const me = roster.find((r) => r.me);
  const able = ableWalls(roster);
  const project = place.kind === "project" ? place.name : null;
  const rows: MachineOption[] = [{ host: null, label: "this machine", note: me?.host ?? "", ok: true }];
  for (const r of roster) {
    if (r.me) continue;
    const ok = able.includes(r);
    const why = wallRefusal(r, r.host) ?? ((r.territories ?? []).length ? null : `${r.host} holds no project to open a card in`);
    const note = !ok
      ? (why ?? "")
      : project && holds(r, project)
        ? `holds ${project}`
        : `opens in ${[...(r.territories ?? [])].sort((a, b) => a.localeCompare(b))[0]}`;
    rows.push({ host: r.host, label: r.host, note, ok });
  }
  return [rows[0]!, ...rows.slice(1).sort((a, b) => Number(b.ok) - Number(a.ok) || a.label.localeCompare(b.label))];
}

/** The place menu on another machine: the projects it announces, the ones used
 *  most recently *here* first (the same order the menu has at home), and no
 *  *just chat* and no *open a folder…* — neither is a project there. */
export function placesOn(row: Pick<Opener, "territories">, seen: readonly Seen[], current: Place): PlaceOption[] {
  const names = [...new Set(row.territories ?? [])];
  const at = lastUse(names.map((name) => ({ name, dir: "" })), seen);
  return names
    .sort((a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0) || a.localeCompare(b))
    .map((name) => ({
      place: { kind: "project", name, dir: "" } as Place,
      label: name,
      note: current.kind === "project" && current.name === name ? "on that machine" : "",
      count: 0,
    }));
}

/** Where a conversation works once its machine is `row`: the place in use if
 *  the wall holds that project, else the first it holds in the order the menu
 *  at home would put it. Never chat or a folder — those are not projects there. */
export function placeOnWall(row: Pick<Opener, "territories">, current: Place, local: readonly Known[], seen: readonly Seen[]): Place {
  if (current.kind === "project" && holds(row, current.name)) return { kind: "project", name: current.name, dir: "" };
  const first = placesOf(local, seen, current).find((o) => o.place.kind === "project" && holds(row, o.place.name));
  if (first?.place.kind === "project") return { kind: "project", name: first.place.name, dir: "" };
  const any = placesOn(row, seen, current)[0];
  return any ? any.place : current;
}

/** Where a conversation works when its machine goes back to being this one:
 *  what it was if that is a folder here, else what the place would have been
 *  with nothing remembered of the other machine. */
export function placeAtHome(current: Place, stored: StoredPlace | null, local: readonly Known[], seen: readonly Seen[]): Place {
  if (current.kind === "project") {
    const p = local.find((k) => k.name === current.name);
    if (p) return { kind: "project", name: p.name, dir: p.dir };
    return startingPlace(stored, local, seen);
  }
  return current;
}

/* ── what it opens as ────────────────────────────────────────────────────── */

/** A model id or alias as a person says it: `claude-opus-5[1m]` → `opus 5`,
 *  `sonnet[1m]` → `sonnet`, `claude-haiku-4-5-20251001` → `haiku 4.5`. The
 *  window tier and the date stamp are not something anyone chooses by. */
export function modelSaid(model: string | null | undefined): string {
  if (!model) return "";
  const bare = model.replace(/\[[^\]]*\]$/, "").toLowerCase();
  const m = bare.match(/^(?:claude-)?(opus|sonnet|haiku|fable|opusplan)(?:-(\d+(?:-\d{1,2})?))?(?:-\d{8})?$/);
  if (!m) return bare;
  return m[2] ? `${m[1]} ${m[2].replace("-", ".")}` : m[1]!;
}

/** The chip beside send: the model and its effort, the mockup's `sonnet ·
 *  medium`. Haiku carries no effort (`presets.ts`, the note on `effort`). */
export function chipSaid(model: string | null | undefined, effort: string | null | undefined): string {
  const m = modelSaid(model);
  if (!m) return "claude code's own";
  return effort ? `${m} · ${effort}` : m;
}

/** A preset choice, in `Skein.open`'s three states (`menu.md`): a preset id,
 *  `""` for *as claude code is set up*, `null` for nobody said — the wall's
 *  default. */
export type PresetChoice = string | null;

/** What a choice resolves to, with the wall's default standing in for `null`. */
export function presetOf(choice: PresetChoice, wallDefault: Preset | undefined): Preset | undefined {
  if (choice === null) return wallDefault;
  if (choice === "") return undefined;
  return presetById(choice) ?? wallDefault;
}

/** The menu's rows: the five presets cheapest first, then *as claude code is
 *  set up* — the same six the wall's `+` offers, so the two never disagree. */
export function presetRows(): { id: string; label: string; chip: string }[] {
  return [
    ...PRESETS.map((p) => ({ id: p.id, label: p.label, chip: chipSaid(p.model, p.effort) })),
    { id: "", label: "as claude code is set up", chip: "claude code's own" },
  ];
}

/** Changing an open conversation's model and effort: the lines it is sent, in
 *  order. `Skein.send` already follows a `/model` with the family's usual
 *  `/effort` (`effortForModel`), so a preset whose level *is* that one sends
 *  `/model` alone — sending it again drew the same line and its answer twice —
 *  and one whose level differs sends its own after, so it lands last rather
 *  than under the automatic one. Haiku has no effort to send. */
export function switchLines(p: Pick<Preset, "model" | "effort">): string[] {
  const model = `/model ${p.model}`;
  if (!p.effort || effortForModel(model) === p.effort) return [model];
  return [model, `/effort ${p.effort}`];
}

/* ── whether a conversation can start at all ────────────────────────────── */

/** The one PowerShell line `claude.ai` gives for installing Claude Code — the
 *  sibling of the `install.sh` the CLI names (`claude.rs`). Shown with a copy
 *  button and never run for anybody (`accounts.md`). */
export const INSTALL_LINE = "irm https://claude.ai/install.ps1 | iex";

/** The account label a sign-in from the empty state creates. A managed account
 *  rather than the machine's own credential: `signin.rs` signs in only into a
 *  store, which is what keeps it from overwriting a credential somebody signed
 *  in from a terminal — and an account is what the waterfall already spawns. */
export const FIRST_ACCOUNT = "claude";

export type Readiness = "looking" | "missing" | "signed-out" | "ready";

/** Can a conversation start here?
 *
 *  `claude` is `find_claude`'s answer (null before the first look), `auth` the
 *  default credential's (`claude_auth`: null before asking, `"unknown"` when the
 *  CLI could not say), `usable` how many managed accounts could take work.
 *
 *  **A signed-out default credential is not "signed out"** when an account is
 *  usable: `tools/probe-auth.ts` found exactly that on Lyss's machine, where
 *  every sign-in is a managed account and a card spawns on one. And a CLI that
 *  could not say reads as ready — the first message's own error is a better
 *  answer than a card accusing a working machine of being signed out. */
export function readiness(
  claude: { state: "ready" | "missing" } | null,
  auth: { loggedIn: boolean } | "unknown" | null,
  usable: number,
): Readiness {
  if (claude === null) return "looking";
  if (claude.state === "missing") return "missing";
  if (usable > 0) return "ready";
  if (auth === null) return "looking";
  if (auth === "unknown") return "ready";
  return auth.loggedIn ? "ready" : "signed-out";
}
