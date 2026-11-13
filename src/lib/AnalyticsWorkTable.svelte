<script lang="ts">
  /* The work tab's honest table, shared by both presentations.
   *
   * It is a component of its own on purpose: the room and the page must show
   * one set of figures (§11.15), and two tables with two column decisions is
   * exactly how a skin change becomes a data change. The rows arrive already
   * built by `analyticswork.ts::cardWorkOf`, so this file decides nothing but
   * how a null reads.
   *
   * **A ratio with no divisor is a dash.** `costPerMerged` is null when the
   * card merged nothing, and printing `$0.00` there would put it at the top of
   * the cheapest column; the title says which divisor was missing. A card with
   * no artifact at all is marked, because design and review are work and zero
   * commits is not zero output.
   */
  import { money, count } from "./usage";
  import { signed, type CardWork } from "./analyticswork";

  let {
    cards,
    onhover,
    compact = false,
  }: {
    cards: CardWork[];
    /** Lets a chart highlight the card under the pointer or the cursor. */
    onhover?: (card: string | null) => void;
    /** The page sets this: fewer columns, the same numbers. */
    compact?: boolean;
  } = $props();

  function dollars(v: number | null): string {
    return v === null ? "" : money(v);
  }
</script>

<div class="wk-tblwrap">
  <table class="wk-table">
    <thead>
      <tr>
        <th scope="col">card</th>
        <th scope="col" class="wk-num">cost</th>
        <th scope="col" class="wk-num">commits</th>
        <th scope="col" class="wk-num">merged</th>
        <th scope="col" class="wk-num">net</th>
        {#if !compact}
          <th scope="col" class="wk-num">churn</th>
        {/if}
        <th scope="col" class="wk-num">$/merged</th>
        <th scope="col" class="wk-num">$/commit</th>
      </tr>
    </thead>
    <tbody>
      {#each cards as card (card.card)}
        <tr
          tabindex="0"
          onfocusin={() => onhover?.(card.card)}
          onfocusout={() => onhover?.(null)}
          onpointerenter={() => onhover?.(card.card)}
          onpointerleave={() => onhover?.(null)}
        >
          <th scope="row">
            <span class="wk-name">{card.label}</span>
            {#if card.project}
              <span class="wk-proj">{card.project}</span>
            {/if}
            {#if card.noArtifact}
              <span class="wk-none" title="design, review and answers produce no artifact">no artifact</span>
            {/if}
          </th>
          <td
            class="wk-num"
            title={card.cost === null
              ? card.unpriced > 0
                ? `${count(card.unpriced)} spend rows could not be priced`
                : "no spend was attributed to this card"
              : card.unpriced > 0
                ? `priced, plus ${count(card.unpriced)} unpriced spend rows`
                : card.reported > 0
                  ? "modeled and reported"
                  : "modeled"}
          >{dollars(card.cost)}</td>
          <td class="wk-num">
            {count(card.commits)}{#if card.attributedCommits > 0}<span
                class="wk-attr"
                title={`${count(card.attributedCommits)} attributed from git history rather than a receipt`}
                >·{count(card.attributedCommits)} attr</span
              >{/if}
          </td>
          <td class="wk-num">
            {count(card.merged)}{#if card.attributedMerges > 0}<span
                class="wk-attr"
                title={`${count(card.attributedMerges)} attributed from git history rather than a receipt`}
                >·{count(card.attributedMerges)} attr</span
              >{/if}
          </td>
          <td class="wk-num" class:wk-neg={card.net < 0}>{signed(card.net)}</td>
          {#if !compact}
            <td class="wk-num">{count(card.churn)}</td>
          {/if}
          <td
            class="wk-num"
            title={card.costPerMerged === null
              ? card.merged === 0
                ? "no merged artifact in this window, so there is no divisor"
                : "no spend was attributed to this card"
              : "cost divided by merged pull requests and merge commits"}
          >{card.costPerMerged === null ? "" : money(card.costPerMerged)}</td>
          <td
            class="wk-num"
            title={card.costPerCommit === null
              ? card.commits === 0
                ? "no commit in this window, so there is no divisor"
                : "no spend was attributed to this card"
              : "cost divided by commits"}
          >{card.costPerCommit === null ? "" : money(card.costPerCommit)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .wk-tblwrap {
    overflow: auto;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
    background: color-mix(in oklab, var(--raised) 60%, transparent);
  }
  .wk-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .wk-table th,
  .wk-table td {
    padding: 5px 10px;
    text-align: left;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    white-space: nowrap;
  }
  .wk-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--raised);
    color: var(--paper-mute);
    font-weight: 500;
    font-size: 10.5px;
  }
  .wk-table tbody th {
    font-weight: 400;
    color: var(--paper-dim);
  }
  .wk-table tbody tr:hover,
  .wk-table tbody tr:focus-visible {
    background: color-mix(in oklab, var(--paper) 6%, transparent);
    outline: none;
  }
  .wk-table .wk-num {
    text-align: right;
    color: var(--paper);
  }
  .wk-table .wk-neg {
    color: var(--paper-mute);
  }
  .wk-name {
    color: var(--paper);
  }
  .wk-proj {
    margin-left: 7px;
    color: var(--paper-faint);
    font-size: 10.5px;
  }
  .wk-attr {
    margin-left: 4px;
    color: var(--paper-faint);
    font-size: 10px;
  }
  .wk-none {
    margin-left: 7px;
    padding: 1px 5px;
    border: 1px solid var(--edge);
    border-radius: 999px;
    color: var(--paper-mute);
    font-size: 9.5px;
    letter-spacing: 0.02em;
  }
</style>
