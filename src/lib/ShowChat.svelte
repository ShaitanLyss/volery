<script lang="ts">
  /* Chat view, as the second presentation of the same wall.
   *
   * The point to draw is not that it looks like a chat app. It is that the
   * rows on the left are the same cards, the question at the foot is the same
   * parked question, and switching does not start or stop anything.
   */
  import CtxRing from "./CtxRing.svelte";
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";

  type Row = {
    id: string;
    title: string;
    project: string;
    age: string;
    state: "work" | "ask" | "rest" | "fail" | "idle";
    ctx: number;
  };

  const ROWS: readonly Row[] = [
    { id: "migration", title: "Split the billing migration", project: "portfolio", age: "now", state: "ask", ctx: 0.67 },
    { id: "sync", title: "Refactor the price sync to a queue", project: "portfolio", age: "2m", state: "work", ctx: 0.42 },
    { id: "invoices", title: "Reconcile the Q3 invoice batch", project: "paperwork", age: "4m", state: "work", ctx: 0.19 },
    { id: "notes", title: "Write the release notes for 0.104", project: "portfolio", age: "12m", state: "rest", ctx: 0.31 },
    { id: "assets", title: "Bump the asset pipeline to 5.6", project: "portfolio", age: "1h", state: "fail", ctx: 0.54 },
    { id: "article", title: "Summarise the HNSW article", project: "just chat", age: "3h", state: "idle", ctx: 0.08 },
  ];

  const THREADS: Record<string, { you: string; prose: string; doing?: string; ask?: boolean }> = {
    migration: {
      you: "split the billing migration",
      prose:
        "The split is ready, and the only thing left is the order. The billing table and the audit backfill touch the same rows, so one of them has to go first.",
      ask: true,
    },
    sync: {
      you: "make the retry path stop double-writing",
      prose:
        "The claim and the work are separate transactions now, and the retry wraps only the second one. The suite is green.",
      doing: "running the retry tests",
    },
    invoices: {
      you: "reconcile the Q3 batch against the bank export",
      prose: "I am reading the nine invoices that do not match a line in the export. Four look like timing.",
      doing: "reading 9 files",
    },
    notes: {
      you: "write the release notes for 0.104",
      prose:
        "The notes are written. I left out the analytics work from another card because its own note covers it, and I kept the two fixes that changed behaviour.",
    },
    assets: {
      you: "bump the asset pipeline to 5.6",
      prose:
        "I gave up. The plugin does not build against 5.6 and the error is in its own shader compiler, not in this repository. The card is stopped.",
    },
    article: {
      you: "summarise this HNSW article",
      prose: "Nothing said yet. This card is dormant and wakes when you send.",
    },
  };

  let selected = $state("migration");
  let answered = $state<string | null>(null);
  const row = $derived(ROWS.find((r) => r.id === selected) ?? ROWS[0]);
  const thread = $derived(THREADS[selected] ?? THREADS.migration);
  const prose = $derived(parseMarkdown(thread.prose));
</script>

<div class="chatmock">
  <header class="chead">
    <svg class="cmark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--edge)" stroke-width="3.4" />
      <path d="M12 3.8a8.2 8.2 0 1 1-8 6.4" fill="none" stroke="var(--st-work)" stroke-width="3.4" stroke-linecap="round" />
    </svg>
    <span class="cword">volery</span>
    <span class="cwhere">{row.project} / {row.title}</span>
  </header>

  <div class="cbody">
    <aside class="cside">
      <span class="ckick">conversations</span>
      {#each ROWS as r (r.id)}
        <button
          type="button"
          class="crow"
          class:on={selected === r.id}
          onclick={() => {
            selected = r.id;
            answered = null;
          }}
        >
          <span class="cdot" data-st={r.state} aria-hidden="true"></span>
          <span class="cwords">
            <span class="ctitle">{r.title}</span>
            <span class="cmeta">{r.project} · {r.age}{r.state === "ask" ? " · waiting on you" : r.state === "work" ? " · working" : ""}</span>
          </span>
          {#if r.ctx > 0.3 || selected === r.id}
            <span class="cring"><CtxRing ctx={r.ctx} dormant={r.state === "idle"} size={18} /></span>
          {/if}
        </button>
      {/each}
    </aside>

    <section class="cthread">
      <div class="cscroll">
        <button
          type="button"
          class="ctoast"
          onclick={() => {
            selected = "migration";
            answered = null;
          }}
        >
          <span class="cdot" data-st="ask" aria-hidden="true"></span>
          <span>Split the billing migration is waiting on you</span>
          <span class="copen">open</span>
        </button>

        <div class="cyou">{thread.you}</div>
        <div class="cagent"><div class="cmd"><Markdown blocks={prose} nav={false} /></div></div>
        {#if thread.doing}<div class="cdoing"><i></i>{thread.doing}</div>{/if}

        {#if thread.ask}
          <div class="cask">
            <div class="cshead">
              <span class="csk">question</span>
              <span class="csq">Which migration should land first?</span>
            </div>
            {#if answered}
              <div class="cans">answered: {answered}</div>
            {:else}
              <button type="button" class="copt" onclick={() => (answered = "billing first, then audit")}>
                <span class="clab">billing first, then audit</span>
                <span class="cdet">Short window. The backfill waits for the deploy.</span>
              </button>
              <button type="button" class="copt" onclick={() => (answered = "audit first, then billing")}>
                <span class="clab">audit first, then billing</span>
                <span class="cdet">No deploy order. The backfill needs a second pass.</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <div class="ccomp">
        <span class="cph">write to the flock…</span>
        <span class="csend" aria-hidden="true"></span>
      </div>
    </section>
  </div>
</div>

<style>
  .chatmock {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    overflow: hidden;
    box-shadow: 0 30px 60px -42px var(--shade, #000);
  }
  .chead {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 13px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
  }
  .cmark {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .cword {
    font: 400 14px var(--display);
    color: var(--paper);
  }
  .cwhere {
    font-size: 10px;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cbody {
    display: grid;
    grid-template-columns: 206px minmax(0, 1fr);
    min-height: 360px;
  }
  @media (max-width: 760px) {
    .cbody {
      grid-template-columns: minmax(0, 1fr);
    }
    .cside {
      display: none;
    }
  }
  .cside {
    border-right: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    padding: 9px 7px;
    display: grid;
    align-content: start;
    gap: 2px;
    background: color-mix(in oklab, var(--well) 38%, transparent);
  }
  .ckick {
    padding: 3px 7px 6px;
    font-size: 8.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .crow {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 7px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .crow:hover {
    background: color-mix(in oklab, var(--raised) 45%, transparent);
  }
  .crow.on {
    background: var(--raised);
    border-color: color-mix(in oklab, var(--edge) 70%, transparent);
  }
  .cdot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex: none;
    background: var(--paper-faint);
  }
  .cdot[data-st="work"] {
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .cdot[data-st="ask"] {
    background: var(--st-ask);
    box-shadow: 0 0 6px var(--st-ask);
  }
  .cdot[data-st="rest"] {
    background: var(--st-rest);
  }
  .cdot[data-st="fail"] {
    background: var(--st-fail);
  }
  .cwords {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .ctitle {
    font-size: 10px;
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crow.on .ctitle {
    color: var(--paper);
  }
  .cmeta {
    font-size: 8.5px;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cring {
    margin-left: auto;
    display: flex;
    flex: none;
  }
  .cthread {
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: radial-gradient(80% 55% at 50% -10%, color-mix(in oklab, var(--paper) 4%, transparent), transparent 70%), var(--ink);
  }
  .cscroll {
    flex: 1;
    padding: 12px 16px 10px;
    display: grid;
    align-content: start;
    gap: 9px;
    max-height: 330px;
    overflow: auto;
  }
  .ctoast {
    justify-self: center;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--st-ask) 35%, var(--edge));
    background: color-mix(in oklab, var(--st-ask) 7%, var(--surface));
    font: inherit;
    font-size: 9.5px;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .ctoast:hover {
    border-color: color-mix(in oklab, var(--st-ask) 55%, var(--edge));
  }
  .copen {
    color: var(--st-ask);
  }
  .cyou {
    justify-self: end;
    max-width: 82%;
    padding: 6px 10px;
    border-radius: 10px 10px 3px 10px;
    background: var(--raised);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    color: var(--paper);
    font: 12px/1.5 var(--body);
  }
  .cagent {
    max-width: 92%;
    color: var(--paper-dim);
    font-family: var(--body);
    font-size: 12px;
    line-height: 1.6;
    --tx-size: 0.8rem;
    --tx-leading: 1.58;
    --tx-prose: var(--paper-dim);
  }
  .cmd {
    font-family: var(--body);
  }
  .cdoing {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9.5px;
    color: var(--paper-faint);
  }
  .cdoing i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .cask {
    display: grid;
    gap: 5px;
    padding: 9px 10px;
    border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--st-ask) 45%, var(--edge));
    background: color-mix(in oklab, var(--st-ask) 5%, var(--surface));
  }
  .cshead {
    display: grid;
    gap: 2px;
  }
  .csk {
    font-size: 8px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--st-ask);
  }
  .csq {
    font: 12.5px/1.35 var(--display);
    color: var(--paper);
  }
  .copt {
    display: grid;
    gap: 1px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: color-mix(in oklab, var(--well) 45%, transparent);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .copt:hover {
    border-color: color-mix(in oklab, var(--st-ask) 50%, var(--edge));
  }
  .clab {
    font-size: 10.5px;
    color: var(--paper-dim);
  }
  .cdet {
    font-size: 9px;
    color: var(--paper-faint);
  }
  .cans {
    padding: 5px 7px;
    border-radius: 6px;
    background: var(--raised);
    font-size: 10.5px;
    color: var(--paper-dim);
  }
  .ccomp {
    flex: none;
    margin: 0 12px 12px;
    height: 34px;
    display: flex;
    align-items: center;
    padding: 0 6px 0 12px;
    border-radius: 11px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 8%);
    background: var(--surface);
  }
  .cph {
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .csend {
    margin-left: auto;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--paper);
    opacity: 0.85;
  }
</style>
