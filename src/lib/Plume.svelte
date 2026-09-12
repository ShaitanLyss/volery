<script lang="ts">
  /* The toy, drawn.
   *
   * Almost nothing happens here: the canvas is handed straight to a worker on
   * mount and everything on it is drawn there. What is left is the frame around
   * it — a legend you can read without stopping playing, and the one word that
   * says what the last gesture did.
   *
   * **The component is `Plume` and the class is `Synth`**, which is not a whim:
   * a `.svelte.ts` module and a `.svelte` component of the same name are one
   * module path to two files on a case-insensitive filesystem, and TypeScript
   * says so. `Spyglass`/`Finder`, `Console`/`Shell` and `Pomodoro`/`Cycle` are
   * the same split, arrived at the same way. A plume because that is what it
   * draws, and because the wall's vocabulary is birds.
   *
   * **This is the only file in the app that names a hue**, and that is the point
   * rather than an oversight. Colour on the wall means status — celadon
   * working, amber asking, rust failed — so a toy full of it would either
   * dilute that vocabulary or have to do without the one thing that makes it
   * fun. Confining it to a component nothing else imports settles both: the
   * moment you see colour that is not status, you know you are somewhere else.
   * Nothing here touches `tokens.css`.
   */
  import type { Synth } from "./synth.svelte";
  import { MODES } from "./synth";

  let { synth }: { synth: Synth } = $props();

  const note = $derived(MODES.find((m) => m.id === synth.mode)?.note ?? "");
</script>

<!-- Opaque, and covering everything. The wall's rule is that nothing standing
     on it may be transparent; this goes one further and occludes it outright,
     which is also what makes the ambience beneath free to pause. -->
<div class="toy" role="presentation">
  <canvas {@attach (el: HTMLCanvasElement) => synth.attach(el)}></canvas>

  {#if synth.said}
    <!-- Big, centred, brief. A toy has no status bar: this says what you just
         did and is gone before you have finished looking at it. -->
    {#key synth.said}
      <div class="said">{synth.said}</div>
    {/key}
  {/if}

  {#if synth.fault}
    <div class="fault">{synth.fault}</div>
  {/if}

  <div class="legend">
    <span class="what">{synth.mode}</span>
    <span class="note">{note}</span>
    <span class="keys">
      <kbd>space</kbd> palette · <kbd>tab</kbd> mode · <kbd>esc</kbd> close
    </span>
  </div>
</div>

<style>
  .toy {
    position: fixed;
    inset: 0;
    z-index: 400;
    background: #07060a;
    overflow: hidden;
    cursor: none;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .said {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    font-size: 3.4rem;
    font-weight: 300;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.82);
    text-shadow: 0 0 40px rgba(255, 255, 255, 0.25);
    animation: flash 1.1s ease-out forwards;
  }

  @keyframes flash {
    0% {
      opacity: 0;
      transform: scale(0.97);
    }
    12% {
      opacity: 1;
      transform: scale(1);
    }
    70% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  .fault {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    font-size: 0.9rem;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.45);
  }

  .legend {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 1.4rem;
    display: flex;
    gap: 0.9rem;
    align-items: baseline;
    justify-content: center;
    pointer-events: none;
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.3);
  }

  .what {
    color: rgba(255, 255, 255, 0.6);
    letter-spacing: 0.08em;
  }

  .note {
    font-style: italic;
  }

  .keys kbd {
    font: inherit;
    padding: 0 0.28em;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 3px;
    color: rgba(255, 255, 255, 0.5);
  }
</style>
