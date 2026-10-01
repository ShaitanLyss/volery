<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { span } from "./span.svelte";

  const win = getCurrentWindow();
  let maximized = $state(false);

  $effect(() => {
    win.isMaximized().then((v) => (maximized = v));
    const un = win.onResized(() => win.isMaximized().then((v) => (maximized = v)));
    return () => {
      un.then((f) => f());
    };
  });

  /* How many screens, asked at mount and again whenever the window comes back to
     the front — a monitor plugged in announces nothing to us, and coming back to
     the window is the moment the answer is worth having. */
  $effect(() => {
    void span.count();
    const un = win.onFocusChanged(({ payload }) => payload && void span.count());
    /* Rust ends a spread on its own when the screens change under it. Here
       because this is mounted exactly once, for the window's whole life, and
       releases what it holds when it goes. */
    const lost = listen("window:spread", () => span.lost());
    return () => {
      un.then((f) => f());
      lost.then((f) => f());
    };
  });
</script>

<!-- Drawn rather than borrowed: thin strokes in the paper tone, so the controls
     read as part of the wall instead of Win32 glyphs bolted onto it. Only close
     takes colour, and it takes the same rust that means "something broke". -->
<div class="controls">
  <!-- Shown while spread even if a screen has since gone, since it is the only
       way back to one window. -->
  {#if span.screens > 1 || span.view}
    <button
      class="ctl"
      class:on={!!span.view}
      onclick={() => void span.toggle()}
      aria-label={span.view ? "Back to one screen" : "Spread over every screen"}
      title={span.view
        ? "back to one screen (space then w s)"
        : "spread the wall over every screen (space then w s)"}
    >
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0.8 2.4h3.7v5.2H0.8z" />
        <path d="M5.5 2.4h3.7v5.2H5.5z" />
      </svg>
    </button>
  {/if}

  <button class="ctl" onclick={() => win.minimize()} aria-label="Minimise">
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" /></svg>
  </button>

  <!-- Not while spread: maximising puts the window over one screen, and the
       spread would put it straight back (`window.rs::hold`). -->
  <button
    class="ctl"
    disabled={!!span.view}
    onclick={() => win.toggleMaximize()}
    aria-label={maximized ? "Restore" : "Maximise"}
  >
    {#if maximized}
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 3.2h5.8V9H1z" />
        <path d="M3.2 3.2V1H9v5.8H6.8" />
      </svg>
    {:else}
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.2 1.2h7.6v7.6H1.2z" /></svg>
    {/if}
  </button>

  <button class="ctl close" onclick={() => win.close()} aria-label="Close">
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.4 1.4l7.2 7.2M8.6 1.4L1.4 8.6" /></svg>
  </button>
</div>

<style>
  .controls {
    display: flex;
    align-self: stretch;
    /* Cancel the bar's padding so the buttons reach the true window corner —
       when maximised, the close button must be slammable at the screen edge. */
    margin: -0.6rem -0.9rem -0.6rem 0.35rem;
  }

  .ctl {
    width: 42px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    color: var(--paper-mute);
    transition:
      background 0.14s ease,
      color 0.14s ease;
  }
  .ctl svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ctl:hover {
    background: var(--raised);
    color: var(--paper);
  }
  .ctl:active {
    background: var(--surface);
  }
  .ctl.close:hover {
    background: color-mix(in srgb, var(--st-fail) 26%, transparent);
    color: var(--paper);
  }

  .ctl.on {
    color: var(--paper);
  }
  .ctl:disabled {
    opacity: 0.35;
    cursor: default;
    background: none;
  }

  .ctl:focus-visible {
    outline-offset: -2px;
  }
</style>
