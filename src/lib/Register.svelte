<script lang="ts">
  /* The register: the chronicle hung on the wall.
   *
   * Named for the register rather than for the chronicle, and that is not a
   * flourish — this filesystem is case-insensitive, so `Chronicle.svelte` and
   * `chronicle.svelte.ts` would be the *same file* and the import would resolve
   * to whichever TypeScript reached first. `Billboard.svelte` beside
   * `board.svelte.ts` is the same dodge; `journal.svelte.ts`'s head comment is
   * the record of this trap being walked into while the paragraph warning about
   * it was being written.
   *
   * Everything it knows is `chronicle.ts` and tested — the order, the grouping,
   * the tally, what is still in flight. Everything it *does* is one call in
   * `chronicle.svelte.ts`. `.claude/rules/chronicle.md` is the design.
   *
   * Four things here are deliberate:
   *
   * - **A row is the same object as the wisp that flew.** Not a log of
   *   notifications — the notification *is* the newest row, briefly standing up
   *   off the wall (`Canvas.svelte` draws that half). So there is no dismissal
   *   gesture anywhere in this component, and there must not be one: things
   *   scroll off, they are not dismissed. The only state a row has is whether
   *   you have read it.
   *
   * - **Read/unread is real state, and only unread is marked.** A pale rule on
   *   the left and the mark at the top of the ink ramp. Not a colour: the level
   *   already owns the colour, and giving unread one too would mean two things
   *   competing for the same channel on the same row. Deliberately *not* a
   *   count-down badge you clear — `markSeen` is what a click does, so reading
   *   the register is what marks it read, which is the only honest definition.
   *
   * - **Two readings, and they answer different questions.** `roll` is the whole
   *   thing newest-first, for a register hung where you plan: what has this wall
   *   been doing. `since` is the unseen only, grouped by what the things *did*,
   *   for one hung where you work: what do I have to catch up on. Same table,
   *   and the second is the one that makes an absence readable — which is the
   *   whole reason this feature exists.
   *
   * - **Newest first**, with the grain of the wall and against `Basin`'s. A
   *   chronicle is read to find out what just happened; a sink is read to find
   *   what has been ignored longest. Two piles, two orders, and each is wrong
   *   for the other.
   */

  import { clock } from "./conversation.svelte";
  import { chronicle } from "./chronicle.svelte";
  import {
    byNewest,
    digest,
    statusOf,
    tally,
    unseen,
    type Entry,
    type Level,
  } from "./chronicle";
  import { ago } from "./gates";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    onreveal,
  }: {
    widget: Widget;
    /** Go and look at the card that wrote this. */
    onreveal?: (id: string) => void;
  } = $props();

  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const showing = $derived(textOf(widget, "showing", "all"));

  /* One reader behind however many registers are up — see `chronicle.svelte.ts`.
     The pair is the whole lifecycle: without the second, a closed widget leaves
     the wall re-reading a table nothing draws, once per write. */
  $effect(() => {
    chronicle.attach(widget.id);
  });
  $effect(() => () => chronicle.detach(widget.id));

  const all = $derived(byNewest(chronicle.entries));

  const shown = $derived(
    showing === "all" ? all : all.filter((e) => e.level === (showing as Level)),
  );

  /* The digest ignores `showing` on purpose. It answers "what do I have to catch
     up on", and a filtered answer to that question is one that quietly leaves
     something out — which is the one thing a catch-up may not do. */
  const groups = $derived(digest(chronicle.entries));

  const line = $derived(tally(chronicle.entries));
  const waitingHere = $derived(unseen(shown).length);

  function open(e: Entry) {
    void chronicle.markSeen([e.id]);
    /* Volery's own wall-level entries have no card to go to, and a button that
       is drawn and does nothing teaches you to distrust the ones that work. */
    if (e.from && onreveal) onreveal(e.from);
  }
</script>

<!-- One row, both readings. A row in the roll and a row under a group heading
     are two placements of one thing, and duplicating the markup is how the two
     would come to disagree about what a row looks like. -->
{#snippet row(e: Entry)}
  <button
    class="row"
    class:unread={e.seenAt === null}
    class:goes={!!e.from}
    data-st={statusOf(e.level)}
    title={e.from ? `${e.source} — go to the card` : e.source}
    onclick={() => open(e)}
  >
    <i class="dot" aria-hidden="true"></i>
    <span class="src">{e.source}</span>
    <span class="mark">{e.mark}</span>
    {#if e.detail}<span class="detail">{e.detail}</span>{/if}
    <span class="when">{ago(now - e.at)}</span>
  </button>
{/snippet}

<div class="register">
  <header>
    <span class="what">{variant === "since" ? "since you looked" : "register"}</span>
    <span class="tot">{variant === "since" ? waitingHere : shown.length}</span>
    <!-- Offered only when there is something to mark, for the reason a hold's
         verb is: a button that is there and does nothing is one you learn to
         distrust. -->
    {#if chronicle.waiting > 0}
      <button class="seen" title="Mark everything as read" onclick={() => void chronicle.markSeen()}
        >all seen</button
      >
    {/if}
  </header>

  <!-- The strip on the top edge, which is the same fact the wisps carried and
       the only thing this widget says when it is too small to read. -->
  {#if line}
    <div class="strip" aria-label={line}>
      <span class="bar" data-st="ask"></span>
      <span class="bar" data-st="fail"></span>
      <span class="bar" data-st="work"></span>
      <span class="note">{line}</span>
    </div>
  {/if}

  <!-- `data-scroll` is what tells `Canvas`'s wheel handler to let the wheel
       scroll this rather than zoom the wall. `test/styles.test.ts` asserts it
       for every widget face that declares an `overflow`, which is how it was
       caught here. -->
  <div class="scroll" data-scroll>
    {#if variant === "since"}
      {#if groups.length === 0}
        <p class="nothing">nothing new — you are caught up.</p>
      {:else}
        {#each groups as g (g.level)}
          <div class="group">
            <div class="glabel" data-st={statusOf(g.level)}>
              <i class="dot" aria-hidden="true"></i>
              <span>{g.label}</span>
              <span class="gn">{g.entries.length}</span>
            </div>
            {#each g.entries as e (e.id)}
              {@render row(e)}
            {/each}
          </div>
        {/each}
      {/if}
    {:else if shown.length === 0}
      <p class="nothing">
        {all.length === 0
          ? "nothing recorded yet — this fills as the cards work."
          : "nothing of that kind."}
      </p>
    {:else}
      {#each shown as e (e.id)}
        {@render row(e)}
      {/each}
    {/if}
  </div>
</div>

<style>
  /* Colour is status and nothing else here, per `tokens.css`. `data-st` carries
     the level's status word and this block is the only place it becomes a
     colour, so a level added in `chronicle.ts` needs one line here and nothing
     more. */
  [data-st="work"] {
    --st: var(--st-work);
  }
  [data-st="ask"] {
    --st: var(--st-ask);
  }
  [data-st="fail"] {
    --st: var(--st-fail);
  }
  [data-st="rest"] {
    --st: var(--st-rest);
  }

  .register {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem 0.3rem;
    border-bottom: 1px solid var(--edge);
    flex: none;
  }

  .what {
    font-family: var(--util);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }

  .tot {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }

  .seen {
    margin-left: auto;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-mute);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .seen:hover {
    color: var(--paper);
  }

  /* The tally strip. Three hairlines rather than a number in a circle: it is
     read at a glance and at a distance, and the widths say which kinds are
     waiting without anybody having to count. */
  .strip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--edge);
    flex: none;
  }

  .bar {
    height: 2px;
    flex: 1;
    max-width: 2.5rem;
    border-radius: 1px;
    background: var(--st);
    opacity: 0.8;
  }

  .note {
    margin-left: auto;
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--paper-mute);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* No `stickToTail`, and that is the one thing to check before adding it:
       this list grows at the *top*, so following the tail would walk away from
       what just arrived. `follow.ts` is for scrollers that gain content at the
       end. */
  }

  .group {
    padding-bottom: 0.2rem;
  }

  .glabel {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.5rem 0.2rem;
    font-family: var(--util);
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }

  .gn {
    margin-left: auto;
    letter-spacing: 0;
    color: var(--paper-faint);
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: none;
    border-bottom: 1px solid color-mix(in srgb, var(--edge) 55%, transparent);
    background: none;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: default;
  }

  .row.goes {
    cursor: pointer;
  }

  .row:hover {
    background: var(--raised);
  }

  /* Unread is a rule and the ink, never a colour — the level owns the colour,
     and two things in one channel is a row that cannot say either. */
  .row.unread {
    box-shadow: inset 2px 0 0 var(--paper-faint);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st);
    flex: none;
    align-self: center;
  }

  .src {
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--paper-faint);
    flex: none;
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mark {
    font-size: 0.78rem;
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.unread .mark {
    color: var(--paper);
  }

  .detail {
    font-size: 0.7rem;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: none;
    max-width: 40%;
  }

  .when {
    margin-left: auto;
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    flex: none;
  }

  .nothing {
    margin: 0;
    padding: 0.7rem 0.5rem;
    font-size: 0.75rem;
    color: var(--paper-faint);
  }
</style>
