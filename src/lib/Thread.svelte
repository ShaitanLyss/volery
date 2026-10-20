<script lang="ts">
  /* One conversation's column: what was said, folded where it is machinery,
     with the turn still being written at its foot.

     It was the inside of `Transcript.svelte` — the `one` and `column` snippets,
     the streaming tail, the fold state and the find — and came out on its own
     because the panel is no longer the only reading of a conversation. Chat view
     (`docs/chat-mode.md` §7.2) draws the same column in a different room, and a
     column drawn twice is a column that drifts. Everything panel-shaped stayed
     behind: the rails, the reading size, the footer, the jobs drawer, the way
     back to the end. What came here is what a conversation *is* on screen.

     Four things it owns, each because a reading that forgot it would be wrong
     rather than plain:

     - **The folds**, local, as they always were. Not a module keyed by the card:
       a fresh view of a card is a fresh view, so chat view and the panel each
       start closed.
     - **The find** (`hunt.svelte.ts`), because the highlights are read inside the
       column and landing on a match opens the fold it is in. Whoever mounts the
       thread draws the bar (`HuntBar.svelte`) over its own scroller.
     - **Letting go of the tail.** A fold worked, a match landed on, a write
       revealed: each raises `RELEASE` on this element, which bubbles to the
       scroller wearing `follow.svelte.ts`'s `Follow`. An event rather than a
       callback prop, so no mounter can forget to pass it.
     - **The history.** A card on another wall opens empty until its column is
       pulled, so any mount of the thread asks — through the handle, which is
       why this takes a `CardHandle` rather than a `Readable` and two callbacks.

     What it does not own: the files and pictures scopes. Those stay ambient and
     the mounter sets them (`scopeFiles`, `scopePictures`), as the panel always
     has, so a path is clickable here by the thread existing in a scope. */
  import { untrack } from "svelte";
  /* A `!` run keeps its colour: the shell is spawned with FORCE_COLOR, so `cargo`
     and `git` answer in SGR sequences exactly as they do in the console panel,
     and this is the same parser reading them. */
  import { ansiVar, parseAnsi } from "./ansi";
  import type { Line } from "./conversation.svelte";
  import type { CardHandle } from "./cards.svelte";
  import Markdown from "./Markdown.svelte";
  import ToolCall from "./ToolCall.svelte";
  import Figure from "./Figure.svelte";
  import { parseMarkdown, StreamedMarkdown } from "./markdown";
  import {
    blocksOf,
    foldCount,
    foldSummary,
    runFoldCap,
    runSummary,
    longFold,
    type Block,
  } from "./transcript";
  import { view } from "./view.svelte";
  import { clock } from "./conversation.svelte";
  import { spanOf } from "./classify";
  import { MIN_QUERY, matchAt } from "./hunt";
  import { Hunting } from "./hunt.svelte";
  import { RELEASE } from "./follow.svelte";
  import { others } from "./others.svelte";
  import { spawnedHandle } from "./chatview";
  import { relayBody, relayFrom, sentOf } from "./relay";
  import { ageOf } from "./chatview";
  import { cardName } from "./naming";

  let { card }: { card: CardHandle } = $props();

  /* Chat view reads a run of machinery as what it came to, where the panel
     reads it as a status line of its last call (`docs/chat-mode.md` §4.2, §6.4
     "the live parts"). Read, not passed: the view is one holder for the
     window, and the panel is not mounted while chat view is up. */
  const chat = $derived(view.current === "chat");
  /** The run still being written: the last block of the live column while the
   *  card works. Chat view shows it as the step it is on and how long it has
   *  been at it — shimmer with a clock beside it, never shimmer alone. */
  const liveRun = $derived.by(() => {
    if (!conv.working) return null;
    const last = live[live.length - 1];
    return last && last.kind === "tools" ? last.key : null;
  });

  const conv = $derived(card.readable);

  /* The other conversations, if the surface above can reach them — chat view
     can and the wall's panel provides nothing, so the relations below are
     drawn there and nowhere else (`others.svelte.ts`). */
  const reach = others();

  /** A message longer than this is cut to a few lines until opened. */
  const LETTER_LONG = 520;
  /** A card as a letter names it. */
  function nameOf(c: CardHandle): string {
    return cardName(c.face.title, "").text || "a conversation";
  }
  /** Who a sent message went to, as the agent wrote it: a handle that is a
   *  card here becomes that card, the two broadcast words are said as words,
   *  and anything else is shown as written. */
  function recipient(to: string): { name: string; card: CardHandle | null } {
    const word = to.toLowerCase();
    if (word === "project") return { name: "every card in this project", card: null };
    if (word === "skein") return { name: "every card on the wall", card: null };
    const c = reach?.find(to) ?? null;
    return { name: c ? nameOf(c) : to, card: c };
  }
  /** How long ago, coarse, or nothing for a line that never had a time. */
  function when(at: number | undefined): string {
    return at ? `${ageOf(clock.t - at)} ago` : "";
  }

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
  /* In chat view a message this card sent stands where it was sent, as a
     letter, rather than inside the run of calls around it (`Block` "sent"). */
  const apart = $derived(chat ? (l: Line) => sentOf(l.call) !== null : undefined);
  const past = $derived(blocksOf(conv.history, "h", 0, apart));
  /* `conv.dropped` is what makes a live line's key its absolute position rather
     than its index in a window that slides — without it the whole column is
     rebuilt on every message past the cap, and the reading goes with it. See
     `Conversation.dropped`. */
  const live = $derived(blocksOf(conv.lines, "l", conv.dropped, apart));

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

  /** This element: `display: contents`, so the scroller's own flex sees the
   *  lines as it always did, and still something to raise an event on and to
   *  find a block under. */
  let root: HTMLDivElement | undefined = $state();

  /** A fold you have just worked is something you are asking to read where it
   *  is, so it lets go of the tail — the same argument the rails' `jump` makes,
   *  and one the follow needs made out loud: it hears the column itself, so a
   *  call unfolded at the bottom of a live turn would otherwise carry the view
   *  straight past the header to the end of whatever it uncovered.
   *
   *  Said for closing as well as for opening, and that is safe rather than
   *  sloppy: a shorter column clamps the view back down onto the tail, which is
   *  a real scroll event, and the follow measures it and takes the tail up
   *  again. Raised rather than called back: see `RELEASE`. */
  function release() {
    root?.dispatchEvent(new CustomEvent(RELEASE, { bubbles: true }));
  }

  function toggleRun(key: string) {
    if (shut[key]) delete shut[key];
    else shut[key] = true;
    release();
  }

  function toggle(key: string) {
    if (open[key]) delete open[key];
    else open[key] = true;
    release();
  }

  /* ── finding a word in what you are reading ──────────────────────────────
   *
   * Ctrl+F used to reach the webview's own find bar, which searched the *whole
   * document* — the header, every card title, every widget on the wall — and
   * drew Chromium's chrome over an app that has none. Asked for by the user
   * (sink 776a4d34). The arithmetic is `hunt.ts`, pure and tested; the state is
   * `hunt.svelte.ts`; this is the stepping and the scroll.
   *
   * Both columns at once, past and live, because "this transcript" is what the
   * reader is showing and the split into history and live is an implementation
   * detail of how it got there. */
  const hunt = new Hunting(() => [...past, ...live], carry);

  /** The find, for whoever draws its bar. */
  export function finder(): Hunting {
    return hunt;
  }

  /** Carry the view to the match at `mark`.
   *
   *  Opens the fold it is in first, which is the half that makes searching a
   *  closed fold honest: `hunt.ts::textOf` deliberately looks inside one, so a
   *  match there is real and landing on a collapsed line would be the reader
   *  saying "here" and showing nothing.
   *
   *  Lets go of the tail, because this is you changing your mind about where
   *  the view should be, and the follow would otherwise write the tail straight
   *  over it on the next event. */
  function carry() {
    const at = matchAt(hunt.found, hunt.mark);
    if (!at || !root) return;
    release();
    if (shut[at.key]) delete shut[at.key];
    if (!open[at.key]) open[at.key] = true;
    requestAnimationFrame(() => {
      const wrap = root?.querySelector<HTMLElement>(`[data-hunt="${CSS.escape(at.key)}"]`);
      /* The *child*, not the wrapper. `.blk` is `display: contents`, which is
         what makes an anchor per block free — and an element with no box has
         nothing for `scrollIntoView` to scroll to, so aiming at the wrapper
         silently does nothing at all. */
      const el = wrap?.firstElementChild ?? wrap;
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /** The block a reveal last landed on, lit for a moment so the eye finds it
   *  in a column that has just scrolled under it. Cleared by its own timer. */
  let sought = $state<string | null>(null);
  let soughtTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => () => {
    if (soughtTimer) clearTimeout(soughtTimer);
  });

  /** Carry the view to the last line `want` matches, opening the fold it is in.
   *
   *  The last rather than the first, because what asks is a timeline step
   *  looking for the write that finished it, and a receipt is unique — but a
   *  caller with a looser test wants the most recent, which is the one nearest
   *  where the reader already is. Answers whether anything matched, so a caller
   *  whose card is still reading its history off disk can try again.
   *
   *  Lets go of the tail for `carry`'s reason: this is you choosing where the
   *  view should be, and the follow would otherwise write the tail over it. */
  export function reveal(want: (line: Line) => boolean): boolean {
    if (!root) return false;
    const blocks = [...past, ...live];
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const lines = b.kind === "tools" ? b.lines : [b.line];
      if (!lines.some(want)) continue;
      release();
      if (b.kind === "tools" && !open[b.key]) open[b.key] = true;
      if (b.kind === "long" && !open[b.key]) open[b.key] = true;
      sought = b.key;
      if (soughtTimer) clearTimeout(soughtTimer);
      soughtTimer = setTimeout(() => (sought = null), 1800);
      requestAnimationFrame(() => {
        const wrap = root?.querySelector<HTMLElement>(`[data-hunt="${CSS.escape(b.key)}"]`);
        /* The child, for `carry`'s reason: `.blk` has no box of its own. */
        const el = wrap?.firstElementChild ?? wrap;
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      return true;
    }
    return false;
  }

  /* A new query starts from the first match rather than from wherever the last
     one left the cursor, and lands on it without being asked. */
  $effect(() => {
    const q = hunt.query;
    if (!hunt.on) return;
    hunt.mark = 0;
    if (q.trim().length >= MIN_QUERY) carry();
  });

  /* A different card is a different column: the keys belong to the column that
     is going — another card's groups would be closed anyway, and a key it
     happens to share is not the same run. */
  $effect(() => {
    void conv.id;
    open = {};
  });

  /* Mounting the thread is what pays for reading a multi-megabyte file: the
     wall itself never needs the scrollback, and reading every card's transcript
     at launch would undo lazy restore.

     Untracked, because the loader's own first act is to read `historyState` to
     see whether it has already run — inside a tracking scope that would make
     this effect depend on the very field it is about to write.

     And again whenever the card says there is more to read (`historyMark`),
     which only a card on another wall has: its conversation is pulled from its
     own wall rather than read off this disk, so it is pulled again when that
     wall says it has moved on. A card here reads once, and its own fold does
     the rest. */
  $effect(() => {
    const c = conv;
    void c.id;
    void c.historyMark;
    untrack(() => card.history());
  });
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
      root={conv.kind === "project" ? conv.cwd : undefined}
      onfile={card.look}
    />
  {:else if line.kind === "text"}
    <!-- `data-nav` is the rail's whole handle on the panel: this one is the
         answer itself, and the marks inside it are its shape. -->
    <!-- Narration is the server's summary of what the agent wrote between tool
         calls, which is all of that prose the wire carries. Speech, so drawn as
         speech; marked, because it is the gist rather than the words. -->
    <div
      class="line text md"
      class:narration={line.narration}
      data-nav="msg"
      title={line.narration
        ? "summarised by the server — what the agent wrote between tool calls"
        : undefined}
    >
      <Markdown blocks={parseMarkdown(line.text)} />
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
      class:held={line.state === "held"}
      class:failed={line.state === "failed"}
      data-nav={line.kind === "you" ? "you" : null}
    >{line.text}</div>
    <!-- What became of it on another machine. Only a shadow card sets this, and
         it is under the words rather than beside them for the reason the `you`
         register itself is drawn plainly: the receipt is about the sending, not
         part of what was said. A line this wall still holds and a line the far
         wall has are the two cases somebody is actually watching for, so the
         second is drawn quietly and the first and third are not. -->
    {#if line.receipt}
      <div class="receipt" class:late={line.state === "failed"}>{line.receipt}</div>
    {/if}
    <!-- Sent while the agent was working: the CLI queues it behind the running
         turn (`turns.md`), and `awaited` is the honest flag for as long as that
         holds — `pending` is taken off by the running turn's next message,
         whose answer is not about this prompt (CLAUDE.md, *Settling a line is
         not claiming it*). So it says when it goes, rather than looking sent.
         *Send now* is a stop and nothing else: an interrupt does not lose a
         queued prompt, the CLI takes it up next, and stopping then sending
         would deliver it twice (`docs/chat-mode.md` §5.6). -->
    {#if line.kind === "you" && line.awaited && conv.working && line.state !== "held" && line.state !== "failed"}
      <div class="receipt queued" aria-live="polite">
        queued — it goes when this turn finishes
        {#if card.can("stop") === "yes"}
          <button
            type="button"
            class="now"
            onclick={() => void card.do("stop")}
            title="stop this turn — the queued message goes next (esc)">send now</button
          >
        {/if}
      </div>
    {/if}
    <!-- The pictures that went with the prompt, under the words that refer to
         them by name. Thumbnails rather than the bytes that were sent — a card
         talking all week would otherwise hold every screenshot at full size for
         as long as it is on the wall (`attach.ts::THUMB_SIDE`).

         A restored card has none: they were never in the session file as
         anything a panel could draw, so a transcript read back off disk shows
         the prompt with its `[name]` tokens and nothing under it. That is the
         honest shape rather than a gap — the sentence still says which picture
         it meant. -->
    {#if line.shots?.length}
      <div class="shots">
        {#each line.shots as s (s.name)}
          <img src={s.thumb} alt={s.name} title={s.name} />
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

<!-- Where a spawn call stands, the conversation it started (§5.5): its name,
     what it is doing, its live dot, and the way into it. Only where the view
     can reach other cards; the wall shows the same thing as a limb. -->
{#snippet linked(lines: Line[])}
  {#if reach}
    {#each lines as l, i (i)}
      {@const h = spawnedHandle(l.call)}
      {@const kid = h ? reach.find(h) : null}
      {#if kid}
        <button
          type="button"
          class="linked"
          class:work={kid.face.working}
          onclick={() => reach.open(kid.id)}
          title="open the conversation this one started"
        >
          <svg class="i" viewBox="0 0 16 16" aria-hidden="true"
            ><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5.5" r="1.6" /><path
              d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3.2-5.4 3.9"
            /></svg
          >
          <span class="who">
            <span class="t">{cardName(kid.face.title, "").text || "a conversation"}</span>
            <span class="sub"
              >started by this conversation · {kid.ask
                ? "asking you something"
                : kid.face.working
                  ? kid.face.doing || "working"
                  : kid.face.tier === "fail"
                    ? "stopped on an error"
                    : "at rest"}</span
            >
          </span>
          <span class="go"
            ><i class="st" class:work={kid.face.working} class:ask={!!kid.ask} class:fail={kid.face.tier === "fail"}
            ></i>open</span
          >
        </button>
      {/if}
    {/each}
  {/if}
{/snippet}

<!-- A message between two conversations, either way (Lyss, 2026-10-20: *"messages
     sent or received are displayed as plain text instead of having a nice
     ui"*). The spawn link's family — a bordered card with the other card's
     name, its live dot and the way into it — so a thread reads as one house.
     A long one is cut to a few lines until opened, with the folds' own
     toggle, so a coordinator's brief does not bury the round you came for. -->
{#snippet letter(key: string, dir: "in" | "out", who: { name: string; card: CardHandle | null }[], sub: string, body: string)}
  {@const long = body.length > LETTER_LONG}
  {@const one = who.length === 1 ? who[0].card : null}
  <div class="letter" class:out={dir === "out"} data-nav="msg">
    <div class="hd">
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true"
        >{#if dir === "in"}<path d="M10 3 4 8l6 5" /><path d="M4 8h9" />{:else}<path d="M6 3l6 5-6 5" /><path
            d="M12 8H3"
          />{/if}</svg
      >
      <span class="who">
        <span class="t"
          >{#if dir === "out"}<span class="to">to{" "}</span>{/if}{#each who as w, i (i)}{#if i}<span class="to">,{" "}</span>{/if}{#if w.card}{@const c = w.card}<button
                type="button"
                class="name"
                onclick={() => reach?.open(c.id)}
                title="open {w.name}">{w.name}</button
              >{:else}{w.name}{/if}{/each}</span
        >
        <span class="sub">{sub}</span>
      </span>
      {#if one}
        {@const c = one}
        <button type="button" class="go" onclick={() => reach?.open(c.id)}
          ><i class="st" class:work={c.face.working} class:ask={!!c.ask} class:fail={c.face.tier === "fail"}></i>open</button
        >
      {/if}
    </div>
    <div class="bd md" class:cut={long && !open[key]}>
      <Markdown blocks={parseMarkdown(body)} />
    </div>
    {#if long}
      <button type="button" class="more" aria-expanded={open[key] ? "true" : "false"} onclick={() => toggle(key)}
        >{open[key] ? "show less" : "show all"}</button
      >
    {/if}
  </div>
{/snippet}

<!-- A column of blocks: lines, and runs of tool calls folded into one cap each.
     Nothing navigable is ever inside a fold — a tool call carries no `data-nav` —
     so the rails list the same places whatever is open. -->
{#snippet column(blocks: Block[])}
  {#each blocks as b (b.key)}
    <!-- A wrapper per block, and only so a find has something to scroll to.
         `display: contents` so it is invisible to layout — the column's own
         flex still sees the block itself, which is what keeps this from being a
         reflow in exchange for a feature. The band is drawn on the wrapper
         rather than on the block, because a block is four different elements
         depending on what it is and one of them is a component. -->
    <div
      class="blk"
      data-hunt={b.key}
      class:found={hunt.lit.has(b.key)}
      class:here={hunt.here === b.key}
      class:sought={sought === b.key}
    >
    {#if b.kind === "line"}
      {@render one(b.line, lineKey(b.line, b.key))}
      {#if b.line.call}{@render linked([b.line])}{/if}
    {:else if b.kind === "long" && chat && b.line.kind === "relay"}
      <!-- In chat view a relay is a message *from* whoever sent it, not a fold
           of machinery and never your own words (§5.5) — a letter: the sender
           named and openable where they are on the wall, then what they said.
           The envelope's note to the model stays out, as `relayBody` keeps it
           out everywhere. -->
      {@const from = relayFrom(b.line.text)}
      {@const sender = from?.handle && reach ? reach.find(from.handle) : null}
      {@render letter(
        b.key,
        "in",
        [{ name: sender ? nameOf(sender) : (from?.name ?? "another conversation"), card: sender }],
        ["sent this conversation a message", from?.handle, when(b.line.at)].filter(Boolean).join(" · "),
        relayBody(b.line.text),
      )}
    {:else if b.kind === "sent"}
      <!-- A message this conversation sent, out of the run it was sent in —
           the same letter the other way round, marked by a dashed edge and an
           outgoing arrow so the two directions never read alike. -->
      {@const m = sentOf(b.line.call)}
      {#if m}
        {@render letter(
          b.key,
          "out",
          m.to.map(recipient),
          [
            m.delivered === false
              ? `not delivered — ${m.why || "the wall refused it"}`
              : m.delivered === null
                ? "sending…"
                : "this conversation sent",
            when(b.line.at),
          ]
            .filter(Boolean)
            .join(" · "),
          m.message,
        )}
      {/if}
    {:else if b.kind === "long"}
      <!-- What a compaction carried forward, the whole of a skill the agent
           invoked, the prompt rousing sent a card whose turn was cut off, or
           Skein's account of why a prompt it re-sent is in the column twice.
           Folded like a run of calls, but marked as its own thing: the words
           inside are neither yours nor the agent's — the CLI or Skein put them
           there — so they must not be able to be read as either. Closed until
           you open it, which is the whole point: a summary runs to twenty
           thousand characters, a skill to rather more, and the resume prompt to
           twenty lines of instructions addressed to somebody else — and the
           round you came here to read is on the far side of one.

           One branch for all four, because the drawing is the same problem four
           times and only the cap differs — `longFold` is where it does. The
           `failed` mark is the resume prompt's alone: folded, the line's own is
           not on screen to be read.

           The resend mark is the one that is not a whole line of its own on the
           wire — it is the tail of a prompt, and `blocksOf` has drawn the rest
           of that prompt as an ordinary `you` line directly above this block.
           So here alone the thing above the fold and the thing inside it were
           one string when they went.

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
              <Markdown blocks={parseMarkdown(b.line.text)} />
            </div>
          </div>
        {/if}
      </div>
    {:else if b.kind === "shown"}
      <!-- A picture an agent showed, where it showed it — never inside a fold,
           since it is the thing the turn wanted you to look at. See
           `.claude/rules/showing.md`. -->
      <Figure line={b.line} />
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
                  style:color={sp.color === null ? null : ansiVar(sp.color)}
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
          {#if chat}
            {@const sum = runSummary(b.lines)}
            {#if b.key === liveRun}
              {@const since = b.lines[0]?.at}
              <span class="what live"
                ><span class="shimmer">{b.lines[b.lines.length - 1]?.text ?? ""}</span>{#if since}<span class="time"
                    >{spanOf(Math.max(0, (clock.t - since) / 1000))}</span
                  >{/if}</span
              >
            {:else}
              <span class="what"
                >{#if sum.worked !== null}<b>worked for {spanOf(sum.worked / 1000)}</b>{" — "}{/if}{sum.words ||
                  foldCount(b.lines)}</span
              >
              {#if sum.added || sum.removed}<span class="delta">+{sum.added} −{sum.removed}</span>{/if}
            {/if}
          {:else}
            <span class="what">{open[b.key] ? foldCount(b.lines) : foldSummary(b.lines)}</span>
          {/if}
        </button>
        {#if open[b.key]}
          <div class="inside">
            {#each b.lines as line, i (i)}
              {@render one(line, lineKey(line, `${b.key}:${i}`))}
            {/each}
          </div>
        {/if}
      </div>
      {@render linked(b.lines)}
    {/if}
    </div>
  {/each}
{/snippet}

<!-- `display: contents`: the scroller this is mounted in is a flex column, and
     its gap and its children are the lines, exactly as before there was a
     thread between them. -->
<div class="thread" bind:this={root}>
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
      />
      <Markdown blocks={streamed.tail} caret />
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

<style>
  .thread {
    display: contents;
  }

  /* One wrapper per block, and `display: contents` is the whole of why it is
     affordable: the column's flex layout still sees the block itself, so this
     adds an anchor to scroll to and changes nothing about how anything sits.

     Which means the band cannot be a background — a `display: contents` element
     has no box to paint. It is drawn on the block inside instead, which is the
     one thing a wrapper can still reach. */
  .blk {
    display: contents;
  }
  /* Every match, quietly. A found block is a place worth noticing while you
     scan; it is not where you are. */
  .blk.found > :global(*) {
    background: color-mix(in srgb, var(--paper) 7%, transparent);
    border-radius: 2px;
  }
  /* And where you are, which has to be findable at a glance in a column of
     them. Still achromatic — brighter rather than coloured. */
  .blk.here > :global(*) {
    background: color-mix(in srgb, var(--paper) 15%, transparent);
    outline: 1px solid var(--paper-faint);
    outline-offset: 1px;
  }
  /* Where a timeline step carried you: the find's own mark, fading out once
     the eye has had it. Brighter rather than coloured, as `here` is. */
  .blk.sought > :global(*) {
    border-radius: 2px;
    animation: sought 1.8s ease-out both;
  }
  @keyframes sought {
    0%,
    35% {
      background: color-mix(in srgb, var(--paper) 15%, transparent);
      outline: 1px solid var(--paper-faint);
      outline-offset: 1px;
    }
    100% {
      background: transparent;
      outline: 1px solid transparent;
      outline-offset: 1px;
    }
  }
  :global(html[data-motion="still"]) .blk.sought > :global(*) {
    animation: none;
    background: color-mix(in srgb, var(--paper) 15%, transparent);
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
  /* A pseudo-element rather than a child, so `.md > :last-child` still finds
     the end of the answer and a copy never carries the word. Achromatic: what
     this says is whose words these are, which is not a status. */
  .line.text.narration::after {
    content: "summary";
    display: block;
    margin-top: calc(0.15rem * var(--read, 1));
    font-family: var(--util);
    font-size: calc(0.68rem * var(--read, 1));
    color: var(--paper-faint);
  }
  /* Your half of the conversation. Set in against a rule rather than in a
     bubble: the transcript is one column of speech, and what distinguishes you
     is the margin, not a container. */
  /* Your half of the conversation. On the wall, set in against a rule; in chat
     view, a bubble on the right — the one convention every chat product shares,
     and the one visible difference between the two readings of this column
     (`docs/chat-mode.md` §7.2). It is custom properties rather than a class a
     mounter reaches in to restyle, and every one of them defaults to exactly
     what the panel draws, so the panel does not move a pixel:

     `--you-align`, `--you-width` — where the line sits and how wide;
     `--you-fill`, `--you-radius` — the bubble's ground and corners;
     `--you-rule` — the left edge (the panel's rule);
     `--you-edge` — the other three edges (the panel has none but the round's);
     `--you-pad-l/-r/-t/-b` — the padding; `--you-face`, `--you-size` — the type.
     */
  .line.you {
    color: var(--tx-you, var(--paper));
    border-left: var(--you-rule, 2px solid var(--paper-faint));
    padding-left: var(--you-pad-l, calc(0.6rem * var(--read, 1)));
    margin-left: -0.05rem;
    align-self: var(--you-align, auto);
    width: var(--you-width, 100%);
    background: var(--you-fill, none);
    border-radius: var(--you-radius, 0);
    border-right: var(--you-edge, 0 solid transparent);
    border-bottom: var(--you-edge, 0 solid transparent);
    padding-right: var(--you-pad-r, 0);
    padding-bottom: var(--you-pad-b, 0);
    font-family: var(--you-face, inherit);
    font-size: var(--you-size, calc(var(--tx-size, 0.86rem) * var(--read, 1)));
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
    border-top: var(--you-edge, 1px solid var(--tx-round-rule, transparent));
    padding-top: var(--you-pad-t, calc(var(--tx-round, 0rem) * 0.5 * var(--read, 1)));
  }
  /* The pictures a prompt carried, under it and inside its bracket — the left
     rule continues past them, because they are part of the same thing you said.
     A row that wraps rather than scrolls: twenty images is the cap and a
     sideways scroller inside a column you are already scrolling is two gestures
     fighting. */
  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    border-left: 2px solid var(--paper-faint);
    padding-left: calc(0.6rem * var(--read, 1));
    margin-left: -0.05rem;
    padding-top: 0.35rem;
  }
  .shots img {
    max-width: calc(7rem * var(--read, 1));
    max-height: calc(7rem * var(--read, 1));
    border-radius: 2px;
    /* Opaque, per the standing rule — a PNG with an alpha channel drawn onto
       the panel would show whatever is behind it through the middle of the
       picture. */
    background: var(--surface);
  }

  /* Nothing above it to be separated from, and a rule across the top of the
     panel is furniture announcing the start of a column you are already
     looking at.

     The first prompt *of the column*, which is what this was written against —
     and for two months it meant every prompt. `44a19be` wrapped each block in a
     `.blk` for the find to scroll to, and a prompt is the first child of its
     own wrapper, so `.line.you:first-child` matched them all: the round's air
     and rule (`--tx-round`, set by `readable`, `column` and the themes built
     on them) were zeroed on every prompt and no theme could draw them. Anchored
     through the wrapper now, which is the column's first block or nothing. */
  .thread > .blk:first-child > .line.you {
    margin-top: 0;
    border-top-color: var(--you-first-top, transparent);
    padding-top: var(--you-pad-t, 0);
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
  /* Kept for an allowance to come back (`holding.ts`). Sits back like a
     prompt on its way, and says what it is waiting for in the face `· not
     sent` uses — but achromatic, because nothing has gone wrong: the card has
     your words and will send them itself. Rust is kept for the one state of
     the four that means they did not go. */
  .line.you.held {
    color: color-mix(in srgb, var(--tx-you, var(--paper)) 68%, var(--well));
    border-left-style: dashed;
  }
  .line.you.held::after {
    content: " · held — will send when allowance returns";
    font-family: var(--util);
    font-size: calc(0.7rem * var(--read, 1));
    color: var(--paper-faint);
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
  /* What the far wall did with a prompt. Sits under the words in the utility
     face at the same size `· not sent` uses, indented to the prompt's own rule
     so the two read as one thing. Achromatic while it is ordinary — a message
     crossing a network is not a status — and rust only where it stopped being
     ordinary, which is the house rule for colour rather than an exception to
     it. Not copied: `copy.ts` takes what is drawn, and a receipt is Volery's
     sentence about the sending rather than anything anybody said. */
  .receipt {
    font-family: var(--util);
    font-size: calc(0.7rem * var(--read, 1));
    color: var(--paper-faint);
    padding-left: 0.75em;
    margin-top: calc(-0.15rem * var(--read, 1));
    user-select: none;
  }
  .receipt.queued {
    display: flex;
    gap: 0.6em;
    align-items: baseline;
    align-self: var(--you-align, auto);
  }
  .receipt .now {
    font: inherit;
    color: var(--paper-mute);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 3px;
  }
  .receipt .now:hover {
    color: var(--paper);
  }
  .receipt.late {
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

  /* ── a side question, and what came back ─────────────────────────────────
     `/btw`. Neither of these is part of the conversation — the question opened
     no turn and the answer came from a *fork* of the session — so they are set
     apart rather than drawn as a prompt and an answer. A rule down the left is
     what says "beside": the column's own voices all start at the margin, and
     these two are the only pair that does not.

     Achromatic, because colour on this wall is status and a side question is
     not one. Quiet, because it is a footnote to a conversation that is carrying
     on without it — which is the whole feature. */
  .line.asked,
  .line.aside {
    border-left: 1px solid var(--edge);
    padding-left: 0.5rem;
    margin-left: 0.1rem;
    font-family: var(--util);
    font-size: calc(0.74rem * var(--read, 1));
    white-space: pre-wrap;
  }
  /* The question is yours, so it takes the weight your prompts take — one step
     down, since it is a footnote. */
  .line.asked {
    color: var(--paper-dim);
  }
  .line.asked::before {
    content: "btw ";
    font-family: var(--mono);
    font-size: 0.9em;
    color: var(--paper-faint);
  }
  .line.aside {
    color: var(--paper-mute);
  }

  /* ── chat view's relations (§5.5) ───────────────────────────────────────── */
  /* The conversation a spawn started, as the mockups' `.linked`: a quiet card
     with a wash of the working hue only while it works. */
  .linked {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 50%, transparent);
    font: inherit;
    font-family: var(--cv-ui, var(--util));
    font-size: 13px;
    color: var(--paper-dim);
    text-align: left;
    cursor: pointer;
  }
  .linked.work {
    background:
      linear-gradient(90deg, color-mix(in oklab, var(--st-work) calc(10% * var(--ch-bloom, 1)), transparent), transparent 60%),
      color-mix(in oklab, var(--surface) 50%, transparent);
  }
  .linked:hover,
  .linked:focus-visible {
    border-color: var(--edge);
  }
  .linked .i {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--paper-mute);
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .linked .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .linked .t {
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .linked .sub {
    font-size: 12px;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .linked .go {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--paper-dim);
  }
  .linked .st {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-rest);
  }
  .linked .st.work {
    background: var(--st-work);
  }
  .linked .st.ask {
    background: var(--st-ask);
  }
  .linked .st.fail {
    background: var(--st-fail);
  }
  /* A message between conversations: a letter, in the spawn link's family. */
  .letter {
    padding: 12px 16px 14px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 50%, transparent);
  }
  /* Sent, the other way: the edge dashed and no fill, so the two directions
     never read alike even with the arrows out of sight. */
  .letter.out {
    border-style: dashed;
    background: none;
  }
  .letter .hd {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    margin-bottom: 8px;
    font-family: var(--cv-ui, var(--util));
  }
  .letter .i {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--paper-mute);
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .letter .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .letter .t {
    font-size: 13.5px;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .letter .to {
    color: var(--paper-mute);
  }
  .letter .sub {
    font-size: 12px;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .letter button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .letter .name:hover,
  .letter .name:focus-visible {
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
  }
  .letter .go {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--paper-dim);
  }
  .letter .st {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-rest);
  }
  .letter .st.work {
    background: var(--st-work);
  }
  .letter .st.ask {
    background: var(--st-ask);
  }
  .letter .st.fail {
    background: var(--st-fail);
  }
  /* Cut to a few lines, fading out rather than stopping on a hard edge. */
  .letter .bd.cut {
    max-height: 9.5em;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black 60%, transparent);
  }
  .letter .more {
    margin-top: 6px;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-mute);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
  }

  /* ── a folded run of tool calls ─────────────────────────────────────────── */
  /* A run of calls folded: on the wall a line of chrome in the tool's own
     mono; in chat view a quiet card, the mockups' `.work` — set by custom
     properties (`--run-*`) whose defaults are exactly the panel's, so nothing
     here reaches in from outside and the panel does not move. */
  .fold {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border: var(--run-border, 0 solid transparent);
    border-radius: var(--run-radius, 0);
    background: var(--run-fill, none);
    padding: var(--run-pad, 0);
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
    font-family: var(--run-face, var(--mono));
    font-size: var(--run-size, 0.7rem);
    line-height: 1.55;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .cap b {
    font-weight: 500;
    color: var(--paper);
  }
  .cap .delta,
  .cap .time {
    margin-left: auto;
    padding-left: 0.6rem;
    flex: 0 0 auto;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--cv-note, var(--paper-mute));
  }
  .cap .what.live {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    color: var(--paper);
  }
  /* The live step's shimmer: a band of the sheet's own ink moving across the
     words, by transform only, only while a step is live (a running clock sits
     beside it, so a stalled agent does not read as a working one). `spare`
     steps it, `still` and reduced motion stop it (`motion.md`). */
  .shimmer {
    position: relative;
    overflow: hidden;
    display: inline-block;
    vertical-align: bottom;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shimmer::after {
    content: "";
    position: absolute;
    inset: 0 -60%;
    background: linear-gradient(
      100deg,
      transparent 35%,
      color-mix(in oklab, var(--cv-sheet, var(--ink)) 70%, transparent) 50%,
      transparent 65%
    );
    animation: sweep 1.8s var(--ease-move, ease-in-out) infinite;
  }
  @keyframes sweep {
    from {
      transform: translateX(-45%);
    }
    to {
      transform: translateX(45%);
    }
  }
  :global(html[data-motion="spare"]) .shimmer::after {
    animation-timing-function: steps(8, end);
  }
  :global(html[data-motion="still"]) .shimmer::after {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer::after {
      animation: none;
    }
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
  :global(html[data-motion="still"]) .line.doing .pip {
    animation: none;
  }
  :global(html[data-motion="spare"]) .line.doing .pip {
    animation-timing-function: steps(6, end);
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
</style>
