<script lang="ts">
  /* The opening argument, shown in three states rather than made in a
   * paragraph: nine tabs, then the same nine with nothing to read, then the
   * wall, where the one that asked you something is amber.
   */
  import { TABS_STORY } from "./showcase";

  const TABS = [
    "price sync",
    "billing split",
    "asset bump",
    "release notes",
    "invoice batch",
    "vendor summary",
    "water shader",
    "HNSW article",
    "audit backfill",
  ];

  const STATES = ["work", "ask", "work", "rest", "fail", "work", "rest", "idle", "work"] as const;

  /* The fourth beat is the morning after, and every row is a different kind
     of thing that survived. A resumed session, a question still parked, and a
     dev server that came back with the wall — the three answers to "what did
     I lose when I closed the lid". */
  const RESTORED = [
    { name: "billing split", what: "resumed its session, 41 turns kept" },
    { name: "vendor summary", what: "still waiting on your answer" },
    { name: "water shader", what: "its dev server came back on :5173" },
  ];

  let beat = $state(0);
  const story = $derived(TABS_STORY[beat]);
</script>

<div class="tabsdemo">
  <div class="switchrow" role="group" aria-label="the story in four states">
    {#each TABS_STORY as s, i (s.title)}
      <button type="button" class="step" class:on={beat === i} onclick={() => (beat = i)}>
        <span class="num">{i + 1}</span>{s.title}
      </button>
    {/each}
  </div>

  <div class="stage">
    {#if beat < 2}
      <div class="strip" aria-hidden="true">
        {#each TABS as t, i (t)}
          <span class="tab" class:active={i === 3}>{t}</span>
        {/each}
        <span class="plus">+</span>
      </div>

      {#if beat === 0}
        <div class="pane">
          <div class="pline you">make the retry path stop double-writing</div>
          <div class="pline agent">I read the retry helper and the queue in front of it…</div>
          <div class="pline agent dim">The claim and the work are now separate transactions…</div>
          <div class="pfoot"><span class="pip"></span>working</div>
        </div>
      {:else}
        <div class="sessions">
          {#each TABS as t (t)}
            <div class="srow"><span class="sdot"></span>{t}<span class="sage">open</span></div>
          {/each}
        </div>
      {/if}
    {:else if beat === 2}
      <div class="wallgrid">
        {#each TABS as t, i (t)}
          <div class="wcard" data-st={STATES[i]}>
            <span class="wname">{t}</span>
            <span class="wfoot"><i></i>{STATES[i] === "ask" ? "waiting on you" : STATES[i] === "work" ? "working" : STATES[i] === "rest" ? "at rest" : STATES[i] === "fail" ? "failed" : "dormant"}</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="returned">
        <div class="rhead">
          <span class="rlabel">closed friday 18:04</span>
          <span class="rarrow" aria-hidden="true">&rarr;</span>
          <span class="rlabel live">opened monday 09:12</span>
        </div>
        <div class="rlist">
          {#each RESTORED as r, i (r.name)}
            <div class="rrow" data-kind={i}>
              <span class="rname">{r.name}</span>
              <span class="rwhat">{r.what}</span>
            </div>
          {/each}
        </div>
        <div class="rservers">
          <span class="slabel">dev servers</span>
          <span class="srv">portfolio :5173</span>
          <span class="srv">api :3001</span>
          <span class="srv">docs :4321</span>
          <span class="rup"><i></i>back up</span>
        </div>
      </div>
    {/if}
  </div>

  <div class="caption">
    <span class="ct">{story.title}</span>
    <p class="cb">{story.body}</p>
  </div>
</div>

<style>
  .tabsdemo {
    display: grid;
    gap: 12px;
  }
  .switchrow {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .step {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 10px 0 7px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 72%, transparent);
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .step:hover {
    color: var(--paper-dim);
  }
  .step.on {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 20%);
    background: color-mix(in oklab, var(--raised) 55%, transparent);
  }
  .num {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    display: grid;
    place-items: center;
    font-size: 9px;
    color: var(--paper-faint);
    background: var(--raised);
    border: 1px solid var(--edge);
  }
  .step.on .num {
    color: var(--st-work);
  }
  .stage {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: var(--ink);
    overflow: hidden;
    min-height: 250px;
  }
  .strip {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    padding: 8px 8px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 65%, transparent);
    overflow: hidden;
  }
  .tab {
    flex: none;
    max-width: 96px;
    padding: 6px 9px 7px;
    border-radius: 6px 6px 0 0;
    border: 1px solid color-mix(in oklab, var(--edge) 65%, transparent);
    border-bottom: 0;
    font-size: 9.5px;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: color-mix(in oklab, var(--well) 55%, transparent);
  }
  .tab.active {
    color: var(--paper-dim);
    background: var(--surface);
    border-color: var(--edge);
  }
  .plus {
    padding: 6px 8px;
    font-size: 11px;
    color: var(--paper-faint);
  }
  .pane {
    padding: 16px 18px 14px;
    display: grid;
    gap: 8px;
    max-width: 620px;
  }
  .pline {
    font: 12.5px/1.55 var(--body);
    padding: 7px 10px;
    border-radius: 8px;
    max-width: 92%;
  }
  .pline.you {
    justify-self: end;
    color: var(--paper);
    background: var(--raised);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
  }
  .pline.agent {
    color: var(--paper-dim);
    background: color-mix(in oklab, var(--well) 45%, transparent);
    border: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
  }
  .pline.dim {
    color: var(--paper-mute);
  }
  .pfoot {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--paper-faint);
  }
  .pip {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .sessions {
    padding: 12px 14px;
    display: grid;
    gap: 1px;
  }
  .srow {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border-radius: 5px;
    font-size: 11px;
    color: var(--paper-mute);
  }
  .srow:nth-child(2) {
    background: color-mix(in oklab, var(--raised) 35%, transparent);
  }
  .sdot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--rule);
  }
  .sage {
    margin-left: auto;
    font-size: 9px;
    color: var(--paper-faint);
  }
  .wallgrid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 7px;
    padding: 14px;
  }
  .wcard {
    display: grid;
    gap: 10px;
    padding: 9px 10px;
    min-height: 64px;
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--edge);
  }
  .wcard[data-st="work"] {
    border-color: color-mix(in oklab, var(--st-work) 52%, var(--edge));
    box-shadow: 0 0 20px -8px color-mix(in oklab, var(--st-work) 65%, transparent);
  }
  .wcard[data-st="ask"] {
    border-color: color-mix(in oklab, var(--st-ask) 62%, var(--edge));
    box-shadow: 0 0 22px -8px color-mix(in oklab, var(--st-ask) 65%, transparent);
  }
  .wcard[data-st="rest"],
  .wcard[data-st="idle"] {
    background: var(--ink);
    border-style: dashed;
  }
  .wcard[data-st="fail"] {
    border-color: color-mix(in oklab, var(--st-fail) 48%, var(--edge));
  }
  .wname {
    font-size: 10.5px;
    color: var(--paper-dim);
    line-height: 1.3;
  }
  .wcard[data-st="rest"] .wname,
  .wcard[data-st="idle"] .wname {
    color: var(--paper-mute);
  }
  .wfoot {
    display: flex;
    align-items: center;
    gap: 5px;
    align-self: end;
    font-size: 8.5px;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .wfoot i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--paper-faint);
    flex: none;
  }
  .wcard[data-st="work"] .wfoot i {
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .wcard[data-st="ask"] .wfoot i {
    background: var(--st-ask);
    box-shadow: 0 0 6px var(--st-ask);
  }
  .wcard[data-st="rest"] .wfoot i {
    background: var(--st-rest);
  }
  .wcard[data-st="fail"] .wfoot i {
    background: var(--st-fail);
  }
  .returned {
    padding: 14px;
    display: grid;
    gap: 10px;
    align-content: start;
    min-height: 250px;
  }
  .rhead {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    letter-spacing: 0.03em;
    color: var(--paper-faint);
  }
  .rlabel.live {
    color: var(--paper-mute);
  }
  .rarrow {
    color: var(--rule);
  }
  .rlist {
    display: grid;
    gap: 5px;
  }
  .rrow {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    background: color-mix(in oklab, var(--surface) 80%, transparent);
  }
  .rrow[data-kind="1"] {
    border-color: color-mix(in oklab, var(--st-ask) 40%, var(--edge));
  }
  .rname {
    flex: none;
    width: 110px;
    font-size: 11px;
    color: var(--paper-dim);
  }
  .rwhat {
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .rrow[data-kind="1"] .rwhat {
    color: color-mix(in oklab, var(--st-ask) 70%, var(--paper-mute));
  }
  .rservers {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border-radius: 7px;
    border: 1px dashed color-mix(in oklab, var(--edge) 75%, transparent);
  }
  .slabel {
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .srv {
    font: 10px var(--util);
    color: var(--paper-mute);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--raised);
    border: 1px solid var(--edge);
  }
  .rup {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 9.5px;
    color: var(--st-work);
  }
  .rup i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .caption {
    display: grid;
    gap: 3px;
    padding: 0 2px;
  }
  .ct {
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--paper);
  }
  .cb {
    margin: 0;
    font: 12.5px/1.62 var(--body);
    color: var(--paper-mute);
    max-width: 76ch;
  }
</style>
