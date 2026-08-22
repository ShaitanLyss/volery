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
    ambience,
    flights,
    lineage,
    billboard,
    sink,
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
    /** The one Azure DevOps connection behind the pipelines and reviews
     *  widgets, idle until one of them attaches. */
    devops: DevOps;
    /** What a performance row's role and reference are called up here. */
    naming: (role: string, reference: string | null) => string | null;
    /** Go and look at whatever a widget row points at. */
    onreveal?: (role: string, reference: string) => void;
    /** Leave the app entirely — a pipeline or a pull request in the browser. */
    onopen?: (url: string) => void;
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
     is dragged in screen pixels and its wall cell is not what changed. */
  let carried = $state<{ cwd: string; x: number; y: number; glass: boolean } | null>(
    null,
  );
  const territories = $derived.by(() => {
    const c = carried;
    if (!c) return projects;
    return projects.map((p) =>
      p.root_path !== c.cwd
        ? p
        : c.glass
          ? { ...p, glassX: c.x, glassY: c.y }
          : { ...p, x: c.x, y: c.y },
    );
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

  /* ── panning the ground ─────────────────────────────────── */
  /* $state because the template reads it for the grab/grabbing cursor. */
  let pan = $state<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );

  /** Shift-drag on bare ground gathers cards; plain drag pans. */
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

  /** Is this press on the ground rather than on something that lives on it?
   *
   *  This used to be `e.target === surface`, which looks equivalent and is not.
   *  `.layer` is an absolutely positioned box the size of the viewport, so a
   *  press anywhere inside it lands on the layer and never on the surface —
   *  and panning simply did nothing over that whole area. It went unnoticed
   *  because the layer is carried by `.pan`: after any pan there is a margin of
   *  bare surface where dragging still worked, so the wall felt draggable in some
   *  places and inert in others, the inert part being wherever the projects
   *  were. Cards, images and controls still handle their own presses. */
  function isGround(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el?.closest) return false;
    return !el.closest(
      "[data-conv], [data-image], [data-widget], [data-region], button, input, textarea, a",
    );
  }

  /* A press on the ground, whichever button made it — and a press *anywhere*
     when it is the right button.

     Panning is how this wall is read, so the gesture that does it must not be
     something the wall can be too full to offer. `isGround` used to be asked of
     every press, which meant a right-drag begun over a card, a widget, a
     reference image or any button inside one of them did nothing at all: the
     denser a territory got, the less of it you could take hold of, and the
     places you most want to move away from were the places you could not. The
     left button still asks what is under it — there the answer is the difference
     between panning the wall and carrying a card — but nothing standing on this
     wall wants a right-drag for itself, so the right button takes it everywhere.

     A pan that happened must not also leave a menu behind when the button comes
     up: the gesture was "move the wall", not "ask the wall something". Chromium
     fires `contextmenu` on release on Windows, so by the time it arrives this
     knows which one it was. */
  let ground: { button: number; sx: number; sy: number; moved: boolean } | null =
    null;
  let swallowMenu = false;

  /* That menu is refused at the *window*, in the capture phase, rather than on
     `.surface`. A right-drag can now begin on anything, and the `contextmenu`
     that follows is aimed at whatever the cursor was over — which may be a card
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
     rather than off `.surface`, for two reasons that both come from the right
     button: the press may have landed on the glass, which is a sibling of the
     surface and not a descendant, and for the first few pixels the pointer is
     deliberately not captured — so there is no one element guaranteed to see
     them. The listeners exist only for the length of the drag. */
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
    const rmb = e.button === 2;
    if (!rmb && !isGround(e.target)) return;
    /* Any press ends the last gesture's claim on the menu. Without this a
       right-drag that never produced a `contextmenu` — released off the window,
       say — left the flag standing and ate the next honest right-click. */
    swallowMenu = false;
    ground = { button: e.button, sx: e.clientX, sy: e.clientY, moved: false };
    watch();
    /* A right press is a click until it has travelled, so the pointer is not
       captured yet — the same rule a card drag follows, for a sharper reason
       here: capture retargets what comes after it, and a right-click on a
       card's composer has to reach that composer for the menu to know it was
       aimed at an editable. `groundMove` takes the pointer once the gesture is
       unmistakable. A left press is on bare ground by definition and has
       nothing under it to mistarget, so it captures at once as it always did. */
    if (!rmb) surface?.setPointerCapture(e.pointerId);

    /* Shift gathers, and only with the left button: the right one is the pan
       that always works, which is the whole point of it. */
    if (e.shiftKey && !rmb) {
      const p = toCanvas(e.clientX, e.clientY);
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    pan = { sx: e.clientX, sy: e.clientY, ox: studio.x, oy: studio.y };
  }

  function groundMove(e: PointerEvent) {
    if (ground && !ground.moved) {
      const far =
        Math.hypot(e.clientX - ground.sx, e.clientY - ground.sy) >= DRAG_SLOP;
      /* The same slop a card drag uses, so a right-click with an unsteady hand
         still opens a menu. */
      if (far) {
        ground.moved = true;
        /* Now it is a drag rather than a click, so taking the pointer is safe —
           and necessary, or a pan that wanders off the window stops dead. */
        if (surface && !surface.hasPointerCapture(e.pointerId)) {
          surface.setPointerCapture(e.pointerId);
        }
      }
    }
    if (marquee) {
      const p = toCanvas(e.clientX, e.clientY);
      marquee = { ...marquee, x1: p.x, y1: p.y };
      return;
    }
    if (!pan) return;
    moved();
    studio.x = pan.ox + (e.clientX - pan.sx);
    studio.y = pan.oy + (e.clientY - pan.sy);
  }

  function groundUp(e: PointerEvent) {
    if (marqueeBox) {
      const b = marqueeBox;
      /* Anything the rectangle touches, not only what it fully contains —
         a lasso you have to draw perfectly is a lasso you stop using. The card's
         size is whatever the current density draws, not the wall's. */
      const card = CARD_BOX[studio.lod];
      /* `wallCards`, not `model.laid`: a card on the glass is not standing
         anywhere the rectangle passed over, and gathering one because the slot
         it still owns happened to be inside would be the wall selecting
         something you cannot see it select. */
      const hit = wallCards
        .filter(
          (n) =>
            n.x < b.x + b.w &&
            n.x + card.w > b.x &&
            n.y < b.y + b.h &&
            n.y + card.h > b.y,
        )
        .map((n) => n.conv.id);
      studio.selected = [...new Set([...studio.selected, ...hit])];
    }
    /* A click on bare ground lets go of everything — the card, the gathering
       and any reference image. On the *release*, and only if the press never
       moved: it used to happen on pointerdown, which meant dragging the wall to
       look at something dropped the gathering you had assembled on the way. A
       pan is how you read this wall, not how you change your mind about it.
       Shift is the additive gesture, so a marquee never clears either. */
    if (ground && !ground.moved && !marquee && ground.button === 0) {
      studio.clearSelection();
      board.selected = null;
      widgets.selected = null;
      ondeselect?.();
    }
    if (ground?.moved && ground.button === 2) swallowMenu = true;
    ground = null;
    marquee = null;
    pan = null;
    unwatch?.();
    if (surface?.hasPointerCapture(e.pointerId)) {
      surface.releasePointerCapture(e.pointerId);
    }
  }

  /* ── dragging a card pins it ────────────────────────────── */
  const DRAG_SLOP = 4;
  let drag: {
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
    /** Which frame this drag is in. The gesture is identical; what differs is
     *  that the glass has no zoom to divide by and a different place to write
     *  the result to. */
    glass: boolean;
    /** The whole placement before the press, for the undo stack — captured here
     *  because every pointermove overwrites it, and null is a real answer (a
     *  flowing card has no placement, and undoing to that is what puts it back
     *  in its slot). */
    was: Placement | null;
  } | null = null;
  let suppressClick = false;

  function cardDown(
    e: PointerEvent,
    id: string,
    x: number,
    y: number,
    glass = false,
  ) {
    if (e.button !== 0) return;
    /* Record the gesture, but do NOT capture the pointer yet. Capturing on
       pointerdown retargets the eventual `click` to this wrapper, which silently
       swallows every button inside the card — close included. */
    drag = {
      id,
      sx: e.clientX,
      sy: e.clientY,
      ox: x,
      oy: y,
      moved: false,
      glass,
      was: placementOf(id),
    };
  }

  function cardMove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      /* Only now is it a drag rather than a click, so capturing is safe. */
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    moved();
    /* Screen delta → the frame's own units. On the wall that means dividing by
       the scale, or a card would outrun the cursor when zoomed out and lag it
       when zoomed in; on the glass the two are the same thing. */
    const s = drag.glass ? 1 : studio.scale;
    const x = drag.ox + dx / s;
    const y = drag.oy + dy / s;
    if (drag.glass) studio.stick(drag.id, { x, y });
    else studio.pin(drag.id, x, y);
  }

  function cardUp(e: PointerEvent) {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true;
      /* Commit only once, on release — not on every pointermove. Dragging a
         card about on the pane is not a statement about where it belongs on
         the wall, so it writes the glass spot and leaves the placement alone. */
      const p = studio.placements[drag.id];
      if (p && drag.glass) onstick?.(drag.id, spotOf(p));
      else if (p) onpin?.(drag.id, p.x, p.y);
      /* One act for the whole press, for the same reason the row is written
         once: the frames in between are not places the card was put. */
      undo.did(drag.glass ? "moving a card on the glass" : "moving a card", [
        { at: "placement", id: drag.id, was: drag.was, now: placementOf(drag.id) },
      ]);
    }
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag = null;
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
   *  Both gestures are only counted once they are past the slop and have become
   *  drags, which is also when they first move anything. */
  function inHand(id: string, cwd: string) {
    if (drag?.moved) return drag.id === id;
    if (terr?.moved) return terr.cwd === cwd;
    return false;
  }

  /* ── dragging a territory carries the project ───────────── *
   *
   * The handle is the territory's own name, not the territory: `.region` fills
   * most of the wall, and a press anywhere inside one has to keep panning —
   * that whole area being inert is the bug `isGround` exists to have fixed.
   *
   * Everything standing in the territory comes along. Flowing cards do that by
   * arithmetic, since their positions are slots measured off the region's
   * origin; pinned cards are absolute canvas coordinates and have to be carried
   * by hand, or a territory would tear in two the moment it moved. */
  let terr: {
    cwd: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    /** Pinned members and where they started, so every frame is computed from
     *  the origin rather than accumulated — as `ox`/`oy` are for a card. `was`
     *  is the same fact whole, for the undo stack: the arithmetic only needs the
     *  two numbers, but putting one back needs the record. */
    pins: { id: string; x: number; y: number; was: Placement | null }[];
    moved: boolean;
    glass: boolean;
    /** Where the territory stood before the press. */
    was: Stand | null;
  } | null = null;

  function terrDown(
    e: PointerEvent,
    r: { cwd: string; x: number; y: number },
    glass = false,
  ) {
    if (e.button !== 0) return;
    /* Only the wall has pinned cards to carry by hand. On the glass a
       territory's members are laid at an offset from its glass origin — that
       is what `drawnAt` in `layout` computes — so moving the origin moves all
       of them, pinned or flowing, and there is nothing to translate. */
    const pins: { id: string; x: number; y: number; was: Placement | null }[] = [];
    if (!glass) {
      for (const c of convs) {
        if (c.cwd !== r.cwd) continue;
        const p = studio.placements[c.id];
        if (p?.pinned) pins.push({ id: c.id, x: p.x, y: p.y, was: { ...p } });
      }
    }
    terr = {
      cwd: r.cwd,
      sx: e.clientX,
      sy: e.clientY,
      ox: r.x,
      oy: r.y,
      pins,
      moved: false,
      glass,
      was: standOf(r.cwd),
    };
  }

  function terrMove(e: PointerEvent) {
    if (!terr) return;
    const dx = e.clientX - terr.sx;
    const dy = e.clientY - terr.sy;
    if (!terr.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      terr.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    moved();
    /* Screen delta → the frame's own units, as a card's drag is: divided by the
       scale on the wall, taken as it comes on the glass. */
    const s = terr.glass ? 1 : studio.scale;
    const x = terr.ox + dx / s;
    const y = terr.oy + dy / s;
    carried = { cwd: terr.cwd, x, y, glass: terr.glass };
    for (const p of terr.pins) {
      studio.pin(p.id, p.x + (x - terr.ox), p.y + (y - terr.oy));
    }
  }

  function terrUp(e: PointerEvent) {
    if (!terr) return;
    if (terr.moved && carried) {
      /* Committed once, on release: the project's row, and every card that came
         with it. From here the rows are the position again. */
      if (terr.glass) onstickproject?.(terr.cwd, { x: carried.x, y: carried.y });
      else onplace?.(terr.cwd, carried.x, carried.y);
      for (const p of terr.pins) {
        const at = studio.placements[p.id];
        if (at) onpin?.(p.id, at.x, at.y);
      }
      /* One act for the territory *and* everything it carried. Recorded as one
         because it happened as one: a territory that came back while its cards
         stayed where the drag left them is a torn wall, and putting that right
         by hand is not something anybody should be asked to do with the same key
         they pressed to undo it. */
      if (terr.was) {
        const edits: Edit[] = [
          {
            at: "territory",
            id: terr.cwd,
            was: terr.was,
            now: terr.glass
              ? { ...terr.was, glassX: carried.x, glassY: carried.y }
              : { ...terr.was, x: carried.x, y: carried.y },
          },
          ...terr.pins.map(
            (p): Edit => ({
              at: "placement",
              id: p.id,
              was: p.was,
              now: placementOf(p.id),
            }),
          ),
        ];
        undo.did(
          terr.glass ? "moving a territory on the glass" : "moving a territory",
          edits,
        );
      }
      carried = null;
    }
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    terr = null;
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
      onpointerdown={(e) => terrDown(e, r, glass)}
      onpointermove={terrMove}
      onpointerup={terrUp}
      onpointercancel={terrUp}
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
      /* Shift adds to the gathering; a plain click starts a new one. */
      if (e.shiftKey) studio.toggle(n.conv.id);
      else studio.selectOnly(n.conv.id);
      onfocus(n.conv.id);
    }}
    onclose={() => onclose(n.conv)}
  />
{/snippet}

{#snippet reference(img: RefImage, glass: boolean)}
  <ImageNode
    {img}
    src={board.src(img)}
    selected={board.selected === img.id}
    scale={glass ? 1 : studio.scale}
    toCanvas={glass ? toGlass : toCanvas}
    onselect={() => {
      board.selected = img.id;
      board.bringToFront(img.id);
    }}
    onupdate={(patch) => board.update(img.id, glass ? glassPatch(patch) : patch)}
    onremove={() => board.remove(img.id)}
  />
{/snippet}

{#snippet instrument(w: Widget, glass: boolean)}
  <WidgetNode
    widget={w}
    selected={widgets.selected === w.id}
    scale={glass ? 1 : studio.scale}
    {meter}
    {ledger}
    {pomodoro}
    {devops}
    {billboard}
    {sink}
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
    onselect={() => {
      widgets.selected = w.id;
      /* One thing is held at a time: selecting a widget lets go of any
         reference image, or Delete would be aimed at whichever of them was
         picked first. */
      board.selected = null;
    }}
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
          onpointerdown={(e) => cardDown(e, n.conv.id, n.x, n.y)}
          onpointermove={cardMove}
          onpointerup={cardUp}
          onpointercancel={cardUp}
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
      onpointerdown={(e) => cardDown(e, n.conv.id, n.x, n.y, true)}
      onpointermove={cardMove}
      onpointerup={cardUp}
      onpointercancel={cardUp}
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
    cursor: grab;
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
     that area is pannable (`isGround` decides by what a press is *not* on); on
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
       `isGround` decides by what a press is *not* on, a territory can take its
       own events without swallowing a pan: right-clicking one is how you get a
       menu that knows which project you meant. */
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
