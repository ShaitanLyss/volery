/* The hands that carry a layout out and put one back.
 *
 * `portage.ts` is what a layout *is* — what travels, what is left behind, how a
 * re-import avoids doubling the wall. This is the doing of it, and it has one
 * governing rule:
 *
 * **An import goes through the same commands a pair of hands would use.**
 *
 * That is `.claude/rules/control.md`'s argument about the control surface,
 * borrowed one file over, and it is worth borrowing: a second write path is the
 * one that drifts. Every widget here arrives through `Widgets.add`, every image
 * through `Board.paste`, every territory through `ensure_project` — so an
 * imported thing is undoable, is normalized, is drawn and is saved by exactly
 * the code that does those things for a thing you made yourself. Nothing in this
 * file writes a row, and nothing in Rust knows an import happened.
 *
 * It costs two things, and both are the right price. Placing a widget is two
 * round trips rather than one (`add`, then `update` with the size and the config
 * the catalogue's default does not know). And an import lands on the undo stack
 * as one act per thing rather than as one act — `fusable` in `undo.ts` requires
 * the same records, and these are all different records. So the panel says so
 * rather than promising a single press that takes it all back.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Skein, Project } from "./skein.svelte";
import type { Board } from "./images.svelte";
import type { Widgets } from "./widgets.svelte";
import type { Ambience } from "./ambience.svelte";
import type { ink } from "./theme.svelte";
import { specFor } from "./widgets";
import { EXPORT_VERSION as THEME_VERSION } from "./theme";
import {
  alreadyHere,
  baseName,
  freeName,
  imageIsHere,
  normPath,
  oneActive,
  readLayout,
  rerootGroup,
  widgetIsHere,
  writeLayout,
  type Carried,
  type CarriedGroup,
  type CarriedProject,
} from "./portage";

export type Hands = {
  skein: Skein;
  board: Board;
  widgets: Widgets;
  ambience: Ambience;
  /* The singleton, whose class is not exported — see `theme.svelte.ts`. */
  ink: typeof ink;
};

/** What an import actually did, for the sentence afterwards. Counted rather than
 *  assumed: half the point of the `sameSpot` identity is that a re-import adds
 *  almost nothing, and a panel that said "imported 40 widgets" when it had added
 *  none would make that invisible. */
export type Landed = {
  projects: number;
  groups: number;
  widgets: number;
  images: number;
  ambiences: number;
  themes: number;
  /** Things in the document this build could not place, by reason. Reported
   *  rather than swallowed — a layout that came back quietly incomplete is the
   *  failure `portage.ts` is written against. */
  skipped: string[];
};

const NOTHING_LANDED = (): Landed => ({
  projects: 0,
  groups: 0,
  widgets: 0,
  images: 0,
  ambiences: 0,
  themes: 0,
  skipped: [],
});

export class Portage {
  /** A read or a write in flight. One at a time: both walk the whole wall, and
   *  two at once would be two documents interleaved. */
  busy = $state(false);
  /** What the last gesture had to say, in the panel's own voice. */
  note = $state<string | null>(null);
  fault = $state<string | null>(null);

  /** A document that has been read and not yet applied, and where it came from.
   *
   *  Two steps on purpose. An import adds to the wall and cannot be taken back
   *  in one press, so the tally goes up first and the press that commits to it
   *  is a second one — the same reason a broadcast costs a modifier. */
  pending = $state<Carried | null>(null);
  pendingFrom = $state<string | null>(null);
  landed = $state<Landed | null>(null);

  #hands: Hands;

  constructor(hands: Hands) {
    this.#hands = hands;
  }

  /* ── Out ───────────────────────────────────────────────────────────────── */

  /** The wall as a document.
   *
   *  Reads live state and the image files behind it, and writes nothing. Safe to
   *  call to show a tally before anybody has chosen a path. */
  async gather(): Promise<Carried> {
    const { skein, board, widgets, ambience, ink } = this.#hands;

    const projects: CarriedProject[] = skein.projects.map((p) => ({
      name: p.name,
      wasRoot: p.root_path,
      /* The wall position travels; the *glass* position does not. Sticking a
         thing to the glass is a place in screen pixels on this window at this
         size (see the note at the top of `glass.ts`), and a window somewhere
         else is a different window. A carried thing comes back on the wall,
         where it also is. */
      x: p.x,
      y: p.y,
      groups: skein.groups
        .filter((g) => g.group.project_id === p.id)
        .map((g) => ({
          label: g.group.label,
          autostart: g.group.autostart,
          startOrder: g.group.start_order,
          servers: g.group.servers.map((s) => ({
            label: s.label,
            command: s.command,
            cwd: s.cwd,
            port: s.port,
          })),
        })),
    }));

    return {
      projects,
      widgets: widgets.items.map((w) => ({
        kind: w.kind,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        config: $state.snapshot(w.config) as Record<string, unknown>,
      })),
      images: await Promise.all(
        board.images.map(async (i) => ({
          name: baseName(i.path),
          x: i.x,
          y: i.y,
          w: i.w,
          h: i.h,
          rotation: i.rotation,
          z: i.z,
          bytes: await this.#bytesOf(i.path),
        })),
      ),
      ambiences: oneActive(
        ambience.profiles.map((p) => ({
          name: p.name,
          layers: $state.snapshot(p.layers),
          active: p.id === ambience.activeId,
        })),
      ),
      /* The themes themselves, not which one is on: `.claude/rules/theme.md` is
         explicit that the choice is per-machine and disposable, and it lives in
         localStorage for that reason. */
      themes: $state.snapshot(ink.customs),
    };
  }

  /** Read an image back out of storage as base64.
   *
   *  Through the asset protocol rather than a Rust command, because the wall
   *  already draws these files that way — `assetProtocol.scope` in
   *  `tauri.conf.json` is `$APPDATA/references/**`, which is exactly the set of
   *  files an image row can point at. Nothing new is reachable that was not
   *  already on screen.
   *
   *  Null on any failure, which is a deliberate non-event: `portage.ts` carries
   *  an image with no bytes as a hole you can see and replace, and one missing
   *  file must not cost the other thirty. */
  async #bytesOf(path: string): Promise<string | null> {
    try {
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) return null;
      return base64(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Gather, ask for a path, write it. */
  async write(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.note = null;
    this.fault = null;
    try {
      const carried = await this.gather();
      /* Imported lazily for the same reason the rest of the app does it: the
         dialog plugin pulls in a chunk nothing on the first paint needs. */
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        title: "Carry this wall off",
        defaultPath: "wall.volery.json",
        filters: [{ name: "volery layout", extensions: ["volery.json", "json"] }],
      });
      if (typeof picked !== "string") return;
      /* The extension is insisted on rather than corrected: `portage.rs` refuses
         anything else, and silently renaming what somebody typed is a file
         saved where they cannot find it. */
      const path = picked.toLowerCase().endsWith(".volery.json")
        ? picked
        : `${picked.replace(/\.json$/i, "")}.volery.json`;
      await invoke("write_layout_file", { path, text: writeLayout(carried) });
      this.note = `carried off to ${baseName(path)}`;
    } catch (err) {
      this.fault = String(err);
    } finally {
      this.busy = false;
    }
  }

  /* ── In ────────────────────────────────────────────────────────────────── */

  /** Ask for a document and read it. Nothing is put on the wall by this — see
   *  `pending`. */
  async read(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.note = null;
    this.fault = null;
    this.landed = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: "A layout to bring in",
        filters: [{ name: "volery layout", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      const text = await invoke<string>("read_layout_file", { path: picked });
      const carried = readLayout(text);
      if (!carried) {
        this.fault = `there is no layout in ${baseName(picked)}`;
        return;
      }
      this.pending = carried;
      this.pendingFrom = baseName(picked);
    } catch (err) {
      this.fault = String(err);
    } finally {
      this.busy = false;
    }
  }

  forget() {
    this.pending = null;
    this.pendingFrom = null;
  }

  /** Put the read document onto the wall.
   *
   *  Ordered so that nothing lands before the thing it belongs to: themes and
   *  ambiences are free-standing, territories have to exist before their server
   *  groups, and the furniture is last because it is what you will be looking
   *  at when this finishes.
   *
   *  Every step is guarded on its own. A document with one unusable section
   *  should import the other four and say what it could not do — the failure
   *  this whole feature is written against is a wall that comes back subtly
   *  wrong, not one that comes back incomplete and honest about it. */
  async settle(): Promise<Landed | null> {
    const carried = this.pending;
    if (!carried || this.busy) return null;
    this.busy = true;
    this.fault = null;
    const out = NOTHING_LANDED();
    const { skein, board, widgets, ambience, ink } = this.#hands;

    try {
      /* Themes, through the same paste the themes panel uses — which already
         renames rather than overwrites on a collision, and normalizes. */
      if (carried.themes.length > 0) {
        try {
          out.themes = ink.paste(
            JSON.stringify({ skeinThemes: THEME_VERSION, themes: carried.themes }),
          );
        } catch {
          out.skipped.push(`${carried.themes.length} themes could not be read`);
        }
      }

      /* Ambiences. Renamed rather than overwritten, same policy — and the one
         the document says was showing is switched to at the end, once, rather
         than as each arrives. */
      let becomes: string | null = null;
      for (const a of carried.ambiences) {
        try {
          const name = freeName(
            a.name,
            ambience.profiles.map((p) => p.name),
          );
          const p = await ambience.adopt(name, a.layers);
          out.ambiences++;
          if (a.active) becomes = p.id;
        } catch {
          out.skipped.push(`the ambience "${a.name}" could not be built`);
        }
      }
      /* A layout is how the wall looks, so the ambience it was wearing comes
         with it. Said out loud in the panel, because it is the one part of an
         import that changes something already on screen rather than adding to
         it. */
      if (becomes) await ambience.use(becomes);

      /* Territories. A carried root that is already a territory here is matched
         to it rather than duplicated — importing your own layout back onto the
         machine it came from should be close to a no-op, not a second copy of
         every project. Its position is deliberately *not* reapplied: where your
         territories sit is your arrangement, and the document is older than it.
         What is topped up is its server groups, by label. */
      for (const p of carried.projects) {
        try {
          const here = alreadyHere(p, skein.projects.map((x) => x.root_path));
          const project = await invoke<Project>("ensure_project", { rootPath: p.wasRoot });
          if (!here) {
            out.projects++;
            if (p.x !== null && p.y !== null) skein.placeProject(p.wasRoot, p.x, p.y);
          }
          out.groups += await this.#groupsFor(project, p.wasRoot, p.groups);
        } catch (err) {
          out.skipped.push(`the territory "${p.name}" could not be made (${err})`);
        }
      }

      /* Widgets. `add` takes a place and the catalogue's defaults; the size, the
         stacking and the knobs are a second call, because those are what the
         document knows and the catalogue does not. */
      const standing = () => widgets.items.map((w) => ({ kind: w.kind, x: w.x, y: w.y }));
      for (const w of carried.widgets) {
        /* The catalogue is asked here rather than in `portage.ts`, which must not
           hold a second copy of the list of kinds. A widget from a newer build
           is named in the skips instead of being silently dropped — that is the
           one honest thing to do about a thing this build cannot draw. */
        if (!specFor(w.kind)) {
          out.skipped.push(`no widget called "${w.kind}" in this build`);
          continue;
        }
        if (widgetIsHere(w, standing())) continue;
        try {
          const made = await widgets.add(w.kind as never, w.x, w.y);
          if (!made) continue;
          widgets.update(made.id, {
            w: w.w > 0 ? w.w : made.w,
            h: w.h > 0 ? w.h : made.h,
            z: w.z,
            /* Normalized on the way in by `widgets.ts`, like every other read of
               `config_json` — a knob this build has never heard of costs a
               migration nowhere. */
            config: { ...made.config, ...w.config } as never,
          });
          out.widgets++;
        } catch (err) {
          out.skipped.push(`a ${w.kind} would not go up (${err})`);
        }
      }

      /* Images. `paste` is the path bytes take when there is no file to copy —
         written for a screenshot off the clipboard, and an imported image is the
         same situation: bytes in hand, nothing on disk. */
      for (const i of carried.images) {
        if (i.bytes === null) {
          out.skipped.push(`"${i.name}" travelled without its file`);
          continue;
        }
        if (imageIsHere(i, board.images.map((h) => ({ path: h.path, x: h.x, y: h.y })))) continue;
        try {
          const made = await board.paste(unbase64(i.bytes), i.x, i.y);
          if (!made) continue;
          /* `paste` measures the image and centres it on the point given, so the
             place and the size are both corrected here to what was carried. */
          board.update(made.id, {
            x: i.x,
            y: i.y,
            w: i.w > 0 ? i.w : made.w,
            h: i.h > 0 ? i.h : made.h,
            rotation: i.rotation,
            z: i.z,
          });
          out.images++;
        } catch (err) {
          out.skipped.push(`"${i.name}" would not go up (${err})`);
        }
      }

      this.landed = out;
      this.note = sayLanded(out);
      this.forget();
      return out;
    } catch (err) {
      this.fault = String(err);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** A territory's server groups, topped up rather than replaced.
   *
   *  Matched on the label, which is what a group is called and how you would
   *  tell two apart yourself — so importing a layout you already have adds the
   *  group you have since made on the other machine and leaves the rest alone.
   *
   *  Rerooted only if the two roots genuinely differ, which at import time they
   *  do not: `ensure_project` is called with the carried root, so a fresh
   *  territory *is* rooted where the document said. The case this guard is for is
   *  a document whose project was matched to one already here — the same folder
   *  under a different spelling, or a root somebody has since moved. Rerooting
   *  when they match would rewrite every `cwd` into this document's
   *  capitalisation for no reason. Pointing an unrooted territory at a real
   *  folder afterwards is `reroot`, which is where the interesting half of this
   *  lives. */
  async #groupsFor(
    project: Project,
    wasRoot: string,
    groups: CarriedGroup[],
  ): Promise<number> {
    const { skein } = this.#hands;
    const moved = normPath(wasRoot) !== normPath(project.root_path);
    let made = 0;
    for (const g of groups) {
      const already = skein.groups.some(
        (x) => x.group.project_id === project.id && x.group.label === g.label,
      );
      if (already) continue;
      const g2 = moved ? rerootGroup(g, wasRoot, project.root_path) : g;
      await skein.addGroup(project.id, g2.label, g2.servers, {
        autostart: g2.autostart,
        startOrder: g2.startOrder,
      });
      made++;
    }
    return made;
  }

  /* ── Rooting a territory that arrived pointing nowhere ─────────────────── */

  /** Point a territory at a folder on this machine.
   *
   *  This is the other half of "a project arrives unrooted". `root_path` is the
   *  identity the whole app matches on — cards find their territory by `cwd`,
   *  `ensure_project` finds one by its root — so changing it is a real edit and
   *  not a label change, and it has to take the territory's server groups with
   *  it. A territory rooted at a new folder whose dev servers still start in the
   *  old one is a territory that looks right and does nothing; `rebase` in
   *  `portage.ts` is that rewrite, and it is tested against the partial-segment
   *  trap that makes the naive version wrong.
   *
   *  Refuses rather than merges when the new root is already a territory here.
   *  Two rows cannot share a `root_path` — it is UNIQUE — and quietly folding
   *  one into the other would take a decision about somebody's cards that
   *  nothing here is entitled to make. */
  async reroot(project: Project, to: string): Promise<boolean> {
    const { skein } = this.#hands;
    this.fault = null;
    if (normPath(to) === normPath(project.root_path)) {
      this.note = "that is where it already points";
      return false;
    }
    if (skein.projects.some((p) => p.id !== project.id && normPath(p.root_path) === normPath(to))) {
      this.fault = `${baseName(to)} is already a territory on this wall`;
      return false;
    }
    const was = project.root_path;
    try {
      await invoke("reroot_project", { id: project.id, rootPath: to });
      for (const g of skein.groups.filter((x) => x.group.project_id === project.id)) {
        const moved = rerootGroup(
          {
            label: g.group.label,
            autostart: g.group.autostart,
            startOrder: g.group.start_order,
            servers: g.group.servers,
          },
          was,
          to,
        );
        await skein.reworkGroup(g, moved.servers);
      }
      skein.rootedAt(project.id, to);
      this.note = `pointed at ${baseName(to)}`;
      return true;
    } catch (err) {
      this.fault = String(err);
      return false;
    }
  }

  /** Ask for a folder and root a territory at it. */
  async pickRoot(project: Project): Promise<void> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: `Where is ${project.name}?`,
    });
    if (typeof picked === "string") await this.reroot(project, picked);
  }
}

/* ── Prose ─────────────────────────────────────────────────────────────────── */

/** What an import did, as a line. Counts only, plus the skips — a wall you can
 *  now look at does not need a list of what is on it. */
export function sayLanded(l: Landed): string {
  const parts: string[] = [];
  const say = (n: number, one: string, many = `${one}s`) =>
    n > 0 ? parts.push(`${n} ${n === 1 ? one : many}`) : undefined;
  say(l.projects, "territory", "territories");
  say(l.groups, "server group");
  say(l.widgets, "widget");
  say(l.images, "image");
  say(l.ambiences, "ambience");
  say(l.themes, "theme");
  const did = parts.length > 0 ? parts.join(" · ") : "nothing new — it was all already here";
  return l.skipped.length > 0 ? `${did} · ${l.skipped.length} left out` : did;
}

/* ── base64 ────────────────────────────────────────────────────────────────── */

/** Chunked, because `String.fromCharCode(...bytes)` on a screenshot is a spread
 *  of two million arguments and blows the stack. 32k at a time is comfortably
 *  under every engine's limit and costs one concatenation per chunk. */
function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 32 * 1024;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function unbase64(text: string): ArrayBuffer {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}
