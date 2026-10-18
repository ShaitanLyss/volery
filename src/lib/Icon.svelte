<script lang="ts">
  /* One of the chat view's icons (`icons.ts`). Stroked in the current colour,
     so a button's colour is the icon's. Hidden from assistive technology: every
     icon here sits beside words or in a control that carries its own name. */
  import { ICONS, type IconName } from "./icons";

  let { name, small = false }: { name: IconName; small?: boolean } = $props();
</script>

<svg class="i" class:s={small} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  {#each ICONS[name] as shape, i (i)}
    <svelte:element this={shape.tag} xmlns="http://www.w3.org/2000/svg" {...shape.attrs} />
  {/each}
</svg>

<style>
  .i {
    width: 16px;
    height: 16px;
    flex: none;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .i.s {
    width: 14px;
    height: 14px;
  }
</style>
