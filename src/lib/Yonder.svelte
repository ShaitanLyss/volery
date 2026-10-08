<script lang="ts">
  /* The panel for a card on another wall — what the transcript is for a card on
     this one, minus the transcript.

     A digest is the tier, not the conversation (`shadow.ts`), so this draws the
     three things this wall honestly knows about the card: what it is doing as of
     its wall's last word, the last thing it said, and every prompt sent to it
     *from here*, each marked for how far it has got. It says in so many words
     that the conversation itself stays on the other machine, because a panel
     that looked like a transcript with most of it missing would read as one
     that failed to load. */
  import { clock } from "./conversation.svelte";
  import { cardName } from "./naming";
  import Transcript from "./Transcript.svelte";
  import type { Shadow } from "./shadows.svelte";

  let {
    shadow,
    read = 1,
    rails = "left",
    watching = true,
    onread,
  }: {
    shadow: Shadow;
    /** The same four the transcript takes on this wall, passed straight
     *  through. Not re-derived here: how the window is set up to be read from
     *  belongs to `App.svelte` whichever kind of card is in the panel, and a
     *  shadow whose reading size was its own would be the one panel that did
     *  not answer ctrl+0. */
    read?: number;
    rails?: "left" | "right";
    watching?: boolean;
    onread?: (next: number) => void;
  } = $props();

  const name = $derived(cardName(shadow.title, ""));

  /** The card's activity line, with the suffix a card face would put on it —
   *  same rule as `Card.svelte`'s label, so the two cannot disagree. */
  const status = $derived.by(() => {
    const s = shadow.idleSeconds;
    if (shadow.working || s < 2) return shadow.doing;
    if (s < 60) return `${shadow.doing} · ${s}s`;
    if (s < 3600) return `${shadow.doing} · ${Math.floor(s / 60)}m`;
    return `${shadow.doing} · ${Math.floor(s / 3600)}h`;
  });
</script>

<section class="yonder" data-st={shadow.tier} class:unheard={shadow.face.unheard}>
  <header>
    <span class="where">{shadow.project} · on {shadow.host}</span>
    <span class="title" class:provisional={name.provisional}>{name.text}</span>
    <span class="act"><span class="dot"></span>{status}</span>
  </header>

  <p class="note">
    <!-- What the panel still owes saying, now that the conversation itself
         crosses. Two things, and both are about the *edges* of what is here:
         how far back it goes, and that a prompt of yours is marked until the
         far wall says it has it. The old sentence — "its conversation stays on
         {host}" — was the honest reading of a panel that had one line of it,
         and keeping it now would be the panel describing a limitation it no
         longer has. -->
    the last of this card's conversation, read from {shadow.host} — older rounds stay there.
    what you send it is marked until {shadow.host} says it has it.
  </p>

  <!-- Whether it is stopped on you. Answered in the dock, where a question on
       this wall is, so the two are never answered in two different places. A
       wall gone quiet takes the offer away and says why: the question may
       have been answered there, or run out of time, and an unconfirmed
       question must not look like one still waiting. -->
  {#if shadow.open.length}
    <p class="asking">
      parked on {shadow.open.length === 1 ? "a question" : `${shadow.open.length} questions`} for you
      — answer {shadow.open.length === 1 ? "it" : "them"} in the dock, and it goes back to {shadow.host}
    </p>
  {:else if shadow.sheets.length && shadow.face.unheard}
    <p class="note">
      it was asking you something when {shadow.host} went quiet — it may have been answered there,
      or have run out of time, so it cannot be answered from here until {shadow.host} is heard again
    </p>
  {/if}

  <!-- The conversation, drawn by the same component a card on this wall uses.
       Not a second transcript: `Transcript.svelte` takes `Readable` rather than
       a `Conversation`, and a shadow answers it — so folding, markdown, the
       rails, the find bar, opening a tool call and following the tail all work
       here because they are the same code, not because they were built twice.

       Where this wall is, is said once in the header and nowhere in the column.
       Lyss asked for the host marker kept and she is right that it belongs on
       the furniture: a card on another machine is a fact about the card, and
       repeating it beside every line would make the conversation harder to
       read in exchange for saying nothing new. The receipts under your own
       prompts are the exception, and they say something the header cannot —
       whether the far wall has these particular words. -->
  <div class="column">
    <Transcript conv={shadow} {read} {rails} {watching} {onread} />
  </div>
</section>

<style>
  .yonder {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    height: 100%;
    min-height: 0;
    padding: 1rem 1.1rem;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .where {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .title {
    font-family: var(--display);
    font-size: 1.1rem;
    color: var(--paper);
  }
  .title.provisional {
    font-style: italic;
    color: var(--paper-dim);
  }
  .act {
    font-family: var(--util);
    font-size: 0.75rem;
    color: var(--paper-dim);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  /* Status is the one thing colour is for, and only here: the dot takes the
     card's tier exactly as the card face does. An unheard wall's card is at
     `rest`, which is the tier that claims nothing. */
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
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
  .unheard .title {
    color: var(--paper-mute);
  }

  .note {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--paper-faint);
  }

  /* Amber, because it is the asking status and nothing else here is: the same
     hue the card face wears for the same fact. */
  .asking {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--st-ask);
  }

  /* The transcript takes the rest of the panel and scrolls itself. It brings
     its own rails, find bar and follow-the-tail; nothing here may give it a
     height it has to fight. `min-height: 0` is what lets it shrink below its
     content inside this flex column — without it the column is sized by the
     conversation and the panel grows off the bottom of the window. */
  .column {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
