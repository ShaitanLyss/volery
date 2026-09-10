/* Which skin the wall is wearing, and the writing of it onto the root element.
 *
 * The second of the two theme holders and deliberately the same shape as
 * `theme.svelte.ts`'s `Ink`, down to the storage seam: `readCustoms` and
 * `writeCustoms` are the only two functions here that know where an authored
 * skin lives, localStorage is the wrong home for a thing you made, and it is
 * there because this machine cannot build the Rust half to test a schema rung.
 * When that changes, those two become invokes and nothing else moves. The
 * argument in full is in `theme.svelte.ts` and is not repeated.
 *
 * Two holders rather than one because the two rings are orthogonal — see the
 * head of `palette.ts`. What that costs is this file; what it buys is that
 * choosing `sugar` does not throw away the reading you had set, and that
 * `theme.ts`'s promise about colour stays true of `theme.ts`.
 *
 * The two `paint`s write disjoint property sets, so neither can disturb the
 * other and the order they run in does not matter. `test/palette.test.ts`
 * asserts the disjointness, because it is the one thing that would make that
 * sentence false and nothing in either file can see the other.
 */

import {
  SKIN_KNOBS,
  STUDIO,
  resolveSkin,
  nextSkin,
  skinAt,
  skinFor,
  cleanSkins,
  allSkins,
  deriveSkin,
  withSkinKnob,
  skinDependents,
  exportSkins,
  importSkins,
  mergeSkins,
  type Skin,
  type SkinOverrides,
  type Derivation,
} from "./palette";

export * from "./palette";

const SKIN_KEY = "skein.skin.v1";
const CUSTOM_KEY = "skein.skins.v1";

/* ── the seam ──────────────────────────────────────────────────────────── */

function readCustoms(): Skin[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? cleanSkins(JSON.parse(raw)) : [];
  } catch {
    /* Unparseable, or storage refused outright. Both mean the same thing here
       and neither is worth a start-up failure: the wall comes up on the
       built-ins, which is the app as it shipped. */
    return [];
  }
}

function writeCustoms(list: Skin[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* Quota, or a browser refusing storage. The skins stand for this session. */
  }
}

/* ── applying ──────────────────────────────────────────────────────────── */

/** Write a skin's override map onto the root element.
 *
 *  Every knob is visited, not only the ones this skin names: a knob the
 *  incoming skin is silent about is *removed*, so the cascade resolves it
 *  against `tokens.css` again. The full argument is in `theme.svelte.ts` — it
 *  is what makes reverting to `studio` exact rather than approximate, and it
 *  is the reason a light skin followed by a dark one cannot leave a stray
 *  cream `--edge` behind on a violet wall. */
function paint(over: SkinOverrides) {
  const root = document.documentElement;
  for (const k of SKIN_KNOBS) {
    const v = over[k];
    if (v === undefined) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
}

/** The wall's skin, and the ones you wrote.
 *
 *  A module singleton for `Ink`'s two reasons: it has to be applied before the
 *  first paint or the app shows the base ground and re-skins itself a frame
 *  later — which on a light skin is a full-window flash of near-black on every
 *  launch, considerably worse than the one `Ink` was avoiding — and the peek
 *  is a second window with its own document, so a holder owned by `App.svelte`
 *  would leave the notification surface permanently unskinned.
 *
 *  It holds no subscription and no timer, which is what keeps it out of
 *  `Listeners`. If anything is ever added to it that listens, that stops being
 *  true. */
class Skins {
  customs = $state<Skin[]>([]);
  id = $state(STUDIO);

  constructor() {
    this.customs = readCustoms();
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SKIN_KEY);
    } catch {
      /* a browser refusing storage is not a reason to start unskinned */
    }
    this.id = skinFor(stored, this.customs);
    paint(resolveSkin(this.id, this.customs));
  }

  /** The ring, in the order it cycles: built-ins first, then yours. */
  get all(): Skin[] {
    return allSkins(this.customs);
  }

  /** The skin currently on.
   *
   *  Named `theme` and not `skin` so this class and `Ink` answer the same
   *  question by the same name — `Themes.svelte` draws either ring off one
   *  `Ring` handle and cannot ask a different question per tab. `skin` below
   *  is the alias for reading at a call site where the word matters. */
  get theme(): Skin {
    return skinAt(this.id, this.customs);
  }

  get skin(): Skin {
    return this.theme;
  }

  /** What is actually on the root element — the whole chain flattened. */
  get over() {
    return resolveSkin(this.id, this.customs);
  }

  set(id: string) {
    this.id = skinFor(id, this.customs);
    paint(resolveSkin(this.id, this.customs));
    /* Per-machine and disposable, like the panel's width and the reading
       scale: which skin is on is about this screen and this pair of eyes.
       Written on the switch rather than deferred — this is one discrete
       gesture and there is no pointerup afterwards to hang a save on. */
    try {
      localStorage.setItem(SKIN_KEY, this.id);
    } catch {}
  }

  /** Round the ring. The gesture is Ctrl+Shift+Y in `App.svelte`. */
  cycle(dir: number = 1) {
    this.set(nextSkin(this.id, this.customs, dir));
  }

  /* ── authoring ───────────────────────────────────────────────────────── */

  #save(list: Skin[]) {
    this.customs = list;
    writeCustoms(list);
    /* The current skin may have just changed underneath the document — an edit
       to it, or a delete of the base it extends. Repainting from the new list
       unconditionally is cheaper than working out whether this write touched
       the chain being drawn, and `skinFor` catches the case where the skin
       itself has gone. */
    this.id = skinFor(this.id, list);
    paint(resolveSkin(this.id, list));
  }

  /** A new skin from the current one, and switch to it. Returns its id. */
  create(label: string, how: Derivation = "extend", baseId: string = this.id): string {
    const s = deriveSkin(baseId, { label, how, customs: this.customs });
    this.#save([...this.customs, s]);
    this.set(s.id);
    return s.id;
  }

  /** Set or clear one knob on a custom skin.
   *
   *  A built-in cannot be edited and this does not quietly refuse: it derives
   *  an extending child first and edits that, for the reason `Ink.tweak`
   *  gives — the answer to "you cannot edit `sugar`" is always "then make one
   *  from it", and a dead control costs the gesture. */
  tweak(knob: string, value: string | null) {
    const cur = this.skin;
    const id = cur.builtin ? this.create(`${cur.label} mine`, "extend", cur.id) : cur.id;
    this.#save(this.customs.map((s) => (s.id === id ? withSkinKnob(s, knob, value) : s)));
  }

  /** Rename, renote. The id never moves — it is what `from` and the stored key
   *  point at. */
  rename(id: string, label: string, note?: string) {
    this.#save(
      this.customs.map((s) =>
        s.id === id
          ? {
              ...s,
              label: label.trim().slice(0, 60) || s.label,
              note: note === undefined ? s.note : note.trim().slice(0, 200),
            }
          : s,
      ),
    );
  }

  /** What would break if `id` went. Ask before offering the delete. */
  children(id: string): Skin[] {
    return skinDependents(id, this.customs);
  }

  remove(id: string) {
    this.#save(this.customs.filter((s) => s.id !== id));
  }

  /* ── carrying them off the machine ───────────────────────────────────── */

  text(): string {
    return exportSkins(this.customs);
  }

  /** Take pasted text in, renaming rather than overwriting on a collision.
   *  Returns how many arrived — zero is also the answer for a *reading theme*
   *  pasted here, which the wrapper key catches. */
  paste(text: string): number {
    const incoming = importSkins(text);
    if (!incoming.length) return 0;
    this.#save(mergeSkins(this.customs, incoming));
    return incoming.length;
  }
}

export const skin = new Skins();
