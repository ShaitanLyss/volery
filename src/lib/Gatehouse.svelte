<script lang="ts">
  /* Whether the tree builds, hung on the wall.
   *
   * Named for the gatehouse rather than for the gates, which is not a flourish:
   * this filesystem is case-insensitive, so `Gates.svelte` and `gates.svelte.ts`
   * are the *same file* and `./gates.svelte` resolves to whichever TypeScript
   * reached first. `Basin.svelte` beside `sink.svelte.ts` is the same dodge, and
   * `beacon.svelte.ts` beside `Status.svelte` is the same lesson learned from
   * the other end. Caught here by `svelte-check`, which refuses it outright.
   *
   * Sink 3ebe1d59. The `pipelines` face two specs up draws a *remote* build's
   * state; this draws the local tree's, and the difference is the whole reason
   * it is a second widget rather than a variant — see the spec in `widgets.ts`.
   *
   * Everything it knows is `gates.ts` and tested; everything it *does* is
   * `attach`/`detach` on `gates.svelte.ts`. Read-only, like `pipelines` and
   * unlike `Basin` — a gate reading is not a list of decisions you make, it is
   * an account of what was observed, and the verb it implies (run the gate
   * again) belongs to a card or to your own shell rather than to a widget.
   *
   * Four things about it are deliberate:
   *
   * - **It says *when* and *who*, always, and that is not decoration.** A green
   *   with no time on it is the stale green that made a broadcast need
   *   retracting an hour after it was sent. The reading here is "what was
   *   observed, attributed and timestamped" and never "the tree is fine", which
   *   is a claim nothing in this app is entitled to make: Volery only ever sees
   *   gates run by cards on this wall.
   *
   * - **A partial pass is drawn as amber, not green.** `bash tools/check-gnu.sh`
   *   is `cargo check --lib`, which looks at no `#[cfg(test)]` code at all, and
   *   it is the form everybody on this machine actually types — so the commonest
   *   observation available is a partial one. Drawing it celadon would be the
   *   widget asserting the whole gate passed. Amber is the wall's "somebody
   *   should look", which is exactly right.
   *
   * - **A gate nobody has run is absent rather than grey.** There is no row for
   *   it, because a row implies a reading and there is none. The face says how
   *   many trees it is drawing so an empty pane is never a widget that looks
   *   broken — `logface`'s `emptyBecause` rule, one domain over.
   *
   * - **Flapping is drawn, and it is the reading nobody had.** The same
   *   `cargo update --precise` pin was applied and lost three times on
   *   2026-08-27, each card assuming a sibling had undone its fix when all three
   *   were losing to cargo re-resolving a lock entry. A gate going green and red
   *   repeatedly is visible here in a way it was visible to no one that day.
   */

  import { clock } from "./conversation.svelte";
  import type { Gates } from "./gates.svelte";
  import { ago, type GateState } from "./gates";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    gates,
    names,
  }: {
    widget: Widget;
    gates: Gates;
    /** Conversation id → what that card is called. Most of what a long-lived
     *  table like this holds was observed by cards that have since closed, which
     *  is why `card_name` is resolved on read and may be null. */
    names: Map<string, string>;
  } = $props();

  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const onlyRed = $derived(textOf(widget, "showing", "all") === "red");

  /* `Basin`'s two lines exactly. Which trees to read is the holder's business,
     not this face's — see `gates.svelte.ts`, and note that a widget could not
     answer it anyway: the record is keyed on the directory a card's child
     actually ran in, which the front end does not know for a worktree card. */
  $effect(() => {
    gates.attach(widget.id);
  });
  $effect(() => () => gates.detach(widget.id));

  /** The trees anything has been observed in. */
  const roots = $derived(gates.trees);

  /** The last path segment, which is what a tree is called on this wall. */
  function leaf(root: string): string {
    const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || root;
  }

  type Row = { root: string; state: GateState };

  /* Flattened to rows rather than nested per tree, so `red first` is one
     ordering over everything on the face. A wall with three territories on it
     wants the broken gate at the top whichever tree it is in — nesting would
     bury it under whichever project happened to sort first. */
  const rows = $derived.by<Row[]>(() => {
    const out: Row[] = [];
    for (const root of roots) {
      for (const state of gates.stateOf(root)) {
        if (onlyRed && state.last?.outcome !== "failed") continue;
        out.push({ root, state });
      }
    }
    return out;
  });

  /** How many trees actually had something to say, for the header. */
  const seen = $derived(new Set(rows.map((r) => r.root)).size);

  /** The newest failure anywhere, which is what the `detail` reading opens. */
  const worst = $derived.by<Row | null>(() => {
    let best: Row | null = null;
    for (const r of rows) {
      if (r.state.last?.outcome !== "failed") continue;
      const at = r.state.last.settledAt ?? r.state.last.startedAt;
      const bestAt = best?.state.last?.settledAt ?? best?.state.last?.startedAt ?? -1;
      if (at > bestAt) best = r;
    }
    return best;
  });

  /** Who observed it, in the words on the card where there are any.
   *
   *  `names` first, because a card that is still on the wall may have been
   *  renamed since the row was written; then the name stored with the row; then
   *  the short id, which is the honest answer for a card that has closed — and
   *  that is exactly when this record is worth most, since there is nobody left
   *  to ask. */
  function who(state: GateState): string {
    const r = state.last ?? state.runs[0];
    if (!r) return "";
    const live = names.get(r.card);
    if (live && live !== "untitled") return live;
    if (r.cardName && r.cardName !== "untitled") return r.cardName;
    return r.card.slice(0, 8);
  }

  /** Which of the five status tokens a gate's state earns.
   *
   *  `partial` never reaches `work`, for the reason in the header above: the
   *  commonest observation on this machine is a partial one and drawing it as a
   *  pass would be the widget claiming more than was run. */
  function tone(state: GateState): "work" | "fail" | "ask" | "soft" | "rest" {
    const r = state.last;
    if (!r) return "rest";
    if (r.outcome === "failed") return "fail";
    if (r.scope === "partial") return state.lastWhole ? "soft" : "ask";
    return "work";
  }

  /** The verdict in a word or two. Lowercase and sentence-shaped, per the house
   *  convention, and it never says "passing" — only what was seen. */
  function verdict(state: GateState): string {
    const r = state.last;
    if (!r) return "not seen run";
    if (r.outcome === "failed") return "red";
    if (r.scope === "partial") return "part passed";
    return "green";
  }

  function when(state: GateState): string {
    const r = state.last;
    if (!r) return "";
    return ago(now - (r.settledAt ?? r.startedAt));
  }

  /** A run still open and recent enough to be believable as in flight.
   *
   *  Ten minutes, matching `hooks::GATE_RUNNING_MS` — a row older than that is
   *  more likely orphaned than live, and announcing it as running would be the
   *  widget inventing news. The two numbers are the same fact and should move
   *  together. */
  const RUNNING_MS = 10 * 60 * 1000;
  function running(state: GateState): boolean {
    return state.runs.some(
      (r) => r.outcome === "unknown" && r.settledAt === null && now - r.startedAt < RUNNING_MS,
    );
  }
</script>

<div class="gates">
  <div class="head">
    <span class="title">gates</span>
    {#if gates.fault}
      <span class="fault">{gates.fault}</span>
    {:else if rows.length}
      <span class="count">
        {rows.length} in {seen}
        {seen === 1 ? "tree" : "trees"}
      </span>
    {/if}
  </div>

  {#if !rows.length}
    <p class="empty">
      {#if gates.read === 0}
        not looked yet
      {:else if onlyRed}
        nothing red — {roots.length}
        {roots.length === 1 ? "tree" : "trees"} watched
      {:else}
        no gate has been seen run in
        {roots.length === 1 ? "this tree" : "these trees"} yet
      {/if}
    </p>
  {:else if variant === "detail" && worst}
    <!-- One failure, opened out. The reading for a wall hung where you work:
         not "is anything broken" but "what is broken and do I know why". -->
    <div class="one">
      <div class="line">
        <span class="dot" data-tone="fail"></span>
        <span class="gate">{worst.state.gate}</span>
        <span class="age">{when(worst.state)}</span>
      </div>
      <div class="where">{leaf(worst.root)} · {who(worst.state)}</div>
      {#if worst.state.last?.scope === "partial"}
        <div class="part">only {worst.state.last.narrowed ?? "part of it"} ran</div>
      {/if}
      <code class="cmd">{worst.state.last?.command}</code>
      {#if worst.state.last?.detail}
        <!-- `data-text` puts this on `Canvas.handleOf`'s list of presses the
             wall does not take, so a drag here selects the compiler's words
             instead of carrying the widget off. Paired with `user-select: text`
             below, which is the half that is easy to leave off and which
             `test/styles.test.ts` asserts. -->
        <pre class="detail" data-text>{worst.state.last.detail}</pre>
      {/if}
      {#if worst.state.flapping}
        <div class="flap">
          green and red more than once here — check the fix survives a re-resolve
        </div>
      {/if}
    </div>
  {:else}
    <ul class="list">
      {#each rows as row (row.root + " " + row.state.gate)}
        <li>
          <span class="dot" data-tone={tone(row.state)}></span>
          <span class="gate">{row.state.gate}</span>
          <span class="say">
            {verdict(row.state)}
            {#if running(row.state)}<span class="live">· running</span>{/if}
            {#if row.state.flapping}<span class="live">· flapping</span>{/if}
          </span>
          <span class="age">{when(row.state)}</span>
          {#if roots.length > 1}
            <span class="tree">{leaf(row.root)}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* No background here. `WidgetNode` is the only thing that fills, so the `bare`
     frame actually shows the wall through — a face painting its own
     `var(--ink)` was the bug that made `bare` show nothing. See widgets.md. */
  .gates {
    display: flex;
    flex-direction: column;
    gap: 0.35em;
    height: 100%;
    overflow: hidden;
    font-size: clamp(9px, 3.6cqw, 13px);
    color: var(--paper);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    flex: 0 0 auto;
  }

  .title {
    letter-spacing: 0.04em;
    opacity: 0.75;
  }

  .count,
  .age,
  .tree,
  .where {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  .count {
    margin-left: auto;
  }

  .fault {
    margin-left: auto;
    color: var(--st-fail);
  }

  .empty {
    margin: 0;
    color: var(--paper-faint);
    line-height: 1.35;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    overflow: hidden;
    /* Overflow spills off the bottom, where it is merely the quieter gates —
       the list is red-first, so what is cut is what matters least. Nothing here
       scrolls, for `logface`'s reason: `Canvas` preventDefaults every wheel on
       the wall to zoom it, so a scrollbar would be one nothing could move. */
  }

  .list li {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    white-space: nowrap;
  }

  .dot {
    flex: 0 0 auto;
    width: 0.5em;
    height: 0.5em;
    border-radius: 50%;
    background: var(--paper-faint);
  }

  /* The five status tokens and nothing invented. `rest` is deliberately not a
     status colour: a gate nobody has run is the absence of a reading, and
     drawing it in any of the four would be the widget inventing news. */
  .dot[data-tone="work"] {
    background: var(--st-work);
  }
  .dot[data-tone="fail"] {
    background: var(--st-fail);
  }
  .dot[data-tone="ask"] {
    background: var(--st-ask);
  }
  .dot[data-tone="soft"] {
    background: var(--st-soft);
  }
  .dot[data-tone="rest"] {
    background: var(--paper-faint);
  }

  .gate {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .say {
    color: var(--paper-dim);
  }

  .live {
    color: var(--st-ask);
  }

  .age {
    margin-left: auto;
  }

  .tree {
    flex: 0 0 auto;
    opacity: 0.7;
  }

  .one {
    display: flex;
    flex-direction: column;
    gap: 0.25em;
    overflow: hidden;
  }

  .one .line {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
  }

  .part {
    color: var(--st-ask);
  }

  .cmd {
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The tail of what it said. `user-select: text` beside `data-text`, which is
     the pairing `test/styles.test.ts` asserts and `logface`'s note explains: the
     marker alone buys a pane that can no longer be moved *or* selected. A
     compiler error you cannot copy out is one you read once and then retype. */
  .detail {
    margin: 0;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.9em;
    line-height: 1.3;
    color: var(--paper-dim);
    white-space: pre-wrap;
    overflow: hidden;
    user-select: text;
    cursor: text;
  }

  .flap {
    color: var(--st-ask);
    line-height: 1.3;
    white-space: normal;
  }
</style>
