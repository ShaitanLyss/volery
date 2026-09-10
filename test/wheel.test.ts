import { describe, expect, test } from "bun:test";
import {
  axisOf,
  BEYOND_PX,
  overflowScrolls,
  scrolls,
  wheelMeaning,
  type Box,
  type Turn,
} from "../src/lib/wheel";

/** A turn of the wheel with nothing held. */
function turn(t: Partial<Turn> = {}): Turn {
  return { deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...t };
}

/** A box that scrolls on the named axes and not on the other. */
function box(on: { x?: boolean; y?: boolean } = {}): Box {
  const reach = (yes?: boolean) => ({ container: !!yes, beyond: yes ? 400 : 0 });
  return { x: reach(on.x), y: reach(on.y) };
}

/** The one shape that is the whole point of `container` and `beyond` being two
 *  fields: a scroll container with nothing in it to scroll. */
const FITS: Box = { x: { container: true, beyond: 0 }, y: { container: true, beyond: 0 } };

describe("which axis a turn is on", () => {
  test("a plain wheel is vertical", () => {
    expect(axisOf(turn({ deltaY: -120 }))).toBe("y");
    expect(axisOf(turn({ deltaY: 120 }))).toBe("y");
  });

  test("windows puts shift+wheel on deltaX", () => {
    expect(axisOf(turn({ deltaX: 120, shiftKey: true }))).toBe("x");
  });

  test("the dominant delta wins a diagonal", () => {
    expect(axisOf(turn({ deltaX: 30, deltaY: 4 }))).toBe("x");
    expect(axisOf(turn({ deltaX: 4, deltaY: 30 }))).toBe("y");
  });

  test("a tie goes to vertical, which is the wall's own reading", () => {
    expect(axisOf(turn({ deltaX: 20, deltaY: 20 }))).toBe("y");
    expect(axisOf(turn({ deltaX: -20, deltaY: 20 }))).toBe("y");
  });

  test("no delta is no axis", () => {
    /* Chromium sends these on a modifier press mid-gesture. Asking a chain
       about a direction there is asking about nothing. */
    expect(axisOf(turn())).toBe(null);
  });
});

describe("whether a box scrolls", () => {
  test("a container with content beyond it does", () => {
    expect(scrolls({ container: true, beyond: 400 })).toBe(true);
  });

  test("a container that fits its content does not", () => {
    /* The half that keeps zoom-over-a-widget: a list of three rows in a box
       that holds six is `overflow-y: auto` and is not a scroller. */
    expect(scrolls({ container: true, beyond: 0 })).toBe(false);
  });

  test("overflow that is not a scroll container does not, however much it spills", () => {
    /* `LogTail`'s `pre.log` is exactly this: `overflow: hidden` with more lines
       than fit, spilling off the top on purpose. Swallowing the wheel there
       would move nothing at all. */
    expect(scrolls({ container: false, beyond: 4000 })).toBe(false);
  });

  test("sub-pixel slack is not something to scroll", () => {
    expect(scrolls({ container: true, beyond: BEYOND_PX })).toBe(false);
    expect(scrolls({ container: true, beyond: 0.5 })).toBe(false);
    expect(scrolls({ container: true, beyond: BEYOND_PX + 0.5 })).toBe(true);
  });
});

describe("what a turn of the wheel means", () => {
  test("over bare ground it zooms", () => {
    expect(wheelMeaning(turn({ deltaY: -120 }), [])).toBe("zoom");
  });

  test("shift over bare ground pans", () => {
    expect(wheelMeaning(turn({ deltaX: 120, shiftKey: true }), [])).toBe("pan");
  });

  test("ctrl over bare ground zooms, which is the older habit", () => {
    expect(wheelMeaning(turn({ deltaY: -120, ctrlKey: true }), [])).toBe("zoom");
  });

  test("inside a list that can move, it scrolls", () => {
    expect(wheelMeaning(turn({ deltaY: 120 }), [box({ y: true })])).toBe("scroll");
  });

  test("inside a list that fits, it zooms", () => {
    expect(wheelMeaning(turn({ deltaY: 120 }), [FITS])).toBe("zoom");
  });

  test("the modifiers stay the wall's even over a list that would scroll", () => {
    /* The trap this fix must not walk into: a widget that is a dead zone for a
       wall gesture is worse than a widget you cannot scroll. Over a Kanban
       column with twenty cards in it, both of the wall's own gestures still
       work, and they are the two that were already documented. */
    const chain = [box({ y: true })];
    expect(wheelMeaning(turn({ deltaY: 120, ctrlKey: true }), chain)).toBe("zoom");
    expect(wheelMeaning(turn({ deltaX: 120, shiftKey: true }), chain)).toBe("pan");
    expect(wheelMeaning(turn({ deltaY: 120, shiftKey: true }), chain)).toBe("pan");
    expect(wheelMeaning(turn({ deltaY: 120, metaKey: true }), chain)).toBe("zoom");
  });

  test("a vertical wheel over a horizontal-only scroller zooms", () => {
    /* Kanban's `.lanes` is `overflow-x: auto` and nothing else, so the gutter
       between its columns is still a place you can zoom from. This is why the
       axis is asked at all. */
    expect(wheelMeaning(turn({ deltaY: 120 }), [box({ x: true })])).toBe("zoom");
  });

  test("a horizontal swipe over a horizontal scroller scrolls it", () => {
    /* A trackpad two-finger swipe with no modifier: `deltaX` only. The wall's
       zoom reads `deltaY`, so this used to be prevented and then do nothing. */
    expect(wheelMeaning(turn({ deltaX: 120 }), [box({ x: true })])).toBe("scroll");
  });

  test("the nearest scroller on the axis answers, however deep it is", () => {
    /* A card inside `.cards` inside `.lanes`: the y scroller is two boxes up
       and the x one above it, and a vertical wheel has to find the first. */
    const chain = [box(), box({ y: true }), box({ x: true })];
    expect(wheelMeaning(turn({ deltaY: 120 }), chain)).toBe("scroll");
    expect(wheelMeaning(turn({ deltaX: 120 }), chain)).toBe("scroll");
  });

  test("a chain of boxes that fit is a chain of nothing", () => {
    expect(wheelMeaning(turn({ deltaY: 120 }), [FITS, FITS, box({ x: true })])).toBe("zoom");
  });

  test("a turn with no delta at all is left to the wall", () => {
    /* It has nowhere else to go — there is no axis to ask a chain about — and
       the wall's own answer to a zero delta is a zoom factor of exactly 1, so
       nothing moves either way. */
    expect(wheelMeaning(turn(), [box({ x: true, y: true })])).toBe("zoom");
  });
});

describe("which overflow values the browser scrolls", () => {
  test("the three that do", () => {
    expect(overflowScrolls("auto")).toBe(true);
    expect(overflowScrolls("scroll")).toBe(true);
    /* Deprecated, and still what some builds compute for `auto`. */
    expect(overflowScrolls("overlay")).toBe(true);
  });

  test("the ones that do not", () => {
    /* `hidden` is programmatically scrollable and the wheel does not touch it,
       which is the distinction `container` exists to make. */
    expect(overflowScrolls("hidden")).toBe(false);
    expect(overflowScrolls("visible")).toBe(false);
    expect(overflowScrolls("clip")).toBe(false);
    expect(overflowScrolls("")).toBe(false);
  });
});
