<script lang="ts">
  /* What an id in prose opens: the thing it names, read where you are.
   *
   * A sink item, a billboard notice or a commit named in a transcript is a chip
   * (`Inlines.svelte`), and pressing one lands here — a sheet over whatever you
   * were doing, so the thread you were reading is still there under it when it
   * goes. Lyss, 2026-10-21: *"when I'm already on a conversation, clicking
   * should open a modal view over the conversation so that I don't lose the
   * thread"*. One sheet for the wall and for chat view, because what differs
   * between the two rooms is what *else* is on offer — chat view has a page for
   * each of these (`Pages`), and `onpage` is how a sheet says so — not what the
   * item is.
   *
   * It reads the stores the faces already read (`Sink`, `Board`) rather than
   * holding a copy, so an item settled while the sheet is open reads as settled.
   * Read-only on purpose: the verbs are the pile's and the board's own, and a
   * sheet reached from a sentence is a place to find out, which is cheaper than
   * a place to decide.
   *
   * Escape closes it and goes no further — Escape on this wall stops a card's
   * turn, and putting away a sheet must not also stop an agent. */
  import { onMount } from "svelte";
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { refText, type Ref } from "./refs";
  import { refs, type CommitDetail } from "./refs.svelte";
  import { ago } from "./gates";
  import { whois } from "./whois.svelte";
  import { clock } from "./conversation.svelte";
  import { stateOf, whence } from "./sink";
  import type { Sink } from "./sink.svelte";
  import type { Board } from "./board.svelte";

  let {
    reference,
    sink,
    board,
    onclose,
    onpage,
  }: {
    reference: Ref;
    sink: Sink;
    board: Board;
    onclose: () => void;
    /** Where this surface keeps a page for the thing, if it does: chat view's
     *  sink and board pages. Absent on the wall, whose face for them is the
     *  widget, found by hanging one up. */
    onpage?: (ref: Ref) => void;
  } = $props();

  /** The row behind a sink or notice chip. Reactive on the stores, so it is
   *  `undefined` until they have read and never stale after. */
  const item = $derived(
    reference.kind === "sink"
      ? [...sink.items, ...sink.settled].find((i) => i.id.startsWith(reference.key))
      : undefined,
  );
  const notice = $derived(
    reference.kind === "notice" ? board.notices.find((n) => n.id.startsWith(reference.key)) : undefined,
  );

  let detail = $state<CommitDetail | null | undefined>(undefined);

  onMount(() => {
    /* Attaching is what makes a store read at all (`Sink`'s bargain), and the
       sheet is somebody asking. A commit asks git once, on opening. */
    if (reference.kind === "sink") sink.attach("refsheet");
    if (reference.kind === "notice") board.attach("refsheet");
    if (reference.kind === "commit") void refs.detail(reference.root, reference.key).then((d) => (detail = d));
    sheet?.focus();
    return () => {
      sink.detach("refsheet");
      board.detach("refsheet");
    };
  });

  let sheet = $state<HTMLElement | null>(null);

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      onclose();
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(reference.kind === "commit" ? reference.short : reference.key);
    } catch {
      /* A clipboard that will not answer is not worth a fault bar here. */
    }
  }

  const body = $derived(
    reference.kind === "sink" ? (item?.body ?? "") : reference.kind === "notice" ? (notice?.body ?? "") : "",
  );
  const blocks = $derived(parseMarkdown(body));

  const when = (t: number) => ago(clock.t - t);
  const who = (id: string | null) => (id ? whois.name(id) : "you");

  const heading = $derived(
    reference.kind === "sink" ? "sink item" : reference.kind === "notice" ? "billboard notice" : "commit",
  );
</script>

<svelte:window onkeydown={key} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <div class="sheet" role="dialog" aria-label={refText(reference)} tabindex="-1" bind:this={sheet}>
    <header>
      <h2>{heading}</h2>
      {#if reference.kind === "sink" && item}
        <span class="kind">{item.kind}</span>
        <span class="state">{stateOf(item)}</span>
      {/if}
      <span class="grow"></span>
      <button
        type="button"
        class="ghost"
        title="copy {reference.kind === 'commit' ? reference.short : reference.key}, to paste to an agent"
        onclick={copyId}>copy id</button
      >
      {#if onpage}
        <button type="button" class="ghost" title="Open its page" onclick={() => onpage(reference)}>open page</button>
      {/if}
      <button type="button" class="ghost" aria-label="Close" onclick={onclose}>close</button>
    </header>

    <h3>{refText(reference)}</h3>

    {#if reference.kind === "sink"}
      {#if item}
        {#if body.trim()}
          <div class="md"><Markdown {blocks} nav={false} /></div>
        {:else}
          <p class="quiet">no body — the title is the whole of it.</p>
        {/if}
        <dl>
          <dt>filed</dt>
          <dd>
            {when(item.droppedAt)}{#if item.from} · by {who(item.from)}{/if}{#if whence(item, sink.here)} · on {whence(item, sink.here)}{/if}
          </dd>
          {#if item.voices > 1}
            <dt>voices</dt>
            <dd>{item.voices} cards have met it</dd>
          {/if}
          {#if item.heldBy}
            <dt>held</dt>
            <dd>by {who(item.heldBy)}{item.holdStale ? " — lapsed" : ""}</dd>
          {/if}
          {#if item.paths.length}
            <dt>files</dt>
            <dd class="mono">{item.paths.join("  ")}</dd>
          {/if}
          {#if item.settledAt !== null}
            <dt>settled</dt>
            <dd>{when(item.settledAt)}{item.settledNote ? ` — ${item.settledNote}` : ""}</dd>
          {/if}
        </dl>
      {:else}
        <p class="quiet">{sink.read > 0 ? "no longer in the sink — it may have been thrown away." : "reading the sink…"}</p>
      {/if}
    {:else if reference.kind === "notice"}
      {#if notice}
        {#if body.trim()}
          <div class="md"><Markdown {blocks} nav={false} /></div>
        {/if}
        <dl>
          <dt>posted</dt>
          <dd>
            {when(notice.postedAt)} · by {who(notice.from)}{#if notice.host} · on {notice.host}{/if}{notice.stale ? " · stale" : ""}
          </dd>
          {#if notice.paths.length}
            <dt>covers</dt>
            <dd class="mono">{notice.paths.join("  ")}</dd>
          {/if}
        </dl>
      {:else}
        <p class="quiet">{board.read > 0 ? "no longer on the board — it was taken down." : "reading the board…"}</p>
      {/if}
    {:else}
      <p class="by">
        {reference.author || "someone"}{#if reference.at > 0} · {new Date(reference.at * 1000).toLocaleString()}{/if}
      </p>
      {#if detail}
        {#if detail.body.replace(reference.subject, "").trim()}
          <pre class="plain">{detail.body}</pre>
        {/if}
        {#if detail.stat}
          <pre class="stat">{detail.stat}</pre>
        {/if}
      {:else if detail === null}
        <p class="quiet">git would not say any more about it.</p>
      {:else}
        <p class="quiet">reading the commit…</p>
      {/if}
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    /* The studio root is the containing block for anything fixed while the wall
       is spread, so a full-window catcher is sized off the span rather than
       `inset: 0`. See CLAUDE.md on `--span-*`. */
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    right: calc(-1 * var(--span-r, 0px));
    background: var(--scrim);
    display: grid;
    place-items: center;
    z-index: 92;
  }
  .sheet {
    width: min(44rem, 90cqw);
    max-height: 82cqh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1rem 1.3rem 1.1rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 6px;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .grow {
    flex: 1;
  }
  h2 {
    margin: 0;
    font-family: var(--util);
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .kind,
  .state {
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.35;
    color: var(--paper);
    overflow-wrap: anywhere;
  }
  .ghost {
    font-family: var(--util);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    padding: 0.18rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 999px;
    background: transparent;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .ghost:hover,
  .ghost:focus-visible {
    color: var(--paper);
    border-color: var(--paper-mute);
  }
  .md {
    font-size: 0.84rem;
    line-height: 1.55;
    color: var(--paper);
  }
  .quiet,
  .by {
    margin: 0;
    font-size: 0.76rem;
    color: var(--paper-faint);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0.2rem 0 0;
    font-size: 0.74rem;
  }
  dt {
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
    padding-top: 0.12rem;
  }
  dd {
    margin: 0;
    color: var(--paper-mute);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.7rem;
  }
  pre {
    margin: 0;
    padding: 0.55rem 0.7rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 0.72rem;
    line-height: 1.5;
    color: var(--paper-mute);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 18rem;
    overflow-y: auto;
  }
  pre.plain {
    font-family: inherit;
    font-size: 0.8rem;
    color: var(--paper);
  }
</style>
