<script lang="ts">
  /* One card's life (§11.10).
   *
   * The inspector's first block in the room, and the first section of the page
   * in either presentation — one component, so the card cannot be worded two
   * ways. **The chip says what it is on now and is never the caption of the
   * total**: the total's caption is *paid by*, and the bar under it says in
   * what shares, because a card is a history rather than a label.
   *
   * Three honesty rules are drawn here:
   *
   * - The reported dollars are the card's whole life (the `turn` table is not
   *   pruned). The token half is what the fine tier still holds, so when the
   *   card predates it the bar says where the facts begin instead of drawing a
   *   lifetime share over a recent window.
   * - A move with no recorded reason says `reason unknown`. The wall writes the
   *   new value and the instant and nothing else, and a guessed why is worse
   *   than an unanswered one.
   * - A measured zero prints as zero. A dash means the measure does not exist
   *   (no settled turn, no price for a model), never that it was zero.
   */
  import Icon from "./Icon.svelte";
  import { SERIES_FOLD, seriesColor } from "./analytics";
  import {
    daySaid,
    lifeModel,
    livedSaid,
    nowSaid,
    rowSaid,
    splitSaid,
    type CardLife,
    type LifeShare,
  } from "./analyticslife";
  import { shareSaid } from "./analyticsbehaviour";
  import type { CardAllowance } from "./allowancesamples";
  import { count, money } from "./usage";
  import { tipOf } from "./tipped.svelte";

  let {
    life,
    onclose,
    carry,
  }: {
    life: CardLife;
    /** Present in the room's inspector; absent on the page, which has no
     *  neighbour to go back to. */
    onclose?: () => void;
    /** What this card carried of the account's windows, per account and kind.
     *  Null while the life is unread, or when nothing could be priced. */
    carry?: readonly CardAllowance[] | null;
  } = $props();

  const model = $derived(lifeModel(life, Date.now()));

  /* A colour is the entity's, not its rank (`analytics.ts` §10.1). The order is
     the order the card first spent under each label, which does not change when
     a refresh reorders the bar. */
  const payerOrder = $derived.by(() => orderOf(life.spend.map((g) => g.account || "unknown")));
  const modelOrder = $derived.by(() => orderOf(life.spend.map((g) => g.model)));

  function orderOf(labels: readonly string[]): string[] {
    const out: string[] = [];
    for (const label of labels) if (!out.includes(label)) out.push(label);
    return out;
  }

  function colour(label: string, order: readonly string[]): string {
    if (label === "others") return SERIES_FOLD;
    return seriesColor(order.indexOf(label));
  }

  function clock(at: number): string {
    return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  function titled(one: LifeShare): string {
    return `${one.label} · ${shareSaid(one.share)} · ${count(one.tokens)} tokens`;
  }
</script>

<section class="cl" aria-label="this card's life">
  <header class="cl-head">
    <div class="cl-what">
      <h3>{life.label || "this card"}</h3>
      <p class="cl-now">{nowSaid(model)}</p>
    </div>
    {#if onclose}
      <button type="button" class="cl-close" {@attach tipOf("close (esc)")} aria-label="close the card" onclick={onclose}>
        <Icon name="x" small />
      </button>
    {/if}
  </header>

  <div class="cl-total">
    <span class="cl-usd" {@attach tipOf(() => (model.turns > 0 ? "what its settled turns reported, all time" : undefined))}>
      {model.turns > 0 ? money(model.usd) : ""}
    </span>
    <span class="cl-under">
      {count(model.turns)} {model.turns === 1 ? "settled turn" : "settled turns"}
      {#if model.perTurn !== null}· {money(model.perTurn)} each{/if}
    </span>
    <span class="cl-under cl-tokens">
      {#if model.tokens > 0}
        {count(model.tokens)} tok · {count(model.requests)} requests{model.partial
          ? ` since ${daySaid(model.factsFrom, Date.now())}`
          : ""}
      {:else}
        no requests recorded
      {/if}
    </span>
  </div>

  {#if model.payer.rows.length > 0}
    <p class="cl-cap">paid by</p>
    <div class="cl-bar" role="img" aria-label={model.payer.rows.map(titled).join(", ")}>
      {#each model.payer.rows as one (one.label)}
        <span
          class="cl-seg"
          style:background={colour(one.label, payerOrder)}
          style:flex-grow={Math.max(1, one.tokens)}
          {@attach tipOf(() => (titled(one)))}
        ></span>
      {/each}
    </div>
    <ul class="cl-legend">
      {#each model.payer.rows as one (one.label)}
        <li>
          <span class="cl-dot" style:background={colour(one.label, payerOrder)} aria-hidden="true"></span>
          <span class="cl-name">{one.label}</span>
          <span class="cl-share">{shareSaid(one.share)}</span>
          <span class="cl-amount">
            {count(one.tokens)} tok{one.usd !== null ? ` · ${money(one.usd)}` : ""}{one.unpriced > 0 ? " · part unpriced" : ""}
          </span>
        </li>
      {/each}
    </ul>
    {#if model.payer.usdPartial && model.unpriced > 0}
      <p class="cl-note">
        {count(model.unpriced)} tokens sit on a model no price table here knows; they are counted and
        left out of the dollars rather than priced at zero.
      </p>
    {/if}

    {#if model.model.rows.length > 1}
      <p class="cl-cap">by model</p>
      <div class="cl-bar" role="img" aria-label={model.model.rows.map(titled).join(", ")}>
        {#each model.model.rows as one (one.label)}
          <span
            class="cl-seg"
            style:background={colour(one.label, modelOrder)}
            style:flex-grow={Math.max(1, one.tokens)}
            {@attach tipOf(() => (titled(one)))}
          ></span>
        {/each}
      </div>
      <ul class="cl-legend cl-legend-model">
        {#each model.model.rows as one (one.label)}
          <li>
            <span class="cl-dot" style:background={colour(one.label, modelOrder)} aria-hidden="true"></span>
            <span class="cl-name">{one.label}</span>
            <span class="cl-share">{shareSaid(one.share)}</span>
            <span class="cl-amount">{count(one.tokens)} tok{one.usd !== null ? ` · ${money(one.usd)}` : ""}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if splitSaid(model)}
      <p class="cl-note">{splitSaid(model)}</p>
    {/if}
  {:else}
    <p class="cl-cap">paid by</p>
    <p class="cl-note">no requests recorded, so there is no share to draw.</p>
  {/if}

  <h4 class="cl-changes">changes</h4>
  {#if model.timeline.length === 0}
    <p class="cl-note">nothing recorded for this card yet.</p>
  {:else}
    <ol class="cl-line">
      {#each model.timeline as row (row.at + row.verb + row.target)}
        <li>
          <time datetime={new Date(row.at).toISOString()}>
            <span class="cl-day">{daySaid(row.at, Date.now())}</span>
            <span class="cl-clock">{clock(row.at)}</span>
          </time>
          <span class="cl-said">{rowSaid(row)}</span>
          {#if row.reason}<span class="cl-why">{row.reason}</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}

  <!-- **What this card carried of the account's windows** (§11.10). The only
       reading on this wall that says a card "used 40% of the five-hour
       allowance", and it says whose window, because a point on one plan is not
       a point on another. -->
  {#if carry && carry.length > 0}
    <div class="cl-carry-head">of the allowance</div>
    <ul class="cl-carry">
      {#each carry as row (row.account + row.kind)}
        {@const which = row.kind === "session" ? "5-hour" : "weekly"}
        <li>
          {#if row.share === null}
            <span class="cl-carry-said"
              >{row.account}'s {which} window moved nothing while this card ran</span
            >
          {:else}
            <span class="cl-carry-pct">{Math.round(row.share * 100)}%</span>
            <span class="cl-carry-said"
              >of {row.account}'s {which} window, {Math.round(row.points)} of
              {Math.round(row.moved)} points</span
            >
            {#if row.blind > 0}
              <span class="cl-carry-note"
                >{Math.round(row.blind)} points in windows nothing here could price</span
              >
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <footer class="cl-foot">
    {#if model.born > 0}
      born {daySaid(model.born, Date.now())} · lived {livedSaid(model.lived)}{model.open ? " so far" : ""} ·
      {count(model.sessions)} {model.sessions === 1 ? "session" : "sessions"}
    {:else}
      no session recorded for this card
    {/if}
  </footer>
</section>

<style>
  .cl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px 16px;
    font-family: var(--cv-ui, var(--util));
    color: var(--paper);
    min-width: 0;
    container-type: inline-size;
  }
  .cl-head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .cl-what {
    flex: 1;
    min-width: 0;
  }
  .cl-what h3 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cl-now {
    margin: 2px 0 0;
    font-size: 11.5px;
    color: var(--paper-mute);
  }
  .cl-close {
    flex: none;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .cl-close:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }

  .cl-total {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 6px;
  }
  .cl-usd {
    font-size: 26px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .cl-under {
    font-size: 11.5px;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .cl-tokens {
    color: var(--paper-faint);
  }

  .cl-cap {
    margin: 10px 0 0;
    font-size: 10.5px;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    color: var(--paper-faint);
  }
  .cl-bar {
    display: flex;
    gap: 2px;
    height: 10px;
    margin-top: 4px;
    border-radius: 4px;
    overflow: hidden;
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .cl-seg {
    min-width: 3px;
    border-radius: 2px;
  }
  .cl-legend {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cl-legend li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11.5px;
    min-width: 0;
  }
  .cl-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    transform: translateY(1px);
  }
  .cl-name {
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cl-share {
    margin-left: auto;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .cl-amount {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cl-legend-model .cl-amount {
    display: none;
  }
  /* The model rows give up their token count first, so a narrow inspector
     keeps the two things that matter: which model, and how much of it. The
     threshold is the room's 340px column less this block's own padding, which
     is the narrowest width a card page is drawn at. */
  @container (min-width: 300px) {
    .cl-legend-model .cl-amount {
      display: inline;
    }
  }
  .cl-note {
    margin: 4px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--paper-faint);
  }

  .cl-changes {
    margin: 14px 0 0;
    font-size: 10.5px;
    font-weight: 500;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    color: var(--paper-faint);
  }
  .cl-line {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .cl-line li {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 8px;
    align-items: baseline;
    font-size: 11.5px;
  }
  .cl-line time {
    display: inline-flex;
    gap: 4px;
    align-items: baseline;
    color: var(--paper-faint);
    font-family: var(--mono);
    font-size: 10px;
    white-space: nowrap;
  }
  .cl-day {
    color: var(--paper-faint);
  }
  .cl-clock {
    color: var(--paper-mute);
  }
  .cl-said {
    color: var(--paper-dim);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .cl-why {
    grid-column: 2;
    font-size: 10px;
    color: var(--paper-faint);
  }

  .cl-foot {
    margin-top: 14px;
    padding-top: 8px;
    border-top: 1px solid var(--cv-hair, var(--edge));
    font-size: 10.5px;
    color: var(--paper-faint);
  }

  /* What the card carried (§11.10). The percentage is the reading, so it takes
     the readable ink and the window it belongs to stays faint beside it. */
  .cl-carry-head {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--cv-hair, var(--edge));
    font-size: 10px;
    letter-spacing: 0.03em;
    color: var(--paper-faint);
  }
  .cl-carry {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }
  .cl-carry li {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
  }
  .cl-carry-pct {
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .cl-carry-said {
    color: var(--paper-dim);
  }
  .cl-carry-note {
    color: var(--paper-faint);
    font-size: 10px;
  }
</style>
