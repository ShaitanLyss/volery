<script lang="ts">
  /* The same wall in two presentations. One toggle, because the point is that
     the choice is a view rather than a mode: nothing starts, stops or moves. */
  import ShowChat from "./ShowChat.svelte";
  import ShowWall from "./ShowWall.svelte";

  let view = $state<"wall" | "chat">("wall");
</script>

<div class="views">
  <div class="switch" role="group" aria-label="how the wall is presented">
    <button type="button" class:on={view === "wall"} onclick={() => (view = "wall")}>the wall</button>
    <button type="button" class:on={view === "chat"} onclick={() => (view = "chat")}>chat view</button>
  </div>

  {#if view === "wall"}
    <ShowWall />
  {:else}
    <ShowChat />
  {/if}

  <p class="note">
    The same agents, sessions and queue in both. <kbd>ctrl</kbd><kbd>shift</kbd><kbd>M</kbd> or
    <kbd>space</kbd><kbd>w</kbd><kbd>v</kbd> switches from anywhere, and the wall stays mounted
    behind chat view, so going back is instant. Every verb has a chord: <kbd>space</kbd> opens
    the leader, and <kbd>ctrl</kbd><kbd>K</kbd> searches conversations, projects, chords and
    commands in one list. Drop an image on the wall and it stays there as reference.
  </p>
</div>

<style>
  .views {
    display: grid;
    gap: 10px;
  }
  .switch {
    display: inline-flex;
    justify-self: start;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    overflow: hidden;
  }
  .switch button {
    height: 27px;
    padding: 0 12px;
    border: 0;
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .switch button:hover {
    color: var(--paper-dim);
  }
  .switch button.on {
    background: var(--raised);
    color: var(--paper);
  }
  .note {
    margin: 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--paper-faint);
  }
  kbd {
    font-family: var(--util);
    font-size: 9.5px;
    color: var(--paper-mute);
    padding: 1px 5px;
    margin-right: 2px;
    border-radius: 4px;
    border: 1px solid var(--edge);
    background: color-mix(in oklab, var(--surface) 55%, transparent);
  }
</style>
