/* Carrying a wall off the machine and setting it up again somewhere else.
 *
 * A layout is everything about *how the room is arranged* and nothing about
 * what has been said in it. That line is the whole design, and every judgement
 * below falls out of it:
 *
 * - **Furniture travels.** Widgets, reference images, ambiences, custom themes,
 *   the territories and where they sit, the server groups a project runs.
 * - **Work does not.** Cards, turns, transcripts. A conversation is a session
 *   file in the CLI's own store keyed to this machine, and a card carrying a
 *   `--resume` id that resolves to nothing is worse than no card. This is also
 *   why the sink, the billboard, the relays and the wakes stay behind: those are
 *   the wall's live coordination, not its arrangement.
 * - **Nor does anything about *this* machine.** `window_frame` is physical
 *   pixels of a monitor that is not there. Which theme is *on* lives in
 *   localStorage because `.claude/rules/theme.md` says that question is
 *   per-machine and disposable — the themes themselves travel, the choice
 *   between them does not.
 * - **Accounts are a separate document**, because the user asked for that and
 *   because they are a different kind of thing: `.claude/rules/accounts.md` is
 *   explicit that Skein holds no credential, so an exported account is a
 *   waterfall configuration and mixing it into the furniture would suggest a
 *   subscription had been carried across.
 *
 * ## No id travels
 *
 * An id is this database's handle on a row. Carrying one invites a collision
 * whose only resolutions are to overwrite something you have been using or to
 * silently drop what you are importing, and `theme.ts` already decided which of
 * those is wrong: *the themes already here are the ones you have been using and
 * the paste is the guess*. So every carried thing is made afresh here and gets a
 * fresh id, and an import **adds**. It never replaces and never deletes.
 *
 * That leaves one problem, and it is the one that decides whether this feature
 * is pleasant: the first thing anybody does with an export is import it again to
 * see whether it worked, and an import that adds would then double the wall.
 * Hence `sameSpot` — **furniture of the same kind in the same place is the same
 * furniture**, so a re-import is close to a no-op rather than a mess. It is a
 * judgement rather than a fact, and it is the right one for objects that have no
 * name: a widget is identified by what it is and where it is, because that is
 * also how you identify it when you are looking at the wall.
 *
 * ## A project arrives unrooted
 *
 * `project.root_path` is UNIQUE and is the identity the whole app uses — cards
 * are matched to territories by `cwd`, `ensure_project` finds one by its root.
 * A path from another machine will not exist here, and inventing a placeholder
 * would throw away the only useful thing the document knows: *which folder this
 * territory wants*. So the old root travels as-is, a project whose root is not
 * on this disk reads as unrooted, and rooting it is pointing it at a folder.
 *
 * Rooting has to rewrite more than one field, which is why `rebase` is here and
 * tested: a server group's `cwd` is a path under the old root, and a territory
 * rooted at a new folder whose dev servers still start in the old one is a
 * territory that looks fine and does nothing.
 */

import { tidy } from "./guidance";
import { cleanThemes, type Theme } from "./theme";

/** Bumped when a document written by this build could be misread by an older
 *  one. Reading is deliberately lenient about everything else — see `readLayout`
 *  — so this is for changes of *meaning*, not of shape. */
export const LAYOUT_VERSION = 1;

/** The wrapper key, and it says `skein` on purpose: CLAUDE.md's paragraph on
 *  where the rename stopped is that anything the disk or the wire depends on
 *  stays `skein`, and a document on disk is exactly that. `skeinThemes` in
 *  `theme.ts` is the same decision one file over. */
export const LAYOUT_KEY = "skeinLayout";

export type CarriedServer = {
  label: string;
  command: string;
  cwd: string | null;
  port: number | null;
};

export type CarriedGroup = {
  label: string;
  autostart: boolean;
  startOrder: number;
  servers: CarriedServer[];
};

export type CarriedProject = {
  name: string;
  /** The root it had where it was written. Kept verbatim even though it will
   *  not exist on the machine reading this — it is the only clue about what
   *  folder this territory is for, and a person can read it. */
  wasRoot: string;
  x: number | null;
  y: number | null;
  groups: CarriedGroup[];
  /** What this territory tells the cards standing in it. Furniture by this
   *  file's own test — it is how the room is arranged, not what has been said in
   *  it — and the one piece of furniture that is words rather than a rectangle.
   *  `""` for a territory that says nothing, which is most of them. */
  instructions: string;
};

export type CarriedWidget = {
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Opaque, and normalized by `widgets.ts` on the way in like every other
   *  read of `config_json` — a knob this build has never heard of costs a
   *  migration nowhere and cannot put a NaN inside a frame loop. */
  config: Record<string, unknown>;
};

export type CarriedImage = {
  /** The file's name, not its path. The path is a directory inside this
   *  machine's `%APPDATA%`, which means nothing anywhere else; the name is what
   *  a person recognises and is what the re-import matches on. */
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  /** The file itself, base64. Null for one that could not be read, which is
   *  carried anyway — an image with a size and a place and no bytes is a hole
   *  in the wall you can see and replace, where a silently dropped row is a
   *  layout that came back subtly wrong. */
  bytes: string | null;
};

export type CarriedAmbience = {
  name: string;
  /** Opaque for the same reason `config` is. */
  layers: unknown;
  /** Whether this was the one running. Part of how the wall looks, so it
   *  travels — unlike which *theme* was on, which is per-machine by rule. */
  active: boolean;
};

export type Carried = {
  projects: CarriedProject[];
  widgets: CarriedWidget[];
  images: CarriedImage[];
  ambiences: CarriedAmbience[];
  themes: Theme[];
  /** What the wall told every card standing on it. See `.claude/rules/guidance.md`.
   *
   *  A string rather than a section, so a document with nothing set is a
   *  document with `""` here rather than a key that may be missing — and so the
   *  five-section emptiness test below stays about *sections*. It is on purpose
   *  that this does not make a document non-empty on its own: a wall whose only
   *  content is a line of instructions is still a wall with nothing standing on
   *  it, and `readLayout` already has the right answer for that case through
   *  `LAYOUT_KEY`. */
  guidance: string;
};

export const NOTHING_CARRIED: Carried = {
  projects: [],
  widgets: [],
  images: [],
  ambiences: [],
  themes: [],
  guidance: "",
};

/* ── Writing ─────────────────────────────────────────────────────────────── */

/** The document, as text.
 *
 *  Indented, because it is a file somebody may open and read — and because the
 *  bytes are one long line whatever we do, so the indentation costs almost
 *  nothing against them. */
export function writeLayout(c: Carried): string {
  return JSON.stringify({ [LAYOUT_KEY]: LAYOUT_VERSION, ...c }, null, 2);
}

/** What is in a document, for the sentence the panel says before it commits to
 *  anything. `bytes` is the base64 length rather than the decoded size — this
 *  is a claim about the file you are about to write, not about the images. */
export function tally(c: Carried): {
  projects: number;
  widgets: number;
  images: number;
  ambiences: number;
  themes: number;
  bytes: number;
  /** How many sets of standing instructions are in here — the wall's, if it has
   *  any, plus every territory that carries some. Counted as one number rather
   *  than split by scope, because what the sentence before an import needs to
   *  say is *whether the document tells your agents anything*, and the panel
   *  that follows is where you find out what. */
  instructions: number;
} {
  return {
    projects: c.projects.length,
    widgets: c.widgets.length,
    images: c.images.length,
    ambiences: c.ambiences.length,
    themes: c.themes.length,
    bytes: c.images.reduce((n, i) => n + (i.bytes?.length ?? 0), 0),
    instructions:
      (c.guidance.trim() ? 1 : 0) + c.projects.filter((p) => p.instructions.trim()).length,
  };
}

/** A tally as a line of prose, or null for a document with nothing in it.
 *
 *  Written out rather than shown as a table because it is read once, before a
 *  press, and what matters is whether the numbers look like the wall you meant
 *  to carry. */
export function sayTally(c: Carried): string | null {
  const t = tally(c);
  const parts: string[] = [];
  const say = (n: number, one: string, many = `${one}s`) =>
    n > 0 ? parts.push(`${n} ${n === 1 ? one : many}`) : undefined;
  say(t.projects, "project");
  say(t.widgets, "widget");
  say(t.images, "image");
  say(t.ambiences, "ambience");
  say(t.themes, "theme");
  /* Last, and named as "instructions" rather than counted as a thing — "2
     instructions" reads as two sentences. This is the one item in the tally that
     changes what an agent is *told*, so it is worth its own clause even though
     it is the smallest thing in the file. */
  if (t.instructions > 0) {
    parts.push(t.instructions === 1 ? "1 set of instructions" : `${t.instructions} sets of instructions`);
  }
  if (parts.length === 0) return null;
  const size = t.bytes > 0 ? ` · ${saySize(t.bytes)} of image` : "";
  return parts.join(" · ") + size;
}

/** Round numbers, since this is read to decide whether to press something and
 *  not to audit anything. */
export function saySize(chars: number): string {
  const mb = chars / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)}mb`;
  const kb = chars / 1024;
  return `${Math.max(1, Math.round(kb))}kb`;
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/** A layout out of a document, normalized like anything else this app reads
 *  back.
 *
 *  Returns null only for text that is not a layout at all — not JSON, or JSON
 *  with none of the five keys in it. A document that *is* one but holds a
 *  section this build cannot use comes back with that section empty rather than
 *  refusing the whole thing, which is the same bargain every opaque column in
 *  this app strikes: degrade to something usable, because this is data that
 *  outlives the build that wrote it.
 *
 *  The version is read but not enforced. A newer document is very likely still
 *  mostly readable by the cleaners below, and refusing it outright would turn a
 *  partial import into no import — the failure this whole file exists to avoid
 *  is a wall that comes back subtly wrong, not one that comes back incomplete
 *  and says so. */
export function readLayout(text: string): Carried | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const out: Carried = {
    projects: list(r.projects).map(cleanProject).filter(isThere),
    widgets: list(r.widgets).map(cleanWidget).filter(isThere),
    images: list(r.images).map(cleanImage).filter(isThere),
    ambiences: list(r.ambiences).map(cleanAmbience).filter(isThere),
    themes: cleanThemes(r.themes),
    /* Through `guidance.ts`'s own `tidy`, so a document that has been hand-edited
       past the limit arrives already bounded — the same normalize-on-read
       bargain every opaque column in this app strikes, and the alternative is a
       string that reaches an argv and fails a spawn. */
    guidance: tidy(str(r.guidance) ?? ""),
  };

  const empty =
    out.projects.length === 0 &&
    out.widgets.length === 0 &&
    out.images.length === 0 &&
    out.ambiences.length === 0 &&
    out.themes.length === 0;
  /* An empty result is only "not a layout" if the document never claimed to be
     one. A wall with nothing on it is a legitimate thing to have exported, and
     saying "nothing in that" about your own empty export is a lie about the
     file rather than about the wall. */
  if (empty && !(LAYOUT_KEY in r)) return null;
  return out;
}

/** What version wrote a document, or null for one that does not say. Read for
 *  the note the panel shows, not to gate anything. */
export function versionOf(text: string): number | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const v = raw?.[LAYOUT_KEY];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/* ── Identity: what counts as already being here ─────────────────────────── */

/** How close two coordinates have to be to count as the same place.
 *
 *  Generous — a widget is 200-odd pixels wide and nothing lands within four of
 *  another by accident — because the point is to survive a round trip through a
 *  float in JSON, not to be strict about it. */
export const SPOT_SLOP = 4;

export function sameSpot(a: number, b: number, slop = SPOT_SLOP): boolean {
  return Math.abs(a - b) <= slop;
}

/** Whether this widget is already on the wall: same kind, same place.
 *
 *  See the note at the top about why identity for furniture is what-and-where.
 *  Deliberately not the config: two clocks in one spot set to two timezones are
 *  one clock somebody has been fiddling with, and a re-import should leave the
 *  fiddling alone rather than adding a second clock underneath it. */
export function widgetIsHere(
  w: { kind: string; x: number; y: number },
  here: { kind: string; x: number; y: number }[],
): boolean {
  return here.some((h) => h.kind === w.kind && sameSpot(h.x, w.x) && sameSpot(h.y, w.y));
}

/** The same, for an image — matched on the file's name and its place, since the
 *  path is a `%APPDATA%` directory that means nothing off this machine. */
export function imageIsHere(
  i: { name: string; x: number; y: number },
  here: { path: string; x: number; y: number }[],
): boolean {
  const name = baseName(i.name).toLowerCase();
  return here.some(
    (h) => baseName(h.path).toLowerCase() === name && sameSpot(h.x, i.x) && sameSpot(h.y, i.y),
  );
}

/* ── Roots ───────────────────────────────────────────────────────────────── */

/** Whether a carried project's old root is a territory this wall already has.
 *
 *  Matched case-insensitively and with separators folded, because the same
 *  folder is spelled several ways on Windows and a territory duplicated by a
 *  backslash is the worst kind of duplicate: two of them, both apparently
 *  right. */
export function alreadyHere(p: { wasRoot: string }, roots: string[]): boolean {
  const want = normPath(p.wasRoot);
  return roots.some((r) => normPath(r) === want);
}

/** Fold a path to the one form comparisons are done in. Not for display and
 *  never written anywhere — `wasRoot` keeps whatever it was given. */
export function normPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The last segment of a path, with either separator. `classify.ts` has a
 *  `basename` for display; this one is for matching and is deliberately not
 *  that — it keeps the extension, because two screenshots differing only in
 *  extension are two images. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Move a path from under one root to under another.
 *
 *  Returns the path unchanged when it is not under `from` at all, which is the
 *  common case for an absolute `cwd` somebody set by hand to somewhere else
 *  entirely — rewriting that would be inventing an intention. Separator style
 *  follows the *new* root, since the result is a path for this machine.
 *
 *  The guard on a partial segment match is the case worth having a test for:
 *  `C:\work\skein-old` is not under `C:\work\skein`, and a naive prefix check
 *  says it is. */
export function rebase(path: string, from: string, to: string): string {
  const f = normPath(from);
  const p = normPath(path);
  if (f.length === 0) return path;
  if (p !== f && !p.startsWith(f + "/")) return path;

  const rest = path.slice(from.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
  const sep = to.includes("\\") ? "\\" : "/";
  const base = to.replace(/[\\/]+$/, "");
  return rest.length === 0 ? base : `${base}${sep}${rest}`;
}

/** A server group rooted somewhere else, brought over to a new root.
 *
 *  A group whose `cwd` is null is left null — that means "the project's root",
 *  which is exactly the thing that has just changed, so it is already correct
 *  and rewriting it to an absolute path would freeze it. */
export function rerootGroup(g: CarriedGroup, from: string, to: string): CarriedGroup {
  return {
    ...g,
    servers: g.servers.map((s) => ({
      ...s,
      cwd: s.cwd === null ? null : rebase(s.cwd, from, to),
    })),
  };
}

/* ── Cleaners ────────────────────────────────────────────────────────────── */

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isThere<T>(v: T | null): v is T {
  return v !== null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** A finite number or the fallback. Every coordinate in this file goes through
 *  here, because a NaN out of a hand-edited document would reach a `transform`
 *  and take the wall with it. */
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A number or null, for a coordinate that legitimately has no value — a
 *  territory the grid has not placed yet. */
function maybeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function cleanProject(raw: unknown): CarriedProject | null {
  const o = obj(raw);
  if (!o) return null;
  const wasRoot = str(o.wasRoot) ?? str(o.root_path);
  /* Without a root there is nothing to root, and nothing to tell a person what
     the territory was for. A named project pointing nowhere is furniture with
     no purpose, so it is dropped rather than imported empty. */
  if (!wasRoot) return null;
  return {
    name: str(o.name) ?? baseName(wasRoot),
    wasRoot,
    x: maybeNum(o.x),
    y: maybeNum(o.y),
    groups: list(o.groups).map(cleanGroup).filter(isThere),
    instructions: tidy(str(o.instructions) ?? ""),
  };
}

export function cleanGroup(raw: unknown): CarriedGroup | null {
  const o = obj(raw);
  if (!o) return null;
  const servers = list(o.servers).map(cleanServer).filter(isThere);
  /* A group with no runnable server in it is a button that does nothing. */
  if (servers.length === 0) return null;
  return {
    label: str(o.label) ?? servers[0].label,
    autostart: bool(o.autostart, true),
    startOrder: num(o.startOrder ?? o.start_order, 0),
    servers,
  };
}

export function cleanServer(raw: unknown): CarriedServer | null {
  const o = obj(raw);
  if (!o) return null;
  const command = str(o.command);
  if (!command) return null;
  const port = maybeNum(o.port);
  return {
    label: str(o.label) ?? command,
    command,
    cwd: str(o.cwd),
    /* A port is a port. Anything outside the range is a typo, and a typo that
       reaches the health check reads as a server that never comes up. */
    port: port !== null && port > 0 && port < 65536 ? Math.floor(port) : null,
  };
}

export function cleanWidget(raw: unknown): CarriedWidget | null {
  const o = obj(raw);
  if (!o) return null;
  const kind = str(o.kind);
  /* The catalogue is checked on the way in, not here — `widgets.ts` owns what
     kinds exist and this module must not hold a second copy of that list. What
     is dropped here is only a row with no kind at all. */
  if (!kind) return null;
  return {
    kind,
    x: num(o.x, 0),
    y: num(o.y, 0),
    /* Zero is not a size. A widget with no measurements takes the catalogue's,
       which is what `defaultConfig` and `newWidget` would have given it. */
    w: Math.max(0, num(o.w, 0)),
    h: Math.max(0, num(o.h, 0)),
    z: Math.round(num(o.z, 0)),
    config: obj(o.config) ?? {},
  };
}

export function cleanImage(raw: unknown): CarriedImage | null {
  const o = obj(raw);
  if (!o) return null;
  const name = str(o.name) ?? (str(o.path) ? baseName(str(o.path)!) : null);
  if (!name) return null;
  const bytes = str(o.bytes);
  return {
    name: baseName(name),
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: Math.max(0, num(o.w, 0)),
    h: Math.max(0, num(o.h, 0)),
    rotation: num(o.rotation, 0),
    z: Math.round(num(o.z, 0)),
    bytes,
  };
}

export function cleanAmbience(raw: unknown): CarriedAmbience | null {
  const o = obj(raw);
  if (!o) return null;
  const name = str(o.name);
  if (!name) return null;
  return {
    name,
    layers: o.layers ?? o.layers_json ?? null,
    active: bool(o.active, false),
  };
}

/** Only one ambience can be running, so more than one claiming it is a document
 *  that has been edited or merged by hand. The first wins, because the first is
 *  the one a person reading the file would expect to. */
export function oneActive(list: CarriedAmbience[]): CarriedAmbience[] {
  let seen = false;
  return list.map((a) => {
    if (!a.active) return a;
    if (seen) return { ...a, active: false };
    seen = true;
    return a;
  });
}

/** A name that is not already taken, `dusk` → `dusk 2`.
 *
 *  The same policy `theme.ts`'s `freeId` has and for the same reason — rename
 *  rather than overwrite — but on a display name rather than a slug, so the
 *  suffix is spaced rather than hyphenated and the result is meant to be read.
 *  Compared case-insensitively, since two ambiences called `Dusk` and `dusk`
 *  are a person who does not think they have two. */
export function freeName(want: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.trim().toLowerCase()));
  if (!used.has(want.trim().toLowerCase())) return want;
  for (let n = 2; n < 1000; n++) {
    const t = `${want} ${n}`;
    if (!used.has(t.toLowerCase())) return t;
  }
  return `${want} ${Date.now()}`;
}
