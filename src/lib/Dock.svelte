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
   * is the keyboard — `onDraftKey` stays in `App.svelte` beside `onGlobalKey`,
   * deliberately. That ladder is not dock-local: half its branches are about the
   * wall (Tab between cards, Escape to the ground, the transcript's scrolling),
   * and it is the *boundary* between the dock and everything else rather than a
   * thing inside it. Splitting it across two files would put the two halves of
   * one priority order where neither can be read against the other. */
  import { untrack } from "svelte";
  import Ask from "./Ask.svelte";
  import type { Skein } from "../lib/skein.svelte";
  import type { Conversation } from "../lib/conversation.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import { askShown } from "./asking";
  import { completionForChoice, slashAt, typingChoice, type Command } from "./commands";
  import { nameBesideProject } from "./naming";
  import { promptPath } from "./shell";
  import { BANG, isBang, kindLabel, tokens, type Completion, type Match } from "./bang";
  import { dropToken, runsOf, sizeNote } from "./attach";

  let {
    field,
    skein,
    bang,
    focused,
    targets,
    waiting,
    clashing,
    bangCard,
    dropping,
    prompt = $bindable(),
    onkey,
    onsendtext,
    onrun,
    ontake,
    oncycle,
    onmore,
    onselect,
  }: {
    /** What is being typed and what the typing currently means. */
    field: Field;
    skein: Skein;
    /** The `!` line's session — its runs and its completions. */
    bang: Bang;
    /** The card in the ring, if there is one. */
    focused: Conversation | null;
    /** Everything a send would reach: the gathering, or the focused card, or
     *  nothing at all. */
    targets: Conversation[];
    /** Cards that want you, in the order the Tab cycle takes them. */
    waiting: Conversation[];
    /** Ids among the targets that have already edited the same files as another
     *  target — a broadcast about to land twice in one tree. */
    clashing: string[];
    /** Which card a `!` line would run in. One card, never the gathering. */
    bangCard: Conversation | null;
    /** A file is being dragged over somewhere that would attach it to this
     *  draft. The only feedback a drag gets: an OS file drag fires no DOM drag
     *  events at all here — the webview swallows them so the payload can carry
     *  real paths — so nothing under the cursor is ever told it is hovered, and
     *  without this the dock would look identical whether a drop was about to
     *  land in the prompt or fly past onto the wall. */
    dropping: boolean;
    /** The textarea itself, handed back up so a keystroke on the wall can put
     *  the focus here and the character with it. */
    prompt: HTMLTextAreaElement | undefined;
    onkey: (e: KeyboardEvent) => void;
    onsendtext: (text: string, broadcast: boolean) => Promise<void>;
    onrun: (cmd: Command, broadcast: boolean) => Promise<void>;
    ontake: (offer: Completion, match: Match) => Promise<void>;
    oncycle: (step: 1 | -1) => void;
    /** Move to the next card waiting on an answer. Which one that is, is the
     *  wall's question rather than the dock's. */
    onmore: (shown: Conversation) => void;
    /** Land on a card: the ring, the gathering and the panel, the way clicking
     *  it does. Asked for by the ask panel when the card being asked is not the
     *  one selected. */
    onselect: (conv: Conversation) => void;
  } = $props();

  /* A draft that stops being a shell line is a new question, so the dismissal
     does not outlive it — the same rule the palette's has, for the same reason. */
  $effect(() => {
    if (!isBang(field.text)) field.bangOff = false;
  });

  /* A draft that stops being a command being typed is a new question, so the
     dismissal does not outlive it. Without this, one Escape silenced the
     palette for the rest of the session. Both stages count: dismissing over
     `/model son` must not be undone by the very next keystroke.

     Asked of `slashAt` rather than `typingName` now that a name can sit inside
     a sentence: the question is whether the *caret* is still in one, and moving
     it out of the word you dismissed over is as much a new question as deleting
     the word would be. Read against `field.commandsOff` being what suppresses
     `field.token` — this has to ask the draft directly, or the dismissal would
     hide the very thing that clears it. */
  $effect(() => {
    if (
      slashAt(field.text, field.caret) === null &&
      typingChoice(field.text) === null
    ) {
      field.commandsOff = false;
    }
  });

  /** Where the caret is, off the textarea itself.
   *
   *  Everything the palette's first stage does keys on which word the caret is
   *  in, and there is no one event that reports every way it moves — `input`
   *  covers typing, `keyup` the arrows and Home/End, `click` a pointer landing
   *  mid-word, and `focus` coming back to a draft you left. Four cheap handlers
   *  rather than `selectionchange`, which is engine-dependent and would fail
   *  silently by leaving the palette matching the end of the line.
   *
   *  Never called for a write this app made: those go through `Field.put`,
   *  which puts the caret back to meaning the end of the text. */
  function caretMoved() {
    field.caret = prompt?.selectionStart ?? null;
  }

  /** An edit to the draft, as opposed to the caret merely moving in it.
   *
   *  Both are `oninput`'s business here and they are two different questions,
   *  which is why this is not folded into `caretMoved`: that one is also on
   *  `keyup`, `click` and `focus`, and none of those is you writing anything.
   *
   *  What the edit buys is the card's process. A card at rest no longer gets one
   *  at launch (`rousing.ts`), so the first send of the day would otherwise be a
   *  spawn and a `--resume` waited out with the sentence already typed. Starting
   *  it on the first character spends that second on the time you were using
   *  anyway. Nothing is awaited and no answer is read — `Skein.stir` is a head
   *  start, and `#deliver` still asks for a process and still fails honestly if
   *  there is none.
   *
   *  Two things it is asked about first. A `!` line is a shell command run in
   *  the card's directory by `bang.rs` and reaches no agent at all, so a card
   *  you only ever run commands in stays dormant. And an empty box is a draft
   *  you have just cleared or backspaced out of, which is the opposite of
   *  turning towards the card.
   *
   *  The focused card and not `targets`: a gathering of twenty would otherwise
   *  be twenty spawns off one keystroke, which is the thundering herd
   *  `ROUSE_GAP_MS` exists to avoid. A broadcast wakes each of them in
   *  `#deliver` as it reaches them. */
  function edited() {
    caretMoved();
    if (field.banging || !field.text) return;
    skein.stir(focused);
  }

  /* An image lives by its token, so backspacing over one detaches it — and that
     has to be true of *typing*, not only of the writes that go through
     `Field.put`. The text is two-way bound to the textarea, so an ordinary
     keystroke never reaches `put` at all: without this, deleting `[shot 1]`
     left the picture in the strip above the field and counted against the cap,
     while `compose` — which asks `stillIn` — would not have sent it. The strip
     and the sentence disagreeing about what is attached is the one state this
     feature must not have.

     `untrack` because `prune` both reads and writes the list; depending on what
     it writes would make the effect re-run itself. It only assigns when
     something actually went, so an ordinary keystroke costs a filter and no
     invalidation. Third effect of this shape here — the two above it drop a
     dismissal that has stopped applying to the draft, and this drops a picture
     that has. */
  $effect(() => {
    const text = field.text;
    untrack(() => field.shots.prune(text));
  });

  /** Is the field drawing its own text, so the chips can be drawn in it?
   *
   *  A shell line already owns the tint layer and the two cannot both have it —
   *  `!` is a different vocabulary over the same box. In practice they never
   *  meet: a `!` line is a command run in a directory and has nothing to do with
   *  a picture, and attaching one to a shell command would be nonsense. This is
   *  what makes that true rather than merely likely. */
  const marked = $derived(!field.banging && field.shots.any);

  /** Take an image out of the prompt.
   *
   *  By editing the sentence, which is the only thing an attachment *is* — see
   *  `attach.ts::dropToken`. `Attachments.prune` then drops it on the next
   *  read, so this needs no second call and the two can never disagree about
   *  what is attached. */
  function detach(name: string) {
    field.put(dropToken(field.text, name));
  }

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

  /* The lit row goes back to the top when the list under it is replaced, or
     stepping from the names to the values would land on whichever value
     happened to share an index with the command you just picked. */
  const stage = $derived(field.choosing ? `values:${field.choosing.cmd.name}` : "names");
  $effect(() => {
    stage;
    field.at = 0;
  });
</script>

<footer class="dock" class:dropping>
  <!-- A blocked card jumps the queue: it is the only state where an agent is
       genuinely stopped, so answering it comes before anything else. -->
  {#if skein.blocked.length}
    {@const target = askShown(focused, skein.blocked)!}
    <Ask
      conv={target}
      elsewhere={target !== focused}
      onanswer={() => skein.answerAsk(target)}
      onselect={() => onselect(target)}
      onlink={(href) => void skein.openLink(href)}
    />
    {#if skein.blocked.length > 1}
      <button class="more" onclick={() => onmore(target)}>
        {skein.blocked.length - 1} more waiting on an answer
      </button>
    {/if}
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
    {:else if focused}
      <span class="count">To</span>
      <span class="tgt"><b>{focused.project}</b> {nameBesideProject(focused.title)}</span>
      <!-- "when you type" and not "on send", which is what this said while the
           rousing queue woke the whole wall and a dormant card was the unusual
           one. It is now the ordinary state of most cards, and the true answer
           moved: `Skein.stir` starts the spawn on the first character, so this
           line is gone by the time the sentence is. Worth being exact about,
           because "on send" reads as a wait you are about to be made to do. -->
      {#if focused.dormant}
        <span class="hint">dormant — wakes when you type</span>
      {/if}
      <!-- Said here as well as on the card, because this is the one place
           where it is about to stop being true: a prompt picks the card back
           up, and a card quietly rejoining the waiting cycle is worth one
           clause of warning rather than a surprise later. -->
      {#if focused.aside}
        <span class="hint">set aside — sending picks it back up</span>
      {/if}
      {#if focused.interrupted}
        <span class="hint warn">last turn was interrupted</span>
      {/if}
    {:else}
      <span class="count dim">No card focused</span>
    {/if}
    <!-- The counterpart of the send below it, and only ever offered while
         there is a turn to end. It names the card when the row above is a
         broadcast readout, because "stop" beside a list of four is a
         question rather than a verb — the key and the button both aim at
         the focused card alone. -->
    {#if focused?.working}
      <button class="stop" onclick={() => skein.stop(focused)}>
        <span class="sq"></span>
        stop{targets.length > 1 ? ` ${focused.project}` : ""}
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
            void onsendtext(
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
            void onrun(cmd, targets.length > 1);
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
              void ontake(bang.offer!, m);
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
      <span class="where">{bangCard ? promptPath(bangCard.cwd, "") : "no card"}</span>
      {#if bangCard?.bangCmd}
        <span class="going">running {bangCard.bangCmd} · esc stops it</span>
      {:else if bang.asking}
        <span class="going">asking the shell…</span>
      {:else}
        <span class="hint">↵ run · ctrl ↵ run and tell the agent · tab completes</span>
      {/if}
    </p>
  {/if}

  <!-- What is attached to the draft. Above the field rather than below it, so
       the pictures sit between the target line and the sentence that refers to
       them — and so the field itself never moves as you type.

       Drawn only when there is something to draw: an empty strip on every card
       all day is a row of chrome saying nothing, and the dock is already four
       stacked things deep. -->
  {#if field.shots.any}
    <div class="shots">
      {#each field.shots.list as a (a.id)}
        <button
          class="shot"
          type="button"
          title="{a.name} — {sizeNote(a)}. Click to take it out of the prompt."
          onclick={() => detach(a.name)}
        >
          <img src={a.thumb} alt="" />
          <span class="what">
            <span class="who">{a.name}</span>
            <span class="how">{sizeNote(a)}</span>
          </span>
          <span class="off" aria-hidden="true">✕</span>
        </button>
      {/each}
    </div>
  {/if}
  <!-- A refusal is said once and where the gesture was made, rather than in the
       fault bar — dropping eighty files on the dock is a thing that happens by
       accident and the answer belongs beside the thing you dropped them on. -->
  {#if field.shots.refused}
    <p class="line refused-shot">{field.shots.refused}</p>
  {/if}

  <div class="field">
    <!-- The highlight is drawn *behind* a transparent textarea, which is why
         both `tokens` and `runsOf` have to concatenate back to exactly what went
         in: one dropped space and every colour on the line sits over the wrong
         character. The `!` is drawn here rather than tokenised, since it is the
         mode marker and not part of the command — and the remainder is passed
         untrimmed, because trimming it would shift everything after a leading
         space.

         `marked` is the same mechanism over the other vocabulary, and it is
         switched on *only* while something is attached. That is deliberate
         rather than lazy: drawing the text underneath means the textarea's own
         glyphs go transparent, which is a real cost — an IME's composition text
         would be invisible while you typed it — and it is a cost worth paying
         only on the drafts that have a chip to show. An ordinary prompt is
         exactly the field it has always been. -->
    <div
      class="ink"
      class:shell={field.banging}
      class:marked={marked}
    >
      {#if field.banging}
        <div class="tint" aria-hidden="true"><span class="t-mark"
            >{BANG}</span
          >{#each tokens(field.text.slice(BANG.length)) as t, i (i)}<span
              class="t-{t.kind}">{t.text}</span
            >{/each}</div>
      {:else if marked}
        <div class="tint" aria-hidden="true">{#each runsOf(field.text, field.shots.list) as r, i (i)}{#if r.chip}<span
                class="chip">{r.text}</span
              >{:else}{r.text}{/if}{/each}</div>
      {/if}
      <textarea
        bind:this={prompt}
        bind:value={field.text}
        onkeydown={onkey}
        oninput={edited}
        onkeyup={caretMoved}
        onclick={caretMoved}
        onfocus={caretMoved}
        placeholder={field.banging
          ? "run a command in this card's directory…"
          : targets.length > 1
            ? `Say something to all ${targets.length}…`
            : focused
              ? "Say something…"
              : "Open a conversation first"}
        disabled={targets.length === 0}
        spellcheck={!field.banging}
        rows="1"
      ></textarea>
    </div>
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
  </div>
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

  .field {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
  }
  /* ── the `!` line ────────────────────────────────────────────────────────
     The field holds two things in the same box: a textarea whose text is
     transparent, and the coloured copy of it underneath. */
  .ink {
    position: relative;
    flex: 1 1 auto;
    display: flex;
  }
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
     the line grows. */
  .ink.shell textarea,
  .ink.shell .tint {
    font-family: var(--mono);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .ink.shell textarea {
    /* The caret stays, which is the whole trick: the text is drawn once,
       underneath, and this is only where it is typed. */
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.shell textarea::selection {
    /* Transparent text with an ordinary selection is an invisible highlight, so
       the selection has to be something you can see against the ghost. */
    background: var(--edge);
  }

  /* ── an image written into the prompt ────────────────────────────────────
     The same trick as the `!` line one box over: the text is drawn once
     underneath and the textarea is only where it is typed. Both halves take the
     *same* metrics — the field's own, not the mono the shell line uses — or the
     chips drift off the characters they are meant to be sitting on. */
  .ink.marked textarea,
  .ink.marked .tint {
    font-family: var(--body);
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .ink.marked textarea {
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.marked textarea::selection {
    background: var(--edge);
  }
  .ink.marked .tint {
    color: var(--paper);
  }
  /* A chip is the *same glyphs* with a background behind them, and that is the
     whole reason this works: anything that changed the token's width — padding,
     a different face, a border — would move every character after it out from
     under the caret. So it is colour and a radius and nothing else, and the
     background is drawn with `box-decoration-break` so a token that wraps
     across two lines gets a rounded end on each rather than one box spanning
     the gap. Achromatic: colour on this wall means status, and a picture you
     attached is not one. */
  .chip {
    background: var(--edge);
    color: var(--paper);
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  /* ── the strip of what is attached ───────────────────────────────────────── */
  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
  }
  .shot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.3rem 0.2rem 0.2rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    color: var(--paper-mute);
  }
  .shot:hover {
    border-color: var(--paper-faint);
    color: var(--paper);
  }
  .shot img {
    /* A fixed box with the picture covering it, so a wide screenshot and a tall
       one make the same shape and the strip does not go ragged. */
    width: 2rem;
    height: 2rem;
    object-fit: cover;
    border-radius: 2px;
    /* Nothing standing on this wall may be transparent, and a PNG with an alpha
       corner drawn straight onto the dock would show the ambience through the
       middle of a thumbnail. */
    background: var(--surface);
  }
  .shot .what {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  .shot .who {
    font-size: 0.72rem;
  }
  .shot .how {
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .shot .off {
    font-size: 0.7rem;
    color: var(--paper-faint);
    padding-left: 0.1rem;
  }
  .shot:hover .off {
    color: var(--paper);
  }
  .refused-shot {
    color: var(--paper-mute);
  }

  /* A drag is overhead and would land here. An outline rather than a fill: the
     dock is where you are about to read a sentence, and washing it over hides
     the very draft the picture is about to be written into. Achromatic — the
     four colours on this wall are the three statuses and the shell line, and a
     drop is none of them. */
  .dock.dropping {
    outline: 1px dashed var(--paper-faint);
    outline-offset: -3px;
  }

  /* Colour on a shell line, which is the one place on this wall it is not
     status. The exemption is `ansi.ts`'s, already taken and for the same reason:
     a terminal register reads by hue — that is how every shell on earth is read
     — and these are the same warm-neutral takes on the standard 16 that the
     console panel renders output with, so a `!` line looks like it belongs on an
     ink wall rather than in somebody else's editor. Amber is deliberately absent:
     it means "wants you" here, and nothing in a line you are typing does. */
  .t-mark {
    color: var(--paper-mute);
  }
  .t-cmd {
    color: var(--paper);
    font-weight: 600;
  }
  .t-param {
    color: #9bb8d8;
  }
  .t-str {
    color: #9bd4bf;
  }
  .t-var {
    color: #c4a8d8;
  }
  .t-num {
    color: #8fd0d0;
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

  .field textarea {
    flex: 1 1 auto;
    background: none;
    border: 0;
    resize: none;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.9rem;
    line-height: 1.45;
    max-height: 7rem;
    field-sizing: content;
  }
  .field textarea:focus {
    outline: none;
  }
  .field textarea::placeholder {
    color: var(--paper-faint);
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
