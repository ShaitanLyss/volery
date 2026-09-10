/* The machinery behind a ring of themes, with the knobs left as a parameter.
 *
 * There are two rings on this wall and they answer different questions —
 * `theme.ts` is *how the reading is set* and `palette.ts` is *what the wall is
 * made of* — but everything below the catalogue itself is the same code twice:
 * normalizing a store somebody typed into, walking a `from` chain, resolving
 * it root-first, deriving a child, cycling the ring, carrying the lot off the
 * machine as text. That half was written once for the reading theme and is
 * lifted here rather than copied, for the same reason `prose` stopped
 * repeating `readable`'s six knobs and said `from: "readable"` instead: the
 * duplicate needed a test to hold the two halves in step, and the test was
 * cheaper to delete than to keep honest.
 *
 * What stays in each catalogue is what is genuinely about *that* ring — its
 * knobs, the words for them, its built-ins and the arguments for them. What is
 * here is what neither ring can have an opinion about.
 *
 * `makeCatalogue` binds the knob list, the built-ins and the name of the
 * theme-that-changes-nothing into one closure and hands back the functions
 * with the signatures they always had, so `theme.ts` re-exports them under
 * their historical names and nothing above it moved.
 *
 * Pure, and tested through both of its instances — `test/theme.test.ts` and
 * `test/palette.test.ts`.
 */

/** The longest a knob's value may be. Not a security boundary — CSS custom
 *  properties are substituted after the stylesheet is parsed, so a value
 *  containing `;` or `}` cannot close a declaration and open another; the worst
 *  it can do is make its own declaration invalid at computed-value time. This
 *  is a sanity bound, so a corrupt store cannot write a megabyte onto the root
 *  element's inline style on every switch. */
const MAX_VALUE = 200;

/** How deep a `from` chain may go before it is treated as malformed.
 *
 *  `chainOf` already refuses to revisit a theme, so a cycle terminates on its
 *  own and this is not what stops one. It is a bound on how much work a
 *  hand-written store can ask for on every switch, and a limit worth having
 *  because nothing in either UI encourages a chain this long — a theme eight
 *  removed from its base is not derived from anything anybody can picture. */
export const MAX_CHAIN = 8;

export const EXPORT_VERSION = 1;

/** Whether a value is worth writing. Rejects the empty, the enormous, and
 *  anything carrying a control character — none of which any real declaration
 *  needs, and all of which make a computed style unreadable when you are
 *  trying to work out why a theme looks wrong. */
export function okValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > MAX_VALUE) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(s);
}

/** A stored id, reduced to the shape ids are allowed to have.
 *
 *  Lowercase, alphanumeric and dashes. Not for safety — ids never reach a
 *  selector or a query — but because an id is what the export carries between
 *  machines and what a person types into a control op, and one with a space or
 *  a quote in it is a thing you get wrong once and cannot see. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** How a new theme relates to the one it came from.
 *
 *  Both were asked for and they are genuinely different things, which is why
 *  this is a word and not a boolean:
 *
 *  - `"extend"` keeps the link. The new theme holds only what you changed, and
 *    editing the base later moves the child with it. This is the one to want
 *    when the base is a theme you also use — `prose` is `readable` plus two
 *    decisions, and it should stay that way when `readable` is retuned.
 *  - `"copy"` cuts it. The base's resolved values are inlined and `from` is
 *    null, so the new theme is a standalone snapshot that nothing can move
 *    under you. This is the one to want when you are taking a built-in as a
 *    starting point and going your own way.
 *
 *  The failure each avoids is the other's behaviour arriving unasked: an
 *  extend you thought was a copy changes under you, and a copy you thought was
 *  an extend quietly stops tracking a base you are still editing. */
export type Derivation = "extend" | "copy";

export type Overrides<K extends string> = Partial<Record<K, string>>;

export type Entry<K extends string> = {
  id: string;
  /** What the chip says when you switch to it. Lowercase, like the rest. */
  label: string;
  /** One line on what it is for — the tooltip, and the argument for keeping it. */
  note: string;
  /** The theme this one is layered over, or null for one that stands alone.
   *
   *  This is the whole of "derived": resolution walks the chain root-first and
   *  a child's knobs win. A `from` naming a theme that no longer exists is not
   *  an error — see `chainOf`. */
  from: string | null;
  over: Overrides<K>;
  /** True for the ones that ship. Built-ins are never written to storage and
   *  cannot be edited in place; you derive from one instead, which is what
   *  keeps "as it always was" able to mean it. */
  builtin?: boolean;
};

export type Spec<K extends string> = {
  /** Every property a theme on this ring is allowed to set.
   *
   *  A closed list, and `resolve` filters against it, for the reason the rest
   *  of the front end normalizes anything opaque it reads back: this is data
   *  that outlives the build that wrote it, and once custom themes exist it is
   *  data a person typed. A name from an older version, a knob since renamed,
   *  a typo — all of them arrive as a string that is nobody's property, and
   *  the answer is to drop it rather than to write it onto the root element
   *  where it will sit forever doing nothing and confusing the next person to
   *  read the computed style. */
  knobs: readonly K[];
  builtins: Entry<K>[];
  /** The id of the theme that changes nothing, and the one a bad name degrades
   *  to. It must be `builtins[0]`, so the way back is always one known place
   *  at the head of the ring. */
  rest: string;
  /** The wrapper key this ring's export writes, and the only one its import
   *  will accept from a wrapped document.
   *
   *  Two rings mean two export formats that look alike, and a skin pasted into
   *  the reading ring would otherwise arrive as a theme whose every knob was
   *  filtered out — present in the list, selectable, and changing nothing,
   *  which is the most confusing thing a paste can do. Naming the ring in the
   *  wrapper lets the import say "nothing in that" instead. */
  exportKey: string;
};

export type Catalogue<K extends string> = ReturnType<typeof makeCatalogue<K>>;

/** What a holder looks like from the panel, with the knobs widened to strings.
 *
 *  `Ink` and `Skins` are two classes over two disjoint knob sets, and
 *  `Themes.svelte` draws either one — a tab, rather than a second panel, since
 *  the two rings are siblings and comparing along one while the other holds
 *  still is the whole reason they are separate. A component cannot hold a
 *  value whose type depends on which tab is showing, so the seam widens here:
 *  every knob becomes a `string`, which is what the DOM was going to make of
 *  it anyway, and `withKnob` filters against the real list on the way back in.
 *
 *  Structural, and deliberately not `implements`-ed by either class — the two
 *  holders are written to their own catalogues and satisfying this is a
 *  consequence rather than an obligation. `test/palette.test.ts` asserts the
 *  member names line up, since a rename on one side is exactly the kind of
 *  drift nothing else here can see. */
export type Ring = {
  id: string;
  customs: { id: string; label: string }[];
  readonly all: Entry<string>[];
  /** The entry currently on. Named `theme` on both rings rather than `theme`
   *  and `skin`, because the panel has to ask one question of either. */
  readonly theme: Entry<string>;
  readonly over: Record<string, string | undefined>;
  set(id: string): void;
  cycle(dir?: number): void;
  create(label: string, how: Derivation, baseId?: string): string;
  tweak(knob: string, value: string | null): void;
  rename(id: string, label: string, note?: string): void;
  children(id: string): Entry<string>[];
  remove(id: string): void;
  text(): string;
  paste(text: string): number;
};

export function makeCatalogue<K extends string>(spec: Spec<K>) {
  const { knobs, builtins, rest, exportKey } = spec;
  const knobSet: ReadonlySet<string> = new Set<string>(knobs);
  const builtinIds: ReadonlySet<string> = new Set(builtins.map((t) => t.id));

  function isKnob(name: string): name is K {
    return knobSet.has(name);
  }

  /** An override map with everything that is not a knob, or not a usable
   *  value, dropped. */
  function cleanOverrides(raw: unknown): Overrides<K> {
    const out: Overrides<K> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isKnob(k) && okValue(v)) out[k] = v.trim();
    }
    return out;
  }

  /** A free id for a new theme, given what is already taken. Built-ins always
   *  count as taken — a custom theme called `paper` would shadow the one name
   *  that has to keep meaning "untouched". */
  function freeId(want: string, taken: Iterable<string>): string {
    const used = new Set<string>([...builtinIds, ...taken]);
    const base = slugify(want) || "theme";
    if (!used.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const tryId = `${base}-${n}`;
      if (!used.has(tryId)) return tryId;
    }
    return `${base}-${used.size + 1}`;
  }

  /** One stored theme, normalized, or null if there is nothing usable in it.
   *
   *  Null rather than a repaired stub for the one case that matters: an entry
   *  with no id is not a theme somebody wrote and lost the name of, it is a
   *  fragment, and inventing a name for it puts an entry in the list that
   *  nobody can account for. Everything else degrades — a missing label
   *  becomes the id, a `from` that is not a string becomes null. */
  function cleanEntry(raw: unknown): Entry<K> | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? slugify(r.id) : "";
    /* A stored theme may not claim a built-in's name: `at` looks built-ins up
       first, so such an entry would be invisible and uneditable — present in
       the store, absent from the wall, and impossible to explain. */
    if (!id || builtinIds.has(id)) return null;
    const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 60) : id;
    const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
    const from = typeof r.from === "string" && r.from.trim() ? slugify(r.from) : null;
    return { id, label, note, from: from === id ? null : from, over: cleanOverrides(r.over) };
  }

  /** Every custom theme in a stored blob, normalized, with duplicates by id
   *  resolved last-wins and anything unusable dropped. */
  function cleanEntries(raw: unknown): Entry<K>[] {
    const list = Array.isArray(raw) ? raw : [];
    const byId = new Map<string, Entry<K>>();
    for (const entry of list) {
      const t = cleanEntry(entry);
      if (t) byId.set(t.id, t);
    }
    return [...byId.values()];
  }

  /* ── looking one up ──────────────────────────────────────────────────── */

  /** Built-ins first, then customs. The order is the order they cycle in, and
   *  it puts the theme that changes nothing at the head so the way back is
   *  always one known place. */
  function all(customs: Entry<K>[] = []): Entry<K>[] {
    return [...builtins, ...customs];
  }

  /** The theme a name means, or null. Unlike `at` this does not substitute a
   *  default, which is what lets `idFor` tell "no such theme" from "the theme
   *  that changes nothing". */
  function find(id: string | null | undefined, customs: Entry<K>[] = []): Entry<K> | null {
    if (typeof id !== "string") return null;
    return all(customs).find((t) => t.id === id) ?? null;
  }

  /** The name a stored choice means, degraded to `rest` if it means nothing.
   *
   *  A theme that was deleted, or renamed between builds, must cost a session
   *  its look and not its start-up. */
  function idFor(id: string | null | undefined, customs: Entry<K>[] = []): string {
    return find(id, customs) ? (id as string) : rest;
  }

  /** The theme itself, never null — `idFor` has already had its say. */
  function at(id: string | null | undefined, customs: Entry<K>[] = []): Entry<K> {
    return find(id, customs) ?? builtins[0];
  }

  /** The chain a theme resolves through, root first, ending with the theme
   *  itself.
   *
   *  Exported because it is the honest answer to "where did this value come
   *  from", which is the first thing anybody asks of a derived theme that is
   *  not drawing what they expected — and because it is the clearest thing to
   *  test.
   *
   *  Two ways it stops early, and they are different failures. A `from` naming
   *  nothing is a **broken link** — the base was deleted out from under a child
   *  — and the child still resolves, using its own overrides alone, because a
   *  theme you can no longer select is worse than one that lost a layer. A
   *  `from` that revisits a theme already in the chain is a **cycle**, and it
   *  stops at the revisit for the obvious reason. Neither throws: this runs on
   *  every switch and on start-up, and a store that has gone strange must not
   *  be able to stop the app drawing. */
  function chainOf(id: string | null | undefined, customs: Entry<K>[] = []): Entry<K>[] {
    const chain: Entry<K>[] = [];
    const seen = new Set<string>();
    let node = find(id, customs);
    while (node && !seen.has(node.id) && chain.length < MAX_CHAIN) {
      seen.add(node.id);
      chain.push(node);
      node = node.from ? find(node.from, customs) : null;
    }
    return chain.reverse();
  }

  /** What to write onto the root for a theme: the whole chain merged
   *  root-first, so a child's knobs win over the base's, with anything that is
   *  not a knob already dropped. */
  function resolve(id: string | null | undefined, customs: Entry<K>[] = []): Overrides<K> {
    const out: Overrides<K> = {};
    for (const t of chainOf(id, customs)) {
      for (const k of knobs) {
        const v = t.over[k];
        if (okValue(v)) out[k] = v.trim();
      }
    }
    return out;
  }

  /* ── making one ──────────────────────────────────────────────────────── */

  /** A new theme from an existing one. Pure — the caller stores it.
   *
   *  The base is resolved through its own chain first, so copying a theme that
   *  was itself derived gives you everything it draws with rather than only
   *  the layer it happened to add. */
  function derive(
    baseId: string | null | undefined,
    opts: { label: string; how: Derivation; customs?: Entry<K>[]; note?: string },
  ): Entry<K> {
    const customs = opts.customs ?? [];
    const base = at(baseId, customs);
    const id = freeId(
      opts.label,
      customs.map((t) => t.id),
    );
    const extending = opts.how === "extend";
    return {
      id,
      label: opts.label.trim().slice(0, 60) || id,
      note: (opts.note ?? (extending ? `extends ${base.label}` : `from ${base.label}`)).slice(
        0,
        200,
      ),
      from: extending ? base.id : null,
      over: extending ? {} : resolve(base.id, customs),
    };
  }

  /** A theme with one knob set, or cleared when `value` is null. Pure, and
   *  returns a new object rather than mutating — the holder swaps the entry.
   *
   *  Clearing matters as much as setting on a derived theme, and means
   *  something different there: a knob removed from an extending child falls
   *  back to the base's value, not to `tokens.css`. That is the point of
   *  extending, and it is why this is a delete rather than a write of the
   *  default. */
  function withKnob(theme: Entry<K>, knob: string, value: string | null): Entry<K> {
    if (!isKnob(knob)) return theme;
    const over = { ...theme.over };
    if (value === null) delete over[knob];
    else if (okValue(value)) over[knob] = value.trim();
    else return theme;
    return { ...theme, over };
  }

  /** The next theme round the ring.
   *
   *  A cycle rather than a picker because the whole point of this is
   *  comparison: a picker costs two gestures per look and puts a menu over the
   *  thing you are trying to see. Wraps both ways, and an unknown current name
   *  enters the ring at `rest` rather than throwing. */
  function next(id: string | null | undefined, customs: Entry<K>[] = [], dir: number = 1): string {
    const ring = all(customs);
    const i = ring.findIndex((t) => t.id === idFor(id, customs));
    const step = dir < 0 ? -1 : 1;
    return ring[(i + step + ring.length) % ring.length].id;
  }

  /** Themes that would break if this one went — the children pointing at it.
   *
   *  Asked before a delete so the answer can be said out loud rather than
   *  discovered: `resolve` degrades a broken link to "no base", which is the
   *  right behaviour and a bad surprise. Direct children only; a grandchild is
   *  reached through a child that is itself still fine. */
  function dependents(id: string, customs: Entry<K>[] = []): Entry<K>[] {
    return customs.filter((t) => t.from === id);
  }

  /* ── carrying one between machines ─────────────────────────────────────
   *
   * Custom themes live in localStorage, which is the wrong home for a thing
   * you made — the rest of the app puts what you authored in SQLite and keeps
   * localStorage for what is per-machine and disposable. It is there because
   * this machine has no MSVC toolchain, so a schema rung and the commands to
   * reach it could be written but not compiled or tested, and untested Rust in
   * a tree somebody else is working in is a worse trade than a storage seam
   * that has to move later. Each holder keeps that seam to one pair of
   * functions. These three are the mitigation in the meantime: your themes can
   * leave the machine as text, which is what makes the wrong home
   * survivable. */

  function exportText(customs: Entry<K>[]): string {
    return JSON.stringify({ [exportKey]: EXPORT_VERSION, themes: customs }, null, 2);
  }

  /** Themes out of exported text, normalized like anything else read back.
   *
   *  Accepts the wrapper `exportText` writes, a bare array, or a single theme
   *  object, because all three are things a person plausibly pastes and
   *  refusing two of them teaches nothing. Returns an empty list rather than
   *  throwing on text that is not JSON at all — the caller reports "nothing in
   *  that", which is the same message a valid document with no themes in it
   *  deserves.
   *
   *  A wrapper naming the *other* ring is refused outright rather than run
   *  through the knob filter, which would otherwise turn a pasted skin into a
   *  reading theme that changes nothing: selectable, present in the list, and
   *  with no way to tell from the panel why it does nothing at all. */
  function importText(text: string): Entry<K>[] {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (Array.isArray(r.themes)) return r[exportKey] === undefined ? [] : cleanEntries(r.themes);
      return cleanEntries([raw]);
    }
    return cleanEntries(raw);
  }

  /** Merge imported themes into the ones already here, renaming rather than
   *  overwriting on a collision.
   *
   *  Overwriting is the wrong default for an import: the themes already on
   *  this machine are the ones you have been using, and the paste is the
   *  guess. A rename costs a moment's confusion; an overwrite costs work with
   *  no way back. The rename is `freeId`, so `dusk` arriving twice becomes
   *  `dusk-2`.
   *
   *  A `from` pointing inside the incoming set is rewritten to follow the
   *  rename, or a derived theme would silently re-base onto whatever happened
   *  to already hold that name here. One pointing outside it is left alone and
   *  may well be broken, which `resolve` degrades and `chainOf` shows. */
  function merge(existing: Entry<K>[], incoming: Entry<K>[]): Entry<K>[] {
    const out = [...existing];
    const taken = new Set(out.map((t) => t.id));
    const renamed = new Map<string, string>();
    for (const t of incoming) {
      const id = freeId(t.id, taken);
      taken.add(id);
      if (id !== t.id) renamed.set(t.id, id);
      out.push({ ...t, id });
    }
    return out.map((t) => (t.from && renamed.has(t.from) ? { ...t, from: renamed.get(t.from)! } : t));
  }

  return {
    knobs,
    builtins,
    builtinIds,
    rest,
    isKnob,
    cleanOverrides,
    cleanEntry,
    cleanEntries,
    freeId,
    all,
    find,
    idFor,
    at,
    chainOf,
    resolve,
    derive,
    withKnob,
    next,
    dependents,
    exportText,
    importText,
    merge,
  };
}
