<script lang="ts">
  /* Screens kept floating over chat view's conversation — Lyss, 2026-10-31:
   * *"it's nice to be able to have floating vignettes"*. A render box's build,
   * a test runner on another laptop, kept in the corner of your eye while you
   * read and write somewhere else.
   *
   * Chat view's alone, and mounted only there: on the wall the same thing is
   * a screen widget stuck to the glass, which needs nothing new. Each vignette
   * is the one tile (`Screen`) in a session of its own (`float:` and the key),
   * so it is seen whichever conversation is in the sheet, is a thumbnail in
   * what it asks of the host (`cast.ts::want` — small, 15 fps), and is driven
   * like any other tile: click into it, and hold Escape to let go.
   *
   * Moved by its strip; placed from the window's bottom-right so a window made
   * smaller keeps them in reach. Not resized: a vignette is a glance, and the
   * sheet is where a screen is big. */

  import { casts } from "./cast.svelte";
  import { monitorLabel, statsLine } from "./cast";
  import Screen from "./Screen.svelte";

  const W = 320;
  const H = 180;

  let drag: { key: string; px: number; py: number; x: number; y: number } | null = null;

  function down(e: PointerEvent, key: string, x: number, y: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    drag = { key, px: e.clientX, py: e.clientY, x, y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    /* From the bottom-right, so moving right or down makes the offset smaller. */
    const x = Math.max(0, Math.min(innerWidth - W, drag.x - (e.clientX - drag.px)));
    const y = Math.max(0, Math.min(innerHeight - H - 24, drag.y - (e.clientY - drag.py)));
    casts.moveFloat(drag.key, x, y);
  }

  function up(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag = null;
  }

  function nameOf(key: string): string {
    const m = casts.monitorOf(key);
    return `${casts.machineOf(key)}${m ? ` · ${monitorLabel(m, [m])}` : ""}`;
  }
</script>

{#each casts.floats as f (f.key)}
  {@const s = casts.showing[`float:${f.key}`]}
  <div
    class="vignette"
    data-float={f.key}
    style:right="{f.x}px"
    style:bottom="{f.y}px"
    style:width="{W}px"
    style:--h="{H}px"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="strip" onpointerdown={(e) => down(e, f.key, f.x, f.y)} onpointermove={move} onpointerup={up}>
      <span class="name" title={nameOf(f.key)}>{nameOf(f.key)}</span>
      <span class="stats">{statsLine(s?.stats ?? null, s?.path ?? null)}</span>
      <button
        type="button"
        title="open it in the sheet"
        onclick={() => (casts.sheet = f.key)}>open</button
      >
      <button
        type="button"
        title="stop floating it (space then r v, with it open)"
        aria-label="stop floating it"
        onclick={() => casts.toggleFloat(f.key)}>×</button
      >
    </div>
    <div class="pic">
      <Screen sid={`float:${f.key}`} screen={f.key} room="any" />
    </div>
  </div>
{/each}

<style>
  .vignette {
    position: fixed;
    z-index: 40;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 14px 30px -14px var(--shade, #000);
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 0.5em;
    height: 22px;
    padding: 0 0.3em 0 0.6em;
    font-family: var(--util);
    font-size: 11px;
    color: var(--paper-dim);
    cursor: grab;
    user-select: none;
  }
  .strip:active {
    cursor: grabbing;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper);
  }
  .stats {
    margin-left: auto;
    white-space: nowrap;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .strip button {
    font: inherit;
    color: var(--paper-dim);
    background: none;
    border: none;
    padding: 0 0.3em;
    cursor: pointer;
  }
  .strip button:hover {
    color: var(--paper);
  }
  /* The tile's own header would say the name twice; the strip says it once
     and the picture is the rest. */
  .pic {
    height: var(--h);
  }
  .pic :global(.screen > header) {
    display: none;
  }
</style>
