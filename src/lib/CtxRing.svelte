<!-- How full a conversation's context window is, as chat view draws it: the
     wall card's ring (`Card.svelte`), small, warming at the same two lines
     (`classify.ts::ctxWarmth`). Achromatic while there is room — a column of
     rows each wearing celadon would be colour that means nothing — so the only
     colour it ever shows is amber from 65% and rust from 85%, which is when it
     wants you. A dormant card's ring is faint whatever its fill, as on the
     wall: nothing is spending it. -->
<script lang="ts">
  import { ctxWarmth } from "./classify";

  let { ctx, dormant = false, size = 16 }: { ctx: number; dormant?: boolean; size?: number } = $props();

  const R = 11;
  const CIRC = 2 * Math.PI * R;
  const fill = $derived(Math.max(0, Math.min(1, ctx || 0)));
  const warmth = $derived(dormant ? "dormant" : ctxWarmth(fill));
</script>

<svg class="ring {warmth}" viewBox="0 0 26 26" width={size} height={size} aria-hidden="true">
  <circle class="track" cx="13" cy="13" r={R} />
  {#if fill > 0}
    <circle class="fill" cx="13" cy="13" r={R} stroke-dasharray={CIRC} stroke-dashoffset={CIRC * (1 - fill)} />
  {/if}
</svg>

<style>
  .ring {
    flex: 0 0 auto;
    display: block;
    transform: rotate(-90deg);
  }
  circle {
    fill: none;
    stroke-width: 3.2;
  }
  .track {
    stroke: color-mix(in oklab, var(--edge) 90%, var(--paper) 6%);
  }
  .fill {
    stroke-linecap: round;
    stroke: var(--paper-dim);
    transition:
      stroke-dashoffset 0.6s ease,
      stroke 0.6s ease;
  }
  .warm .fill {
    stroke: var(--st-ask);
  }
  .hot .fill {
    stroke: var(--st-fail);
  }
  .dormant .fill {
    stroke: var(--paper-faint);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
</style>
