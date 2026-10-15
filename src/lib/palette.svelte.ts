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
  luminance,
  type Skin,
  type SkinOverrides,
  type Derivation,
} from "./palette";

import { BRIGHT_KEYS, brighten, cleanLevel, cleanLevels, nudged } from "./brightness";

export * from "./palette";

const SKIN_KEY = "skein.skin.v1";
const CUSTOM_KEY = "skein.skins.v1";
/* How bright each skin is set, by skin id. Per-machine and disposable, like
   which skin is on: it is about this screen, this room and this pair of eyes,
   which is also why it is per skin. Studio brightened and meadow dimmed are
   two settings, and one shared number would mean opposite things on a dark
   ground and a light one. */
const LEVEL_KEY = "skein.brightness.v1";

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

function readLevels(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LEVEL_KEY);
    return raw ? cleanLevels(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeLevels(levels: Record<string, number>) {
  try {
    localStorage.setItem(LEVEL_KEY, JSON.stringify(levels));
  } catch {}
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
function paint(over: SkinOverrides): boolean {
  const root = document.documentElement;
  for (const k of SKIN_KNOBS) {
    const v = over[k];
    if (v === undefined) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
  /* `data-ground="light"` is for what one token cannot say. A table of sixteen
     terminal colours, say, has a dark-ground set and a light-ground set and no
     single knob to choose between them. Absent on a dark ground, so studio's
     root element carries nothing it did not carry before. */
  const light = groundIsLight();
  if (light) root.setAttribute("data-ground", "light");
  else root.removeAttribute("data-ground");
  return light;
}

/** Whether the panel's ground, which is what everything is measured against,
 *  is light.
 *
 *  Read off the document rather than off the override map, so a custom skin
 *  extending a light one, or a skin that only moved `--well`, answers the same
 *  as a built-in. The computed value of an unregistered custom property is the
 *  token stream with `var()` substituted, which is a hex for every built-in.
 *  For anything else, a `color-mix(…)` say, the engine is asked through a
 *  probe's `color`. A ground nobody can measure counts as dark, which is what
 *  the wall was before any of this. */
function groundIsLight(): boolean {
  const root = document.documentElement;
  const declared = getComputedStyle(root).getPropertyValue("--well").trim();
  const y = luminance(declared);
  if (y !== null) return y > LIGHT_ABOVE;
  try {
    const probe = document.createElement("i");
    probe.style.cssText = "position:absolute;visibility:hidden;color:var(--well)";
    root.appendChild(probe);
    const said = getComputedStyle(probe).color;
    probe.remove();
    const rgb = channels(said);
    if (!rgb) return false;
    const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2] > LIGHT_ABOVE;
  } catch {
    return false;
  }
}

/** WCAG luminance above which a ground is light. Mid-grey is about 0.2; every
 *  dark skin's well sits under 0.02 and every light one's over 0.6, so the
 *  threshold has room on both sides and is not a judgement about any skin. */
const LIGHT_ABOVE = 0.3;

/** `rgb(…)` or `color(srgb …)`, as the engine serialises a computed colour,
 *  into 0–1 channels. */
function channels(css: string): [number, number, number] | null {
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(css);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
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
  /** Whether the skin on paints a light ground. See `paint`. */
  light = $state(false);
  /** Bumped every time the root element is repainted, so anything drawing on
   *  a canvas can re-read its colours. A canvas cannot see a custom property
   *  change. It reads the tokens once with `getComputedStyle`, and without
   *  something to depend on it keeps drawing whatever ground it was mounted
   *  on. Reading `skin.painted` inside the effect that reads the tokens is the
   *  whole of what it takes. */
  painted = $state(0);
  /** Brightness by skin id. See `brightness.ts`, and `LEVEL_KEY` above for
   *  why it is per skin. */
  levels = $state<Record<string, number>>(readLevels());

  constructor() {
    this.customs = readCustoms();
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SKIN_KEY);
    } catch {
      /* a browser refusing storage is not a reason to start unskinned */
    }
    this.id = skinFor(stored, this.customs);
    this.#paint();
  }

  #paint() {
    const over = resolveSkin(this.id, this.customs);
    this.light = paint(over);
    /* Brightness is a second pass over what the skin drew, never a value
       stored into a skin. It needs the tokens as the browser resolves them,
       tokens.css's defaults included, and the only honest source for that is
       the document just painted. At zero the second pass does not happen at
       all, which is what keeps `studio` the untouched app. */
    const level = this.levels[this.id] ?? 0;
    if (level !== 0) {
      const cs = getComputedStyle(document.documentElement);
      const drawn: Record<string, string> = {};
      for (const k of BRIGHT_KEYS) drawn[k] = cs.getPropertyValue(k).trim();
      paint({ ...over, ...brighten(drawn, level) });
    }
    this.painted++;
  }

  /** How bright the skin on is set, from -1 to 1. 0 is the skin as it is. */
  get brightness(): number {
    return this.levels[this.id] ?? 0;
  }

  setBrightness(v: number) {
    const n = cleanLevel(v);
    const next = { ...this.levels };
    if (n === 0) delete next[this.id];
    else next[this.id] = n;
    this.levels = next;
    writeLevels(next);
    this.#paint();
  }

  /** One step brighter (1) or dimmer (-1). The chords are space v k and v j. */
  nudge(dir: number) {
    this.setBrightness(nudged(this.brightness, dir));
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
    this.#paint();
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
    this.#paint();
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
