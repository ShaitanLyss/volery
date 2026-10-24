<!-- How full a conversation's context window is: the wall card's ring, and
     the one every surface draws, so chat view's rows and header are the card's
     ring at another size rather than a second idea of it. It warms
     independently of status as it approaches full (`classify.ts::ctxWarmth`),
     so a card can be calmly at rest and still visibly close to the edge;
     a dormant card's is faint, since nothing is spending it. -->
<script lang="ts">
  import { ctxWarmth } from "./classify";

  let { ctx, dormant = false, size = 26 }: { ctx: number; dormant?: boolean; size?: number } = $props();

  const CIRC = 2 * Math.PI * 11;
  const fill = $derived(Math.max(0, Math.min(1, ctx || 0)));
  const colour = $derived(
    dormant ? "var(--paper-faint)" : { hot: "var(--st-fail)", warm: "var(--st-ask)", cool: "var(--st-work)" }[ctxWarmth(fill)],
  );
</script>

<svg class="ring" viewBox="0 0 26 26" style:--ring-size="{size}px" aria-hidden="true">
  <circle class="track" cx="13" cy="13" r="11" />
  <circle
    class="fill"
    cx="13"
    cy="13"
    r="11"
    style:stroke={colour}
    style:stroke-dasharray={CIRC}
    style:stroke-dashoffset={CIRC * (1 - fill)}
  />
</svg>

<style>
  .ring {
    flex: 0 0 auto;
    width: var(--ring-size, 26px);
    height: var(--ring-size, 26px);
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.5;
  }
  .ring .track {
    stroke: var(--edge);
  }
  .ring .fill {
    stroke-linecap: round;
    transition:
      stroke-dashoffset 0.6s ease,
      stroke 0.6s ease;
  }
</style>
