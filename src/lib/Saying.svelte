<script lang="ts">
  /* A card's last message, kept on the wall or the glass.
   *
   * The glance (`Glance.svelte`) left standing: the same reader (`Said.svelte`)
   * over the same reading (`glance.ts::lastMessage`), so a pin, a glance and a
   * notice about the same card cannot disagree about what it said. What this
   * adds is only the frame a widget wears and the card's name and state above
   * the words — a pin you cannot tell the author of is a quotation with the
   * attribution torn off.
   *
   * **Nothing here goes and looks.** The text is a `$derived` over the card's
   * own lines, which the event fold already keeps, so it redraws when the card
   * speaks and at no other time; `Said` parses only when the string changes.
   * The one thing asked for is the card's conversation, when nobody has read
   * it yet — a card restored off disk keeps its scrollback in `history` until
   * the panel or a glance asks — and, for a card on another wall, again when
   * its wall says it has said something new (`saidMark`). That is the
   * transcript panel's own arrangement (`historyMark`), keyed narrower: a pin
   * is up all day where a panel is open for a minute, and re-reading a whole
   * conversation over the link every time a far card runs a tool would be the
   * pin costing more than the card it reads. See `.claude/rules/widgets.md`. */
  import { untrack } from "svelte";
  import Said from "./Said.svelte";
  import { lastMessage } from "./glance";
  import { closingOf, tetherOf, tetherHost } from "./tether";
  import { variantOf, type Widget } from "./widgets";
  import { cardName } from "./naming";
  import { scopeFiles } from "./paths.svelte";
  import type { CardHandle } from "./cards.svelte";

  let {
    widget,
    card,
    onreveal,
  }: {
    widget: Widget;
    /** The card this pin reads, or null while it is not on the wall — the
     *  first frames of a launch for a card here, and until its wall is heard
     *  for one elsewhere. Never for a card that has closed: that takes the pin
     *  down on the same run (`Widgets.untether`). */
    card: CardHandle | null;
    /** Go to the card, and open its transcript. */
    onreveal?: (id: string) => void;
  } = $props();

  /* A path in what it said counts from its own root, as it does in the glance
     and the transcript — the scope is the one thing a surface says for itself,
     and a pin that forgot it would draw the same words as plain text. */
  scopeFiles(() => card?.readable.root ?? null);

  const face = $derived(card?.face ?? null);
  const said = $derived(face ? lastMessage(face) : "");
  const close = $derived(variantOf(widget) === "close");
  const text = $derived(close ? closingOf(said) : said);

  const name = $derived.by(() => {
    if (!face) return "";
    const n = cardName(face.title).text;
    return n ? `${face.project} · ${n}` : face.project;
  });
  /* The state the card wears, as a dot rather than a tint: colour on this wall
     is status, and this is the one status the pin has to say. `working` ahead
     of the tier, which is how the card itself reads. */
  const st = $derived(face ? (face.working ? "work" : face.tier) : "rest");

  /* What stands in the reader when there are no words yet, and why — a card
     whose conversation is still being read is not a card that has said
     nothing. */
  const empty = $derived.by(() => {
    const state = card?.readable.historyState;
    if (state === "loading" || state === "unread") return "reading…";
    return "nothing said yet";
  });

  /* Read the conversation once, and again when a card on another wall says it
     has moved on. Untracked, because the loader's first act is to read the
     state it is about to write — the trap `Transcript.svelte` names over its
     own copy of this effect. */
  $effect(() => {
    const c = card;
    if (!c) return;
    void c.id;
    void c.readable.saidMark;
    untrack(() => c.history());
  });

  /* A new message is read from its start. The reader is the same element from
     one message to the next, so without this a pin you had scrolled down the
     last answer of would open the next one part-way through. */
  let scroller = $state<HTMLElement | null>(null);
  $effect(() => {
    void text;
    untrack(() => {
      if (scroller) scroller.scrollTop = 0;
    });
  });

  const absent = $derived.by(() => {
    const id = tetherOf(widget);
    const host = id ? tetherHost(id) : null;
    return host ? `${host} has not been heard from yet` : "waiting for its card";
  });
</script>

<div class="saying" data-st={st} class:close>
  <header>
    <span class="dot" aria-hidden="true"></span>
    {#if card}
      <button
        class="who"
        title="Go to the card and open its transcript"
        onclick={() => onreveal?.(card.id)}>{name}</button
      >
      <span class="doing">{face?.doing ?? ""}</span>
    {:else}
      <span class="doing">{absent}</span>
    {/if}
  </header>
  {#if card}
    <div class="body">
      <Said {text} {empty} bind:el={scroller} />
    </div>
  {/if}
</div>

<style>
  .saying {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
  }
  header {
    flex: 0 0 auto;
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
    min-width: 0;
  }
  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    align-self: center;
    background: var(--st-rest);
  }
  [data-st="work"] .dot {
    background: var(--st-work);
  }
  [data-st="ask"] .dot {
    background: var(--st-ask);
  }
  [data-st="soft"] .dot {
    background: var(--st-soft);
  }
  [data-st="fail"] .dot {
    background: var(--st-fail);
  }
  .who {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    color: var(--paper-dim);
    cursor: pointer;
  }
  .who:hover {
    color: var(--paper);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .doing {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--paper-faint);
    text-align: right;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding-top: 0.3rem;
    /* The box you dragged it to is the ceiling, not the notice's 16rem. */
    --said-ceiling: none;
  }
  /* The reader keeps its own type and spacing; what it gives up here is the
     frame it wears in the dock. A widget's fill lives on `WidgetNode` and
     nowhere else (`widgets.md`, "How much of a frame it wears"), so a pin set
     `bare` must not have the reading paint the wall back over, and an outline
     inside the widget's own would be a frame inside a frame. */
  .body :global(.said) {
    flex: 1 1 auto;
    min-height: 0;
    border: 0;
    border-radius: 0;
    background: none;
    padding: 0.1rem 0.2rem;
  }
  .close .body :global(.said) {
    font-size: 1rem;
    line-height: 1.5;
    color: var(--paper);
  }
</style>
