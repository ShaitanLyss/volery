<script lang="ts">
  /* The sink and the billboard as chat view draws them — a page, like a
   * project's, in the sheet where a conversation would be.
   *
   * Lyss, 2026-10-21: *"The sink and board need to become openable from the
   * chat, matching the direction and style of chat view, so not only copying,
   * same system and data, different looks."* So this reads the stores the
   * wall's faces read (`Sink`, `Board`) and the vocabulary they draw with
   * (`sink.ts`, `board.ts`: the order a pile is read in, its states, its
   * search, its ages), and only the drawing is its own — the project page's
   * look, which is chat view's: a display heading, filter pills, hairline rows.
   *
   * One component for both piles, because they are one shape — a list of
   * things somebody left for later, read, opened, and dealt with — and two
   * components would be two places for the shape to drift. What differs is said
   * where it differs: a sink item has a state and four verbs, a notice has an
   * author and one.
   *
   * A row opens in place rather than over the page, so the list you were
   * reading stays where it was; a chip in a conversation that names an item
   * opens the page *on* that item (`focus`).
   *
   * The keyboard reaches all of it, the house rule: j/k or the arrows move
   * between rows, Enter opens one, Escape closes the open row and then goes no
   * further — Escape on this wall stops a turn, and closing a row must not.
   * `/` is the search. */
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { clock } from "./conversation.svelte";
  import { whois } from "./whois.svelte";
  import {
    about,
    reading as sinkReading,
    search as searchSink,
    stateOf,
    tally,
    whence,
    type State,
  } from "./sink";
  import { covering, elsewhere, reading as boardReading, searchNotices } from "./board";
  import { ago as agoMs } from "./gates";
  import { shortHandle } from "./whois";
  import type { Sink } from "./sink.svelte";
  import type { Board } from "./board.svelte";

  let {
    kind,
    sink,
    board,
    focus = null,
  }: {
    kind: "sink" | "board";
    sink: Sink;
    board: Board;
    /** An id, or the first eight characters of one, to open on arrival. */
    focus?: string | null;
  } = $props();

  type Filter = "open" | State;
  let filter = $state<Filter>("open");
  let query = $state("");
  let open = $state<string | null>(null);
  let list = $state<HTMLElement | null>(null);
  let searchBox = $state<HTMLInputElement | null>(null);
  /** A throw-away asked for once and confirmed by a second press — the one
   *  verb here that loses a record (`sink.md`). */
  let armed = $state<string | null>(null);

  onMount(() => {
    sink.attach("pilepage");
    board.attach("pilepage");
    return () => {
      sink.detach("pilepage");
      board.detach("pilepage");
    };
  });

  /* ── the sink ── */
  const everything = $derived([...sink.items, ...sink.settled]);
  const counts = $derived(tally(everything));
  const items = $derived(
    searchSink(
      sinkReading(everything).filter((i) =>
        filter === "open" ? i.settledAt === null : stateOf(i) === filter,
      ),
      query,
    ),
  );

  /* ── the board ── */
  const notices = $derived(searchNotices(boardReading(board.notices), query));

  const FILTERS: { key: Filter; label: string }[] = [
    { key: "open", label: "open" },
    { key: "waiting", label: "waiting" },
    { key: "lapsed", label: "lapsed" },
    { key: "held", label: "held" },
    { key: "settled", label: "settled" },
  ];

  function countOf(f: Filter): number {
    return f === "open" ? counts.waiting + counts.lapsed + counts.held : counts[f];
  }

  /* Opening on a focus: the item a chip named, made visible whatever filter it
     falls under and scrolled to — once it has been read. */
  let landed = $state<string | null>(null);
  $effect(() => {
    const want = focus;
    if (!want || landed === want) return;
    if (kind === "sink") {
      const hit = everything.find((i) => i.id.startsWith(want));
      if (!hit) return;
      filter = hit.settledAt === null ? "open" : "settled";
      open = hit.id;
    } else {
      const hit = board.notices.find((n) => n.id.startsWith(want));
      if (!hit) return;
      open = hit.id;
    }
    landed = want;
    query = "";
    void tick().then(() =>
      list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(open ?? "")}"]`)?.scrollIntoView({ block: "center" }),
    );
  });

  function toggle(id: string) {
    open = open === id ? null : id;
    armed = null;
  }

  const who = (id: string | null) => (id ? whois.name(id) : "you");
  /** An age in the wall's words (`gates.ts::ago`, which the sheet uses too). */
  const ago = (t: number) => agoMs(clock.t - t);

  function rows(): HTMLButtonElement[] {
    return list ? [...list.querySelectorAll<HTMLButtonElement>("button.row")] : [];
  }

  function key(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT") {
      if (e.key === "Escape" && query) {
        e.stopPropagation();
        query = "";
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        rows()[0]?.focus();
      }
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      searchBox?.focus();
      return;
    }
    /* Escape is the page's whichever way it goes: on this wall it would
       otherwise reach the ladder that stops a turn, and the turn it would stop
       belongs to the conversation this page is covering. */
    if (e.key === "Escape") e.stopPropagation();
    if (e.key === "Escape" && open) {
      const at = open;
      open = null;
      void tick().then(() => list?.querySelector<HTMLElement>(`[data-row="${CSS.escape(at)}"]`)?.focus());
      return;
    }
    const down = e.key === "j" || e.key === "ArrowDown";
    const up = e.key === "k" || e.key === "ArrowUp";
    if (!down && !up) return;
    const all = rows();
    if (!all.length) return;
    e.preventDefault();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + (down ? 1 : -1)));
    all[next]!.focus();
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(shortHandle(id));
    } catch {
      /* the clipboard refusing is not worth a fault bar */
    }
  }

  const blocksOf = (text: string) => parseMarkdown(text);
  const fault = $derived(kind === "sink" ? sink.fault : board.fault);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="page" onkeydown={key}>
  <header class="head">
    <span class="glyph" aria-hidden="true"><Icon name={kind === "sink" ? "list" : "pin"} /></span>
    <div class="who">
      <h1>{kind === "sink" ? "the sink" : "the billboard"}</h1>
      <div class="path">
        {#if kind === "sink"}
          <span>what cards noticed and did not stop for — {countOf("open")} open, {counts.settled} settled</span>
        {:else}
          <span>standing notices about work in progress — {board.notices.length} up</span>
        {/if}
      </div>
    </div>
  </header>

  <div class="bar">
    {#if kind === "sink"}
      <div class="filters" role="group" aria-label="show">
        {#each FILTERS as f (f.key)}
          {#if f.key === "open" || countOf(f.key)}
            <button type="button" class:on={filter === f.key} aria-pressed={filter === f.key} onclick={() => (filter = f.key)}>
              {f.label} {countOf(f.key)}
            </button>
          {/if}
        {/each}
      </div>
    {/if}
    <span class="grow"></span>
    <label class="find">
      <Icon name="search" small />
      <input
        bind:this={searchBox}
        bind:value={query}
        placeholder="search — every word, &quot;a phrase&quot; whole"
        aria-label="search {kind === 'sink' ? 'the sink' : 'the billboard'}"
        title="search (/)"
      />
    </label>
  </div>

  {#if fault}<p class="fault">{fault}</p>{/if}

  <ul bind:this={list}>
    {#if kind === "sink"}
      {#each items as it (it.id)}
        {@const st = stateOf(it)}
        <li class:opened={open === it.id}>
          <button type="button" class="row {st}" data-row={it.id} aria-expanded={open === it.id} onclick={() => toggle(it.id)}>
            <i class="shape sink" aria-hidden="true"></i>
            <b>{it.title}</b>
            <span class="when">{st === "settled" && it.settledAt ? `settled ${ago(it.settledAt)}` : ago(it.droppedAt)}</span>
            <span class="line">
              {it.kind}{#if st === "held"} · held by {who(it.heldBy)}{:else if st === "lapsed"} · hold lapsed{/if}{#if it.voices > 1} · {it.voices} voices{/if}{#if about(it)} · {about(it)}{/if}{#if whence(it, sink.here)} · from {whence(it, sink.here)}{/if}
            </span>
          </button>
          {#if open === it.id}
            <div class="open">
              {#if it.body.trim()}
                <div class="md"><Markdown blocks={blocksOf(it.body)} nav={false} /></div>
              {:else}
                <p class="note">no body — the title is the whole of it.</p>
              {/if}
              <p class="note">
                dropped by {who(it.from)}{#if it.settledNote} · settled: {it.settledNote}{/if}
              </p>
              <div class="acts">
                {#if st === "settled"}
                  <button type="button" class="btn" onclick={() => void sink.restore(it.id)}>put it back</button>
                {:else}
                  <button type="button" class="btn" onclick={() => void sink.settle(it.id)}>settle it</button>
                {/if}
                {#if it.heldBy && st !== "settled"}
                  <button type="button" class="btn" onclick={() => void sink.release(it.id)}>release the hold</button>
                {/if}
                <button type="button" class="btn quiet" title="copy {shortHandle(it.id)}, to paste to an agent" onclick={() => void copyId(it.id)}>copy id</button>
                <span class="grow"></span>
                <button
                  type="button"
                  class="btn danger"
                  onclick={() => {
                    if (armed === it.id) void sink.remove(it.id);
                    else armed = it.id;
                  }}>{armed === it.id ? "throw it away — sure?" : "throw it away"}</button
                >
              </div>
            </div>
          {/if}
        </li>
      {:else}
        <li class="none">{query ? "nothing matches" : filter === "open" ? "the sink is empty" : `nothing ${filter}`}</li>
      {/each}
    {:else}
      {#each notices as n (n.id)}
        <li class:opened={open === n.id}>
          <button type="button" class="row" class:stale={n.stale} data-row={n.id} aria-expanded={open === n.id} onclick={() => toggle(n.id)}>
            <i class="shape notice" aria-hidden="true"></i>
            <b>{n.subject}</b>
            <span class="when">{n.stale ? "stale · " : ""}{ago(n.postedAt)}</span>
            <span class="line">
              {n.from === null ? "you" : n.host ? whois.name(n.from, n.title) : who(n.from)}{#if n.host} · on {n.host}{/if}{#if covering(n)} · {covering(n)}{/if}
            </span>
          </button>
          {#if open === n.id}
            <div class="open">
              {#if n.body.trim()}
                <div class="md"><Markdown blocks={blocksOf(n.body)} nav={false} /></div>
              {/if}
              {#if elsewhere(n)}<p class="note">{elsewhere(n)}</p>{/if}
              <div class="acts">
                <button type="button" class="btn quiet" title="copy {shortHandle(n.id)}, to paste to an agent" onclick={() => void copyId(n.id)}>copy id</button>
                <span class="grow"></span>
                <button type="button" class="btn danger" onclick={() => void board.unpost(n.id, n.host)}>take it down</button>
              </div>
            </div>
          {/if}
        </li>
      {:else}
        <li class="none">{query ? "nothing matches" : "nothing is up"}</li>
      {/each}
    {/if}
  </ul>
</div>

<style>
  .page {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 34px 44px 28px;
    max-width: var(--cv-measure, 44rem);
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    font-family: var(--cv-ui, var(--util));
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .page {
      animation: none;
    }
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 22px;
  }
  .glyph {
    width: 48px;
    height: 48px;
    flex: none;
    border-radius: 14px;
    display: grid;
    place-items: center;
    color: var(--paper-dim);
    background: linear-gradient(160deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 8%), var(--raised));
    border: 1px solid var(--cv-hair, var(--edge));
    box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--shade) 90%, transparent);
  }
  .glyph :global(svg) {
    width: 22px;
    height: 22px;
  }
  h1 {
    margin: 0;
    font: 400 30px/1.1 var(--display);
    color: var(--paper);
  }
  .path {
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--paper-mute);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .filters button {
    height: 28px;
    padding: 0 11px;
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--paper-mute);
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .filters button.on {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    border-color: var(--paper-faint);
  }
  .find {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--cv-sheet, var(--ink)) 80%, transparent);
    color: var(--paper-mute);
    min-width: 15rem;
  }
  .find input {
    flex: 1;
    border: 0;
    outline: none;
    background: none;
    color: var(--paper);
    font: 13px var(--cv-ui, var(--util));
  }
  .fault {
    margin: 0 0 10px;
    font-size: 12.5px;
    color: var(--st-fail);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  li {
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .row {
    width: 100%;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: start;
    padding: 12px 6px;
    border-radius: 6px;
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .row:hover,
  .row:focus-visible,
  li.opened .row {
    background: color-mix(in oklab, var(--surface) 50%, transparent);
    outline: none;
  }
  .row b {
    font-weight: 500;
    font-size: 14px;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li.opened .row b {
    white-space: normal;
  }
  .row.settled b,
  .row.stale b {
    color: var(--paper-dim);
  }
  .row .line {
    grid-column: 2;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The two states with a colour of their own on the wall's face keep it here:
     a lapsed hold is amber (somebody should look), a held item celadon (a
     conversation is alive on it). Everything else is ink. */
  .row.lapsed .line {
    color: color-mix(in oklab, var(--st-ask) 55%, var(--paper-dim));
  }
  .row.held .line {
    color: color-mix(in oklab, var(--st-work) 55%, var(--paper-dim));
  }
  .when {
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
    text-align: right;
    white-space: nowrap;
  }
  /* The kind is a shape, the language the chips in prose speak: a sink item is
     a square, a notice a hairline square. */
  .shape {
    width: 8px;
    height: 8px;
    margin-top: 6px;
    justify-self: center;
    background: var(--paper-mute);
  }
  .shape.notice {
    background: none;
    border: 1px solid var(--paper-mute);
  }
  .open {
    padding: 2px 6px 14px 34px;
  }
  .md {
    font: 13.5px/1.55 var(--body);
    color: var(--cv-prose, var(--paper-dim));
  }
  .note {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .btn {
    height: 28px;
    padding: 0 11px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--paper);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .btn:hover,
  .btn:focus-visible {
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    outline: none;
  }
  .btn.quiet {
    color: var(--paper-mute);
  }
  /* The one warm thing: a verb that loses something, and only once the pointer
     is on it. */
  .btn.danger {
    color: var(--paper-mute);
  }
  .btn.danger:hover,
  .btn.danger:focus-visible {
    color: var(--st-fail);
  }
  .none {
    padding: 16px 6px;
    font-size: 13px;
    color: var(--cv-note, var(--paper-mute));
  }
</style>
