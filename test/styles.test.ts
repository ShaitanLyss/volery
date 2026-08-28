import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Svelte scopes a stylesheet to its component, which is why `.ghost` can mean a
   chrome button in three panels at once and has never once collided. What it
   does not do is protect a component from *itself* — and `App.svelte` carries
   565 lines of CSS over 84 class rules, written across two years by people who
   could not hold all of it in their head.

   So one of them called the dock's coloured shell-line overlay `.ghost` too,
   in the same stylesheet where it already meant the header's buttons. Same
   specificity, further down the file, so it won: every button in the title bar
   took `position: absolute; inset: 0; pointer-events: none`, stacked into one
   unclickable blob, and stayed that way for three releases. Nothing caught it,
   because nothing was looking — it is valid CSS, it type-checks, and the two
   rules do not even share a property, so it survives every cleverer test than
   this one. See the note by `.tint` in `App.svelte`.

   The invariant: within one stylesheet, a bare class selector is *defined* in
   exactly one place. Two standalone `.foo {}` rules are two definitions of
   `.foo`, and past a screenful the second author did not know about the first. */

const SRC = "src";

/** Every `.svelte` under `src`, at any depth. */
function components(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...components(p));
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out.sort();
}

/** The `<style>` body, comments stripped. Svelte allows one style element per
 *  component, so this does not need to handle several. */
function stylesheet(source: string): string {
  const open = source.indexOf("<style");
  if (open === -1) return "";
  const from = source.indexOf(">", open);
  const to = source.lastIndexOf("</style>");
  if (from === -1 || to === -1) return "";
  return source.slice(from + 1, to).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The selector list of every rule at the top level of a stylesheet.
 *
 *  Depth-tracked rather than regexed line by line, so the contents of `@media`
 *  and `@keyframes` — which are rules too, one level down — are skipped rather
 *  than being read as top-level ones. Conservative on purpose: a false positive
 *  here is a test nobody trusts, and the collision this exists for was at the
 *  top level in both halves. */
function topLevelSelectors(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let head = "";
  for (const ch of css) {
    if (ch === "{") {
      if (depth === 0) out.push(head.trim());
      head = "";
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      head = "";
    } else if (depth === 0) {
      head += ch;
    }
  }
  return out.filter(Boolean);
}

/** The one class a rule *defines*, or null if it defines no single bare class.
 *
 *  Only `.foo` on its own counts. `.foo:hover`, `.foo.on` and `.foo .bar` are
 *  refinements of a definition rather than one, and a grouped selector —
 *  `.bar, .dock, .wall` — is a trait being handed to several named things,
 *  which reads as exactly that and is how `.wall` legitimately appears twice
 *  in `App.svelte`. Narrow beats noisy: this catches the shape that actually
 *  shipped a bug and nothing else. */
function definedClass(selector: string): string | null {
  const m = /^\.([a-zA-Z][a-zA-Z0-9_-]*)$/.exec(selector.trim());
  return m ? m[1] : null;
}

describe("a class means one thing per stylesheet", () => {
  const files = components(SRC);

  test("there are components to check at all", () => {
    /* A path that stops resolving would otherwise make this whole file pass by
       checking nothing, which is the failure mode of every test that walks a
       directory. */
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    test(`${file} defines each bare class once`, () => {
      const css = stylesheet(readFileSync(file, "utf8"));
      const seen = new Map<string, number>();
      for (const sel of topLevelSelectors(css)) {
        const cls = definedClass(sel);
        if (cls) seen.set(cls, (seen.get(cls) ?? 0) + 1);
      }
      const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
      expect(twice).toEqual([]);
    });
  }
});

/* The second invariant this file holds, and it is the same *kind* of thing: a
   fact about the CSS that is true across two files and therefore has nowhere
   else to live.
 *
 * `data-text` marks the one thing on the wall a left-drag selects rather than
 * carries — a log's lines. It is two halves in two files and works only as a
 * pair: `Canvas.handleOf` has to name the attribute, or the press is read as a
 * haul and the widget goes with the cursor; and the marked element has to say
 * `user-select: text`, or the selection it just allowed is refused anyway by
 * the `user-select: none` on `.surface`, `.glass` and `WidgetNode`'s `.face`.
 *
 * Either half alone is silent and looks like the other one's fault. Marker
 * without CSS is a log widget you can no longer move *or* select — strictly
 * worse than before the feature. CSS without marker is a selection that starts
 * and is then dragged out from under itself. Neither is a type error, neither
 * shows up in `bun run check`, and both are one careless deletion away, so the
 * pairing is asserted rather than remembered. */
describe("text you are meant to be able to select", () => {
  const files = components(SRC);

  /** Components with at least one `data-text` in their markup.
   *
   *  Two mentions are not uses and are skipped, or this asks a file for a rule
   *  it has nothing to put one on. A backticked one is prose — this codebase
   *  names an attribute in a comment constantly, and a comment explaining the
   *  marker is not a use of it. A bracketed one is a *selector* for the marker
   *  rather than the marker: that is `Canvas.handleOf`, which is the other side
   *  of this pairing and is asserted on its own terms just above. */
  const marked = files.filter((f) =>
    /(?<![`[])\bdata-text\b(?![`\]])/.test(
      readFileSync(f, "utf8").split("<style")[0],
    ),
  );

  test("something on the wall carries the marker", () => {
    /* The same guard the walk above has: a rename that stopped matching would
       make every assertion below pass by checking nothing. */
    expect(marked.length).toBeGreaterThan(0);
  });

  test("the wall's press handler knows the marker", () => {
    /* Asserted against the source rather than against a pure module, because
       `handleOf` is a closure inside `Canvas.svelte` and this is the whole of
       what could be got wrong about it from over here. */
    const canvas = readFileSync(join(SRC, "lib", "Canvas.svelte"), "utf8");
    expect(canvas).toContain("[data-text]");
  });

  for (const file of marked) {
    test(`${file} lets the marked text be selected`, () => {
      const css = stylesheet(readFileSync(file, "utf8"));
      expect(css.replace(/\s+/g, " ")).toContain("user-select: text");
    });
  }
});

describe("the parser this leans on", () => {
  test("reads a rule's selector list", () => {
    expect(topLevelSelectors(".a { color: red }")).toEqual([".a"]);
  });

  test("does not read into a nested block", () => {
    /* The `.inner` here is a media query's, one level down. Counting it as
       top-level would flag a perfectly ordinary responsive override. */
    const css = ".a { color: red } @media (min-width: 5px) { .inner { color: blue } }";
    expect(topLevelSelectors(css)).toEqual([".a", "@media (min-width: 5px)"]);
  });

  test("keeps a grouped selector whole", () => {
    expect(topLevelSelectors(".a,\n  .b { color: red }")).toEqual([".a,\n  .b"]);
  });

  test("counts a bare class and nothing else as a definition", () => {
    expect(definedClass(".ghost")).toBe("ghost");
    expect(definedClass("  .ghost  ")).toBe("ghost");
    expect(definedClass(".ghost:hover")).toBe(null);
    expect(definedClass(".ghost.on")).toBe(null);
    expect(definedClass(".ink .ghost")).toBe(null);
    expect(definedClass(".bar, .dock")).toBe(null);
    expect(definedClass("@media (min-width: 5px)")).toBe(null);
  });

  test("strips a comment before it can look like a rule", () => {
    /* A selector inside a comment is not a rule, and a stylesheet this size has
       plenty of CSS written out in prose. */
    expect(topLevelSelectors(stylesheet("<style>/* .a { x } */ .b { y }</style>"))).toEqual([".b"]);
  });

  test("catches the collision this was written for", () => {
    const css = stylesheet("<style>.ghost { color: red } .ghost { position: absolute }</style>");
    const bare = topLevelSelectors(css).map(definedClass).filter(Boolean);
    expect(bare).toEqual(["ghost", "ghost"]);
  });
});

/* A second invariant in the same file, and the same kind of bug: valid CSS,
 * clean typecheck, and wrong only when you look at the running app.
 *
 * A Svelte `css` transition applies its styles **only while it is running**. So
 * an absolutely-positioned element whose resting offset comes from the
 * transition and from nowhere else looks correct for the length of the animation
 * and then snaps to its origin. `Bump.svelte`'s three arc items did exactly
 * that: `.pick` was `position: absolute; left: 0; top: 0`, the fan wrote the
 * offsets, and when it finished all three stacked on the button's centre — so
 * the wall showed the last one in DOM order and the bump chip appeared to offer
 * `patch` alone (sink c9f8e6bd). Nothing was missing; two were underneath.
 *
 * Checked by reading the source rather than by rendering, which is the same
 * bargain the collision test above strikes: this suite has no DOM, and the
 * property is visible in the text. */
describe("an element positioned by a transition", () => {
  /** Which elements carry a `transition:` directive, with their markup. */
  function transitioned(source: string): string[] {
    const markup = source.slice(0, source.indexOf("<style") + 1 || undefined);
    const out: string[] = [];
    const re = /<(\w[\w-]*)\b[^>]*?\btransition:[^>]*>/gs;
    for (const m of markup.matchAll(re)) out.push(m[0]);
    return out;
  }

  test("also says where it rests when it is not transitioning", () => {
    const offenders: string[] = [];
    for (const file of components(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const el of transitioned(source)) {
        /* Only a transition that moves the thing. An `opacity`-only fade needs
           no resting offset, and neither does one on a statically-placed node —
           so the test is scoped to a transition whose element is absolutely
           positioned by a class this stylesheet defines with `left`/`top` at an
           origin. That is more than this suite can see, so the rule is narrowed
           to the honest, checkable half: an element carrying BOTH a transition
           and an inline `style:transform` is fine, and one carrying a transition
           whose component's CSS contains `position: absolute` and no
           `style:transform` anywhere is worth a human look. */
        if (!/\btransition:\w+=\{\{[^}]*\bd[xy]\b/.test(el)) continue;
        if (/style:transform=/.test(el)) continue;
        offenders.push(`${file}: ${el.slice(0, 80)}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("recognises the shape it is looking for", () => {
    /* The bug, as it was written. */
    const bad = '<div><button transition:fan={{ dx: 1, dy: 2, i: 0 }}>x</button></div><style>.p{}</style>';
    expect(transitioned(bad)).toHaveLength(1);
    expect(/style:transform=/.test(transitioned(bad)[0])).toBe(false);

    /* And the fix. */
    const good =
      '<div><button style:transform="translate(1px,2px)" transition:fan={{ dx: 1, dy: 2, i: 0 }}>x</button></div><style>.p{}</style>';
    expect(/style:transform=/.test(transitioned(good)[0])).toBe(true);
  });

  test("leaves a transition that only fades alone", () => {
    const fade = '<div><p transition:slide>x</p></div><style>.p{}</style>';
    const el = transitioned(fade)[0];
    expect(/\btransition:\w+=\{\{[^}]*\bd[xy]\b/.test(el)).toBe(false);
  });
});
