<script lang="ts" module>
  import type { IconName } from "./icons";
  /** One row of a chat-view picker. `sep` draws a hairline above it. */
  export type PickRow = {
    id: string;
    label: string;
    note?: string;
    aside?: string;
    icon?: IconName;
    on?: boolean;
    sep?: boolean;
  };
</script>

<script lang="ts">
  /* A small list that opens from a chip — the place chip and the model chip in
     chat view (`docs/chat-mode.md` §6.3, the mockup's `.menu`). It decides
     nothing: the rows are its owner's and so is what a pick does.

     The keyboard reaches it whole, the house rule for a menu: focus lands on
     the row in force when it opens, ↑↓ and j/k move, Enter takes, Escape
     closes and goes no further — the window's Escape would otherwise stop the
     conversation's turn on the same press (`App.svelte::chatKey`). */
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";

  let {
    rows,
    onpick,
    onclose,
    up = false,
    label,
  }: {
    rows: PickRow[];
    onpick: (id: string) => void;
    onclose: () => void;
    /** Opens above its chip, for a chip at the foot of the sheet. */
    up?: boolean;
    label: string;
  } = $props();

  let list: HTMLDivElement | undefined = $state();

  function buttons(): HTMLButtonElement[] {
    return [...(list?.querySelectorAll<HTMLButtonElement>("button.mi") ?? [])];
  }

  onMount(() => {
    const all = buttons();
    (all.find((b) => b.dataset.on === "true") ?? all[0])?.focus();
    /* A press anywhere else closes it — on the next frame, so the press that
       opened it is not also the one that closes it. */
    const away = (e: PointerEvent) => {
      if (list && !list.contains(e.target as Node)) onclose();
    };
    const t = requestAnimationFrame(() => window.addEventListener("pointerdown", away, true));
    return () => {
      cancelAnimationFrame(t);
      window.removeEventListener("pointerdown", away, true);
    };
  });

  function onkey(e: KeyboardEvent) {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      e.stopPropagation();
      all[(at + 1) % all.length]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      e.stopPropagation();
      all[(at - 1 + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") {
      onclose();
    } else if (e.key === " ") {
      /* Space is the leader's everywhere else; here it would only scroll. */
      e.stopPropagation();
    }
  }
</script>

<div class="menu" class:up role="menu" aria-label={label} tabindex="-1" bind:this={list} onkeydown={onkey}>
  {#each rows as r (r.id)}
    {#if r.sep}<hr />{/if}
    <button
      type="button"
      class="mi"
      class:on={r.on}
      role="menuitemradio"
      aria-checked={!!r.on}
      data-on={r.on ? "true" : "false"}
      data-pick={r.id}
      onclick={() => onpick(r.id)}
    >
      <span class="ic">{#if r.icon}<Icon name={r.icon} small />{/if}</span>
      <span class="l">{r.label}</span>
      <span class="k">{r.aside ?? ""}</span>
      {#if r.note}<small>{r.note}</small>{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    z-index: 6;
    min-width: 270px;
    max-width: 340px;
    border-radius: var(--cv-r-m, 12px);
    padding: 6px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: color-mix(in oklab, var(--raised) 97%, transparent);
    box-shadow: 0 24px 50px -20px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
    font-size: 13px;
    outline: none;
    animation: drop var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  .menu.up {
    top: auto;
    bottom: calc(100% + 6px);
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  :global(html[data-motion="still"]) .menu {
    animation-name: fade;
  }
  @media (prefers-reduced-motion: reduce) {
    .menu {
      animation-name: fade;
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .mi {
    width: 100%;
    display: grid;
    grid-template-columns: 18px 1fr auto;
    column-gap: 9px;
    align-items: center;
    padding: 7px 9px;
    border: 0;
    border-radius: 9px;
    background: none;
    font: inherit;
    text-align: left;
    color: var(--paper-dim);
    cursor: pointer;
  }
  .mi:hover,
  .mi:focus-visible {
    background: color-mix(in oklab, var(--paper) 5%, transparent);
    outline: none;
  }
  .mi.on {
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    color: var(--paper);
  }
  .mi small {
    grid-column: 2 / 4;
    font-size: 11.5px;
    color: var(--paper-mute);
    margin-top: 1px;
  }
  .ic {
    display: grid;
    place-items: center;
    color: var(--paper-mute);
  }
  .k {
    font-size: 11px;
    color: var(--cv-note, var(--paper-mute));
    white-space: nowrap;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--cv-hair, var(--edge));
    margin: 5px 4px;
  }
</style>
