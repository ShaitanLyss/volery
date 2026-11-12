<script lang="ts">
  /* What a widget draws, whoever is holding it.

     Cut out of `WidgetNode.svelte`, which is a widget *on the wall* — its
     frame, its place, its resize grip — so that a reading can be drawn
     somewhere that is not the wall: the sheet the action palette opens over
     either view (`ReadingSheet.svelte`). A second copy of this switch for the
     sheet would be twelve arms kept in step by hand, and the first knob one of
     them gained would be a knob the other never heard of. So there is one
     switch, and the two holders differ only in what they hand it.

     Everything here is a reading of something handed in; nothing knows where
     it is drawn. A face sizes itself against its container (`cqw`/`cqh`), so
     whoever holds one owes it `container-type: size`. */
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
  import { duoPatch, runPatch, type Widget } from "./widgets";
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
  import Register from "./Register.svelte";
  import Gatehouse from "./Gatehouse.svelte";
  import ServerLog from "./ServerLog.svelte";
  import AppLog from "./AppLog.svelte";
  import Browser from "./Browser.svelte";
  import Screen from "./Screen.svelte";
  import BuildLog from "./BuildLog.svelte";
  import UnrealLog from "./UnrealLog.svelte";
  import Saying from "./Saying.svelte";
  import Plate from "./Plate.svelte";
  import { tetherOf } from "./tether";
  import type { Timelines } from "./timelines.svelte";
  import type { CardHandle } from "./cards.svelte";
  import type { Analytics } from "./analyticsholder.svelte";
  import type { ViewSpec } from "./analytics";
  import AnalyticsFace from "./AnalyticsFace.svelte";

  let {
    widget,
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
    onupdate,
    onreveal,
    cardOf = () => null,
    onopen,
    onkeyring,
    onforgerun,
    timelines,
    onreading,
    analytics,
    onanalyticsopen,
  }: {
    widget: Widget;
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
    /**  writes without an undo act — see . */
    /** `quiet` writes without putting an act on the undo stack, which is what a
     *  widget's own bookkeeping owes — see `widgets.svelte.ts::updateQuiet`. */
    onupdate: (patch: Partial<Widget>, quiet?: boolean) => void;
    onreveal?: (role: string, reference: string) => void;
    /** The card with this id, here or on another wall — what a widget that is
     *  a view of one card reads. A function rather than the cards, so the
     *  arm that needs it asks for exactly the one it names. */
    cardOf?: (id: string) => CardHandle | null;
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
    /** The plans cards have drawn — what a plate looks its timeline up in, and
     *  where its gestures go. Handed down for the reason the meter is. */
    timelines?: Timelines;
    /** A face that hangs a card over itself (a plate's hover) says so, so its
     *  holder can lift it over its neighbours while that card is open. */
    onreading?: (open: boolean) => void;
    /** The one analytics reader behind however many analytics widgets are up —
     *  idle, and reading no facts at all, until one attaches. */
    analytics: Analytics;
    /** Open a view in the overlay, where the controls that change it live.
     *  Routed out for the reason `onopen` is: which surface is on screen is the
     *  studio's business. */
    onanalyticsopen?: (view: ViewSpec) => void;
  } = $props();

  function setRun(run: Run) {
    onupdate({ config: { ...widget.config, ...runPatch(run) } });
  }

  function setDuo(duo: Duo) {
    onupdate({ config: { ...widget.config, ...duoPatch(duo) } });
  }
</script>

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
  {:else if widget.kind === "chronicle"}
    <!-- No holder threaded in: `chronicle` is a module singleton, for
         `journal`'s reason — the register and the header are the only things
         that want it, and threading it through here would put it in a file
         that is somebody else's. -->
    <Register {widget} onreveal={(id) => onreveal?.("conversation", id)} />
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
  {:else if widget.kind === "screen"}
    <!-- No holder threaded in: `casts` is a module singleton, because the
         focused overlay and chat view reach the same sessions from subtrees
         this file is not in (`cast.svelte.ts`). The zoom is handed down so
         the host is asked for the tile's size in device pixels. -->
    <Screen
      sid={widget.id}
      screen={typeof widget.config.monitor === "string" ? widget.config.monitor : "here/primary"}
      interactive={widget.config.interactive !== false}
      calm={widget.config.variant === "calm"}
      {scale}
    />
  {:else if widget.kind === "said"}
    <!-- The card, asked for by the id the widget carries. Null while it is
         not on the wall yet — a launch, or a wall not heard from — and the
         face says which; never for a card that closed, which took this
         widget down with it. -->
    <Saying
      {widget}
      card={cardOf(tetherOf(widget) ?? "")}
      onreveal={(id) => onreveal?.("conversation", id)}
    />
  {:else if widget.kind === "timeline" && timelines}
    <Plate {widget} {timelines} onreading={(open) => onreading?.(open)} />
  {:else if widget.kind === "analytics"}
    <!-- One spec, drawn small: the same `splitSeries` the room and the page
         draw, so the three surfaces cannot disagree about a number (§9.1). -->
    <AnalyticsFace
      {widget}
      {analytics}
      {onupdate}
      onopen={onanalyticsopen ? (view) => onanalyticsopen?.(view) : undefined}
    />
  {/if}
