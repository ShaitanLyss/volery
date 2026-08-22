<script lang="ts">
  /* The sink, hung on the wall.
   *
   * Named for the basin rather than for the sink, which is not a flourish: this
   * filesystem is case-insensitive, so `Sink.svelte` and `sink.svelte.ts` are
   * the *same file* and the import resolves to whichever TypeScript reached
   * first. `Billboard.svelte` beside `board.svelte.ts` is the same dodge, and
   * `meter.svelte.ts` beside `Perf.svelte` is the same lesson learned from the
   * other end.
   *
   * Everything the agents noticed and did not stop for. Everything it knows is
   * `sink.ts` and tested — the ordering, the ages, the states — and everything
   * it *does* is five calls in `sink.svelte.ts`.
   *
   * Four things about it are deliberate:
   *
   * - **This face is where you actually work the pile.** The pipelines and
   *   reviews faces are read-only because what they show belongs to a service;
   *   the billboard lets you post and take down because a notice is an
   *   instruction. This is neither: it is a list of decisions only you can make,
   *   so every verb is here. Settle a thing an agent fixed and forgot to close,
   *   put back one it closed too eagerly, prise a hold off a card that has
   *   plainly moved on, throw away the note that was never worth keeping.
   *
   * - **A hold is drawn as status, because it is one.** Celadon for an item a
   *   conversation is on — the wall's "alive", and that is exactly what it means
   *   here — and amber for a hold nobody has honoured for two hours, which is
   *   the wall's "wants attention" and is likewise exactly right: nothing is
   *   broken, but somebody should look. An unheld item is achromatic like the
   *   rest of the chrome, since waiting is not a status.
   *
   * - **Oldest first**, against the grain of every other face on this wall. See
   *   `reading` in `sink.ts`: a pile is read to find what has been ignored
   *   longest, and newest-first buries exactly that.
   *
   * - **The settled list is one click away rather than a second widget.** "Has
   *   anybody already dealt with this" is asked by somebody looking at the
   *   pending half, and answering it should not mean hanging another instrument.
   *
   * - **The `next` reading is one item, opened out.** Not a skin on the pile: a
   *   list answers "what does this wall owe", and one thing in front of you
   *   answers "what should I do about it now". The second is the reading that
   *   gets an item done, and it is the whole reason to hang a sink where you are
   *   working rather than where you are planning.
   *
   * - **An item you can read is an item you can fix.** Everything else here acts
   *   on an item whole — settle it, free it, throw it away — and until this there
   *   was nothing between keeping a half-thought item and binning it. An agent
   *   drops a finding in the seconds it can spare from the job it was actually
   *   doing, so a typo'd title, a body that trails off, a `note` that is plainly
   *   a `bug`: all normal, and all previously dead weight you could only watch.
   *   The verb is offered on a pending, unheld item and *not drawn at all*
   *   otherwise (`editable` in `sink.ts`) — a button that is there and refuses
   *   teaches you to distrust the ones that work. Rewriting the brief under a
   *   card that is working from it is the billboard's own hazard, so a held item
   *   is left alone; a settled one is history.
   */

  import { clock } from "./conversation.svelte";
  import type { Sink } from "./sink.svelte";
  import {
    KINDS,
    about,
    editable,
    finder,
    held,
    holder,
    moved,
    nothing,
    opening,
    pile,
    proposed,
    refusal,
    stateOf,
    waiting,
    type Draft,
    type Item,
    type Kind,
  } from "./sink";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    sink,
    names,
    onreveal,
  }: {
    widget: Widget;
    sink: Sink;
    /** Conversation id → what that card is called, so an item says who found it
     *  in the words on the card. Most of a long-lived sink was dropped by cards
     *  that have since closed, which `finder` answers for. */
    names: Map<string, string>;
    /** Go and look at the card holding this one. */
    onreveal?: (id: string) => void;
  } = $props();

  const now = $derived(clock.t);
  const kind = $derived(textOf(widget, "showing", "all") as Kind | "all");
  const variant = $derived(variantOf(widget));

  $effect(() => {
    sink.attach(widget.id);
  });
  $effect(() => () => sink.detach(widget.id));

  /* Which half you are looking at. Not a widget parameter: it is a glance you
     take and put back, not a way you want this instrument set up — a config knob
     would persist "showing the settled list" across a launch, which is nobody's
     idea of what a sink is for. */
  let past = $state(false);
  const shown = $derived(pile(past ? sink.settled : sink.items, kind));
  /* `pile` puts what nobody is on first and the longest-waiting first within
     that, so the head of it is exactly the thing this reading exists to show —
     no second ordering, and the two variants cannot disagree about which item is
     next. */
  const next = $derived(shown[0] ?? null);

  let open = $state<string | null>(null);

  let drafting = $state(false);
  let title = $state("");
  let bodyText = $state("");
  /* Your item is as expressive as an agent's or it is a second-class row in a
     table you own. The kind is the one field of the four an agent may set that
     you cannot infer from what you typed — the paths you would rather name in
     the body, and the scope is settled below. */
  let draftKind = $state<Kind>("note");

  async function put() {
    const t = title.trim();
    if (!t) return;
    /* Wall-wide, for the billboard's reason: something you write by hand is not
       standing in any one project — you are. */
    await sink.add(t, bodyText.trim() || t, draftKind, [], null);
    title = "";
    bodyText = "";
    draftKind = "note";
    drafting = false;
  }

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      drafting = false;
      e.stopPropagation();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void put();
    }
  }

  /* One glyph per kind, and none of them is a colour. `bug` is the only one that
     could argue for rust, and it would be wrong: a bug in the sink is a bug
     nothing is currently going wrong about. */
  const GLYPH: Record<Kind, string> = { bug: "!", idea: "*", chore: "·", note: "–" };

  /* Which item you are rewording, and what the fields hold. One at a time,
     because it is a form and there is one of you. */
  let editing = $state<string | null>(null);
  let draft = $state<Draft>({ title: "", body: "", kind: "note", paths: "" });
  /* Why the last save did not happen, drawn beside the editor rather than in
     `sink.fault` — which replaces the whole pile, and would take the paragraph
     you just wrote with it. `Sink.edit` returns the complaint for this reason. */
  let snag = $state<string | null>(null);

  function begin(i: Item) {
    editing = i.id;
    snag = null;
    draft = opening(i);
  }

  function cancel() {
    editing = null;
    snag = null;
  }

  async function save(i: Item) {
    const e = proposed(draft);
    const no = refusal(e);
    if (no) {
      snag = no;
      return;
    }
    /* Nothing moved, so nothing is written — opening an item to read it must not
       stamp it as reworded. See `moved` in `sink.ts`. */
    if (!moved(i, e)) {
      cancel();
      return;
    }
    snag = await sink.edit(i.id, e);
    if (!snag) editing = null;
  }

  /* Escape gives up, and stops there rather than reaching the wall's own ladder.
     Ctrl+Enter saves from anywhere in the form; plain Enter saves from the title,
     where it has nothing else to mean — in the body it is a newline, because a
     body written for somebody months from now has paragraphs in it. */
  function editKey(e: KeyboardEvent, i: Item, single = false) {
    if (e.key === "Escape") {
      cancel();
      e.stopPropagation();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (single && !e.shiftKey))) {
      e.preventDefault();
      void save(i);
    }
  }
</script>

<!-- The editor. One markup for both readings, since a list row and the opened-out
     `next` are two ways of showing an item and only one way of changing it. -->
{#snippet editor(i: Item)}
  <div class="draft edit">
    <input
      class="title"
      bind:value={draft.title}
      placeholder="the thing, in one line"
      spellcheck="false"
      onkeydown={(e) => editKey(e, i, true)}
    />
    <textarea
      class="body"
      bind:value={draft.body}
      placeholder="what somebody picking this up needs"
      onkeydown={(e) => editKey(e, i)}
    ></textarea>
    <input
      class="globs"
      bind:value={draft.paths}
      placeholder="files it is about, comma separated"
      spellcheck="false"
      onkeydown={(e) => editKey(e, i, true)}
    />
    <div class="kinds">
      {#each KINDS as k (k)}
        <button
          class="kind"
          class:on={draft.kind === k}
          onclick={() => (draft.kind = k)}
          onkeydown={(e) => editKey(e, i)}>{k}</button
        >
      {/each}
    </div>
    {#if snag}<p class="snag">{snag}</p>{/if}
    <div class="verbs">
      <button class="verb" onclick={() => void save(i)}>save</button>
      <button class="verb" onclick={cancel}>leave it</button>
    </div>
  </div>
{/snippet}

<div class="sink">
  <header>
    <span class="what">{past ? "settled" : "sink"}</span>
    <button
      class="flip"
      title={past ? "Back to what is pending" : "What has already been dealt with"}
      onclick={() => {
        past = !past;
        open = null;
        cancel();
      }}>{past ? "pending" : "settled"}</button
    >
    <span class="tot">{shown.length}</span>
    <button class="add" title="Leave something in the sink yourself" onclick={() => (drafting = !drafting)}
      >+</button
    >
  </header>

  {#if drafting}
    <!-- Two fields, for the billboard's reason: a title on its own is a thing
         nobody will be able to act on in a month, which is the whole span this
         table is built for. -->
    <div class="draft">
      <input
        class="title"
        bind:value={title}
        placeholder="the thing, in one line"
        spellcheck="false"
        onkeydown={key}
      />
      <textarea
        class="body"
        bind:value={bodyText}
        placeholder="what somebody picking this up needs — enter to drop it in"
        onkeydown={key}
      ></textarea>
      <!-- Four buttons rather than a select: the whole vocabulary is four words
           and a dropdown would hide three of them behind a click. Achromatic —
           a kind is a filing decision, and this wall's colour is status. -->
      <div class="kinds">
        {#each KINDS as k (k)}
          <button
            class="kind"
            class:on={draftKind === k}
            onclick={() => (draftKind = k)}
            onkeydown={key}>{k}</button
          >
        {/each}
      </div>
    </div>
  {/if}

  {#if sink.fault}
    <p class="note fault">{sink.fault}</p>
  {:else if shown.length === 0}
    <p class="note">
      {sink.read === 0 ? "reading…" : nothing(kind, past)}{#if !past && sink.read > 0}. agents
        leave things here that they noticed and could not stop for.{/if}
    </p>
  {:else if variant === "next" && next}
    <!-- One thing, opened out. Everything a row's detail carries, at reading
         size, with the count of what is behind it — a sink that showed one item
         and did not say there were nine more would be an instrument quietly
         understating the wall. -->
    <div class="one">
      {#if editing === next.id}
        {@render editor(next)}
      {:else}
        <p class="head">{next.title}</p>
        <p class="prose">{next.body}</p>
        {#if about(next)}<p class="files">{about(next)}</p>{/if}
        <p class="whence">
          {next.kind} · dropped by {finder(next, names)}, {waiting(next, now)} ago{#if next.voices > 1}
            · {next.voices} conversations have met it{/if}{#if next.editedAt !== null && next.from}
            · you have reworded it since{/if}{#if stateOf(next) === "lapsed"}
            · {holder(next, names)} took it and let it lapse{/if}
        </p>
        <div class="verbs">
          <button
            class="verb"
            onclick={() => void (past ? sink.restore(next.id) : sink.settle(next.id))}
            >{past ? "put it back" : "settled"}</button
          >
          {#if editable(next)}
            <button class="verb" onclick={() => begin(next)}>reword</button>
          {/if}
          {#if next.heldBy}
            <button class="verb" onclick={() => void sink.release(next.id)}>free the hold</button>
          {/if}
          <button class="verb bin" onclick={() => void sink.remove(next.id)}>throw away</button>
        </div>
      {/if}
      {#if shown.length > 1}
        <p class="behind">{shown.length - 1} more behind it</p>
      {/if}
    </div>
  {:else}
    <ul class="rows">
      {#each shown as i (i.id)}
        {@const state = stateOf(i)}
        {@const who = finder(i, names)}
        {@const on = holder(i, names)}
        {@const files = about(i)}
        <li class:held={state === "held"} class:lapsed={state === "lapsed"} class:open={open === i.id}>
          <!-- Not while you are rewording it: closing the detail unmounts the
               editor, and losing a paragraph to a stray click on its own heading
               is the sort of thing you only forgive once. -->
          <button
            class="row"
            title={i.body}
            onclick={() => {
              if (editing !== i.id) open = open === i.id ? null : i.id;
            }}
          >
            <span class="glyph">{GLYPH[i.kind]}</span>
            <span class="label">{i.title}</span>
            {#if i.voices > 1}<span class="voices" title="{i.voices} conversations have met this"
                >×{i.voices}</span
              >{/if}
            {#if state === "held"}<span class="who">{on}</span>{/if}
            <span class="when">{waiting(i, now)}</span>
          </button>
          {#if past}
            <button
              class="off"
              title="Put this back — it was not actually finished"
              aria-label="Put this back"
              onclick={() => void sink.restore(i.id)}>↺</button
            >
          {:else}
            <button
              class="off"
              title="Settle this — it has been dealt with"
              aria-label="Settle this"
              onclick={() => void sink.settle(i.id)}>✓</button
            >
          {/if}
          {#if open === i.id}
            <div class="detail">
              {#if editing === i.id}
                {@render editor(i)}
              {:else}
                <p>{i.body}</p>
                {#if files}<p class="files">{files}</p>{/if}
                <p class="whence">
                  {i.kind} · dropped by {who}, {waiting(i, now)} ago{#if i.editedAt !== null && i.from}
                    · you have reworded it since{/if}{#if i.settledNote}
                    · settled: {i.settledNote}{/if}
                </p>
                {#if state === "lapsed"}
                  <p class="aged">
                    {holder(i, names)} took this and has not touched it since — free for
                    anybody to pick up
                  </p>
                {/if}
                <div class="verbs">
                  {#if editable(i)}
                    <button class="verb" onclick={() => begin(i)}>reword</button>
                  {/if}
                  {#if held(i) && i.heldBy && onreveal}
                    <button class="verb" onclick={() => onreveal?.(i.heldBy!)}>go to {on}</button>
                  {/if}
                  {#if i.heldBy}
                    <button class="verb" onclick={() => void sink.release(i.id)}>free the hold</button
                    >
                  {/if}
                  {#if !past && i.from && names.has(i.from) && onreveal}
                    <button class="verb" onclick={() => onreveal?.(i.from!)}>go to {who}</button>
                  {/if}
                  <button class="verb bin" onclick={() => void sink.remove(i.id)}>throw away</button>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sink {
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
  .flip,
  .add {
    background: none;
    border: none;
    padding: 0 0.2rem;
    color: var(--paper-faint);
    cursor: pointer;
    font-family: var(--util);
    line-height: 1;
  }
  .flip {
    font-size: 0.6rem;
  }
  .add {
    font-size: 0.8rem;
    color: var(--paper-mute);
  }
  .flip:hover,
  .add:hover {
    color: var(--paper);
  }

  .draft {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.3rem 0.2rem;
    border-bottom: 1px solid var(--edge);
  }
  .draft input,
  .draft textarea {
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.22rem 0.34rem;
    resize: none;
  }
  .draft textarea {
    min-height: 2.4rem;
  }
  .kinds {
    display: flex;
    gap: 0.24rem;
  }
  .kind {
    flex: 1;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0;
    color: var(--paper-faint);
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.58rem;
  }
  .kind:hover {
    color: var(--paper);
  }
  .kind.on {
    color: var(--paper);
    border-color: var(--rule);
  }
  .draft input:focus,
  .draft textarea:focus {
    outline: none;
    border-color: var(--rule);
  }

  /* The editor is the draft form, in place of the item rather than above the
     pile — so no rule under it, and no padding fighting the row it sits in. */
  .draft.edit {
    padding: 0.1rem 0 0.2rem;
    border-bottom: none;
  }
  /* Amber: nothing is broken, but this did not go through and you should look.
     Not rust — the wall's rust is for something that failed, and the commonest
     reason to see this is somebody having taken the item while you typed, which
     is the wall working correctly. */
  .snag {
    margin: 0;
    font-size: 0.6rem;
    line-height: 1.4;
    color: var(--st-soft);
  }

  .note {
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.68rem;
    color: var(--paper-faint);
    line-height: 1.4;
  }
  .fault {
    color: var(--st-fail);
  }

  /* The `next` reading. Larger than a row on purpose — this is a thing to read
     rather than a thing to scan — and scrollable, since a body written for
     somebody months from now is longer than any box you would hang. */
  .one {
    display: flex;
    flex-direction: column;
    gap: 0.24rem;
    padding: 0.4rem 0.3rem;
    overflow-y: auto;
    min-height: 0;
  }
  .head {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.35;
    color: var(--paper);
  }
  .prose {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-dim);
    white-space: pre-wrap;
  }
  .behind {
    margin: 0.1rem 0 0;
    font-size: 0.6rem;
    color: var(--paper-faint);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0.2rem 0 0;
    overflow-y: auto;
    min-height: 0;
  }
  .rows li {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: start;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    width: 100%;
    background: none;
    border: none;
    padding: 0.12rem 0.2rem;
    text-align: left;
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-dim);
    overflow: hidden;
  }
  .row:hover {
    color: var(--paper);
  }

  /* Achromatic, and one character wide. A kind is a filing decision rather than
     a state, and the wall's colours are reserved for states. */
  .glyph {
    flex: 0 0 auto;
    width: 1ch;
    text-align: center;
    color: var(--paper-faint);
    font-family: var(--mono);
    font-size: 0.62rem;
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .voices,
  .who,
  .when {
    flex: 0 0 auto;
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  /* The two colours, and both are the wall's own. Celadon: a conversation is
     alive on this. Amber: a hold nobody has honoured — nothing is broken, but
     somebody should look, which is precisely what this wall's amber means. */
  li.held .label,
  li.held .who {
    color: var(--st-work);
  }
  li.lapsed .label {
    color: var(--st-soft);
  }

  .off {
    background: none;
    border: none;
    padding: 0 0.34rem;
    color: transparent;
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.7;
  }
  li:hover .off {
    color: var(--paper-faint);
  }
  .off:hover {
    color: var(--st-work);
  }

  .detail {
    grid-column: 1 / -1;
    padding: 0.1rem 0.2rem 0.4rem 1.2ch;
    font-size: 0.66rem;
    line-height: 1.5;
    color: var(--paper-dim);
  }
  .detail p {
    margin: 0 0 0.2rem;
    white-space: pre-wrap;
  }
  .files {
    color: var(--paper-faint);
    font-family: var(--mono);
    font-size: 0.6rem;
  }
  .whence {
    color: var(--paper-faint);
    font-size: 0.6rem;
  }
  .aged {
    color: var(--st-soft);
  }

  .verbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding-top: 0.1rem;
  }
  .verb {
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0.4rem;
    color: var(--paper-mute);
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.6rem;
  }
  .verb:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .bin:hover {
    color: var(--st-fail);
    border-color: var(--st-fail);
  }
</style>
