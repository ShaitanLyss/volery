/* The seam between what was said and the wall it was said to.
 *
 * `voice.ts` is the whole of the thinking and none of the reaching: it resolves
 * referents against a `Wall` it is handed and produces a `Plan` of steps against
 * a `Hands` it is given. This is the thing that builds both out of the running
 * app, and it is the only file in the subsystem that knows Tauri exists.
 *
 * Named `.svelte.ts` though it declares no rune, because that is the honest
 * label rather than a technicality: every line of it reads live `$state`
 * through the host, so it can only run in the app, and the purity boundary is a
 * statement about what can be tested rather than about which functions were
 * called. The logic worth testing is already next door.
 *
 * ## What it takes, and why that one
 *
 * A `ControlHost` — the same handles `App.svelte` builds for the control
 * surface, which its own comment describes as *"the handles a pair of hands
 * would have"*. A voice is a pair of hands, so this is not an analogy.
 *
 * But it is **not** a client of the control surface, and the distinction is the
 * point. That surface is off unless `SKEIN_CONTROL=1`, binds loopback, writes a
 * token into `%APPDATA%` and lights a chip in the title bar; arming it in every
 * install so voice had somewhere to POST would be a listening socket nobody
 * asked for. The *host* is built unconditionally and is just an object. So voice
 * reaches the same in-process seams the surface does, directly, which is
 * `control.md`'s first rule kept rather than worked around: drive the app's own
 * seams, never a path beside them.
 *
 * ## The file lists, and why they are a cache
 *
 * `Finder.root` is a single `$state("")` and `list()` replaces `files` wholesale
 * for that one root — so the list to hand belongs to whichever territory the
 * finder was last opened on, which is almost never the one you just named.
 * Prefetching every territory is a ripgrep apiece, stale before it is used;
 * fetching inside the parse would make the fast rung async, which is the one
 * thing it must not be. So `wallFor` fetches exactly the territories the
 * sentence mentions, once each, and keeps them. About 100ms the first time a
 * territory is named and nothing after that.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ControlHost } from "./control.svelte";
import {
  carry,
  hear,
  territoriesIn,
  type Hands,
  type Outcome,
  type Plan,
  type VoiceCard,
  type VoiceTerritory,
  type Wall,
} from "./voice";

/** What became of an utterance. */
export type Heard =
  /** The grammar could not account for the whole of it, so it is the steward's.
   *
   *  There is no steward yet, so this is where the ladder currently stops. It is
   *  a distinct outcome rather than a failure on purpose: *escalate* and *did
   *  not understand* are the same shape from outside and must not become the
   *  same value, or the day the steward arrives every call site has to be
   *  re-read to find out which one it was handling. */
  | { kind: "escalate"; said: string }
  /** Understood, and not run: at least one step is not something you may do to
   *  the wall without being asked. */
  | { kind: "confirm"; plan: Plan }
  | { kind: "carried"; plan: Plan; outcome: Outcome };

export class Voicing {
  #host: ControlHost;

  /** One project's file list per root, fetched once and kept.
   *
   *  Plain, not `$state`: nothing draws it, and a fetch landing must not repaint
   *  the wall. Nothing subscribes and no timer runs, so there is nothing here to
   *  release — which is worth saying, because most classes on this wall have
   *  both. */
  #files = new Map<string, string[]>();

  constructor(host: ControlHost) {
    this.#host = host;
  }

  /* ── the wall, as voice sees it ────────────────────────────────────────── */

  /** The wall right now, with whatever file lists are already to hand. */
  #snapshot(): Wall {
    const cards: VoiceCard[] = this.#host.skein.convs.map((c) => ({
      id: c.id,
      title: c.title,
      project: c.project,
      working: c.working,
    }));
    const territories: VoiceTerritory[] = this.#host.skein.projects.map((p) => ({
      /* `Project.name` is `dir_name(root_path)` — the folder, which is what a
         territory is called out loud. The two fields are kept apart anyway,
         since the day a territory can be labelled is the day the spoken name
         and the folder stop agreeing. */
      project: p.name,
      cwd: p.root_path,
      files: this.#files.get(p.root_path) ?? [],
    }));
    return { cards, territories, focusedId: this.#host.focusedId() };
  }

  /** One territory's files, fetched once.
   *
   *  A root that has gone away leaves an empty list rather than throwing: the
   *  consequence is that a file in it cannot be resolved, which is the same
   *  answer as a file that is not there, and it is not worth failing an
   *  utterance that may not have been about that territory at all. */
  async #list(cwd: string): Promise<void> {
    if (this.#files.has(cwd)) return;
    try {
      const out = await invoke<{ files: string[]; truncated: boolean }>("find_files", {
        root: cwd,
      });
      this.#files.set(cwd, out.files);
    } catch {
      this.#files.set(cwd, []);
    }
  }

  /** Forget the cached lists, so the next sentence sees the tree as it is now.
   *
   *  Nothing calls this on a clock. A file list going stale costs you a file
   *  that will not open by name until you say the territory again, which is a
   *  worse thing to *poll* for than to live with — see the three-pollers
   *  argument in `CLAUDE.md`. The gestures that plainly invalidate it (a branch
   *  changing under a territory, a card finishing a build) can call it. */
  forget(cwd?: string): void {
    if (cwd) this.#files.delete(cwd);
    else this.#files.clear();
  }

  /** The wall, with the file lists this particular sentence is going to need.
   *
   *  Two snapshots rather than one because the question is circular — which
   *  territories to fetch is read off the sentence *against* a wall — and a map
   *  over the cards and projects is cheap enough that resolving it by doing it
   *  twice is better than threading a half-built wall through. */
  async wallFor(utterance: string): Promise<Wall> {
    for (const t of territoriesIn(utterance, this.#snapshot())) await this.#list(t.cwd);
    return this.#snapshot();
  }

  /* ── the hands ─────────────────────────────────────────────────────────── */

  /** The same calls the control surface's ops make, and for the same reason
   *  they do: `focus` selects as well as focuses because that is what the wall's
   *  own gesture does, and a voice that focused without selecting would have
   *  invented a state no mouse can produce. */
  hands(): Hands {
    const h = this.#host;
    /** A card by id, or a throw — which is what turns a card closed between the
     *  parse and the run into `carry`'s `stopped`, naming the step. */
    const card = (id: string) => {
      const c = h.skein.convs.find((x) => x.id === id);
      if (!c) throw new Error(`no card ${id} any more`);
      return c;
    };
    return {
      focus: (id) => {
        const c = card(id);
        h.setFocused(c.id);
        h.studio.selectOnly(c.id);
      },
      select: (ids) => h.studio.pickCards(ids.map((i) => card(i).id)),
      deselect: () => h.deselect(),
      fit: () => {
        const canvas = h.canvas();
        /* Louder than a no-op on purpose. A plan that silently did not move the
           wall is the failure `spoke()` exists to be able to report. */
        if (!canvas) throw new Error("the wall is not drawn yet");
        canvas.fitAll();
      },
      stop: async (id) => {
        await h.skein.stop(card(id));
      },
      aside: (id, aside) => h.skein.setAside(card(id), aside),
      open: async (cwd) => {
        await h.openIn(cwd);
      },
      lookAt: async (cwd, path) => {
        await h.finder.lookAt(cwd, path);
      },
    };
  }

  /* ── the whole path ────────────────────────────────────────────────────── */

  /** Understand a sentence and, if it may simply happen, do it.
   *
   *  **A plan that needs confirming is never carried out here**, whatever the
   *  caller intended, unless it says so. That gate is in this one function
   *  rather than in each of its callers, because the set of things it protects
   *  is `IMMEDIATE`'s complement — everything the wall can do that is not merely
   *  looking at it — and a caller that forgot would be a broadcast to a wall of
   *  cards spawned with `--dangerously-skip-permissions`. */
  async say(utterance: string, confirmed = false): Promise<Heard> {
    const plan = hear(utterance, await this.wallFor(utterance));
    if (!plan) return { kind: "escalate", said: utterance };
    if (plan.needs === "confirmation" && !confirmed) return { kind: "confirm", plan };
    return { kind: "carried", plan, outcome: await carry(plan, this.hands()) };
  }
}
