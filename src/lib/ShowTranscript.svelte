<script lang="ts">
  /* The same turn, twice: what the CLI writes to stdout, and what the card
   * draws from it.
   *
   * The left half is deliberately unpleasant to read. That is the argument.
   * The right half reuses the real markdown renderer, so the prose is not a
   * mock-up of a transcript; it is the component the panel uses, given the
   * same kind of input.
   */
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { CARD_PROSE, CARD_PROSE_AFTER, CARD_RUN, TERMINAL_LINES } from "./showcase";

  let open = $state(false);
  let diffAt = $state<number | null>(3);

  const before = $derived(parseMarkdown(CARD_PROSE));
  const after = $derived(parseMarkdown(CARD_PROSE_AFTER));

  const summary = $derived(
    `${CARD_RUN.length} calls · ${new Set(CARD_RUN.filter((c) => c.tool === "Read").map((c) => c.subject)).size} files · 1 test run`,
  );
</script>

<div class="pair">
  <section class="half raw">
    <header class="head">
      <span class="tag">stdout</span>
      <span class="cmd">claude -p "the retry path double-writes" --output-format stream-json</span>
    </header>
    <pre class="tape" aria-label="the raw event stream">{#each TERMINAL_LINES as line, i (i)}{line}
{/each}</pre>
    <p class="caveat">one JSON object per line, in arrival order. The prose is in there; so is every tool result, the cost, and the session id.</p>
  </section>

  <section class="half drawn">
    <header class="head">
      <span class="tag">the card</span>
      <span class="meta">opus 5.5 · turn 2</span>
    </header>

    <div class="column">
      <p class="you">the retry path double-writes under load. fix it and run the suite.</p>

      <div class="md prose"><Markdown blocks={before} nav={false} /></div>

      <button class="run" type="button" data-tour-focus aria-expanded={open} onclick={() => (open = !open)}>
        <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span class="word">{summary}</span>
        <span class="last">{CARD_RUN[CARD_RUN.length - 1].tool} · {CARD_RUN[CARD_RUN.length - 1].subject}</span>
      </button>

      {#if open}
        <div class="calls">
          {#each CARD_RUN as c, i (c.subject + c.tool)}
            <div class="call">
              {#if c.diff}
                <button class="callhead" type="button" aria-expanded={diffAt === i} onclick={() => (diffAt = diffAt === i ? null : i)}>
                  <span class="tool">{c.tool}</span>
                  <span class="subject">{c.subject}</span>
                  <span class="result">{c.result}</span>
                </button>
                {#if diffAt === i}
                  <div class="diff">
                    {#each c.diff as d (d.text)}
                      <div class="row" data-sign={d.sign}><span class="mark">{d.sign}</span><code>{d.text}</code></div>
                    {/each}
                  </div>
                {/if}
              {:else}
                <div class="callhead static">
                  <span class="tool">{c.tool}</span>
                  <span class="subject">{c.subject}</span>
                  <span class="result">{c.result}</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="md prose"><Markdown blocks={after} nav={false} /></div>

      <p class="foot">4 files read, one edited, the suite run. Folded until you ask, so a round of thirty calls still reads as a conversation.</p>
    </div>
  </section>
</div>

<style>
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 900px) {
    .pair {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .half {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    overflow: hidden;
    background: var(--ink);
    min-height: 360px;
  }
  .raw {
    background: linear-gradient(180deg, color-mix(in oklab, var(--well) 100%, var(--paper) 2%), var(--well));
  }
  .drawn {
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
  }
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 13px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 65%, transparent);
    min-width: 0;
  }
  .tag {
    flex: none;
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .cmd,
  .meta {
    font-size: 10.5px;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cmd {
    font-family: var(--mono);
    color: var(--paper-mute);
  }
  .meta {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .tape {
    margin: 0;
    padding: 12px 13px 16px;
    max-height: 322px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.62;
    color: color-mix(in oklab, var(--paper-mute) 88%, transparent);
    white-space: pre;
  }
  .caveat {
    margin: 0;
    padding: 10px 13px 14px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
    font-size: 11px;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: 13px;
    padding: 15px 16px 18px;
    --tx-size: 0.95rem;
    --tx-leading: 1.62;
    --tx-prose: var(--paper-dim);
  }
  .prose {
    font-family: var(--body);
    font-size: var(--tx-size, 0.95rem);
    line-height: var(--tx-leading, 1.62);
    color: var(--tx-prose, var(--paper-dim));
  }
  .you {
    align-self: flex-end;
    max-width: 88%;
    margin: 0;
    padding: 7px 11px;
    border-radius: 10px 10px 3px 10px;
    background: var(--raised);
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    color: var(--paper);
    font-family: var(--body);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .run {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 7px 9px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    background: color-mix(in oklab, var(--well) 55%, transparent);
    color: var(--paper-mute);
    font: inherit;
    font-family: var(--mono);
    font-size: 10.5px;
    text-align: left;
    cursor: pointer;
  }
  .run:hover {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 18%);
    color: var(--paper-dim);
  }
  .chev {
    flex: none;
    color: var(--paper-faint);
  }
  .word {
    flex: none;
  }
  .last {
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper-faint);
  }
  .calls {
    display: grid;
    gap: 3px;
    padding: 3px 0 3px 12px;
    border-left: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    margin-left: 7px;
  }
  .call {
    display: grid;
    gap: 3px;
  }
  .callhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    font: inherit;
    font-family: var(--mono);
    font-size: 10.5px;
    text-align: left;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .callhead.static {
    cursor: default;
  }
  .callhead:not(.static):hover {
    background: color-mix(in oklab, var(--raised) 60%, transparent);
    color: var(--paper-dim);
  }
  .tool {
    flex: none;
    color: var(--paper-faint);
    min-width: 44px;
  }
  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper-dim);
  }
  .result {
    margin-left: auto;
    flex: none;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .diff {
    margin: 2px 0 6px 8px;
    border-radius: 6px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    overflow: hidden;
    background: var(--well);
  }
  .row {
    display: flex;
    gap: 8px;
    padding: 1px 8px;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.65;
    color: var(--paper-mute);
    white-space: pre;
  }
  /* Achromatic, as the panel's own diff is: a diff's two sides are not a
     status, and colour on this wall means status. The gutter mark carries the
     meaning, and the wash is light for a line added and shade for one removed,
     which is how a printed diff has always done it. */
  .row[data-sign="+"] {
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    color: var(--paper);
  }
  .row[data-sign="-"] {
    background: color-mix(in oklab, var(--shade, #000) 30%, transparent);
    color: var(--paper-mute);
  }
  .mark {
    flex: none;
    width: 8px;
    color: var(--paper-faint);
  }
  .row code {
    font: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .foot {
    margin: 2px 0 0;
    font-size: 11px;
    line-height: 1.55;
    color: var(--paper-faint);
  }
</style>
