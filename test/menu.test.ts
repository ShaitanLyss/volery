import { expect, test, describe } from "bun:test";
import { menuFor, type MenuItem } from "../src/lib/menu";

const ids = (items: MenuItem[]) =>
  items.filter((i) => i.kind === "item").map((i) => (i as { id: string }).id);

/** What one item is *called*, for the few whose wording is the state. */
const label = (items: MenuItem[], id: string) =>
  items.find((i): i is Extract<MenuItem, { kind: "item" }> =>
    i.kind === "item" && i.id === id,
  )?.label ?? null;

describe("a menu offers only what the target can actually do", () => {
  test("a dormant card can be woken; a live one has nothing to wake", () => {
    expect(ids(menuFor({ kind: "card", dormant: true }))).toContain("wake");
    expect(ids(menuFor({ kind: "card", dormant: false }))).not.toContain("wake");
  });

  test("only a pinned card can be let go", () => {
    expect(ids(menuFor({ kind: "card", pinned: true }))).toContain("unpin");
    expect(ids(menuFor({ kind: "card", pinned: false }))).not.toContain("unpin");
  });

  /* One item with two labels, not two items: it is one state with two sides,
     and only one of them is available at a time. */
  test("setting aside and picking back up are the same item", () => {
    const away = menuFor({ kind: "card", aside: false });
    const back = menuFor({ kind: "card", aside: true });
    expect(ids(away)).toContain("aside");
    expect(ids(back)).toContain("aside");
    expect(label(away, "aside")).toBe("set it aside");
    expect(label(back, "aside")).toBe("pick it back up");
  });

  /* Nothing is destroyed and nothing is stopped — the card keeps its process,
     its transcript and its place, and one prompt undoes it. */
  test("setting aside is not marked destructive", () => {
    expect(
      menuFor({ kind: "card" }).find((i) => i.kind === "item" && i.id === "aside"),
    ).not.toMatchObject({ danger: true });
  });

  /* One gesture, four kinds of target, one wording. A wall where sticking a
     card and sticking a clock are called different things is a wall you have
     to learn twice. */
  test("the glass reads the same on everything that can go on it", () => {
    for (const kind of ["card", "image", "widget", "region"] as const) {
      expect(label(menuFor({ kind }), "glass")).toBe("stick it to the glass");
      expect(label(menuFor({ kind, glass: true }), "glass")).toBe(
        "put it back on the wall",
      );
    }
  });

  /* Nothing stops and nothing is lost — the wall still holds the card's slot,
     and one click puts it back. */
  test("sticking something to the glass is not marked destructive", () => {
    expect(
      menuFor({ kind: "card" }).find((i) => i.kind === "item" && i.id === "glass"),
    ).not.toMatchObject({ danger: true });
  });

  /* A card drawn on the pane because its whole territory is stuck was not put
     there, and "put it back on the wall" is a promise it cannot keep while the
     territory is still carrying it. Offering nothing is the honest answer. */
  test("a card held on the glass by its territory is offered nothing", () => {
    expect(ids(menuFor({ kind: "card", held: true }))).not.toContain("glass");
    expect(ids(menuFor({ kind: "card", held: true, glass: false }))).not.toContain(
      "glass",
    );
  });

  /* The session id is what `--resume` takes and it appears nowhere else in the
     UI, so this is the one bridge between a card and a terminal. */
  test("every card can hand over its resume command", () => {
    expect(ids(menuFor({ kind: "card" }))).toContain("copy-resume");
  });

  /* A dormant card holds no process, so the list would open on nothing. An
     item that reliably answers "nothing" stops being read. */
  test("only a card with a process can have its processes looked at", () => {
    expect(ids(menuFor({ kind: "card", dormant: false }))).toContain("processes");
    expect(ids(menuFor({ kind: "card", dormant: true }))).not.toContain(
      "processes",
    );
  });

  /* Clearing a card that has never spoken would mint a session id and change
     nothing anybody can see. */
  test("only a card with something behind it can be cleared", () => {
    expect(ids(menuFor({ kind: "card", spoken: true }))).toContain("clear");
    expect(ids(menuFor({ kind: "card", spoken: false }))).not.toContain("clear");
  });

  /* Closing takes the card off the wall; clearing keeps the card, its place and
     its transcript on disk. Marking both would say they cost the same. */
  test("clearing is not marked destructive, and closing is", () => {
    const items = menuFor({ kind: "card", spoken: true });
    expect(items.find((i) => i.kind === "item" && i.id === "clear")).not.toMatchObject({
      danger: true,
    });
    expect(items.find((i) => i.kind === "item" && i.id === "close")).toMatchObject({
      danger: true,
    });
  });

  test("copy needs something selected, or there is no menu at all", () => {
    expect(menuFor({ kind: "prose", hasSelection: false })).toEqual([]);
    expect(ids(menuFor({ kind: "prose", hasSelection: true }))).toEqual(["copy"]);
  });

  test("an input offers paste only when there is a clipboard to read", () => {
    expect(ids(menuFor({ kind: "editable", canPaste: true }))).toContain("paste");
    expect(ids(menuFor({ kind: "editable", canPaste: false }))).not.toContain("paste");
    // select all needs neither a selection nor a clipboard.
    expect(ids(menuFor({ kind: "editable" }))).toEqual(["select-all"]);
  });
});

describe("the list is shaped like something a person meant", () => {
  test("conditional items never leave a rule hanging", () => {
    /* Built by filtering, so the separators have to be swept up afterwards —
       a menu that opens with a horizontal rule reads as a missing item. */
    for (const t of [
      { kind: "card" as const, dormant: false, pinned: false, spoken: false },
      { kind: "card" as const, dormant: true, pinned: true, spoken: true },
      { kind: "card" as const, dormant: true, pinned: false, spoken: false },
      { kind: "card" as const, held: true, spoken: false },
      { kind: "region" as const },
      { kind: "region" as const, moved: true, empty: true },
      { kind: "image" as const },
      { kind: "editable" as const, hasSelection: false, canPaste: false },
      { kind: "editable" as const, hasSelection: true, canPaste: true },
    ]) {
      const items = menuFor(t);
      expect(items[0]?.kind).toBe("item");
      expect(items[items.length - 1]?.kind).toBe("item");
      for (let i = 1; i < items.length; i++) {
        expect(items[i].kind === "sep" && items[i - 1].kind === "sep").toBe(false);
      }
    }
  });

  test("destructive things are marked, so the menu can draw them apart", () => {
    const close = menuFor({ kind: "card" }).find(
      (i) => i.kind === "item" && i.id === "close",
    );
    expect(close).toMatchObject({ danger: true });
    const remove = menuFor({ kind: "image" }).find(
      (i) => i.kind === "item" && i.id === "remove",
    );
    expect(remove).toMatchObject({ danger: true });
  });

  test("the ground and a territory both lead somewhere", () => {
    expect(ids(menuFor({ kind: "ground" }))).toEqual([
      "open",
      "chat",
      "adopt",
      "image",
      "fit",
      "tidy",
      "ambience",
      "guidance",
    ]);
    expect(ids(menuFor({ kind: "region" }))).toEqual([
      "new",
      "new-worktree",
      "adopt",
      "image",
      "glass",
      "guidance",
    ]);
  });

  /* The wall's gestures are mouse gestures — you dragged a territory with this
     hand, and the way back belongs under the same one rather than only on a key
     you have to know about. Named, because a stack you cannot see is a gesture
     you have to guess at. */
  test("the ground offers a way back, named, once there is one", () => {
    const m = menuFor({ kind: "ground", undoing: "moving a territory" });
    expect(ids(m)).toContain("undo");
    expect(label(m, "undo")).toBe("undo moving a territory");
    /* At the top: it is about what just happened, not about what to start. */
    expect(ids(m)[0]).toBe("undo");
  });

  test("and a way forward once one has been stepped back past", () => {
    const m = menuFor({
      kind: "ground",
      undoing: "moving a card",
      redoing: "resizing a widget",
    });
    expect(ids(m).slice(0, 2)).toEqual(["undo", "redo"]);
    expect(label(m, "redo")).toBe("redo resizing a widget");
  });

  /* Offering nothing is a real answer — an inert "undo" is an item you stop
     reading after the second time, which is how a live one gets missed later. */
  test("neither is offered with nothing either way", () => {
    const m = ids(menuFor({ kind: "ground", undoing: null, redoing: null }));
    expect(m).not.toContain("undo");
    expect(m).not.toContain("redo");
    expect(m[0]).toBe("open");
  });

  test("a way forward on its own is still offered", () => {
    const m = menuFor({ kind: "ground", redoing: "removing an image" });
    expect(ids(m)[0]).toBe("redo");
    expect(ids(m)).not.toContain("undo");
  });

  /* Dropping a file in from another window was the only way to pin one up,
     which is no help when what you want is a file rather than something
     already on screen. */
  test("an image can be pinned up from anywhere on the wall", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("image");
    expect(ids(menuFor({ kind: "region", empty: true }))).toContain("image");
  });

  /* A chat card is one opened *outside* any project, so the only place it can
     be started from is the part of the wall that is not in one. A territory
     offering it would be offering to start something in a place it cannot be. */
  test("a chat card is offered by the ground and by no ordinary territory", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("chat");
    expect(ids(menuFor({ kind: "region" }))).not.toContain("chat");
    expect(ids(menuFor({ kind: "region", empty: true }))).not.toContain("chat");
  });

  /* Except the one territory chat cards stand in, where the two things a
     territory normally offers to start are both impossible — there is no
     project to open a conversation in and no git tree to branch — and a `+`
     that quietly made an ordinary card would put an agent with the whole
     machine in Skein's own data folder. */
  test("the chat territory offers another chat card and nothing it cannot do", () => {
    const m = ids(menuFor({ kind: "region", chat: true }));
    expect(m).toContain("chat");
    expect(m).not.toContain("new");
    expect(m).not.toContain("new-worktree");
    /* Everything a territory is otherwise still stands: it is a place on the
       wall, and can be carried, tidied and forgotten like any other. */
    expect(m).toContain("glass");
    expect(ids(menuFor({ kind: "region", chat: true, empty: true }))).toContain(
      "forget",
    );
  });

  /* The ground is the thing the ambience is drawn on, so right-clicking bare
     wall is the shortest way to ask about it. */
  test("the wall's own backdrop is reachable from the wall", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("ambience");
  });

  /* Widgets are offered off the catalogue rather than listed here, so a new
     kind of instrument appears on the menu by existing. */
  test("whatever can be hung up is offered wherever an image is", () => {
    const offers = [{ id: "clock", label: "hang up a clock" }];
    expect(ids(menuFor({ kind: "ground", offers }))).toContain("widget:clock");
    expect(ids(menuFor({ kind: "region", offers }))).toContain("widget:clock");
    /* And nothing at all when nothing is on offer — no empty gap where the
       instruments would be. */
    expect(ids(menuFor({ kind: "ground" }))).not.toContain("widget:clock");
  });

  /* A widget's variants are the whole reason to right-click one, so they come
     first — and the one in force is *marked* rather than labelled, since
     "analog (showing)" repeated five times is a paragraph. */
  test("a widget offers its variants, with the current one marked", () => {
    const items = menuFor({
      kind: "widget",
      picks: [
        { id: "analog", label: "analog", on: false },
        { id: "digital", label: "digital", on: true },
      ],
    });
    expect(ids(items).slice(0, 2)).toEqual(["set:analog", "set:digital"]);
    /* The face and whether it shows seconds are different kinds of question,
       so they are two groups rather than one list of ten. */
    const items2 = menuFor({
      kind: "widget",
      picks: [{ id: "analog", label: "analog", on: true }],
      options: [[{ id: "cfg:seconds", label: "seconds", on: true }]],
    });
    expect(ids(items2)).toEqual([
      "set:analog",
      "cfg:seconds",
      "front",
      "glass",
      "remove",
    ]);
    expect(items2.filter((i) => i.kind === "sep")).toHaveLength(3);
    expect(items.find((i) => i.kind === "item" && i.id === "set:digital")).toMatchObject({
      on: true,
    });
    expect(ids(items)).toContain("front");
    expect(items.find((i) => i.kind === "item" && i.id === "remove")).toMatchObject({
      danger: true,
    });
  });

  /* And the same argument one level down. `options` used to be a single flat
     list, so every knob below the variant was still run together — invisible
     while each label was a self-describing sentence, and not invisible at all
     once the usage widget's account knob began contributing bare names like
     "work" sitting directly under "tokens". */
  test("each knob is its own group, with a rule between", () => {
    const items = menuFor({
      kind: "widget",
      picks: [{ id: "bars", label: "bars", on: true }],
      options: [
        [
          { id: "cfg:measure:allowance", label: "what is left", on: true },
          { id: "cfg:measure:cost", label: "what it would cost", on: false },
        ],
        [
          { id: "cfg:account:all", label: "every account", on: true },
          { id: "cfg:account:work", label: "work", on: false },
        ],
      ],
    });
    expect(items.map((i) => (i.kind === "sep" ? "|" : i.id))).toEqual([
      "set:bars",
      "|",
      "cfg:measure:allowance",
      "cfg:measure:cost",
      "|",
      "cfg:account:all",
      "cfg:account:work",
      "|",
      "front",
      "glass",
      "|",
      "remove",
    ]);
  });

  /* A guarded knob contributes nothing and must leave no gap behind it — two
     rules in a row read as an item that failed to draw. */
  test("an empty group leaves no rule behind it", () => {
    const items = menuFor({
      kind: "widget",
      picks: [{ id: "bars", label: "bars", on: true }],
      options: [[{ id: "cfg:measure:cost", label: "cost", on: true }], []],
    });
    expect(items.map((i) => (i.kind === "sep" ? "|" : i.id))).toEqual([
      "set:bars",
      "|",
      "cfg:measure:cost",
      "|",
      "front",
      "glass",
      "|",
      "remove",
    ]);
  });


  /* The way back from carrying a territory off into the far wall — and, like
     every other conditional item here, absent when it would do nothing. */
  test("only a territory that has been moved offers to be tidied back", () => {
    expect(ids(menuFor({ kind: "region", moved: true }))).toContain("reflow");
    expect(ids(menuFor({ kind: "region", moved: false }))).not.toContain("reflow");
  });

  /* A territory outlives its last card so you can begin again in it — which
     means the wall would otherwise collect every folder ever opened. */
  test("only an empty territory can be forgotten", () => {
    expect(ids(menuFor({ kind: "region", empty: true }))).toContain("forget");
    expect(ids(menuFor({ kind: "region", empty: false }))).not.toContain("forget");
    const forget = menuFor({ kind: "region", empty: true }).find(
      (i) => i.kind === "item" && i.id === "forget",
    );
    expect(forget).toMatchObject({ danger: true });
  });
});

/* One gesture, one label, whichever scope it is read at and whether or not
   anything is set behind it — the argument is by `item("guidance", …)` in
   `menu.ts`. A menu entry that renames itself according to its own contents is
   one you cannot learn the position of, which is the whole value of a menu. */
describe("standing instructions", () => {
  test("both the wall and a territory offer them, always", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("guidance");
    expect(ids(menuFor({ kind: "region" }))).toContain("guidance");
    /* An empty territory is still a territory, and setting its instructions
       before opening the first card in it is a reasonable order to work in. */
    expect(ids(menuFor({ kind: "region", empty: true }))).toContain("guidance");
    /* Chat cards are told the wall's, so the territory they stand in is not a
       special case here — see `guidance.rs`. */
    expect(ids(menuFor({ kind: "region", chat: true }))).toContain("guidance");
  });

  test("nothing else offers them", () => {
    for (const kind of ["card", "image", "widget", "prose", "editable"] as const) {
      expect(ids(menuFor({ kind }))).not.toContain("guidance");
    }
  });

  test("the labels say which scope you are about to set", () => {
    const label = (t: Parameters<typeof menuFor>[0]) =>
      menuFor(t).find((i) => i.kind === "item" && i.id === "guidance") as { label: string };
    expect(label({ kind: "ground" }).label).toContain("wall");
    expect(label({ kind: "region" }).label).toContain("project");
  });
});
