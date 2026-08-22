/* The ambience profiles, as the studio holds them.
 *
 * The vocabulary and every rule about it are pure and live in `./ambience.ts`;
 * this is the part with runes and a database behind it. The split is the same one
 * `layout.ts` and `studio.svelte.ts` have.
 *
 * Everything here writes as you move, debounced — there is no apply button, and
 * there should not be one. The whole argument for editing a backdrop live is
 * that you are looking at the thing you are adjusting, so a gesture that ends in
 * "now press this" has already lost.
 *
 * Which profile is showing lives in SQLite beside the profiles rather than in
 * localStorage. Unlike the viewport, it is a thing you *made* — see the note in
 * studio.svelte.ts about not having two sources of truth for the same fact. */

import { invoke } from "@tauri-apps/api/core";
import {
  clamp,
  defaultLayer,
  normalizeProfile,
  shippedProfiles,
  specFor,
  uid,
  type EffectKind,
  type Layer,
  type Profile,
} from "./ambience";

export * from "./ambience";

/** A row, as Rust hands it over: the layers are opaque JSON on that side. */
type Row = { id: string; name: string; layers: unknown; active: boolean };

export class Ambience {
  profiles = $state<Profile[]>([]);
  activeId = $state<string | null>(null);
  fault = $state<string | null>(null);

  /** Which layer has its knobs open in the panel. One at a time: a stack of
   *  four effects with ten sliders each is a wall of controls nobody reads. */
  open = $state<string | null>(null);

  loaded = $state(false);

  active = $derived(this.profiles.find((p) => p.id === this.activeId) ?? null);

  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async load() {
    try {
      const rows = await invoke<Row[]>("list_ambience");
      if (rows.length === 0) {
        /* First run. The shipped profiles are written as ordinary rows rather
           than kept as a special case anywhere, so the first thing you can do
           with one is change it. */
        const seeded = shippedProfiles();
        for (const p of seeded) await this.#write(p);
        this.profiles = seeded;
        await this.use(seeded[0].id);
      } else {
        this.profiles = rows.map((r) =>
          normalizeProfile({ id: r.id, name: r.name, layers: r.layers }),
        );
        this.activeId = rows.find((r) => r.active)?.id ?? null;
      }
    } catch (err) {
      this.fault = String(err);
    } finally {
      this.loaded = true;
    }
  }

  /** Show a profile, or nothing at all — a bare wall is a real choice. */
  async use(id: string | null) {
    this.activeId = id;
    this.open = null;
    try {
      await invoke("activate_ambience", { id });
    } catch (err) {
      this.fault = String(err);
    }
  }

  async create(name = "new profile"): Promise<Profile> {
    const p: Profile = { id: uid(), name, layers: [] };
    this.profiles = [...this.profiles, p];
    await this.#write(p);
    await this.use(p.id);
    return p;
  }

  /** A copy to take somewhere else, which is how most profiles get made: you
   *  like what is up there and want to try something without losing it. */
  async duplicate(id: string): Promise<Profile | null> {
    const from = this.profiles.find((p) => p.id === id);
    if (!from) return null;
    const p: Profile = {
      id: uid(),
      name: `${from.name} copy`,
      /* Fresh layer ids: they key the renderer's live state, and two layers
         sharing one would share a flock of leaves between profiles. */
      layers: from.layers.map((l) => ({ ...l, id: uid(), params: { ...l.params } })),
    };
    this.profiles = [...this.profiles, p];
    await this.#write(p);
    await this.use(p.id);
    return p;
  }

  /** A profile out of a carried layout — see `portage.ts`.
   *
   *  Through `normalizeProfile`, which is the same normalizer `load` runs on a
   *  row read back: this is data that outlives the build that wrote it and may
   *  well have been hand-edited, and a layer parameter that arrived as a string
   *  must degrade rather than reach a frame loop.
   *
   *  Fresh layer ids for the reason `duplicate` has them — they key the
   *  renderer's live state, and two layers sharing one would share a flock of
   *  leaves between profiles.
   *
   *  Deliberately does not `use` it. Whether an imported wall's ambience becomes
   *  the one showing is the importer's decision to make once, not a side effect
   *  of each profile arriving — a document carrying four of them would otherwise
   *  end on whichever happened to be written last. */
  async adopt(name: string, layers: unknown): Promise<Profile> {
    const clean = normalizeProfile({ id: uid(), name, layers });
    const p: Profile = {
      ...clean,
      layers: clean.layers.map((l) => ({ ...l, id: uid(), params: { ...l.params } })),
    };
    this.profiles = [...this.profiles, p];
    await this.#write(p);
    return p;
  }

  rename(id: string, name: string) {
    this.#patch(id, (p) => ({ ...p, name }));
  }

  async destroy(id: string) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    /* Drop a queued save first or it lands after the delete and puts the row
       straight back — the same trap `Board.remove` fell into. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);
    try {
      await invoke("delete_ambience", { id });
    } catch (err) {
      this.fault = String(err);
    }
    if (this.activeId === id) await this.use(this.profiles[0]?.id ?? null);
  }

  /* ── the stack ─────────────────────────────────────────────────────────
   *
   * All of these act on whichever profile is showing, because that is the only
   * one you can see. Editing one that is not up would be adjusting something
   * blind, which is the thing this panel exists to avoid. */

  addLayer(kind: EffectKind) {
    const l = defaultLayer(kind);
    this.#patchActive((p) => ({ ...p, layers: [...p.layers, l] }));
    this.open = l.id;
  }

  removeLayer(layerId: string) {
    this.#patchActive((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) }));
    if (this.open === layerId) this.open = null;
  }

  setLayer(layerId: string, patch: Partial<Pick<Layer, "on" | "opacity">>) {
    this.#patchLayer(layerId, (l) => ({ ...l, ...patch }));
  }

  /** One knob. Clamped here as well as on read, so a value out of range never
   *  reaches the canvas even before it has been round-tripped. */
  setParam(layerId: string, key: string, value: number) {
    this.#patchLayer(layerId, (l) => {
      const q = specFor(l.kind)?.params.find((s) => s.key === key);
      if (!q || !Number.isFinite(value)) return l;
      return { ...l, params: { ...l.params, [key]: clamp(value, q.min, q.max) } };
    });
  }

  /** Move a layer through the stack. Order is paint order — first is furthest
   *  back — so this is what puts the leaves in front of the swirls. */
  moveLayer(layerId: string, delta: number) {
    this.#patchActive((p) => {
      const at = p.layers.findIndex((l) => l.id === layerId);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= p.layers.length) return p;
      const layers = [...p.layers];
      const [l] = layers.splice(at, 1);
      layers.splice(to, 0, l);
      return { ...p, layers };
    });
  }

  /** Everything a layer's knob can be reset to. Ten sliders is easy to get lost
   *  in, and a way back is cheaper than undo. */
  resetLayer(layerId: string) {
    this.#patchLayer(layerId, (l) => ({ ...l, params: defaultLayer(l.kind, l.id).params }));
  }

  /* ── writing ───────────────────────────────────────────────────────── */

  #patchActive(fn: (p: Profile) => Profile) {
    const id = this.activeId;
    if (id) this.#patch(id, fn);
  }

  #patchLayer(layerId: string, fn: (l: Layer) => Layer) {
    this.#patchActive((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === layerId ? fn(l) : l)),
    }));
  }

  #patch(id: string, fn: (p: Profile) => Profile) {
    const at = this.profiles.findIndex((p) => p.id === id);
    if (at < 0) return;
    const next = fn(this.profiles[at]);
    this.profiles[at] = next;
    this.#saveSoon(next);
  }

  /** Dragging a slider fires this every frame; the database only wants where it
   *  came to rest. Keyed per profile, as the board's saves are per image. */
  #saveSoon(p: Profile) {
    clearTimeout(this.#saveTimers.get(p.id));
    this.#saveTimers.set(
      p.id,
      setTimeout(() => void this.#write(p).catch(() => {}), 250),
    );
  }

  async #write(p: Profile) {
    /* `active` is not this call's business — `activate_ambience` owns it, and a
       save must never be able to switch what the wall is showing. */
    await invoke("save_ambience", {
      profile: {
        id: p.id,
        name: p.name,
        layers: $state.snapshot(p.layers),
        active: false,
      },
    });
  }
}
