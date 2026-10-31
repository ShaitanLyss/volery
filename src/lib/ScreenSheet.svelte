<script lang="ts">
  /* A screen in chat view's sheet, in place of a conversation — or the grid of
   * every screen. Lyss, 2026-10-31: *"I want to be able to easily click on the
   * different laptop/screens in the sidebar; to go immersive there should be
   * an additional click."* So choosing a screen in the sidebar shows it here,
   * live and drivable, with the sidebar still beside it to step to the next;
   * immersive is the tile's own button, or `space r f`.
   *
   * The same `Screen` the wall's widget draws, in its own session (`chat:` and
   * the key), so the wall's tiles — offstage and asking for nothing under chat
   * view — are not borrowed from a room that cannot see them. */

  import { casts } from "./cast.svelte";
  import Screen from "./Screen.svelte";
  import ScreenGrid from "./ScreenGrid.svelte";

  let { which }: { which: string } = $props();
</script>

<div class="sheet-screen">
  {#if which === "all"}
    <ScreenGrid onopen={(key) => (casts.sheet = key)} />
  {:else}
    {#key which}
      <div class="one">
        <Screen sid={`chat:${which}`} screen={which} room="any">
          {#snippet actions()}
            {@const on = casts.floats.some((f) => f.key === which)}
            <button
              class="act"
              title={on
                ? "stop floating it over the conversation (space then r v)"
                : "keep it floating over the conversation while you read (space then r v)"}
              onclick={() => casts.toggleFloat(which)}>{on ? "unfloat" : "float"}</button
            >
          {/snippet}
        </Screen>
      </div>
    {/key}
  {/if}
</div>

<style>
  .sheet-screen {
    position: relative;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* The tile's own header buttons, which this snippet is drawn inside: a
     component is the only CSS scope there is, so the look is said again here. */
  .act {
    font: inherit;
    color: var(--paper-dim);
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0 0.35em;
    cursor: pointer;
  }
  .act:hover {
    color: var(--paper);
  }
  .one {
    flex: 1;
    min-height: 0;
    margin: 0.8rem 1rem 1rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    overflow: hidden;
    background: var(--ink);
  }
</style>
