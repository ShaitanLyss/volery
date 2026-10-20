<script lang="ts">
  /* The one tip on the window: the whole of a title a card or a row cut short
   * (`tip.ts`, `tipped.svelte.ts`). Mounted once at the root, inside the
   * studio root, so a spread window's `--span-*` reaches it — it stands at
   * viewport coordinates, which is the case that owes them (CLAUDE.md).
   *
   * It takes nothing: no focus, no pointer. The pointer leaving what asked for
   * it is what takes it down, and anything that moves the ground under it — a
   * wheel, a key, the window going behind — takes it down first, since a tip
   * left over a wall that has moved points at nothing. */
  import { tipped } from "./tipped.svelte";
  import { placeTip } from "./tip";

  let w = $state(0);
  let h = $state(0);
  const at = $derived(
    tipped.now ? placeTip(tipped.now.at, { w, h }, { w: window.innerWidth, h: window.innerHeight }) : null,
  );
</script>

<svelte:window onwheel={() => tipped.hide()} onkeydown={() => tipped.hide()} onblur={() => tipped.hide()} />

{#if tipped.now && at}
  <div
    class="tip"
    role="tooltip"
    class:measured={w > 0}
    bind:clientWidth={w}
    bind:clientHeight={h}
    style:left="calc({at.x}px - var(--span-x, 0px))"
    style:top="calc({at.y}px - var(--span-y, 0px))"
  >
    {tipped.now.text}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    z-index: 60;
    max-width: min(46ch, calc(100vw - 12px));
    padding: 0.32rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--surface);
    box-shadow: 0 14px 34px -20px color-mix(in srgb, var(--shade) 90%, transparent);
    color: var(--paper);
    font-family: var(--util);
    font-size: 12.5px;
    line-height: 1.35;
    overflow-wrap: anywhere;
    pointer-events: none;
    /* Unseen for the one frame before it has been measured, so it never
       draws once in the wrong place and then jumps. */
    visibility: hidden;
  }
  .tip.measured {
    visibility: visible;
    animation: tip-in 120ms ease-out both;
  }
  @keyframes tip-in {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tip.measured {
      animation: none;
    }
  }
</style>
