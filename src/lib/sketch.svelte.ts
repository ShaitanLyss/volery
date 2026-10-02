/* The references on disk, and the quiet job that keeps some there.
 *
 * `sketch.ts` knows what a source is; `sketch.rs` fetches and caches. This is
 * the state in between — what is on disk, what you are working on this month,
 * and the one rule that makes the toy worth having: **the gate never fetches.**
 *
 * That rule is the whole design. A morning with no network is still a morning
 * you wanted to draw, and a gate that went to the internet for its picture
 * would be a gate that hangs for twenty seconds on a train and then shows you
 * an error — so the fetching happens *ahead*, while you are going away and the
 * machine is idle and nobody is waiting, and the gate only ever opens a file.
 *
 * Holds no subscription, so it needs no `Listeners` — the same note
 * `motion.svelte.ts` carries, and the same warning: if anything here is ever
 * given one, that stops being true.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import {
  CACHE_WANT,
  DEFAULT_TERMS,
  pick,
  wanted,
  type Reference,
  type SourceId,
} from "./sketch";

const SOURCES_KEY = "skein.sketch.sources";
const TERMS_KEY = "skein.sketch.terms";
const FOLDER_KEY = "skein.sketch.folder";

/** One reference as Rust keeps it. Mirrors `sketch::Cached`. */
export type Cached = {
  id: string;
  title: string;
  artist: string;
  credit: string;
  source: string;
  path: string;
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a browser refusing storage is not a reason to refuse the setting */
  }
}

export class Sketchbook {
  /** What is on disk, ready to draw. */
  have = $state<Cached[]>([]);
  /** Which sources are on. */
  sources = $state<SourceId[]>(["artic", "met", "photo", "search"]);
  /** What you are working on. Empty means `DEFAULT_TERMS`, so clearing the box
   *  is "surprise me" rather than "fetch nothing" — which is the reading
   *  somebody emptying a list of search terms actually wants. */
  terms = $state<string[]>([]);
  /** A directory of your own references. The honest route for an artist whose
   *  work no open-access collection has — see the note in `sketch.ts`. */
  folder = $state<string | null>(null);

  /** What the last top-up ran into, if anything. Shown in the settings rather
   *  than thrown: a cache that could not be filled is not an error anybody
   *  needs interrupting for, and a *silent* one is a toy that mysteriously has
   *  nothing to show. */
  fault = $state<string | null>(null);

  /** One top-up at a time. Two running together would race on the same ids and
   *  spend somebody's network twice for one picture. */
  #filling = false;

  constructor() {
    this.sources = read(SOURCES_KEY, this.sources);
    this.terms = read(TERMS_KEY, this.terms);
    this.folder = read(FOLDER_KEY, null);
    void this.refresh();
  }

  get ready(): boolean {
    return this.have.length > 0;
  }

  async refresh() {
    try {
      this.have = await invoke<Cached[]>("sketch_have");
    } catch {
      /* Leave it as it was; an empty list here would read as "you have nothing
         to draw", which is the one wrong answer. */
    }
  }

  /** A picture to draw, or nothing. */
  take(roll: number): Cached | null {
    return pick(this.have, roll);
  }

  /** The URL the webview can actually show it at. The asset protocol is scoped
   *  to `$APPDATA/references/**` and the cache lives under it, which is the
   *  whole reason the files go there. */
  src(c: Cached): string {
    return convertFileSrc(c.path);
  }

  async drop(id: string) {
    try {
      await invoke("sketch_drop", { id });
    } catch {
      /* Not worth reporting: the file is either gone or will be swept. */
    }
    this.have = this.have.filter((c) => c.id !== id);
  }

  /** Fetch until there are enough, one at a time, and stop at the first real
   *  failure.
   *
   *  Called when you go away and once at launch. Never from the gate — see the
   *  note at the top of this file, which is the rule the whole toy rests on.
   *
   *  It stops on the first failure rather than trying the next source, and that
   *  is deliberate: the overwhelming cause of a failure here is *no network*,
   *  and a loop that reacted by trying eleven more times would spend twenty
   *  seconds apiece finding out the same thing. */
  async topUp(want = CACHE_WANT): Promise<number> {
    if (this.#filling) return 0;
    /* `navigator.onLine` is a weak signal — it answers true behind a captive
       portal — but it is free, and the one thing it is reliable about is the
       case this check is for, which is a laptop with the lid shut on a train. */
    if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
    this.#filling = true;
    let got = 0;
    try {
      await this.refresh();
      const seen = new Set(this.have.map((c) => c.id));
      let guard = 0;
      while (this.have.length + got < want && guard++ < want * 2) {
        const plan = wanted(this.sources, this.terms, Math.random());
        if (!plan) break;
        const found: Reference | null = await plan.source.find(
          (url) => invoke<string>("sketch_json", { url }),
          Math.random(),
          plan.term,
        );
        if (!found) continue;
        /* A reference already on disk is the common answer, not a failure: a
           source with thirty usable works and twelve already taken will offer
           one of those two times in five. */
        if (seen.has(found.id)) continue;
        seen.add(found.id);
        const cached = await invoke<Cached>("sketch_cache", {
          url: found.url,
          id: found.id,
          title: found.title,
          artist: found.artist,
          credit: found.credit,
          source: found.source,
        });
        this.have = [...this.have, cached];
        got++;
      }
      this.fault = null;
    } catch (err) {
      this.fault = String(err);
    } finally {
      this.#filling = false;
    }
    return got;
  }

  /** Take a copy of everything in your own folder, so it can be drawn
   *  alongside the rest. One gesture, not a watch: a folder Volery kept in step
   *  would be a folder Volery could delete out of. */
  async adoptFolder(): Promise<number> {
    if (!this.folder) return 0;
    let got = 0;
    try {
      const files = await invoke<string[]>("sketch_folder", { path: this.folder });
      const seen = new Set(this.have.map((c) => c.id));
      for (const [i, src] of files.entries()) {
        const id = `folder-${i}-${src.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? i}`;
        if (seen.has(id)) continue;
        const cached = await invoke<Cached>("sketch_adopt", {
          src,
          id,
          credit: `${src.split(/[\\/]/).pop() ?? "reference"} · yours`,
        });
        this.have = [...this.have, cached];
        got++;
      }
      this.fault = null;
    } catch (err) {
      this.fault = String(err);
    }
    return got;
  }

  setSources(on: SourceId[]) {
    this.sources = on;
    write(SOURCES_KEY, on);
  }

  toggleSource(id: SourceId) {
    this.setSources(
      this.sources.includes(id)
        ? this.sources.filter((s) => s !== id)
        : [...this.sources, id],
    );
  }

  /** One per line, which is how a list of search terms is actually edited. */
  setTerms(text: string) {
    const list = text
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    this.terms = list;
    write(TERMS_KEY, list);
  }

  get termText(): string {
    return (this.terms.length ? this.terms : DEFAULT_TERMS).join("\n");
  }

  /** Whether the box is showing your list or the default one, so the settings
   *  can say which — a box full of terms you did not write looks exactly like a
   *  box full of terms you did. */
  get usingDefaults(): boolean {
    return this.terms.length === 0;
  }

  setFolder(path: string | null) {
    this.folder = path;
    write(FOLDER_KEY, path);
  }
}
