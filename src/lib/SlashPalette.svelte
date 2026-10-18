<script lang="ts">
  /* The slash palette in its two stages, and the `!` line's offering and bar —
     what rises out of a field over the draft while you are choosing a command
     or writing a shell line.

     It was the dock's, and came out when chat view's message box needed the
     same rows (`docs/chat-mode.md` §4.3): the vocabulary is `commands.ts` and
     `bang.ts`, the state is `Field` and `Bang`, and what a row does when it is
     pressed is the composer's. This is only the drawing, and one drawing for
     every field, so the two cannot drift. */
  import type { Conversation } from "./conversation.svelte";
  import type { CardHandle } from "./cards.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import type { Composer } from "./composer.svelte";
  import { completionForChoice } from "./commands";
  import { kindLabel } from "./bang";
  import { promptPath } from "./shell";

  let {
    field,
    bang,
    composer,
    targets,
    card,
    bangCard,
  }: {
    field: Field;
    bang: Bang;
    composer: Composer;
    /** The gathering a row would reach, for the count it says it reaches. */
    targets: Conversation[];
    /** The card in the ring, for what the `!` bar says when it cannot run. */
    card: CardHandle | null;
    /** Which card a `!` line would run in. */
    bangCard: Conversation | null;
  } = $props();

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

<style>
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
</style>
