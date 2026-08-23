<script lang="ts">
  /* A `!` run keeps its colour: the shell is spawned with FORCE_COLOR, so `cargo`
     and `git` answer in SGR sequences exactly as they do in the console panel,
     and this is the same parser reading them. */
  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import { untrack } from "svelte";
  import type { Conversation, Line } from "./conversation.svelte";
  import Markdown from "./Markdown.svelte";
  import Rail from "./Rail.svelte";
  import ToolCall from "./ToolCall.svelte";
  import { nudgeReading } from "./layout";
  import { parseMarkdown, StreamedMarkdown } from "./markdown";
  import {
    conclusionAt,
    landing,
    nest,
    readingAt,
    stepBy,
    stub,
    type Kind,
    type Mark,
  } from "./outline";
  import {
    blocksOf,
    foldCount,
    foldSummary,
    runFoldCap,
    longFold,
    type Block,
  } from "./transcript";
  import { selectionMarkdown } from "./copy";
  /* The judgement, and the slack it is made with, are shared with every other
     scroller that follows its own tail — see follow.ts. The wiring is not: this
     panel has a rail carrying the view, a keyboard ladder that steps it, and a
     `following` its effect graph reads, so it keeps its own effect and hands
     that module the three numbers. */
  import { stillFollowing, STICK_PX } from "./follow";

  let {
    conv,
    watching = true,
    read = 1,
    onhistory,
    onlink,
    onread,
  }: {
    conv: Conversation;
    /** Whether this panel can actually be being read — today, whether the studio
     *  window has focus. Passed in rather than asked for here: the window's
     *  focus already has an owner in `attention.svelte.ts`, and a second
     *  subscription to it would be a second thing to release. */
    watching?: boolean;
    /** How large the transcript is drawn, as a multiplier — see
     *  `readingScale`. Resolved by the caller, because it is stored beside the
     *  viewport and the panel's width rather than in here. */
    read?: number;
    /** Ask for the scrollback that predates this card's process. Routed out
     *  rather than invoked here: `skein.svelte.ts` is the only thing that talks
     *  to Rust. */
    onhistory?: (c: Conversation) => void;
    /** Open a link the agent wrote. Routed out for the same reason. */
    onlink?: (href: string) => void;
    /** A notch of ctrl+wheel asking for a different size. Routed out for the
     *  same reason the width's drag is: how this window is set up to be read
     *  from is not the panel's to keep. */
    onread?: (next: number) => void;
  } = $props();

  /* The agent speaks markdown — headings, lists, fenced code, tables — and it
     used to arrive here as literal asterisks and hashes. Parsed per line rather
     than once per render: `lines` only ever grows, so a line is folded the once.
     Everything else is left exactly as it is. `you` is what *you* typed, shown
     character for character; a tool call and an error are already terse and
     already monospaced.

     The turn still being written is the same argument one level down, and it
     used to be the exception: `parseMarkdown(conv.streaming)` re-read the whole
     of an answer on every `text_delta`, which is thousands of times a turn and
     quadratic in its length — 36.6 s of parsing across a hundred-thousand
     character report, against 169 ms now. `StreamedMarkdown` settles everything
     above the last block boundary once and hands it back by identity, so this
     one holds a fold rather than being one. See markdown.ts for what counts as
     a boundary; it is the whole of the subtlety. */
  const stream = new StreamedMarkdown();
  const streamed = $derived(stream.read(conv.id, conv.streaming));

  /* Runs of tool calls fold into one line each — see transcript.ts for why, and
     for why the two columns are folded separately. Both are cheap: a fold is one
     pass over an array that only grows at the end. */
  const past = $derived(blocksOf(conv.history, "h"));
  const live = $derived(blocksOf(conv.lines, "l"));

  /** Which folded groups are open, by key. Every group starts closed — the
   *  space they were taking is the whole point — and each is its own decision,
   *  since what you want open is the one round you are picking apart.
   *
   *  A plain object rather than a set: `$state` proxies it, so reading
   *  `open[key]` in the markup subscribes to that one group and opening one
   *  redraws one cap. Not persisted — where you had scrolled to isn't either,
   *  and a fresh view of a card is a fresh view. */
  let open = $state<Record<string, true>>({});

  /** Which folds you have deliberately *closed*.
   *
   *  A second record rather than a flag on `open`, because one kind of fold has
   *  the opposite default: a `!` run starts open. Every other fold hides
   *  machinery you did not ask for — a run is the thing you asked for, and a
   *  `git status` you have to click to read is a `git status` you would rather
   *  have typed somewhere else. So "have you touched this one" is a different
   *  question for runs than for calls, and it gets its own answer. */
  let shut = $state<Record<string, true>>({});

  /** Is this run's fold open? Open unless you shut it. */
  const runOpen = (key: string) => !shut[key];

  /** Where one line's own fold state lives, for the one kind of line that has
   *  any: a tool call.
   *
   *  Its `tool_use` id, which is unique across the card, is stable for as long
   *  as the line is, and is the *same string after a restart* — history reads
   *  it out of the session file — so a call you had open stays open across a
   *  rouse. The block key is the fallback for a call that arrived without one,
   *  and is positional in exactly the way `blocksOf` warns about; that is
   *  acceptable here only because nothing on the wire has ever omitted the id. */
  const lineKey = (line: Line, fallback: string) => line.call?.id ?? fallback;

  function toggleRun(key: string) {
    if (shut[key]) delete shut[key];
    else shut[key] = true;
    refresh(0);
  }

  function toggle(key: string) {
    if (open[key]) delete open[key];
    else open[key] = true;
    /* The column just changed height, so every offset the rails measured is
       stale — including which mark counts as where you are reading. */
    refresh(0);
  }

  let scroller: HTMLDivElement | undefined = $state();

  /** How long after the last scroll event a view being carried counts as having
   *  arrived. Chromium's smooth scroll emits all the way to the end, so this is
   *  measured from the last of them, not from the click. */
  const SETTLE_MS = 120;

  /** Whether the view is parked at the tail. Recomputed on every scroll, so
   *  scrolling back down by hand resumes following without a control to click. */
  let following = $state(true);

  /** Non-zero while the rail is carrying the view somewhere. */
  let carrying = 0;

  /** Where the follow last put the view, or `-1`.
   *
   *  The same distinction `carrying` draws, for the other thing in here that
   *  moves the view on its own — and the follow went without it for as long as it
   *  has existed. A write to `scrollTop` does not dispatch its scroll event
   *  synchronously: the event arrives a beat later, and `onScroll` then recomputes
   *  `following` from `atTail`. A burst of deltas landing inside that beat moves
   *  the bottom out from under the write, so `atTail` is measured against a column
   *  that has already grown past the place we aimed at, reads false, and the panel
   *  silently stops following. Nothing takes it back: `following` is only re-armed
   *  by scrolling down by hand or by the studio losing focus.
   *
   *  Which is why the symptom is *mid-conversation* rather than at the top. The
   *  view is stranded at whatever height the column had at that instant, and the
   *  faster the turn writes, the further from the tail it stops — a card roused at
   *  launch, whose whole transcript arrives at once and which then takes a turn,
   *  froze around two thirds of the way down a wall of its own reading.
   *
   *  Measured, not a flag: content landing *below* the view does not change
   *  `scrollTop`, so the event that reports our own write reports exactly the
   *  number we wrote, and anything else is you. */
  let pinned = -1;

  /** Put the view on the tail, and remember where that turned out to be. Every
   *  programmatic trip to the bottom goes through here, or the next one to be
   *  added is the next one to be read as you scrolling away. */
  function pin(el: HTMLElement) {
    el.scrollTop = el.scrollHeight;
    pinned = el.scrollTop;
  }

  /** How far below the fold the tail has to be before the way back is worth
   *  offering: three quarters of a screen still to go. A few lines short of the
   *  bottom is one flick of the wheel and does not need a control put up for it
   *  — and a button that appeared every time a live turn nudged the view a line
   *  off the tail would be furniture that blinks. */
  const FAR = 0.75;

  /** Whether the tail is far enough below to offer the way back. Measured like
   *  everything else here rather than remembered: the column grows all through
   *  a turn, so a distance taken when you stopped scrolling is wrong a second
   *  later. */
  let far = $state(false);

  function atTail(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }

  function below(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  /** Take the reading once the movement stops. */
  function settle() {
    carrying = 0;
    if (scroller) following = atTail(scroller);
  }

  function onScroll() {
    if (!scroller) return;
    measure();
    /* A carried view's own scroll events say nothing about where you want to
       be. This is not a nicety: the first event of a smooth scroll fires with
       the panel barely moved, so a panel parked at the tail — which is where
       every panel starts — read as still following, and the follow below
       promptly dragged it back down. Clicking a rail entry looked like clicking
       nothing at all. */
    if (carrying) {
      clearTimeout(carrying);
      carrying = window.setTimeout(settle, SETTLE_MS);
      return;
    }
    /* And the follow's own write, reported a beat after it happened — the
       judgement is `stillFollowing`, pure and tested, because it is the panel's
       most consequential three lines. See follow.ts. */
    const was = pinned;
    following = stillFollowing({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      pinned,
      following,
    });
    /* Consumed: the next event is either ours again (and re-pinned by the follow)
       or a hand on the wheel. */
    if (was >= 0 && scroller.scrollTop !== was) pinned = -1;
  }

  /* ── the rails ────────────────────────────────────────────────────────────
     Two floating lists over the wall, and they are lists of different things.

     `you said` is the conversation: everything you have asked, from the top.
     `contents` is one answer — how the round you are reading came out — laid
     out as its opening words, its headings (written as `#` or run in as a
     paragraph's bold opening, which is how most of them arrive) and the start
     of each item of each of its lists. A table of contents for a dozen answers
     at once is not a table of contents; it is the transcript again, in a
     narrower column.

     Both are collected off this panel's own DOM: every navigable thing carries
     `data-nav`, so one query in document order finds the lot, and an element's
     offset is what a click needs anyway. See outline.ts. */
  type Place = Mark & {
    el: HTMLElement;
    /** Which answer this belongs to, counted down the panel. */
    msg: number;
    /** Which round — everything since you last spoke. What scopes the contents
     *  rail, and the reason marks are collected for every message rather than
     *  only the one on screen: which round you are in, and what that round came
     *  to, both fall out of the same measurement that lights an entry. */
    round: number;
  };

  /* Raw: these hold DOM elements and are replaced wholesale on every collect,
     so there is nothing for a deep proxy to earn. */
  let places = $state.raw<Place[]>([]);
  let headAt = $state(-1);
  let saidAt = $state(-1);

  const marks = $derived(places.filter((p) => p.kind !== "you"));
  const said = $derived(places.filter((p) => p.kind === "you"));

  /** Which answer the contents rail is showing, and which of how many rounds
   *  that is. The whole judgement is `conclusionAt`, pure and tested. */
  const scope = $derived(conclusionAt(marks, headAt));

  const contents = $derived(marks.filter((p) => p.msg === scope.msg));
  /** Where the reader is *within* the answer on show — `-1` when that is
   *  nowhere, which is a real state now that the rail outlasts the message
   *  being read: scrolled back into the middle of a round, the rail still lists
   *  how the round came out, and nothing in that list is where you are. */
  const contentsAt = $derived(headAt < 0 ? -1 : contents.indexOf(marks[headAt]));

  /* Which of several, when there are several. The rail is scoped and should
     say so — otherwise an answer whose contents look short reads as an answer
     that lost half its headings. */
  const contentsCap = $derived(
    scope.of > 1 ? `contents · ${scope.nth}/${scope.of}` : "contents",
  );

  /** The text a container carries *before* its first nested mark.
   *
   *  What "the start of" a message or a list item means: everything past the
   *  first mark inside it is that mark's own to label, and taking it here would
   *  print the same words twice, one line apart. It is also why a message
   *  opening with a heading gets no entry of its own — there is nothing in front
   *  of the heading to show. */
  function startText(el: HTMLElement): string {
    let out = "";
    for (const kid of el.children) {
      if (kid.matches("[data-nav]") || kid.querySelector("[data-nav]")) break;
      out += ` ${kid.textContent ?? ""}`;
      // Long enough to cut from; the rest is read in the panel, not the rail.
      if (out.length > 400) break;
    }
    return out;
  }

  /** How many lists a list item is inside — its `rank`, which `nest` turns into
   *  an indent once it knows what heading it fell under. */
  function listDepth(el: HTMLElement): number {
    let n = 0;
    for (let p = el.parentElement; p && p !== scroller; p = p.parentElement) {
      if (p.tagName === "UL" || p.tagName === "OL") n++;
    }
    return n;
  }

  function collect() {
    if (!scroller) return;
    /* Counted here rather than in `nest`, which is about depth and has no
       business knowing where one answer stops. A mark ahead of the first
       message — there are none today — would be −1 and belong to nothing.

       A round starts at 0 rather than at the first `you`, because a transcript
       read from disk can open mid-conversation: what the agent was saying when
       the file starts is a round whose prompt is not on the page. */
    let msg = -1;
    let round = 0;
    const found = [...scroller.querySelectorAll<HTMLElement>("[data-nav]")].map(
      (el) => {
        const kind = (el.dataset.nav ?? "h") as Kind;
        if (kind === "msg") msg++;
        if (kind === "you") round++;
        /* A heading and a line you typed are whole; a message and a list item
           are containers, and only their opening is theirs. */
        const text =
          kind === "h" || kind === "you" || kind === "lead"
            ? (el.textContent ?? "")
            : startText(el);
        return {
          el,
          kind,
          msg,
          round,
          rank:
            kind === "h"
              ? Number(el.dataset.level ?? 1)
              : kind === "li"
                ? listDepth(el)
                : 0,
          /* A run-in label names its paragraph and the rest of the paragraph is
             what it says — so the bold is the entry and the whole line is the
             tooltip, which is the one place a narrow column can afford it. */
          label: stub(kind === "lead" ? (el.dataset.lead ?? "") : text),
          // Capped too: a tooltip carrying a whole pasted file is not a tooltip.
          full: stub(text, 300),
        };
      },
    );

    /* Indents come from the run, not from any one tag — and `nest` drops the
       marks with nothing to show, after it has used them for their place. */
    const levels = nest(found);
    const next: Place[] = [];
    for (let i = 0; i < found.length; i++) {
      const level = levels[i];
      if (level === null) continue;
      next.push({ ...found[i], level });
    }
    places = next;
  }

  /** Where the reader is, in each rail. Measured rather than remembered: the
   *  column above a mark grows all through a turn, so an offset cached when the
   *  mark was collected would be wrong a second later. */
  function measure() {
    const el = scroller;
    if (!el) return;
    const { scrollTop, clientHeight, scrollHeight } = el;
    far = below(el) > clientHeight * FAR;
    /* Against every mark in the panel, not only the ones on show: this is what
       decides *which* answer is on show. `offsetTop` is measured against
       `.lines`, which is positioned for exactly this. */
    headAt = readingAt(
      marks.map((p) => p.el.offsetTop),
      scrollTop,
      clientHeight,
      scrollHeight,
    );
    saidAt = readingAt(
      said.map((p) => p.el.offsetTop),
      scrollTop,
      clientHeight,
      scrollHeight,
    );
  }

  /** Recollect, after the DOM the change caused actually exists. Never sooner:
   *  mid-effect the panel is still the old one, so the list and every offset in
   *  it would be a frame stale — the same reason the follow below waits.
   *
   *  A soon-enough collect already coming is left alone; a sooner one takes its
   *  place. Only ever *shortening* the wait is what keeps this from starving:
   *  a stream asking again every few milliseconds asks for the same 160ms it
   *  already has, and gets it. */
  let recollect = 0;
  let waiting = Infinity;
  function refresh(delay: number) {
    if (recollect && waiting <= delay) return;
    clearTimeout(recollect);
    waiting = delay;
    recollect = window.setTimeout(() => {
      recollect = 0;
      waiting = Infinity;
      collect();
      measure();
    }, delay);
  }

  $effect(() => {
    void conv.lines.length;
    void conv.history.length;
    refresh(0);
  });

  /* A different card is a different panel. The marks go the moment it changes
     rather than when the next collect lands: they point at elements that are no
     longer in the document, so left up they would list the previous answer and
     measure it at an offset of zero. */
  $effect(() => {
    void conv.id;
    places = [];
    headAt = -1;
    saidAt = -1;
    /* The keys belong to the column that is going: another card's groups would
       be closed anyway, and a key it happens to share is not the same run. */
    open = {};
    /* And a run in flight belongs to the panel that is going away. Cleared here
       rather than left to the next `measure`, which is a timeout away: a button
       offering the way back on a panel that starts at the tail is a button
       pointing at where you already are. */
    stopGlide();
    far = false;
    /* The place the follow pinned belonged to the column that is going. */
    pinned = -1;
    refresh(0);
  });

  /* A turn's own text is throttled rather than followed frame by frame: a
     collect walks every mark in the panel, `thinking_delta` outnumbers
     `text_delta` about 8:1 so there are a great many of them, and a heading that
     joins the rail a sixth of a second late is not something anybody sees. Where
     you *are* stays exact regardless — `measure` runs on every scroll, and
     following the tail scrolls. */
  const STREAM_MS = 160;
  $effect(() => {
    void conv.streaming;
    refresh(STREAM_MS);
  });

  /* The timers — and the frame loop — are the one thing here that outlives the
     panel. */
  $effect(() => () => {
    clearTimeout(recollect);
    clearTimeout(carrying);
    cancelAnimationFrame(gliding);
  });

  /** Hand the clipboard the markdown, not the drawing of it.
   *
   *  The panel renders an agent's marks as elements, so the browser's own copy
   *  strips every one of them — and an answer copied out of here is on its way
   *  to somewhere that reads markdown far more often than not. `copy.ts` walks
   *  the selected fragment back into the source it was drawn from.
   *
   *  Silent when there is nothing to say, which leaves the default copy exactly
   *  as it was: a selection that is all furniture must not clear the clipboard. */
  function onCopy(e: ClipboardEvent) {
    const md = selectionMarkdown();
    if (!md) return;
    e.clipboardData?.setData("text/plain", md);
    e.preventDefault();
  }

  /** Go to a mark. */
  function jump(p: Place) {
    const el = scroller;
    if (!el) return;
    /* Clicking a rail is asking to read something, so it lets go of the tail —
       otherwise a live turn drags the view straight back down. `settle` takes
       it up again if the view came to rest at the bottom after all. */
    following = false;
    pinned = -1;
    clearTimeout(carrying);
    carrying = window.setTimeout(settle, SETTLE_MS);
    /* Where the mark sits inside the scroller, whatever it is nested in:
       `offsetTop` would answer for the nearest positioned ancestor, and the
       panel is free to grow one. A little air above it, too — a heading flush
       against the top edge reads as cropped. */
    const to =
      el.scrollTop +
      (p.el.getBoundingClientRect().top - el.getBoundingClientRect().top) -
      12;
    el.scrollTo({ top: Math.max(0, to), behavior: "smooth" });
  }

  /** How long the run back to the tail takes, whatever the distance.
   *
   *  Fixed, which is why this is hand-run rather than `behavior: "smooth"`:
   *  Chromium scales that duration with the distance, so on a transcript of any
   *  length the way back is a long slow ride to somewhere you asked to be now.
   *  Not instant either — landing at the bottom of a column that looks nothing
   *  like the one you left reads as having been moved rather than having
   *  travelled, and the point of the button is to know where you went. */
  const TAIL_MS = 300;

  /** Non-zero while the run is in flight. */
  let gliding = 0;

  /** The wheel outranks a run in progress: without this the frame loop would
   *  write its next position straight over yours, and changing your mind
   *  halfway down would do nothing. */
  function stopGlide() {
    if (!gliding) return;
    cancelAnimationFrame(gliding);
    gliding = 0;
  }

  /** Run back to the tail and take the tail up again on arrival. */
  function toTail() {
    const el = scroller;
    if (!el) return;
    stopGlide();
    /* Same carry as the rail's: `following` off so the follow effect doesn't
       teleport us there mid-run, and `settle` to take the reading once the
       movement stops — which here means switching following back *on*, since
       the tail is where this is going. */
    following = false;
    clearTimeout(carrying);
    carrying = window.setTimeout(settle, SETTLE_MS);

    const from = el.scrollTop;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TAIL_MS);
      /* The target is read every frame, not once: a turn streaming while you
         travel moves the bottom, and a run computed against where the bottom
         used to be lands short of it. */
      const to = el.scrollHeight - el.clientHeight;
      el.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
      if (t < 1) {
        gliding = requestAnimationFrame(step);
        return;
      }
      gliding = 0;
      /* Taking the tail back up is the entire gesture, so it is said rather than
         re-derived: `settle` would ask `atTail` about a column a streaming turn
         has already grown, and answer that the button had not worked. */
      pin(el);
      clearTimeout(carrying);
      carrying = 0;
      following = true;
    };
    gliding = requestAnimationFrame(step);
  }

  /** What one line of prose is drawn at, which is the unit a step is measured
   *  in. Measured off a real line rather than computed from `read`: the size is
   *  `calc(0.86rem * var(--read))` against a `line-height` that could change
   *  with the theme, and a step that disagreed with the text would leave a
   *  sliver of the previous line at the top of every page. Falls back to what
   *  that calc comes to at rest, for a panel with nothing in it yet. */
  function lineHeight(el: HTMLElement): number {
    const line = el.querySelector(".line");
    const px = line ? parseFloat(getComputedStyle(line).lineHeight) : NaN;
    return Number.isFinite(px) && px > 0 ? px : 21;
  }

  /** Move the reading. The keys live up in `App.svelte` — they have to fire with
   *  the caret in the draft as readily as on the wall, so they are the window's
   *  and not this panel's — but where the panel is scrolled to is the panel's
   *  own and is never lifted out of here.
   *
   *  Instant, unlike the rails' `jump` and the run back to the tail. Both of
   *  those are one deliberate leap to a place you named, where seeing yourself
   *  travel is what tells you where you went; a step is the reading advancing,
   *  and a held key would spend the whole press fighting the animation it
   *  started a frame earlier.
   *
   *  `following` is deliberately not touched. An instant write to `scrollTop`
   *  fires a real scroll event, so `onScroll` takes the reading exactly as it
   *  does for the wheel: stepping up off the tail lets go of a live turn, and
   *  stepping back down onto it takes it up again, with nothing here to keep in
   *  step with it. */
  export function step(kind: "line" | "page", dir: -1 | 1) {
    const el = scroller;
    if (!el) return;
    /* Same right the wheel has: a key is you changing your mind about a run
       already in flight, and the frame loop would otherwise write its next
       position straight over the step. */
    stopGlide();
    /* Yours, so it must be read as yours even if it lands exactly on the tail the
       follow last pinned — that is a step back *onto* a live turn, and taking it
       up again is the point of measuring rather than flagging. */
    pinned = -1;
    const delta = dir * stepBy(kind, lineHeight(el), el.clientHeight);
    el.scrollTop = landing(el.scrollTop, delta, el.scrollHeight, el.clientHeight);
  }

  /* Focusing a different card is a fresh view, and a fresh view starts at the
     tail — otherwise the scroll position you left behind on one card decides
     where you land on the next one. */
  $effect(() => {
    void conv.id;
    following = true;
  });

  /* The panel opening is what pays for reading a multi-megabyte file: the wall
     itself never needs the scrollback, and reading every card's transcript at
     launch would undo lazy restore.

     Untracked, because the loader's own first act is to read `historyState` to
     see whether it has already run — inside a tracking scope that would make
     this effect depend on the very field it is about to write. */
  $effect(() => {
    const c = conv;
    void c.id;
    untrack(() => onhistory?.(c));
  });

  /* A panel nobody is looking at lets go of the place it was holding.
     Scrolling up during a live turn means "I am reading this", and the tail is
     let go of for exactly as long as that is true — but turn to an editor for a
     minute and the agent writes another round underneath, and coming back to a
     view parked in the middle of the round before it is coming back to stale
     news. So while the studio is unfocused, anything arriving re-arms the tail
     and the follow below takes the view down; you turn back to the newest thing
     said, which is what you left the card alone to get on with.

     Gated on something actually arriving rather than on the blur itself: away
     for two seconds with nothing said, the place you were holding is still
     yours. And it is only ever *this* card's panel, so a card you are not
     focused on has nothing to reset — its scroll position isn't kept anywhere.

     **`watching` is read untracked, and that is the whole of the gate.** Asking
     `if (!watching)` inside the effect makes the blur a dependency, so losing
     focus re-ran this and re-armed the tail by itself — the arrival signals
     above became decoration, and the follow effect (which reads `watching` too)
     took the view straight to the bottom. Scroll into the middle of a finished
     conversation, click an editor, and the panel you were reading threw the
     place away with nothing having arrived to justify it. The condition here is
     "is anyone looking", which is a question this effect asks and never wants to
     be woken by; what wakes it is the four reads above, which are the events.

     It has to write `following` rather than scroll: the follow effect is what
     knows to wait a frame for the DOM the new text made, and a second path to
     the bottom would be a second thing to keep in step with it. */
  $effect(() => {
    void conv.streaming;
    void conv.lines.length;
    void conv.history.length;
    void conv.activity;
    if (!untrack(() => watching)) following = true;
  });

  /* Follow the tail while text streams in — but only if that is where you
     already were. Scrolling up during a live turn is how you read what has just
     gone past, and pinning the view to the bottom on every token made that
     impossible: the line you were reading left the screen before you finished
     it, several times a second. */
  $effect(() => {
    void conv.streaming;
    void conv.lines.length;
    /* History arrives all at once and lands *above* everything, so without this
       the view would sit at what is suddenly the top of a long column. */
    void conv.history.length;
    /* The live status line is at the foot of the column and changes without any
       line being added — a tool call begins before its line exists. It is the
       thing most worth being at the bottom for. */
    void conv.activity;
    /* And coming back to the window is a moment to honour the tail, because the
       frame this effect waits for may never have come while you were away:
       Chromium suspends `requestAnimationFrame` for a minimised or fully
       occluded window, so every scroll the re-arm above asked for is a callback
       queued behind the restore rather than a view at the bottom. Re-running on
       focus costs nothing when the tail was let go of — the guard below returns
       — and is the difference between landing on the newest thing said and
       landing wherever the column happened to leave you. */
    void watching;
    const el = scroller;
    if (!el || !following) return;
    /* On the next frame rather than now: mid-effect the DOM still has its old
       height, so scrolling to `scrollHeight` here would stop one line short of
       the text that triggered this.
       Asked again when it fires, because a frame is long enough to have let go:
       a rail click during a live turn lands between the two, and this would
       otherwise carry out a decision that had already been reversed. */
    requestAnimationFrame(() => {
      if (following) pin(el);
    });
  });

  /* ── how big the reading is ───────────────────────────────────────────────
     ctrl+wheel over the panel, which is what the same hands do everywhere else
     — and the modifier is what keeps the plain wheel doing the only thing it
     can mean here, which is scrolling. The wall's own wheel is the other way
     round (bare wheel zooms, because on the wall zoom *is* the navigation);
     they never overlap, since the panel is outside `.surface` and neither
     listener ever sees the other's events.

     What it changes is the multiplier and nothing else: `--read` scales the
     line, and everything inside a line is already `em` off it, so a heading
     stays a heading's size relative to its paragraph and `78ch` stays
     seventy-eight characters. See `readingScale` in layout.ts. */
  let panel: HTMLElement | undefined = $state();

  /** How long the size stays on screen after the last notch. Long enough to
   *  read at the end of a spin, short enough that it is gone before it becomes
   *  something on the panel rather than something you did. */
  const READOUT_MS = 900;
  let showRead = $state(false);
  let readTimer = 0;

  function flashRead() {
    showRead = true;
    clearTimeout(readTimer);
    readTimer = window.setTimeout(() => (showRead = false), READOUT_MS);
  }

  /** Where the reader was, as a fraction of the column, taken *before* the
   *  size changes. Restored after, or resizing the text would leave the view
   *  at a pixel offset that means something entirely different in the new
   *  column — at double the size, halfway down becomes a quarter of the way. */
  let anchor: number | null = null;

  $effect(() => {
    const el = panel;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      /* Registered by hand for this: the listener has to be non-passive.
         Chromium's own ctrl+wheel zoom is not in play (Tauri 2 leaves
         `zoomHotkeysEnabled` false and tauri.conf.json does not set it), but
         the column would otherwise scroll as well as resize, which is two
         things for one turn of the wheel. */
      e.preventDefault();
      const next = nudgeReading(read, e.deltaY);
      /* A notch that changes nothing still reports: at either end of the range
         the size saying what it already is is the answer to why the wheel did
         nothing. A notch that *does* change something is flashed by the effect
         below instead, so ctrl+0 and anything else that sets the size gets the
         same readout without having to remember to ask for it. */
      if (next === read) {
        flashRead();
        return;
      }
      if (scroller && scroller.scrollHeight > 0) {
        anchor = scroller.scrollTop / scroller.scrollHeight;
      }
      onread?.(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /* A different size is a different column: every mark sits at a new offset,
     and where the reader was is a new number. Both are the same fix the stream
     gets and for the same reason — mid-effect the panel is still drawn at the
     old size, so the measuring waits a frame.

     `read` is the only dependency: `following` and `scroller` are both read
     untracked, because either would re-run this on every scroll and on every
     rebind — and re-running it means recollecting the whole panel, and a
     readout announcing a size that did not change. */
  let sized = -1;
  $effect(() => {
    const to = read;
    if (to === sized) return;
    const was = sized;
    sized = to;
    const at = anchor;
    anchor = null;
    /* The size it was drawn at to begin with is not a change. Without this a
       panel would report its own size the moment a card was focused, which is
       a readout nobody asked for on every click. */
    if (was < 0) return;
    flashRead();
    const el = untrack(() => scroller);
    if (!el) return;
    requestAnimationFrame(() => {
      /* The tail outranks the anchor — a panel that was following is asking to
         stay at the bottom, not at 0.98 of a column that just grew. */
      if (untrack(() => following)) pin(el);
      else if (at !== null) el.scrollTop = at * el.scrollHeight;
      /* After the scroll, not before: `measure` reads `scrollTop`. */
      refresh(0);
    });
  });

  $effect(() => () => clearTimeout(readTimer));
</script>

<!-- One line of the column, drawn exactly as it always was: the two columns and
     the inside of a fold all go through here, so history, live text and a call
     you have opened cannot drift apart.

     `key` is the line's own place in `open` — needed because a tool call is now
     a fold in its own right, nested inside the run fold it may be part of. It
     is passed in rather than derived here for the reason a group's key is its
     first line's words: the live column is sliced at `MAX_LINES`, so anything
     positional silently moves an opened thing onto a different one. A call's
     key is its `tool_use` id, which is the one identifier that is the same line
     for as long as the line exists — and the same one after a restart, since
     history reads it out of the session file. -->
{#snippet one(line: Line, key: string)}
  {#if line.kind === "tool" && line.call}
    <!-- A call is openable: closed it is the line it always was, open it is
         every argument the model wrote and what came back. No `data-nav`, like
         everything else inside a fold. -->
    <ToolCall
      call={line.call}
      text={line.text}
      open={!!open[key]}
      ontoggle={() => toggle(key)}
    />
  {:else if line.kind === "text"}
    <!-- `data-nav` is the rail's whole handle on the panel: this one is the
         answer itself, and the marks inside it are its shape. -->
    <div class="line text md" data-nav="msg">
      <Markdown blocks={parseMarkdown(line.text)} {onlink} />
    </div>
  {:else}
    <!-- The line is drawn exactly as it was — `pre-wrap` here, so the text stays
         glued to its tags. -->
    <!-- A prompt is drawn when you send it, so its own line carries whether the
         agent has it yet: dimmed while it is on its way, and saying so if it
         never got there. -->
    <div
      class="line {line.kind}"
      class:pending={line.state === "pending"}
      class:failed={line.state === "failed"}
      data-nav={line.kind === "you" ? "you" : null}
    >{line.text}</div>
  {/if}
{/snippet}

<!-- A column of blocks: lines, and runs of tool calls folded into one cap each.
     Nothing navigable is ever inside a fold — a tool call carries no `data-nav` —
     so the rails list the same places whatever is open. -->
{#snippet column(blocks: Block[])}
  {#each blocks as b (b.key)}
    {#if b.kind === "line"}
      {@render one(b.line, lineKey(b.line, b.key))}
    {:else if b.kind === "long"}
      <!-- What a compaction carried forward, the whole of a skill the agent
           invoked, or the prompt rousing sent a card whose turn was cut off.
           Folded like a run of calls, but marked as its own thing: the words
           inside are neither yours nor the agent's — the CLI or Skein put them
           there — so they must not be able to be read as either. Closed until
           you open it, which is the whole point: a summary runs to twenty
           thousand characters, a skill to rather more, and the resume prompt to
           twenty lines of instructions addressed to somebody else — and the
           round you came here to read is on the far side of one.

           One branch for all three, because the drawing is the same problem
           three times and only the cap differs — `longFold` is where it does.
           The `failed` mark is the resume prompt's alone: folded, the line's
           own is not on screen to be read.

           Parsed as markdown only when it is open. Both are written as headed
           sections and lists; parsing one on every keystroke of a live turn,
           folded away where nobody can see it, would be the panel's most
           expensive line by far. -->
      {@const fold = longFold(b.line)}
      <div class="fold long" class:shown={open[b.key]}>
        <button
          type="button"
          class="cap"
          class:failed={b.line.state === "failed"}
          aria-expanded={open[b.key] ? "true" : "false"}
          onclick={() => toggle(b.key)}
          title={open[b.key] ? "fold it away" : fold.hint}
        >
          <span class="mark" aria-hidden="true">{open[b.key] ? "▾" : "▸"}</span>
          <span class="what">{fold.cap}</span>
        </button>
        {#if open[b.key]}
          <!-- No `data-nav`: the rails list places in the conversation, and a
               summary's own two dozen headings — or a skill's — would bury every
               one of them. -->
          <div class="inside">
            <div class="line text md">
              <Markdown blocks={parseMarkdown(b.line.text)} {onlink} />
            </div>
          </div>
        {/if}
      </div>
    {:else if b.kind === "shell"}
      <!-- A `!` run: a command you ran in this card's directory rather than
           something you said to its agent. Open unless you shut it, which is
           the one fold on this wall that starts that way round — the others
           hide machinery, and this is what you asked for.

           The cap is written whole by `bang.ts::runCap` when the run is drawn,
           so it carries the command, the line count and how it ended without
           this component knowing what any of those mean. -->
      <div class="fold run" class:shown={runOpen(b.key)}>
        <button
          type="button"
          class="cap"
          class:failed={b.line.state === "failed"}
          aria-expanded={runOpen(b.key) ? "true" : "false"}
          onclick={() => toggleRun(b.key)}
          title={runOpen(b.key) ? "fold what it printed away" : "what it printed"}
        >
          <span class="mark" aria-hidden="true">{runOpen(b.key) ? "▾" : "▸"}</span>
          <span class="what">{runFoldCap(b.line)}</span>
        </button>
        {#if runOpen(b.key) && b.line.text}
          <!-- No `data-nav`, like every other fold: the rails list places in the
               conversation, and a build's output is not one of them. -->
          <div class="inside">
            <div class="line out">{#each parseAnsi(b.line.text) as sp}<span
                  style:color={sp.color === null ? null : ANSI_PALETTE[sp.color]}
                  style:font-weight={sp.bold ? "600" : null}
                  style:opacity={sp.dim ? 0.6 : null}>{sp.text}</span
                >{/each}</div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="fold" class:shown={open[b.key]}>
        <button
          type="button"
          class="cap"
          aria-expanded={open[b.key] ? "true" : "false"}
          onclick={() => toggle(b.key)}
          title={open[b.key] ? "fold the calls away" : foldSummary(b.lines)}
        >
          <span class="mark" aria-hidden="true">{open[b.key] ? "▾" : "▸"}</span>
          <!-- Folded, the cap carries the latest call in the run, so a group at
               the foot of a live turn says what is happening without being
               opened. Open, the calls themselves say it. -->
          <span class="what">{open[b.key] ? foldCount(b.lines) : foldSummary(b.lines)}</span>
        </button>
        {#if open[b.key]}
          <div class="inside">
            {#each b.lines as line, i (i)}
              {@render one(line, lineKey(line, `${b.key}:${i}`))}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
{/snippet}

<!-- `--read` is set on the panel rather than on the column, so anything drawn
     here can be sized in step with the reading; only what is *in* the column
     actually uses it today. -->
<section class="detail" bind:this={panel} style:--read={read}>
  <!-- Over the wall rather than in the panel: what is being read keeps its full
       column, and the gaps between the rails stay wall you can pan. -->
  <div class="rails">
    <Rail label="you said" marks={said} active={saidAt} onpick={(i) => jump(said[i])} />
    <Rail
      label={contentsCap}
      marks={contents}
      active={contentsAt}
      onpick={(i) => jump(contents[i])}
    />
  </div>

  <!-- The column and the way back out of it. A wrapper, because the button has
       to hang off something that is *not* the scroller: absolutely positioned
       inside `.lines` it would be pinned to the text rather than to the panel,
       and would slide off the top the moment you scrolled up. -->
  <div class="reading">
    <div
      class="lines"
      bind:this={scroller}
      onscroll={onScroll}
      onwheel={stopGlide}
      oncopy={onCopy}
    >
      <!-- What was said before this card had a process listening. Drawn in the
           same column and the same kinds as the live fold, so the seam is a rule
           and a label rather than a change of voice. -->
      {#if conv.history.length}
        <div class="seam">
          <span>
            {conv.historyPartial
              ? "earlier — read from the transcript, from partway in"
              : "earlier — read from the transcript"}
          </span>
        </div>
        {@render column(past)}
        {#if conv.lines.length || conv.streaming}
          <div class="seam rule"></div>
        {/if}
      {:else if conv.historyState === "loading"}
        <div class="line meta">reading the transcript…</div>
      {/if}

      {@render column(live)}
      {#if conv.streaming}
        <!-- Two components, one column: what has settled and what is still
             being written. Neither adds an element, so `.md > :first-child` and
             `:last-child` still find the ends of the answer — and the settled
             array's identity only moves when one more block joins it, so
             Svelte's each walks none of them on an ordinary delta. That is the
             other half of the fix; parsing once would be wasted if the diff
             still read every block per token.
             The caret goes wherever the writing has got to, which is the last
             settled block on the deltas where the tail is only blank lines —
             or it would blink out between one paragraph and the next. -->
        <div class="line text md" data-nav="msg">
          <Markdown
            blocks={streamed.settled}
            caret={streamed.tail.length === 0}
            {onlink}
          />
          <Markdown blocks={streamed.tail} caret {onlink} />
        </div>
      {/if}
      <!-- What the agent is doing *now*, at the foot of the column.
           The transcript is a record of what landed, and a tool call lands as a
           line only when its block closes — so between "you asked" and the first
           thing written there was nothing on the page at all, and a run folded
           away is a page that does not visibly move for a minute at a time. This
           is the live edge: it says thinking, or the call in flight, and it goes
           when the turn does.
           Not while text is streaming — `activity` is "responding" then, and the
           words arriving above are a better account of it than the word is. -->
      {#if conv.working && conv.activity !== "responding"}
        <div class="line doing" aria-live="polite">
          <span class="pip" aria-hidden="true"></span>{conv.doing}
        </div>
        <!-- The one wait long enough to be worth a bar, and the only one whose
             bar is a guess — nothing on the wire says how far along a fold is,
             so this is drawn against what compactions have actually cost on
             this machine. It is built not to overclaim: it stops short of full
             at the predicted moment and creeps after, so it can never sit at
             the end pretending to be done, and the line above says "longer than
             usual" when the prediction has been blown. Dotted, like everything
             else here that is not yet settled. -->
        {#if conv.compactFrac !== null}
          <div
            class="guess"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.round(conv.compactFrac * 100)}
            aria-label="compacting, estimated"
          >
            <span class="fill" style:width="{conv.compactFrac * 100}%"></span>
          </div>
        {/if}
      {/if}
      <!-- An empty card should read as a beginning, not as a missing component.
           The theme is ink on paper down to its token names, so a card with
           nothing on it is a sheet with nothing on it — and one that has spoken
           but whose pages are not on disk is a different thing again, worth
           saying rather than dressing up as new. -->
      {#if conv.lines.length === 0 && !conv.working && !conv.streaming && conv.historyState !== "loading" && !conv.history.length}
        <div class="line meta">
          {#if !conv.dormant}
            the page is open — say something
          {:else if conv.everSpoke}
            its earlier pages aren't here — speak and it picks up where it left off
          {:else}
            a fresh sheet — it wakes when you speak
          {/if}
        </div>
      {/if}
    </div>

    <!-- Only when the way back is a journey. No arrow glyph: `↓` falls through
         to Segoe UI Emoji and renders *blue*, and colour on this wall is
         status. -->
    {#if far}
      <button class="to-end" onclick={toTail}>to the end</button>
    {/if}

    <!-- What the wheel just did, while you are doing it. Opposite corner from
         the way back out, and gone a moment later: a size that stayed on the
         panel would be furniture, and this is the report of a gesture. -->
    {#if showRead}
      <div class="read-size">text {Math.round(read * 100)}%</div>
    {/if}
  </div>

  <footer class="meta-bar">
    <span>{Math.round(conv.ctx * 100)}% context</span>
    <span class="sep">·</span>
    <span>{conv.ctxTokens.toLocaleString()} tok</span>
    <span class="sep">·</span>
    <span>{conv.turns} {conv.turns === 1 ? "turn" : "turns"}</span>
    {#if conv.costUsd > 0}
      <span class="sep">·</span>
      <span>${conv.costUsd.toFixed(3)}</span>
    {/if}
    <span class="grow"></span>
    {#if conv.model}<span class="model">{conv.model}</span>{/if}
    <!-- Beside the model because it is the other half of the same fact: which
         mind this card is talking to, and how hard it has been asked to think.
         Neither is on the wire — the model id arrives with the stream, the
         effort is read off the transcript — and both are readings rather than
         controls, so this footer states them and `/effort` changes them. -->
    {#if conv.effort}<span class="effort">{conv.effort}</span>{/if}
  </footer>
</section>

<style>
  .detail {
    flex: 1 1 auto;
    min-height: 0;
    /* Load-bearing: nothing in here may set the panel's width. A flex item's
       automatic minimum size is its *content's* min-content width, and three
       different things in a transcript have a large one — a table's is the sum
       of its columns, a code fence's is its longest line (capped at `.line`'s
       78ch, wider than this column ever is), and the `.meta-bar`'s mono model
       id does it at the 300px floor. Any of them widened this box past `.side`
       and off the right edge of the window: one wide table pushed it to 613px
       inside a 384px panel and gave the window itself a horizontal scrollbar.
       The `overflow-x: auto` on `.table-scroll` did not save it — a scroll
       container stops its content overflowing *it*, but Chromium still
       propagates the intrinsic width up through the ancestors, so the panel
       widened and the table then fitted. Probed 2026-08-13 against a standalone
       repro of this exact cascade. */
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--well);
    padding: 0.75rem 0.85rem 0.6rem;
    /* The rails hang off this. */
    position: relative;
  }

  /* Beside the panel, over the wall. Only the rails themselves take the mouse:
     the gaps around them are wall, and the wall pans. */
  .rails {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(100% + 0.7rem);
    width: clamp(9rem, 13vw, 15rem);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
    pointer-events: none;
    z-index: 2;
  }
  /* Holds the column and the button over it. `min-width: 0` for the same reason
     `.detail` has it — a fence's min-content must never reach the panel. */
  .reading {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  /* Quiet, achromatic, and clear of the 9px scrollbar. Opaque because it sits
     over the last lines of the answer, and raised off the well rather than
     outlined in anything brighter: it is a way out of where you are, not a
     status. */
  .to-end {
    position: absolute;
    right: 0.8rem;
    bottom: 0.55rem;
    padding: 0.2rem 0.6rem;
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 999px;
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.6;
    color: var(--paper-mute);
    cursor: pointer;
    user-select: none;
    box-shadow: 0 2px 10px #0009;
    animation: surface 110ms ease-out;
  }
  .to-end:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  @keyframes surface {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .to-end {
      animation: none;
    }
  }

  /* The size, while you are choosing it. Same chip as the way back out and the
     opposite corner, and deliberately *not* scaled by `--read`: it is the
     instrument, not the reading, and one that grew as you turned the wheel
     would be reporting on itself. `pointer-events: none` because it appears
     under a cursor that is mid-gesture. */
  .read-size {
    position: absolute;
    right: 0.8rem;
    top: 0.2rem;
    padding: 0.2rem 0.6rem;
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 999px;
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.6;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
    user-select: none;
    pointer-events: none;
    box-shadow: 0 2px 10px #0009;
    animation: surface 110ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .read-size {
      animation: none;
    }
  }

  /* Everything in the column is a multiple of `--read`, which ctrl+wheel sets
     and which is 1 until it has been touched. Written as `calc(Xrem * …)`
     rather than as an inherited `em` chain so each rule keeps the number it
     always had, and so a rule added here cannot silently opt out by being
     nested one level deeper than expected. The air between the lines goes with
     it: text at double size in a gap that stayed put reads as crowded. */
  .lines {
    flex: 1 1 auto;
    /* Both axes, spelled out. A table and a code fence bring their own
       horizontal scroller, which is the better one — it keeps the prose still
       while the wide thing moves. This is the backstop for whatever does not:
       the column scrolls sideways rather than spilling over the wall, and a
       transcript is a record, so nothing in it may be simply unreachable. */
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: calc(0.6rem * var(--read, 1));
    min-height: 0;
    min-width: 0;
    padding-right: 0.3rem;
    /* What a mark's `offsetTop` is measured against — see `measure`. */
    position: relative;
  }
  .line {
    /* The only size the column actually sets: a heading, a fence, a table and
       a caret are all `em` off this one, so this is the whole of the knob.

       Two multipliers, and they answer different questions. `--read` is
       ctrl+wheel — how large you want this hour's reading, held per card
       session in the studio. `--tx-size` is what the wall is *set* in, held by
       the theme. Keeping them apart means changing the theme does not throw
       away a size you had wheeled to, and vice versa. Both carry the value
       they always had as a fallback, so this rule is correct with neither
       `tokens.css` nor a theme in front of it. */
    font-size: calc(var(--tx-size, 0.86rem) * var(--read, 1));
    line-height: var(--tx-leading, 1.55);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* A line takes the panel, never its widest neighbour. `.lines` is a column
       flex container *and* a scroll container, so `align-items: stretch`
       resolves against the scrollable content width — which is whatever the
       widest child is. One wide table or code fence therefore set the measure
       for every paragraph in the transcript, and prose you had to scroll
       sideways to read was the result. A percentage resolves against the
       containing block instead, which is this column's content box whatever is
       overflowing it, so siblings stop deciding for each other. */
    width: 100%;
    max-width: 78ch;
  }
  /* The agent's prose — the thing the panel exists to be read in, at length.
     Themed apart from your own half below, because which of the two belongs at
     the top of the ink ramp is a real question: see the `prose` theme, which
     answers it the other way round. The fallback is the value this rule always
     carried, so the column is correct with no theme and no `tokens.css`. */
  .line.text {
    color: var(--tx-prose, var(--paper-dim));
  }
  /* A folded line brings its own layout: paragraphs keep the agent's newlines,
     but a heading, a list and a table must not be held in pre-wrap. */
  .line.md {
    white-space: normal;
  }
  /* Your half of the conversation. Set in against a rule rather than in a
     bubble: the transcript is one column of speech, and what distinguishes you
     is the margin, not a container. */
  .line.you {
    color: var(--tx-you, var(--paper));
    border-left: 2px solid var(--paper-faint);
    padding-left: calc(0.6rem * var(--read, 1));
    margin-left: -0.05rem;
    /* Where a round begins. Two paragraphs inside one answer sit 0.55em apart
       and a prompt sat only `.lines`' gap from the answer above it — about two
       pixels between "next paragraph" and "a whole new thing was said", which
       is proximity saying nothing and the reason finding a round wanted the
       rail. The left rule was already the landmark; this is the room it needs
       to act as one, and 0 is the historical value so an unthemed column is
       untouched.

       `--read`-multiplied like every other space in the panel: air that does
       not grow with the type closes up at 200%. The rule is off by default
       (`transparent`) and is the stronger setting of the same idea — the seam
       treatment the history boundary uses, applied per round. With the left
       rule already there it reads as a bracket opening the round rather than
       as one more horizontal line down a long card. Half the round's air sits
       under it, so the rule leads the prompt instead of touching it. */
    margin-top: calc(var(--tx-round, 0rem) * var(--read, 1));
    border-top: 1px solid var(--tx-round-rule, transparent);
    padding-top: calc(var(--tx-round, 0rem) * 0.5 * var(--read, 1));
  }
  /* Nothing above it to be separated from, and a rule across the top of the
     panel is furniture announcing the start of a column you are already
     looking at. */
  .line.you:first-child {
    margin-top: 0;
    border-top-color: transparent;
    padding-top: 0;
  }
  /* On its way. The rule goes dashed and the text sits back a shade — the same
     "not settled yet" the streaming fence uses, and achromatic, because a prompt
     in flight is not a status the wall reports in colour. */
  .line.you.pending {
    /* A shade back from wherever the theme put a settled prompt, rather than a
       fixed `--paper-dim`. Fixed was right while a prompt was always `--paper`
       and became wrong the moment `--tx-you` existed: the `prose` theme sets a
       settled prompt to `--paper-dim` itself, at which point "sits back a
       shade" was the same colour as arrived, and the only thing left saying a
       prompt was still in flight was the dashed rule. Mixing toward the well
       keeps the step whatever the theme does with the ramp. */
    color: color-mix(in srgb, var(--tx-you, var(--paper)) 68%, var(--well));
    border-left-style: dashed;
  }
  /* It never left. Rust, which is what failure is everywhere else here, and it
     says which failure rather than leaving a colour to be interpreted. The words
     stay exactly where they were written, to be copied back out of. */
  .line.you.failed {
    border-left-color: var(--st-fail);
  }
  .line.you.failed::after {
    content: " · not sent";
    font-family: var(--util);
    font-size: calc(0.7rem * var(--read, 1));
    color: var(--st-fail);
  }
  .line.tool {
    font-family: var(--mono);
    font-size: calc(0.7rem * var(--read, 1));
    color: var(--paper-mute);
  }
  .line.tool::before {
    content: "▸ ";
    color: var(--paper-faint);
  }
  .line.error {
    font-family: var(--mono);
    font-size: calc(0.7rem * var(--read, 1));
    color: var(--st-fail);
  }
  /* What you answered a parked question with. Small, and set just under the
     call that asked it: it is your words, so it is not monospaced like the
     machinery, but it is a reply rather than a prompt and must not carry the
     weight of one — a decision made in the dock is read here as the footnote to
     the call above, not as a new thing said. Achromatic, like everything else
     that is not a status: the amber the question wore was the card waiting, and
     it is not waiting any more. */
  .line.answer {
    font-family: var(--util);
    font-size: calc(0.74rem * var(--read, 1));
    color: var(--paper-mute);
  }
  .line.answer::before {
    content: "↳ ";
    color: var(--paper-faint);
  }

  /* ── a folded run of tool calls ─────────────────────────────────────────── */
  .fold {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  /* The cap is chrome, and reads as the calls it stands for: same monospace,
     same size, same paper as a tool line, so a folded run does not weigh more
     on the page than the run itself did. */
  .cap {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--mono);
    font-size: 0.7rem;
    line-height: 1.55;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .cap:hover {
    color: var(--paper-dim);
  }
  .cap .mark {
    flex: 0 0 auto;
    color: var(--paper-faint);
  }
  .cap .what {
    /* One line: an opened run is where the detail is. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fold.shown .cap {
    color: var(--paper-dim);
  }
  /* These caps are the register the `meta` line is in — the CLI talking
     about the conversation rather than in it — because that is what they are,
     and because reading as a tool call would put them among the machinery when
     they are the opposite: what the card kept, and what it was told to do. Set
     in a shade further from the tool caps around them, and given the seam's
     dotted rule under them, since each *is* a discontinuity — the same thing
     the seam between the file and the stream marks, happening mid-column. */
  .fold.long > .cap {
    font-family: var(--util);
    font-size: calc(0.72rem * var(--read, 1));
    padding-bottom: 0.25rem;
    border-bottom: 1px dotted var(--edge);
  }
  /* Opened, it is a long read and wants the column it is set in to say where it
     ends as clearly as where it begins. */
  .fold.long.shown > .inside {
    border-left-style: dotted;
    padding-bottom: 0.2rem;
  }
  /* ── a `!` run ──────────────────────────────────────────────────────────
     A command you drove rather than one the agent did, so the cap is set a shade
     brighter than the tool caps it sits among: this is the one piece of
     machinery in the column you put there yourself. */
  .fold.run > .cap .what {
    color: var(--paper-dim);
  }
  /* Rust, and on the *command* rather than in its output — which line failed is
     a question you ask having scrolled past a screenful of what it printed, so
     the answer wants to be at the top of that screen. The same call
     `Console.svelte` makes for the same reason. A run that was *stopped* wears
     nothing: killing it is something you did on purpose. */
  .cap.failed .what {
    color: var(--st-fail);
  }
  /* What it printed. `pre-wrap` because a build's indentation is how you read
     it, and `anywhere` because the panel is a third of the window wide and a
     stack trace's paths are longer than that. */
  .line.out {
    font-family: var(--mono);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--paper-mute);
  }

  /* Set in against a rule, the same way your own half of the conversation is:
     what binds the calls together is the margin, not a container. */
  .inside {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-left: 1px solid var(--edge);
    padding-left: 0.6rem;
    margin-left: 0.3rem;
  }

  /* The live edge. Celadon because it is a status and that is what celadon
     means on this wall — the same working colour the card is wearing. */
  .line.doing {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--paper-mute);
  }
  .line.doing .pip {
    flex: 0 0 auto;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    animation: pulse 2.4s ease-in-out infinite;
  }

  /* A predicted bar, drawn as one. The track is dotted rather than solid —
     everything unsettled in this panel is (the streaming fence, a pending
     prompt, the summary's rule), and a prediction is the most unsettled thing
     here. Celadon, because it is the working status and this is the same card
     state the pip above is reporting; it earns the colour by being a status
     rather than decoration.

     Two pixels tall and inset to sit under the words rather than beside them:
     it is the line's evidence, not a second thing to read. The transition is
     what makes a once-a-second `clock` look continuous — without it the fill
     steps ~0.8% at a time and reads as a stall. Linear, not eased: an eased
     step would accelerate and decelerate twice a second, which is worse than
     the step it hides. */
  .guess {
    height: 2px;
    margin: 0.1rem 0 0.15rem 0.65rem;
    border-bottom: 1px dotted var(--edge);
  }
  .guess .fill {
    display: block;
    height: 2px;
    background: var(--st-work);
    opacity: 0.55;
    transition: width 1s linear;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .line.doing .pip {
      animation: none;
    }
  }
  .line.meta {
    font-family: var(--util);
    font-size: calc(0.76rem * var(--read, 1));
    color: var(--paper-note, var(--paper-faint));
  }

  /* Where the file stops and the stream starts. Achromatic — this is chrome,
     not status. */
  .seam {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: calc(0.64rem * var(--read, 1));
    color: var(--paper-note, var(--paper-faint));
  }
  .seam::before,
  .seam::after {
    content: "";
    flex: 1 1 auto;
    height: 1px;
    background: var(--edge);
  }
  /* The closing seam carries no label: the history above it already said what
     it was, and the live lines below need no announcement. */
  .seam.rule {
    gap: 0;
  }

  .meta-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.45rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-note, var(--paper-faint));
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .meta-bar .grow {
    flex: 1 1 auto;
  }
  .meta-bar .sep {
    color: var(--edge);
  }
  .meta-bar .model {
    font-family: var(--mono);
    font-size: 0.64rem;
  }
  /* Quieter than the model id and set apart from it, so the pair reads as one
     thing with an aside rather than as two ids. No colour: colour is status
     here, and how hard a card thinks is not a status. */
  .meta-bar .effort {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0 0.25rem;
  }
</style>
