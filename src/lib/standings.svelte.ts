/* The wall's copy of the models reading.
 *
 * `benchmarks.rs` owns the cache, the fetch and the arithmetic; `benchmarks.ts`
 * owns the definitions. This is the one connection between them and the
 * surfaces that draw them — the models tab in the accounts panel and the line
 * beside a model in a spawn menu — on the `ledger.svelte.ts` pattern: named for
 * the subsystem rather than for the component it serves, because
 * `models.svelte.ts` beside `Models.svelte` is the trap `accounts.md`
 * records for `accounts.svelte.ts` (a case-insensitive disk and a component
 * called `Accounts.svelte`).
 *
 * **Two events refresh, and neither is a clock.** The panel opening asks for a
 * view, and Rust fetches first when the cache is past its day floor; the manual
 * refresh asks for a fetch whatever the floor says. A menu opening reads what
 * the store already has and never fetches — a model menu that spent a request
 * per open would make choosing expensive in a way nobody asked for.
 */

import { invoke } from "@tauri-apps/api/core";
import { presetById, presetPicks } from "./presets";
import {
  aliasOf,
  profileFor,
  sayAsOf,
  standingLine,
  type Entry,
  type Profile,
  type Ranked,
  type SourceId,
  type SourceState,
} from "./benchmarks";

export type Catalogue = {
  sources: SourceState[];
  benchmarks: { key: string; name: string; category: string; unit: string; source: SourceId }[];
  models: {
    source: SourceId;
    key: string;
    name: string;
    creator: string;
    contextWindow: number | null;
    release: string | null;
    vision: boolean | null;
    toolUse: boolean | null;
  }[];
  readings: {
    source: SourceId;
    model: string;
    benchmark: string;
    score: number | null;
    unit: string;
    effort: string;
    harness: string | null;
    published: string | null;
    vendor: boolean;
  }[];
};

/** The basis every blended price is made of, said once on a menu's foot rather
 *  than on each row. Kept in step by nothing but its own spelling — it is prose
 *  rather than arithmetic, and `benchmarks.rs::PRICE_BASIS` is the number. */
const PRICE_BASIS = "blended 3:1 per 1M";

class ModelStandings {
  /** Which workflow the panel is showing. Null means "the one that fits": the
   *  coding agent here, since the panel is opened to choose a card. */
  profileId = $state<string | null>(null);
  view = $state<Ranked | null>(null);
  /** What the panel's catalogue tab last read, per view. Kept simple: one
   *  filtered reading at a time, which is what a tab draws. */
  catalogue = $state<Catalogue | null>(null);
  loading = $state(false);
  refreshing = $state(false);
  error = $state<string | null>(null);
  /** When the panel or a menu last asked, so the panel can say *asking…*
   *  rather than *no source is on* for the beat before the answer. */
  asked = $state(false);

  get sources(): SourceState[] {
    return this.view?.sources ?? [];
  }

  get profile(): Profile {
    return this.view?.profile ?? profileFor("project");
  }

  get rows(): Entry[] {
    return this.view?.rows ?? [];
  }

  get asOf(): string | null {
    return this.view?.asOf ?? null;
  }

  /** The panel opening. One call; Rust decides whether the cache is stale. */
  async load(profile?: string | null): Promise<void> {
    if (profile !== undefined) this.profileId = profile;
    this.loading = true;
    this.asked = true;
    this.error = null;
    try {
      this.view = await invoke<Ranked>("models_view", { profile: this.profileId });
    } catch (err) {
      this.error = String(err);
    } finally {
      this.loading = false;
    }
  }

  /** The manual refresh: a fetch whatever the floor says, then the view. */
  async refresh(): Promise<void> {
    this.refreshing = true;
    this.error = null;
    try {
      await invoke("models_refresh", {});
      await this.load();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.refreshing = false;
    }
  }

  /** The catalogue tab: one benchmark's readings, or one model's. */
  async readCatalogue(benchmark?: string | null, model?: string | null): Promise<void> {
    try {
      this.catalogue = await invoke<Catalogue>("models_catalogue", {
        benchmark: benchmark ?? null,
        model: model ?? null,
      });
    } catch (err) {
      this.error = String(err);
    }
  }

  /** One entry by model key, for a menu drawing a line beside a model. */
  entryFor(modelKey: string | null | undefined): Entry | null {
    if (!modelKey) return null;
    const bare = modelKey.replace(/\[.*\]$/, "");
    return this.rows.find((r) => r.key === bare || r.name.toLowerCase() === bare.toLowerCase()) ?? null;
  }

  /** The wall's name for a model, resolved to the version a reading is about. */
  entryForAlias(alias: string | null | undefined): Entry | null {
    return this.entryFor(aliasOf(alias)?.model ?? null);
  }

  /** The `+`'s preset rows with the measurement on each: the same shape
   *  `presetPicks` builds, plus a standing line wherever there is a view. It is
   *  the store that appends rather than `presets.ts`, because that file is pure
   *  and a menu is not where a fetch belongs. */
  picks(): { id: string; label: string; note: string; standing?: string }[] {
    return presetPicks().map((p) => {
      if (!this.view) return p;
      const entry = this.entryForAlias(presetById(p.id)?.model ?? null);
      return { ...p, standing: standingLine(entry, this.profile) };
    });
  }

  /** The menu's foot: which profile those standings are on, the price basis,
   *  and how old the reading is. Null when nothing has been read, so a menu
   *  with no data says nothing rather than naming a profile it has not read. */
  foot(): string | undefined {
    if (!this.view) return undefined;
    return `${this.profile.label} profile · ${PRICE_BASIS} · ${sayAsOf(this.sources)}`;
  }

  /** Asked once at launch so the first right-click is not a menu with no
   *  standing lines on it. Not a poller: `load` answers from the cache inside
   *  the day floor, and the fetch happens at most once a day whichever surface
   *  asks first. */
  ensure(): void {
    if (!this.view && !this.loading) void this.load(profileFor("project").id);
  }
}

export const standings = new ModelStandings();
