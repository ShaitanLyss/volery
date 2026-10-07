<script lang="ts">
  /* The whole pile, searchable, without hanging a widget on the wall.
   *
   * `Basin.svelte` is the sink's *widget* face — something you place and read
   * from while you work. This is the other gesture: you are looking for one
   * thing, you half-remember a word from it, and you want it now. A widget you
   * have to find first and then scroll is the wrong shape for that, and a widget
   * you place in order to search once is furniture you then have to take down.
   *
   * `<space>ss`. See `leader.ts` for why the sink is a family.
   *
   * ## It searches the way the agents' own tool does
   *
   * `sink.ts::search` is the shared spelling — every whitespace-separated term
   * has to appear somewhere, quoted phrases stay whole — and it is the same
   * rule `mcp__skein__sink` documents to every card on the wall. Two spellings
   * of one idea is the shape that makes somebody conclude the search is broken
   * when it is merely disagreeing with itself.
   *
   * ## It shows what is waiting, and says so when it is not showing everything
   *
   * The default reading is the pending pile, because that is what the sink is
   * for — `reading` orders it. Settled items are a deliberate second question,
   * since a pile you have to filter past your own finished work is one you stop
   * opening. The count in the footer names what is being hidden rather than
   * leaving you to wonder, which is the same honesty the Basin's own face
   * keeps.
   */
  import {
    KINDS,
    finder,
    reading,
    search,
    stateOf,
    waiting,
    whence,
    type Kind,
  } from "./sink";
  import type { Sink } from "./sink.svelte";

  let {
    sink,
    names,
    now,
    onreveal,
    onclose,
  }: {
    sink: Sink;
    /** Conversation id → what that card is called, so a row can say who found
     *  it. Most of a long-lived pile was dropped by cards that have since
     *  closed, which `finder` answers for. */
    names: Map<string, string>;
    now: number;
    onreveal?: (id: string) => void;
    onclose: () => void;
  } = $props();

  let query = $state("");
  let kind = $state<Kind | "all">("all");
  let settled = $state(false);

  const pool = $derived(
    reading(sink.items).filter((i) => (settled ? i.settledAt !== null : i.settledAt === null)),
  );
  const shown = $derived(
    search(pool, query).filter((i) => kind === "all" || i.kind === kind),
  );
  const hidden = $derived(pool.length - shown.length);

  /* Escape closes, unless it is clearing a query you are in the middle of —
     one key, two meanings, innermost first. That is the ladder `App.svelte`
     already follows for the panel and the menu. */
  function onkey(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (query) {
      query = "";
      e.stopPropagation();
      return;
    }
    onclose();
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="sieve"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="the sink"
    tabindex="-1"
  >
    <input
      class="find"
      bind:value={query}
      placeholder="a word from it — title, body, a file it names, or its id"
      spellcheck="false"
      {@attach (el: HTMLInputElement) => el.focus()}
    />

    <div class="knobs">
      <button class="knob" class:on={kind === "all"} onclick={() => (kind = "all")}>all</button>
      {#each KINDS as k (k)}
        <button class="knob" class:on={kind === k} onclick={() => (kind = k)}>{k}</button>
      {/each}
      <span class="gap"></span>
      <button class="knob" class:on={settled} onclick={() => (settled = !settled)}>
        {settled ? "settled" : "pending"}
      </button>
    </div>

    <div class="rows" data-scroll>
      {#each shown as i (i.id)}
        {@const toCard = i.heldBy ?? i.from}
        <!-- Reveals the *card*, not the item — the card holding it if somebody
             has taken it, else the one that found it. Offered only when there
             is a card still on the wall to go to: a row that looks clickable
             and does nothing teaches you to distrust the ones that work, which
             is the Basin's own rule about a verb it withholds. -->
        <button
          class="row"
          class:go={toCard && names.has(toCard)}
          disabled={!(toCard && names.has(toCard))}
          onclick={() => toCard && onreveal?.(toCard)}
          title={toCard && names.has(toCard) ? "go and look at that card" : "that card has closed"}
        >
          <span class="line">
            <span class="kind">{i.kind}</span>
            <span class="title">{i.title}</span>
            {#if i.voices > 1}<span class="voices">×{i.voices}</span>{/if}
          </span>
          <span class="under">
            {finder(i, names)} · {waiting(i, now)} ago{#if stateOf(i) !== "waiting"} ·
              {stateOf(i)}{/if}{#if whence(i, sink.here)} · <span class="whence"
                >{whence(i, sink.here)}</span
              >{/if}
          </span>
        </button>
      {:else}
        <p class="nothing">
          {#if query}nothing matches “{query}”{:else if settled}nothing settled yet{:else}the pile
            is empty{/if}
        </p>
      {/each}
    </div>

    <p class="foot">
      {shown.length} shown{#if hidden > 0}, {hidden} hidden by the filters{/if} · escape
      {query ? "clears the search" : "closes"}
    </p>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    /* Sized off the span rather than `inset: 0`: spread, the studio root is the
       containing block for anything fixed. See CLAUDE.md on `--span-*`. */
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    right: calc(-1 * var(--span-r, 0px));
    background: var(--scrim);
    display: grid;
    place-items: center;
    z-index: 90;
  }
  .sieve {
    width: min(48rem, 92cqw);
    height: min(40rem, 82cqh);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.1rem 0.8rem;
    background: var(--paper-bg, var(--surface));
    border: 1px solid var(--edge);
    border-radius: 6px;
  }
  .find {
    font-family: inherit;
    font-size: 0.86rem;
    color: var(--paper);
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.5rem 0.7rem;
    flex: 0 0 auto;
  }
  .find:focus {
    outline: none;
    border-color: var(--paper-mute);
  }
  .find::placeholder {
    color: var(--paper-faint);
  }
  .knobs {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex: 0 0 auto;
  }
  .gap {
    flex: 1 1 auto;
  }
  .knob {
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.18rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 999px;
    background: transparent;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .knob:hover {
    color: var(--paper-mute);
  }
  .knob.on {
    color: var(--paper);
    border-color: var(--paper-mute);
    background: var(--well);
  }
  /* A scroller inside a flex column whose height is only a max wants an `auto`
     basis — see restore.md, where a zero basis collapsed a list to nothing. */
  .rows {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-align: left;
    padding: 0.4rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }
  .row.go:hover {
    background: var(--well);
    border-color: var(--edge);
  }
  .row:disabled {
    cursor: default;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }
  .kind {
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
    flex: 0 0 auto;
  }
  .title {
    font-size: 0.82rem;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .voices {
    font-size: 0.68rem;
    color: var(--paper-faint);
    flex: 0 0 auto;
  }
  .under {
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  /* Which machine it came from, drawn only when that is not this one. Marked
     rather than coloured — colour is status here. */
  .whence {
    font-family: var(--util);
    letter-spacing: 0.06em;
    color: var(--paper-mute);
  }
  .nothing {
    margin: 1.5rem 0 0;
    text-align: center;
    font-size: 0.76rem;
    color: var(--paper-faint);
  }
  .foot {
    margin: 0;
    flex: 0 0 auto;
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
</style>
