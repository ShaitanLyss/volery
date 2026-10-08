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
  import { sentReading } from "./shadow";
  import type { Shadow } from "./shadows.svelte";

  let { shadow }: { shadow: Shadow } = $props();

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
    only what this card is doing travels between walls — its conversation stays on
    {shadow.host}. what you send it from here is below, marked until {shadow.host} says
    it has it.
  </p>

  <div class="lines" data-scroll>
    {#if shadow.digest.said}
      <div class="said">
        <span class="cap">last said</span>
        {shadow.digest.said}
      </div>
    {/if}

    {#each shadow.sent as p (p.id)}
      {@const r = sentReading(p, shadow.host, clock.t)}
      <div class="you {r.look}">
        {p.text}
        <span class="mark">{r.words}</span>
      </div>
    {:else}
      <p class="none">nothing sent from here yet — type in the dock to speak to it</p>
    {/each}
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

  .lines {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .said,
  .you {
    font-size: calc(var(--tx-size, 0.86rem) * var(--read, 1));
    line-height: var(--tx-leading, 1.55);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .said {
    color: var(--paper-dim);
  }
  .cap {
    display: block;
    font-family: var(--util);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    color: var(--paper-faint);
  }

  /* A prompt, in the transcript's own register: a rule down the left, and the
     rule's stitch saying how far it got. Solid once the other wall has it;
     dashed while it is still here, which is what a local prompt on its way
     wears; dotted once it has left — the stitch the other wall's region is
     drawn in, because that is where it now is. Achromatic until it fails,
     since a prompt in flight is not a status. */
  .you {
    color: var(--tx-you, var(--paper));
    border-left: 2px solid var(--paper-faint);
    padding-left: 0.6rem;
  }
  .you.pending {
    color: color-mix(in srgb, var(--tx-you, var(--paper)) 68%, var(--well));
    border-left-style: dashed;
  }
  .you.transit {
    color: color-mix(in srgb, var(--tx-you, var(--paper)) 68%, var(--well));
    border-left-style: dotted;
  }
  .you.failed {
    border-left-color: var(--st-fail);
  }
  .mark {
    display: block;
    margin-top: 0.15rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }
  .you.failed .mark {
    color: var(--st-fail);
  }
  .none {
    margin: 0;
    font-size: 0.75rem;
    color: var(--paper-faint);
  }
</style>
