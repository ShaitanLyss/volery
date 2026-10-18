<script lang="ts">
  /* The dock: the strip along the bottom of the wall where a prompt is written.
   *
   * Cut out of `App.svelte` after a `.ghost` here and a `.ghost` in the header
   * turned out to be the same selector — one 565-line stylesheet holding two
   * unrelated subsystems, where Svelte's scoping had nothing to bite on. Both
   * halves now have their own, which is the sort of fix a language enforces
   * rather than a reviewer. `test/styles.test.ts` guards the rest.
   *
   * What is here is what the dock alone owns: the target line, the palette in
   * its two stages, the `!` line's offering and bar, and the field. What is not
   * is what the keys and the sends *do* — that is the composer's
   * (`composer.svelte.ts`, its table in `composer.ts`), because chat view draws a
   * second field over the same draft and the two must not drift. Read its table
   * against `onGlobalKey` in `App.svelte`: the two ladders still share every
   * key. */
  import { tick } from "svelte";
  import Ask from "./Ask.svelte";
  import Notice from "./Notice.svelte";
  import type { Skein } from "../lib/skein.svelte";
  import type { Conversation } from "../lib/conversation.svelte";
  import type { CardHandle, Cards } from "./cards.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import type { Front } from "./front.svelte";
  import type { Composer } from "./composer.svelte";
  import { replies } from "./replies.svelte";
  import { glance } from "./glancing.svelte";
  import type { Orphan, Reply } from "./replies";
  import { isShadowKey } from "./shadow";
  import type { DockChord } from "./leader";
  import { scopeFiles } from "./paths.svelte";
  import { completionForChoice } from "./commands";
  import { nameBesideProject } from "./naming";
  import { promptPath } from "./shell";
  import { BANG, isBang, kindLabel, tokens } from "./bang";
  import PromptBox from "./PromptBox.svelte";
  import type { DockSite } from "./berth";

  let {
    field,
    skein,
    bang,
    card,
    cards,
    front,
    targets,
    waiting,
    clashing,
    bangCard,
    berth,
    grabbing,
    onmoor,
    onheight,
    composer,
    oncycle,
    onselect,
  }: {
    /** What is being typed and what the typing currently means. */
    field: Field;
    skein: Skein;
    /** The `!` line's session — its runs and its completions. */
    bang: Bang;
    /** The card in the ring, on this wall or another, as the handle every
     *  gesture here takes (`cards.svelte.ts`): what the line above the field
     *  says about it, its stop, and the words typed to it all come through
     *  it, so the dock has one card and never asks which kind. */
    card: CardHandle | null;
    /** Every card on every wall, as handles. Their questions and notices are
     *  the queue (`items`), drawn by the same panels and held by the same rule
     *  — see `queue.ts`. */
    cards: Cards;
    /** What is in front of you — the queue, and which item of it is held
     *  (`front.svelte.ts`). */
    front: Front;
    /** A gathering of this wall's cards, for a broadcast — a selection never
     *  holds a card on another wall. */
    targets: Conversation[];
    /** Cards that want you, in the order the Tab cycle takes them. */
    waiting: Conversation[];
    /** Ids among the targets that have already edited the same files as another
     *  target — a broadcast about to land twice in one tree. */
    clashing: string[];
    /** Which card a `!` line would run in. One card, never the gathering. */
    bangCard: Conversation | null;
    /** Where the dock is moored, and — while it is floating — the box it was
     *  put in, in window coordinates. The dock has always been a strip along
     *  the bottom; over three screens that is a line of text pinned to the
     *  corner of one of them, so it can go to the top or come off both edges.
     *  See `berth.ts`, which owns the sites and the drop rule.
     *
     *  `inset` is how far in from each side a moored dock stops — the
     *  panel's column, when the dock takes only the width the panel leaves
     *  (`berth.ts::dockInsets`), and zero both sides otherwise. */
    berth: { site: DockSite; x: number; y: number; w: number; inset: { left: number; right: number } };
    /** The mooring handle is being dragged, so it says so under the cursor. */
    grabbing: boolean;
    /** The three halves of that drag, which live in `App.svelte` beside the
     *  panel's — one gesture over two surfaces wants one implementation, and
     *  the room a drop is measured against is the window's rather than the
     *  dock's. */
    onmoor: {
      down: (e: PointerEvent) => void;
      move: (e: PointerEvent) => void;
      up: () => void;
      reset: () => void;
    };
    /** How tall the dock is drawn, which is the draft's business and not the
     *  berth's — the field grows as you type. Reported rather than stored, so
     *  a floating dock can be clamped against a bottom edge it actually has. */
    onheight: (h: number) => void;
    /** The window's message to a card — what a key in the field does, what
     *  Enter sends and to whom, the commands and the `!` line
     *  (`composer.svelte.ts`). The dock is one drawing of it; its field
     *  registers itself as the composer's input. */
    composer: Composer;
    oncycle: (step: 1 | -1) => void;
    /** Land on a card, here or elsewhere, the way clicking it does — asked for
     *  by a panel when the card being asked is not the one in the ring, and by
     *  "more waiting on you", so the transcript beside the item is its card's. */
    onselect: (card: CardHandle) => void;
  } = $props();

  /* ── what is in front of you ───────────────────────────────────────────
   *
   * The queue every card writes to, the one item of it that is held, the guard
   * for a held item going while you type into it, and the step to the next:
   * `front.svelte.ts`, constructed in `App.svelte`, because chat view draws the
   * same queue and a hold the dock owned would be dropped every time chat view
   * unmounts it. The dock draws the held item; `queue.ts` still has the rule,
   * and the bug that made it one rule rather than one per kind. */
  const items = $derived(front.items);
  const shown = $derived(front.shown);
  const next = $derived(front.next);
  const waitingOnYou = $derived(front.waitingOnYou);
  /** The card in the ring, here or on another wall. */
  const ring = $derived(card?.id ?? null);

  /* The dock draws whichever card is waiting, which need not be the card in
     the ring — `elsewhere` is that case and it is drawn on the panel. So a
     path in the question belongs to the asking card's directory, and never to
     the focused one: the same file name in two projects would have opened the
     wrong one, silently. See `scopeFiles`. A card on another wall has no
     directory here, so its paths are plain words — its pictures arrive
     resolved (`flyway/look.rs`). This call went missing with the hold rule
     (f96136e), which left every path in a question pointing at nothing. */
  const shownCard = $derived(shown?.of.conv ?? null);
  scopeFiles(() => (shownCard?.kind === "project" ? shownCard.cwd : null) ?? null);

  /* ── a reply whose item went first ─────────────────────────────────────
   *
   * What you typed is kept under the item it was typed to (`replies`), and an
   * item can go before its reply is sent: a deadline, a turn taking a rest
   * notice down, a send the other side refused, a question you deferred, the
   * process dying under a parked one. So whatever is kept for an item no
   * longer waiting is said here, with the words, and offered back — derived
   * from the store and the queue alone, which is what makes it survive a
   * reload: nothing has to have watched the item go. A reply is only ever let
   * go on purpose.
   *
   * Not before the queue it belongs to has been read: at launch every notice
   * looks gone until the queue is read, and a far one until its wall is
   * heard. A far card whose wall never comes back keeps its reply until it
   * ages out (`REPLY_KEEP_MS`) — the one case this cannot say anything about. */
  const live = $derived(new Set(items.map((t) => t.key)));
  function ready(r: Reply): boolean {
    /* A queue is read once its wall has said what is in it: this one's at
       launch, another's when it is heard. */
    const far = cards.find(r.card)?.remote;
    if (far) return !far.unheard;
    if (isShadowKey(r.card)) return false;
    return skein.loaded && skein.noticesRead;
  }
  const strays = $derived(replies.orphans(live, ready));
  const stray = $derived(strays[0] ?? null);

  function reachable(o: Orphan): CardHandle | null {
    return cards.find(o.card);
  }

  /** Into the prompt, at the card it was written to — the ring goes there
   *  first, so the words land in that card's draft rather than whichever one
   *  is in hand. Appended to anything already written there. */
  async function reclaim(o: Orphan) {
    const to = reachable(o);
    if (!o.text || !to) return;
    onselect(to);
    await tick();
    field.put(field.text.trim() ? `${field.text.trimEnd()}\n\n${o.text}` : o.text);
    replies.forget(o.item);
    composer.input?.focus();
  }

  async function copyStray(o: Orphan) {
    try {
      await navigator.clipboard.writeText(o.text);
      replies.forget(o.item);
    } catch {
      skein.fault = "could not write to the clipboard — the reply is still kept";
    }
  }

  /** The dock's verbs for the leader (`<space>d`, `leader.ts`), so nothing
   *  here is mouse-only. Answers why it did nothing, for the caller to say. */
  export function chord(act: DockChord): string | null {
    if (act === "next") {
      if (!next) return "nothing else is waiting on you";
      front.more();
      return null;
    }
    if (act === "glance") {
      /* What the asking card last said, beside the question. A notice already
         *is* that reading, so there is nothing to open for one. */
      if (shown?.kind !== "ask") {
        return shown ? "the notice already shows what it said" : "nothing is waiting on you";
      }
      const at = front.heldEl?.querySelector("[data-ask]") ?? null;
      return glance.open(shown.of.id, at, true) ? null : "it has not said anything yet";
    }
    if (!stray) return "no unsent reply is waiting";
    if (act === "reclaim") {
      if (!reachable(stray)) return "the card it was for has gone — copy it or drop it";
      void reclaim(stray);
    } else if (act === "copy") void copyStray(stray);
    else replies.forget(stray.item);
    return null;
  }

  /* The border box, fractions and all. It was `clientHeight`, which leaves out
     the border and rounds — harmless for clamping a floating dock, and not for
     the panel beside an available-width dock, which is let out past the wall by
     exactly this much and would stop a hairline short of the window's edge. */
  let box = $state<ResizeObserverSize[] | undefined>(undefined);
  const height = $derived(box?.[0]?.blockSize ?? 0);
  /* Braced, not an arrow expression: an effect that *returns* a value is an
     effect Svelte reads as handing back a teardown, and `(h) => (dockH = h)`
     answers the number it assigned. */
  $effect(() => {
    onheight(height);
  });

  /* The field's own rules — a dismissal that does not outlive its draft, the
     lit row going back to the top — are `Field`'s now, and the caret and the
     stir are the composer's: every view over the draft has them by existing. */

  /** Whichever of the palette's two stages is up. Bound by both, since they are
   *  the arms of one `if` and never both on screen. */
  let palette = $state<HTMLElement | undefined>(undefined);

  /* The lit row is kept in view, because the palette is now long enough to need
     it: Volery's own nine plus everything the agent answers to came to 66 rows
     on the wall this was written for. It scrolls rather than being cut off at some
     number — a list that silently stops at ten says a card has no skill that it
     does have, which is worse than a list you have to scroll. Found by asking
     the DOM rather than by binding the lit button, because which button is lit
     changes with an index and `bind:this` does not take a condition. */
  $effect(() => {
    field.at;
    field.commands;
    field.choices;
    palette?.querySelector(".cmd.on")?.scrollIntoView({ block: "nearest" });
  });

</script>

<!-- Moored beside a panel it stops at the panel's border: a margin on a
     stretched item in the studio's column is the whole of "the width the panel
     leaves", and the panel runs on past the wall into the room it frees. Never
     on a floating dock, which is fixed and placed by `left` — a margin there
     would move it off the spot it was dropped on. -->
<footer
  bind:borderBoxSize={box}
  class="dock"
  data-attach-area
  class:moored-top={berth.site === "top"}
  class:afloat={berth.site === "float"}
  style:width={berth.site === "float" ? `${berth.w}px` : undefined}
  style:left={berth.site === "float" ? `calc(${berth.x}px - var(--span-x, 0px))` : undefined}
  style:top={berth.site === "float" ? `calc(${berth.y}px - var(--span-y, 0px))` : undefined}
  style:margin-left={berth.site !== "float" && berth.inset.left ? `${berth.inset.left}px` : undefined}
  style:margin-right={berth.site !== "float" && berth.inset.right ? `${berth.inset.right}px` : undefined}
>
  <!-- The handle that moves the whole dock: to the top, or off both edges, and
       along an edge to say how much of it to take. Faint until asked for, in
       the dock's own padding so it is never over anything you are reading. The
       keyboard path is the two chords in the title — a chord cannot point at a
       place, so one cycles the three sites and the other the two widths. -->
  <div
    class="moor"
    class:on={grabbing}
    role="presentation"
    title="drag to move the dock — top, bottom, or floating; the middle of an edge for its whole width, a corner for the width the panel leaves · double-click to put it back (space then w d, space then w a)"
    onpointerdown={onmoor.down}
    onpointermove={onmoor.move}
    onpointerup={onmoor.up}
    onpointercancel={onmoor.up}
    ondblclick={onmoor.reset}
  ></div>
  <!-- A reply typed to something that went before it was sent. Above the
       panel rather than in it, because the panel has already moved on to the
       next thing, and quiet: it is a thing kept for you, not a fault. -->
  <!-- A reply typed to something that went before it was sent. Above the
       panel rather than in it, because the panel has already moved on to the
       next thing, and quiet: it is a thing kept for you, not a fault. -->
  {#if stray}
    {@const s = stray}
    {@const to = reachable(s)}
    <div class="unsent" role="status">
      <span class="why"
        >not sent — {s.about}{s.why ? `: ${s.why}` : " went before your reply did"}{strays.length > 1
          ? ` · 1 of ${strays.length}`
          : ""}</span
      >
      <span class="words">{s.text}</span>
      {#if to}
        <button
          class="keep"
          onclick={() => void reclaim(s)}
          title="Put it in the prompt, aimed at the card it was written to (space then d p)"
          >to its prompt</button
        >
      {/if}
      <button class="keep" onclick={() => void copyStray(s)} title="Copy it, and let it go (space then d c)"
        >copy</button
      >
      <button class="keep" onclick={() => replies.forget(s.item)} title="Let it go (space then d x)"
        >drop</button
      >
    </div>
  {/if}
  {#if front.swapped}
    <div class="unsent" role="status"><span class="why">{front.swapped}</span></div>
  {/if}

  <!-- One branch per kind, and the kind of the thing held never changes, so
       the panel drawing it is never torn down and rebuilt while it is held —
       which is what keeps the caret in the field you are typing in. There used
       to be two branches apiece for the far kinds (ahead of this wall's items
       when their card was in the ring, behind otherwise), and an item moving
       between them was remounted mid-sentence.

       `display: contents`, so the wrapper changes no layout; it is here to
       know whether the caret is in the panel, and to hold the first Enter
       after the held item went from under it (`guardEnter`). A pointer in it
       is you acting, and lets the guard go. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="held"
    bind:this={front.heldEl}
    onkeydowncapture={front.guardEnter}
    onpointerdowncapture={() => (front.swapped = null)}
  >
    <!-- A question or a notice from a card here or on another wall, in the
         one panel each has. What differs is the card's, read off its handle:
         its project line names the wall it is on, and answering goes back down
         the prompt wire to the wall it came from. A
         question that shows something is drawn from the call's own arguments
         either way (`flyway/look.rs`), scripts gated as here by the card's
         kind. -->
    {#if shown?.kind === "ask"}
      {@const target = shown.of}
      {@const sheet = shown.ask}
      <Ask
        ask={sheet}
        card={target.id}
        project={target.where}
        title={target.face.title}
        scripts={target.scripts}
        elsewhere={target.id !== ring}
        onanswer={() => target.answer(sheet)}
        ondefer={() => target.defer(sheet)}
        onheld={() => target.holdAsk()}
        onselect={() => onselect(target)}
      />
    {:else if shown?.kind === "notice"}
      {@const n = shown.notice}
      {@const target = shown.of}
      <Notice
        notice={n}
        project={target.where}
        title={target.face.title}
        elsewhere={target.id !== ring}
        onack={() => target.acknowledge(n, "")}
        onclosecard={() => void target.do("close")}
        onfollow={(text) => target.acknowledge(n, text)}
        onselect={() => onselect(target)}
      />
    {/if}
  </div>
  {#if shown && next}
    <button class="more" onclick={() => front.more()} title="Step to the next thing waiting (space then d n)">
      {waitingOnYou - 1} more waiting on you
    </button>
  {:else if shown && waitingOnYou > 1}
    <!-- Questions queued behind this card's own, which nothing reaches but
         answering it: a count, not a button that would do nothing. -->
    <span class="behind">{waitingOnYou - 1} more queued behind this one</span>
  {/if}

  <div class="targets">
    {#if targets.length > 1}
      <span class="count bcast">Broadcast to {targets.length}</span>
      {#each targets as t (t.id)}
        <span class="tgt" class:clash={clashing.includes(t.id)}>
          <b>{t.project}</b>
          {nameBesideProject(t.title)}
        </span>
      {/each}
    {:else if card}
      <span class="count">To</span>
      <span class="tgt"><b>{card.face.project}</b> {nameBesideProject(card.face.title)}</span>
      <!-- What sending will do to it, said before you find out — dormant, set
           aside, interrupted, and for a card on another wall where the words go
           and what can travel there. One list off the handle
           (`handle.ts::dockHints`, which has the reasons), so the two kinds of
           card cannot say different things here. -->
      {#each card.hints as h (h.text)}
        <span class="hint" class:warn={h.tone === "warn"}>{h.text}</span>
      {/each}
    {:else}
      <span class="count dim">No card focused</span>
    {/if}
    <!-- The counterpart of the send below it, and only ever offered while
         there is a turn to end. It names the card when the row above is a
         broadcast readout, because "stop" beside a list of four is a
         question rather than a verb — the key and the button both aim at
         the focused card alone. -->
    {#if card?.face.working || card?.can("stop") === "yes"}
      <!-- On a card elsewhere too: stopping a turn crosses as an act, and a
           wall too old to be asked says so when it is pressed rather than the
           button being missing. -->
      <button class="stop" onclick={() => void card?.do("stop")}>
        <span class="sq"></span>
        stop{targets.length > 1 ? ` ${card.face.project}` : ""}
        <span class="kbd">esc</span>
      </button>
    {/if}
    <span class="grow"></span>
    {#if waiting.length}
      <button class="cycle" onclick={() => oncycle(1)}>
        {waiting.length} waiting <span class="kbd">⇥</span>
      </button>
    {/if}
  </div>
  {#if clashing.length > 1}
    <div class="clashwarn">
      <span>⚠</span>
      <span>
        {clashing.length} of these {targets.length} have edited the same files —
        they'll work on one tree
      </span>
    </div>
  {/if}

  <!-- Above the field, so it grows towards the wall rather than pushing the
       field down under the cursor that is typing into it.

       Two stages, never both: the field.commands, and then — for one that takes a
       fixed set of values — the values. Listed here are Skein's own and the
       handful of the CLI's that this window knows the shape of; everything
       else the agent offers is its business, and there is no way to enumerate
       it from here. -->
  {#if field.choices.length && field.choosing}
    <div
      class="palette"
      role="listbox"
      aria-label="/{field.choosing.cmd.name} values"
      bind:this={palette}
    >
      {#each field.choices as choice, i (choice.value)}
        {@const on = choice === field.choicePick}
        <button
          class="cmd"
          class:on
          role="option"
          aria-selected={on}
          onmousedown={(e) => {
            /* mousedown, not click: the field must not lose focus first, or
               the draft is cleared while the caret is somewhere else. */
            e.preventDefault();
            field.at = i;
            void composer.sendText(
              completionForChoice(field.choosing!.cmd, choice),
              targets.length > 1,
            );
          }}
          onmouseenter={() => (field.at = i)}
        >
          <span class="name">{choice.value}</span>
          <span class="summary">{choice.summary}</span>
          <span class="grow"></span>
          {#if targets.length > 1}
            <span class="reach">{targets.length} cards</span>
          {/if}
        </button>
      {/each}
      <p class="detail">{field.choosing.cmd.detail}</p>
    </div>
  {:else if field.commands.length}
    <div class="palette" role="listbox" aria-label="skein field.commands" bind:this={palette}>
      {#each field.commands as cmd, i (cmd.name)}
        {@const on = cmd === field.commandPick}
        <button
          class="cmd"
          class:on
          role="option"
          aria-selected={on}
          onmousedown={(e) => {
            /* mousedown, not click: the field must not lose focus first, or
               the draft is cleared while the caret is somewhere else. */
            e.preventDefault();
            field.at = i;
            void composer.runCommand(cmd, targets.length > 1);
          }}
          onmouseenter={() => (field.at = i)}
        >
          <!-- The ellipsis is the menus' own convention for a gesture that
               opens something further rather than doing a thing: this row
               leads to the values, and Enter on it says so by showing them.
               `opens` is the same claim for a command that puts up a panel
               instead — `/resume` offers you the sessions on disk. -->
          <span class="name">/{cmd.name}{cmd.choices || cmd.opens ? "…" : ""}</span>
          <!-- What it takes, in the CLI's own words: `[interval] [prompt]`,
               `<model>`, `branch`. Beside the name rather than in the summary,
               because it is the shape of the line you are about to write and
               not a description of what the thing does. Set in mono for the
               same reason a completion is: it is text that will be typed. -->
          {#if cmd.hint}
            <span class="hint">{cmd.hint}</span>
          {/if}
          <span class="summary">{cmd.summary}</span>
          <span class="grow"></span>
          <!-- A click is the one way in here that does not pass through the
               Ctrl gate, so the row has to say how far it reaches. The
               keyboard path still costs the modifier — and a command that acts
               on no card reaches nothing, so it says nothing: "5 cards" beside
               `/resume` would be a claim about a gathering it will not touch. -->
          {#if targets.length > 1 && cmd.needsCard}
            <span class="reach">{targets.length} cards</span>
          {/if}
        </button>
      {/each}
      {#if field.commandPick}
        <p class="detail">{field.commandPick.detail}</p>
      {/if}
    </div>
  {/if}

  <!-- The `!` line's own two rows, above the field like the palette and for
       the same reason: they grow towards the wall rather than pushing the
       field down under the cursor typing into it.

       Never up at the same time as the palette — one needs a leading slash
       and the other a leading bang — so this is its own block rather than
       another arm of that chain. -->
  {#if field.banging}
    {#if bang.offer}
      <div class="palette bang" role="listbox" aria-label="what the shell offers">
        {#each bang.offer.matches as m, i (m.text + i)}
          {@const on = m === bang.lit}
          <button
            class="cmd"
            class:on
            role="option"
            aria-selected={on}
            onmousedown={(e) => {
              /* mousedown, not click: the field must not lose focus first, or
                 the caret is somewhere else by the time the text lands. */
              e.preventDefault();
              bang.at = i;
              void composer.takeCompletion(bang.offer!, m);
            }}
            onmouseenter={() => (bang.at = i)}
          >
            <span class="name">{m.label}</span>
            <span class="summary">{kindLabel(m.kind)}</span>
            <span class="grow"></span>
          </button>
        {/each}
      </div>
    {/if}
    <!-- Which directory, because that is the whole of what a `!` line needs
         you to know and the one thing the field itself cannot say. It also
         replaces the dock's usual claim about reach: a run is one directory,
         so the target line's "5 cards" would be a lie here. -->
    <p class="bangbar">
      <span class="where"
        >{bangCard
          ? promptPath(bangCard.cwd, "")
          : card
            ? `${card.where} — a ! line runs on this machine, in a card that is here`
            : "no card"}</span
      >
      {#if bangCard?.bangCmd}
        <span class="going">running {bangCard.bangCmd} · esc stops it</span>
      {:else if bang.asking}
        <span class="going">asking the shell…</span>
      {:else}
        <span class="hint">↵ run · ctrl ↵ run and tell the agent · tab completes</span>
      {/if}
    </p>
  {/if}

  <!-- The field, and everything attached to it: the strip of pictures and
       files above it, the chips in the sentence, paste and drop. All of it is
       `PromptBox`'s, which every input that speaks to an agent is — so the
       dock is one of them rather than the one that had it (sink fd7ef025).

       The `!` line draws its own tint in the same box: a shell line is a
       different vocabulary over the same field, and the two never meet — a
       command run in a directory has nothing to do with an attachment. Its
       remainder is passed untrimmed, because trimming would shift everything
       after a leading space. -->
  {#snippet bangTint()}
    <div class="tint" aria-hidden="true"><span class="t-mark">{BANG}</span
      >{#each tokens(field.text.slice(BANG.length)) as t, i (i)}<span class="t-{t.kind}">{t.text}</span
        >{/each}</div>
  {/snippet}
  {#snippet keyHint()}
    <!-- Keyed on the refusal count so the flash retriggers: a second press
         with the modifier still missing has to be a second answer, and a CSS
         animation on a node that was never replaced runs exactly once. The
         class is what keeps it off the first paint, when nothing has been
         refused yet. -->
    {#key field.refused}
      <span class="key" class:refused={field.refused > 0}
        >{field.banging || targets.length <= 1 ? "↵" : "Ctrl ↵"}</span
      >
    {/key}
  {/snippet}
  <PromptBox
    bind:text={field.text}
    bind:el={composer.input}
    shots={field.shots}
    name="prompt"
    accepts={() => !!card || targets.length > 0}
    oncaret={(c) => (field.caret = c)}
    tint={field.banging ? bangTint : undefined}
    inkClass={field.banging ? "shell" : ""}
    after={keyHint}
    onkeydown={composer.key}
    oninput={composer.edited}
    onkeyup={composer.caretMoved}
    onclick={composer.caretMoved}
    onfocus={composer.caretMoved}
    placeholder={field.banging
      ? "run a command in this card's directory…"
      : targets.length > 1
        ? `Say something to all ${targets.length}…`
        : card?.remote
          ? `Say something to ${card.remote.host}…`
          : card
            ? "Say something…"
            : "Open a conversation first"}
    disabled={targets.length === 0 && !card}
    spellcheck={!field.banging}
    rows={1}
  />
</footer>

<style>
  .dock {
    /* Above `.studio::after`, the horizon that carries the day's spend. Was one
       arm of a `.bar, .dock, .wall` group in `App.svelte`; a component cannot be
       reached by its parent's selector, so the dock now says it itself. */
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    border-top: 1px solid var(--edge);
    padding: 0.6rem 0.9rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  /* ── the dock's berth ─────────────────────────────────────────────────
     At the top, which is `order` and a mirrored border and nothing else — the
     studio is a column, everything in it is at the default order, and the bar
     is pushed one lower so the dock lands under the title bar rather than over
     it. */
  .dock.moored-top {
    order: -1;
    border-top: 0;
    border-bottom: 1px solid var(--edge);
  }
  /* Off both edges. Window coordinates, so it can be put on a monitor the
     chrome does not live on, and therefore owing `--span-*` like everything
     else placed at viewport coordinates — the studio root is the containing
     block for anything fixed inside it while spread (`span.ts`), and both
     variables are zero when nothing is. Above the wall, which carries its own
     `z-index: 1`, and above the glass inside it: this is chrome you are typing
     into, and the one thing in the window that must never be covered. */
  .dock.afloat {
    position: fixed;
    z-index: 6;
    border: 1px solid var(--edge);
    border-radius: var(--ch-radius, 4px);
    /* Opaque, for the reason nothing standing on the wall may be transparent. */
    background: var(--ink);
    box-shadow: 0 24px 48px -18px color-mix(in srgb, var(--shade) 90%, transparent);
  }
  /* The mooring handle: a pill centred on the dock's top edge, inside its own
     padding so it is never over anything you are reading, and faint until the
     pointer is near it — a dock wearing a visible handle all day is a dock with
     a button on it. Centred rather than in a corner because the dock is a line
     rather than a box, and the middle of its top edge is the one part of it
     that holds nothing.

     Mirrors `.moor` in `App.svelte`, which is the panel's. A component is the
     only CSS scope this codebase has, so the two say a similar thing in two
     places rather than sharing a selector neither of them owns. */
  .moor {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 34px;
    height: 10px;
    z-index: 2;
    cursor: grab;
    opacity: 0.25;
    transition: opacity 0.12s ease;
    user-select: none;
    touch-action: none;
  }
  /* The pill, drawn smaller than the thing you can hit — the dock's top
     padding is ten pixels and the handle has to live entirely inside it, so
     the bar is three and the hit area is all of them. */
  .moor::after {
    content: "";
    position: absolute;
    inset: 3px 0;
    border-radius: 2px;
    background: var(--paper-faint);
  }
  .moor:hover,
  .moor.on {
    opacity: 0.8;
  }
  .moor.on {
    cursor: grabbing;
  }
  :global(html[data-motion="still"]) .moor {
    transition: none;
  }

  .targets {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .count {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--paper);
  }
  .count.dim {
    color: var(--paper-faint);
  }
  .tgt {
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.08rem 0.42rem;
    color: var(--paper-dim);
    font-size: 0.69rem;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tgt b {
    color: var(--paper-faint);
    font-weight: 600;
  }
  .hint {
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
  .hint.warn {
    color: var(--st-soft);
  }
  .count.bcast {
    color: var(--st-ask);
  }
  .tgt.clash {
    border-color: color-mix(in srgb, var(--st-ask) 50%, var(--edge));
  }
  .clashwarn {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--st-ask);
  }

  .cycle {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-ask) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-ask);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .cycle:hover {
    background: color-mix(in srgb, var(--st-ask) 12%, transparent);
  }
  /* Celadon, like the card it acts on: this button only exists while something
     is working, so the colour is that status rather than a decoration. */
  .stop {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-work) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-work);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .stop:hover {
    background: color-mix(in srgb, var(--st-work) 12%, transparent);
  }
  /* Drawn, not typed. `■` falls through to Segoe UI Emoji on this machine and
     comes out as somebody else's blue — the same trap the ambience panel's
     layer-order buttons avoid by saying "back" and "front" in words. */
  .stop .sq {
    width: 0.42rem;
    height: 0.42rem;
    background: currentColor;
    border-radius: 1px;
  }

  .more {
    align-self: flex-start;
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 0;
    color: var(--st-ask);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .kbd {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .held {
    display: contents;
  }
  .behind {
    align-self: flex-start;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  /* Achromatic: nothing here is waiting on you or has failed — it is your own
     words, kept. */
  .unsent {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    border: 1px dashed var(--edge);
    border-radius: 4px;
    background: var(--well);
    padding: 0.35rem 0.6rem;
    font-family: var(--util);
    font-size: 0.66rem;
  }
  .unsent .why {
    flex: 0 0 auto;
    color: var(--paper-mute);
  }
  .unsent .words {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--body);
    font-size: 0.8rem;
    color: var(--paper-dim);
  }
  .unsent .keep {
    flex: 0 0 auto;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-mute);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .unsent .keep:hover {
    color: var(--paper);
  }

  /* Achromatic, like the rest of the chrome: colour on this wall is status, and
     a command that has not run yet has none. */
  .palette {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.25rem;
    gap: 1px;
    /* About twelve rows, then it scrolls. The list was nine entries long for
       the whole of this palette's life and is now nine plus every skill the
       card declares — 31 on the wall this was measured on, which unbounded is a
       popup taller than the transcript it covers. Scrolled rather than cut,
       because a list that silently stops says a card has no skill that it does
       have; `Dock`'s effect keeps the lit row in view. */
    max-height: 17rem;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .palette .cmd {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    width: 100%;
    background: none;
    border: 0;
    border-radius: 2px;
    padding: 0.3rem 0.45rem;
    text-align: left;
    cursor: pointer;
    color: var(--paper-dim);
    font-family: var(--util);
    font-size: 0.74rem;
  }
  .palette .cmd.on {
    background: var(--raised);
    color: var(--paper);
  }
  .palette .name {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  /* Faint, and in the mono a completion lands in: this is the shape of what
     you are about to type rather than prose about it. */
  .palette .hint {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .palette .cmd.on .hint {
    color: var(--paper-mute);
  }
  .palette .summary {
    color: var(--paper-mute);
  }
  .palette .grow {
    flex: 1 1 auto;
  }
  .palette .reach {
    color: var(--paper-mute);
    font-size: 0.68rem;
  }
  .palette .cmd.on .summary {
    color: var(--paper-dim);
  }
  /* One line about the lit entry, since a summary short enough to scan cannot
     also say what will be lost.

     Stuck to the bottom of the box now that the box scrolls: it describes
     whichever row is lit, which is a row you are looking at, so it must not
     scroll out of sight along with the rows you are not. Opaque for the same
     reason — the entries pass underneath it. */
  .palette .detail {
    position: sticky;
    bottom: -0.25rem;
    margin: 0.15rem 0 -0.25rem;
    padding: 0.3rem 0.45rem 0.25rem;
    border-top: 1px solid var(--edge);
    background: var(--surface);
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.7rem;
  }

  /* ── the `!` line ────────────────────────────────────────────────────────
     The field holds two things in the same box: a textarea whose text is
     transparent, and the coloured copy of it underneath. The box is
     `PromptBox`'s; the copy is drawn here, by the snippet it is handed. */
  /* Named for what it does rather than for how it looks, and deliberately not
     `.ghost` — that is this stylesheet's chrome-button class, one bare rule of
     it sits further up, and a second bare `.ghost` here won on being later in
     the file. Every button in the header took `position: absolute; inset: 0;
     pointer-events: none` and collapsed into one unclickable stack. */
  .tint {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: hidden;
  }
  /* Both halves get the same metrics, or the colours drift off the characters as
     the line grows. `:global` because the field is `PromptBox`'s and this is
     the dock's own vocabulary drawn into it (the `inkClass` it is handed). */
  .dock :global(.ink.shell textarea),
  .dock :global(.ink.shell .tint) {
    font-family: var(--mono);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .dock :global(.ink.shell textarea) {
    /* The caret stays, which is the whole trick: the text is drawn once,
       underneath, and this is only where it is typed. */
    color: transparent;
    caret-color: var(--paper);
  }
  .dock :global(.ink.shell textarea::selection) {
    /* Transparent text with an ordinary selection is an invisible highlight, so
       the selection has to be something you can see against the ghost. */
    background: var(--edge);
  }

  /* Colour on a shell line, which is the one place on this wall it is not
     status. The exemption is `ansi.ts`'s, already taken and for the same reason:
     a terminal register reads by hue — that is how every shell on earth is read
     — and these are the same takes on the standard 16 that the console panel
     renders output with (`--ansi-*`, the bright row: blue, green, magenta, cyan),
     so a `!` line looks like it belongs on the wall rather than in somebody
     else's editor, and follows the ground to a light set where there is one.
     Amber is deliberately absent: it means "wants you" here, and nothing in a
     line you are typing does. */
  .t-mark {
    color: var(--paper-mute);
  }
  .t-cmd {
    color: var(--paper);
    font-weight: 600;
  }
  .t-param {
    color: var(--ansi-12);
  }
  .t-str {
    color: var(--ansi-10);
  }
  .t-var {
    color: var(--ansi-13);
  }
  .t-num {
    color: var(--ansi-14);
  }
  .t-op {
    color: var(--paper-mute);
  }
  .t-comment {
    color: var(--paper-faint);
    font-style: italic;
  }
  .t-plain {
    color: var(--paper-dim);
  }

  /* Where it will run, and what the keys do. The register of a meta note — this
     is the dock talking about itself rather than anything an agent said. */
  .bangbar {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.35rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  .bangbar .where {
    font-family: var(--mono);
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Celadon, because a run is working and that is what celadon means here. */
  .bangbar .going {
    color: var(--st-work);
  }
  .bangbar .hint {
    margin-left: auto;
    white-space: nowrap;
  }
  /* The offering reuses the palette's rows — it is the same gesture over a
     different vocabulary — and only the leading column differs: a completion is
     a thing you are about to type, so it is set in the mono it will land in. */
  .palette.bang .name {
    font-family: var(--mono);
  }

  .key {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0.32rem;
  }

  /* The answer to a press that wanted a modifier it did not have. It points at
     the reading rather than replacing it — the words already say `Ctrl ↵`, and
     what was missing was any acknowledgement that the key had been pressed at
     all. Achromatic, like the rest of the chrome: colour on this wall is
     reserved for status, and a keystroke is not a status. */
  .key.refused {
    animation: refused 0.5s ease-out 2;
  }

  @keyframes refused {
    0% {
      color: var(--paper-faint);
      border-color: var(--edge);
    }
    18% {
      color: var(--paper);
      border-color: var(--paper-mute);
    }
    100% {
      color: var(--paper-faint);
      border-color: var(--edge);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    /* Still an answer, just not a moving one. */
    .key.refused {
      animation: none;
      color: var(--paper);
      border-color: var(--paper-mute);
    }
  }

  /* The dock's own spacer. `App.svelte` has one too — the same three
     declarations under the same name, and deliberately not shared: a rule this
     small is cheaper duplicated than it is coupled, and one stylesheet reaching
     into another is exactly what this component was cut out to stop. */
  .grow {
    flex: 1 1 auto;
  }

</style>
