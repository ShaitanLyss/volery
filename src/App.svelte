<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import type { Conversation } from "./lib/conversation.svelte";
  import { clock } from "./lib/conversation.svelte";
  import { Attention } from "./lib/attention.svelte";
  import type { Tier } from "./lib/classify";
  import {
    READ_REST,
    Studio,
    layout,
    panelWidth,
    readingScale,
  } from "./lib/studio.svelte";
  import { Skein, type Session } from "./lib/skein.svelte";
  import { Board } from "./lib/images.svelte";
  import { Widgets } from "./lib/widgets.svelte";
  import { Undo } from "./lib/undo.svelte";
  import { shifted, standsOf, type Stand } from "./lib/undo";
  import { Meter } from "./lib/meter.svelte";
  import { crowds } from "./lib/crowds.svelte";
  import { releases } from "./lib/release.svelte";
  import { READY_LINE, sayOffer } from "./lib/update";
  import { Ledger } from "./lib/ledger.svelte";
  import { DevOps } from "./lib/devops.svelte";
  import { Cycle } from "./lib/cycle.svelte";
  import {
    WIDGETS,
    limitIn,
    optionFor,
    optionsOf,
    optionGroupsOf,
    runIn,
    textOf,
    variantsOf,
    VARIANT,
    type WidgetKind,
  } from "./lib/widgets";
  import {
    CADENCES,
    PERS,
    lengthLabel,
    overrun,
    said,
    standing,
  } from "./lib/timing";
  import Rest from "./lib/Rest.svelte";
  import Quit from "./lib/Quit.svelte";
  import { type BusyCard } from "./lib/quitting";
  import { groupOptions, type Reading } from "./lib/serverlog";
  import { FOLLOW } from "./lib/logface";
  import { projectOptions } from "./lib/buildlog";
  import { editorOptions } from "./lib/unreallog";
  import { Ambience } from "./lib/ambience.svelte";
  import { Actions, conflictBadge, conflictPrompt, NO_STATUS } from "./lib/actions.svelte";
  import { Control } from "./lib/control.svelte";
  import { ink } from "./lib/theme.svelte";
  import Canvas from "./lib/Canvas.svelte";
  import Dock from "./lib/Dock.svelte";
  import Dogears from "./lib/Dogears.svelte";
  import { Field } from "./lib/field.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import Effects from "./lib/Effects.svelte";
  import Import from "./lib/Import.svelte";
  import Themes from "./lib/Themes.svelte";
  import Accounts from "./lib/Accounts.svelte";
  import Keyring from "./lib/Keyring.svelte";
  import Guidance from "./lib/Guidance.svelte";
  import Overflow, { MORE_WIDTH } from "./lib/Overflow.svelte";
  import { foldChrome, type Fold, type Measured } from "./lib/chrome";
  /* `Carry` draws `Portage` — the same component/class split `Console` and
     `Shell` have, for the same case-insensitive-filesystem reason. */
  import Carry from "./lib/Carry.svelte";
  import { Portage } from "./lib/portage.svelte";
  import { waterfall } from "./lib/waterfall.svelte";
  import {
    completionFor,
    completionForChoice,
    resolveCommand,
    type Command,
  } from "./lib/commands";
  import { menuFor, type MenuItem, type MenuTarget } from "./lib/menu";
  import { presetById, presetPicks, type Preset } from "./lib/presets";
  import { spotOf } from "./lib/glass";
  import { selectionMarkdown } from "./lib/copy";
  import { displayName } from "./lib/naming";
  import { Drafts } from "./lib/drafts";
  import Transcript from "./lib/Transcript.svelte";
  import Servers from "./lib/Servers.svelte";
  import Processes from "./lib/Processes.svelte";
  /* The component is `Console` and the class it draws is `Shell`, which is not
     a whim: a `.svelte.ts` module and a `.svelte` component of the same name
     are one file to a case-insensitive filesystem, and TypeScript says so. The
     same split `cycle.svelte.ts` and `Pomodoro.svelte` already have. */
  import Console from "./lib/Console.svelte";
  import { Shell } from "./lib/shell.svelte";
  /* `!` in the dock: a shell line where a prompt goes. `bang.ts` is the pure
     half — what a draft means, how the line is coloured, where a completion
     lands — and `Bang` is the session behind it. See `.claude/rules/bang.md`. */
  import { Bang } from "./lib/bang.svelte";
  import {
    BANG,
    type Completion,
    type Match,
    applyCompletion,
    commandCursor,
    tokens,
  } from "./lib/bang";
  import { activeShellKey } from "./lib/shell";
  /* The finder behind the space-leader chords, and the file viewer it opens
     into. Same component/class split `Console` and `Shell` have, and forced
     the same way: `Spyglass.svelte` beside `finder.svelte.ts` rather than
     `Finder.svelte`, which would be one module path to two files. See
     `.claude/rules/finding.md`. */
  import Spyglass from "./lib/Spyglass.svelte";
  import { Finder } from "./lib/finder.svelte";
  import { Editor } from "./lib/nvim.svelte";
  import WindowControls from "./lib/WindowControls.svelte";

  const studio = new Studio();
  const skein = new Skein(studio);
  const board = new Board();
  const widgets = new Widgets();
  /* One stacking order for the whole wall (see layout.ts), so each of the two
     hand-placed things has to be able to see the other's z — otherwise "bring
     to front" would only mean "in front of the other clocks". */
  board.others = () => widgets.items.map((w) => w.z);
  widgets.others = () => board.images.map((i) => i.z);
  /* And one *selection* for the whole wall, for a related reason: a card, a
     territory, a widget and an image can all be held at once, so neither of
     these two registries may keep a selection of its own. `Studio` holds it and
     these say "what I have just put up is what you are holding" through it —
     see the note over `Studio.picks`. */
  board.picks = studio;
  widgets.picks = studio;
  /* Taking it back. One stack for the whole wall, and it holds no subscriptions
     and no timers, so unlike the four below it needs nothing releasing on
     destroy — its whole state is a plain value it can be handed back. */
  const undo = new Undo();
  /* Widgets and images write their own edits down, so every route to one — the
     menu, a drag, the control surface — is undoable by existing, and there is no
     second path that quietly is not. Placements and territories are recorded at
     their gestures' commit points instead; see the head of `undo.svelte.ts`. */
  board.scribe = undo;
  /* An agent pinned something. Rust copied it; the wall sizes it and puts it
     down — see `pin.rs`. Through `Board.pinned`, so it arrives at the same size,
     in the same z-band and on the same undo stack as a file you dropped. */
  skein.onPin = (path, x, y, mark) => void board.pinned(path, x, y, mark);
  /* And an agent changing one it already pinned rather than putting up a second
     copy of the same picture, which is the pile `pin.rs` exists to stop. */
  skein.onRepin = (id, change) => void board.repinned(id, change);
  widgets.scribe = undo;
  /* And how a step is put back. One function per realm, because this is the only
     place that holds all four of the things a step writes to. */
  undo.hand = {
    placement(id, p) {
      /* Whole-record writers, not the gestures beside them: `pin` and `unpin`
         each set one side of the row and leave the other standing, which is
         right for a person and wrong here — see `Studio.place`. */
      if (p) studio.place(id, p);
      else studio.forget(id);
      savePlacement(id);
    },
    widget(id, w) {
      if (w) widgets.put(w);
      else void widgets.remove(id);
    },
    image(id, i) {
      if (i) board.put(i);
      else void board.remove(id);
    },
    territory(cwd, at) {
      if (!at) return;
      const p = skein.projects.find((q) => q.root_path === cwd);
      if (!p) return;
      /* Each half only if it differs, and that is not tidiness:
         `placeProject(cwd, null, null)` is not a write but a request to re-pack
         (`#settlePlaces`), and asking for one that nobody's gesture asked for
         can move a territory this step was never about. */
      if ((p.x ?? null) !== at.x || (p.y ?? null) !== at.y) {
        skein.placeProject(cwd, at.x, at.y);
      }
      const spot =
        at.glassX === null || at.glassY === null
          ? null
          : { x: at.glassX, y: at.glassY };
      if ((p.glassX ?? null) !== (spot?.x ?? null) || (p.glassY ?? null) !== (spot?.y ?? null)) {
        skein.stickProject(cwd, spot);
      }
    },
  };
  /* The process sampler. Idle — and holding nothing — until a performance
     widget attaches to it. */
  const meter = new Meter();
  /* The transcript reader behind the usage widget. Idle — and reading nothing —
     until one attaches, which matters more here than for the sampler: the first
     reading walks every session file written in the past week. */
  const ledger = new Ledger();
  /* The one connection to Azure DevOps, behind however many pipelines and
     reviews widgets are up. Idle — and holding no credential — until one of them
     attaches, which matters more here than for either of the other two: this is
     the only thing in the app besides `git fetch` that leaves the machine, and a
     wall nobody is looking at must not be polling a corporate server. */
  const devops = new DevOps();
  /* Which organisations to ask about, read off the wall rather than configured:
     the AzDO orgs worth watching are the ones whose repos are standing on it.
     Injected as a function, the way `Cycle.watched` and `Widgets.others` are, so
     opening a folder brings its org into the reading on the next tick with
     nothing to re-wire. */
  devops.roots = () => skein.projects.map((p) => p.root_path);
  /* The studio's one pomodoro cycle. Not a widget's state — hang two pomodoro
     widgets up and they are two readings of one afternoon, and the break it
     enforces has to outlive every view of it. See `pomodoro.svelte.ts`. */
  const pomodoro = new Cycle();
  /* A cycle runs only while something on the wall is showing it — the same rule
     the process sampler has, and for the same reason: an instrument you took
     down should not still be running the room, least of all one whose breaks
     take the whole window. Removing the last view pauses rather than ends, so
     hanging one back up picks the same phase up where it was. */
  pomodoro.watched = () => widgets.has("pomodoro");
  /* The wall's own weather. Owns no subscriptions, so unlike the four below it
     needs nothing releasing on destroy. */
  const ambience = new Ambience();
  /* The shell behind Alt+I. Holds subscriptions and a batch timer, so it is
     released on destroy with the rest of them — and it holds a *process*, which
     the panel being toggled shut deliberately does not end. */
  const shell = new Shell();
  /* The finder behind `<space>ff` and `<space>fw`. Told where to look rather
     than reaching for it — the same injection `devops.roots` and
     `pomodoro.watched` use — because it asks the question the shell asks: which
     tree are you working in. It holds timers and no subscriptions, so it is
     released on destroy with the rest of them. */
  const finder = new Finder();
  /* The editor behind the finder's panel. One nvim per project and it outlives
     the panel switching back to a reading, so this is created once with
     everything else that holds subscriptions — and released below with them. */
  const editor = new Editor();
  finder.where = () => shellCwd();

  /* The `!` line. Given a way to find a card and a way to say something to one,
     rather than the whole of `Skein` — the same injection `devops.roots` and
     `widgets.others` use, and it keeps `bang.svelte.ts` unable to reach the
     wall. */
  const bang = new Bang(
    (id) => skein.convs.find((c) => c.id === id) ?? null,
    (conv, text) => skein.send(conv, text),
  );
  /* Project verbs. Its faults go to the same red bar everything else's do —
     a build that failed is not a different kind of news from a spawn that did. */
  const actions = new Actions((message) => (skein.fault = message));
  /* And which projects' editor logs are worth a thread, which is the same
     arrangement `pomodoro.watched` has one screen up: the holder may not reach
     into the widget registry, so it asks. Nothing is tailed on a wall with no
     editor log on it, which is most walls.

     A widget set to follow wants *every* Unreal project rather than a guess at
     which one — "whichever editor is open" cannot be resolved without the
     answer, and the reconcile filters to the ones actually running anyway. A
     widget pinned to one project wants only that. */
  actions.wantsEditorLog = () => {
    const up = widgets.items.filter((w) => w.kind === "unreallog");
    if (!up.length) return [];
    const named = up.map((w) => textOf(w, "project", FOLLOW));
    if (named.some((n) => !n || n === FOLLOW)) return Object.keys(actions.facts);
    return named;
  };
  const attention = new Attention(
    () => skein.convs,
    (id) => {
      /* The peek can now point at an instrument as well as a card, and they are
         reached differently: a widget has no transcript to open and is not in
         the layout, so it is selected and panned to rather than focused. */
      if (widgets.items.some((w) => w.id === id)) {
        studio.only("widget", id);
        canvas?.revealWidget(id);
        return;
      }
      focusedId = id;
      studio.selectOnly(id);
    },
    () => rungTimers(),
  );

  /** Countdowns that have run out, as things wanting your attention.
   *
   *  Built here rather than in `attention.svelte.ts` because it needs the
   *  catalogue's vocabulary, and rebuilt on the clock like everything else the
   *  peek reads. `project` is the small-caps label the peek prints, so it says
   *  what kind of instrument rang; `title` is what it was set for. */
  function rungTimers() {
    const now = clock.t;
    const out = [];
    for (const w of widgets.items) {
      if (w.kind !== "timer") continue;
      const limit = limitIn(w);
      if (limit === null) continue;
      const run = runIn(w);
      if (standing(run, limit, now) !== "rung") continue;
      out.push({
        id: w.id,
        project: "timer",
        title: lengthLabel(String(w.config.length ?? "")),
        kind: "rang" as const,
        detail: "time is up",
        waitedSeconds: Math.floor(overrun(run, limit, now)),
      });
    }
    return out;
  }

  /* These three own Tauri subscriptions and have no lifecycle of their own, so
     this component's is the one that has to release them. In dev that is not a
     nicety: Vite destroys and rebuilds App on every edit, and a superseded Skein
     goes on ingesting events and writing rows for a wall nobody can see — one
     `result` used to become two `turn` rows, one per generation. */
  onDestroy(() => {
    skein.detach();
    attention.detach();
    actions.detach();
    control.detach();
    shell.detach();
    finder.detach();
    editor.detach();
    bang.detach();
    /* Not a subscription but the same hazard: a superseded generation's sampler
       would go on enumerating every process on the machine every two seconds
       for a wall nobody can see. */
    meter.stop();
    ledger.stop();
    devops.stop();
    crowds.stop();
    releases.release();
  });

  /* Learn what each territory can do, and forget the ones that leave.
     `sync` is deliberately not called from inside the tracking scope: it reads
     `actions.facts` to decide what still needs probing and writes it when the
     answer comes back, which read synchronously here would be an effect that
     retriggers itself forever. */
  $effect(() => {
    const roots = skein.projects.map((p) => p.root_path);
    void Promise.resolve().then(() => actions.sync(roots));
  });

  /* What workflows are running, against what `crowds` is asking about.
     Reconciled from here because `conversation.svelte.ts` never talks to Rust
     and no single card can see the others: a workflow's journal directory is on
     its own job, and the poller wants the whole set at once so a wall with four
     workflows on it makes one call rather than four.

     A workflow whose receipt named no directory is left alone deliberately —
     the crowd then draws as it did before any of this, which is honest about
     what is known rather than a count of zero. */
  $effect(() => {
    const live = new Map<string, string>();
    for (const c of skein.convs) {
      for (const j of c.jobs) {
        if (j.kind === "workflow" && j.journalDir) live.set(j.toolId, j.journalDir);
      }
    }
    for (const [toolId, dir] of live) crowds.attach(toolId, dir);
    /* And stop asking about the ones that have settled. Untracked: reading the
       poller's own keys here would make this effect answer to the very state it
       writes, and every reading would re-run the reconciliation. */
    for (const toolId of untrack(() => Object.keys(crowds.watching))) {
      if (!live.has(toolId)) crowds.detach(toolId);
    }
  });

  /* One tick drives the peek: the clock already ticks for urgency decay, so
     reading it here means the peek reacts to a card going overdue without a
     second timer. */
  $effect(() => {
    void clock.t;
    void attention.items.length;
    void attention.focused;
    void attention.sync();
  });

  /* Whether there is a newer Volery, asked when you are looking at the window
     and not otherwise. Nothing emits an event when a tag appears, so this has to
     go and look — but focus *is* an event and `attention.focused` already folds
     it, so the trigger is you coming back to the wall rather than a clock. It
     runs once at mount, once per focus change, and stops for good once there is
     something to say. `release.svelte.ts` holds the three bounds and why each
     one is there; every failure of it is silence in the header. */
  $effect(() => {
    releases.watch(attention.focused);
  });

  /* And what version each project is on, for the same reason and off the same
     event. A pull or an editor save changes a package.json with nothing emitted
     to hear, and the facts behind the bump chip were read once when the project
     came onto the wall — so the arc went on offering a bump that had already
     been made. Coming back to the window is the boundary of having been away,
     which is when it can have changed. `Actions.refocus` holds the bounds. */
  $effect(() => {
    const focused = attention.focused;
    /* `untrack` for the reason the clock effect below gives: `refocus` reads
       `facts` to know which projects to re-probe and then *writes* it, so
       tracked it would re-run on every poll tick. Harmless today, since the
       gate answers no to anything that is not a transition — and exactly the
       sort of quiet self-feeding effect that becomes a real one the next time
       somebody edits either end of it. */
    void untrack(() => actions.refocus(focused));
  });

  let canvas = $state<ReturnType<typeof Canvas> | undefined>();
  /** The open panel, for the keys that move the reading. Undefined whenever
   *  there is no card focused, which is what makes those keys a no-op there
   *  without anything having to ask. */
  let transcript = $state<ReturnType<typeof Transcript> | undefined>();
  let showDetail = $state(true);
  let showServers = $state(false);
  /* Which card has its process list open, by id rather than by reference:
     a card that is closed while its list is up should take the list with
     it, and an id that no longer resolves is how that is noticed. */
  let showProcs = $state<string | null>(null);
  /* Resolved on every read rather than held. A card closed while its list
     is up takes the list with it; holding the object instead would keep a
     card on screen that the wall has already forgotten. */
  const procsFor = $derived(
    showProcs ? (skein.convs.find((c) => c.id === showProcs) ?? null) : null,
  );
  let showEffects = $state(false);
  let focusedId = $state<string | null>(null);
  /** What is being typed and what the typing currently means — the draft text,
   *  the palette's two stages, the `!` mode. `Dock.svelte` owns nearly all of
   *  it; the wall reads `field.preview` for the name an unnamed card is about
   *  to wear, which is the one reading that has to leave the dock, and is the
   *  reason this is a class rather than state inside the component. */
  const field = new Field();
  /** Every other card's unsent line, and the wall's own. See `drafts.ts`: one
   *  field over a wall of cards is one Enter away from saying what you wrote at
   *  one of them to another, and the parking is what stops it. */
  const drafts = new Drafts();
  /* The whole of the per-card behaviour, in the one place the focus is known to
     have moved. Deliberately an effect rather than something `focusCard` does:
     the focus is set from a dozen places — the wall, Tab, the attention list,
     opening a card, closing one — and a rule with a dozen call sites is a rule
     with one that forgot.

     `draft` is read untracked, or this would re-run on every keystroke and the
     swap would be a function of what you are typing rather than of where you
     are. */
  $effect(() => {
    const id = focusedId;
    if (drafts.holds(id)) return;
    /* A dismissal belongs to the draft it was made over, and a new draft has
       not been dismissed. Both flags are reset by their own effects when the
       text stops looking like a command or a shell line, so the only case left
       for here is the one they cannot see: landing on a card whose draft looks
       like exactly the same thing the last one did — which is why this is
       `reset` rather than an assignment to the text. */
    field.reset(drafts.switchTo(id, untrack(() => field.text)));
  });
  /** The dock's field, so typing on the wall can hand it the keystroke. */
  let prompt: HTMLTextAreaElement | undefined = $state();
  let spawning = $state(false);

  const focused = $derived(skein.convs.find((c) => c.id === focusedId) ?? null);

  /** The project whose card you touched last, which is the one whose shell the
   *  panel shows. Sticky: letting go of the wall — Escape, the ground click,
   *  closing the card — is not a statement about which shell you wanted, and a
   *  panel that snapped back to the first project every time you deselected
   *  would be one you could not leave pointing anywhere.
   *
   *  Chat cards do not move it. A chat card stands in a folder of Skein's own
   *  and has no project at all (`kind`), so following one would open a `pwsh`
   *  in the directory beside the database — a shell whose first command would
   *  have to be `cd` somewhere else. */
  let lastTouched = $state<string | null>(null);
  $effect(() => {
    const conv = focused;
    if (conv && conv.kind === "project") lastTouched = conv.cwd;
  });

  /* The panel follows the wall, open or shut.
     Which project is active is tracked either way — the shell's own verbs
     (stop, clear, close) act on it, and with the panel down they would
     otherwise have nothing to act on. It is `select` that declines to *start*
     anything while the panel is shut, so clicking past five cards does not
     leave five shells reading five profiles.

     Nothing to follow until the wall has been painted, and the guard is what
     keeps the `.` fallback out of the session list: that fallback belongs to
     Alt+I on an empty wall — a shell somewhere rather than no shell at all —
     and is not a project this should file a record under before `load` has
     said what the projects are. */
  $effect(() => {
    void shell.open;
    if (skein.projects.length) void shell.select(shellCwd());
  });

  /* Paint the wall from disk, then start the servers. Deliberately no agent. */
  $effect(() => {
    void skein.load();
    void board.load();
    void widgets.load();
    void ambience.load();
    void pomodoro.load();
  });

  /* The instruments run off the same one-second tick everything else does: the
     cycle's phase machine steps here, the running timers write down what they
     have earned about once a minute, and the day's spend notices midnight
     going past. All three are cheap when nothing has changed, and none of them
     is a second wake-up on an idle machine.

     `untrack` because all of them *write* — the cycle is `$state`, a beat
     patches a widget's config, and a rollover re-reads the figure — and an
     effect that re-ran on what it had just written would never stop. The clock
     is the only thing it may depend on. */
  $effect(() => {
    const t = clock.t;
    untrack(() => {
      pomodoro.tick(t);
      widgets.beat(t);
      skein.dayTick(t);
    });
  });

  /* Throw things at the wall and it works out what you meant: a folder becomes
     a conversation, an image gets pinned up. Tauri hands us real filesystem
     paths, so both are imports rather than browser blobs. */
  $effect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      /* The payload carries a PHYSICAL pixel position; getBoundingClientRect
         works in CSS pixels. On a 150% display those differ by 1.5×, so
         skipping this makes every drop land well off from where you aimed. */
      const dpr = window.devicePixelRatio || 1;
      const at = canvas?.toCanvas(
        e.payload.position.x / dpr,
        e.payload.position.y / dpr,
      );

      const sorted = await invoke<{ dirs: string[]; images: string[] }>(
        "classify_drop",
        { paths: e.payload.paths },
      );

      for (const dir of sorted.dirs) await openIn(dir);

      if (!at) return;
      let { x, y } = at;
      for (const path of sorted.images) {
        await board.add(path, x, y);
        /* Stagger a multi-file drop so they land as a small stack rather than
           perfectly on top of each other. */
        x += 28;
        y += 28;
      }
    });
    return () => {
      void un.then((f) => f());
    };
  });

  /* How loudly each tier is asking. Drives the Tab order and the count in the
     dock, so "what wants me" is defined in exactly one place — and, because
     Tab falls back to the wall when this list is empty, it also decides which
     of the two things Tab means at any moment. Ctrl+Tab walks the whole wall in
     reading order (`cycleConv`) — that is a navigation gesture and has nothing
     to do with urgency.

     A card you have set aside needs nothing here, deliberately: it is folded
     into `urgencyFor`, so it reads `rest` and falls out of this by the same
     rule everything else does. Filtering it out here instead would leave it
     out of the cycle while still blooming amber on the wall. */
  const URGENCY: Record<Tier, number> = {
    fail: 3,
    ask: 2,
    soft: 1,
    rest: 0,
    work: 0,
  };
  const waiting = $derived(
    skein.convs
      .filter((c) => !c.working && !c.dormant && URGENCY[c.tier] > 0)
      .sort(
        (a, b) => URGENCY[b.tier] - URGENCY[a.tier] || b.idleSeconds - a.idleSeconds,
      ),
  );

  /** Open a conversation somewhere. Nobody should ever type a path to do this:
   *  you either drop a folder on the wall, add one to a territory you already
   *  have, or pick a folder the way you pick a folder. */
  async function openIn(dir: string, worktree?: string, preset?: Preset) {
    if (spawning) return null;
    spawning = true;
    const conv = await skein.open(dir, worktree, preset);
    if (conv) {
      focusedId = conv.id;
      studio.selectOnly(conv.id);
    }
    spawning = false;
    return conv;
  }

  /** A card with no project and no reach onto this machine — see
   *  `Skein.openChat`. Guarded by the same `spawning` latch as `openIn`, since
   *  both cost a process and a double click on either should cost one card. */
  async function openChat() {
    if (spawning) return null;
    spawning = true;
    const conv = await skein.openChat();
    if (conv) {
      focusedId = conv.id;
      studio.selectOnly(conv.id);
    }
    spawning = false;
    return conv;
  }

  /** Put an agent on a half-finished merge.
   *
   *  A fresh card rather than a broadcast to whatever is standing in that
   *  territory: the cards already there are mid-thought on something else, and
   *  a conflict is its own piece of work with its own transcript worth keeping.
   *
   *  The status is read *now* rather than when the badge was drawn, so the
   *  prompt names the operation and the count the repo has at the moment you
   *  pressed it — the poll is eight seconds wide, and a merge finished in a
   *  terminal in between should not produce a card asking about conflicts that
   *  are no longer there. */
  async function resolveConflicts(cwd: string) {
    const status = actions.status[cwd];
    if (!status?.conflicts) return;
    const conv = await openIn(cwd);
    if (conv) await skein.send(conv, conflictPrompt(status));
  }

  /* Adoption: conversations that already exist on disk, from the CLI or from a
     card that was closed. The list is read when the panel opens rather than
     kept current — it is a catalogue of files, and scanning them all on a timer
     would be work nobody asked for. */
  let showImport = $state(false);
  /* The theme panel. `ink` itself is a module singleton — it has to be applied
     before the first paint, and the peek needs it too — so this flag is only
     whether the panel over it is up. */
  let showThemes = $state(false);
  let showAccounts = $state(false);
  /* The Azure DevOps token. Reachable from here *and* from the pipelines widget's
     fault line, which is where you actually find out you need one — a panel only
     in the menu is a panel nobody finds at the moment it would help. */
  let showKeyring = $state(false);

  /* Standing instructions — what you tell every card once instead of every
     turn. `null` while shut; open it *at* a scope, since the same panel is
     reached from the header (the wall) and from a territory's menu (that
     territory), and arriving on the wrong one is arriving somewhere you then
     have to navigate out of. See `.claude/rules/guidance.md`. */
  let guiding = $state<{ focus: string | null } | null>(null);
  let importing = $state(false);
  let sessions = $state<Session[]>([]);

  /* Carrying the wall off and bringing one in. See `.claude/rules/portage.md`:
     what a layout is and what it deliberately leaves behind. */
  const portage = new Portage({ skein, board, widgets, ambience, ink });
  let showCarry = $state(false);
  /** Territory roots that are not directories on this machine. Asked rather than
   *  derived, because it is a question about a disk.
   *
   *  Asked at three moments and on no clock: when the panel opens, after an
   *  import, and after a territory is rooted. A drive appearing is not something
   *  this app has to notice within a second, and a poll over `n` filesystem
   *  stats — one of which may be a share that has to time out — is exactly the
   *  fourth exception CLAUDE.md says has to earn its place. This does not. */
  let unrooted = $state<string[]>([]);

  async function askRoots() {
    try {
      unrooted = await invoke<string[]>("missing_roots", {
        paths: skein.projects.map((p) => p.root_path),
      });
    } catch {
      /* A territory wrongly drawn as rooted is the harmless direction: the
         actions on it fail the way they already do for a folder that has gone. */
      unrooted = [];
    }
  }

  async function openCarry() {
    showCarry = !showCarry;
    if (showCarry) await askRoots();
  }

  /* Re-asked while the panel is up and never otherwise — the same attach/detach
     bargain the usage widgets strike with `Ledger`. An import adds territories
     and rooting one changes a path, so the list of roots is the trigger for
     both; with the panel shut, nothing is asking and nothing is read. */
  const rootSig = $derived(skein.projects.map((p) => p.root_path).join("|"));
  $effect(() => {
    void rootSig;
    if (!showCarry) return;
    void askRoots();
  });

  async function openImport(force = false) {
    if (showImport && !force) {
      showImport = false;
      return;
    }
    showImport = true;
    importing = true;
    sessions = await skein.importable();
    importing = false;
  }

  async function adopt(s: Session) {
    const conv = await skein.importSession(s);
    if (!conv) return;
    focusedId = conv.id;
    studio.selectOnly(conv.id);
  }

  /* ── how wide the reading panel is ────────────────────────────────────
     Its left border is the handle. The panel is a column you set rather than
     one that sizes itself: what it holds — a table, a fence — scrolls inside
     itself, because re-measuring the paragraph somebody is halfway through
     reading is the same kind of wrong as reshuffling the wall when a card
     opens. The width is decided by `panelWidth` (pure, tested) and lives with
     the viewport, which is the other half of how this window is divided. */
  let winW = $state(window.innerWidth);
  const panelPx = $derived(panelWidth(studio.panelW, winW));
  let grip = $state<{ x: number; w: number } | null>(null);

  function gripDown(e: PointerEvent) {
    if (e.button !== 0) return;
    grip = { x: e.clientX, w: panelPx };
    /* Captured, because a 7px grip is not somewhere the cursor is going to
       stay: without this the drag would end the moment it crossed onto the
       wall, which is the direction that widens the panel. */
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    /* Deliberately no `preventDefault` here. The transcript is the one place in
       this app you are meant to be able to select text, so a drag starting on
       its edge does have to refuse that — but cancelling pointerdown suppresses
       the compatibility mouse events and takes `dblclick` with them, so
       `gripReset` below could never fire. Probed 2026-08-13 through the control
       surface: two real clicks on the grip left the panel where it was.
       `user-select: none` on `.grip` refuses the selection at the source
       instead, which costs nothing. */
  }

  function gripMove(e: PointerEvent) {
    if (!grip) return;
    /* The panel is on the right: leftwards is wider. */
    studio.panelW = panelWidth(grip.w + (grip.x - e.clientX), winW);
  }

  function gripUp() {
    if (!grip) return;
    grip = null;
    studio.save();
  }

  /* Back to fitting the window. Nothing else offers a way back, and a panel
     dragged to the wrong width on a monitor you are no longer at is otherwise
     something you have to drag back by eye. */
  function gripReset() {
    studio.panelW = null;
    studio.save();
  }

  /* ── how big the reading is ───────────────────────────────────────────
     The panel's other dimension, and the same shape of thing: decided by a
     pure function (`readingScale`), stored beside the viewport, and set by a
     gesture in the panel that is routed back out to here — Transcript does not
     own how this window is set up to be read from.

     Saved on the notch rather than debounced. A pan writes every frame, which
     is why the viewport's save is deferred; a wheel notch is discrete and
     there is no moment afterwards to hang a save on, the way the width's drag
     has its pointerup. */
  const reading = $derived(readingScale(studio.readScale));

  function setRead(next: number) {
    studio.readScale = next;
    studio.save();
  }

  /* ── the right-click ──────────────────────────────────────────────────
     Chromium's menu is suppressed globally in main.ts. What replaces it is
     decided in menu.ts and dispatched here: the component turns ids into calls
     and knows nothing about what the ids mean. Where a target has nothing to
     offer, `items` is empty and no menu opens at all. */
  let menu = $state<{
    x: number;
    y: number;
    items: MenuItem[];
    act: (id: string) => void;
  } | null>(null);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      skein.fault = "could not reach the clipboard";
    }
  }

  function onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el?.closest) return;
    e.preventDefault();
    menu = null;

    const field = el.closest("input, textarea") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const cardEl = el.closest("[data-conv]") as HTMLElement | null;
    /* The `+` on a territory, which has its own answer — see the branch. */
    const addEl = el.closest("[data-add]") as HTMLElement | null;
    const imageEl = el.closest("[data-image]") as HTMLElement | null;
    const widgetEl = el.closest("[data-widget]") as HTMLElement | null;
    /* Both the territory and the name that carries it — right-clicking the
       handle you just dragged should reach the project it belongs to. */
    const regionEl = el.closest("[data-cwd]") as HTMLElement | null;
    const selection = window.getSelection();
    const selected = (selection?.toString() ?? "").trim();

    /* Where on the wall this was, so anything the menu pins up lands under the
       cursor rather than at the origin. */
    const where = canvas?.toCanvas(e.clientX, e.clientY) ?? { x: 0, y: 0 };

    let target: MenuTarget | null = null;
    let act: (id: string) => void = () => {};

    if (field) {
      target = {
        kind: "editable",
        hasSelection: field.selectionStart !== field.selectionEnd,
        /* Reading the clipboard can be refused; offering an item that throws
           is worse than not offering it. */
        canPaste: typeof navigator.clipboard?.readText === "function",
      };
      act = async (id) => {
        const from = field.selectionStart ?? 0;
        const to = field.selectionEnd ?? 0;
        if (id === "select-all") return field.select();
        if (id === "copy" || id === "cut") {
          await copyText(field.value.slice(from, to));
          if (id === "cut") {
            field.setRangeText("", from, to, "end");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return;
        }
        if (id === "paste") {
          try {
            const text = await navigator.clipboard.readText();
            field.setRangeText(text, from, to, "end");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          } catch {
            skein.fault = "could not read the clipboard";
          }
        }
      };
    } else if (cardEl?.dataset.conv) {
      const conv = skein.convs.find((c) => c.id === cardEl.dataset.conv);
      if (conv) {
        focusedId = conv.id;
        studio.selectOnly(conv.id);
        target = {
          kind: "card",
          dormant: conv.dormant,
          pinned: !!studio.placements[conv.id]?.pinned,
          /* Its *own* spot, not whether it happens to be drawn on the pane. */
          glass: !!spotOf(studio.placements[conv.id]),
          /* A card drawn on the glass because its whole territory is stuck is
             not a card anybody stuck, and there is nothing honest for the item
             to say about it: "put it back on the wall" would be a promise it
             cannot keep, since the territory would still be carrying it. So it
             is not offered, which is a real answer here — see menu.ts. */
          held: heldByGlassTerritory(conv.cwd, conv.id),
          /* Something to clear means a turn taken or one under way — not a
             line on screen, which a *cleared* card still has (its own "cleared"
             note), and which would leave the item offered forever on a card
             with nothing left to clear. `working` earns its place: abandoning a
             first turn that is going wrong is exactly when this is wanted. */
          spoken: conv.everSpoke || conv.working,
          aside: conv.aside,
          bypassing: conv.bypassCaps,
          accounts: waterfall.list.length > 0,
        };
        act = (id) => {
          if (id === "wake") void skein.wake(conv);
          else if (id === "aside") skein.setAside(conv, !conv.aside);
          else if (id === "bypass") skein.setBypass(conv, !conv.bypassCaps);
          /* The session id is what `--resume` takes, and this is the only place
             the UI hands it over — see the note on adoption in CLAUDE.md. It is
             `sessionId` rather than `id`, or a cleared card would hand over a
             resume command for a session that never existed. */
          else if (id === "copy-resume")
            void copyText(`claude --resume ${conv.sessionId}`);
          else if (id === "copy-cwd") void copyText(conv.cwd);
          else if (id === "processes") showProcs = conv.id;
          else if (id === "clear") void skein.clear(conv);
          else if (id === "unpin") {
            const was = { ...studio.placements[conv.id] };
            studio.unpin(conv.id);
            savePlacement(conv.id);
            undo.did("letting a card flow again", [
              {
                at: "placement",
                id: conv.id,
                was,
                now: studio.placements[conv.id]
                  ? { ...studio.placements[conv.id] }
                  : null,
              },
            ]);
          } else if (id === "glass") canvas?.toggleGlass("card", conv.id);
          else if (id === "close") void closeConv(conv);
        };
      }
    } else if (imageEl?.dataset.image) {
      const id = imageEl.dataset.image;
      target = {
        kind: "image",
        glass: !!spotOf(board.images.find((i) => i.id === id)),
      };
      act = (which) => {
        if (which === "front") board.bringToFront(id);
        else if (which === "glass") canvas?.toggleGlass("image", id);
        else if (which === "remove") void board.remove(id);
      };
    } else if (widgetEl?.dataset.widget) {
      const id = widgetEl.dataset.widget;
      const w = widgets.items.find((w) => w.id === id);
      if (w) {
        /* A right-click aims the menu at exactly one thing, so it replaces the
           selection rather than adding to it — the same answer a plain left
           press on something unpicked gives. */
        studio.only("widget", id);
        const now = w.config[VARIANT];
        target = {
          kind: "widget",
          glass: !!spotOf(w),
          picks: variantsOf(w.kind).map((v) => ({
            id: v.value,
            label: v.label,
            on: v.value === now,
          })),
          /* A pomodoro's cadence is the *cycle's*, not this view's — there is one
             cadence for the studio, and two widgets offering their own would be
             two clocks telling different times. Those items are built by hand
             here for that reason rather than off `optionsOf`, which only ever
             knows about a widget's own config. Everything else is the catalogue —
             `optionsOf` is still asked, and has to be, or the knobs every widget
             has (its frame) would be missing from the one kind whose menu is
             partly written out here. */
          /* The accounts are handed in rather than reached for, because
             `widgets.ts` is pure and the registry is a rune. A knob that names
             a source gets its literal options plus whatever is resolved — see
             `Source` — so a wall with none registered simply offers "every
             account", which is the honest menu for it. */
          options:
            w.kind === "pomodoro"
              ? [...cycleOptions(), ...optionGroupsOf(w, widgetSources())]
              : optionGroupsOf(w, widgetSources()),
        };
        act = (which) => {
          if (which.startsWith("set:")) {
            widgets.set(id, VARIANT, which.slice(4));
          } else if (which.startsWith("cfg:")) {
            /* The cycle's two keys first, then anything else as the widget's
               own. Not an either/or on the kind: a pomodoro has a frame like
               everything else, and reading its `cfg:` items as cadence-or-
               nothing silently dropped every one of them. */
            const [key, ...rest] = which.slice(4).split(":");
            if (w.kind === "pomodoro" && (key === "cadence" || key === "per")) {
              pomodoro.set(key, rest.join(":"));
            } else {
              const o = optionFor(w, which);
              if (o) widgets.set(id, o.key, o.value);
            }
          } else if (which === "front") widgets.bringToFront(id);
          else if (which === "glass") canvas?.toggleGlass("widget", id);
          else if (which === "remove") void widgets.remove(id);
        };
      }
    } else if (addEl?.dataset.add && !skein.isChatHome(addEl.dataset.add)) {
      /* Ahead of the territory, and that order is the whole feature: the `+`
         stands inside the region, so without this branch a right-click on it
         opens the territory's menu — which is what it did, and which offers
         "new conversation here" with no say in what the card is set up as.

         Not offered on a chat territory. A chat card is spawned with two web
         tools and no model of its own worth choosing, and `onadd` already
         routes that `+` somewhere else entirely; see `chat.md`. */
      const cwd = addEl.dataset.add;
      target = { kind: "spawn", presets: presetPicks() };
      act = (id) => {
        if (id === "new") void openIn(cwd);
        else if (id.startsWith("preset:")) {
          void openIn(cwd, undefined, presetById(id.slice(7)));
        }
      };
    } else if (regionEl?.dataset.cwd) {
      const cwd = regionEl.dataset.cwd;
      target = {
        kind: "region",
        empty: !skein.convs.some((c) => c.cwd === cwd),
        moved: territoryMoved(cwd),
        glass: !!spotOf(skein.projects.find((p) => p.root_path === cwd)),
        chat: skein.isChatHome(cwd),
        offers: widgetOffers(),
      };
      act = (id) => {
        if (id === "glass") canvas?.toggleGlass("region", cwd);
        else if (id === "chat") void openChat();
        else if (id === "new") void openIn(cwd);
        else if (id === "new-worktree") canvas?.startBranch(cwd);
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
        else if (id.startsWith("widget:")) hangWidget(id.slice(7), where);
        else if (id === "reflow") {
          const before = stands();
          skein.placeProject(cwd, null, null);
          undo.did("settling a territory back in", moved(before));
        } else if (id === "guidance") {
          /* Opened on this territory, by id — the panel speaks the store's
             vocabulary and the wall speaks paths. A territory with no row is
             not a case: the region was drawn from one. */
          const p = skein.projects.find((x) => x.root_path === cwd);
          guiding = { focus: p?.id ?? null };
        } else if (id === "forget") {
          /* Same reasoning as a card being closed: the project row is gone, so
             an act about where its territory stood can never be applied. */
          undo.drop("territory", cwd);
          void skein.forgetProject(cwd);
        }
      };
    } else if (el.closest(".surface")) {
      target = {
        kind: "ground",
        offers: widgetOffers(),
        undoing: undo.goingBack,
        redoing: undo.goingForward,
      };
      act = (id) => {
        if (id === "undo") undo.back();
        else if (id === "redo") undo.forward();
        else if (id === "open") void pickFolder();
        else if (id === "chat") void openChat();
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
        else if (id.startsWith("widget:")) hangWidget(id.slice(7), where);
        else if (id === "fit") canvas?.fitAll();
        else if (id === "tidy") {
          /* One act for the whole wall — it was one gesture, and a tidy you can
             only take back a territory at a time is a tidy you cannot take
             back. */
          const before = stands();
          skein.tidyProjects();
          undo.did("tidying the territories", moved(before));
        }
        /* The ground is the thing the effects are drawn on, so this is where
           asking about them belongs. */
        else if (id === "ambience") showEffects = true;
        /* And what the wall tells every card standing on it, one scope out from
           the territory menu's own. */
        else if (id === "guidance") guiding = { focus: null };
      };
    } else if (selected) {
      /* Read-only prose — the transcript, mostly. */
      target = { kind: "prose", hasSelection: true };
      act = (id) => {
        /* The same markdown ctrl+C hands over, and taken now rather than then:
           opening a menu can cost the selection, and two routes to "copy" that
           put different text on the clipboard would be two clipboards. */
        if (id === "copy") void copyText(selectionMarkdown() || selected);
      };
    }

    const items = target ? menuFor(target) : [];
    if (!items.length) return;
    menu = { x: e.clientX, y: e.clientY, items, act };
  }

  /** Is this card on the glass only because its territory is?
   *
   *  Two ways to be drawn on the pane, and only one of them is a thing you did
   *  to the card. A territory carries its cards, so a card inside a stuck one
   *  is there without ever having been stuck — and the menu item, which is one
   *  state with two sides, has no side to be on. It is left off rather than
   *  offered as a no-op; see the note where it is passed. */
  function heldByGlassTerritory(cwd: string, id: string): boolean {
    if (spotOf(studio.placements[id])) return false;
    return !!spotOf(skein.projects.find((p) => p.root_path === cwd));
  }

  /** Write a card's placement down, whole.
   *
   *  Taken off `studio.placements` rather than passed in piece by piece,
   *  because the row now carries two positions that mean different things —
   *  where the card belongs on the wall and where it is drawn on the glass —
   *  and every call site that spelled out only the first would quietly clear
   *  the second. That is the same silent-drop shape as the `lastTier` bug the
   *  schema note in CLAUDE.md is about, and there is no error to see it by. */
  function savePlacement(id: string) {
    const p = studio.placements[id];
    skein.savePlacement(id, p ?? { x: 0, y: 0, pinned: false });
  }

  /** Where every territory stands right now, for the undo stack to compare
   *  against afterwards — see `standsOf`/`shifted` in `undo.ts` for why a
   *  territory gesture has to be observed rather than predicted. */
  const stands = () => standsOf(skein.projects);
  const moved = (before: Map<string, Stand>) => shifted(before, stands());

  /** Is this territory somewhere other than where the grid would have put it?
   *
   *  The counterpart to a card's "let it flow again": a territory dragged out
   *  into the far wall needs a way back that is not hunting for it. Offered only
   *  when it would do something — computed on the right-click rather than kept,
   *  since it is one layout pass and nothing else asks. */
  function territoryMoved(cwd: string): boolean {
    const p = skein.projects.find((p) => p.root_path === cwd);
    if (!p || p.x === null || p.y === null) return false;
    const flowed = layout(
      [],
      {},
      /* This one handed back to the grid, the rest holding their cells — so a
         territory sitting exactly where it was first put reads as unmoved. */
      skein.projects.map((q) =>
        q.root_path === cwd ? { ...q, x: null, y: null } : q,
      ),
    ).regions.find((r) => r.cwd === cwd);
    return !!flowed && (Math.abs(flowed.x - p.x) > 1 || Math.abs(flowed.y - p.y) > 1);
  }

  /** What the wall can be given, straight off the catalogue — so a new kind of
   *  widget appears in the menu by existing. */
  function widgetOffers(): { id: string; label: string }[] {
    return WIDGETS.map((w) => ({ id: w.kind, label: `hang up a ${w.label}` }));
  }

  /** Hang one at a point on the wall. Unlike a conversation it needs nothing
   *  else — no folder, no dialog, no process. */
  function hangWidget(kind: string, at: { x: number; y: number }) {
    void widgets.add(kind as WidgetKind, at.x, at.y);
  }

  /** The cycle's own knobs, as marked menu options — the shape `optionsOf`
   *  returns, so `ContextMenu` cannot tell the difference. Two groups' worth of
   *  choices in one list, which is what the widget menu already does with a
   *  clock's four toggles. */
  /** What each widget-knob `Source` resolves to right now.
   *
   *  `widgets.ts` is pure and cannot reach a rune, so the catalogue names a
   *  source and this hands over what it currently means. The same arrangement
   *  `cycleOptions` uses one line down, for the same reason: the menu knows
   *  things the catalogue is deliberately kept from knowing. */
  function widgetSources() {
    return {
      /* Empty until there is genuinely a choice, which drops the knob from the
         menu entirely — see `optionGroupsOf`. One account is not a choice, and
         a knob offering "every account" against a single account is a question
         with one answer. */
      accounts: waterfall.several
        ? waterfall.usable.map((a) => ({ value: a.label, label: a.label }))
        : [],
      /* And the same rule one line down: a wall with one dev server group has
         nothing to pin a log widget *to* — following it and naming it are the
         same answer — so the knob does not appear until a second group does. */
      groups: skein.groups.length > 1 ? groupOptions(serverReadings()) : [],
      /* And the same rule twice more. One project on the wall is not a choice
         either — following it and naming it are the same answer — so a build log
         gets no `watching` knob until there is a second project, and an editor
         log none until there is a second Unreal one. */
      projects: actions.builds().length > 1 ? projectOptions(actions.builds()) : [],
      editors: actions.editors().length > 1 ? editorOptions(actions.editors()) : [],
    };
  }

  /** Every dev server group, flat enough for a log widget to draw.
   *
   *  The same flattening `chipsFor` does for a territory's chips, and for the
   *  same reason: `GroupRuntime` is a rune class in `skein.svelte.ts`, and
   *  nothing between here and the face — `Canvas`, `WidgetNode` — has any
   *  business holding one. The log arrays are handed over by reference rather
   *  than copied: they are the 400 lines `skein.svelte.ts` caps them at, and a
   *  chatty `vite` would otherwise cost a copy of all of them per line. */
  function serverReadings(): Reading[] {
    return skein.groups.map((g) => ({
      id: g.group.id,
      label: g.group.label,
      project: skein.projectFor(g.group.project_id)?.name ?? "",
      running: g.running,
      overall: g.overall,
      servers: g.group.servers.map((s) => ({ label: s.label, port: s.port })),
      health: g.health,
      log: g.log,
    }));
  }

  /** The cycle's two knobs, as two groups — they are two questions (how long a
   *  stretch runs, and how many before a long break) and the menu now keeps
   *  knobs apart. */
  function cycleOptions(): { id: string; label: string; on: boolean }[][] {
    return [
      CADENCES.map((c) => ({
        id: `cfg:cadence:${c.value}`,
        label: c.label,
        on: c.value === pomodoro.cycle.cadence,
      })),
      PERS.map((p) => ({
        id: `cfg:per:${p.value}`,
        label: p.label,
        on: Number(p.value) === pomodoro.cycle.per,
      })),
    ];
  }

  /** What a performance row's role and reference are called up here.
   *
   *  This is the whole reason a process meter is worth having inside Skein:
   *  `perf.rs` can say "conversation 5f3c…" and nothing more, because the title
   *  of that card is front-end knowledge. Six identical `claude.exe` become six
   *  cards you can name. */
  function nameFor(role: string, reference: string | null): string | null {
    if (!reference) return role === "studio" ? "skein" : null;
    if (role === "conversation") {
      const c = skein.convs.find((c) => c.id === reference);
      return c ? displayName(c.title, c.project) : "a conversation";
    }
    if (role === "server") {
      const g = skein.groups.find((g) => g.group.id === reference);
      return g ? g.group.label : "a dev server";
    }
    if (role === "action") {
      /* A run id is `<cwd>:<action>` — the action alone is what reads, since
         the territory it belongs to is on the wall behind it. */
      const bit = reference.split(":").pop();
      return bit ? bit.replace(/-/g, " ") : "a build";
    }
    return null;
  }

  /** Clicking a row goes to the thing it is about. A meter that tells you which
   *  card is eating a core, and then makes you find it, has done half a job. */
  function revealRow(role: string, reference: string) {
    if (role !== "conversation") return;
    const conv = skein.convs.find((c) => c.id === reference);
    if (!conv) return;
    focusedId = conv.id;
    studio.selectOnly(conv.id);
    canvas?.reveal(conv.id);
  }

  /** Pin up an image from a file, at a point on the wall.
   *
   *  The counterpart to dropping one in from another window — which was the
   *  only way, and is no help when what you want is a file rather than
   *  something already on screen. Same path afterwards: `board.add` copies it
   *  into `$APPDATA/references/`, which is the only place the asset protocol
   *  will serve from. */
  async function pickImage(at: { x: number; y: number }) {
    const picked = await openDialog({
      multiple: true,
      title: "Pin up on the wall…",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"],
        },
      ],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    let { x, y } = at;
    for (const path of paths) {
      await board.add(path, x, y);
      /* Stagger, as a multi-file drop does — a stack you can pull apart beats
         several images landing exactly on top of each other. */
      x += 28;
      y += 28;
    }
  }

  /** Where the cursor last was, and whether it was over the wall at the time.
   *
   *  Deliberately not `$state`: a pointermove fires dozens of times a second and
   *  nothing here is drawn from it — it is read once, by a paste. Made reactive
   *  it would invalidate whatever happened to touch it on every mouse move. */
  let pointer = { x: 0, y: 0, onWall: false };

  function trackPointer(e: PointerEvent) {
    const el = e.target as Element | null;
    pointer = {
      x: e.clientX,
      y: e.clientY,
      onWall: !!el?.closest?.(".surface"),
    };
  }

  /** Paste a screenshot onto the wall, where the cursor is.
   *
   *  Drag-and-drop and the file picker both need the image to already be a file,
   *  and a screen capture is not one: Windows' capture tools put a bitmap on the
   *  clipboard and write nothing to disk. So the bytes come off the clipboard
   *  and Rust gives them a home — from there it is the same path a drop takes.
   *
   *  It listens for the `paste` event rather than reading
   *  `navigator.clipboard.read()`, which wants a permission the webview may
   *  prompt for or refuse outright. A paste is already a gesture you made, and
   *  the event carries the bytes with it — nothing has to be asked for.
   *
   *  The image goes where the *cursor* is, not where the keyboard focus is,
   *  because ctrl+V has no position of its own and the cursor is the only thing
   *  on screen that does. With the cursor off the wall — over the transcript, or
   *  never moved since launch — it goes to the middle of the view, which is at
   *  least somewhere you are looking. */
  async function onPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data) return;

    /* Read the files out synchronously: `clipboardData` is only valid during
       the event, so anything taken after the first await is gone. */
    const images = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;

    /* Text on the clipboard beside the image wins inside a field. Copying from
       a web page puts both there, and a paste into the draft you are writing
       means the words — pinning a picture up instead would be an ordinary
       ctrl+V doing something nobody asked for. Image-only in a field still
       pins: there is nothing else it could mean. */
    if (isTyping(e.target) && data.types.includes("text/plain")) return;

    e.preventDefault();

    const at =
      pointer.onWall && canvas
        ? canvas.toCanvas(pointer.x, pointer.y)
        : (canvas?.center() ?? { x: 0, y: 0 });

    let { x, y } = at;
    for (const file of images) {
      await board.paste(await file.arrayBuffer(), x, y);
      /* Stagger, as a multi-file drop does. */
      x += 28;
      y += 28;
    }
  }

  async function pickFolder() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Open a conversation in…",
    });
    if (typeof picked === "string") await openIn(picked);
  }

  /** The cards a prompt would reach right now. */
  const targets = $derived(
    studio.selected.length > 1
      ? skein.convs.filter((c) => studio.isSelected(c.id))
      : focused
        ? [focused]
        : [],
  );

  /** The reach of the draft, for the cards that draw it as their name-to-be.
   *
   *  Derived apart from `targets` so a keystroke does not re-derive the objects:
   *  this changes when the gathering does, which is rarely, and never while you
   *  are typing. */
  const targetIds = $derived(targets.map((c) => c.id));

  /* ── quitting while the wall is working ──────────────────────────────────
   *
   * Closing takes every card's process tree down, background jobs included, and
   * that is settled (`turns.md`, "a row is not a handle"). What this adds is the
   * sentence before it. The decision has to be readable from inside Rust's
   * `CloseRequested` handler, where there is no round trip to ask us anything —
   * so the count is written through as it changes, the same bargain
   * `set_mid_turn` strikes for a turn. */

  /** The cards holding background work, as the dialog would name them. */
  const busyCards = $derived<BusyCard[]>(
    skein.convs
      .filter((c) => c.jobs.length > 0)
      .map((c) => ({
        name: displayName(c.title, c.project),
        jobs: c.jobs.map((j) => j.label),
      })),
  );

  /* Depends on the *count* and not the list, so this fires when work starts or
     lands rather than every time a job's label sharpens. */
  const busyCount = $derived(busyCards.length);
  $effect(() => {
    void invoke("note_busy", { count: busyCount }).catch(() => {});
  });

  /** The cards named in the dialog, or null when it is not up.
   *
   *  Snapshotted when the close is refused rather than left reactive: this is a
   *  question about the moment you pressed close, and a list that rearranged
   *  itself under the pointer is one you cannot answer. */
  /** Take the update: download it, arm it, and then close the window.
   *
   *  Closing through the ordinary path on purpose, rather than exiting: a wall
   *  with background work on it gets to ask about that first (`quit.rs`), and if
   *  you then choose to stay, nothing has happened except a file in the data
   *  directory. `update.rs` launches the installer from the exit handler, after
   *  the supervisor is down — which is the only moment the exe it is replacing
   *  has actually been let go of. */
  async function takeUpdate() {
    if (await releases.fetch()) void getCurrentWindow().close();
  }

  let quitting = $state<BusyCard[] | null>(null);
  $effect(() => {
    const un = listen("app:quit-blocked", () => {
      quitting = busyCards;
    });
    return () => {
      void un.then((f) => f());
    };
  });

  /** Ids among the targets that have already edited the same files as another
   *  target. Recomputed when the gathering changes, never during typing. */
  let clashing = $state<string[]>([]);
  $effect(() => {
    const t = targets;
    if (t.length < 2) {
      clashing = [];
      return;
    }
    let live = true;
    void skein.sharedTree(t).then((ids) => {
      if (live) clashing = ids;
    });
    return () => {
      live = false;
    };
  });

  /* ── slash commands ────────────────────────────────────────────────────
   *
   * `commands.ts` owns the vocabulary and what a half-typed draft matches;
   * this is only the palette's state and the arm that runs each one — the same
   * split as `menu.ts` and `ContextMenu.svelte`.
   *
   * The rule that matters is that Skein reads *only* its own names. `claude`
   * has slash commands of its own and they work in `--print` mode, so `/commit`
   * is the project's and goes to the agent untouched; nothing here may swallow
   * a command it does not recognise. */

  /* ── the `!` line ──────────────────────────────────────────────────────
   *
   * `bang.ts` owns what a draft means and how it is coloured; `Bang` owns the
   * runs and the completion. This is the dock's half: which mode the field is
   * in, which card the line will run in, and the keys.
   *
   * The palette and this can never both be up — one needs a leading slash and
   * the other a leading bang — so nothing here has to negotiate with it. */

  /** Which card the line runs in.
   *
   *  One card, never the gathering, and the bar says which — a shell command
   *  runs in *a* directory, and broadcasting one would run it once per card in
   *  what is very often the same tree. Falling back to the first of a marquee
   *  gathering rather than to nothing, so a line typed over a selection with no
   *  ring still has somewhere honest to go, and the bar names it. */
  const bangCard = $derived(focused ?? targets[0] ?? null);

  /* An offering standing over a draft that is no longer a shell line would be a
     popup completing paths into a sentence. */
  $effect(() => {
    if (!field.banging) bang.close();
  });

  /** Run the line, and hand the result over if that is what was asked.
   *
   *  Cleared before the run rather than after, so the field is ready for the
   *  next thing while a build is still going — a `!` run does not own the dock,
   *  and the transcript is where it reports. */
  async function runBang(handOver: boolean) {
    const cmd = field.bangText;
    const card = bangCard;
    if (!cmd || !card) return;
    bang.close();
    field.text = "";
    await bang.run(card, cmd, handOver);
  }

  /** Put a completion into the line, and the caret after it.
   *
   *  The `!` is added back here because the shell was asked about the *command*
   *  and answers in the command's own offsets — see `commandCursor`. */
  async function takeCompletion(offer: Completion, match: Match) {
    const done = applyCompletion(field.text.slice(BANG.length), offer, match);
    field.text = BANG + done.cmd;
    bang.close();
    await tick();
    prompt?.setSelectionRange(
      done.cursor + BANG.length,
      done.cursor + BANG.length,
    );
  }

  /** Ask the shell what it would complete, and apply it if there is only one. */
  async function askCompletion() {
    const card = bangCard;
    if (!card) return;
    const cmd = field.text.slice(BANG.length);
    const at = commandCursor(field.text, prompt?.selectionStart ?? field.text.length);
    const only = await bang.complete(card, cmd, at);
    if (only) await takeCompletion(only.offer, only.only);
  }

  async function runCommand(cmd: Command, broadcast: boolean, arg = "") {
    /* Only the ones that act on cards need one. `/resume` acts on the wall —
       it offers the sessions on disk, which is the same offer whatever is
       standing in front of you — so an empty gathering is no reason to refuse
       it. */
    if (cmd.needsCard && targets.length === 0) return;
    /* A command that takes a value is not finished being chosen, so Enter on it
       means "show me them" rather than running anything — there is nothing yet
       to run. Tab does the identical thing, which is the point: at this row the
       two keys agree. One that takes prose is in exactly the same position with
       nothing typed after it, and gets the same answer: `/rename` names
       nothing, so Enter opens the space to write in. */
    if (cmd.choices || (cmd.takesText && !arg)) {
      field.text = completionFor(cmd);
      field.at = 0;
      return;
    }
    /* A command reaches as far as a prompt does and costs the same modifier —
       clearing five cards at once should not be easier than talking to them.
       Refused out loud, for `sendText`'s reason. Skipped for one that acts on
       no card: friction here is meant to scale with reach, and a panel opens
       once however many cards you are pointed at, so charging the modifier for
       it would be a toll on a number that is always one. */
    if (cmd.needsCard && targets.length > 1 && !broadcast) return field.refuse();
    /* The CLI's own commands are carried out by sending them. Skein has nothing
       to do here beyond having helped you type it: `/compact` goes down the
       same stdin as any prompt, and the agent answers it. */
    if (cmd.by === "cli") return sendText(`/${cmd.name}`, broadcast);
    field.text = "";
    field.at = 0;
    /* Forced open rather than `openImport()`, which toggles: toggling is the
       right answer for a button you press twice and the wrong one for a
       command, where typing the name is a request for the panel and never a
       request to put it away. Answered before the gathering is snapshotted,
       since this is the one command with nothing to act on. */
    if (cmd.name === "resume") return openImport(true);
    const on = [...targets];
    if (cmd.name === "clear") {
      for (const c of on) await skein.clear(c);
    } else if (cmd.name === "rename") {
      /* Reaching the whole gathering, like everything else here, and gated by
         the same modifier above. Renaming five cards to one word is a strange
         thing to want, but it is a strange thing you asked for twice — where a
         rename that silently only took on the focused card would be the dock
         quietly disagreeing with its own target line. */
      for (const c of on) await skein.rename(c, arg);
    }
  }

  /** Say something to every target, with the reach gate the dock's Enter has. */
  async function sendText(text: string, broadcast: boolean) {
    if (!text || targets.length === 0) return;
    /* Friction scales with reach: Enter sends to one, Ctrl+Enter to many.
       With permissions bypassed a broadcast is the most destructive gesture in
       the app, and one modifier is the cheapest possible insurance.

       The gate stays; what it no longer does is stay *quiet*. It used to return
       and say nothing — the press did nothing, the draft sat in the box, and
       the only thing separating that from a dead keyboard was that you were
       expected to have noticed `Ctrl ↵` already written beside the field. So
       the refusal flashes exactly that reading, which is the answer and is
       already on screen; anything more would be prose about a key. */
    if (targets.length > 1 && !broadcast) return field.refuse();
    field.text = "";
    field.at = 0;
    if (targets.length === 1) await skein.send(targets[0], text);
    else await skein.broadcast(targets, text);
  }

  async function send(broadcast = false) {
    /* With a value lit the line is complete, so Enter sends it. */
    if (field.choicePick && field.choosing) {
      return sendText(completionForChoice(field.choosing.cmd, field.choicePick), broadcast);
    }
    /* With the palette open the key means "run what is lit", exactly as it
       does in the CLI: `/cle` and Enter runs clear. */
    if (field.commandPick) return runCommand(field.commandPick, broadcast);

    const text = field.text.trim();
    if (!text || targets.length === 0) return;
    /* A command typed in full and sent without the palette ever opening —
       pasted, or completed and then dismissed. Only Skein's own arrive here:
       the CLI's, and every unknown name, fall through and go to the agent as
       the prompts they are. */
    const found = resolveCommand(text);
    if (found) return runCommand(found.cmd, broadcast, found.arg);

    await sendText(text, broadcast);
  }

  /** Step along the cards that want something, in urgency order.
   *
   *  Same both-ends rule as `cycleConv`, and it earns it more often here: the
   *  focused card is usually *not* in this list — you were reading one thing
   *  when another went amber — so `at < 0` is the common case rather than the
   *  cold-start one, and forwards has to mean the loudest while backwards
   *  means the quietest. */
  function cycleWaiting(step: 1 | -1) {
    if (waiting.length === 0) return;
    const at = waiting.findIndex((c) => c.id === focusedId);
    const to =
      at < 0
        ? step > 0
          ? 0
          : waiting.length - 1
        : (at + step + waiting.length) % waiting.length;
    focusCard(waiting[to]);
  }

  /** Step the focus along the wall: Tab forwards, shift+Tab back.
   *
   *  In the wall's own reading order (`wallOrder`) rather than open order,
   *  because what you are stepping through is what you are looking at. Cyclic,
   *  and with nothing focused Tab starts at the beginning while shift+Tab starts
   *  at the end — the two gestures should reach the same card from either end of
   *  a wall you have not touched yet. */
  function cycleConv(step: 1 | -1) {
    const order = canvas?.order() ?? [];
    if (order.length === 0) return;
    const at = order.findIndex((c) => c.id === focusedId);
    const to =
      at < 0
        ? step > 0
          ? 0
          : order.length - 1
        : (at + step + order.length) % order.length;
    focusCard(order[to]);
  }

  /** What Tab does, wherever it is pressed.
   *
   *  Tab is one gesture — "the next card I care about" — and what that means
   *  depends on whether anything is asking. With cards waiting, they *are* the
   *  next card you care about, and walking the whole wall past them is work you
   *  did not ask for; with none waiting, the wall is the only thing left to
   *  step through. So the plain key changes its footing under you, which is
   *  deliberate and is why Ctrl+Tab exists beside it: that one always walks the
   *  whole wall, so there is a key whose meaning does not move. It used to be
   *  the other way round — Ctrl for the waiting list — but the unmodified key
   *  should be the one aimed at the thing that wants you. */
  function cycleTab(step: 1 | -1, wholeWall: boolean) {
    if (!wholeWall && waiting.length > 0) cycleWaiting(step);
    else cycleConv(step);
  }

  /** Land on a card the way clicking it does.
   *
   *  Both halves matter: the gathering has to follow, or Tab would move the ring
   *  while the dock still pointed a broadcast at whatever was picked before it. */
  function focusCard(conv: Conversation) {
    focusedId = conv.id;
    studio.selectOnly(conv.id);
    canvas?.reveal(conv.id);
  }

  /** Let go of the card: no ring, no gathering, no panel.
   *
   *  Both halves again, and the focus is the half that was missing — clicking
   *  the ground cleared the gathering while leaving the card lit and its
   *  transcript open, so there was no way back to a bare wall short of closing
   *  a conversation. Having nothing in hand is a state the wall is meant to
   *  have: it is what the dock's "no card focused" says, and it is where the
   *  keystroke-to-the-field rule stops firing. */
  function ondeselect() {
    focusedId = null;
    studio.clearSelection();
  }

  function onDraftKey(e: KeyboardEvent) {
    /* A shell line borrows the same keys the palette does, and is checked first
       for the same reason. The two are mutually exclusive, so the order between
       them is arbitrary; what matters is that both come before the branches that
       assume the field holds prose. */
    if (field.banging) {
      const offer = bang.offer;
      /* With an offering up, the keys are the popup's. Bare arrows only —
         ctrl+arrow scrolls the transcript from wherever the keyboard is, which
         is a different question asked of a different part of the window. */
      if (offer) {
        if (
          (e.key === "ArrowDown" || e.key === "ArrowUp") &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          bang.move(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        /* Enter *completes* rather than running, which is where this
           deliberately parts company with the command palette. There, Enter
           runs what is lit, because the palette is for choosing what to do; here
           the popup is for choosing what to *type*, and a half-written path is
           the one moment you certainly did not mean to run anything. Escape
           first, then Enter, is how you run it. Tab agrees, as it does
           everywhere. */
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const lit = bang.lit;
          if (lit) void takeCompletion(offer, lit);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          bang.close();
          return;
        }
        /* Anything else typed invalidates the span the shell answered with, so
           the offering goes rather than being applied at an index the line no
           longer has. `applyCompletion` clamps as a backstop; this is the actual
           fix. */
        if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
          bang.close();
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        void askCompletion();
        return;
      }
      /* Up and Down walk this card's own `!` history. Free to take here in a way
         they are not in an ordinary draft: a shell line is one line, so there is
         no caret to move vertically. */
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.ctrlKey &&
        !e.metaKey &&
        bangCard
      ) {
        const was = bang.step(
          bangCard,
          e.key === "ArrowUp" ? -1 : 1,
          field.text.slice(BANG.length),
        );
        if (was !== null) {
          e.preventDefault();
          field.text = BANG + was;
          void tick().then(() =>
            prompt?.setSelectionRange(field.text.length, field.text.length),
          );
        }
        return;
      }
      if (e.key === "Escape") {
        /* One step back out: this leaves the shell line and keeps the text, and
           a second press does what Escape in a field always did. Stopped from
           bubbling, or the window's handler would blur the field on the same
           press and take both steps at once. */
        e.preventDefault();
        e.stopPropagation();
        field.bangOff = true;
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        /* Ctrl is what it is everywhere in this dock — the modifier that widens
           what the key reaches. It cannot mean "more cards" here, since a run is
           one directory, so it means the other thing a run can reach: the agent.
           Same friction, and the expensive gesture is still the one that costs a
           modifier. */
        e.preventDefault();
        void runBang(e.ctrlKey || e.metaKey);
        return;
      }
    }

    /* The palette borrows four keys while it is open, and gives them all back
       the moment it closes — which is why it is checked before anything else
       here rather than folded into the branches below. */
    if (field.palette) {
      /* However many rows are up, in whichever stage. */
      const rows = field.choices.length || field.commands.length;
      /* Bare arrows only. Ctrl+arrow scrolls the transcript from anywhere the
         keyboard happens to be, the palette included — it is a different
         question ("what does that answer say") asked of a different part of the
         window, and a palette open over the draft is no reason to stop
         answering it. Falling through here lets it reach the window. */
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        field.at = (Math.min(field.at, rows - 1) + step + rows) % rows;
        return;
      }
      if (e.key === "Escape") {
        /* The text stays. Dismissing is "I did not mean a command", not "undo
           what I typed" — and a draft beginning with a slash is a perfectly
           ordinary thing to say to an agent. */
        e.preventDefault();
        field.commandsOff = true;
        return;
      }
      /* Tab completes without running, which is how you read the detail line
         before committing to it. At the values it fills the whole line in, so
         the last thing before Enter is the command exactly as it will be sent. */
      if (e.key === "Tab" && (field.choicePick || field.commandPick)) {
        e.preventDefault();
        field.text =
          field.choicePick && field.choosing
            ? completionForChoice(field.choosing.cmd, field.choicePick)
            : completionFor(field.commandPick!);
        return;
      }
    }

    /* Tab reaches the wall from inside the field too — you write to one card,
       then step to the next without going by way of the mouse. */
    if (e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1, e.ctrlKey || e.metaKey);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(e.ctrlKey || e.metaKey);
    }
  }

  /** Which project's shell is the one on screen.
   *
   *  The last project you touched a card in, then whichever is first on the
   *  wall, then nowhere in particular. Only ever names a *project* — a card,
   *  a worktree card included, carries its project root as its `cwd`, so this
   *  is one key per territory rather than one per card.
   *
   *  Only ever consulted for which shell to show and where a *new* one starts:
   *  one already running is wherever you last `cd`'d it to, and moving it back
   *  because you clicked a card would be the app arguing with something you
   *  typed. */
  function shellCwd(): string {
    return activeShellKey(lastTouched, skein.projects.map((p) => p.root_path)) || ".";
  }

  async function onGlobalKey(e: KeyboardEvent) {
    /* Alt+I, from anywhere at all — the wall, the draft, the shell's own field.
       It is the one binding here that fires while you are typing, and it can
       afford to be: Alt+letter is not a text gesture Chromium binds, and this
       window has no menu bar for it to collide with (`decorations: false`).
       Checked before everything else because it is also how you get *out*. */
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      await shell.toggle(shellCwd());
      return;
    }
    /* An open shell owns the keyboard. Every branch below is aimed at the wall
       or at the reading, and the two that reach past a field regardless —
       ctrl+arrow's scroll and ctrl+0's reading size — would otherwise fire
       from inside a console into a transcript nobody is looking at. Escape and
       the history keys are the panel's own, handled in Shell.svelte. */
    if (shell.open) return;
    /* And an open finder owns it for the same reason, one panel over: every
       branch below is aimed at the wall or at the reading, and the finder's own
       keys — the arrows through the results, ctrl+F between its two modes,
       Escape back out of the viewer — are handled in `Spyglass.svelte` where
       the field it is typed into lives. */
    if (finder.open) return;

    /* The space-leader chords: `<space>ff` for a file by name, `<space>fw` for
       a word in one. Ahead of everything below because it has to beat the bare
       printable key at the bottom of this ladder, which would otherwise take
       the space into the focused card's draft.
     *
     * That branch is also the whole argument for space being free here. The
     * wall routes any printable key into the draft — but a prompt never
     * *begins* with a space, and by the time a space is a space the focus is in
     * the field and this ladder no longer runs at all. So the leader costs
     * nothing that was being used.
     *
     * `press` is the machine and it answers whether the key was ours: a second
     * key that completes no chord abandons the sequence and **falls through**,
     * the way `<space>q` in nvim leaves you with a `q`. Not called at all with
     * a modifier down or with a menu up, so ctrl+Z is still undo and the
     * sequence is not advanced by a gesture aimed somewhere else. */
    if (
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !menu &&
      !isTyping(e.target) &&
      finder.press(e.key)
    ) {
      e.preventDefault();
      return;
    }

    if (e.key === "F11") {
      e.preventDefault();
      const win = getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
      /* Round the ring of themes. A cycle and not a picker because the point
         of the thing is comparison: a picker costs two gestures per look and
         puts a menu over the reading you are trying to judge. One direction
         only — the ring is short and `paper` is always at the head of it, so
         the way back is never more than a few presses. Free here — the webview
         has no tab strip for ctrl+shift+T to reopen anything into. */
      e.preventDefault();
      ink.cycle(1);
    } else if (e.key === "Home" && !isTyping(e.target)) {
      /* Fit the wall — but only where Home has nothing else to mean. In a field
         it is the start of the line, and this branch called `preventDefault`,
         so the key was not merely doubled up: it was swallowed, and the caret
         did not move at all. Every other key here that a field has a use for is
         already guarded this way (Tab, Delete, and a bare printable character);
         Home was the one that was not.

         Note ctrl+arrow a few branches down is the deliberate exception, and it
         is only an exception because it costs a modifier a textarea does not
         bind. A bare key that means something to a field belongs to the field. */
      e.preventDefault();
      canvas?.fitAll();
    } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
      /* Back to the size the transcript always was — the same key that means
         that in every reader, and free here because the webview's own zoom
         hotkeys are off (Tauri 2 leaves `zoomHotkeysEnabled` false). It is
         worth having: ctrl+wheel is easy to turn by accident with a hand
         already on the wheel, and there is otherwise nothing that says what
         100% was. Aimed at the reading and not at the wall, which has Home. */
      e.preventDefault();
      setRead(READ_REST);
    } else if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === "z" || e.key === "Z" || e.key === "y" || e.key === "Y") &&
      /* A field keeps its own undo, and this is the one binding where that is
         not a courtesy: a textarea's undo is the browser's, it is what your
         hands expect while a prompt is half written, and there is nothing on
         this wall worth taking it for. Unlike ctrl+arrow a few branches down,
         which reaches past a field deliberately, ctrl+Z *is* a text gesture and
         the field is where it already means something. */
      !isTyping(e.target)
    ) {
      e.preventDefault();
      /* Ctrl+Y as well as Ctrl+Shift+Z, because both are what redo is called
         depending on where your hands learned it, and neither is spoken for
         here. */
      const forward = e.key === "y" || e.key === "Y" || e.shiftKey;
      if (forward) undo.forward();
      else undo.back();
    } else if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "PageUp" ||
        e.key === "PageDown")
    ) {
      /* Read the answer without touching the mouse.
       *
       * Deliberately *not* conditional on where the keyboard is. Everything else
       * on this wall that reaches past a field checks `isTyping` first, and this
       * one must not: the moment you most want to scroll an answer is the moment
       * you have just pressed Enter, and the caret is sitting in the draft then
       * — a binding that worked everywhere except there would fail exactly where
       * it is for. So it costs ctrl, which is what buys it the right to fire
       * inside the field. Bare arrows stay the caret's and bare page keys stay
       * the field's; ctrl+arrow is not a text gesture Chromium binds in a
       * textarea, so nothing is taken away.
       *
       * Aimed at the focused card alone, like Escape's stop — the panel only
       * ever shows one conversation, and a gathering has no reading to move.
       * With no panel open `transcript` is undefined and the keys are somebody
       * else's, hence the guard before `preventDefault`. */
      if (!transcript) return;
      e.preventDefault();
      const up = e.key === "ArrowUp" || e.key === "PageUp";
      transcript.step(e.key.startsWith("Page") ? "page" : "line", up ? -1 : 1);
    } else if (e.key === "Escape") {
      /* One step back out, innermost first. Anything that closes on Escape owns
         the key while it is open — the menu, the import panel and the theme
         panel all listen on the window themselves, so this only has to stay out
         of their way, and it runs first because App mounts before any of them.

         A field is a step of its own: Escape with the caret in the draft means
         "give the wall the key back", not "throw away what I aimed this at".
         Letting go of the card there would leave a written prompt pointed at
         nothing, so the draft survives and a second press does the deselect. */
      if (menu || showImport || showThemes || showAccounts || showKeyring || guiding) return;
      if (isTyping(e.target)) {
        (e.target as HTMLElement).blur();
        return;
      }
      /* A running turn is the innermost thing of all, so it is the first thing
         Escape reaches — which is also what the key does in Claude Code, and
         the hands arriving here already know that. It only ever takes the step
         it has: with nothing working, Escape lets go exactly as it always did,
         and a second press after a stop does the letting go.
         Aimed at the focused card alone, never at the gathering. A stop is
         cheap and undoable — the context survives, and you can say the next
         thing straight away — but firing one at everything a wide marquee
         happened to catch is not a gesture anybody means. */
      /* A `!` run is the innermost thing of all — more recent than a turn, and
         a card can be doing both at once — so it is what Escape reaches first.
         The same key, for the same reason it stops a turn: this is the thing
         this card is doing that you might want to take back. */
      if (focused?.bangCmd) void bang.stop(focused);
      else if (focused?.working) void skein.stop(focused);
      /* Escape backs out one kind at a time, innermost first, which is what it
         did while images and widgets each held a selection of their own. There
         is one selection now, spanning all four kinds, so these ask it rather
         than two singletons that used to clear each other. */
      else if (studio.pickedOf("image").length) studio.dropKind("image");
      else if (studio.pickedOf("widget").length) studio.dropKind("widget");
      else ondeselect();
    } else if (e.key === "Tab" && !isTyping(e.target)) {
      /* Tab means "the next card" everywhere on the wall, not only in the dock
         — the next card that wants you if any do, otherwise simply the next one
         along (`cycleTab`). It does cost the browser's own focus ring, which
         would otherwise walk a card's close button and the transcript's links —
         reachable by mouse, and not by Tab, deliberately: a card is the only
         thing on this wall there are dozens of, and stepping between them is
         what the key is for.
         Fields keep their Tab (`isTyping`); the draft field claims it back for
         this in onDraftKey, since that is where you already are when you want
         the next card. */
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1, e.ctrlKey || e.metaKey);
    } else if (
      (e.key === "Delete" || e.key === "Backspace") &&
      (studio.pickedOf("image").length || studio.pickedOf("widget").length) &&
      !isTyping(e.target)
    ) {
      e.preventDefault();
      /* Everything held of the two kinds this key may take down, not the first
         of them: with one selection spanning the wall, a Delete that removed one
         of four picked widgets would be a key that half-worked. Deliberately not
         cards or territories — closing a card takes an agent down with it, and
         forgetting a project refuses while anything is open there, so both stay
         gestures you have to name. */
      for (const id of studio.pickedOf("image")) void board.remove(id);
      for (const id of studio.pickedOf("widget")) void widgets.remove(id);
    } else if (
      /* Start typing with a card in hand and the words go to it. The wall has
         no single-letter shortcuts, so a printable key means only one thing —
         and reaching for the mouse to click a field you were already looking at
         is the sort of small tax that adds up across a day. */
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !menu &&
      targets.length > 0 &&
      !isTyping(e.target)
    ) {
      /* The character is carried across by hand rather than left to the
         browser: focus moves during this same keydown, and what happens to the
         keystroke that caused it is not something to leave to chance. */
      e.preventDefault();
      field.text += e.key;
      void focusDraft();
    }
  }

  function isTyping(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  /** Put the caret at the end of the draft, after the value has landed. */
  async function focusDraft() {
    await tick();
    prompt?.focus();
    prompt?.setSelectionRange(field.text.length, field.text.length);
  }

  /* The horizon saturates around $20 of the day's spend — far enough that a
     normal afternoon barely lifts it, close enough that a runaway wall is
     unmistakable without anyone reading a number. A day rather than a session,
     so restarting the app does not put the ground back to cold; see the note
     over `Skein.spend`. */
  const HORIZON_FULL_USD = 20;
  const burn = $derived(Math.min(1, skein.spend / HORIZON_FULL_USD));

  async function closeConv(conv: Conversation) {
    /* Closing is not undoable — it takes an agent down, and see the boundary at
       the head of `undo.ts` — so anything on the stack about where this card
       stood is a press that would appear to do nothing. It goes with the card. */
    undo.drop("placement", conv.id);
    /* Before the focus moves, so a line still being written is handed to the
       wall rather than parked under a card that no longer exists — which is the
       same as losing it. What the card had parked goes with the card. */
    field.text = drafts.release(conv.id, field.text);
    /* Both of these are ahead of the await for the reason `Skein.close` now puts
       the removal ahead of its own: everything the eye is owed by this gesture
       happens when the gesture happens, and none of it waits on a command that
       may not answer. The next card is found by *excluding* this one rather than
       by reading `convs[0]` afterwards, which is what makes it independent of
       when the removal lands rather than merely usually right. */
    if (focusedId === conv.id) {
      focusedId = skein.convs.find((c) => c.id !== conv.id)?.id ?? null;
    }
    await skein.close(conv);
  }

  /* The control surface, off unless SKEIN_CONTROL asked for it. It gets the
     same handles a pair of hands would — nothing here is a second code path,
     which is the only way a green run says anything about the real app. */
  const control = new Control({
    skein,
    studio,
    board,
    widgets,
    undo,
    meter,
    ledger,
    devops,
    pomodoro,
    ambience,
    attention,
    actions,
    shell,
    finder,
    bang,
    editor,
    canvas: () => canvas,
    focusedId: () => focusedId,
    setFocused: (id) => (focusedId = id),
    deselect: ondeselect,
    draft: () => field.text,
    setDraft: (t) => (field.text = t),
    commands: () => field.commands,
    choices: () => field.choices.map((c) => c.value),
    targets: () => targets,
    waiting: () => waiting,
    clashing: () => clashing,
    openIn,
    openChat,
    resolveConflicts,
    submit: send,
    flags: () => ({
      showDetail,
      showServers,
      showEffects,
      /* Reported separately from `shellLive`, because the panel being shut is
         not the shell being gone — that is the whole shape of the thing, and a
         surface that could not tell them apart could not test it. */
      showShell: shell.open,
      shellLive: shell.live,
      chime: attention.chime,
    }),
    setFlag: (name, value) => {
      if (name === "showDetail") showDetail = value;
      else if (name === "showServers") showServers = value;
      else if (name === "showEffects") showEffects = value;
      else if (name === "showShell") {
        if (value) void shell.show(shellCwd());
        else shell.hide();
      } else if (name === "chime") attention.chime = value;
    },
    shellCwd,
  });

  /* ── The header at narrow widths ──────────────────────────────────────────
     This bar is the title bar, and it used to be a flex row with no floor: it
     asks for about 1250px and the window may be 720, at which point every item
     shrank to its min-content and then spilled straight past the right edge.
     Losing `themes` off the end is a nuisance. Losing the window controls is a
     trap, because maximising is the gesture that would give you the room back,
     and it went over the edge with everything else.

     Two halves, and the order matters. The stylesheet holds the *guarantee*:
     `.cluster` may shrink to nothing and clip what does not fit, and nothing
     else in the bar may shrink at all — so the window controls stay reachable
     even on the first frame, before anything has been measured, and on a build
     where every line of measurement below is wrong. This is the *behaviour* on
     top of it: what to give up, and in what order, so that narrowing the window
     reads as the header getting shorter rather than as the header being cut
     off.

     It lives down here, past the surfaces it reads, only because `control` is
     one of them — the fold has to know how wide the control-surface note is.

     `chrome.ts` has the arithmetic and the tests. */

  /** Left to right as they are drawn, which is exactly the arrangement at full
   *  screen — the one the bar has always had. Fold order is a different list on
   *  purpose; nothing may reorder as the window narrows. */
  const BAR_ORDER = [
    "spend",
    "live",
    "zoom",
    "fit",
    "servers",
    "shell",
    "find",
    "ambience",
    "read",
    "adopt",
    "themes",
    "accounts",
    "guide",
    "token",
    "chime",
    "layout",
  ];

  /** Most important first: the order these are given up in.
   *
   *  Verbs before readings, because a reading is the one thing here you can
   *  also get by looking at the wall — the zoom is written on the cards, what
   *  is live is the cards that are moving, and the count is the cards
   *  themselves. `adopt` is kept longest of the verbs partly because it is the
   *  control surface's only handle on this bar (`data-adopt`), and a test
   *  driving a narrow window should not have to widen it first. `token` is the
   *  first of the verbs to go, being a panel you open once a year and then
   *  never again.
   *
   *  An item's key has to be in *both* lists or it is drawn nowhere at all —
   *  the bar iterates `BAR_ORDER` and the panel iterates what folded out of
   *  this one, so a `barButtons` entry in neither is a button that exists only
   *  in the array. `token` shipped that way for a release, with the panel
   *  reachable only from the pipelines widget's own fault line;
   *  `chrome.test.ts` now holds the three lists against each other.
   *
   *  Three things in the bar are deliberately absent from this list and never
   *  fold. The update offer, because an offer nobody is shown is not an offer.
   *  The control-surface note, because a surface that can drive the app must
   *  never be quietly on and a note inside a shut panel is quiet. And `open`,
   *  the one way into the app, which is why `minWidth` in `tauri.conf.json` is
   *  the floor it is. */
  const FOLD_ORDER = [
    "adopt",
    "read",
    "servers",
    "shell",
    "find",
    "fit",
    "themes",
    "ambience",
    "accounts",
    "guide",
    "chime",
    "layout",
    "token",
    "zoom",
    "live",
    "spend",
    "tag",
  ];

  /** The bar's `gap`, in px. Duplicated from the `.bar` rule below because the
   *  arithmetic needs a number and CSS is where the truth is; keep them in
   *  step. 0.7rem at the app's root size. */
  const BAR_GAP = 11.2;

  let bar: HTMLElement | undefined = $state();
  /** The bar's content width — inside its padding, which is what the items
   *  actually have. Zero until the observer's first callback. */
  let barW = $state(0);
  let folding = $state<Fold>({ shown: [], folded: [] });
  /** Nothing is given up before anything has been measured. The first paint
   *  therefore draws the full bar, which is right on a wide window and is
   *  corrected within a frame on a narrow one — where the clusters' own
   *  overflow is what stops it looking broken in the meantime. */
  let measured = $state(false);

  /** The foldable items that are in the bar at all right now — `spend` and
   *  `live` come and go with the wall. Decided in one place, because the ruler
   *  and the bar disagreeing about what exists is a measurement of something
   *  that is not there. */
  const barPresent = $derived(
    new Set(
      FOLD_ORDER.filter((k) =>
        k === "spend" ? skein.spend > 0 : k === "live" ? skein.live > 0 : true,
      ),
    ),
  );

  const shows = (key: string) =>
    barPresent.has(key) && (!measured || folding.shown.includes(key));

  /** Where an item sits in the bar, left to right. `tag` is the one foldable
   *  item drawn on the left of the drag region, so it is ahead of everything. */
  const drawAt = (key: string) => (key === "tag" ? -1 : BAR_ORDER.indexOf(key));

  /* Sorted back into drawing order for the panel, which is *not* the order the
     fold hands them over in — that is priority, and priority is nearly the
     reverse. The panel is a continuation of the bar rather than a list about
     it, so it should read in the same direction; an item does not change which
     side of the header it belongs to by being folded away. */
  const folded = $derived(
    measured
      ? folding.folded.filter((k) => barPresent.has(k)).sort((a, b) => drawAt(a) - drawAt(b))
      : [],
  );

  /** Every text in the bar that has a width, joined — so the fold is recomputed
   *  when a label changes and not only when the window is dragged. None of
   *  these change the bar's own size, so the observer below would never hear
   *  about them. */
  const barSig = $derived(
    [
      studio.lod,
      skein.convs.length,
      skein.projects.length,
      skein.live,
      skein.spend.toFixed(2),
      releases.stage,
      releases.offer?.version ?? "",
      releases.note ?? "",
      control.endpoint?.port ?? 0,
      spawning,
    ].join("|"),
  );

  $effect(() => {
    const el = bar;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width;
      if (typeof w === "number") barW = w;
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  $effect(() => {
    /* Both of the things that can change the answer, read for the dependency
       rather than for the value — the widths themselves come off the DOM. */
    void barSig;
    const width = barW;
    const el = bar;
    if (!el || width <= 0) return;

    /* A frame later, so the ruler has been laid out with whatever `barSig` just
       changed. Measuring in the same tick reads the previous paint's widths,
       which is a fold one keystroke behind. */
    const raf = requestAnimationFrame(() => {
      /* The ruler holds every foldable item at its natural width, always, and
         is never drawn — measuring the real ones would mean measuring the thing
         the measurement is about to change, which is how a fold flickers. The
         fixed items are measured from the bar itself, since those never fold
         and so cannot feed back. */
      const nat = new Map<string, number>();
      for (const n of el.querySelectorAll<HTMLElement>("[data-rule]")) {
        nat.set(n.dataset.rule ?? "", n.offsetWidth);
      }
      const fixed: Measured[] = [
        ...el.querySelectorAll<HTMLElement>("[data-fixed]"),
      ].map((n, i) => ({ key: `fixed${i}`, width: n.offsetWidth }));

      let room = width;
      for (const f of fixed) room -= f.width + BAR_GAP;

      const items: Measured[] = FOLD_ORDER.filter((k) => nat.has(k)).map((k) => ({
        key: k,
        width: nat.get(k) ?? 0,
      }));

      folding = foldChrome(room, items, BAR_GAP, MORE_WIDTH);
      measured = true;
    });
    return () => cancelAnimationFrame(raf);
  });

  /** The chrome toggles as data, so one description of each can be drawn in the
   *  bar, in the overflow panel, or into the ruler to be measured. Three copies
   *  of the same button in the markup would be three places for one of them to
   *  drift. */
  const barButtons = $derived(
    [
      { key: "fit", label: "fit", title: "Fit everything (Home)", press: () => canvas?.fitAll() },
      {
        key: "servers",
        label: "servers",
        on: showServers,
        press: () => (showServers = !showServers),
      },
      {
        key: "shell",
        label: "shell",
        title: "A shell over the middle of the wall (alt+I)",
        on: shell.open,
        press: () => shell.toggle(shellCwd()),
      },
      {
        key: "find",
        label: "find",
        title: "Find a file, or a word in one (space then f, then f or w)",
        on: finder.open,
        press: () => (finder.open ? finder.hide() : finder.show("files", shellCwd())),
      },
      {
        key: "ambience",
        label: "ambience",
        title: "What the wall does when nobody is asking it anything",
        on: showEffects,
        press: () => (showEffects = !showEffects),
      },
      { key: "read", label: "read", on: showDetail, press: () => (showDetail = !showDetail) },
      {
        key: "adopt",
        label: "adopt",
        title: "Put a conversation started elsewhere on the wall",
        on: showImport,
        /* `data-adopt` is the control surface's only handle on this button; the
           other chrome buttons are reachable by the panel they open. */
        adopt: true,
        press: () => void openImport(),
      },
      {
        key: "themes",
        label: "themes",
        title: "How the transcript is set — ctrl+shift+T cycles without opening this",
        on: showThemes,
        press: () => (showThemes = !showThemes),
      },
      {
        key: "accounts",
        label: "accounts",
        title: "Which Claude subscriptions this wall spends, and in what order",
        on: showAccounts,
        press: () => (showAccounts = !showAccounts),
      },
      {
        key: "guide",
        label: "instructions",
        title:
          "What every card is told before you say anything — for the whole wall, and per project",
        on: !!guiding,
        press: () => (guiding = guiding ? null : { focus: null }),
      },
      {
        key: "token",
        label: "azdo token",
        title: "A personal access token for Azure DevOps, when the credential git holds isn't enough for builds",
        on: showKeyring,
        press: () => (showKeyring = !showKeyring),
      },
      {
        key: "chime",
        label: "chime",
        title: "Play a soft chime when a card wants you and Skein isn't focused",
        on: attention.chime,
        press: () => (attention.chime = !attention.chime),
      },
      {
        key: "layout",
        label: "layout",
        title: "Carry this wall off as a file, or bring one in — and root a territory whose folder is not here",
        on: showCarry,
        press: () => void openCarry(),
      },
    ] as { key: string; label: string; title?: string; on?: boolean; adopt?: boolean; press: () => void }[],
  );

</script>

<svelte:window
  onkeydown={onGlobalKey}
  onpaste={onPaste}
  onpointermove={trackPointer}
  bind:innerWidth={winW}
/>

<div
  class="studio"
  style:--burn={burn}
  oncontextmenu={onContextMenu}
  role="presentation"
>
  <!--
    One description of each foldable item, drawn in three places: across the bar
    when there is room, inside the overflow panel when there is not, and into
    the ruler below to be measured. Three copies in the markup would be three
    places for one of them to drift.

    `mute` is the ruler's copy — same element, same classes, therefore the same
    width, but no handler and no `data-adopt`, because the control surface finds
    its button by selector and must not find a hidden one.
  -->
  {#snippet chromeItem(key: string, mute: boolean)}
    {#if key === "tag"}
      <span class="tag" data-tauri-drag-region>
        {skein.convs.length} card{skein.convs.length === 1 ? "" : "s"} ·
        {skein.projects.length} project{skein.projects.length === 1 ? "" : "s"}
      </span>
    {:else if key === "spend"}
      <!-- Dated in the tooltip, because a day's spend and a session's are the
           same six characters and only one of them survives a restart. -->
      <span
        class="spend"
        title="spent today · {skein.heldTokens.toLocaleString()} tokens held across the wall"
        >${skein.spend.toFixed(2)}</span
      >
    {:else if key === "live"}
      <span class="livecount">{skein.live} live</span>
    {:else if key === "zoom"}
      <span class="zoom" title="Semantic zoom — wheel; shift+wheel pans">{studio.lod}</span>
    {:else}
      {@const b = barButtons.find((x) => x.key === key)}
      {#if b}
        <button
          class="ghost"
          class:on={b.on}
          data-adopt={b.adopt && !mute ? true : undefined}
          title={b.title}
          onclick={mute ? undefined : b.press}>{b.label}</button
        >
      {/if}
    {/if}
  {/snippet}

  <!-- This bar IS the title bar. Undecorated window, so dragging, double-click
       to maximise, and the window buttons all live here. -->
  <header class="bar" data-tauri-drag-region bind:this={bar}>
    <!-- Never drawn, never reachable, and the only honest place to read a
         natural width from: measuring the real items would mean measuring the
         thing the measurement is about to change, which is how a fold gets into
         a loop with itself. `inert` so nothing in here can be tabbed to or
         clicked, and absolutely placed so it costs the bar no room. -->
    <div class="ruler" aria-hidden="true" inert>
      {#each FOLD_ORDER as key (key)}
        {#if barPresent.has(key)}
          <span class="rule" data-rule={key}>{@render chromeItem(key, true)}</span>
        {/if}
      {/each}
    </div>

    <span class="wordmark" data-tauri-drag-region data-fixed>Volery</span>
    {#if shows("tag")}
      {@render chromeItem("tag", false)}
    {/if}
    <span class="grow" data-tauri-drag-region></span>
    <!--
      A newer Volery. Quiet until there is one, and then one button rather than a
      dialog: an update is an offer, and an offer that interrupts you is a
      demand. It says the version so the answer to "is it worth it" is one click
      away in the release notes rather than behind this.

      Everything about *whether* to draw this is `update.ts`; everything about
      what happens when it is pressed is `release.svelte.ts` and `update.rs`.
    -->
    {#if releases.stage !== "quiet" && releases.offer}
      <span class="uproll" data-fixed>
        {#if releases.stage === "offered"}
          <button
            class="ghost up"
            onclick={() => void takeUpdate()}
            title="Download {releases.offer.version} and install it on the way out. Volery will close and come back up.">
            {sayOffer(releases.offer)}
          </button>
        {:else if releases.stage === "fetching"}
          <span class="upnote">{releases.note ?? "downloading"}</span>
        {:else if releases.stage === "armed"}
          <span class="upnote">{READY_LINE}</span>
        {:else if releases.stage === "failed"}
          <button
            class="ghost up bad"
            onclick={() => void takeUpdate()}
            title={releases.note ?? "the download failed"}>update failed &mdash; retry</button>
        {/if}
      </span>
    {/if}
    <!-- A surface that can drive the app must never be quietly on — which is
         also why this is not in `FOLD_ORDER`: a note inside a shut panel is
         quiet. -->
    {#if control.endpoint}
      <span
        class="ctl"
        data-fixed
        title="External control is listening on 127.0.0.1:{control.endpoint.port}"
        >control :{control.endpoint.port}</span
      >
    {/if}
    <!-- The cluster that gives way. `min-width: 0` and its own `overflow` are
         the guarantee: whatever the measurement below decides, this is the only
         thing in the bar that may shrink, so the open button and the window
         controls cannot be pushed off the edge. The fold is what makes that
         graceful rather than a clipped word. -->
    <!-- The drag region is repeated here because the gaps between these buttons
         used to belong to the bar itself, and the bar is how an undecorated
         window is moved. A new wrapper that swallows a strip of draggable title
         bar is a window that is slightly harder to pick up than it was. -->
    <div class="cluster" data-tauri-drag-region>
      {#each BAR_ORDER as key (key)}
        {#if shows(key)}
          {@render chromeItem(key, false)}
        {/if}
      {/each}
    </div>
    <Overflow count={folded.length}>
      {#each folded as key (key)}
        {@render chromeItem(key, false)}
      {/each}
    </Overflow>
    <button class="open" onclick={pickFolder} disabled={spawning} data-fixed>
      {spawning ? "opening…" : "Open a folder…"}
    </button>
    <!-- Wrapped so its footprint can be measured with everything else that does
         not fold. The wrapper is transparent to the layout: `.controls` keeps
         the negative margins that carry it out to the true window corner, and
         `align-self: stretch` here is what lets it fill the bar's height the
         way it did as a direct child. -->
    <span class="anchor" data-fixed><WindowControls /></span>
  </header>

  {#if skein.fault}
    <button class="fault" onclick={() => (skein.fault = null)}>{skein.fault}</button>
  {/if}

  {#if menu}
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menu.items}
      onpick={(id) => {
        menu?.act(id);
        menu = null;
      }}
      onclose={() => (menu = null)}
    />
  {/if}

  {#if showAccounts}
    <Accounts onclose={() => (showAccounts = false)} />
  {/if}

  {#if showThemes}
    <Themes onclose={() => (showThemes = false)} />
  {/if}

  {#if showKeyring}
    <Keyring {devops} onclose={() => (showKeyring = false)} />
  {/if}

  {#if guiding}
    <Guidance
      {skein}
      focus={guiding.focus}
      onclose={() => (guiding = null)}
    />
  {/if}

  {#if showCarry}
    <Carry
      carry={portage}
      projects={skein.projects}
      {unrooted}
      onclose={() => (showCarry = false)}
    />
  {/if}

  {#if showImport}
    <Import
      {sessions}
      loading={importing}
      onpick={adopt}
      onclose={() => (showImport = false)}
    />
  {/if}

  {#if showServers}
    <Servers {skein} {actions} />
  {/if}

  {#if procsFor}
    <Processes
      {meter}
      id={procsFor.id}
      title={procsFor.title || 'conversation'}
      onclose={() => (showProcs = null)}
    />
  {/if}

  {#if showEffects}
    <Effects {ambience} />
  {/if}

  {#if shell.open}
    <Console {shell} />
  {/if}

  <!-- Drawn for a *pending chord* as well as for an open panel, and that is why
       the hint lives in `Spyglass.svelte` rather than here: a leader sequence is
       the one gesture on this wall with no affordance at all, and a component is
       the only CSS scope this codebase has. Putting a `.hint` in App's 565-line
       stylesheet is how `.ghost` came to mean two things. -->
  {#if finder.open || finder.pending !== null}
    <Spyglass {finder} {editor} />
  {/if}

  <main class="wall" class:sizing={!!grip}>
    <!-- A project with no cards is still a place on the wall, and the only
         place its "+" lives — so an empty territory keeps the canvas up. -->
    {#if skein.convs.length || skein.projects.length || board.images.length || widgets.items.length}
      <Canvas
        bind:this={canvas}
        convs={skein.convs}
        projects={skein.projects}
        {studio}
        {board}
        {widgets}
        {undo}
        {pomodoro}
        {meter}
        {ledger}
        {devops}
        naming={nameFor}
        onreveal={revealRow}
        onopen={(url) => void skein.openLink(url)}
        onkeyring={() => (showKeyring = true)}
        ambience={ambience.active}
        flights={skein.flights}
        lineage={skein.kin}
        billboard={skein.board}
        sink={skein.sink}
        {focusedId}
        draft={field.preview}
        draftIds={targetIds}
        chipsFor={(cwd) => {
          const c = skein.convs.find((c) => c.cwd === cwd);
          if (!c) return [];
          return skein.groupsFor(c.projectId).map((g) => ({
            id: g.group.id,
            label: g.group.label,
            state: g.overall,
            running: g.running,
          }));
        }}
        actionsFor={(cwd) => actions.chipsFor(cwd)}
        conflictFor={(cwd) => conflictBadge(actions.status[cwd] ?? NO_STATUS)}
        onaction={(cwd, id) => void actions.run(cwd, id)}
        onresolve={(cwd) => void resolveConflicts(cwd)}
        onadd={(dir, wt) =>
          /* The chat territory's `+` means the thing that territory holds.
             Routed here rather than in `Canvas`, which knows where a territory
             is drawn and has no business knowing what belongs in one. */
          skein.isChatHome(dir) ? openChat() : openIn(dir, wt)}
        onserver={(groupId) => {
          const g = skein.groups.find((g) => g.group.id === groupId);
          if (!g) return;
          void (g.running ? skein.stopGroup(g) : skein.startGroup(g));
        }}
        builds={actions.builds()}
        onbuildrun={(root, action) => void actions.run(root, action)}
        editors={actions.editors()}
        oneditoropen={(root) => void actions.run(root, "editor")}
        servers={serverReadings()}
        onserverstart={(groupId) => {
          /* Start, never toggle — and that is the whole reason this is not
             `onserver` above. A chip toggles because you can see which way it
             is; a log widget offers its button only when the group is *down*,
             and a group that crashed is down with `running` still true. Handed
             to the toggle it would have stopped a server the face had just
             said had stopped. `start_group` releases any old tree of its own
             before it binds a port, so this is also the restart. */
          const g = skein.groups.find((g) => g.group.id === groupId);
          if (g) void skein.startGroup(g);
        }}
        onfocus={(id) => (focusedId = id)}
        {ondeselect}
        onclose={closeConv}
        onpin={(id) => savePlacement(id)}
        onplace={(cwd, x, y) => skein.placeProject(cwd, x, y)}
        onstick={(id) => savePlacement(id)}
        onstickproject={(cwd, at) => skein.stickProject(cwd, at)}
      />
      {#if focused && showDetail}
        <aside class="side" style:width="{panelPx}px">
          <!-- The border, made draggable. `role="presentation"` for the same
               reason the studio root has one: this is a gesture surface, not a
               control, and there is nothing here to announce. -->
          <div
            class="grip"
            class:on={grip}
            role="presentation"
            title="drag to resize · double-click to reset"
            onpointerdown={gripDown}
            onpointermove={gripMove}
            onpointerup={gripUp}
            onpointercancel={gripUp}
            ondblclick={gripReset}
          ></div>
          <Transcript
            bind:this={transcript}
            conv={focused}
            read={reading}
            watching={attention.focused}
            onhistory={(c) => void skein.loadHistory(c)}
            onlink={(href) => void skein.openLink(href)}
            onfile={(path, line) =>
              void finder.lookAt(focused.kind === "project" ? focused.cwd : "", path, line)}
            onread={setRead}
          />
        </aside>
      {/if}
    {:else}
      <div class="empty">
        <p>{skein.loaded ? "Nothing open yet." : "Waking the studio…"}</p>
        <p class="sub">
          Drop a project folder anywhere on this wall to start a conversation in
          it. It spawns headless — no terminal, just the stream.
        </p>
        <p class="sub">
          Drop an image instead and it gets pinned up as reference.
        </p>
      </div>
    {/if}

    <!-- The files kept to hand. Inside the wall rather than beside it, and that
         is the whole of its placement: the wall ends exactly where the dock
         begins, so a strip anchored to the bottom of this element sits on the
         dock's top edge however tall the draft has grown — no measurement and
         nothing to keep in step. It draws itself away when there is nothing to
         show. -->
    <Dogears {finder} />
  </main>

  <Dock
    {field}
    {skein}
    {bang}
    {focused}
    {targets}
    {waiting}
    {clashing}
    {bangCard}
    bind:prompt
    onkey={onDraftKey}
    onsendtext={sendText}
    onrun={runCommand}
    ontake={takeCompletion}
    oncycle={cycleWaiting}
    onmore={(shown) =>
      (focusedId = skein.blocked.find((c) => c !== shown)?.id ?? focusedId)}
    onselect={focusCard}
  />

  <!-- The break, taken. Last in the studio and above everything in it, panel
       and dock included — this is the one thing in the app that stops *you*
       rather than reporting on something, and the work carries on behind it. -->
  {#if pomodoro.resting}
    <Rest {pomodoro} />
  {/if}

  <!-- And above even that. The break is the one thing allowed over everything
       that *reports*; this is you acting, and a dialog holding the close shut
       has to be visible or the window has just stopped closing for no reason
       you can see. -->
  {#if quitting}
    <Quit cards={quitting} onstay={() => (quitting = null)} />
  {/if}
</div>

<style>
  .studio {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--ink);
    position: relative;
  }
  /* A faint warm bloom from above, like light falling on a studio wall. */
  .studio::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 46%;
    background: radial-gradient(
      120% 100% at 50% 0%,
      rgba(233, 161, 59, 0.05),
      transparent 70%
    );
    pointer-events: none;
  }

  /* The horizon: the day's spend, carried by the ground rather than by a
     number in a corner. It warms from nothing to a low band of light as the
     total climbs, so you feel the day getting expensive before you ever go
     looking for the figure — and it stays warm across a restart, since what it
     reads is the day and not this run of the app. */
  .studio::after {
    content: "";
    position: absolute;
    inset: auto 0 0 0;
    height: 38%;
    background: linear-gradient(
      to top,
      rgba(233, 161, 59, calc(0.16 * var(--burn, 0))),
      transparent 78%
    );
    pointer-events: none;
    transition: background 2s ease;
    z-index: 0;
  }

  .bar,
  .wall {
    position: relative;
    z-index: 1;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--edge);
    flex: 0 0 auto;
    user-select: none;
  }
  /* Nothing in the bar shrinks except the cluster. This is the floor the whole
     header rests on, and it is stated here rather than left to the fold
     arithmetic on purpose: the window controls have to stay reachable even on a
     frame where nothing has been measured yet, or on a build where the
     measurement is wrong. Losing a button off the end is a nuisance; losing the
     maximise button is a trap, because maximising is the gesture that gives the
     room back. */
  .bar > :global(*) {
    flex: 0 0 auto;
  }
  .bar button {
    user-select: auto;
  }
  .wordmark {
    font-family: var(--display);
    font-size: 1.05rem;
    letter-spacing: -0.01em;
  }
  .tag {
    font-family: var(--util);
    font-size: 0.66rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
  }
  .grow {
    flex: 1 1 auto;
    /* Nothing but a drag handle, so it is the first thing to give its width
       back — and it may reach zero, which is what lets the cluster keep its
       items for a few hundred pixels longer. */
    min-width: 0;
  }
  /* The one part of the bar that gives way. */
  .cluster {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  /* And it gives way by clipping, not by squeezing. A row of buttons that
     narrow until their labels wrap is harder to read at a glance than a shorter
     row of whole ones — and on the first frame, before anything is measured,
     clipping is what the fold is about to do properly anyway. */
  .cluster > :global(*) {
    flex: 0 0 auto;
  }
  .anchor {
    display: flex;
    align-self: stretch;
  }
  /* The measuring copy. Absolutely placed so it takes no room, invisible rather
     than `display: none` because a thing with no box has no width to read, and
     `inert` in the markup so it cannot be reached. Deliberately outside the
     "nothing on the wall may be transparent" rule — this is not on the wall,
     and it is never drawn at all. */
  .ruler {
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
    display: flex;
    gap: 0.7rem;
    white-space: nowrap;
  }
  .rule {
    display: inline-flex;
    align-items: center;
  }

  .open {
    font-family: var(--util);
    font-size: 0.74rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .open:hover:not(:disabled) {
    background: var(--raised);
    border-color: var(--rule);
  }
  .open:disabled {
    color: var(--paper-faint);
    cursor: default;
  }

  .zoom {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--st-work);
    min-width: 4ch;
  }
  /* The figure exists for when you do go looking; the horizon is what you
     actually read without looking. */
  .spend {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .livecount {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--st-work);
  }
  /* Colour is reserved for status, and a waiting update is one — the same
     amber the wall uses for a card that wants something from you. It goes rust
     when the download failed, which is the same vocabulary one step further. */
  .uproll {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .up {
    color: var(--st-ask);
    border-color: color-mix(in srgb, var(--st-ask) 40%, var(--edge));
  }
  .up:hover {
    border-color: var(--st-ask);
  }
  .up.bad {
    color: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 40%, var(--edge));
  }
  .upnote {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--st-ask);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Deliberately the fail colour: this is a hole in the wall, and it should
     look like one for as long as it is open. */
  .ctl {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--st-fail);
    border: 1px solid color-mix(in srgb, var(--st-fail) 40%, var(--edge));
    border-radius: 3px;
    padding: 0.06rem 0.34rem;
    white-space: nowrap;
  }
  .ghost {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.22rem 0.5rem;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .ghost.on {
    color: var(--paper);
    border-color: var(--paper-faint);
  }

  .fault {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--st-fail);
    padding: 0.5rem 0.9rem;
    border: 0;
    border-bottom: 1px solid var(--edge);
    background: color-mix(in srgb, var(--st-fail) 8%, var(--ink));
    cursor: pointer;
  }

  .wall {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  /* Width is set inline from `panelWidth` — see the note by `gripDown`. It must
     not be given one here as well, or a drag would fight a stylesheet. */
  .side {
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    padding: 0.8rem 0.8rem 0.8rem 0;
    border-left: 1px solid var(--edge);
    /* The grip hangs on this. */
    position: relative;
  }

  /* Seven pixels of hit area over a one-pixel line, because nobody can hit a
     one-pixel line. It sits mostly *outside* the panel, over the wall — three
     pixels in, which is nowhere near the rails, and the wall under it still
     pans everywhere the cursor is not this. Invisible until asked for: an edge
     you can drag should say so under the cursor, not draw a second border down
     the middle of the window all day. */
  /* The whole wall wears the resize cursor for the length of the drag, and
     stops being selectable: the pointer is captured by the grip, so what is
     under it is irrelevant, but a cursor that flickered between `grab` and
     `col-resize` as it crossed the boundary would say the gesture had ended. */
  .wall.sizing {
    cursor: col-resize;
    user-select: none;
  }
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    width: 7px;
    cursor: col-resize;
    z-index: 3;
    /* Refuses the text selection a drag would otherwise start, at the source —
       which is what lets `gripDown` leave the default alone. See the note
       there: `preventDefault` on pointerdown takes `dblclick` with it. */
    user-select: none;
  }
  .grip::after {
    content: "";
    position: absolute;
    inset: 0 3px;
    background: var(--paper-faint);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .grip:hover::after,
  .grip.on::after {
    opacity: 1;
  }

  .empty {
    margin: auto;
    text-align: center;
    max-width: 46ch;
  }
  .empty p {
    margin: 0;
    color: var(--paper-mute);
  }
  .empty .sub {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper-faint);
    margin-top: 0.5rem;
    line-height: 1.5;
  }

</style>
