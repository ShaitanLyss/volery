<script lang="ts">
  /* The find bar over a conversation's column. The state is the thread's
     (`hunt.svelte.ts`); this is the field, the tally and the three buttons, and
     it is drawn by whoever owns the column — over it rather than above it, so
     opening a find does not reflow the thing being searched. */
  import { MIN_QUERY } from "./hunt";
  import type { Hunting } from "./hunt.svelte";

  let {
    hunt,
    onclose,
  }: {
    hunt: Hunting;
    /** After the bar has gone: back to the column, or the next keystroke goes
     *  nowhere — the field was holding focus. Where the column is, is the
     *  mounter's to know. */
    onclose?: () => void;
  } = $props();

  function close() {
    hunt.close();
    onclose?.();
  }

  /** The field's own keys. Enter steps, shift+Enter steps back, Escape leaves.
   *
   *  Stopped from propagating, all of them: Escape on this wall interrupts a
   *  card's turn, and closing a find bar must not also stop an agent — the same
   *  care `Bump.svelte` takes with its own Escape. */
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      hunt.step(e.shiftKey ? -1 : 1);
      return;
    }
    /* Everything else is typing, and must not reach the wall's ladder — a
       printable key there goes into the focused card's draft. */
    e.stopPropagation();
  }
</script>

<div class="hunt">
  <input
    bind:this={hunt.field}
    bind:value={hunt.query}
    class="q"
    type="text"
    spellcheck="false"
    autocomplete="off"
    placeholder="find in this transcript"
    aria-label="find in this transcript"
    onkeydown={onKey}
  />
  <span class="tally" class:none={hunt.query.trim().length >= MIN_QUERY && hunt.matches === 0}
    >{hunt.cap}</span
  >
  <button
    type="button"
    class="hstep"
    disabled={hunt.matches === 0}
    title="previous match — shift+enter"
    onclick={() => hunt.step(-1)}>↑</button
  >
  <button
    type="button"
    class="hstep"
    disabled={hunt.matches === 0}
    title="next match — enter"
    onclick={() => hunt.step(1)}>↓</button
  >
  <button type="button" class="hstep" title="close — escape" onclick={close}>×</button>
</div>

<style>
  /* ── the find bar ──────────────────────────────────────────────────────
     Chrome, so achromatic: colour on this wall is status and a search is not
     one. The single exception is `.tally.none`, which is a *result* — the word
     is not here — and takes the same rust every other failed reading does. */
  .hunt {
    position: absolute;
    z-index: 3;
    top: 0.3rem;
    right: 0.9rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.3rem;
    /* Opaque. It stands over the column, and nothing standing over something
       else on this wall may be transparent. */
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 4px;
    box-shadow: 0 3px 10px color-mix(in srgb, var(--ink) 45%, transparent);
  }
  .hunt .q {
    width: 13rem;
    font-family: var(--util);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.4;
    padding: 0.1rem 0.35rem;
    color: var(--paper);
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
  }
  .hunt .q:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .hunt .tally {
    min-width: 5.5rem;
    font-family: var(--util);
    font-size: calc(0.6rem * var(--read, 1));
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .hunt .tally.none {
    /* The one coloured thing in this bar, and it is a *result* rather than
       chrome: the word is not in this transcript. Same rust every other failed
       reading on the wall takes. */
    color: var(--st-fail);
  }
  .hunt .hstep {
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1;
    padding: 0.15rem 0.3rem;
    color: var(--paper-dim);
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
  }
  .hunt .hstep:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--edge);
  }
  .hunt .hstep:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
</style>
