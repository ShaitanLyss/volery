<script lang="ts">
  /* Open pull requests, and which of them want you.
   *
   * The counterpart to the pipelines face and the other half of the same
   * question — a pipeline says whether the work is sound, a review says who is
   * waiting on whom. Kept a separate widget rather than a variant for the reason
   * written into the catalogue entry: they are different facts, and you want
   * both on the wall at once.
   *
   * Everything it knows is `azdo.ts` and tested — in particular `needsMe`, which
   * is narrower than "am I a reviewer" and is the one judgement this face is
   * really making.
   *
   * **A row is a link and nothing else**, the same floor the pipelines face
   * keeps. Voting from here was considered and left out on purpose: an approval
   * is outward-facing, lands under your name on somebody else's work, and is not
   * undoable by the person who reads the result. A gesture like that belongs
   * where the diff is, not on a glanceable list. */

  import { clock } from "./conversation.svelte";
  import type { DevOps } from "./devops.svelte";
  import {
    emptySaid,
    needsMe,
    orderReviews,
    reviewSaid,
    reviewTierOf,
    scopeReviews,
    shortName,
    tallyReviews,
    took,
    voteSaid,
    type Review,
    type ReviewScope,
  } from "./azdo";
  import { rowsFor, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    devops,
    onopen,
  }: {
    widget: Widget;
    devops: DevOps;
    onopen: (url: string) => void;
  } = $props();

  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const scope = $derived(textOf(widget, "scope", "mine") as ReviewScope);
  const wanted = $derived(rowsFor(widget.h));

  /* Two effects rather than one — see the note on the pipelines face. */
  $effect(() => {
    devops.attachReviews(widget.id);
  });
  $effect(() => () => devops.detach(widget.id));

  const half = $derived(devops.reviews);
  const shown = $derived(orderReviews(scopeReviews(half.rows, scope)));
  /* Tallied over everything rather than over the scope, deliberately: a widget
     narrowed to "mine" must still be able to say that three other things are
     waiting on you, or narrowing it would quietly hide the news. */
  const tally = $derived(tallyReviews(half.rows));
  const rows = $derived(shown.slice(0, wanted));
  const rest = $derived(shown.length - rows.length);

  const lanes = $derived.by(() => {
    const by = new Map<string, Review[]>();
    for (const r of shown) {
      const at = by.get(r.repo);
      if (at) at.push(r);
      else by.set(r.repo, [r]);
    }
    return [...by.entries()].slice(0, wanted).map(([repo, list]) => ({ repo, list }));
  });

  function why(r: Review): string {
    const votes = r.votes.length
      ? `\n${r.votes.map((v) => `${shortName(v.by)} — ${voteSaid(v.vote)}`).join("\n")}`
      : "";
    return `${r.repo} !${r.number} — ${r.title}\nby ${shortName(r.by)}, opened ${took(
      now - r.createdAt,
    )} ago${votes}`;
  }
</script>

<div class="reviews" data-variant={variant}>
  <header>
    <span class="what">{half.orgs.length === 1 ? half.orgs[0] : "pull requests"}</span>
    {#if tally.waiting}<span class="tot" data-tier="ask">{tally.waiting} want you</span>{/if}
    {#if tally.failed}<span class="tot" data-tier="fail">{tally.failed} stuck</span>{/if}
  </header>

  {#if half.fault && !half.rows.length}
    <p class="fault" title={half.fault}>{half.fault}</p>
  {:else if !shown.length}
    <!-- `half.unseen` is passed now, where it used to be left to default. It was
         structurally always zero while Azure DevOps answered pull requests
         org-wide in one call; GitHub asks per repository, so a private one the
         credential is not on is a silence this face can now genuinely have —
         and "no open pull requests" over a repo that refused to answer is the
         face claiming to know something it does not. -->
    <p class="quiet">
      {emptySaid("reviews", half.ready, half.orgs, scope !== "all", half.unseen)}
    </p>
  {:else if variant === "dots"}
    <div class="dots">
      {#each shown as r (r.id)}
        <button
          class="dot"
          data-tier={reviewTierOf(r)}
          class:wants={needsMe(r)}
          title={why(r)}
          onclick={() => onopen(r.url)}
          aria-label={why(r)}
        ></button>
      {/each}
    </div>
  {:else if variant === "lanes"}
    <ul class="rows lanes">
      {#each lanes as lane (lane.repo)}
        <li>
          <span class="lane">
            <span class="label">{lane.repo}</span>
            <span class="marks">
              {#each lane.list.slice(0, 12) as r (r.id)}
                <button
                  class="dot"
                  data-tier={reviewTierOf(r)}
                  class:wants={needsMe(r)}
                  title={why(r)}
                  onclick={() => onopen(r.url)}
                  aria-label={why(r)}
                ></button>
              {/each}
            </span>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="rows">
      {#each rows as r (r.id)}
        <li>
          <button
            class="row"
            data-tier={reviewTierOf(r)}
            title={why(r)}
            onclick={() => onopen(r.url)}
          >
            <span class="mark"></span>
            <span class="label">{r.title}</span>
            <!-- The state, only when there is one worth naming. Most open pull
                 requests are simply open, and a column repeating "open" down the
                 list would be width spent saying nothing. -->
            {#if reviewSaid(r)}<span class="said">{reviewSaid(r)}</span>{/if}
            <span class="when">{took(now - r.createdAt)}</span>
          </button>
        </li>
      {/each}
      {#if rest > 0}
        <li><span class="row more">…and {rest} more</span></li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .reviews {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
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
  .tot {
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }
  .tot[data-tier="ask"] {
    color: var(--st-ask);
  }
  .tot[data-tier="fail"] {
    color: var(--st-fail);
  }

  .rows {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.16rem 0 0;
    list-style: none;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .row,
  .lane {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.7ch;
    padding: 0.12rem 0.2rem;
    border: none;
    border-radius: 2px;
    background: none;
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.68rem;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .row.more {
    cursor: default;
    color: var(--paper-mute);
  }
  button.row:hover {
    background: var(--raised);
    color: var(--paper);
  }
  /* One waiting on you reads at full strength, the way a conversation row does
     in the process meter. Still achromatic — the colour is on the mark. */
  .row[data-tier="ask"] .label {
    color: var(--paper);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .said {
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.62rem;
    color: var(--paper-mute);
  }
  .when {
    min-width: 3ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
    color: var(--paper-mute);
  }

  .mark {
    flex: none;
    align-self: center;
    width: 2px;
    height: 0.72em;
    border-radius: 1px;
    background: var(--st-rest);
  }
  .row[data-tier="ask"] .mark,
  .row[data-tier="soft"] .mark {
    background: var(--st-ask);
  }
  .row[data-tier="soft"] .mark {
    opacity: 0.55;
  }
  .row[data-tier="fail"] .mark {
    background: var(--st-fail);
  }

  .dots {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.34rem;
    padding: 0.4rem 0.2rem;
    overflow: hidden;
  }
  .marks {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.28rem;
    overflow: hidden;
  }
  .dot {
    flex: none;
    width: 0.56rem;
    height: 0.56rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--st-rest);
    cursor: pointer;
  }
  .dot[data-tier="ask"],
  .dot[data-tier="soft"] {
    background: var(--st-ask);
  }
  .dot[data-tier="soft"] {
    opacity: 0.55;
  }
  .dot[data-tier="fail"] {
    background: var(--st-fail);
  }
  .dot:hover {
    outline: 1px solid var(--paper-faint);
    outline-offset: 1px;
  }
  .dot.wants {
    box-shadow: 0 0 0 1px var(--st-ask);
  }

  .quiet,
  .fault {
    flex: 1;
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    text-align: center;
    overflow: hidden;
  }
  .fault {
    color: var(--st-fail);
    text-align: left;
  }
</style>
