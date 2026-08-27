<script lang="ts">
  /* The billboard, hung on the wall.
   *
   * Standing notices the agents have put up about work in progress. Everything
   * it knows is `board.ts` and tested — the ordering, the ages, what a notice
   * is about — and everything it *does* is two calls in `board.svelte.ts`.
   *
   * Three things about it are deliberate:
   *
   * - **A notice can be taken down from here, and posting one is allowed.**
   *   Unlike the pipelines and reviews faces, which are read-only on purpose,
   *   both halves belong to you. Taking one down is the gesture that keeps the
   *   board worth reading and is the one an agent might have forgotten; putting
   *   one up is the only instruction on this wall that reaches every agent
   *   without costing any of them a turn.
   *
   * - **Stale is drawn, never hidden.** A long refactor is a real thing and a
   *   notice that is still true should not disappear because it is old. What
   *   the mark says is "ask whether this still holds", which is a question for
   *   you rather than a decision this face gets to make.
   *
   * - **Colour is status, so the only colour here is the stale mark** — amber,
   *   the wall's "something wants attention", which is exactly what an old
   *   notice is. A current notice is achromatic like the rest of the chrome.
   */

  import { clock } from "./conversation.svelte";
  import type { Board } from "./board.svelte";
  import { author, covering, isEmpty, reading, since, type Notice } from "./board";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    board,
    names,
    onreveal,
  }: {
    widget: Widget;
    board: Board;
    /** Conversation id → what that card is called, so a notice says who put it
     *  up in the words on the card rather than in eight characters of hex. */
    names: Map<string, string>;
    /** Go and look at the card that posted this one. */
    onreveal?: (id: string) => void;
  } = $props();

  const now = $derived(clock.t);
  const showing = $derived(textOf(widget, "showing", "all"));
  const variant = $derived(variantOf(widget));

  $effect(() => {
    board.attach(widget.id);
  });
  $effect(() => () => board.detach(widget.id));

  const shown = $derived(
    reading(board.notices).filter((n) => showing !== "current" || !n.stale),
  );
  const hidden = $derived(board.notices.length - shown.length);

  /* Open on the notice you clicked, closed otherwise — a board is a glance
     first, and the body is what you want once one of them concerns you. The
     `notes` reading opens all of them and the click then closes one, which is
     the same state read the other way round rather than a second mechanism. */
  let open = $state<string | null>(null);
  const opened = (id: string) => (variant === "notes" ? open !== id : open === id);

  let drafting = $state(false);
  let subject = $state("");
  let bodyText = $state("");

  async function put() {
    const s = subject.trim();
    if (!s) return;
    /* Posted to the whole wall, because a notice you write by hand is not
       standing in any one project — you are. */
    /* Kept if it did not land. A notice over the caps is refused rather than
       clipped — see `board.rs::clip` for why yours is and a card's is not —
       and clearing the field on the way to a fault would lose the only copy
       of what you wrote to a length limit. `board.fault` says what was over. */
    if (!(await board.post(s, bodyText.trim() || s, [], null))) return;
    subject = "";
    bodyText = "";
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
</script>

<div class="board">
  <header>
    <span class="what">billboard</span>
    {#if hidden > 0}<span class="tot">{hidden} hidden</span>{/if}
    <span class="tot">{board.notices.length}</span>
    <button
      class="add"
      title="Put up a notice of your own"
      onclick={() => (drafting = !drafting)}>+</button
    >
  </header>

  {#if drafting}
    <!-- Deliberately two fields rather than one. A notice with only a subject
         says what somebody is doing and not what to do about it, which is the
         half that makes it worth reading. -->
    <div class="draft">
      <input
        class="subject"
        bind:value={subject}
        placeholder="what this is about"
        spellcheck="false"
        onkeydown={key}
      />
      <textarea
        class="body"
        bind:value={bodyText}
        placeholder="what you want them to do — enter to post"
        onkeydown={key}
      ></textarea>
    </div>
  {/if}

  {#if board.fault}
    <p class="note fault">{board.fault}</p>
  {:else if isEmpty(shown)}
    <p class="note">
      {board.read === 0
        ? "reading…"
        : hidden > 0
          ? "nothing current — everything up here has gone stale"
          : "nothing up. agents post here when they take on a piece of work."}
    </p>
  {:else}
    <ul class="rows">
      {#each shown as n (n.id)}
        {@const who = author(n, names)}
        {@const files = covering(n)}
        <li class:stale={n.stale} class:open={opened(n.id)}>
          <button
            class="row"
            title={n.body}
            onclick={() => (open = opened(n.id) === (variant === "notes") ? n.id : null)}
          >
            <span class="mark" class:wall={n.scope === "skein"}></span>
            <span class="label">{n.subject}</span>
            <span class="who">{who}</span>
            <span class="when">{since(n, now)}</span>
          </button>
          <button
            class="off"
            title="Take this notice down"
            aria-label="Take this notice down"
            onclick={() => void board.unpost(n.id)}>×</button
          >
          {#if opened(n.id)}
            <div class="detail">
              <p>{n.body}</p>
              {#if files}<p class="files">{files}</p>{/if}
              {#if n.stale}
                <p class="aged">
                  up {since(n, now)} without being touched — worth asking whether it
                  still holds
                </p>
              {/if}
              {#if n.from && onreveal}
                <button class="goto" onclick={() => onreveal?.(n.from!)}
                  >go to {who}</button
                >
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .board {
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
  .add {
    background: none;
    border: none;
    padding: 0 0.2rem;
    color: var(--paper-mute);
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.8rem;
    line-height: 1;
  }
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
  .draft input:focus,
  .draft textarea:focus {
    outline: none;
    border-color: var(--rule);
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

  /* A notice is a pin in a board. Hollow for one posted to a single project,
     filled for one posted to the whole wall — the difference is how far it
     reaches, which is the only thing about a notice you cannot read off its
     words. Achromatic: colour on this wall is status, and "up" is not one. */
  .mark {
    flex: 0 0 auto;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    border: 1px solid var(--paper-faint);
    transform: translateY(-1px);
  }
  .mark.wall {
    background: var(--paper-faint);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who,
  .when {
    flex: 0 0 auto;
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  /* The one colour on this face, and it is the wall's own "wants attention".
     An old notice is not broken and is not working — it is a question. */
  li.stale .label {
    color: var(--st-soft);
  }
  li.stale .mark {
    border-color: var(--st-soft);
  }

  .off {
    background: none;
    border: none;
    padding: 0 0.34rem;
    color: transparent;
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.72rem;
    line-height: 1.7;
  }
  li:hover .off {
    color: var(--paper-faint);
  }
  .off:hover {
    color: var(--st-fail);
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
  .aged {
    color: var(--st-soft);
  }
  .goto {
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0.4rem;
    color: var(--paper-mute);
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.6rem;
  }
  .goto:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
</style>
