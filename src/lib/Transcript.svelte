<script lang="ts">
  import { untrack } from "svelte";
  import type { Line } from "./conversation.svelte";
  import Jobs from "./Jobs.svelte";
  import { countSaid } from "./gist";
  import Rail from "./Rail.svelte";
  import { nudgeReading } from "./layout";
  import { scopeFiles, scopePictures } from "./paths.svelte";
  import { readingOf } from "./gears";
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
  import { selectionMarkdown } from "./copy";
  /* The follow — the panel's own, which a conversation's every reading now
     wears — and the column it follows, which chat view draws too. See
     follow.svelte.ts and Thread.svelte. */
  import { Follow, RELEASE } from "./follow.svelte";
  import { refs } from "./refs.svelte";
  import { whois } from "./whois.svelte";
  import Thread from "./Thread.svelte";
  import HuntBar from "./HuntBar.svelte";
  import type { CardHandle } from "./cards.svelte";

  let {
    card,
    watching = true,
    read = 1,
    rails = "left",
    onread,
  }: {
    /** The conversation, by its handle — the column reads it, and asks it for
     *  its history and to open a file a tool call named, so neither is a
     *  callback a mounter could forget (`Thread.svelte`). */
    card: CardHandle;
    /** Which side the outline rails hang off, which is the side the wall is on
     *  — see the note by `.rails`. The panel's berth decides it
     *  (`berth.md`); the panel does not know, and should not. */
    rails?: "left" | "right";
    /** Whether this panel can actually be being read — today, whether the studio
     *  window has focus. Passed in rather than asked for here: the window's
     *  focus already has an owner in `attention.svelte.ts`, and a second
     *  subscription to it would be a second thing to release. */
    watching?: boolean;
    /** How large the transcript is drawn, as a multiplier — see
     *  `readingScale`. Resolved by the caller, because it is stored beside the
     *  viewport and the panel's width rather than in here. */
    read?: number;
    /** A notch of ctrl+wheel asking for a different size. Routed out for the
     *  same reason the width's drag is: how this window is set up to be read
     *  from is not the panel's to keep. */
    onread?: (next: number) => void;
  } = $props();

  const conv = $derived(card.readable);

  /* Which directory *this card's* prose counts from. One line, because the
     navigation comes down from the root — see `scopeFiles`. `null` for a chat
     card, which has no directory behind it: a relative path there counts from
     nowhere, and a link that resolves against nowhere is the dead link this
     whole path exists to avoid. */
  scopeFiles(() => (conv.kind === "project" ? conv.cwd : null) ?? null);
  /* And its pictures, which are read off this machine's disk: a card on another
     wall has its directory over there, and the same path here is a different
     picture drawn with nothing to say so. See `scopePictures`. */
  scopePictures(() => (conv.kind === "project" && !conv.elsewhere ? conv.cwd : null) ?? null);

  let scroller: HTMLDivElement | undefined = $state();

  /** The column, mounted in the scroller below. */
  let thread = $state<ReturnType<typeof Thread> | undefined>();

  /** The panel's follow: the tail, held while you are at it and let go of only
   *  by a hand. Its resize also re-measures the rails, because a rewrap moves
   *  every mark and `far` taken at the old width is a way back that never
   *  appears — only on a resize, since measuring is the walk `refresh` exists
   *  to throttle. */
  const follow = new Follow(() => measure());

  /** Open the find bar, or put the cursor back in it if it is already open.
   *
   *  Exported because Ctrl+F is a *global* binding — `App.svelte` owns the
   *  ladder and swallows the key everywhere so the browser never sees it. The
   *  find itself is the thread's (`hunt.svelte.ts`). */
  export function hunt() {
    thread?.finder().open();
  }

  /** Carry the view to the last line `want` matches — the thread's, which lets
   *  go of the tail by raising `RELEASE` on its way. */
  export function reveal(want: (line: Line) => boolean): boolean {
    return thread?.reveal(want) ?? false;
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

  function below(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
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
    /* And a run in flight belongs to the panel that is going away. Cleared here
       rather than left to the next `measure`, which is a timeout away: a button
       offering the way back on a panel that starts at the tail is a button
       pointing at where you already are. */
    follow.fresh();
    far = false;
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

  /* An id in the prose is drawn as its hex until the store or git says what it
     names, and then as the name — a change to the column that no line count
     sees. The rails read the drawn text, so without this they kept the hex
     (seen in the lab, 2026-10-21). */
  $effect(() => {
    void refs.answered;
    void whois.answered;
    refresh(STREAM_MS);
  });

  /* The rails' timer is the one thing here that outlives the panel; the
     follow's own go with its attachment. */
  $effect(() => () => clearTimeout(recollect));

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
    follow.carry();
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
    /* The one real gesture the scroller's own listeners cannot see, so it is said
       out loud here. Ctrl+arrow is read by `App.svelte`'s global ladder with the
       caret usually still in the draft, so the keydown never reaches `.lines` —
       and a gesture that leaves no record is now a gesture that cannot let go of
       the tail, which would make these keys unable to scroll up off a live turn. */
    follow.stepped();
    /* Yours, so it must be read as yours even if it lands exactly on the tail the
       follow last pinned — that is a step back *onto* a live turn, and taking it
       up again is the point of measuring rather than flagging. */
    const delta = dir * stepBy(kind, lineHeight(el), el.clientHeight);
    el.scrollTop = landing(el.scrollTop, delta, el.scrollHeight, el.clientHeight);
  }

  /* A panel nobody is looking at used to let go of the place it was holding,
     and that is gone.

     The argument for it was good and it has expired. It read: scrolling up
     during a live turn means "I am reading this", and the tail is let go of
     for exactly as long as that is true -- but turn to an editor for a minute
     and the agent writes another round underneath, so coming back to a view
     parked in the middle of the round before it is coming back to stale news.
     So while the studio was unfocused, anything arriving re-armed the tail and
     the follow took the view down.

     **What expired it is `3da8146`, two and a half weeks later: only a hand
     may let go of the tail.** Before that, `following` went false on its own
     all the time -- the clamp, scroll anchoring, a late-delivered write -- so
     re-arming it while you were away was *repair*, and usually right. After
     it, every path to `following = false` is a deliberate act: a wheel, a key,
     a scrollbar, unfolding a call, clicking a hunt match. So this effect could
     only ever fire over a decision somebody had made, which makes it wrong
     every time it does anything at all.

     And it is the second half of sink `b14e1606`, which is the half that bites
     an orchestrator: Lyss reads a card scrolled up, clicks into an editor --
     constantly, that is what orchestrating is -- a relay lands, the tail is
     re-armed, and coming back throws her place away. *"I intentionally
     scrolled up and I didn't unselect the card."* The comment this replaces
     already described the same complaint one case narrower, from when the blur
     alone could trigger it: *"Scroll into the middle of a finished
     conversation, click an editor, and the panel you were reading threw the
     place away with nothing having arrived to justify it."* That was fixed by
     gating on arrival. The remaining case is the same loss with something
     having arrived, which is not a justification for discarding a decision --
     the newest thing said is one flick of the wheel away, and the place she
     was holding is not recoverable by any gesture at all.

     **Nothing replaces it, and nothing needs to.** The returning-to-the-window
     pin below is a separate effect and is the one that actually mattered: it
     honours `following` rather than overwriting it, so a card left at the tail
     still lands on the newest line when you come back, which is the case this
     one was really protecting. A card left scrolled up stays where you left it.

     The general shape, and it is this file's own lesson arriving from outside:
     **a repair written for a flag that lied is a bug once the flag tells the
     truth.** Anything that corrects a value "for" the user has to be re-read
     whenever that value's meaning is tightened. */

  /* Following the tail while the column grows, hearing a hand on it, and
     letting go of it when the thread says a fold was worked are all the
     follow's now (`follow.svelte.ts`), worn by the scroller below. What stays
     here is the panel's own answer to the thread letting go: the column just
     changed height, so every offset the rails measured is stale — including
     which mark counts as where you are reading. */
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const again = () => refresh(0);
    el.addEventListener(RELEASE, again);
    return () => el.removeEventListener(RELEASE, again);
  });

  /* And coming back to the window is a moment to honour the tail, because the
     frame the follow waits for may never have come while you were away:
     Chromium suspends `requestAnimationFrame` for a minimised or fully occluded
     window, so every scroll the re-arm above asked for is a callback queued
     behind the restore rather than a view at the bottom. It costs nothing when
     the tail was genuinely let go of — `keepTail` returns — and is the
     difference between landing on the newest thing said and landing wherever the
     column happened to leave you.

     `watching` is the one dependency, and `keepTail`'s read of `following` is
     untracked for the reason this whole file is careful about: in an effect a
     condition and a trigger are the same act unless you separate them. */
  $effect(() => {
    void watching;
    untrack(() => follow.keepTail());
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
      if (untrack(() => follow.following)) follow.pin();
      else if (at !== null) el.scrollTop = at * el.scrollHeight;
      /* After the scroll, not before: `measure` reads `scrollTop`. */
      refresh(0);
    });
  });

  $effect(() => () => clearTimeout(readTimer));
</script>

<!-- `--read` is set on the panel rather than on the column, so anything drawn
     here can be sized in step with the reading; only what is *in* the column
     actually uses it today. -->
<section class="detail" bind:this={panel} style:--read={read}>
  <!-- What this wall knows about the conversation that the conversation cannot
       say for itself — only a card on another wall has any: how far back what
       is drawn goes, a read that failed, an ask of its wall in flight or
       refused, a question it is parked on. Read off the readable, so the panel
       is one component for both kinds of card (`handle.ts::panelNotes`). -->
  {#if conv.notes?.length}
    <div class="notes">
      {#each conv.notes as n, i (i)}
        <p class="note" class:warn={n.tone === "warn"} class:ask={n.tone === "ask"}>{n.text}</p>
      {/each}
    </div>
  {/if}
  <!-- Over the wall rather than in the panel: what is being read keeps its full
       column, and the gaps between the rails stay wall you can pan. -->
  <div class="rails" class:other={rails === "right"}>
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
    <!-- Finding a word in what you are reading. Over the column rather than
         above it, so opening it does not reflow the thing you are searching —
         the one gesture where the text moving under you is the worst possible
         answer. It sits at the top because a match is scrolled to the *centre*,
         so a bar at the foot would be the one place a match can never be. -->
    {#if thread?.finder().on}
      <HuntBar hunt={thread.finder()} onclose={() => scroller?.focus()} />
    {/if}
    <div
      class="lines"
      bind:this={scroller}
      onscroll={measure}
      {@attach follow.attach}
      oncopy={onCopy}
    >
      <!-- The conversation itself — what was said, folded where it is
           machinery, and the turn still being written. `display: contents`, so
           this scroller's flex sees its lines exactly as before it was a
           component of its own. -->
      <Thread bind:this={thread} {card} />
    </div>

    <!-- Only when the way back is a journey. No arrow glyph: `↓` falls through
         to Segoe UI Emoji and renders *blue*, and colour on this wall is
         status. -->
    {#if far}
      <button class="to-end" onclick={() => follow.toTail()}>to the end</button>
    {/if}

    <!-- What the wheel just did, while you are doing it. Opposite corner from
         the way back out, and gone a moment later: a size that stayed on the
         panel would be furniture, and this is the report of a gesture. -->
    {#if showRead}
      <div class="read-size">text {Math.round(read * 100)}%</div>
    {/if}
  </div>

  <!-- What this card has running in the background, and its output as it
       arrives. Between the column and the footer because that is the one strip
       of the panel that does not move while you read — a dev server is started
       once, hours ago, so its tool call is a long way up a scrollback you would
       have to go and find, and a pane growing inside the column would fight the
       follow. Draws nothing at all when the card holds no background work,
       which is most cards. See `Jobs.svelte` for the poll's argument. -->
  <Jobs {conv} {watching} />

  <footer class="meta-bar">
    <span>{Math.round(conv.ctx * 100)}% context</span>
    <span class="sep">·</span>
    <!-- Off the gist, which a card anywhere answers (`gist.ts`): a card on
         another wall drew "0 tok · 0 turns" here off constants. What its wall
         did not send is said as unknown, never as a number. -->
    <span title={card.gist.ctxTokens === null ? "its wall does not say" : undefined}>{countSaid(card.gist.ctxTokens)} tok</span>
    <span class="sep">·</span>
    <span title={card.gist.turns === null ? "its wall does not say" : undefined}
      >{countSaid(card.gist.turns)} {card.gist.turns === 1 ? "turn" : "turns"}</span
    >
    {#if card.gist.costUsd}
      <span class="sep">·</span>
      <span>${card.gist.costUsd.toFixed(3)}</span>
    {/if}
    <span class="grow"></span>
    <!-- Where the conversation is, for a card on another wall: said once, in
         the line that says what the card *is*, and nowhere in the column —
         repeating it beside every line would make the conversation harder to
         read for nothing new. Muted with its wall. -->
    {#if conv.elsewhere}
      <span class="where" class:quiet={conv.elsewhere.unheard} title="this card runs on {conv.elsewhere.host}"
        >on {conv.elsewhere.host}{conv.elsewhere.unheard ? ", not heard from" : ""}</span
      >
      <span class="sep">·</span>
    {/if}
    {#if conv.model}<span class="model">{conv.model}</span>{/if}
    <!-- Beside the model because it is the other half of the same fact: which
         mind this card is talking to, and how hard it has been asked to think.
         Neither is on the wire — the model id arrives with the stream, the
         effort is read off the transcript — and both are readings rather than
         controls, so this footer states them and `/effort` changes them. -->
    {#if conv.effort}<span class="effort">{conv.effort}</span>{/if}
    <!-- And the third of the same fact: what this card is allowed to do. Stated
         here rather than only drawn on the card, because the card can say only
         "not quite settled" with a dashed edge and this is the line with room
         for the word. Only when it is *planning* — "making" is what every card
         on this wall has always been, and a word that never varies is one
         nobody reads after the first day. Same argument as `acct`. -->
    {#if conv.gear === "planning"}
      <span class="gear" title={readingOf(conv.gear).note}
        >{readingOf(conv.gear).name}</span
      >
    {/if}
  </footer>
</section>

<style>
  /* Beside `.model` and `.effort` and drawn like them: a reading, not a
     control. Achromatic — a planning card can be working, asking or failed like
     any other, and tinting the word would put a fifth thing in a channel that
     has three. */
  .gear {
    border: 1px dashed var(--edge);
    border-radius: 3px;
    padding: 0 0.3rem;
  }

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
  /* The rails hang *toward the wall*, which is the whole of why they are
     outside the panel — "the gaps between them stay wall you can pan". Which
     side that is stopped being a constant when the panel grew a berth
     (`berth.md`): moored left, the wall is on the right, and rails left would
     be off the edge of the window entirely. Floating, there is wall on both
     sides and the caller picks the roomier one. */
  /* Top and bottom are the wall's, not the panel's, and those differ beside a
     dock that has left the panel its column: the panel runs on past the wall
     into the band beside the dock (`berth.md`), and rails hung its whole height
     were drawn over the dock's own text. `App.svelte` sets the two variables on
     the panel to how far it runs past the wall each way, and they are zero
     everywhere else. */
  .rails {
    position: absolute;
    top: var(--reach-top, 0px);
    bottom: var(--reach-bottom, 0px);
    right: calc(100% + 0.7rem);
    width: clamp(9rem, 13vw, 15rem);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
    pointer-events: none;
    z-index: 2;
  }
  .rails.other {
    right: auto;
    left: calc(100% + 0.7rem);
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
    box-shadow: 0 2px 10px color-mix(in srgb, var(--shade) 60%, transparent);
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
    box-shadow: 0 2px 10px color-mix(in srgb, var(--shade) 60%, transparent);
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
  /* A host name is free text and can be long (`lab-actb.queerisfreedom`), and a
     flex row shrinks every item in proportion, so one long name wrapped "0%
     context" onto two lines. The name gives way first — a heavier shrink and
     no floor, ellipsised, its full spelling in the title — but not to nothing:
     at a weight of a hundred it collapsed to "o…" beside a long model id,
     which says less than wrapping did. Only this item; a card here's footer is
     exactly what it was. */
  .meta-bar .where {
    flex: 0 4 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .meta-bar .where.quiet {
    color: var(--paper-mute);
  }
  /* What only a card on another wall says above its conversation. Quiet, and
     coloured only where it is a status — rust for an ask its wall refused,
     amber for a question it is parked on. */
  .notes {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 0 0 auto;
  }
  .notes .note {
    margin: 0;
    font-family: var(--util);
    font-size: calc(0.74rem * var(--read, 1));
    line-height: 1.5;
    color: var(--paper-note, var(--paper-faint));
  }
  .notes .note.warn {
    color: var(--st-fail);
  }
  .notes .note.ask {
    color: var(--st-ask);
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
