<script lang="ts">
  /* Exporting the window as a report (§13).
   *
   * One question, because there is one decision: whether the names travel. The
   * file itself is self-contained and carries the methodology, so nothing else
   * is asked here. `e` opens this from the room; Escape closes it before the
   * surface, the same order the library keeps.
   */
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { tipOf } from "./tipped.svelte";

  let {
    onclose,
    onwrite,
  }: {
    onclose: () => void;
    /** Write it, and answer the path; throws with the reason it could not. */
    onwrite: (anonymous: boolean) => Promise<string>;
  } = $props();

  let anonymous = $state(true);
  let busy = $state(false);
  let said = $state<string | null>(null);
  let fault = $state<string | null>(null);
  let field = $state<HTMLInputElement>();

  onMount(() => field?.focus());

  async function go() {
    if (busy) return;
    busy = true;
    fault = null;
    said = null;
    try {
      const path = await onwrite(anonymous);
      if (path) said = path;
    } catch (err) {
      fault = String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="ae-wrap" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="ae-panel" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="ae-head" onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }}>
    <header class="ae-head">
      <Icon name="file" small />
      <h3 id="ae-head">export a report</h3>
      <span class="ae-grow"></span>
      <button type="button" class="ae-x" {@attach tipOf("close (esc)")} aria-label="close" onclick={onclose}>
        <Icon name="x" small />
      </button>
    </header>
    <p class="ae-lede">
      one HTML file, opened by double-clicking it. no network and no volery: the data is embedded
      in it, the charts are drawn in it, and the methodology is in it.
    </p>
    <label class="ae-check">
      <input bind:this={field} type="checkbox" bind:checked={anonymous} />
      <span>
        <strong>anonymize the names</strong>
        <em>accounts become account A, machines machine A, projects and cards generic, tool and server names folded. the numbers are untouched.</em>
      </span>
    </label>
    {#if fault}
      <p class="ae-fail">{fault}</p>
    {/if}
    {#if said}
      <p class="ae-said">written to {said}</p>
    {/if}
    <footer class="ae-foot">
      <span class="ae-grow"></span>
      <button type="button" class="ae-btn" onclick={onclose}>cancel</button>
      <button type="button" class="ae-btn ae-go" disabled={busy} onclick={() => void go()}>
        {busy ? "writing…" : "write it"}
      </button>
    </footer>
  </div>
</div>

<style>
  .ae-wrap {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--shade) 38%, transparent);
    animation: ae-fade var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  @keyframes ae-fade {
    from {
      opacity: 0;
    }
  }
  .ae-panel {
    width: min(460px, 86%);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 14px;
    border-radius: 12px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: var(--raised);
    box-shadow: 0 26px 60px -22px color-mix(in srgb, var(--shade) 90%, transparent);
    font-family: var(--cv-ui, var(--util));
    color: var(--paper);
  }
  .ae-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ae-head h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }
  .ae-grow {
    flex: 1;
  }
  .ae-x {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .ae-x:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .ae-lede {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--paper-mute);
  }
  .ae-check {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    padding: 9px 10px;
    border: 1px solid var(--edge);
    border-radius: 8px;
    cursor: pointer;
  }
  .ae-check input {
    margin-top: 2px;
    accent-color: var(--paper-dim);
  }
  .ae-check span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .ae-check strong {
    font-size: 12px;
    font-weight: 600;
  }
  .ae-check em {
    font-style: normal;
    font-size: 11px;
    line-height: 1.45;
    color: var(--paper-faint);
  }
  .ae-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .ae-btn {
    border: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-dim);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 4px 10px;
    border-radius: 7px;
    cursor: pointer;
  }
  .ae-btn:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .ae-go {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--paper) 30%, var(--edge));
  }
  .ae-go:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .ae-fail {
    margin: 0;
    font-size: 11.5px;
    color: var(--st-fail);
  }
  .ae-said {
    margin: 0;
    font-size: 11.5px;
    color: var(--paper-dim);
    overflow-wrap: anywhere;
  }
</style>
