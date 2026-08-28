<script lang="ts">
  /* What is playing, hung on the wall.
   *
   * Everything it knows is `spotify.ts` and tested — the fold, where the
   * playhead is, how a duration reads, what the line under the controls says —
   * and everything it *does* is `deck.svelte.ts`. What is here is the
   * drawing.
   *
   * Three things about it are deliberate:
   *
   * - **The playhead is read from the wall's own tick, not from a timer of its
   *   own.** `clock` advances by exactly one second and `positionAt` is a
   *   `Math.floor` of something linear in it, which is the arrangement
   *   CLAUDE.md asks for and the reason nothing here polls. librespot would
   *   send a position on an interval if asked; it is not asked.
   *
   * - **Colour is status and nothing else.** The only hue on this face is the
   *   celadon of a progress bar that is actually moving and the rust of a
   *   fault. Spotify's own green is deliberately absent: it is a brand colour,
   *   this app reserves colour for what a thing is *doing*, and a widget that
   *   painted itself green while paused would be saying nothing with the one
   *   signal the wall has.
   *
   * - **A control that cannot work is not drawn.** Not drawn disabled —
   *   absent. `canControl` is false when there is no session, and a transport
   *   greyed out over an empty box is furniture pretending to be an
   *   instrument.
   */

  import { onDestroy } from "svelte";
  import { clock } from "./conversation.svelte";
  import { deck } from "./deck.svelte";
  import {
    canControl,
    describe,
    formatDuration,
    normalizeConfig,
    positionAt,
    progressAt,
    sayHit,
    sayResults,
  } from "./spotify";
  import type { Widget } from "./widgets";

  let { widget }: { widget: Widget } = $props();

  const cfg = $derived(normalizeConfig(widget.config));
  /* Named `deckState` and not `state`, which is what it wants to be called:
     a local binding called `state` turns every `$state(...)` in this file into
     `$`-prefixed store access on it, and svelte-check refuses the file with an
     error about `subscribe` that names neither rune nor store. Worth the four
     extra characters everywhere below. */
  const deckState = $derived(deck.state);

  /* The wall's own tick, and nothing else. `clock.t` is snapped to the second
     rather than being whatever `Date.now()` said when the timer fired, which is
     what makes a countdown step by exactly one — so every reading below is a
     pure function of it and this face owns no timer at all. */
  const elapsed = $derived(positionAt(deckState, clock.t));
  const fraction = $derived(progressAt(deckState, clock.t));
  const live = $derived(canControl(deckState));
  const playing = $derived(deckState.phase === "playing");

  /* Derived rather than captured once: `widget` is a prop, and reading `.id` at
     setup would pin this face to whichever widget it happened to draw first. */
  const id = $derived(`spotify-${widget.id}`);
  $effect(() => {
    const mine = id;
    deck.attach(mine);
    return () => deck.detach(mine);
  });
  onDestroy(() => deck.detach(id));

  /* The search, which is only ever open because you asked for it — a player
     widget that showed a search box at rest would be a search box with a player
     attached. `open` is local to this face rather than on `deck`, because two
     widgets on the wall are two places you might be looking and only one of
     them is being typed into. The *results* are on `deck`, since those are an
     answer from Spotify rather than a thing about this box. */
  let open = $state(false);
  let query = $state("");
  let field = $state<HTMLInputElement | null>(null);

  function toggleSearch() {
    open = !open;
    if (open) {
      /* After the paint that creates it. */
      queueMicrotask(() => field?.focus());
    } else {
      query = "";
      deck.clearSearch();
    }
  }

  /* Debounced, because a search is a network round trip and a person types
     faster than one completes. `deck.search` also stamps each ask so a slow
     early answer cannot land on a later query — the two together are what stop
     the list flickering between two words. */
  let typing: ReturnType<typeof setTimeout> | null = null;
  function onType() {
    if (typing !== null) clearTimeout(typing);
    const mine = query;
    typing = setTimeout(() => void deck.search(mine), 250);
  }
  onDestroy(() => {
    if (typing !== null) clearTimeout(typing);
  });

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      toggleSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (typing !== null) clearTimeout(typing);
      void deck.search(query);
    }
  }

  async function pick(uri: string) {
    if (await deck.play(uri)) {
      /* Closed on success only. A failure leaves the list up with the reason
         under it, because the thing you were trying to do is still the thing
         you want. */
      open = false;
      query = "";
      deck.clearSearch();
    }
  }

  const note = $derived(sayResults(deck.searching, deck.hits.length, deck.searchFault));

  function scrub(e: MouseEvent) {
    if (!deckState.track) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    void deck.seek(at * deckState.track.durationMs);
  }
</script>

<div class="sp" data-layout={cfg.layout}>
  {#if deckState.phase === "off"}
    <!-- The one case with nothing to report and something to offer. -->
    <div class="empty">
      <p class="say">not signed in</p>
      <!-- Not "waiting for the browser…": this branch is only drawn *before*
           the first event of the chain arrives, and `spotify.rs` emits
           `linking` the moment the browser leg starts — at which point the
           face leaves this branch and `describe` names the leg it is really
           on. A label that guessed which leg was running is what put this
           widget on "waiting for the browser…" long after the browser was
           done with. -->
      <button class="link" onclick={() => deck.link()} disabled={deck.busy}>
        {deck.busy ? "signing in…" : "sign in to spotify"}
      </button>
    </div>
  {:else}
    <div class="head">
      {#if cfg.art && deckState.track?.art}
        <img class="art" src={deckState.track.art} alt="" />
      {/if}
      <div class="what">
        <p class="title" title={deckState.track?.name ?? ""}>
          {deckState.track?.name ?? (deckState.phase === "idle" ? "nothing playing" : "…")}
        </p>
        <p class="say" class:fault={deckState.phase === "fault"}>{describe(deckState)}</p>
      </div>
    </div>

    {#if cfg.progress && deckState.track}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="rail" onclick={scrub}>
        <div class="fill" class:moving={playing} style:width="{fraction * 100}%"></div>
      </div>
      <div class="times">
        <span>{formatDuration(elapsed)}</span>
        <span>{formatDuration(deckState.track.durationMs)}</span>
      </div>
    {/if}

    <div class="transport">
      <!-- Drawn whenever there is a session, which is a wider condition than
           `canControl` on purpose: with nothing loaded there is no transport to
           offer but searching is exactly what you want, and a player face whose
           only affordance appears after you have already started something is a
           face you cannot start anything from. -->
      {#if deckState.phase !== "linking" && deckState.phase !== "opening"}
        <button class="find" class:on={open} onclick={toggleSearch} title="search spotify">
          ⌕
        </button>
      {/if}
      {#if live}
        <button onclick={() => deck.prev()} title="previous">‹‹</button>
        <button class="big" onclick={() => deck.playPause()} title={playing ? "pause" : "play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button onclick={() => deck.next()} title="next">››</button>
      {/if}
    </div>

    {#if open}
      <div class="search">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={field}
          bind:value={query}
          oninput={onType}
          onkeydown={onSearchKey}
          placeholder="search spotify…"
          spellcheck="false" />
        {#if note}
          <p class="say" class:fault={deck.searching === "failed"}>{note}</p>
        {/if}
        {#if deck.hits.length > 0}
          <ul class="hits">
            {#each deck.hits as hit (hit.uri)}
              <li>
                <button onclick={() => pick(hit.uri)} title={hit.uri}>
                  <span class="kind">{hit.kind}</span>
                  <span class="name">{hit.title}</span>
                  <span class="by">{sayHit(hit)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* A component is the only CSS scope this codebase has, so every name in here
     is local by construction and needs no prefix. See CLAUDE.md. */
  .sp {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    height: 100%;
    padding: 0.55rem 0.6rem;
    font-family: var(--body);
    color: var(--paper);
    overflow: hidden;
  }

  .head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    min-height: 0;
  }

  .art {
    width: 3rem;
    height: 3rem;
    flex: 0 0 auto;
    object-fit: cover;
    border-radius: 2px;
  }

  .what {
    min-width: 0;
    flex: 1 1 auto;
  }

  .title {
    margin: 0;
    font-size: 0.9rem;
    line-height: 1.2;
    color: var(--paper);
    /* One line and an ellipsis: a title that wrapped would push the transport
       out of a widget whose height somebody chose by dragging it. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .say {
    margin: 0.1rem 0 0;
    font-size: 0.75rem;
    line-height: 1.2;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .say.fault {
    color: var(--st-fail);
  }

  .rail {
    height: 3px;
    background: var(--edge);
    border-radius: 2px;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .fill {
    height: 100%;
    background: var(--paper-faint);
    border-radius: 2px;
  }

  /* The one piece of colour, and it means "this is moving" rather than
     "this is Spotify". */
  .fill.moving {
    background: var(--st-work);
  }

  .times {
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  .transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    margin-top: auto;
  }

  .transport button {
    background: none;
    border: none;
    color: var(--paper-dim);
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0.15rem 0.35rem;
    line-height: 1;
    font-family: inherit;
  }

  .transport button:hover {
    color: var(--paper);
  }

  .transport .big {
    font-size: 1rem;
  }

  /* The magnifier reads as pressed while the box is open, because the box may
     be scrolled out of view in a `bar` layout and a toggle that shows no state
     is a button you press twice. Achromatic — this is chrome, not status. */
  .find.on {
    color: var(--paper);
  }

  .search {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.4rem;
    min-height: 0;
  }

  .search input {
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    width: 100%;
    box-sizing: border-box;
  }

  .search input:focus {
    outline: none;
    border-color: var(--paper-dim);
  }

  .hits {
    list-style: none;
    margin: 0;
    padding: 0;
    /* The wall is zoomable and a widget has a fixed slot, so the list scrolls
       rather than growing the card past the box `CARD_BOX` records for it. */
    max-height: 9rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .hits button {
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-areas: "kind name" "kind by";
    column-gap: 0.4rem;
    align-items: baseline;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 3px;
    color: var(--paper-dim);
    font: inherit;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
  }

  .hits button:hover {
    background: var(--surface);
    color: var(--paper);
  }

  .hits .kind {
    grid-area: kind;
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
    align-self: center;
    min-width: 3.2rem;
  }

  .hits .name {
    grid-area: name;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hits .by {
    grid-area: by;
    font-size: 0.68rem;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-start;
    justify-content: center;
    height: 100%;
  }

  .link {
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
  }

  .link:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--paper-faint);
  }

  .link:disabled {
    cursor: default;
    color: var(--paper-faint);
  }

  /* The bar reading is a strip you sit on a shelf: no art, no transport, the
     title and the playhead only. It is a knob rather than a breakpoint because
     a widget's size is something you chose by dragging it, and guessing from
     the width would override that. */
  .sp[data-layout="bar"] .art,
  .sp[data-layout="bar"] .transport,
  .sp[data-layout="bar"] .times {
    display: none;
  }

  .sp[data-layout="compact"] .art {
    width: 2rem;
    height: 2rem;
  }

  .sp[data-layout="compact"] .times {
    display: none;
  }
</style>
