/* What a right-click offers, decided away from the DOM.
 *
 * The native menu is suppressed everywhere (see main.ts), so this file owns the
 * whole answer — including the answer "nothing", which is a real outcome rather
 * than a failure: right-clicking bare wall with nothing to say about it should
 * show no menu at all, not an empty box.
 *
 * Pure, so the vocabulary can be tested without a browser. The component turns
 * ids into calls; it never decides what appears. */

export type MenuKind =
  | "card"
  | "spawn"
  | "image"
  | "widget"
  | "region"
  | "ground"
  | "editable"
  | "prose";

/** One option among several, of which one is in force — a widget's variant. */
export type Pick = { id: string; label: string; on: boolean };

export type MenuTarget = {
  kind: MenuKind;
  /* card */
  dormant?: boolean;
  pinned?: boolean;
  /** Has anything been said in this session? Nothing to clear if not. */
  spoken?: boolean;
  /** Already set aside, so the item is the way back rather than the way in. */
  aside?: boolean;
  /** This card is ignoring the account caps you set. Same one-item-two-labels
   *  shape as `aside`: one state with two sides, only one of them available at
   *  a time. */
  bypassing?: boolean;
  /** The wall has accounts registered at all. With none, the item is left off
   *  entirely rather than offered and inert — there are no caps to ignore, so
   *  "ignore the caps" would be a gesture with nothing behind it, and menu.ts's
   *  standing rule is that offering nothing is a real answer. */
  accounts?: boolean;
  /* card / image / widget / region: already stuck to the glass, so the item is
     the way back onto the wall rather than the way off it. One item with two
     labels, the shape `pinned` and `aside` already have — it is one state with
     two sides and only ever one of them is available. */
  glass?: boolean;
  /* card: drawn on the glass, but only because its whole territory is stuck
     there. The item is left off entirely — "put it back on the wall" would be a
     promise the card cannot keep while its territory is still carrying it, and
     an item that does nothing reads as broken where a missing one reads as not
     applicable. Offering nothing is a real answer here, as it is for prose with
     no selection. */
  held?: boolean;
  /* region */
  empty?: boolean;
  moved?: boolean;
  /** This territory is where chat cards stand, so the two things a territory
   *  normally offers to start are both things a card here cannot have: it has
   *  no project to open a conversation in and no git tree to branch. It offers
   *  another chat card instead. */
  chat?: boolean;
  /* widget: what it can be switched between, and what it is on. Handed in
     rather than looked up, because the catalogue is the widgets' business and
     this file's only business is what a right-click offers.

     `picks` is the variant — what you are looking at — and `options` is
     everything else it can be told, below it. Separate groups rather than one
     long list: a clock's face and whether it shows seconds are different kinds
     of question, and a menu that runs them together reads as ten unrelated
     items.

     That argument used to stop one level too early. `options` was a single flat
     list, so every *other* knob was still run together — invisible while each
     label was a self-describing sentence ("what it would cost", "a ring"), and
     not invisible at all once the usage widget's account knob started
     contributing bare names like "work" sitting directly under "tokens". So
     `options` is now one entry per knob and this file puts the rules in. */
  picks?: Pick[];
  options?: Pick[][];
  /* ground / region: the kinds of instrument that can be hung up — a row each,
     or a family of them behind one row.

     Handed in already grouped, the bargain `picks`, `options` and `presets`
     already strike: which widgets belong together is knowledge about the
     catalogue, and this file's only business is what a right-click offers. The
     shape is structural rather than imported so the two files still do not know
     about each other — see `widgets.ts`'s `Offer`, which is this written from
     the other side. */
  offers?: Offer[];
  /* spawn: how a new card can be set up before it is opened — a model and an
     effort under one name. Handed in rather than looked up, the bargain
     `offers` and `picks` already strike: what a preset *is* belongs to
     `presets.ts`, and this file's business is only what the click offers. */
  presets?: { id: string; label: string; note: string }[];
  /** Which of these rows the plain `+` opens on, so the menu can mark it: a
   *  preset id, or `""` for the "as claude code is set up" row, which is one of
   *  the same choices and is marked the same way.
   *
   *  The *marking* is this file's business even though the presets are handed
   *  in — "which of these is in force" is what the click offers, where "what a
   *  preset is" belongs to `presets.ts`. Undefined marks nothing, which is what
   *  a caller with no opinion gets. */
  presetDefault?: string;
  /** ground: what the undo stack would do in each direction, named, or null
   *  where there is nothing that way.
   *
   *  Named rather than a bare "undo", because a stack you cannot see is a
   *  gesture you have to guess at — "undo moving a territory" is the difference
   *  between pressing it and wondering what it will take. Null keeps the item
   *  off entirely, which is this file's standing answer to having nothing to
   *  offer: an inert "undo" is one you stop reading after the second time. */
  undoing?: string | null;
  redoing?: string | null;
  /* editable / prose */
  hasSelection?: boolean;
  canPaste?: boolean;
};

/** An instrument to hang up, or a family of them. `widgets.ts` produces these;
 *  this file turns them into rows. */
export type Offer =
  | { id: string; label: string }
  | { id: string; label: string; items: { id: string; label: string }[] };

export type MenuItem =
  | {
      kind: "item";
      id: string;
      label: string;
      danger?: boolean;
      on?: boolean;
      /** A second, quieter half of the row — what the item costs, where the
       *  label says what it is for. Only the spawn menu has one: everywhere
       *  else the label is the whole of the answer, and a menu that puts two
       *  columns in front of you for "close" is a menu you read slower. */
      note?: string;
    }
  | { kind: "sep" }
  /** A line you cannot click, naming a gesture the rows themselves cannot show.
   *
   *  There is exactly one, and it exists because `ContextMenu` has no room for a
   *  second action on a row: a preset's row already means "open a card like
   *  this", so "make this the default" had to be a modifier, and a modifier
   *  nobody is told about is a feature only its author has. Not a disabled item
   *  — a greyed row invites the click it will not answer. */
  | { kind: "hint"; text: string }
  | {
      /** A row that opens a list beside it rather than doing anything.
       *
       * Added when the widget menu passed nineteen rows — the browser and the
       * Asana board landed on the same afternoon — and it is deliberately the
       * *only* nesting in this file. One level: a submenu inside a submenu is a
       * gesture you have to hold still for twice, and nothing here has a
       * hierarchy that deep. The type permits it because `MenuItem[]` is the
       * honest element type and a `NestedMenuItem` that forbade it would be a
       * second vocabulary for the same rows; the catalogue is what keeps it to
       * one, and `menu.test.ts` asserts that.
       *
       * It carries no `on` and cannot be picked. A row that both opened a list
       * and did something would be a row where the fast gesture and the careful
       * one disagree. */
      kind: "more";
      id: string;
      label: string;
      items: MenuItem[];
    };

const item = (id: string, label: string, danger = false): MenuItem => ({
  kind: "item",
  id,
  label,
  ...(danger ? { danger: true } : {}),
});

/** An item that is currently in force. Marked rather than labelled — "analog
 *  (showing)" is a sentence, and a menu of five of them is a paragraph. */
const chosen = (id: string, label: string, on: boolean): MenuItem => ({
  kind: "item",
  id,
  label,
  on,
});
const sep: MenuItem = { kind: "sep" };

/** A family's row. */
const more = (id: string, label: string, items: MenuItem[]): MenuItem => ({
  kind: "more",
  id,
  label,
  items,
});

/** The offers, as rows.
 *
 *  The ids are unchanged by the grouping — every leaf is still `widget:<kind>`
 *  — which is the property that made this cheap: the component dispatches on
 *  the id it is handed and never learns that some of them arrived one level
 *  down, and `App`'s `act` needed no edit at all. A family's own row carries a
 *  `family:` id that nothing acts on, because nothing should: it opens a list.
 *
 *  An empty family is dropped rather than drawn, this file's standing answer to
 *  having nothing to offer. `widgets.ts` already flattens a family of one, so
 *  between them a submenu always holds at least two rows. */
function offerItems(offers: Offer[]): MenuItem[] {
  return offers.flatMap((o) => {
    if (!("items" in o)) return [item(`widget:${o.id}`, o.label)];
    if (!o.items.length) return [];
    return [more(o.id, o.label, o.items.map((i) => item(`widget:${i.id}`, i.label)))];
  });
}

/** The one gesture that puts a thing on the glass, or takes it off again.
 *
 *  Written once and offered by four kinds of target, because it means exactly
 *  the same thing to a card, an image, a widget and a whole territory — and a
 *  wall where the same gesture is called four things is a wall you have to
 *  learn four times. "the glass" rather than "the screen" so it cannot be read
 *  as a card's own pinning, which is a different question with a different
 *  answer ("let it flow again"). */
const glassItem = (on = false): MenuItem =>
  item("glass", on ? "put it back on the wall" : "stick it to the glass");

/** Trailing and leading separators, and runs of them, are artefacts of building
 *  a list conditionally — never something anybody meant.
 *
 *  Nullable in, because every case below builds its list with `cond ? row :
 *  null` and dropping those is the same tidying as dropping the separators they
 *  leave behind. */
function tidy(items: (MenuItem | null | undefined | false)[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it.kind === "sep" && (!out.length || out[out.length - 1].kind === "sep")) {
      continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

export function menuFor(t: MenuTarget): MenuItem[] {
  switch (t.kind) {
    case "card":
      return tidy([
        t.dormant ? item("wake", "wake it") : null,
        /* The thing that was missing when a card and a terminal wanted the same
           conversation: the session id is what `--resume` takes, and until now
           it appeared nowhere in the UI at all. */
        item("copy-resume", "copy resume command"),
        item("copy-cwd", "copy working directory"),
        /* Only where there is something to look at. A dormant card owns no
           process, so this would open on an empty list — and an item that
           reliably answers "nothing" is one you stop reading after the second
           time, which is how a real answer gets missed later. */
        t.dormant ? null : item("processes", "processes…"),
        t.pinned ? item("unpin", "let it flow again") : null,
        /* One item with two labels rather than two items, because it is one
           state with two sides — the same shape as `pinned`'s "let it flow
           again", which is also only ever offered as the way back. A toggle
           marked `on` would be worse here: what it does is not "be set aside"
           but "set aside" / "pick up", and only one of those is available at a
           time. Kept beside pinning, since both are things you decide about a
           card rather than things you do to the conversation inside it. */
        item("aside", t.aside ? "pick it back up" : "set it aside"),
        /* Beside `aside` because it is the same kind of decision — something
           you settle about this card rather than something you do to the
           conversation in it — and because both are read off the card's face.
           Only where there are accounts to have caps on. */
        t.accounts
          ? item("bypass", t.bypassing ? "respect the account caps" : "ignore the account caps")
          : null,
        /* Beside pinning for the same reason `aside` is: all three are things
           you decide about the card rather than things you do to the
           conversation inside it. Nothing stops and nothing is lost — the wall
           still holds its slot — so it is not marked danger. */
        t.held ? null : glassItem(t.glass),
        sep,
        /* Beside `close`, because both end the conversation — but not marked
           danger, and the difference is real: closing takes the card off the
           wall, while clearing keeps it and its place, and the session it was
           holding stays on disk to be adopted back. Offered only once there is
           something to clear; on a card that has never spoken it would do
           nothing but mint an id. */
        t.spoken ? item("clear", "clear it — start fresh") : null,
        item("close", "close", true),
      ].filter(Boolean) as MenuItem[]);

    case "image":
      return [
        item("front", "bring to front"),
        glassItem(t.glass),
        sep,
        item("remove", "remove", true),
      ];

    /* A widget's variants are offered here rather than in a panel of their own,
       for the reason the whole file exists: the native menu is suppressed, so
       this *is* the answer, and a clock has one question worth asking about it.
       The variants come first — it is what you right-clicked it for. */
    case "widget":
      return tidy([
        ...(t.picks ?? []).map((p) => chosen(`set:${p.id}`, p.label, p.on)),
        sep,
        /* A rule between knobs, and `tidy` drops any that end up doubled or
           leading — so a guarded knob that contributes nothing leaves no gap. */
        ...(t.options ?? []).flatMap((group) => [
          ...group.map((p) => chosen(p.id, p.label, p.on)),
          sep,
        ]),
        item("front", "bring to front"),
        glassItem(t.glass),
        sep,
        item("remove", "take it down", true),
      ]);

    /* The `+` on a territory, right-clicked. Left-clicked it opens a card on
       whatever this menu was last told to make the default — this is the same
       gesture with the setting-up done first, which is the only moment it can
       be done cheaply: a card that has already spoken has spent a context on
       the model you did not mean to use.

       So this menu does two jobs with one list: a click opens a card set up
       that way *once*, and a ctrl-click makes that row what the plain `+` does
       from now on. One list rather than two because they are the same five
       choices, and a second menu of the same five under a different verb is a
       menu you have to read twice to find out they are.

       The plain opening is last rather than first. It is the one that was
       already there and needs no reading, and putting it at the top would put
       the five things worth looking at below the one you can reach by not
       right-clicking at all. */
    case "spawn": {
      /* Marked only when somebody has told us what the default is. Undefined
         leaves every row a plain item; a value makes the whole list a radio
         group with the dot on the one a plain `+` would open, which is the only
         way to see that setting without opening a card to find out. */
      const mark = (id: string) =>
        t.presetDefault === undefined ? {} : { on: t.presetDefault === id };
      return tidy([
        ...(t.presets ?? []).map((p) => ({
          kind: "item" as const,
          id: `preset:${p.id}`,
          label: p.label,
          note: p.note,
          ...mark(p.id),
        })),
        sep,
        /* `""` is this row's id as the default is stored — see
           `presets.defaultPresetFor`, where it is the *chosen* absence of a
           preset rather than nobody having chosen. */
        { kind: "item" as const, id: "new", label: "as claude code is set up", ...mark("") },
        /* Last, and only where there is a default to change. A hint about a
           gesture is worth its line while the gesture is new and worth nothing
           to somebody who has no way to act on it. */
        t.presetDefault === undefined
          ? null
          : { kind: "hint" as const, text: "ctrl-click a row to make it what + opens" },
      ]);
    }

    case "region":
      return tidy([
        t.chat ? item("chat", "new chat conversation") : null,
        t.chat ? null : item("new", "new conversation here"),
        t.chat ? null : item("new-worktree", "new conversation in a worktree"),
        sep,
        item("adopt", "adopt a recorded session…"),
        /* Dropping a file in from outside was the only way to pin something up,
           which is fine until the thing you want is not already in a window you
           can drag from. */
        item("image", "pin up an image…"),
        ...offerItems(t.offers ?? []),
        sep,
        /* A territory on the glass takes its cards with it — it is a place on
           the wall and a place is where its work is standing, so a region box
           on its own would be an empty rectangle. Grouped with `reflow`: both
           are answers to "where does this territory live", and unlike `reflow`
           this one is always offered, since it has a way back of its own. */
        glassItem(t.glass),
        /* The way back from carrying a territory off somewhere — a card's "let it
           flow again", one level up. Offered only when it would move something:
           a territory still standing where it was packed has nothing to tidy. */
        t.moved ? item("reflow", "settle it back in") : null,
        /* Only once it is standing empty. A territory outlives its last card so
           you can start again in it; forgetting is how you say you won't, and
           it is not something to offer next to live work. */
        sep,
        /* Always offered, and with one label whether or not anything is set.
           The obvious alternative — two labels, the shape `glassItem` and
           `aside` use — is wrong here and the difference is worth stating: those
           are one *state* with two sides, where only one of the two gestures is
           available at a time. This is one gesture that opens one panel, and a
           menu entry that renames itself according to what is behind it is an
           entry you cannot learn the position of. The panel says what is set;
           the menu says where to go. */
        item("guidance", "this project's standing instructions…"),
        t.empty ? sep : null,
        t.empty ? item("forget", "forget this project", true) : null,
      ].filter(Boolean) as MenuItem[]);

    case "ground":
      return tidy([
        /* At the top, and only when there is something either way. The wall's
           gestures are mouse gestures — you dragged a territory with this hand
           and the way back should be under the same one, not only on a key you
           have to know about. */
        t.undoing ? item("undo", `undo ${t.undoing}`) : null,
        t.redoing ? item("redo", `redo ${t.redoing}`) : null,
        t.undoing || t.redoing ? sep : null,
        item("open", "open a folder…"),
        /* Offered on the ground and deliberately not in a territory's menu: a
           chat card is one opened *outside* any project, and putting it in the
           list a territory gives would be offering to start something in a
           place it cannot be. The ground is where "not in a project" is a
           location you can right-click. */
        item("chat", "new chat conversation"),
        item("adopt", "adopt a recorded session…"),
        item("image", "pin up an image…"),
        ...offerItems(t.offers ?? []),
        sep,
        item("fit", "fit everything"),
        /* Territories are packed once and then remembered, so a wall that has
           grown into itself is tidied when you say so and never behind your
           back. This is where you say so. */
        item("tidy", "tidy the territories"),
        sep,
        /* How much the wall is allowed to move. Marked rather than labelled,
           the shape a widget's variants already have — and grouped immediately
           above the ambience because the two are the same question about the
           same surface: what the ground does when nobody is asking it
           anything, and how much of that you are willing to pay for. */
        ...(t.picks ?? []).map((p) => chosen(p.id, p.label, p.on)),
        t.picks?.length ? sep : null,
        /* The ground is what the ambience is drawn on, so this is where asking
           about it belongs — the chrome button is for reaching it without
           finding bare wall first. */
        item("ambience", "the wall's ambience…"),
        /* And beside it, for the same reason one level up: the ground is the
           wall itself, so what the wall tells every card standing on it is a
           question you ask by right-clicking the wall. A territory's own are in
           that territory's menu, which is the same arrangement read one scope
           in. */
        item("guidance", "the wall's standing instructions…"),
      ].filter(Boolean) as MenuItem[]);

    case "editable":
      return tidy([
        t.hasSelection ? item("cut", "cut") : null,
        t.hasSelection ? item("copy", "copy") : null,
        t.canPaste ? item("paste", "paste") : null,
        sep,
        item("select-all", "select all"),
      ].filter(Boolean) as MenuItem[]);

    /* Read-only text: the transcript. Offering "copy" with nothing selected
       would be a menu item that does nothing, so there is simply no menu. */
    case "prose":
      return t.hasSelection ? [item("copy", "copy")] : [];

    default:
      return [];
  }
}
