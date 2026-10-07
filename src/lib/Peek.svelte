<script lang="ts">
  /* The peek: what Skein shows when it isn't the window you're looking at.
   *
   * Deliberately not an OS notification. A Windows toast would be the one part
   * of this app wearing somebody else's design — grey, square, and gone before
   * you've read it. This is a small always-on-top window drawn in the studio's
   * own language, and clicking it takes you straight to the card. */

  import { emit, listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";

  type Item = {
    id: string;
    project: string;
    title: string;
    kind: "blocked" | "notice" | "overdue" | "failed" | "rang";
    detail: string;
    waitedSeconds: number;
  };

  let items = $state<Item[]>([]);
  let showing = $state(false);

  listen<{ items: Item[] }>("peek:set", (e) => {
    items = e.payload.items;
    showing = items.length > 0;
  });

  function go(item: Item) {
    void emit("peek:goto", { id: item.id });
  }

  function dismiss() {
    void emit("peek:dismiss", {});
    void getCurrentWindow().hide();
  }

  /* "Things" rather than "cards": a timer that has run out is in this list too,
     and it is not a card. Worth the small loss of specificity — the alternative
     is counting the two kinds apart to build a sentence nobody reads that
     closely, and getting it wrong the first time a wall has one of each. */
  const headline = $derived(
    items.length === 0
      ? ""
      : items.length === 1
        ? "One thing wants you"
        : `${items.length} things want you`,
  );

  function waited(s: number): string {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }
</script>

<div class="peek" class:in={showing}>
  <header class="top" data-tauri-drag-region>
    <span class="mark">{headline}</span>
    <span class="grow" data-tauri-drag-region></span>
    <button class="x" onclick={dismiss} aria-label="Dismiss">
      <svg viewBox="0 0 10 10" aria-hidden="true"
        ><path d="M2 2l6 6M8 2L2 8" /></svg
      >
    </button>
  </header>

  <div class="list">
    {#each items.slice(0, 3) as item (item.id)}
      <button class="row" data-kind={item.kind} onclick={() => go(item)}>
        <span class="dot"></span>
        <span class="body">
          <span class="who"><b>{item.project}</b> {item.title}</span>
          <span class="detail">{item.detail}</span>
        </span>
        <span class="age">{waited(item.waitedSeconds)}</span>
      </button>
    {/each}
    {#if items.length > 3}
      <div class="more">and {items.length - 3} more</div>
    {/if}
  </div>
</div>

<style>
  .peek {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: var(--ink);
    border: 1px solid color-mix(in srgb, var(--st-ask) 40%, var(--edge));
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    overflow: hidden;
    /* The bloom that means "waiting on you", carried onto the desktop. */
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.4),
      0 18px 50px -18px rgba(0, 0, 0, 0.85),
      0 6px 40px -20px rgba(233, 161, 59, 0.9);

    opacity: 0;
    transform: translateY(8px);
    transition:
      opacity 0.28s ease,
      transform 0.34s cubic-bezier(0.32, 0.72, 0.3, 1);
  }
  .peek.in {
    opacity: 1;
    transform: none;
  }

  .top {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    user-select: none;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--st-ask);
  }
  .grow {
    flex: 1 1 auto;
  }
  .x {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    border-radius: 3px;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .x svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .x:hover {
    color: var(--paper);
    background: var(--raised);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 0.32rem;
    overflow: hidden;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background 0.15s ease;
  }
  .row:hover {
    background: var(--raised);
    border-color: var(--rule);
  }

  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st-rest);
  }
  .row[data-kind="blocked"] .dot {
    background: var(--st-ask);
  }
  .row[data-kind="overdue"] .dot {
    background: var(--st-soft);
  }
  .row[data-kind="failed"] .dot {
    background: var(--st-fail);
  }
  /* The same amber a blocked card gets, deliberately: both are waiting to be
     noticed, which is the whole of what the colour means here. The two are told
     apart by what they say, not by a hue invented to keep them separate. */
  .row[data-kind="rang"] .dot {
    background: var(--st-ask);
  }

  .body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .who {
    font-family: var(--display);
    font-size: 0.82rem;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who b {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--paper-faint);
    margin-right: 0.35rem;
  }
  .detail {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .age {
    flex: 0 0 auto;
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  .more {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    padding-left: 0.2rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .peek {
      transition: none;
    }
  }
</style>
