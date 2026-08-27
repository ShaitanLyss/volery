<script lang="ts">
  /* Whether Claude itself is up, hung on the wall.
   *
   * Everything it knows is `status.ts` and tested — the two ladders, the
   * ordering, the colour, the wording, how old a reading has to be before it
   * stops being one — and everything it *does* is an attach and a detach on
   * `beacon.svelte.ts`. What is here is the drawing.
   *
   * Three things about it are deliberate:
   *
   * - **Colour is the whole instrument.** The house rule reserves colour for
   *   status and this face is nothing but status, so `toneOf` maps Statuspage's
   *   ladder onto the five existing `--st-*` tokens and no tone is invented. The
   *   sixth rung — not having reached the page — is drawn in `--paper-faint`,
   *   which is not a status colour and must not become one: an absent reading
   *   painted green, amber or rust would be this widget making news up.
   *
   * - **A failed ask is drawn, never papered over.** The opposite call to the
   *   update check in the header, where every failure is silence. There, being
   *   unable to check is a fact about plumbing. Here it is evidence about the
   *   very thing you are asking after — and leaving the last green reading
   *   standing over a failed ask is the single dishonest thing this face could
   *   do. Same reasoning behind the age: a reading taken forty minutes ago while
   *   the window was behind something else says so.
   *
   * - **The page's own sentence, verbatim.** "All Systems Operational" is drawn
   *   as written, Title Case and all. This app does not get to paraphrase
   *   somebody else's status page. The per-component word *is* ours
   *   (`sayGrade`), because that is our summary of an enum rather than a
   *   restatement of a claim.
   */

  import { clock } from "./conversation.svelte";
  import type { Beacon } from "./beacon.svelte";
  import {
    clip,
    gradeOfImpact,
    gradeOfReading,
    hiddenBy,
    incidentsOf,
    isStale,
    latestNote,
    rowsOf,
    sayAge,
    sayGrade,
    sayHeadline,
    toneOf,
    type Incident,
  } from "./status";
  import { onOf, rowsFor, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    beacon,
    onopen,
  }: {
    widget: Widget;
    beacon: Beacon;
    /** Out of the app entirely, to the incident's own page. Routed up rather
     *  than an `<a href>`, like every link on this wall — see `open.rs` for why
     *  one here would be a one-way trip out of an undecorated window. */
    onopen?: (url: string) => void;
  } = $props();

  $effect(() => {
    beacon.attach(widget.id);
  });
  $effect(() => () => beacon.detach(widget.id));

  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const onlyIll = $derived(textOf(widget, "showing", "all") === "ill");
  const withPlanned = $derived(onOf(widget, "upcoming", false));

  const reading = $derived(beacon.reading);
  const grade = $derived(reading ? gradeOfReading(reading) : "unknown");
  const stale = $derived(!!reading && isStale(reading, now));
  const incidents = $derived(reading ? incidentsOf(reading, withPlanned) : []);

  const all = $derived(reading ? rowsOf(reading, onlyIll) : []);
  /* One row given back to the incident line when there is one, because a widget
     that overflowed would hide the news behind a scrollbar the wheel cannot move
     — `Canvas` preventDefaults every wheel on the surface. The box you drag it to
     is the setting, which is the rule the whole catalogue is built on. */
  const room = $derived(Math.max(1, rowsFor(widget.h) - (incidents.length ? 1 : 0)));
  const rows = $derived(all.slice(0, room));
  const rest = $derived(all.length - rows.length);
  const filtered = $derived(reading ? hiddenBy(reading, onlyIll) : 0);

  /** The one incident the small face has room for. Worst first, so this is the
   *  one you would have picked. */
  const lead = $derived<Incident | null>(incidents[0] ?? null);

  function why(i: Incident): string {
    const note = latestNote(i);
    return note ? `${i.name} — ${clip(note.body, 400)}` : i.name;
  }
</script>

<div class="status" data-variant={variant} data-grade={grade}>
  <header>
    <span class="dot" style:background={toneOf(grade)}></span>
    <span class="what">claude</span>
    {#if reading}
      <span class="age" class:stale title={stale ? "the window has been away — this reading is old" : undefined}>
        {sayAge(reading.at, now)}
      </span>
    {/if}
  </header>

  {#if !reading}
    <!-- Not asked yet, which is a third state and not the same as either
         answer. It lasts a tick on an ordinary wall; it lasts until you look at
         the window on one opened behind something else, which is the bound
         doing exactly what it is for. -->
    <p class="quiet">looking&hellip;</p>
  {:else if !reading.got}
    <p class="quiet fault" title={reading.fault ?? undefined}>
      could not reach the status page
      <span class="sub"
        >{reading.fault ? clip(reading.fault, 90) : "no answer"}</span
      >
    </p>
  {:else if variant === "parts"}
    {#if rows.length}
      <ul class="rows">
        {#each rows as r (r.name)}
          <li class="row">
            <span class="mark" style:background={toneOf(r.grade)}></span>
            <span class="label" title={r.name}>{r.name}</span>
            <span class="word" style:color={toneOf(r.grade)}>{r.word}</span>
          </li>
        {/each}
        {#if rest > 0}
          <li class="row more">&hellip;and {rest} more</li>
        {/if}
      </ul>
    {:else}
      <!-- An empty pane always says why. A filter that dropped everything is the
           good news spelled out, not a widget that has broken — the same debt
           `emptyBecause` settles for the three logs. -->
      <p class="quiet">
        {filtered > 0
          ? `all ${filtered} services operational`
          : "the page lists no services"}
      </p>
    {/if}
  {:else}
    <div class="head">
      <span class="line" style:color={toneOf(grade)}>{sayHeadline(reading)}</span>
      {#if grade !== "well" && !lead}
        <span class="sub">{sayGrade(grade)}</span>
      {/if}
    </div>
  {/if}

  {#if lead}
    {@const note = latestNote(lead)}
    <button
      class="incident"
      title={why(lead)}
      style:border-color={toneOf(gradeOfImpact(lead.impact))}
      onclick={() => onopen?.(lead.url)}
    >
      <span class="name">{lead.name}</span>
      {#if note}<span class="body">{clip(note.body, 90)}</span>{/if}
    </button>
    {#if incidents.length > 1}
      <span class="quiet tail">and {incidents.length - 1} more open</span>
    {/if}
  {/if}
</div>

<style>
  .status {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    /* Paints no background of its own — the wrapper fills, and leaving it there
       is what lets the `frame` knob's `bare` reach this face. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.6ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .age {
    font-size: 0.6rem;
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
  }
  /* Achromatic, on purpose. An old reading is not a status — it is a statement
     about this window having been elsewhere — and spending amber on it would
     put a fault colour on a wall where nothing is wrong. */
  .age.stale {
    color: var(--paper-mute);
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }

  /* ── the headline reading ─────────────────────────────────────────────── */

  .head {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    padding: 0.2rem 0.3rem;
    overflow: hidden;
  }
  .line {
    /* Sized off the widget's own box, the way the clock and the meter are, so a
       status dragged large is a large reading rather than a small one in a large
       frame. Clamped at both ends: below the floor it stops being legible, and
       above it starts competing with the cards. */
    font-size: clamp(0.7rem, 7cqw, 1.05rem);
    line-height: 1.25;
    text-align: center;
    text-wrap: balance;
  }
  .sub {
    font-size: 0.62rem;
    color: var(--paper-mute);
  }

  /* ── the list reading ─────────────────────────────────────────────────── */

  .rows {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.16rem 0 0;
    list-style: none;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.7ch;
    padding: 0.12rem 0.2rem;
    color: var(--paper-dim);
    font-size: 0.68rem;
    white-space: nowrap;
  }
  .row.more {
    color: var(--paper-mute);
  }
  /* A bar rather than a disc on a row, so it reads as a status stripe down the
     left of the list rather than as six loose dots — the same choice the
     pipelines face makes about the same shape of list. */
  .mark {
    width: 3px;
    height: 0.62rem;
    border-radius: 1px;
    flex: 0 0 auto;
    align-self: center;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .word {
    font-size: 0.62rem;
  }

  /* ── what is actually happening ───────────────────────────────────────── */

  .incident {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    margin-top: 0.24rem;
    padding: 0.2rem 0.34rem;
    border: 1px solid var(--edge);
    /* The tone is on the *left* edge only — a full box in a status colour would
       be a panel shouting, and the dot in the header already carries the grade.
       Set inline above; the rest of the border is given back here. */
    border-top-color: var(--edge);
    border-right-color: var(--edge);
    border-bottom-color: var(--edge);
    border-left-width: 2px;
    border-radius: 2px;
    background: var(--surface);
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.64rem;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
  }
  .incident:hover {
    background: var(--raised);
    color: var(--paper);
  }
  .name {
    font-weight: 600;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    color: var(--paper-mute);
    font-size: 0.6rem;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .quiet {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.3rem 0.2rem 0;
    font-size: 0.66rem;
    line-height: 1.45;
    color: var(--paper-faint);
    overflow: hidden;
  }
  .quiet.fault {
    display: flex;
    flex-direction: column;
    gap: 0.16rem;
  }
  .quiet.tail {
    flex: 0 0 auto;
    padding: 0.16rem 0.2rem 0;
    font-size: 0.6rem;
  }
</style>
