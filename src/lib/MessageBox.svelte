<script lang="ts">
  /* Chat view's message box: a second drawing of the composer
     (`composer.svelte.ts`), over the same draft the dock writes.

     Everything that decides anything is somebody else's — the keys and the
     sends are the composer's, the draft and its dismissals are `Field`'s, the
     pictures and files are `PromptBox`'s, the palette is `SlashPalette`. This
     is the look (`docs/chat-mode.md` §6.1, the lamplit box on the sheet) and
     the two buttons a familiar chat box has: plan first, and send — which
     becomes stop while a turn is open, by cross-fade.

     In chat view the reach is the selected conversation alone and Ctrl+Enter is
     Enter: the composer reads the view and does that itself, so nothing here
     can forget to. */
  import PromptBox from "./PromptBox.svelte";
  import SlashPalette from "./SlashPalette.svelte";
  import Icon from "./Icon.svelte";
  import ModelMenu from "./ModelMenu.svelte";
  import type { Starter } from "./starting.svelte";
  import type { CardHandle } from "./cards.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import type { Composer } from "./composer.svelte";

  let {
    field,
    bang,
    composer,
    card,
    starter,
  }: {
    field: Field;
    bang: Bang;
    composer: Composer;
    /** The conversation in front of you, or null on the empty sheet. */
    card: CardHandle | null;
    /** For the model menu beside send (`ModelMenu.svelte`). */
    starter: Starter;
  } = $props();

  const working = $derived(!!card && (card.face.working || card.can("stop") === "yes"));
  const planning = $derived(card?.gist.planning ?? false);
  const asking = $derived(!!card?.ask);
  const empty = $derived(!field.text.trim());
  const targets = $derived(card?.conv ? [card.conv] : []);

  const placeholder = $derived(
    !card
      ? "pick a conversation, or start one"
      : field.banging
        ? "run a command in this conversation's folder…"
        : asking
          ? "it's waiting on your answer above — a message here waits too"
          : card.remote
            ? `say something to ${card.remote.host}…`
            : "ask a follow-up…",
  );

  function sendOrStop() {
    if (working && empty) {
      void card?.do("stop");
      return;
    }
    void composer.send(false);
  }
</script>

<form
  class="box"
  class:dim={asking}
  aria-label="message"
  onsubmit={(e) => {
    e.preventDefault();
    sendOrStop();
  }}
>
  <SlashPalette {field} {bang} {composer} {targets} {card} bangCard={card?.conv ?? null} />
  <PromptBox
    bind:text={field.text}
    bind:el={composer.input}
    shots={field.shots}
    name="prompt"
    accepts={() => !!card}
    oncaret={(c) => (field.caret = c)}
    onkeydown={composer.key}
    oninput={composer.edited}
    onkeyup={composer.caretMoved}
    onclick={composer.caretMoved}
    onfocus={composer.caretMoved}
    {placeholder}
    disabled={!card}
    spellcheck={!field.banging}
    rows={1}
  />
  <div class="row">
    {#if card?.conv}
      <button
        type="button"
        class="toggle"
        class:on={planning}
        aria-pressed={planning}
        title="plan first — read and propose, change nothing (alt+p)"
        onclick={() => void composer.togglePlan()}
      >
        <Icon name="plan" small />plan first
      </button>
    {/if}
    <span class="grow"></span>
    <ModelMenu {card} {starter} up />
    <button
      type="submit"
      class="send"
      class:idle={empty && !working}
      class:stopping={working && empty}
      disabled={!card || (empty && !working)}
      title={working && empty ? "stop (esc)" : "send (enter)"}
      aria-label={working && empty ? "stop" : "send"}
    >
      <span class="glyph up" aria-hidden="true"><Icon name="up" /></span>
      <span class="glyph sq" aria-hidden="true"><Icon name="stop" /></span>
    </button>
  </div>
</form>
<p class="hint">enter to send · shift enter for a new line · space from an empty box for every command</p>

<style>
  .box {
    position: relative;
    width: min(calc(var(--cv-measure, 44rem) + 2rem), calc(100% - 48px));
    margin: 0 auto;
    border-radius: var(--cv-r-l, 20px);
    padding: 12px 12px 10px 16px;
    background: linear-gradient(
      180deg,
      color-mix(in oklab, var(--cv-lift, var(--surface)) 100%, var(--paper) 3%),
      var(--cv-lift, var(--surface))
    );
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    box-shadow:
      0 1px 0 color-mix(in oklab, var(--paper) 7%, transparent) inset,
      0 14px 34px -18px color-mix(in srgb, var(--shade) 95%, transparent),
      0 2px 6px -2px color-mix(in srgb, var(--shade) 40%, transparent);
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      opacity var(--dur-scene, 360ms) var(--ease-out, ease-out);
    font-family: var(--cv-ui, var(--util));
    /* The field is PromptBox's, set by its custom properties: no box of its
       own inside this one, the size a chat box writes at. */
    --pb-bg: transparent;
    --pb-border: 0;
    --pb-pad: 2px 0 8px;
    --pb-size: 14.5px;
    --pb-max: 40vh;
    /* You write in the UI's voice and the agent answers in a book's (§8.3). */
    --pb-font: var(--cv-ui, var(--util));
  }
  /* A question above is waiting: the box dims and says so, and does not move
     — what you are typing into never changes under you (§5.3). */
  .box.dim {
    opacity: 0.72;
  }
  .box :global(.palette) {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 4;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grow {
    flex: 1;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--paper-mute);
    border: 1px dashed var(--cv-hair, var(--edge));
    transition: color var(--dur-tap, 90ms) var(--ease-out, ease-out);
  }
  .toggle.on {
    color: var(--paper);
    border-color: var(--paper-mute);
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .send {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--cv-sheet, var(--ink));
    background: radial-gradient(
      circle at 35% 25%,
      color-mix(in oklab, var(--paper) 100%, white 10%),
      var(--paper) 60%,
      color-mix(in oklab, var(--paper) 85%, var(--shade))
    );
    box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--shade) 80%, transparent);
    transition: transform var(--dur-quick, 160ms) var(--ease-pop, ease-out);
  }
  .send:active:not(:disabled) {
    transform: scale(0.92);
  }
  .send.idle,
  .send:disabled {
    background: color-mix(in oklab, var(--raised) 100%, var(--paper) 6%);
    color: var(--paper-faint);
    box-shadow: none;
    cursor: default;
  }
  /* Send and stop are two glyphs in one place, cross-faded rather than
     swapped (§9.2): opacity and a 4px translate, and nothing that persists. */
  .glyph {
    grid-area: 1 / 1;
    display: grid;
    transition:
      opacity var(--dur-quick, 160ms) var(--ease-out, ease-out),
      transform var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .glyph.sq {
    opacity: 0;
    transform: translateY(4px);
  }
  .send.stopping .glyph.up {
    opacity: 0;
    transform: translateY(-4px);
  }
  .send.stopping .glyph.sq {
    opacity: 1;
    transform: none;
  }
  .glyph.sq :global(svg) {
    fill: currentColor;
    stroke: none;
    width: 12px;
    height: 12px;
  }
  /* Below 600px the hint line goes (§6.8): the keys are in each control's title. */
  @media (max-width: 599px) {
    .hint {
      display: none;
    }
  }
  .hint {
    margin: 8px 0 0;
    text-align: center;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
    color: var(--cv-note, var(--paper-mute));
  }
  @media (prefers-reduced-motion: reduce) {
    .glyph,
    .send {
      transition-property: opacity;
    }
  }
</style>
