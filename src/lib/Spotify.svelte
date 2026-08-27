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
  } from "./spotify";
  import type { Widget } from "./widgets";

  let { widget }: { widget: Widget } = $props();

  const cfg = $derived(normalizeConfig(widget.config));
  const state = $derived(deck.state);

  /* The wall's own tick, and nothing else. `clock.t` is snapped to the second
     rather than being whatever `Date.now()` said when the timer fired, which is
     what makes a countdown step by exactly one — so every reading below is a
     pure function of it and this face owns no timer at all. */
  const elapsed = $derived(positionAt(state, clock.t));
  const fraction = $derived(progressAt(state, clock.t));
  const live = $derived(canControl(state));
  const playing = $derived(state.phase === "playing");

  /* Derived rather than captured once: `widget` is a prop, and reading `.id` at
     setup would pin this face to whichever widget it happened to draw first. */
  const id = $derived(`spotify-${widget.id}`);
  $effect(() => {
    const mine = id;
    deck.attach(mine);
    return () => deck.detach(mine);
  });
  onDestroy(() => deck.detach(id));

  function scrub(e: MouseEvent) {
    if (!state.track) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    void deck.seek(at * state.track.durationMs);
  }
</script>

<div class="sp" data-layout={cfg.layout}>
  {#if state.phase === "off"}
    <!-- The one case with nothing to report and something to offer. -->
    <div class="empty">
      <p class="say">not signed in</p>
      <button class="link" onclick={() => deck.link()} disabled={deck.busy}>
        {deck.busy ? "waiting for the browser…" : "sign in to spotify"}
      </button>
    </div>
  {:else}
    <div class="head">
      {#if cfg.art && state.track?.art}
        <img class="art" src={state.track.art} alt="" />
      {/if}
      <div class="what">
        <p class="title" title={state.track?.name ?? ""}>
          {state.track?.name ?? (state.phase === "idle" ? "nothing playing" : "…")}
        </p>
        <p class="say" class:fault={state.phase === "fault"}>{describe(state)}</p>
      </div>
    </div>

    {#if cfg.progress && state.track}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="rail" onclick={scrub}>
        <div class="fill" class:moving={playing} style:width="{fraction * 100}%"></div>
      </div>
      <div class="times">
        <span>{formatDuration(elapsed)}</span>
        <span>{formatDuration(state.track.durationMs)}</span>
      </div>
    {/if}

    {#if live}
      <div class="transport">
        <button onclick={() => deck.prev()} title="previous">‹‹</button>
        <button class="big" onclick={() => deck.playPause()} title={playing ? "pause" : "play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button onclick={() => deck.next()} title="next">››</button>
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
