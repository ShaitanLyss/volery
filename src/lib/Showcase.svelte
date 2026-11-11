<script lang="ts">
  /* The tour itself: a rail, a chapter, and the one demo that chapter is
   * about.
   *
   * It is an overlay rather than a page because the wall has nowhere to put a
   * document, and because the thing being demonstrated is what is behind it.
   * It closes on Escape and never on a stray click: a presentation is one
   * long sequence of clicks, and a scrim that dismisses on any of them is a
   * tour somebody loses halfway through.
   *
   * The keyboard is the wall's, reduced to the four keys a talk needs. Every
   * verb here also has a mouse path, because the room will not all be at a
   * keyboard.
   */
  import { onDestroy, untrack } from "svelte";
  import ShowAsk from "./ShowAsk.svelte";
  import ShowCompare from "./ShowCompare.svelte";
  import ShowDesk from "./ShowDesk.svelte";
  import ShowNext from "./ShowNext.svelte";
  import ShowRelay from "./ShowRelay.svelte";
  import ShowSecurity from "./ShowSecurity.svelte";
  import ShowTabs from "./ShowTabs.svelte";
  import ShowTranscript from "./ShowTranscript.svelte";
  import ShowWall from "./ShowWall.svelte";
  import { CHAPTERS, chapterIndex, nextChapter, previousChapter, progress, type ChapterId } from "./showcase";

  let { onclose, start = "why" }: { onclose: () => void; start?: ChapterId } = $props();

  let at = $state(untrack(() => chapterIndex(start)));
  let root = $state<HTMLElement>();
  let scroller = $state<HTMLElement>();

  /* Where the keyboard was before the tour took it, put back when the tour
     goes. Read here rather than in an effect because the effect below moves
     the focus a frame later, and the answer by then is the tour itself. */
  const cameFrom = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  onDestroy(() => cameFrom?.focus?.());

  const chapter = $derived(CHAPTERS[at] ?? CHAPTERS[0]);

  $effect(() => {
    root?.focus();
  });

  $effect(() => {
    void at;
    if (scroller) scroller.scrollTop = 0;
  });

  function go(n: number) {
    at = Math.min(CHAPTERS.length - 1, Math.max(0, n));
  }

  function key(e: KeyboardEvent) {
    /* A demo that has already answered this key owns it. The desk's arrow
     * keys and a question's number keys both call `preventDefault`, and
     * without this the tour would also move a chapter on the same press. */
    if (e.defaultPrevented) {
      e.stopPropagation();
      return;
    }
    /* Everything in here is the tour's while it is up, including the keys the
     * wall would otherwise use. The one exception is a key aimed at a control
     * the reader is on, which is the control's. */
    const on = e.target instanceof HTMLElement && e.target.closest("button, a, input, textarea, select");
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      at = nextChapter(at);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      at = previousChapter(at);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      go(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      go(CHAPTERS.length - 1);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      go(Number(e.key) - 1);
      return;
    }
    if ((e.key === " " || e.key === "Enter") && !on) {
      e.preventDefault();
      at = nextChapter(at);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="tour"
  role="dialog"
  aria-modal="true"
  aria-labelledby="tour-head"
  tabindex="-1"
  bind:this={root}
  onkeydown={key}
>
  <aside class="rail">
    <div class="brand">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="tour-markg" x1="0.15" y1="0.95" x2="0.9" y2="0.1">
            <stop offset="0" stop-color="var(--st-work)" />
            <stop offset="1" stop-color="var(--st-ask)" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--edge)" stroke-width="3.4" />
        <path d="M12 3.8a8.2 8.2 0 1 1-8 6.4" fill="none" stroke="url(#tour-markg)" stroke-width="3.4" stroke-linecap="round" />
      </svg>
      <span class="word">volery</span>
      <span class="tag">a tour</span>
    </div>

    <div class="kicker">chapters</div>
    <nav class="chapters" aria-label="chapters">
      {#each CHAPTERS as c, i (c.id)}
        <button type="button" class="ch" class:on={i === at} aria-current={i === at ? "step" : undefined} onclick={() => go(i)}>
          <span class="chno">{String(i + 1).padStart(2, "0")}</span>
          <span class="chword">{c.title}</span>
          <span class="chdot" aria-hidden="true"></span>
        </button>
      {/each}
    </nav>

    <div class="railfoot">
      <div class="pbar" aria-hidden="true"><span style:width={`${progress(at) * 100}%`}></span></div>
      <p class="keys"><kbd>&larr;</kbd><kbd>&rarr;</kbd> move &nbsp; <kbd>1</kbd> to <kbd>9</kbd> jump</p>
      <p class="keys"><kbd>esc</kbd> close</p>
    </div>
  </aside>

  <main class="main" bind:this={scroller}>
    <div class="stage">
      <div class="eyebrow">
        <span class="eno">{String(at + 1).padStart(2, "0")}</span>
        <span class="erule" aria-hidden="true"></span>
        <span class="etitle">{chapter.title}</span>
      </div>

      <h1 class="headline" id="tour-head">{chapter.head}</h1>
      <p class="lede">{chapter.lede}</p>
      {#if chapter.do}<p class="do"><span aria-hidden="true">&#9656;</span>{chapter.do}</p>{/if}

      {#key at}
        <div class="demo">
          {#if chapter.id === "why"}
            <ShowTabs />
          {:else if chapter.id === "wall"}
            <ShowWall />
          {:else if chapter.id === "card"}
            <ShowTranscript />
          {:else if chapter.id === "ask"}
            <ShowAsk />
          {:else if chapter.id === "relay"}
            <ShowRelay />
          {:else if chapter.id === "desk"}
            <ShowDesk />
          {:else if chapter.id === "compare"}
            <ShowCompare />
          {:else if chapter.id === "security"}
            <ShowSecurity />
          {:else}
            <ShowNext onclose={onclose} />
          {/if}
        </div>
      {/key}

      <div class="nav">
        <button type="button" class="ghost" onclick={() => (at = previousChapter(at))}>
          <span aria-hidden="true">&larr;</span>{at === 0 ? "the end" : CHAPTERS[previousChapter(at)].title}
        </button>
        <button type="button" class="primary" onclick={() => (at = nextChapter(at))}>
          {at === CHAPTERS.length - 1 ? "back to the beginning" : CHAPTERS[nextChapter(at)].title}<span aria-hidden="true">&rarr;</span>
        </button>
        <span class="count">{at + 1} / {CHAPTERS.length}</span>
      </div>
    </div>
  </main>
</div>

<style>
  .tour {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    grid-template-columns: 252px minmax(0, 1fr);
    color: var(--paper);
    font-family: var(--cv-ui, var(--util));
    font-size: 13.5px;
    background:
      var(--cv-grain, none),
      radial-gradient(60% 45% at 72% -8%, color-mix(in oklab, var(--paper) 9%, transparent), transparent 70%),
      radial-gradient(50% 40% at 12% 112%, color-mix(in oklab, var(--st-work) 6%, transparent), transparent 70%),
      var(--well);
    background-blend-mode: soft-light, normal, normal, normal;
    overflow: hidden;
    outline: none;
    animation: fade var(--dur-scene, 360ms) var(--ease-out, ease-out) both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .rail {
    border-right: 1px solid color-mix(in oklab, var(--edge) 72%, transparent);
    padding: 24px 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 42%, transparent), transparent 58%);
    min-height: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 9px 2px;
  }
  .mark {
    width: 21px;
    height: 21px;
    flex: none;
  }
  .word {
    font: 400 17px var(--display);
    color: var(--paper);
  }
  .tag {
    margin-left: auto;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-mute);
    padding-top: 3px;
  }
  .kicker {
    margin: 22px 9px 8px;
    font-size: 10.5px;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .chapters {
    display: grid;
    gap: 1px;
    overflow: auto;
    min-height: 0;
  }
  .ch {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 9px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.3;
    text-align: left;
    cursor: pointer;
    transition:
      background var(--dur-quick, 160ms) var(--ease-out, ease-out),
      color var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .ch:hover {
    color: var(--paper-dim);
    background: color-mix(in oklab, var(--raised) 45%, transparent);
  }
  .ch.on {
    color: var(--paper);
    background: linear-gradient(90deg, color-mix(in oklab, var(--surface) 92%, transparent), color-mix(in oklab, var(--surface) 30%, transparent));
    border-color: color-mix(in oklab, var(--edge) 60%, transparent);
  }
  .ch.on::before {
    content: "";
    position: absolute;
    left: 0;
    top: 9px;
    bottom: 9px;
    width: 2px;
    border-radius: 2px;
    background: var(--st-work);
  }
  .chno {
    flex: none;
    width: 16px;
    font-size: 9.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .ch.on .chno {
    color: var(--st-work);
  }
  .chword {
    min-width: 0;
  }
  .chdot {
    margin-left: auto;
    flex: none;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .ch.on .chdot {
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .railfoot {
    margin-top: auto;
    padding: 14px 9px 0;
    border-top: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
    display: grid;
    gap: 6px;
  }
  .pbar {
    height: 2px;
    border-radius: 2px;
    background: var(--rule);
    overflow: hidden;
  }
  .pbar span {
    display: block;
    height: 100%;
    background: color-mix(in oklab, var(--st-work) 75%, var(--paper-mute));
    transition: width var(--dur-step, 240ms) var(--ease-out, ease-out);
  }
  .keys {
    margin: 0;
    font-size: 10.5px;
    color: var(--paper-faint);
    line-height: 1.9;
  }
  kbd {
    font-family: var(--util);
    font-size: 9.5px;
    color: var(--paper-mute);
    padding: 1px 5px;
    margin-right: 2px;
    border-radius: 4px;
    border: 1px solid var(--edge);
    background: color-mix(in oklab, var(--surface) 55%, transparent);
  }
  .main {
    overflow: auto;
    padding: 40px 52px 56px;
    min-width: 0;
  }
  .stage {
    max-width: 980px;
    margin: 0 auto;
  }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 11px;
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .eno {
    color: var(--st-work);
    font-variant-numeric: tabular-nums;
  }
  .erule {
    width: 42px;
    height: 1px;
    background: var(--rule);
  }
  .headline {
    margin: 13px 0 0;
    font: 400 38px/1.14 var(--display);
    letter-spacing: -0.008em;
    color: var(--paper);
    max-width: 24ch;
  }
  .lede {
    margin: 12px 0 0;
    font: 15.5px/1.6 var(--body);
    color: var(--paper-dim);
    max-width: 64ch;
  }
  .do {
    margin: 10px 0 0;
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 11.5px;
    color: var(--paper-faint);
  }
  .demo {
    margin-top: 26px;
    animation: enter var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(7px);
    }
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 30px;
    padding-top: 16px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
  }
  .ghost,
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 13px;
    border-radius: 8px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    max-width: 38%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ghost {
    border: 1px solid color-mix(in oklab, var(--edge) 62%, transparent);
    background: transparent;
    color: var(--paper-mute);
  }
  .ghost:hover {
    color: var(--paper-dim);
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 16%);
  }
  .primary {
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
    color: var(--paper);
  }
  .primary:hover {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 26%);
  }
  .count {
    margin-left: auto;
    font-size: 11px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  @media (max-width: 880px) {
    .tour {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr);
    }
    .rail {
      border-right: 0;
      border-bottom: 1px solid color-mix(in oklab, var(--edge) 65%, transparent);
      padding: 14px 14px 8px;
    }
    .kicker,
    .railfoot {
      display: none;
    }
    .chapters {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .ch {
      flex: none;
      padding: 6px 9px;
    }
    .ch.on::before,
    .chdot {
      display: none;
    }
    .chword {
      white-space: nowrap;
    }
    .main {
      padding: 24px 20px 40px;
    }
    .headline {
      font-size: 30px;
    }
    .ghost {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tour,
    .demo {
      animation: none;
    }
  }
</style>
