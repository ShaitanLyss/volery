<script lang="ts">
  import type { Conversation } from "./conversation.svelte";
  import { cubicOut } from "svelte/easing";
  import {
    Studio,
    layout,
    settle,
    wallOrder,
    CARD_BOX,
    Z_CARD,
    Z_CHIP,
    type Laid,
    type Lod,
    type Placement,
    type Region,
    type Territory,
  } from "./studio.svelte";
  import type { Board, RefImage } from "./images.svelte";
  import type { Widgets } from "./widgets.svelte";
  import type { Undo, Stand } from "./undo.svelte";
  import { nameEdit, type Edit } from "./undo";
  import {
    covered,
    haulLabel,
    haulOf,
    haulSize,
    marqueed,
    pressed,
    tapped,
    type Haul,
    type Mods,
    type Pick,
    type Standing,
    type World,
  } from "./pick";
  import type { Widget } from "./widgets";
  import type { Meter } from "./meter.svelte";
  import type { Ledger } from "./ledger.svelte";
  import type { DevOps } from "./devops.svelte";
  import type { Cycle } from "./cycle.svelte";
  import type { Profile } from "./ambience";
  import { glassAt, spotOf, stickTo, type Spot } from "./glass";
  import { stub } from "./outline";
  import { displayName } from "./naming";
  import type { Flights } from "./relay.svelte";
  import type { Board as Billboards } from "./board.svelte";
  import type { Sink } from "./sink.svelte";
  import type { Beacon } from "./beacon.svelte";
  import type { Reading } from "./serverlog";
  import type { Build } from "./buildlog";
  import type { Editor } from "./unreallog";
  import { screenBox, type Box } from "./flow";
  import Backdrop from "./Backdrop.svelte";
  import Flow from "./Flow.svelte";
  import Lineage from "./Lineage.svelte";
  import type { Kin } from "./lineage";
  import Bump from "./Bump.svelte";
  import Card from "./Card.svelte";
  import Seats from "./Seats.svelte";
  import ImageNode from "./ImageNode.svelte";
  import WidgetNode from "./WidgetNode.svelte";

  let {
    convs,
    projects,
    studio,
    board,
    widgets,
    undo,
    meter,
    ledger,
    pomodoro,
    devops,
    naming,
    onreveal,
    onopen,
    onkeyring,
    ambience,
    flights,
    lineage,
    billboard,
    sink,
    beacon,
    focusedId,
    draft = "",
    draftIds = [],
    chipsFor,
    actionsFor,
    conflictFor,
    onaction,
    onresolve,
    onfocus,
    ondeselect,
    onclose,
    onplan,
    onpin,
    onplace,
    onstick,
    onstickproject,
    onserver,
    servers,
    onserverstart,
    builds,
    onbuildrun,
    editors,
    oneditoropen,
    onadd,
  }: {
    convs: Conversation[];
    /** Every project the studio knows, so a territory outlives its last card. */
    projects: Territory[];
    studio: Studio;
    board: Board;
    /** The instruments hung on the wall — a clock, a performance meter. */
    widgets: Widgets;
    /** The wall's undo stack.
     *
     *  Held here and not only up in App because the gestures that move things
     *  live here, and only here knows when one is over. Widgets and images
     *  record themselves from inside their own classes; a card's placement and a
     *  territory's cannot, because dragging one territory writes a placement
     *  per pinned card inside it every frame — recorded from in there, letting
     *  go of a territory of five cards would be six presses to put back. So
     *  those two are recorded at their commit points, which is where the rows
     *  are written anyway. See the head of `undo.svelte.ts`. */
    undo: Undo;
    /** The one process sampler behind however many meters are up. */
    meter: Meter;
    /** The one transcript reader behind however many usage widgets are up. */
    ledger: Ledger;
    /** The studio's one pomodoro cycle, behind however many views of it are up. */
    pomodoro: Cycle;
    /** What is in the air between cards, and what is waiting undelivered. */
    flights: Flights;
    /** Who opened whom. Drawn behind the cards as a root, not as a message —
     *  see `lineage.ts` for why a standing line is honest here and forbidden
     *  one layer up. */
    lineage: readonly Kin[];
    /** The one billboard reader behind however many are hung up. */
    billboard: Billboards;
    /** The one sink reader behind however many are hung up. */
    sink: Sink;
    /** The one status reader behind however many are hung up, idle until one
     *  attaches. */
    beacon: Beacon;
    /** The one Azure DevOps connection behind the pipelines and reviews
     *  widgets, idle until one of them attaches. */
    devops: DevOps;
    /** What a performance row's role and reference are called up here. */
    naming: (role: string, reference: string | null) => string | null;
    /** Go and look at whatever a widget row points at. */
    onreveal?: (role: string, reference: string) => void;
    /** Leave the app entirely — a pipeline or a pull request in the browser. */
    onopen?: (url: string) => void;
    /** Ask for the Azure DevOps token panel, from the pipelines face's fault. */
    onkeyring?: () => void;
    /** What the wall does when nobody is asking it anything, or null for a bare
     *  one. Drawn inside the surface rather than in App, so it covers exactly
     *  the wall and never the transcript you are reading. */
    ambience: Profile | null;
    focusedId: string | null;
    /** What is typed in the dock, and which cards it would reach.
     *
     *  An unnamed card among them wears it as its title while you write, since
     *  that draft is what is about to name it. Passed as text plus reach rather
     *  than resolved per card up in App, so a keystroke touches only the cards
     *  it is aimed at instead of re-deriving a name for every card on the wall. */
    draft?: string;
    draftIds?: string[];
    /** Dev-server groups belonging to the project that owns a directory. */
    chipsFor?: (cwd: string) => { id: string; label: string; state: string; running: boolean }[];
    /** What the project itself can be asked to do — build, test, ship, push. */
    actionsFor?: (cwd: string) => {
      id: string;
      label: string;
      title: string;
      state: string;
      pct: number | null;
      quiet: boolean;
      idle: boolean;
      /** The choices this chip fans out into instead of firing. Empty for all
       *  but `bump`; see `Bump.svelte`. */
      arc?: { id: string; label: string; title: string }[];
    }[];
    /** A repo left mid-merge, or null for a whole one. Not one of the actions:
     *  a conflict is not something the project offers to do, it is something
     *  that happened to it and has not finished. */
    conflictFor?: (cwd: string) => { label: string; title: string } | null;
    onaction?: (cwd: string, id: string) => void;
    /** Open a card on the conflict, with the prompt already sent. */
    onresolve?: (cwd: string) => void;
    onfocus: (id: string) => void;
    /** Let go of everything: a click on bare ground. The focus lives in App
     *  beside the panel it opens, so the canvas can only report the gesture. */
    ondeselect?: () => void;
    onclose: (conv: Conversation) => void;
    /** Open a plan a card has written, in the file viewer. */
    onplan: (conv: Conversation, path: string) => void;
    onpin?: (id: string, x: number, y: number) => void;
    /** A territory was carried somewhere. `null` gives it back to the grid. */
    onplace?: (cwd: string, x: number | null, y: number | null) => void;
    /** A card's place on the glass changed — stuck, dragged there, or `null`
     *  for put back on the wall. Its wall placement is untouched either way, so
     *  this is a write of its own rather than another `onpin`. */
    onstick?: (id: string, at: Spot | null) => void;
    /** The same, one level up: a whole territory and everything standing in it. */
    onstickproject?: (cwd: string, at: Spot | null) => void;
    onserver?: (groupId: string) => void;
    /** Every dev server group, flat, for a log widget hung on the wall. Plain
     *  data rather than the `GroupRuntime`s: flattened in `App.svelte` beside
     *  the `chipsFor` that already does it for a territory's chips. */
    servers?: Reading[];
    /** Bring one up — start rather than toggle, unlike `onserver`. See the note
     *  at the call site in `App.svelte`. */
    onserverstart?: (groupId: string) => void;
    /** Every project and whatever it last built, for a build log widget. Flat,
     *  for the reason `servers` is. */
    builds?: Build[];
    /** Press one of a project's actions. */
    onbuildrun?: (root: string, action: string) => void;
    /** Every Unreal project, its editor, and what has been tailed of its log. */
    editors?: Editor[];
    /** Open a project's editor, MCP server and all. */
    oneditoropen?: (root: string) => void;
    /** New conversation in an existing project. `worktree` branches it. */
    onadd?: (cwd: string, worktree?: string) => void;
  } = $props();

  /** Which territory is showing its "name a worktree" input. */
  let branching = $state<string | null>(null);
  let branchName = $state("");

  /** Which territory has an action's arc fanned out.
   *
   *  Held per territory rather than per chip because only one chip has an arc;
   *  held here rather than inside the snippet because a snippet has no state,
   *  and the same shape `branching` has for the same reason. A territory stuck
   *  to the glass is drawn by both frames off one snippet, so both copies open
   *  together — which is what `branching` already does and is right: it is one
   *  territory being asked one question. */
  let arcOpen = $state<string | null>(null);

  /* Nothing in the acts row is drawn at `field`, so an arc left open through a
     zoom out would come back when you zoomed in — an answer to a question you
     have stopped asking. */
  $effect(() => {
    if (studio.lod === "field") arcOpen = null;
  });

  let surface: HTMLDivElement | undefined = $state();

  /** Screen point → canvas point. Everything that manipulates a node needs
   *  this, because the layer is translated and scaled under them. */
  export function toCanvas(clientX: number, clientY: number) {
    const r = surface?.getBoundingClientRect();
    return {
      x: ((clientX - (r?.left ?? 0)) - studio.x) / studio.scale,
      y: ((clientY - (r?.top ?? 0)) - studio.y) / studio.scale,
    };
  }

  /* ── the glass ──────────────────────────────────────────── *
   *
   * The pane in front of the wall. See the note at the top of `glass.ts` for
   * what it is for; what lives here is where it *is* and how big it is.
   *
   * It is a child of `main.wall` rather than of `.surface`, which is the whole
   * of how "over the transcript, never over the dock or the header" is enforced
   * — a box cannot escape its parent, so there is no z-index race to lose and
   * no rule anybody has to remember when adding the next thing to the dock.
   * `.surface` would have been wrong twice over: it clips (`overflow: hidden`)
   * and it stops at the panel's left edge. */
  let glassEl: HTMLDivElement | undefined = $state();
  /** How big the pane is, for `glassAt` to keep things reachable inside it.
   *
   *  Measured off the element rather than worked out from the window, because
   *  what it is is "whatever `main.wall` is" — which the header, the dock and
   *  the fault bar all take a share of, and none of them by a number this file
   *  could know. Deliberately *not* narrowed by the transcript panel: covering
   *  that is the one thing the pane is allowed to do. */
  let glassBox = $state({ w: 0, h: 0 });
  $effect(() => {
    const el = glassEl;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      glassBox = { w: el.clientWidth, h: el.clientHeight };
    });
    ro.observe(el);
    glassBox = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  });

  /** Screen point → glass point. `toCanvas`'s counterpart, and much the
   *  shorter of the two: the glass neither pans nor zooms, so this is a
   *  subtraction and nothing else. */
  function toGlass(clientX: number, clientY: number) {
    const r = glassEl?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }

  /** How the viewport looks to `glass.ts`, which knows nothing about runes. */
  const view = $derived({ x: studio.x, y: studio.y, scale: studio.scale });

  /** The middle of the wall as it is currently shown, in canvas units.
   *
   *  Where something goes when it has no position of its own to claim — a paste
   *  with the cursor parked over the transcript, say. Deliberately the middle of
   *  the *view* rather than of the canvas, which has no middle: it is unbounded,
   *  and its origin can be miles from anything you are looking at. */
  export function center() {
    const r = surface?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return toCanvas(r.left + r.width / 2, r.top + r.height / 2);
  }

  /* While a territory is being carried, where it is comes from the gesture
     rather than from the row that will be written on release. `glass` says
     which of its two positions the gesture is moving — a territory on the pane
     is dragged in screen pixels and its wall cell is not what changed.

     Several at once, keyed by `cwd`, because a selection can hold more than one
     territory and one drag moves all of them. It was a single record, from when
     a territory could only ever be dragged by its own name: with two selected,
     that record could only draw the last one moving and the other snapped to
     its new cell on release. `glass` is per gesture rather than per territory,
     since a carry never spans the two frames — see `worldNow`. */
  let carried = $state<{
    glass: boolean;
    at: Record<string, { x: number; y: number }>;
  } | null>(null);
  const territories = $derived.by(() => {
    const c = carried;
    if (!c) return projects;
    return projects.map((p) => {
      const at = c.at[p.root_path];
      if (!at) return p;
      return c.glass
        ? { ...p, glassX: at.x, glassY: at.y }
        : { ...p, x: at.x, y: at.y };
    });
  });

  const model = $derived(layout(convs, studio.placements, territories));

  /* ── the two frames ─────────────────────────────────────── *
   *
   * One layout pass, drawn into two boxes. `layout` runs as though nothing were
   * on the glass at all — that is the rule the whole feature rests on — and
   * then everything it laid out is split by whether it has a glass spot. The
   * markup is shared through snippets, so a card on the pane is the same card
   * with a different origin and no second code path to keep in step.
   *
   * The glass positions are clamped here rather than where they are stored, so
   * a narrow window borrows a thing back from the edge and a wide one gives it
   * straight back — see `glassAt`. */
  const wallRegions = $derived(model.regions.filter((r) => !r.glass));
  const glassRegions = $derived(
    model.regions
      .filter((r) => r.glass)
      .map((r) => ({ ...r, ...glassAt(r.glass!, { w: r.w, h: r.h }, glassBox) })),
  );
  const wallCards = $derived(model.laid.filter((n) => !n.glass));
  const glassCards = $derived(
    model.laid
      .filter((n) => n.glass)
      /* At `wall` density, because the glass is 1:1 and that is the density 1:1
         gives. A card whose box changed with the wall's zoom while its position
         did not would be a thing in screen space measured in canvas units. */
      .map((n) => ({ ...n, ...glassAt(n.glass!, CARD_BOX.wall, glassBox) })),
  );
  /** Every card's box in **screen pixels**, which is the one frame a strand can
   *  reach both a card on the wall and a card stuck to the glass in.
   *
   *  Derived rather than measured off the DOM: the boxes are already known
   *  exactly (`CARD_BOX` is the contract `layout.test.ts` holds the densities
   *  to), and a `getBoundingClientRect` per card per frame during a pan is the
   *  thing this app is careful not to do. A card on the glass is at `wall`
   *  density for the reason `glassCards` gives — the pane is 1:1. */
  const cardBoxes = $derived.by(() => {
    const out = new Map<string, Box>();
    const lod = studio.lod;
    for (const n of wallCards) {
      out.set(
        n.conv.id,
        screenBox({ x: n.x, y: n.y, w: CARD_BOX[lod].w, h: CARD_BOX[lod].h }, view),
      );
    }
    for (const n of glassCards) {
      out.set(n.conv.id, { x: n.x, y: n.y, w: CARD_BOX.wall.w, h: CARD_BOX.wall.h });
    }
    return out;
  });

  /** Which cards are streaming this second, for the one thing about a root that
   *  moves. Derived from the same `tier` the card's own colour comes from, so
   *  the charge and the card can never disagree about what working means —
   *  `urgencyFor` is the single place that question is answered and this is a
   *  read of it rather than a second opinion. */
  const working = $derived(
    new Set(convs.filter((c) => c.tier === "work").map((c) => c.id)),
  );

  const wallImages = $derived(board.images.filter((i) => !spotOf(i)));
  const glassImages = $derived(
    board.images
      .filter((i) => spotOf(i))
      .map((i) => ({ ...i, ...glassAt(spotOf(i)!, { w: i.w, h: i.h }, glassBox) })),
  );
  const wallWidgets = $derived(widgets.items.filter((w) => !spotOf(w)));
  const glassWidgets = $derived(
    widgets.items
      .filter((w) => spotOf(w))
      .map((w) => ({ ...w, ...glassAt(spotOf(w)!, { w: w.w, h: w.h }, glassBox) })),
  );
  /** A patch aimed at a thing on the pane. `ImageNode` and `WidgetNode` know
   *  one pair of coordinates and are handed the glass ones, so what comes back
   *  as `x`/`y` is where it now sits on the glass — and must be written there
   *  rather than over the wall position it still has. Everything else (size,
   *  rotation, z) means the same in both frames and passes straight through. */
  function glassPatch<T extends { x?: number; y?: number }>(patch: T) {
    const { x, y, ...rest } = patch;
    return {
      ...rest,
      ...(x === undefined ? {} : { glassX: x }),
      ...(y === undefined ? {} : { glassY: y }),
    };
  }

  /* ── what the undo stack is told, and when ──────────────────────────────
   *
   * Both of these read the record *whole*, because that is the shape an `Edit`
   * takes — see the head of `undo.ts`. A card with no placement answers null,
   * which is not a gap: it is the record saying "this one flows", and undoing
   * back to it is what puts a dragged card back into its slot. */

  /** A card's placement as it stands, detached from the rune so a snapshot on
   *  the stack cannot follow later changes. */
  function placementOf(id: string): Placement | null {
    const p = studio.placements[id];
    return p ? { ...p } : null;
  }

  /** Where a territory stands, off the project row. */
  function standOf(cwd: string): Stand | null {
    const p = projects.find((q) => q.root_path === cwd);
    if (!p) return null;
    return {
      x: p.x ?? null,
      y: p.y ?? null,
      glassX: p.glassX ?? null,
      glassY: p.glassY ?? null,
    };
  }

  /** Stick a thing to the glass, or put it back on the wall.
   *
   *  Asked of the canvas rather than done up in App, because only the canvas
   *  knows where anything currently *is* — the layout pass, the viewport and
   *  the pane's own box are all here. Everything lands where it already looked
   *  to be, at its 1:1 size, centred on where its middle was (`stickTo`). */
  export function toggleGlass(
    kind: "card" | "image" | "widget" | "region",
    id: string,
  ) {
    if (kind === "card") {
      const n = model.laid.find((l) => l.conv.id === id);
      if (!n) return;
      /* Off the glass reads its *own* spot, not `n.glass`: a card inside a
         stuck territory is drawn on the pane without having been put there,
         and the menu does not offer this for one (see `held` in App). */
      const at = spotOf(studio.placements[id])
        ? null
        : stickTo({ x: n.x, y: n.y, ...CARD_BOX[studio.lod] }, view, CARD_BOX.wall);
      const was = placementOf(id);
      studio.stick(id, at);
      onstick?.(id, at);
      undo.did(
        nameEdit("placement", ["glassX", "glassY"], { was: !!spotOf(was), now: !!at }),
        [{ at: "placement", id, was, now: placementOf(id) }],
      );
    } else if (kind === "region") {
      const r = model.regions.find((r) => r.cwd === id);
      if (!r) return;
      const to = r.glass ? null : stickTo(r, view, { w: r.w, h: r.h });
      const was = standOf(id);
      onstickproject?.(id, to);
      /* The `now` is computed rather than read back: the project row is written
         up in App, and only the wall position is left alone by that call — so
         spelling it out here is both the honest answer and the one that cannot
         depend on when the rune settles. */
      if (was) {
        undo.did(
          nameEdit("territory", ["glassX", "glassY"], {
            was: !!spotOf(was),
            now: !!to,
          }),
          [
            {
              at: "territory",
              id,
              was,
              now: { ...was, glassX: to?.x ?? null, glassY: to?.y ?? null },
            },
          ],
        );
      }
    } else if (kind === "image") {
      const i = board.images.find((i) => i.id === id);
      if (!i) return;
      const at = spotOf(i) ? null : stickTo(i, view, { w: i.w, h: i.h });
      board.update(id, { glassX: at?.x ?? null, glassY: at?.y ?? null });
    } else {
      const w = widgets.items.find((w) => w.id === id);
      if (!w) return;
      const at = spotOf(w) ? null : stickTo(w, view, { w: w.w, h: w.h });
      widgets.update(id, { glassX: at?.x ?? null, glassY: at?.y ?? null });
    }
  }

  /** Who is wandering about, for the footprints effect: the cards on the wall,
   *  by whatever they are called. An unnamed card gives its project's name
   *  instead (`displayName`) — a name crossing the wall has no room to explain
   *  an absence, so whereabouts is the more useful of the two facts.
   *
   *  Stubbed, with the rails' own function: a card's title is a sentence
   *  ("Review remaining implementation tasks from design") and a name floating
   *  over a pair of footprints has room for about three words. */
  const wanderers = $derived(convs.map((c) => stub(displayName(c.title, c.project), 22)));

  /** Every card by id, so a billboard notice names its author in the words on
   *  the card rather than in eight characters of hex. Derived here because this
   *  is where the wall's cards already are; the widget belongs to no project and
   *  has no way to ask. */
  const cardNames = $derived(
    new Map(convs.map((c) => [c.id, displayName(c.title, c.project)])),
  );

  /* ── keeping the wall's text sharp ──────────────────────── *
   *
   * The pan box carries `will-change: transform` only while something is
   * actually moving, and gives it back once the wall has been still for a
   * moment; the long note in the styles says why holding it costs sharpness.
   * One timer serves pan, card drag, territory drag and the wheel, so nothing
   * has to remember to put it down. */
  let moving = $state(false);
  let stillTimer: ReturnType<typeof setTimeout> | undefined;
  function moved() {
    moving = true;
    clearTimeout(stillTimer);
    stillTimer = setTimeout(() => (moving = false), 180);
  }
  $effect(() => () => clearTimeout(stillTimer));

  /** The pan, snapped to whole device pixels. A composited layer translated by
   *  a fraction of a physical pixel is resampled on its way to the screen,
   *  which softens every glyph standing on it. `studio.x/y` stay exact — this
   *  is a paint-time rounding of at most half a physical pixel, and everything
   *  that does arithmetic reads the unsnapped value. */
  function snap(v: number): number {
    const d = window.devicePixelRatio || 1;
    return Math.round(v * d) / d;
  }
  const panX = $derived(snap(studio.x));
  const panY = $derived(snap(studio.y));

  /* ── one press, three gestures ─────────────────────────────────────────────
   *
   * A press on the wall becomes a pan, a marquee or a carry, and which one it
   * is used to be decided by the button alone: left panned, right panned, and
   * shift+left drew a band that gathered cards and only cards. Nothing else on
   * the wall could be selected at all, let alone two things at once.
   *
   * It is now the standard direct-manipulation arrangement, because a wall you
   * arrange things on is a canvas and the canvas conventions are the ones your
   * hands already know:
   *
   * - **Left on bare wall → a marquee**, which selects everything it touches of
   *   all four kinds. Either modifier makes it add to the selection rather than
   *   replace it; `pick.ts` carries the argument for what each one means.
   * - **Left on a thing → carry it**, and carry everything else that is
   *   selected along with it, which is the half that makes a selection worth
   *   having rather than decoration.
   * - **Right or middle anywhere → pan.** This is the part worth being careful
   *   about, because panning is how this wall is *read* and the gesture that
   *   does it must not be something the wall can be too full to offer. The
   *   right button already panned from anywhere and goes on doing exactly that,
   *   asking nothing about what is underneath it. The middle button is added
   *   beside it — it is what every other canvas in the world pans with, and it
   *   is the one that is still free while the right button is on its way to a
   *   menu. shift+wheel pans too, and `reveal` still moves the view on its own.
   *
   * One press record serves all three, and the gesture it *became* is whichever
   * of `pan` / `marquee` / `haul` is standing. None of them exists until the
   * press has travelled `DRAG_SLOP`, which is the same rule everything else on
   * this wall follows and is load-bearing twice over here: a marquee that
   * appeared on the first pixel of movement would flicker up under every click,
   * and capturing the pointer before that retargets the eventual `click` and
   * silently swallows every button inside whatever was captured on. */

  /* $state because the template reads it for the grabbing cursor. */
  let pan = $state<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );

  /** The band, in canvas units, once the press has become one. */
  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  const marqueeBox = $derived(
    marquee
      ? {
          x: Math.min(marquee.x0, marquee.x1),
          y: Math.min(marquee.y0, marquee.y1),
          w: Math.abs(marquee.x1 - marquee.x0),
          h: Math.abs(marquee.y1 - marquee.y0),
        }
      : null,
  );

  /** Which modifiers a gesture was made with.
   *
   *  Meta is ORed into `ctrl` here rather than in `pick.ts`, which has no
   *  business knowing what platform it is on — the same line `cycleTab`'s own
   *  binding takes. */
  const modsOf = (e: PointerEvent | MouseEvent): Mods => ({
    shift: e.shiftKey,
    ctrl: e.ctrlKey || e.metaKey,
  });

  /** What a press is aimed at: a thing standing on the wall, the bare ground,
   *  or a control that answers for itself.
   *
   *  The three-way successor to `isGround`, which only ever had to tell the
   *  ground from everything else, because the only thing a left press could do
   *  there was pan. It still decides by what a press is *not* on, for the reason
   *  it always did: `.layer` is an absolutely positioned box the size of the
   *  viewport, so a press anywhere inside it lands on the layer and never on the
   *  surface. Asking `e.target === surface` made the wall draggable in the
   *  margin the layer had been panned off and inert over every project, which
   *  read as a machine-specific fault and was not.
   *
   *  **A node marker beats an ordinary control inside it**, and getting that
   *  the wrong way round cost every card its press: `Card.svelte`'s whole body
   *  *is* a `<button>`, so a rule that stepped over buttons stepped over the
   *  card. It does not need to step over them, because the pointer is not
   *  captured until the press has travelled — a press on a card's close button
   *  that goes nowhere is still a click on that button, exactly as it was when
   *  `.node` ran its own `onpointerdown`, and one that travels was a drag rather
   *  than a press on the button.
   *
   *  Two things genuinely are not the wall's, and `null` says so:
   *
   *  - **A grip**, marked `data-grip`. These run a gesture of their own — an
   *    image's scale and rotate, a widget's resize — and are the one case where
   *    both would fire and move the same thing twice. `e.stopPropagation()` in
   *    the grip cannot help, since this handler is on an ancestor in the capture
   *    phase, so it has to be asked here.
   *  - **An editable**, where a drag means selecting text. `.surface input`
   *    deliberately keeps `user-select: text` for the territory's worktree
   *    field; without this, dragging across it would draw a band instead.
   *
   *  Everything else standing on the wall is either a node or bare ground. Note
   *  `.region` deliberately carries no `data-region`, so a press in a
   *  territory's open space is *ground* and can start a marquee. A territory's
   *  handle is its name, which is where the attribute is, and that is the same
   *  rule dragging one has always followed. */
  function handleOf(target: EventTarget | null): Pick | "ground" | null {
    const el = target as HTMLElement | null;
    if (!el?.closest) return null;
    if (el.closest("[data-grip], input, textarea, [contenteditable='true']")) {
      return null;
    }
    const node = el.closest<HTMLElement>(
      "[data-conv], [data-image], [data-widget], [data-region]",
    );
    if (!node) return "ground";
    const d = node.dataset;
    if (d.conv) return { kind: "card", id: d.conv };
    if (d.image) return { kind: "image", id: d.image };
    if (d.widget) return { kind: "widget", id: d.widget };
    return { kind: "region", id: d.region! };
  }

  /* A pan that happened must not also leave a menu behind when the button comes
     up: the gesture was "move the wall", not "ask the wall something". Chromium
     fires `contextmenu` on release on Windows, so by the time it arrives this
     knows which one it was. */
  let ground:
    | {
        button: number;
        sx: number;
        sy: number;
        moved: boolean;
        /** What the press landed on, kept for the release: a tap on bare ground
         *  lets go of everything, and a tap on a thing collapses the selection
         *  to it. */
        aim: Pick | "ground";
        mods: Mods;
        /** Which frame the press landed in. A band is a wall gesture and must
         *  not be drawn from a press on the pane: the pane's bare areas — a
         *  stuck territory's chip gutter, its acts row — read as ground, and a
         *  rectangle measured in canvas units from a point in screen space
         *  would select whatever happened to be under the arithmetic. */
        glass: boolean;
      }
    | null = null;
  let swallowMenu = false;

  /* That menu is refused at the *window*, in the capture phase, rather than on
     `.surface`. A right-drag can begin on anything, and the `contextmenu` that
     follows is aimed at whatever the cursor was over — which may be a card
     stuck to the glass, and the glass is deliberately not inside the surface.
     Stopped as well as prevented: the studio's own handler is on an ancestor of
     both and would open Skein's menu even with the native one suppressed. */
  $effect(() => {
    const guard = (e: MouseEvent) => {
      if (!swallowMenu) return;
      swallowMenu = false;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("contextmenu", guard, true);
    return () => window.removeEventListener("contextmenu", guard, true);
  });

  /* While a gesture is live its moves and its release are read off the window
     rather than off `.surface`, for two reasons: the press may have landed on
     the glass, which is a sibling of the surface and not a descendant, and for
     the first few pixels the pointer is deliberately not captured — so there is
     no one element guaranteed to see them. This is also what lets every one of
     the four kinds of thing be carried by the same three functions, rather than
     each drawing its own `onpointermove` on its own wrapper: a card's node, a
     territory's name, an image and a widget all now report only their *press*,
     through `groundDown`'s single capture-phase handler, and the drag itself
     belongs to the wall. The listeners exist only for the length of it. */
  let unwatch: (() => void) | null = null;

  function watch() {
    if (unwatch) return;
    const move = (e: PointerEvent) => groundMove(e);
    const up = (e: PointerEvent) => groundUp(e);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    unwatch = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      unwatch = null;
    };
  }
  $effect(() => () => unwatch?.());

  function groundDown(e: PointerEvent) {
    const aim = handleOf(e.target);
    const panning = e.button === 1 || e.button === 2;
    /* Which frame, asked of the DOM rather than passed in: the pane is a
       sibling of the surface, so containment is the whole of the question and
       every kind of press answers it the same way. */
    const onGlass = !!(
      glassEl &&
      e.target instanceof Node &&
      glassEl.contains(e.target)
    );
    /* A control answers for itself — except to the two buttons that pan, which
       reach past everything on the wall by design. */
    if (aim === null && !panning) return;
    /* Any press ends the last gesture's claim on the menu. Without this a
       right-drag that never produced a `contextmenu` — released off the window,
       say — left the flag standing and ate the next honest right-click. */
    swallowMenu = false;
    /* And the same guard for the click a drag must not also be read as. It is
       set on release and consumed by the `click` that follows immediately, so a
       drag that produced no click — carrying a reference or a widget, where the
       eventual click has no `.node` to be captured on — would otherwise leave it
       standing and swallow the next honest press on a card. Cleared here rather
       than on a timer, because the next press is precisely the gesture whose
       click it could wrongly eat. */
    suppressClick = false;
    ground = {
      button: e.button,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      aim: aim ?? "ground",
      mods: modsOf(e),
      glass: onGlass,
    };
    watch();

    if (panning) {
      /* Chromium's middle-click autoscroll would fight the pan for the same
         drag. `.surface` does not scroll, so this is belt and braces. */
      if (e.button === 1) e.preventDefault();
      pan = { sx: e.clientX, sy: e.clientY, ox: studio.x, oy: studio.y };
      return;
    }
    if (e.button !== 0) return;

    /* The selection is settled on the **press**, before anybody knows whether
       this is a click or a drag, and that is what makes a group draggable at
       all: collapsing to the one thing under the pointer here would mean a
       press on a member of a selection threw the rest of it away before the
       drag had started. `pressed` therefore leaves an existing selection alone,
       and `groundUp` collapses it if the press turns out to have been a click.
       On bare ground nothing is settled yet either way — the band has not been
       drawn, and a plain click there is a letting-go that also belongs on the
       release. */
    if (aim !== "ground" && aim !== null) {
      studio.pick(pressed(studio.picks, aim, ground.mods));
      grab(aim, onGlass);
    }
  }

  function groundMove(e: PointerEvent) {
    if (!ground) return;
    if (!ground.moved) {
      /* The same slop everything else on this wall uses, so a click with an
         unsteady hand is still a click. */
      if (Math.hypot(e.clientX - ground.sx, e.clientY - ground.sy) < DRAG_SLOP) {
        return;
      }
      ground.moved = true;
      /* Now it is a drag rather than a click, so taking the pointer is safe —
         and necessary, or a gesture that wanders off the window stops dead. */
      if (surface && !surface.hasPointerCapture(e.pointerId)) {
        surface.setPointerCapture(e.pointerId);
      }
      /* And only now does a band exist. Drawn from where the press *landed*
         rather than from where it crossed the slop, or every marquee would
         start four pixels away from the thing you began beside. */
      if (ground.button === 0 && ground.aim === "ground" && !ground.glass) {
        const p = toCanvas(ground.sx, ground.sy);
        marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
    }
    if (marquee) {
      const p = toCanvas(e.clientX, e.clientY);
      marquee = { ...marquee, x1: p.x, y1: p.y };
      return;
    }
    if (haul) {
      haulMove(e);
      return;
    }
    if (!pan) return;
    moved();
    studio.x = pan.ox + (e.clientX - pan.sx);
    studio.y = pan.oy + (e.clientY - pan.sy);
  }

  function groundUp(e: PointerEvent) {
    const g = ground;
    /* Whether it travelled is asked *first*, and it has to be: a press on a
       thing takes hold of it straight away, so a plain click on a card arrives
       here with a haul standing. Asking about the haul before the travel meant
       the click was read as a drag that had moved nowhere, and the selection
       was never collapsed — a press on one member of a group could not be
       narrowed to it, which is half of what a plain click is for. */
    if (g?.moved) {
      if (marqueeBox) {
        studio.pick(marqueed(studio.picks, covered(marqueeBox, standing()), g.mods));
      } else if (haul) {
        haulUp();
      }
    } else if (g && g.button === 0) {
      /* A press that never travelled is a click, and there are two of them.
         On bare ground it lets go of everything — the gathering, the focus, and
         the panel the focus opens. On a thing it collapses the selection to
         that one thing, which is the other half of `pressed` having left a group
         standing so it could be carried.
         On the *release* rather than on the press, and that is the older half of
         this: clearing on pointerdown meant dragging the wall to look at
         something dropped the gathering you had assembled on the way there, and
         a pan is how this wall is read rather than how you change your mind
         about it. */
      if (g.aim === "ground") {
        studio.clearSelection();
        ondeselect?.();
      } else {
        studio.pick(tapped(studio.picks, g.aim, g.mods));
      }
    }
    if (g?.moved && g.button === 2) swallowMenu = true;
    /* Nothing was written unless the press travelled, so a click leaves no
       records to commit and no positions to draw from. */
    haul = null;
    carried = null;
    ground = null;
    marquee = null;
    pan = null;
    unwatch?.();
    if (surface?.hasPointerCapture(e.pointerId)) {
      surface.releasePointerCapture(e.pointerId);
    }
  }

  /** Everything standing on the wall, as boxes in canvas units, for the band to
   *  test against.
   *
   *  The *wall's* lists rather than the whole registries, deliberately: a thing
   *  on the glass is not standing anywhere the rectangle passed over, and
   *  catching one because the slot it still owns happened to be inside the band
   *  would be the wall selecting something you cannot see it select.
   *
   *  A card's box is the current density's and not the wall's — `field` is 38
   *  units shorter, and a marquee fixed at 208×78 used to catch cards it never
   *  touched. An image's is its axis-aligned box whatever angle it is pinned at,
   *  which over-reaches slightly on a rotated one; the alternative is a rotated
   *  hit test for the one kind that can rotate, and being caught by a band you
   *  drew across a picture is not the failure worth that.
   *
   *  A territory is marked `area`, which is what lets a band drawn inside one
   *  gather its cards without also taking the project. See `covered`. */
  function standing(): Standing[] {
    const box = CARD_BOX[studio.lod];
    return [
      ...wallRegions.map((r) => ({
        kind: "region" as const,
        id: r.cwd,
        box: { x: r.x, y: r.y, w: r.w, h: r.h },
        area: true,
      })),
      ...wallCards.map((n) => ({
        kind: "card" as const,
        id: n.conv.id,
        box: { x: n.x, y: n.y, w: box.w, h: box.h },
      })),
      ...wallImages.map((i) => ({
        kind: "image" as const,
        id: i.id,
        box: { x: i.x, y: i.y, w: i.w, h: i.h },
      })),
      ...wallWidgets.map((w) => ({
        kind: "widget" as const,
        id: w.id,
        box: { x: w.x, y: w.y, w: w.w, h: w.h },
      })),
    ];
  }

  /* ── carrying whatever is held ──────────────────────────────────────────────
   *
   * One drag for all four kinds. There used to be two — `cardDown` and
   * `terrDown`, near-identical but for what they wrote — and the other two
   * kinds each moved themselves from inside their own component. Four gestures
   * that could each only move one thing is exactly what a selection spanning
   * the wall cannot be built on, so there is one now: the press says what it
   * landed on, `haulOf` says what is coming along, and every frame writes
   * `origin + delta` for all of it.
   *
   * `origin + delta` rather than an accumulation is the same bargain the two old
   * drags struck, and here it earns its keep twice: a pinned card that is both
   * selected *and* inside a selected territory would be written by two paths in
   * the same frame, and computing from the origin makes those two writes agree
   * instead of doubling. (The flowing case cannot be made to agree, which is why
   * `haulOf` excludes it — see the note there.) */
  const DRAG_SLOP = 4;

  let haul: {
    /** What the press landed on, for the label the undo menu says. */
    on: Pick;
    /** Which frame the gesture is in. The glass has no zoom to divide by and a
     *  different place to write the result to. */
    glass: boolean;
    /** Where everything started. */
    it: Haul;
    /** The records as they were, whole, so the release can record one act — see
     *  the head of `undo.ts` for why an `Edit` is a snapshot on both sides. */
    was: {
      placements: Record<string, Placement | null>;
      stands: Record<string, Stand | null>;
      images: Record<string, RefImage>;
      instruments: Record<string, Widget>;
    };
  } | null = null;
  let suppressClick = false;

  /** An image's whole record, detached from the rune. */
  function imageOf(id: string): RefImage | undefined {
    const i = board.images.find((x) => x.id === id);
    return i ? $state.snapshot(i) : undefined;
  }

  function widgetOf(id: string): Widget | undefined {
    const w = widgets.items.find((x) => x.id === id);
    return w ? $state.snapshot(w) : undefined;
  }

  /** Where everything stands right now, in the frame the gesture is happening
   *  in.
   *
   *  **One frame per carry**, and a selection is allowed to span both. The two
   *  measure a delta in different units — canvas units divided by the zoom
   *  against screen pixels taken as they come — so one drag cannot honestly
   *  serve both, and a thing on the pane simply does not move when you drag
   *  something on the wall. The positions are the ones being *drawn*, clamped by
   *  `glassAt` on the pane, which is what the old per-node drags were handed
   *  too: on a pane narrow enough to have borrowed something back from the edge,
   *  the drawn spot is the honest origin. */
  function worldNow(glass: boolean): World {
    if (glass) {
      return {
        cards: glassCards.map((n) => ({
          id: n.conv.id,
          cwd: n.conv.cwd,
          x: n.x,
          y: n.y,
          /* Nothing is carried by hand on the pane: a territory's members are
             laid at an offset from its glass origin (`drawnAt` in `layout`), so
             moving the origin moves all of them, pinned or flowing. That is the
             same branch `terrDown` had, arriving through the data instead. */
          pinned: false,
        })),
        images: glassImages.map((i) => ({ id: i.id, x: i.x, y: i.y })),
        widgets: glassWidgets.map((w) => ({ id: w.id, x: w.x, y: w.y })),
        regions: glassRegions.map((r) => ({ id: r.cwd, x: r.x, y: r.y })),
      };
    }
    return {
      cards: wallCards.map((n) => ({
        id: n.conv.id,
        cwd: n.conv.cwd,
        x: n.x,
        y: n.y,
        pinned: n.pinned,
      })),
      images: wallImages.map((i) => ({ id: i.id, x: i.x, y: i.y })),
      widgets: wallWidgets.map((w) => ({ id: w.id, x: w.x, y: w.y })),
      regions: wallRegions.map((r) => ({ id: r.cwd, x: r.x, y: r.y })),
    };
  }

  function grab(on: Pick, glass: boolean) {
    /* Taking hold of a reference raises it, which is what pressing one always
       did — an image you have picked up should not stay behind the one beside
       it. */
    if (on.kind === "image") board.bringToFront(on.id);
    const it = haulOf(studio.picks, worldNow(glass));
    if (!haulSize(it)) return;
    const placements: Record<string, Placement | null> = {};
    const stands: Record<string, Stand | null> = {};
    const images: Record<string, RefImage> = {};
    const instruments: Record<string, Widget> = {};
    for (const c of it.cards) placements[c.id] = placementOf(c.id);
    for (const r of it.regions) {
      stands[r.id] = standOf(r.id);
      for (const p of r.pins) placements[p.id] = placementOf(p.id);
    }
    for (const i of it.images) {
      const v = imageOf(i.id);
      if (v) images[i.id] = v;
    }
    for (const w of it.widgets) {
      const v = widgetOf(w.id);
      if (v) instruments[w.id] = v;
    }
    haul = { on, glass, it, was: { placements, stands, images, instruments } };
  }

  function haulMove(e: PointerEvent) {
    const h = haul;
    if (!h || !ground) return;
    moved();
    /* Screen delta → the frame's own units. On the wall that means dividing by
       the scale, or a thing would outrun the cursor when zoomed out and lag it
       when zoomed in; on the glass the two are the same thing. */
    const s = h.glass ? 1 : studio.scale;
    const dx = (e.clientX - ground.sx) / s;
    const dy = (e.clientY - ground.sy) / s;
    /* Every write in here is one the stack would otherwise remember, and a drag
       writes its box on every frame. `Widgets` and `Board` record themselves —
       that is deliberate and `undo.md` argues for it — so the quiet has to reach
       across all four realms, and the whole gesture is recorded once on release
       instead. It is the same reason letting go of a territory of five pinned
       cards is one press to undo rather than six. */
    undo.quiet(() => {
      for (const c of h.it.cards) {
        if (h.glass) studio.stick(c.id, { x: c.x + dx, y: c.y + dy });
        else studio.pin(c.id, c.x + dx, c.y + dy);
      }
      for (const i of h.it.images) {
        const at = { x: i.x + dx, y: i.y + dy };
        board.update(i.id, h.glass ? { glassX: at.x, glassY: at.y } : at);
      }
      for (const w of h.it.widgets) {
        const at = { x: w.x + dx, y: w.y + dy };
        widgets.update(w.id, h.glass ? { glassX: at.x, glassY: at.y } : at);
      }
      if (h.it.regions.length) {
        const at: Record<string, { x: number; y: number }> = {};
        for (const r of h.it.regions) {
          at[r.id] = { x: r.x + dx, y: r.y + dy };
          for (const p of r.pins) studio.pin(p.id, p.x + dx, p.y + dy);
        }
        carried = { glass: h.glass, at };
      }
    });
  }

  /** Called from `groundUp`, and only for a press that travelled — a click is
   *  settled there instead, since nothing was written for it to commit. */
  function haulUp() {
    const h = haul;
    if (!h) return;
    suppressClick = true;
    /* One act for the whole press, however many things it moved and however
       many realms they came from: the frames in between are not places anything
       was put. The rows are committed here for the same reason — see
       `undo.md`'s note on gestures that have a commit point. Images and widgets
       need no commit call, since their own `update` has already scheduled the
       save; what they need from here is the *record*, which their own scribe was
       kept quiet about. */
    const edits: Edit[] = [];
    for (const c of h.it.cards) {
      const p = studio.placements[c.id];
      if (p && h.glass) onstick?.(c.id, spotOf(p));
      else if (p) onpin?.(c.id, p.x, p.y);
      edits.push({
        at: "placement",
        id: c.id,
        was: h.was.placements[c.id] ?? null,
        now: placementOf(c.id),
      });
    }
    for (const r of h.it.regions) {
      const at = carried?.at[r.id];
      if (!at) continue;
      if (h.glass) onstickproject?.(r.id, { x: at.x, y: at.y });
      else onplace?.(r.id, at.x, at.y);
      const was = h.was.stands[r.id] ?? null;
      /* The `now` is computed rather than read back: the project's row is
         written up in App, and only one of its two positions is touched by that
         call — so spelling it out is both the honest answer and the one that
         cannot depend on when a rune settles. */
      if (was) {
        edits.push({
          at: "territory",
          id: r.id,
          was,
          now: h.glass
            ? { ...was, glassX: at.x, glassY: at.y }
            : { ...was, x: at.x, y: at.y },
        });
      }
      for (const p of r.pins) {
        const now = studio.placements[p.id];
        if (now) onpin?.(p.id, now.x, now.y);
        edits.push({
          at: "placement",
          id: p.id,
          was: h.was.placements[p.id] ?? null,
          now: placementOf(p.id),
        });
      }
    }
    for (const i of h.it.images) {
      const was = h.was.images[i.id];
      if (was) edits.push({ at: "image", id: i.id, was, now: imageOf(i.id) ?? null });
    }
    for (const w of h.it.widgets) {
      const was = h.was.instruments[w.id];
      if (was) edits.push({ at: "widget", id: w.id, was, now: widgetOf(w.id) ?? null });
    }
    undo.did(haulLabel(h.it, h.on, h.glass), edits);
    carried = null;
  }
  /* ── a slot that empties is walked into, not teleported into ── *
   *
   * Close a conversation and every flowing card behind it in its territory moves
   * up a slot. That is the right arrangement — it is what `layout` says the wall
   * is now — but arriving at it in one frame reads as the wall having always
   * looked that way, and position here is meant to be memory. A card that walks
   * to its new slot can be followed with the eye; one that is simply elsewhere
   * has to be found again.
   *
   * FLIP, via Svelte's `animate:`, which is what the directive is for — but with
   * the offset arithmetic ours (`settle`), because the built-in `flip` divides by
   * the layer's zoom twice. See the note over `settle` and `tools/probe-zoom.html`.
   *
   * Two things fall out of the directive rather than being decided here, and one
   * has to be decided here after all:
   *
   * - **A pinned card is included and costs nothing**: it did not move, so
   *   `settle` gives it a distance of zero and a duration to match.
   * - **The transform is ours alone.** `.node` carries `left`/`top`/`z-index` and
   *   no transform, so unlike `flip` there is nothing to compose with — and the
   *   transform is transient, which is what keeps it clear of the raster-scale
   *   trap in the note over `.pan`.
   * - **A card in hand does not walk anywhere** (`inHand`), and this is the part
   *   that had to be said out loud. It was written here first that the directive
   *   fires only on a *reorder*, so a drag — which moves cards without touching
   *   the list — would stay glued by itself. That is not what Svelte does:
   *   `reconcile` measures every item and applies on the next microtask whenever
   *   the block's **array** changes, reorder or not, and the array changes on
   *   every frame of a drag, because the whole layout is derived from the
   *   `carried` origin and the placements the gesture writes. So each pointermove
   *   aborted the running animation and started a fresh one from wherever the
   *   card had got to — `from` is a `getBoundingClientRect`, which includes the
   *   transform mid-flight — and a territory's cards trailed the cursor by their
   *   own duration for as long as it was moving, catching up only on release.
   *   Suppressed per card rather than wall-wide: dragging one card can hand its
   *   slot to a neighbour, and *that* is a reflow, which should be walked. */
  function walk(
    _node: Element,
    { from, to }: { from: DOMRect; to: DOMRect },
    {
      scale,
      id,
      cwd,
    }: {
      /* Which frame the card is walking in. The rects are screen pixels either
         way; what differs is what the transform's own units are worth, and on
         the glass they are worth exactly one. */
      scale: number;
      id: string;
      cwd: string;
    },
  ) {
    if (inHand(id, cwd)) return { duration: 0 };
    const { dx, dy, duration } = settle(from, to, scale);
    return {
      duration,
      easing: cubicOut,
      css: (_t: number, u: number) =>
        `transform: translate(${u * dx}px, ${u * dy}px)`,
    };
  }

  /** Is this card in hand right now — itself, or inside a territory that is?
   *
   *  Read at `apply()` time, which is a microtask after the pointermove that
   *  moved it, so plain `let`s are enough; nothing here wants to be reactive.
   *  It asks the *haul* rather than a per-kind gesture record, so a card that is
   *  coming along because something else was grabbed is as glued as the thing
   *  under the pointer — which it has to be, since one drag now moves several. */
  function inHand(id: string, cwd: string) {
    if (!haul || !ground?.moved) return false;
    if (haul.it.cards.some((c) => c.id === id)) return true;
    return haul.it.regions.some((r) => r.id === cwd);
  }

  /* A drag must not also read as a click that focuses the card. */
  function nodeClickCapture(e: MouseEvent) {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }

  /* ── zoom ───────────────────────────────────────────────── *
   * The wheel zooms at the cursor; shift+wheel pans. This is deliberately not
   * Figma's convention (wheel pans, ctrl+wheel zooms), which is what this was
   * first: on a wall whose densities *are* the navigation, zoom is the gesture
   * you make constantly and panning is the one you make by dragging the ground.
   * ctrl+wheel still zooms, so the older habit costs nothing.
   *
   * Registered by hand because the listener must be non-passive to
   * preventDefault. */
  $effect(() => {
    const el = surface;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      moved();
      const r = el.getBoundingClientRect();
      if (e.shiftKey) {
        /* Only one axis is ever non-zero — Windows reports shift+wheel on
           deltaX, a trackpad on deltaY — so both are applied unconditionally. */
        studio.x -= e.deltaX;
        studio.y -= e.deltaY;
      } else {
        studio.zoomAt(
          e.clientX - r.left,
          e.clientY - r.top,
          Math.exp(-e.deltaY * 0.0016),
        );
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /* Persist viewport and pins, debounced — a pan fires this every frame. */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void studio.x;
    void studio.y;
    void studio.scale;
    void studio.placements;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => studio.save(), 300);
  });

  /** Open a territory's worktree field, as its `+ branch` chip does. Exposed so
   *  the context menu can reach the same input rather than growing a second way
   *  to name a branch. */
  export function startBranch(cwd: string) {
    branching = cwd;
    branchName = "";
  }

  /** The cards in the order they read off the wall, for Tab and shift+Tab.
   *
   *  Asked of the canvas rather than worked out again in App, because the order
   *  has to be the order of the wall actually on screen — the same layout pass,
   *  carried territory included. */
  export function order(): Conversation[] {
    return wallOrder(model.laid);
  }

  /** Pan the least that brings a card fully into view; leave the zoom alone.
   *
   *  Tab can reach a card that is off screen, and a selection you cannot see is
   *  worse than none: the ring moves, the dock retargets, and nothing you are
   *  looking at changes. The density stays put because it is a deliberate choice
   *  — this shows you the card, it does not decide how you are reading the wall. */
  export function reveal(id: string) {
    const n = model.laid.find((l) => l.conv.id === id);
    if (!n) return;
    /* Nothing to reveal: a card on the glass is already in front of you, and
       panning the wall to the slot it still owns would move the view for no
       visible reason — the card under the ring would not have budged. */
    if (n.glass) return;
    const box = CARD_BOX[studio.lod];
    revealBox(n.x, n.y, box.w, box.h);
  }

  /** The same pan, aimed at an instrument rather than a card. What the peek
   *  calls when a countdown that has rung is clicked — a widget is not in
   *  `model.laid`, since nothing on this wall lays it out. */
  export function revealWidget(id: string) {
    const w = widgets.items.find((w) => w.id === id);
    if (!w || spotOf(w)) return;
    revealBox(w.x, w.y, w.w, w.h);
  }

  /** Pan the least that brings a canvas-space box into view, never zooming: the
   *  density is a deliberate choice about how you are reading the wall, and this
   *  shows you a thing, it does not decide that for you. */
  function revealBox(x: number, y: number, w: number, h: number) {
    if (!surface) return;
    const pad = 24; /* a card flush against the edge reads as cut off */
    const x0 = studio.x + x * studio.scale;
    const y0 = studio.y + y * studio.scale;
    const x1 = x0 + w * studio.scale;
    const y1 = y0 + h * studio.scale;
    const right = surface.clientWidth - pad;
    const bottom = surface.clientHeight - pad;
    /* Top-left wins where a card is taller or wider than the viewport, which is
       what `open` on a short window is: better to see its head than its foot. */
    const dx = x0 < pad ? pad - x0 : x1 > right ? right - x1 : 0;
    const dy = y0 < pad ? pad - y0 : y1 > bottom ? bottom - y1 : 0;
    if (!dx && !dy) return;
    studio.x += dx;
    studio.y += dy;
    /* The debounced save above is watching x/y, so nothing to persist by hand. */
  }

  export function fitAll() {
    if (!surface) return;
    /* References and instruments are part of the wall, so framing "everything"
       has to include them — otherwise Home hides the board you just pinned up,
       or the clock you just hung.

       Everything on the glass is left out, and a territory stuck to it too: it
       is already in view, so counting the wall position it is *not* being drawn
       at would zoom the wall out to frame an empty patch of it. */
    const boxes = [
      ...wallRegions,
      ...[...wallImages, ...wallWidgets].map((n) => ({
        project: "",
        cwd: n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        glass: null,
      })),
    ];
    studio.fit(boxes, surface.clientWidth, surface.clientHeight);
  }
</script>

<!-- ── the shared markup ──────────────────────────────────────────────────
     Everything the wall draws, drawn by the glass too. One layout pass feeds
     both frames (see `wallRegions`/`glassRegions` in the script), so a card on
     the pane is the same card with a different origin rather than a second
     code path that has to be kept in step with this one.

     `glass` is the frame. It reaches exactly three things: which units a drag
     is measured in, where the result is written, and — for a card — the
     density, which on the pane is always `wall` because the pane is 1:1. -->

{#snippet territory(r: Region, glass: boolean)}
    {@const torn = conflictFor?.(r.cwd) ?? null}
    <!-- A territory's boundary is a dashed line, which is to say a stitch.
         When the repo underneath is half-merged, that stitch comes apart —
         see `.region.torn`. It is the one project-level state drawn at *every*
         density, ambient rather than announced: colour is status on this wall
         and rust is the fault colour, so a wall zoomed out to `field` still
         shows you which project is torn without showing you a word. -->
    <div
      class="region"
      class:torn={!!torn}
      class:picked={studio.isPicked("region", r.cwd)}
      data-name={r.project}
      data-cwd={r.cwd}
      style:left="{r.x}px"
      style:top="{r.y}px"
      style:width="{r.w}px"
      style:height="{r.h}px"
    ></div>

    <!-- The name is also the handle. A project is a place on the wall, and
         where that place is should be yours to decide — so it is grabbed by
         the one part of a territory that is a thing rather than an area. -->
    <div
      class="name"
      data-region={r.cwd}
      data-cwd={r.cwd}
      style:left="{r.x + 11}px"
      style:top="{r.y + 8}px"
      style:z-index={Z_CHIP}
      title="{r.project} — drag to move it, and everything in it"
      role="presentation"
    >
      {r.project}
    </div>

    <!-- Dev servers belong to the territory, not to a panel somewhere else:
         "is the backend up" is a property of the project you're looking at. -->
    {#if studio.lod !== "field"}
      {@const chips = chipsFor?.(r.cwd) ?? []}
      <div
        class="chips"
        style:left="{r.x + r.w - 8}px"
        style:top="{r.y + 7}px"
        style:z-index={Z_CHIP}
      >
        {#each chips as c (c.id)}
          <button
            class="chip"
            data-state={c.state}
            title={c.running ? "Running — click to stop" : "Click to start"}
            onclick={() => onserver?.(c.id)}
          >
            <i></i>{c.label}
          </button>
        {/each}

        <!-- Adding another conversation to a project you already have should
             cost one click and no typing. -->
        {#if branching === r.cwd}
          <span class="branch">
            <!-- Focused on appearance: the input is opened by a click on a
                 chip, so without this the very next thing you do — type the
                 branch name — goes to whatever had focus before, and the field
                 you are looking at stays empty. -->
            <input
              bind:value={branchName}
              placeholder="branch name"
              spellcheck="false"
              {@attach (el) => el.focus()}
              onblur={() => (branching = null)}
              onkeydown={(e) => {
                if (e.key === "Enter" && branchName.trim()) {
                  onadd?.(r.cwd, branchName.trim());
                  branching = null;
                  branchName = "";
                } else if (e.key === "Escape") {
                  branching = null;
                  branchName = "";
                }
              }}
            />
          </span>
        {:else}
          <!-- `data-add` is how the right-click finds this button rather than
               the territory it stands on: the menu is decided in `App.svelte`,
               which knows what belongs in a card, and this file only knows
               where the button is drawn. Same division as `data-conv` and
               `data-cwd`. -->
          <button
            class="chip add"
            data-add={r.cwd}
            title="New conversation in {r.project} — right-click to choose a model"
            onclick={() => onadd?.(r.cwd)}>+</button
          >
          <button
            class="chip add"
            title="New conversation in its own git worktree"
            onclick={() => {
              branching = r.cwd;
              branchName = "";
            }}>+ branch</button
          >
        {/if}
      </div>

      <!-- What the project itself can be asked to do, along its bottom edge.
           Deliberately not up beside the servers: an Unreal territory offers
           six verbs, and the top row is already the project's name, its dev
           servers and two ways to start a conversation. Splitting them puts
           identity and address at the top and the work at the foot, and gives
           each row the whole width of the territory.

           It sits inside the region's own bottom padding — `REGION_PAD` below
           the last row of slots — which is why nothing here changes with the
           density: the row is the same size at `wall` and at `open`, and both
           have room for it. -->
      {@const acts = actionsFor?.(r.cwd) ?? []}
      {#if acts.length}
        <div
          class="acts"
          data-cwd={r.cwd}
          style:left="{r.x + 11}px"
          style:top="{r.y + r.h - 21}px"
          style:z-index={Z_CHIP}
        >
          {#each acts as a (a.id)}
            <!-- Wrapped so an arc can be positioned off the chip it comes out
                 of, and marked `data-fan` so `Bump.svelte`'s dismiss-on-press
                 knows the opener is not "somewhere else". A plain inline-flex
                 span, so the row's own flex layout is unchanged for the chips
                 that have no arc. -->
            <span class="fan" data-fan={a.arc?.length ? r.cwd : undefined}>
              <button
                class="chip act"
                data-run={a.state}
                class:quiet={a.quiet}
                class:asking={a.arc?.length && arcOpen === r.cwd}
                disabled={a.idle}
                style:--p="{a.pct ?? 0}%"
                title={a.title}
                onclick={() => {
                  /* An arc-bearing chip asks rather than does, and a second
                     press takes the question back. */
                  if (a.arc?.length) arcOpen = arcOpen === r.cwd ? null : r.cwd;
                  else onaction?.(r.cwd, a.id);
                }}
              >
                <i></i>{a.label}{#if a.pct !== null}<em>{a.pct}%</em>{/if}
              </button>
              {#if a.arc?.length && arcOpen === r.cwd}
                <Bump
                  choices={a.arc}
                  onpick={(id) => {
                    arcOpen = null;
                    onaction?.(r.cwd, id);
                  }}
                  ondismiss={() => (arcOpen = null)}
                />
              {/if}
            </span>
          {/each}
        </div>
      {/if}

      <!-- The tear's own label, at the foot of the territory opposite the
           verbs. Not *among* them: they are things the project offers to do
           all day, and this is one thing that has gone wrong and wants
           undoing. The two rows read as the top row does — the project's
           name at the left, its state at the right.

           Right-aligned off the region's own edge, so it cannot be pushed
           about by however many verbs an Unreal project happens to offer, and
           so it needs nothing from the acts row's existence: a bare git repo
           with no build and nothing to push still tears. -->
      {#if torn}
        <div
          class="tear"
          data-cwd={r.cwd}
          style:left="{r.x + r.w - 11}px"
          style:top="{r.y + r.h - 21}px"
          style:z-index={Z_CHIP}
        >
          <button class="chip rip" title={torn.title} onclick={() => onresolve?.(r.cwd)}>
            <i></i>{torn.label}
          </button>
        </div>
      {/if}
    {/if}
{/snippet}

<!-- The inside of a card. Split out rather than the whole `.node`, because
     `animate:` has to sit on the immediate child of a keyed each block and a
     `{@render}` is not one — so the wrapper is written twice below and only
     what is inside it is shared. -->
{#snippet cardBody(n: Laid<Conversation>, lod: Lod, scale: number)}
  {#if n.conv.seats.length}
    <Seats seats={n.conv.seats} {scale} />
  {/if}
  <Card
    conv={n.conv}
    focused={n.conv.id === focusedId}
    selected={studio.isSelected(n.conv.id)}
    pinned={n.pinned}
    {lod}
    inbox={flights.inbox[n.conv.id] ?? 0}
    draft={draftIds.includes(n.conv.id) ? draft : ""}
    onfocus={(e) => {
      /* Only the focus. What is *selected* was settled by the press, up in
         `groundDown`/`groundUp`, because a group has to be picked before the
         drag that carries it can start and a click is too late to be told.
         A modified click is about the gathering rather than about reading, so it
         does not also swing the panel onto the card: ctrl-clicking one out of a
         selection and having it open is the opposite of what you asked for. */
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      onfocus(n.conv.id);
    }}
    onclose={() => onclose(n.conv)}
    onplan={(path) => onplan(n.conv, path)}
  />
{/snippet}

{#snippet reference(img: RefImage, glass: boolean)}
  <ImageNode
    {img}
    src={board.src(img)}
    selected={studio.isPicked("image", img.id)}
    scale={glass ? 1 : studio.scale}
    toCanvas={glass ? toGlass : toCanvas}
    onupdate={(patch) => board.update(img.id, glass ? glassPatch(patch) : patch)}
    onremove={() => board.remove(img.id)}
  />
{/snippet}

{#snippet instrument(w: Widget, glass: boolean)}
  <WidgetNode
    widget={w}
    selected={studio.isPicked("widget", w.id)}
    scale={glass ? 1 : studio.scale}
    {meter}
    {ledger}
    {pomodoro}
    {devops}
    {billboard}
    {sink}
    {beacon}
    servers={servers ?? []}
    onserverstart={(id) => onserverstart?.(id)}
    builds={builds ?? []}
    onbuildrun={(root, action) => onbuildrun?.(root, action)}
    editors={editors ?? []}
    oneditoropen={(root) => oneditoropen?.(root)}
    names={cardNames}
    {naming}
    toCanvas={glass ? toGlass : toCanvas}
    {onreveal}
    {onopen}
    {onkeyring}
    onupdate={(patch) => widgets.update(w.id, glass ? glassPatch(patch) : patch)}
    onremove={() => void widgets.remove(w.id)}
  />
{/snippet}

<div
  class="surface"
  bind:this={surface}
  onpointerdowncapture={groundDown}
  class:panning={!!pan}
  role="presentation"
>
  <!-- Behind everything, and outside `.layer`: ambience is drawn in screen space
       so panning the wall does not drag the weather along with it. The names are
       the cards standing on the wall — the footprints effect borrows them rather
       than inventing anybody. -->
  <Backdrop profile={ambience} names={wanderers} />

  <!-- The roots, over the weather and under the whole wall.
       Here rather than beside `Flow` — which is a sibling of `.surface` and
       therefore *above* the cards — because that layering is the feature: above
       a card is traffic, below it is structure. A relay strand is light in the
       air and a root is in the ground, so a root arriving at a card passes
       under it rather than across its title, with no rim arithmetic to get
       right. Screen space either way; `cardBoxes` is the same map both are
       given. See `lineage.ts`. -->
  <Lineage kin={lineage} boxes={cardBoxes} scale={studio.scale} charged={working} />

  <!-- Two nested boxes, and which property does which half is the whole reason
       the text on this wall is sharp. See the note over `.pan` in the styles. -->
  <div class="pan" class:moving style:transform="translate({panX}px, {panY}px)">
    <div class="layer" style:zoom={studio.scale}>
      {#each wallRegions as r (r.cwd)}
        {@render territory(r, false)}
      {/each}

      <!-- References sit beneath the cards. The wall is a working surface first
           and a mood board second; a photo should never cover live work. -->
      {#each wallImages as img (img.id)}
        {@render reference(img, false)}
      {/each}

      <!-- Instruments. They stack in the same two bands a reference image does —
           behind the work by default, in front of everything when you say so —
           because to the wall they are the same kind of thing. -->
      {#each wallWidgets as w (w.id)}
        {@render instrument(w, false)}
      {/each}

      {#if marqueeBox}
        <div
          class="marquee"
          style:left="{marqueeBox.x}px"
          style:top="{marqueeBox.y}px"
          style:width="{marqueeBox.w}px"
          style:height="{marqueeBox.h}px"
        ></div>
      {/if}

      {#each wallCards as n (n.conv.id)}
        <div
          class="node"
          data-conv={n.conv.id}
          style:left="{n.x}px"
          style:top="{n.y}px"
          style:z-index={Z_CARD}
          onclickcapture={nodeClickCapture}
          role="presentation"
          animate:walk={{ scale: studio.scale, id: n.conv.id, cwd: n.conv.cwd }}
        >
          {@render cardBody(n, studio.lod, studio.scale)}
        </div>
      {/each}
    </div>
  </div>
</div>

<!-- The strands, between the wall and the pane.

     A sibling of `.surface` rather than a child, for the reason the glass is
     one: `.surface` clips at the transcript panel's left edge, and a card
     stuck to the glass over the transcript is a perfectly good end of a
     message. `main.wall` is `display: flex` with `.surface` its first child, so
     the two boxes share an origin and one set of screen coordinates serves
     both. -->
<Flow {flights} boxes={cardBoxes} pane={glassBox} />

<!-- ── the glass ──────────────────────────────────────────────────────────
     The pane, and the one thing about this feature that is a matter of where
     a box sits rather than of what any code does.

     It is a child of `main.wall`, so it covers the wall *and* the transcript
     beside it and cannot reach the dock or the title bar — a box cannot escape
     its parent, so that constraint holds without a z-index anybody has to keep
     winning and without a rule to remember when the next thing joins the dock.
     Never inside `.surface`, which clips and stops at the panel's left edge.

     Always in the document, empty or not: it is inert and costs nothing, and
     the alternative is that the first thing stuck to the pane is laid out
     against a box that has not been measured yet. -->
<!-- The pane takes the right button too, and for the one reason the surface's own
     handler cannot cover it: the glass is a *sibling* of the surface, so a press
     on a card stuck here never bubbles anywhere the wall can see. Capture rather
     than bubble on both, because the things standing on the wall stop presses of
     their own — a widget's grip, a card's buttons — and the pan that works
     everywhere cannot be the last handler to be asked. -->
<div
  class="glass"
  bind:this={glassEl}
  onpointerdowncapture={groundDown}
  role="presentation"
>
  {#each glassRegions as r (r.cwd)}
    {@render territory(r, true)}
  {/each}

  {#each glassImages as img (img.id)}
    {@render reference(img, true)}
  {/each}

  {#each glassWidgets as w (w.id)}
    {@render instrument(w, true)}
  {/each}

  {#each glassCards as n (n.conv.id)}
    <div
      class="node"
      data-conv={n.conv.id}
      style:left="{n.x}px"
      style:top="{n.y}px"
      style:z-index={Z_CARD}
      onclickcapture={nodeClickCapture}
      role="presentation"
      animate:walk={{ scale: 1, id: n.conv.id, cwd: n.conv.cwd }}
    >
      {@render cardBody(n, "wall", 1)}
    </div>
  {/each}
</div>

<style>
  .surface {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    /* An arrow, because the left button no longer takes hold of the wall: it
       draws a selection band. A grabbing hand over ground you cannot grab is a
       cursor telling you the wrong thing about the gesture you are about to
       make. The two buttons that *do* pan get the grabbing hand below, once one
       of them is down. */
    cursor: default;
    touch-action: none;
    /* On the wall a press-and-move is always a gesture — pan, marquee, or
       carrying a card — and never a text selection. Without this, dragging a
       card highlighted its title and activity line instead of moving it, and
       the highlight persisted after the drop. Reading and copying happen in the
       transcript panel, which is outside the canvas. */
    user-select: none;
  }
  /* Except where typing is the point: the territory's worktree field. */
  .surface input {
    user-select: text;
  }
  .surface.panning {
    cursor: grabbing;
  }

  /* ── why the wall is two boxes ──────────────────────────────────────────
   *
   * It was one, carrying `translate(x, y) scale(s)`, and every card's text was
   * soft at most zoom levels. A `scale()` does not re-lay-out anything: the
   * subtree is laid out once at scale 1, rasterised at whatever raster scale
   * the compositor picked, and that bitmap is then stretched to size. Chromium
   * re-rasterises when the displayed scale drifts far enough from the raster
   * scale — but `will-change: transform` is a promise that this transform will
   * keep changing, so it deliberately *pins* the raster scale rather than
   * re-rastering per frame. Sharp where the two happened to agree, smeared
   * everywhere else, occasionally snapping into focus a moment after the wheel
   * stopped. On a 1× display that is the difference between reading a card and
   * guessing at it; at 1.5× or 2× the extra samples hide it, which is why it
   * looks like a machine-specific fault and isn't.
   *
   * So the two halves of the viewport are split by what they cost:
   *
   * - `.pan` translates. A translation cannot change the raster scale, so the
   *   glyphs stay exactly as rastered, and it stays a compositor-only move.
   * - `.layer` zooms. `zoom` is not a transform — it multiplies used lengths,
   *   so the subtree genuinely re-lays-out and every glyph is rastered at the
   *   size it is displayed at. Crisp at 0.34 and at 2.2 alike.
   *
   * Everything on the wall is positioned in canvas units with `left`/`top`,
   * which `zoom` scales for us, so no coordinate anywhere had to change —
   * `toCanvas`, the drag deltas and `reveal` all work off `studio.scale` and
   * never off the DOM. */
  .pan {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
  }
  /* Worn only while a gesture is running — see `moved()`. Promoting the box
     permanently is what made the raster scale stick, and it also costs the
     subpixel antialiasing Windows draws text with: a promoted layer gets
     greyscale AA, which is a second, quieter kind of soft. */
  .pan.moving {
    will-change: transform;
  }

  .layer {
    position: absolute;
    inset: 0;
  }

  /* ── the glass ──────────────────────────────────────────────────────────
   *
   * The pane in front of the wall. Its whole geometry is "exactly its parent",
   * and its parent is `main.wall` — which is what makes "over the transcript,
   * never over the dock or the header" a fact about the DOM rather than a rule
   * about z-indexes. `overflow: hidden` is the second half of that: without it
   * a thing dragged to the bottom edge would spill over the dock, and clipping
   * it is honest where `glassAt` (which keeps it inside in the first place)
   * cannot reach — a window that shrank while nobody was looking.
   *
   * `z-index: 4` clears `.side` and the resize grip inside it (3). It has to be
   * said out loud because `.glass` comes *before* `.side` in the document: the
   * canvas is rendered first, so source order would put the pane behind the
   * panel it is meant to be able to cover.
   *
   * Inert, and each thing standing on it takes that back — the same bargain
   * `.rails` strikes. Otherwise an empty pane would swallow every pan on the
   * wall and every scroll in the transcript. */
  .glass {
    position: absolute;
    inset: 0;
    overflow: hidden;
    z-index: 4;
    pointer-events: none;
    /* The same rule `.surface` states and for the same reason: a press-and-move
       on a card is carrying it, never selecting its title. It has to be said
       again rather than inherited, because the pane is not inside the surface. */
    user-select: none;
  }
  /* Except where typing is the point — a stuck territory's worktree field. */
  .glass input {
    user-select: text;
  }
  .glass > :global(*) {
    pointer-events: auto;
  }
  /* Except a territory's own boundary, which is mostly empty space. On the wall
     that area is bare ground (`handleOf` decides by what a press is *not* on),
     so a press there pans or draws a band; on
     the pane there is nothing to pan, so it would simply be a large rectangle
     blocking the transcript underneath it. The name, the chips, the acts row
     and the cards all keep their events, and the name carries `data-cwd`, so
     the territory's own menu is still reachable — by its handle, which is what
     you would reach for anyway. */
  .glass .region {
    pointer-events: none;
  }

  /* Territory. Faint on purpose — it is an address, not a container. */
  .region {
    position: absolute;
    border: 1px dashed var(--edge);
    border-radius: 6px;
    /* Was pointer-events: none, so presses would fall through to the surface.
       They fell through to `.layer` instead and did nothing — and now that
       `handleOf` decides by what a press is *not* on, a territory can take its
       own events without swallowing a pan or a marquee: right-clicking one is
       how you get a menu that knows which project you meant. */
  }
  /* The territory's name, and the handle that carries it. It was drawn with
     `.region::after` until the wall had to be arrangeable — a pseudo-element
     cannot be pressed, and making the whole region draggable would have taken
     the pan back off most of the wall. */
  /* ── a torn territory ───────────────────────────────────────────────────
   *
   * The border is dashed, so it is already a stitch. A repo stopped mid-merge
   * draws a second dashed rectangle just outside the first: the two are 8px
   * different in each dimension, so their dashes fall out of step along every
   * edge and the pair reads as one seam that has split rather than as two
   * borders. That is the whole trick — no SVG, no animation, nothing that has
   * to be positioned.
   *
   * Deliberately not a fill. Cards stand inside a territory, the backdrop's
   * weather draws behind everything, and a wash across a project's whole area
   * would sit between the two and tint work that is perfectly fine. */
  /* A territory that is held. Achromatic and quiet, like every other selection
     on this wall: colour here is status, and being picked is not a state the
     project is in. It reads as the stitch drawn firmly rather than as a second
     kind of boundary, which is why it is the same dash a weight heavier and not
     a solid line — a solid one would say the territory had become a panel.
     Before `.region.torn`, so a half-merged repo still shows rust while it is
     held: the fault is the more important of the two things to know. */
  .region.picked {
    border-color: var(--paper-faint);
    border-style: dashed;
    background: color-mix(in srgb, var(--paper) 4%, transparent);
  }

  .region.torn {
    border-color: color-mix(in srgb, var(--st-fail) 55%, var(--edge));
  }
  .region.torn::after {
    content: "";
    position: absolute;
    inset: -4px;
    border: 1px dashed color-mix(in srgb, var(--st-fail) 30%, transparent);
    border-radius: 9px;
    /* The seam is a mark, not a target — the chip at the foot is the target,
       and the wall must still pan from anywhere in the gap. */
    pointer-events: none;
  }

  .tear {
    position: absolute;
    display: flex;
    /* Anchored to the region's right edge and grown leftwards, so the label
       cannot be shoved off by however long the verbs row beside it gets. */
    transform: translateX(-100%);
  }
  .rip {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--paper);
  }
  .rip i {
    background: var(--st-fail);
  }
  .rip:hover {
    border-color: var(--st-fail);
  }

  .name {
    position: absolute;
    font-family: var(--util);
    font-size: 0.64rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    cursor: grab;
    /* Room to aim at, without moving where the name reads from. */
    padding: 0.15rem 0.3rem;
    margin: -0.15rem -0.3rem;
    border-radius: 3px;
  }
  .name:hover {
    color: var(--paper-mute);
    background: var(--surface);
  }
  .name:active {
    cursor: grabbing;
  }

  /* z-index is set inline from Z_CHIP — see the stacking note in layout.ts. */
  .chips {
    position: absolute;
    transform: translateX(-100%);
    display: flex;
    gap: 0.28rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-mute);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.14rem 0.5rem 0.14rem 0.42rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .chip:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .chip i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .chip[data-state="up"] i {
    background: var(--st-work);
  }
  .chip[data-state="starting"] i {
    background: var(--st-soft);
  }
  .chip[data-state="exited"] i {
    background: var(--st-fail);
  }
  .chip[data-state="exited"] {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--edge));
  }
  .chip.add {
    color: var(--paper-faint);
    border-style: dashed;
  }
  .chip.add:hover {
    color: var(--paper);
    border-style: solid;
  }

  /* The project's own verbs, along the foot of its territory. Same chip, laid
     out from the left rather than the right, because this row grows with what
     a project is and the other grows with what you have started in it. */
  .acts {
    position: absolute;
    display: flex;
    gap: 0.28rem;
  }
  .act {
    /* A build's progress is drawn *in* the chip rather than beside it: a
       separate bar would need room the wall does not have, and the fill reads
       at a glance from across the room, which is the whole argument for the
       densities. `--p` is set inline from the run. */
    background:
      linear-gradient(
          to right,
          color-mix(in srgb, var(--st-work) 26%, transparent) var(--p, 0%),
          transparent var(--p, 0%)
        )
        var(--surface);
    /* Nothing about the chip may resize while a build runs, or the row shuffles
       under the cursor every few seconds. */
    transition: background 0.4s linear;
  }
  /* What an arc comes out of. Zero-cost for the chips that have none: it is an
     inline-flex box the size of its one child, so the row lays out exactly as
     it did before there was such a thing as an arc. */
  .fan {
    position: relative;
    display: inline-flex;
  }
  /* A chip whose arc is open is holding a question rather than reporting a
     state, and says so by staying lit — otherwise the only thing on screen
     saying which chip the arc belongs to is the arithmetic of where it is. */
  .act.asking {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .act em {
    font-style: normal;
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
    margin-left: 0.1rem;
  }
  /* Colour is status and nothing else: celadon working, rust failed. A run that
     finished cleanly leaves the faintest possible mark — enough to answer "did
     that build go through", not enough to draw the eye. */
  .act[data-run="running"] i {
    background: var(--st-work);
  }
  .act[data-run="ok"] i {
    background: color-mix(in srgb, var(--st-work) 55%, var(--paper-faint));
  }
  .act[data-run="failed"] i {
    background: var(--st-fail);
  }
  .act[data-run="failed"] {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--edge));
    color: var(--paper);
  }
  /* Nothing to push, or nothing to do at all. Still drawn — a verb that comes
     and goes is a wall you have to re-read. */
  .act.quiet,
  .act:disabled {
    color: var(--paper-faint);
    opacity: 0.7;
  }
  .act:disabled {
    cursor: default;
  }
  .act.quiet:hover {
    opacity: 1;
  }

  .branch input {
    font-family: var(--mono);
    font-size: 0.62rem;
    background: var(--well);
    border: 1px solid var(--paper-faint);
    border-radius: 999px;
    color: var(--paper);
    padding: 0.14rem 0.55rem;
    width: 120px;
  }
  .branch input:focus {
    outline: none;
  }
  .branch input::placeholder {
    color: var(--paper-faint);
  }

  .marquee {
    position: absolute;
    border: 1px solid var(--paper-faint);
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    border-radius: 2px;
    pointer-events: none;
    z-index: 999;
  }

  /* z-index is set inline from Z_CARD. A reference image sits below the cards
     by default and above everything once brought to the front — one order for
     the whole wall, described in layout.ts. */
  .node {
    position: absolute;
    cursor: grab;
  }
  .node:active {
    cursor: grabbing;
  }
</style>
