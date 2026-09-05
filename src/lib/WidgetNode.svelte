<script lang="ts">
  /* One instrument on the wall: the frame, the one gesture it still answers for
   * itself, and whichever face its kind draws.
   *
   * The same shape `ImageNode` has, minus rotation — a reference photo pinned
   * at an angle is a reference photo, and a clock at an angle is a clock you
   * cannot read. Everything else is deliberately identical, because to the wall
   * these are the same kind of thing: hand-placed, freely sized, belonging to no
   * project. */

  import type { Meter } from "./meter.svelte";
  import type { Ledger } from "./ledger.svelte";
  import type { Cycle } from "./cycle.svelte";
  import type { DevOps } from "./devops.svelte";
  import type { Asana } from "./asana.svelte";
  import type { Board } from "./board.svelte";
  import type { Reading } from "./serverlog";
  import type { Build } from "./buildlog";
  import type { Editor } from "./unreallog";
  import type { Sink } from "./sink.svelte";
  import type { Beacon } from "./beacon.svelte";
  import type { Gates } from "./gates.svelte";
  import type { Pane } from "./pane.svelte";
  /* Aliased, because `Run` in this file is already a timer's two numbers off
     `./timing` one line below. Two different `Run`s in one component is the
     kind of collision that reads fine until somebody widens one of them. */
  import type { Run as ForgeRun } from "./azdo";
  import { duoPatch, frameOf, runPatch, specFor, type Widget } from "./widgets";
  import type { Duo, Run } from "./timing";
  import Clock from "./Clock.svelte";
  import Perf from "./Perf.svelte";
  import Cores from "./Cores.svelte";
  import Timer from "./Timer.svelte";
  import Pomodoro from "./Pomodoro.svelte";
  import Usage from "./Usage.svelte";
  import Speedo from "./Speedo.svelte";
  import Status from "./Status.svelte";
  import Spotify from "./Spotify.svelte";
  import Pipelines from "./Pipelines.svelte";
  import Reviews from "./Reviews.svelte";
  import Kanban from "./Kanban.svelte";
  import Tasks from "./Tasks.svelte";
  import Health from "./Health.svelte";
  import Billboard from "./Billboard.svelte";
  import Basin from "./Basin.svelte";
  import Gatehouse from "./Gatehouse.svelte";
  import ServerLog from "./ServerLog.svelte";
  import AppLog from "./AppLog.svelte";
  import Browser from "./Browser.svelte";
  import BuildLog from "./BuildLog.svelte";
  import UnrealLog from "./UnrealLog.svelte";

  let {
    widget,
    selected,
    scale,
    meter,
    ledger,
    pomodoro,
    devops,
    asana,
    billboard,
    sink,
    gates,
    pane,
    beacon,
    servers,
    onserverstart,
    builds,
    onbuildrun,
    editors,
    oneditoropen,
    names,
    naming,
    toCanvas,
    onupdate,
    onremove,
    onreveal,
    onopen,
    onkeyring,
    onforgerun,
  }: {
    widget: Widget;
    selected: boolean;
    /** Canvas zoom, so the handles stay a constant size on screen. */
    scale: number;
    meter: Meter;
    /** The one transcript reader behind however many usage widgets are up —
     *  handed down for the reason the meter is, and idle until one attaches. */
    ledger: Ledger;
    /** The studio's one cycle. Every pomodoro widget is a view onto it — see
     *  `pomodoro.svelte.ts` — so it is handed down rather than made here. */
    pomodoro: Cycle;
    /** The one Azure DevOps connection behind however many pipelines and
     *  reviews widgets are up — idle, and holding no credential, until one of
     *  them attaches. */
    devops: DevOps;
    /** The one Asana connection behind however many board widgets are up —
     *  idle, and reading nothing, until one attaches. Its own holder rather
     *  than a second reading off `devops`: a different service, a different
     *  credential and a different clock, and the only thing they have in common
     *  is that both leave the machine. */
    asana: Asana;
    /** The one billboard reader behind however many are up — idle, and reading
     *  nothing, until one attaches. Named `billboard` rather than `board`
     *  because the wall already has a `Board`: the reference images. */
    billboard: Board;
    /** The one sink reader behind however many are up — idle, and reading
     *  nothing, until one attaches. */
    sink: Sink;
    /** The one gate reader behind however many are up — idle, and reading
     *  nothing, until one attaches. Keyed by tree rather than by project: two
     *  cards on different worktrees of one project share a project and share no
     *  files. See `gates.svelte.ts`. */
    gates: Gates;
    /** The one browser connection behind however many browser widgets are up —
     *  handed down for the reason the meter and the ledger are, and holding no
     *  socket until one attaches. */
    pane: Pane;
    /** The one status reader behind however many claude-status widgets are up.
     *  Idle, and touching the network not at all, until one attaches — and it
     *  asks only while the window is in front. See `beacon.svelte.ts`. */
    beacon: Beacon;
    /** Every dev server group on the wall, flat. Unlike the four holders above
     *  there is nothing to attach to and no sampler to run: the lines arrive as
     *  `server:log` events for the panel's sake and a log widget is a second
     *  reading of state the wall already keeps. See `serverlog.ts`. */
    servers: Reading[];
    /** Bring a dev server group up. Routed out for the reason `onopen` is —
     *  the face knows what it is looking at, `Skein` knows what starting one
     *  means. */
    onserverstart: (groupId: string) => void;
    /** Every project on the wall and whatever it last ran, flat. Same bargain
     *  as `servers` one line up: the lines already exist because a chip on the
     *  territory's edge wanted them, so a build log is a second reading of live
     *  state rather than a sampler. See `buildlog.ts`. */
    builds: Build[];
    /** Press an action in a project. Routed out because `Actions.run` is where
     *  cancel-on-second-press, the fault bar and the poll kick live. */
    onbuildrun: (root: string, action: string) => void;
    /** Every Unreal project, its editor's state, and whatever has been tailed
     *  out of its log. The one log on this wall that had to be asked for; see
     *  `unreallog.ts`. */
    editors: Editor[];
    /** Open a project's editor, with its MCP server on, through the same
     *  `editor` action the territory's chips press. */
    oneditoropen: (root: string) => void;
    /** Conversation id → what that card is called, so a notice names its author
     *  in the words on the card. */
    names: Map<string, string>;
    naming: (role: string, reference: string | null) => string | null;
    toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
    onupdate: (patch: Partial<Widget>) => void;
    onremove: () => void;
    onreveal?: (role: string, reference: string) => void;
    /** Out of the app entirely, for the one thing on this wall that points
     *  somewhere else. Routed up rather than invoked in the face, the way every
     *  link in the transcript is — see `open.rs` for why an `<a href>` here
     *  would be a one-way trip out of an undecorated window. */
    onopen?: (url: string) => void;
    /** Ask for the Azure DevOps token panel — the pipelines face's fault line,
     *  which is the one fault on this wall you can act on. Routed for the same
     *  reason `onopen` is. */
    onkeyring?: () => void;
    /** Open one forge run's insides over the wall. Routed out rather than drawn
     *  in the widget for the reason `onkeyring` is: which panel is on screen is
     *  the studio's business, and a pipelines widget can be dropped to the size
     *  of a card, where a job list would not fit at all.
     *
     *  Named for the subsystem rather than `onrun`, which in this file already
     *  means a timer's run and a build's — the same collision `onbuildrun` was
     *  spelled around, and the precedent this follows. The asymmetry at the call
     *  site is therefore deliberate: `onforgerun` comes *in* to this component,
     *  and plain `onrun` goes *down* to `Pipelines`, where there is only one kind
     *  of run and nothing to spell around. */
    onforgerun?: (run: ForgeRun) => void;
  } = $props();

  /** A timer's own state rides in its config, so setting a run is an ordinary
   *  widget update and costs no new command — the whole reason `config_json` is
   *  one opaque column. The key names come from `widgets.ts` rather than being
   *  written out here, so a key spelled wrong is one place to fix rather than
   *  three. */
  function setRun(run: Run) {
    onupdate({ config: { ...widget.config, ...runPatch(run) } });
  }

  function setDuo(duo: Duo) {
    onupdate({ config: { ...widget.config, ...duoPatch(duo) } });
  }

  const spec = $derived(specFor(widget.kind));
  const hs = $derived(11 / scale);

  /* Moving one is not in here any more, and the resize is the whole of what
     this file still owns as a gesture.

     A widget can be selected alongside a card, a project and a reference image
     now, and dragging any member of a selection moves all of it — so the move
     belongs to the wall rather than to each thing moving only itself. `Canvas`
     hears the press through one capture-phase handler on the surface
     (`handleOf` finds this node by its `data-widget`) and applies one delta to
     everything held.

     That is also where "the press is a click until it has travelled" now lives
     for this node. It was here because a widget can hold buttons and capturing
     the pointer on `pointerdown` retargets the eventual `click` to this wrapper,
     silently swallowing every one of them — the same bug `Canvas.cardDown` had.
     The rule and the 4px are unchanged; they are stated once for the whole wall.

     The resize grip stays, and stays unconditional: nothing else is under it and
     it is small enough that requiring travel would make it feel stuck. It is
     marked `data-grip`, which is what tells `handleOf` to leave the press alone
     — a `button` is not enough on its own, and must not be: a card's whole body
     is one. Same marker on the take-it-down grip, which stops the wall carrying
     the widget out from under the click that removes it. */
  type Gesture = {
    ox: number;
    oy: number;
    w0: number;
    h0: number;
    px: number;
    py: number;
  };

  let gesture: Gesture | null = null;

  function begin(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    gesture = {
      ox: widget.x,
      oy: widget.y,
      w0: widget.w,
      h0: widget.h,
      px: p.x,
      py: p.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!gesture) return;
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    /* Free aspect, unlike an image: a clock stays square inside whatever box it
       is given, and a process list genuinely wants to be wider than it is tall.
       The floor is the widget's own, from the catalogue — below it the face
       stops saying anything and the handles start overlapping each other. */
    const min = spec?.min ?? { w: 60, h: 48 };
    onupdate({
      w: Math.max(min.w, gesture.w0 + (p.x - gesture.px)),
      h: Math.max(min.h, gesture.h0 + (p.y - gesture.py)),
    });
  }

  function end(e: PointerEvent) {
    if (!gesture) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    gesture = null;
  }
</script>

<div
  class="widget"
  data-widget={widget.id}
  data-kind={widget.kind}
  data-frame={frameOf(widget)}
  class:selected
  style:left="{widget.x}px"
  style:top="{widget.y}px"
  style:width="{widget.w}px"
  style:height="{widget.h}px"
  style:z-index={widget.z}
  role="presentation"
>
  <div class="face">
    {#if widget.kind === "clock"}
      <Clock {widget} />
    {:else if widget.kind === "performance"}
      <Perf {widget} {meter} {naming} {onreveal} />
    {:else if widget.kind === "cores"}
      <!-- Same holder as the meter above, which is the whole of the argument
           for it: one sampler however many readers. -->
      <Cores {widget} {meter} />
    {:else if widget.kind === "timer"}
      <Timer {widget} onrun={setRun} onduo={setDuo} />
    {:else if widget.kind === "pomodoro"}
      <Pomodoro {widget} {pomodoro} />
    {:else if widget.kind === "usage"}
      <Usage {widget} {ledger} />
    {:else if widget.kind === "burn"}
      <Speedo {widget} {ledger} />
    {:else if widget.kind === "status"}
      <Status {widget} {beacon} onopen={(url) => onopen?.(url)} />
    {:else if widget.kind === "spotify"}
      <!-- The one arm here that takes no holder: the face reaches `deck` — a
           module-level singleton with refcounted attach/detach — directly,
           rather than having one threaded down through `Canvas` and `App` for
           the single instrument on this wall that nothing else reads. -->
      <Spotify {widget} />
    {:else if widget.kind === "pipelines"}
      <Pipelines
        {widget}
        {devops}
        onopen={(url) => onopen?.(url)}
        onrun={onforgerun ? (run) => onforgerun?.(run) : undefined}
        onkeyring={onkeyring ? () => onkeyring?.() : undefined}
      />
    {:else if widget.kind === "reviews"}
      <Reviews {widget} {devops} onopen={(url) => onopen?.(url)} />
    {:else if widget.kind === "asana"}
      <!-- `onconfig` is this file's own `setRun`/`setDuo` one service over: a
           widget's chosen project rides in its config, so setting it is an
           ordinary widget update and costs no command — the whole reason
           `config_json` is one opaque column. -->
      <Kanban
        {widget}
        {asana}
        onopen={(url) => onopen?.(url)}
        onkeyring={onkeyring ? () => onkeyring?.() : undefined}
        onconfig={(key, value) =>
          onupdate({ config: { ...widget.config, [key]: value } })}
      />
    {:else if widget.kind === "asanatasks"}
      <Tasks
        {widget}
        {asana}
        onopen={(url) => onopen?.(url)}
        onkeyring={onkeyring ? () => onkeyring?.() : undefined}
      />
    {:else if widget.kind === "asanahealth"}
      <Health
        {widget}
        {asana}
        onopen={(url) => onopen?.(url)}
        onkeyring={onkeyring ? () => onkeyring?.() : undefined}
      />
    {:else if widget.kind === "billboard"}
      <Billboard
        {widget}
        board={billboard}
        {names}
        onreveal={(id) => onreveal?.("conversation", id)}
      />
    {:else if widget.kind === "sink"}
      <Basin
        {widget}
        {sink}
        {names}
        onreveal={(id) => onreveal?.("conversation", id)}
      />
    {:else if widget.kind === "gates"}
      <Gatehouse {widget} {gates} {names} />
    {:else if widget.kind === "serverlog"}
      <ServerLog {widget} groups={servers} onstart={onserverstart} />
    {:else if widget.kind === "buildlog"}
      <BuildLog {widget} {builds} onrun={onbuildrun} />
    {:else if widget.kind === "unreallog"}
      <UnrealLog {widget} {editors} onopen={oneditoropen} />
    {:else if widget.kind === "applog"}
      <!-- No props: the subject is the process, and there is only one. -->
      <AppLog {widget} />
    {:else if widget.kind === "browser"}
      <Browser {widget} {pane} />
    {/if}
  </div>

  {#if selected}
    <!-- `data-grip`: the resize runs its own gesture, and the wall's drag sits
         on an ancestor in the capture phase, so the marker is what tells
         `Canvas.handleOf` to leave this press alone. -->
    <button
      data-grip
      class="grip size"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:bottom="{-hs / 2}px"
      onpointerdown={begin}
      onpointermove={move}
      onpointerup={end}
      onpointercancel={end}
      aria-label="Resize"
    ></button>

    <button
      data-grip
      class="grip shut"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:top="{-hs / 2}px"
      onclick={onremove}
      aria-label="Take it down"
    ></button>
  {/if}
</div>

<style>
  .widget {
    position: absolute;
    cursor: grab;
    /* The faces size their type against this box — `cqw`/`cqh` in Clock and
       Perf — so a clock dragged large is a large clock rather than a small one
       in a large frame. */
    container-type: size;
    border: 1px solid var(--edge);
    border-radius: 3px;
    /* Opaque by default: the ambience is drawn behind everything on the wall,
       and an instrument you can see the weather through is not an instrument.
       The fill lives here and *only* here — no face paints its own, or a widget
       set `bare` would have the wall shown through the frame and then painted
       back over by the reading inside it. */
    background: var(--ink);
    overflow: hidden;
    transition: border-color 0.15s ease;
  }
  .widget:active {
    cursor: grabbing;
  }

  /* The two retreats, in the order the knob offers them. They must come *before*
     selection, which reveals the edge again on a widget that has none at rest,
     and at equal specificity that only works if it is read later. */
  .widget[data-frame="plate"],
  .widget[data-frame="bare"] {
    border-color: transparent;
  }
  .widget[data-frame="bare"] {
    background: transparent;
  }

  /* Selection puts the edge back and nothing else does. Hover used to as well,
     on the argument that a widget you cannot find the corner of is one you
     cannot drag — but the whole wall is draggable, and an edge that appears
     under the pointer is the wall reporting where the mouse is rather than
     saying anything about the instrument. The grips are already selection-only,
     so the edge and the handles now agree about what "picked up" means: the
     frame you set is what a widget wears until you select it. */
  .widget.selected {
    border-color: var(--paper-faint);
  }

  .face {
    width: 100%;
    height: 100%;
    /* Presses on the face carry the widget: everything inside is a reading, and
       the one thing that is not — a row you can click through to — takes its
       own press back. */
    user-select: none;
  }

  .grip {
    position: absolute;
    padding: 0;
    border: 1px solid var(--ink);
    background: var(--paper-dim);
    border-radius: 2px;
    cursor: nwse-resize;
    z-index: 2;
  }
  .grip:hover {
    background: var(--paper);
  }
  .grip.shut {
    border-radius: 50%;
    cursor: pointer;
    background: var(--st-fail);
  }
  .grip.shut:hover {
    background: color-mix(in srgb, var(--st-fail) 70%, var(--paper));
  }
</style>
