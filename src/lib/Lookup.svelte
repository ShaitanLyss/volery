<script lang="ts">
  /* Ctrl+K: search and everything (`docs/chat-mode.md` §10.1). Conversations and
     projects, every leader chord with its keys beside it, Volery's own slash
     commands, the settings and the sink — one list, ranked by `search.ts`.

     It runs nothing itself: a pick is handed to its owner, which knows what a
     conversation, a chord or a setting is. Focus lands in the query when it
     opens; ↑↓ (or ctrl+n / ctrl+p) move, Enter takes, Escape closes and goes no
     further — the window's Escape would otherwise stop the conversation's turn
     on the same press. */
  import { onMount } from "svelte";
  import type { ChatRow } from "./chatview";
  import { entriesOf, rank, type Entry } from "./search";

  let {
    rows,
    projects,
    chords,
    commands,
    onpick,
    onclose,
  }: {
    rows: ChatRow[];
    projects: string[];
    chords: readonly { keys: string; label: string }[];
    commands: readonly { name: string; summary: string }[];
    onpick: (e: Entry) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  let lit = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLUListElement | undefined = $state();

  const all = $derived(entriesOf({ rows, projects, chords, commands }));
  const shown = $derived(rank(all, rows, query));

  /* A new query starts at the top. */
  $effect(() => {
    void query;
    lit = 0;
  });
  /* The lit row stays in view as it moves. */
  $effect(() => {
    const i = lit;
    list?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => input?.focus());

  const KIND: Record<Entry["kind"], string> = {
    conversation: "conversation",
    project: "project",
    chord: "command",
    command: "slash command",
    setting: "setting",
    sink: "the sink",
  };

  function take(e: Entry | undefined) {
    if (e) onpick(e);
  }

  function onkey(e: KeyboardEvent) {
    const n = shown.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      e.stopPropagation();
      if (n) lit = (lit + 1) % n;
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      e.stopPropagation();
      if (n) lit = (lit - 1 + n) % n;
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      take(shown[lit]);
    } else if (e.key === " " || e.key.length === 1) {
      /* A query is typed, never the leader or the window's keys. */
      e.stopPropagation();
    }
  }
</script>

<div class="scrim" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <div class="pal" role="dialog" aria-label="search and everything">
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onkey}
      placeholder="search conversations, projects, commands, settings…"
      aria-label="search"
      aria-controls="palette-list"
      aria-activedescendant={shown.length ? `palette-${lit}` : undefined}
      spellcheck="false"
    />
    {#if shown.length}
      <ul id="palette-list" role="listbox" bind:this={list}>
        {#each shown as e, i (e.kind + ":" + ("id" in e ? e.id : "keys" in e ? e.keys : "name" in e ? e.name : e.label))}
          <li
            id="palette-{i}"
            role="option"
            aria-selected={i === lit}
            data-i={i}
            data-kind={e.kind}
            class:lit={i === lit}
            onpointermove={() => (lit = i)}
            onclick={() => take(e)}
            onkeydown={() => {}}
          >
            <span class="l">{e.label}</span>
            {#if e.kind === "chord"}<kbd>{e.note}</kbd>{:else}<span class="n">{e.note}</span>{/if}
            <span class="k">{KIND[e.kind]}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="none">nothing answers to that</p>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: color-mix(in srgb, var(--shade) 35%, transparent);
    animation: fade var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  .pal {
    width: min(620px, calc(100% - 48px));
    max-height: 64vh;
    display: flex;
    flex-direction: column;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: color-mix(in oklab, var(--raised) 98%, transparent);
    box-shadow: 0 30px 70px -24px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
    overflow: hidden;
    animation: drop var(--dur-scene, 360ms) var(--ease-out, ease-out) both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pal {
      animation-name: fade;
    }
  }
  input {
    flex: none;
    height: 46px;
    padding: 0 16px;
    border: 0;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    background: transparent;
    color: var(--paper);
    font: 14.5px var(--cv-ui, var(--util));
    outline: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 12px;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--paper-dim);
    cursor: pointer;
  }
  li.lit {
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    color: var(--paper);
  }
  .l {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n {
    max-width: 220px;
    font-size: 12px;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  kbd {
    font: 11px var(--cv-ui, var(--util));
    color: var(--cv-note, var(--paper-mute));
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .k {
    font-size: 11px;
    color: var(--cv-note, var(--paper-mute));
    min-width: 76px;
    text-align: right;
  }
  .none {
    margin: 0;
    padding: 14px 16px;
    font-size: 13px;
    color: var(--cv-note, var(--paper-mute));
  }
</style>
