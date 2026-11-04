<script lang="ts">
  /* Ctrl+K and the space bar: search and everything (`docs/chat-mode.md` §10.1,
     `chatview.md`). Conversations and projects, every leader chord with its keys
     beside it, Volery's own slash commands (those a chord stands for only under
     a `/`), the settings and the sink — one list, ranked by `search.ts` with
     the opener's lead: Ctrl+K's conversations first, the space bar's
     somewhere to go and something to do. A row about the conversation in front
     of you names it, and refuses in its handle's words.

     It runs nothing itself: a pick is handed to its owner, which knows what a
     conversation, a chord or a setting is. Focus lands in the query when it
     opens; ↑↓ (or ctrl+n / ctrl+p) move, Enter takes, Escape closes and goes no
     further — the window's Escape would otherwise stop the conversation's turn
     on the same press. */
  import { onDestroy, onMount } from "svelte";
  import type { ChatRow } from "./chatview";
  import { entriesOf, entryKey, familyOf, glyphOf, rank, standingOf, type Entry, type Lead, type Target } from "./search";
  import { LAPSE_MS, SETTLE_MS, shortcut, type Verb as ChordVerb } from "./leader";
  import Icon from "./Icon.svelte";

  let {
    rows,
    projects,
    chords,
    commands,
    lead = "search",
    recent = [],
    target = null,
    onpick,
    onclose,
  }: {
    rows: ChatRow[];
    projects: string[];
    chords: readonly { keys: string; label: string; verb?: ChordVerb }[];
    commands: readonly { name: string; summary: string; chord?: string }[];
    /** Which half leads (`search.ts::Lead`): Ctrl+K's conversations, or the
     *  space bar's somewhere to go and something to do. */
    lead?: Lead;
    /** What was taken lately, newest first — a tie-breaker, and the head of
     *  an empty action list. */
    recent?: readonly string[];
    /** The conversation in front of you, for the rows that would act on it:
     *  they say which, and refuse in its handle's words. */
    target?: Target | null;
    onpick: (e: Entry) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  let lit = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLUListElement | undefined = $state();
  /** When the last key that could extend a chord landed. The palette's own
   *  clock, measured against the same `LAPSE_MS` the wall's leader uses — a
   *  fast `i a` is the chord, a slow one is a search for something beginning
   *  with those letters. */
  let lastKeyAt = Date.now();
  /** A one-key chord's settle timer. See `SETTLE_MS`. */
  let settle: ReturnType<typeof setTimeout> | null = null;
  function dropSettle() {
    if (settle !== null) clearTimeout(settle);
    settle = null;
  }
  onDestroy(dropSettle);

  const all = $derived(entriesOf({ rows, projects, chords, commands }));
  const shown = $derived(rank(all, rows, query, 60, { lead, recent }));

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

  /** The right-hand word: what taking the row gives you. */
  const SAID: Record<ReturnType<typeof familyOf>, string> = {
    reading: "reading",
    panel: "panel",
    card: "conversation",
    window: "window",
    machine: "machine",
    toy: "toy",
    find: "find",
    conversation: "conversation",
    project: "project",
    command: "slash command",
  };

  /* A row the conversation in front of you would refuse is drawn with the
     reason and is not taken: Enter on it does nothing, which the reason
     beside it already explains. */
  function take(e: Entry | undefined) {
    if (!e) return;
    if (standingOf(e, target)?.refused) return;
    onpick(e);
  }

  function onkey(e: KeyboardEvent) {
    dropSettle();
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
      /* A chord typed fast is the chord, not a search for a tool whose name
         starts with it. The rule is the wall's own `shortcut` (over
         `leader.ts::chord` and `LAPSE_MS`), so `<space>ia` here fires in the
         same instant it does on the wall; type slower and the same letters are
         a query, with Enter taking the row as before.
      
         **A one-key chord settles first** (`SETTLE_MS`). `p` is both the pile
         and the first letter of "pipelines": firing it on the keypress made the
         palette impossible to type a search into. The key goes into the query,
         and any next key cancels the timer; a hand that stops after `p` still
         gets the shortcut, a beat later. */
      dropSettle();
      if (lead === "actions" && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const now = Date.now();
        const since = now - lastKeyAt;
        lastKeyAt = now;
        if (since <= LAPSE_MS && shortcut(query, e.key, since) !== null) {
          const next = query + e.key.toLowerCase();
          const hit = all.find(
            (x): x is Extract<Entry, { kind: "chord" }> => x.kind === "chord" && x.keys === next,
          );
          if (hit && !standingOf(hit, target)?.refused) {
            if (next.length === 1) {
              settle = setTimeout(() => {
                settle = null;
                if (lead === "actions" && query === next) take(hit);
              }, SETTLE_MS);
            } else {
              e.preventDefault();
              e.stopPropagation();
              take(hit);
              return;
            }
          }
        }
      }
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
      placeholder={lead === "actions" ? "go to, open, do…" : "search conversations, projects, commands, settings…"}
      aria-label="search"
      aria-controls="palette-list"
      aria-activedescendant={shown.length ? `palette-${lit}` : undefined}
      spellcheck="false"
    />
    {#if shown.length}
      <ul id="palette-list" role="listbox" bind:this={list}>
        {#each shown as e, i (entryKey(e))}
          {@const standing = standingOf(e, target)}
          <li
            id="palette-{i}"
            role="option"
            aria-selected={i === lit}
            data-i={i}
            data-kind={e.kind}
            data-family={familyOf(e)}
            class:lit={i === lit}
            class:refused={!!standing?.refused}
            aria-disabled={standing?.refused ? "true" : undefined}
            onpointermove={() => (lit = i)}
            onclick={() => take(e)}
            onkeydown={() => {}}
          >
            <span class="thumb" aria-hidden="true"><Icon name={glyphOf(e)} small /></span>
            <span class="l"
              >{e.label}{#if standing}<span class="on"
                  >{standing.refused ? ` — ${standing.refused}` : ` — ${standing.on}`}</span
                >{/if}</span
            >
            {#if e.kind === "chord"}<kbd>{e.note}</kbd>{:else}<span class="n">{e.note}</span>{/if}
            <span class="k">{SAID[familyOf(e)]}</span>
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
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    column-gap: 12px;
    padding: 7px 10px;
    border-radius: 8px;
    font-size: 13px;
    color: var(--paper-dim);
    cursor: pointer;
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    color: var(--paper-dim);
    background: color-mix(in oklab, var(--paper) 6%, transparent);
  }
  li.lit .thumb {
    color: var(--paper);
  }
  .on {
    color: var(--cv-note, var(--paper-mute));
  }
  li.refused {
    color: var(--paper-mute);
    cursor: default;
  }
  li.refused .thumb {
    opacity: 0.55;
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
