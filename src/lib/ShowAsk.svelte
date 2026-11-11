<script lang="ts">
  /* A question, answered, in the shape the dock draws it.
   *
   * Two decisions in one call, because the useful thing to show is that they
   * are asked one at a time and sent together. The panel is not `Ask.svelte`:
   * that one is wired to a parked HTTP request and to four stores, and a demo
   * that mounts it would need a real card behind it. What is borrowed is the
   * vocabulary (amber, the spine, the numbered keys, a detail line under every
   * option) so that the real panel feels familiar the first time it appears.
   */
  import CtxRing from "./CtxRing.svelte";
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { ASK, ASK_FILED, ASK_REVIEW, ASK_SECOND, DESIGN_ASK, type DesignId } from "./showcase";

  type Stage = "first" | "second" | "review" | "resumed" | "filed";

  let stage = $state<Stage>("first");
  let one = $state<string | null>(null);
  let two = $state<string | null>(null);
  let design = $state<DesignId | null>(null);
  let root = $state<HTMLElement>();

  const why = $derived(parseMarkdown(stage === "second" ? ASK_SECOND.why : ASK.why));
  const asked = $derived(stage === "second" ? ASK_SECOND.asked : ASK.asked);
  const options = $derived(stage === "second" ? ASK_SECOND.options : ASK.options);
  const onQuestion = $derived(stage === "first" || stage === "second");

  /* The shell focuses this, through `data-tour-focus`. It used to focus
     itself, which won on a direct load and took the tour's own keys away. */

  function pick(answer: string) {
    if (stage === "first") {
      one = answer;
      stage = "second";
    } else if (stage === "second") {
      two = answer;
      stage = "review";
    }
  }

  function key(e: KeyboardEvent) {
    if (onQuestion) {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) {
        e.preventDefault();
        pick(options[n - 1].answer);
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        stage = "filed";
      }
      return;
    }
    if (stage === "review" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      stage = "resumed";
      /* And stop here. A `$state` write is read back synchronously, so the
         arm below would match the stage this line just set and reset the
         demo on the same press. The UI review caught it with Enter; Space
         only looked fine because the reset arm tests Enter alone. */
      return;
    }
    if ((stage === "resumed" || stage === "filed") && e.key === "Enter") {
      e.preventDefault();
      reset();
    }
  }

  function reset() {
    stage = "first";
    one = null;
    two = null;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="askwrap" role="group" aria-label="a question from an agent" tabindex="-1" data-tour-focus bind:this={root} onkeydown={key}>
  <div class="who">
    <span class="proj">portfolio</span>
    <span class="title">Split the billing migration</span>
    <span class="ring"><CtxRing ctx={0.67} size={16} /></span>
    <span class="state" data-stage={stage}
      >{stage === "resumed" ? "working" : stage === "filed" ? "filed" : "waiting on you"}</span
    >
  </div>

  <div class="body">
    {#if onQuestion}
      <div class="spine" aria-label={`question ${stage === "first" ? 1 : 2} of 2`}>
        <i class="done"></i>
        <i class="done"></i>
        <i class="now"></i>
        <span class="count">{stage === "first" ? "1" : "2"} of 2</span>
      </div>

      <h3 class="q">{asked}</h3>
      <div class="md why"><Markdown blocks={why} nav={false} /></div>

      <div class="opts">
        {#each options as o, i (o.label)}
          <button type="button" class="opt" onclick={() => pick(o.answer)}>
            <span class="num">{i + 1}</span>
            <span class="words">
              <span class="lab">{o.label}</span>
              <span class="det">{o.detail}</span>
            </span>
          </button>
        {/each}
      </div>

      <div class="under">
        <span class="hint">press 1 or 2</span>
        <button type="button" class="defer" onclick={() => (stage = "filed")}>defer until later <kbd>d</kbd></button>
      </div>
    {:else if stage === "review"}
      <h3 class="q">two answers, one reply</h3>
      <p class="sent">{ASK_REVIEW}</p>
      <div class="review">
        <button type="button" class="pairrow" onclick={() => (stage = "first")}>
          <span class="lab">{ASK.asked}</span><span class="ans">{one}</span>
        </button>
        <button type="button" class="pairrow" onclick={() => (stage = "second")}>
          <span class="lab">{ASK_SECOND.asked}</span><span class="ans">{two}</span>
        </button>
      </div>
      <div class="under">
        <span class="hint">click a pair to change it</span>
        <button type="button" class="defer go" onclick={() => (stage = "resumed")}>send both <kbd>enter</kbd></button>
      </div>
    {:else if stage === "resumed"}
      <div class="done">
        <span class="tick" aria-hidden="true">✓</span>
        <span>the turn resumed in place</span>
      </div>
      <div class="youline">{one} · {two}</div>
      <p class="resumed">{ASK.resumed}</p>
      <div class="under">
        <span class="hint">the card kept its context and its process</span>
        <button type="button" class="defer" onclick={reset}>ask it again</button>
      </div>
    {:else}
      <div class="filed">
        <span class="fold" aria-hidden="true">▸</span>
        <span>filed without a deadline</span>
      </div>
      <p class="sent">{ASK_FILED}</p>
      <div class="under">
        <span class="hint">a machine nobody is touching files it for you</span>
        <button type="button" class="defer" onclick={reset}>start over</button>
      </div>
    {/if}
  </div>
</div>

<!-- The other half of the ask tool: an option that shows rather than
     describes. In the real panel this is a gallery over the whole window,
     three composed designs side by side at full size, and choosing one is
     the answer. The three pictures here are drawn in the wall's own tokens,
     because that is what the real previews are given as well. -->
<div class="gallery" role="group" aria-label="a question that shows three designs" data-picked={design}>
  <div class="ghead">
    <span class="proj">portfolio</span>
    <span class="gtitle">{DESIGN_ASK.asked}</span>
    <span class="gstate">{design ? "answered" : "waiting on you"}</span>
  </div>
  <p class="gwhy">{DESIGN_ASK.why}</p>

  <div class="panels">
    {#each DESIGN_ASK.options as d, i (d.id)}
      <button
        type="button"
        class="panel"
        class:on={design === d.id}
        aria-pressed={design === d.id}
        onclick={() => (design = d.id)}
      >
        <span class="shot" aria-hidden="true">
          <span class="mini" data-design={d.id} data-st="work">
            <span class="mrail"></span>
            <span class="mband"></span>
            <span class="mname">billing split</span>
            <span class="mfoot"><i class="mst"></i>working</span>
          </span>
          <span class="mini rest" data-design={d.id} data-st="rest">
            <span class="mrail"></span>
            <span class="mband"></span>
            <span class="mname">release notes</span>
            <span class="mfoot"><i class="mst"></i>at rest</span>
          </span>
        </span>
        <span class="plabel">{d.label}</span>
        <span class="pdet">{d.detail}</span>
        {#if design === d.id}<span class="chosen" aria-hidden="true">✓ chosen</span>{/if}
      </button>
    {/each}
  </div>

  {#if design}
    <div class="gdone">
      <span class="tick" aria-hidden="true">✓</span>
      <span>{DESIGN_ASK.chosen}</span>
    </div>
  {:else}
    <div class="under">
      <span class="hint">click a design to answer with it</span>
      <span class="hint dim">in the real gallery, a panel is full size</span>
    </div>
  {/if}
  <p class="galso">{DESIGN_ASK.also}</p>
</div>

<style>
  .askwrap {
    max-width: 660px;
    border-radius: 14px;
    border: 1px solid color-mix(in oklab, var(--st-ask) 42%, var(--edge));
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--st-ask) 14%, transparent),
      0 30px 60px -42px var(--shade, #000);
    overflow: hidden;
    outline: none;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    min-width: 0;
  }
  .proj {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
    flex: none;
  }
  .title {
    font-size: 11.5px;
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ring {
    display: flex;
    flex: none;
  }
  .state {
    margin-left: auto;
    flex: none;
    font-size: 10.5px;
    color: var(--st-ask);
  }
  .state[data-stage="resumed"] {
    color: var(--st-work);
  }
  .state[data-stage="filed"] {
    color: var(--paper-mute);
  }
  .body {
    padding: 15px 16px 13px;
    display: flex;
    flex-direction: column;
    gap: 11px;
  }
  .spine {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .spine i {
    width: 16px;
    height: 2px;
    border-radius: 2px;
    background: var(--rule);
  }
  .spine i.done {
    background: color-mix(in oklab, var(--st-ask) 55%, transparent);
  }
  .spine i.now {
    background: var(--st-ask);
  }
  .count {
    margin-left: 5px;
    font-size: 10px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .q {
    margin: 0;
    font: 400 19px/1.35 var(--display);
    color: var(--paper);
  }
  .md {
    font-family: var(--body);
  }
  .why {
    font-size: 12.5px;
    line-height: 1.58;
    color: var(--paper-mute);
    --tx-size: 0.82rem;
    --tx-leading: 1.55;
    --tx-prose: var(--paper-mute);
  }
  .opts {
    display: grid;
    gap: 6px;
  }
  .opt {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 9px 11px;
    text-align: left;
    font: inherit;
    color: var(--paper-dim);
    border-radius: 8px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: color-mix(in oklab, var(--well) 45%, transparent);
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .opt:hover,
  .opt:focus-visible {
    border-color: color-mix(in oklab, var(--st-ask) 55%, var(--edge));
    background: color-mix(in oklab, var(--st-ask) 7%, var(--well));
  }
  .num {
    flex: none;
    width: 17px;
    height: 17px;
    border-radius: 5px;
    display: grid;
    place-items: center;
    font-size: 10px;
    color: var(--paper-mute);
    background: var(--raised);
    border: 1px solid var(--edge);
  }
  .words {
    display: grid;
    gap: 2px;
  }
  .lab {
    font-size: 12.5px;
    color: var(--paper);
  }
  .det {
    font-size: 11px;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .under {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 3px;
  }
  .hint {
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .defer {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .defer:hover {
    border-color: var(--edge);
    color: var(--paper-dim);
  }
  .defer.go {
    border-color: color-mix(in oklab, var(--st-ask) 50%, var(--edge));
    color: var(--paper);
  }
  .defer kbd {
    font-family: var(--util);
    font-size: 9.5px;
    color: var(--paper-faint);
    padding: 0 4px;
    border: 1px solid var(--edge);
    border-radius: 3px;
  }
  .sent {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--paper-mute);
  }
  .review {
    display: grid;
    gap: 5px;
  }
  .pairrow {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 8px 10px;
    text-align: left;
    font: inherit;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: color-mix(in oklab, var(--well) 40%, transparent);
    cursor: pointer;
  }
  .pairrow:hover {
    border-color: color-mix(in oklab, var(--edge) 50%, var(--paper) 20%);
  }
  .pairrow .lab {
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .ans {
    font-size: 12.5px;
    color: var(--paper);
  }
  .done {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--st-work);
  }
  .tick {
    width: 17px;
    height: 17px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10px;
    border: 1px solid color-mix(in oklab, var(--st-work) 55%, var(--edge));
  }
  .youline {
    font-size: 12px;
    color: var(--paper-dim);
    padding: 7px 10px;
    border-radius: 8px;
    background: var(--raised);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
  }
  .resumed {
    margin: 0;
    font: 13.5px/1.6 var(--body);
    color: var(--paper-dim);
  }
  .filed {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--paper-mute);
  }
  .fold {
    color: var(--paper-faint);
  }

  /* The gallery: the same amber as the panel above, because it is the same
     conversation still parked. Three previews across, which is the one thing
     a design question needs and a dock panel cannot do. */
  .gallery {
    max-width: 900px;
    margin-top: 16px;
    padding: 13px 15px 12px;
    display: grid;
    gap: 10px;
    border-radius: 14px;
    border: 1px solid color-mix(in oklab, var(--st-ask) 34%, var(--edge));
    background: var(--surface);
  }
  .gallery[data-picked] {
    border-color: color-mix(in oklab, var(--st-work) 34%, var(--edge));
  }
  .ghead {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .gtitle {
    font-size: 13px;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gstate {
    margin-left: auto;
    flex: none;
    font-size: 10.5px;
    color: var(--st-ask);
  }
  .gallery[data-picked] .gstate {
    color: var(--st-work);
  }
  .gwhy {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--paper-mute);
    max-width: 78ch;
  }
  .panels {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .panel {
    position: relative;
    display: grid;
    gap: 6px;
    padding: 8px;
    text-align: left;
    font: inherit;
    border-radius: 10px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: color-mix(in oklab, var(--well) 45%, transparent);
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .panel:hover,
  .panel:focus-visible {
    border-color: color-mix(in oklab, var(--st-ask) 55%, var(--edge));
  }
  .panel.on {
    border-color: color-mix(in oklab, var(--st-work) 62%, var(--edge));
    background: color-mix(in oklab, var(--st-work) 6%, var(--well));
  }
  .shot {
    display: grid;
    grid-template-rows: 1fr 1fr;
    gap: 6px;
    padding: 8px;
    height: 128px;
    border-radius: 8px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    background: var(--ink);
  }
  .mini {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 6px 9px 6px 11px;
    border-radius: 6px;
    border: 1px solid var(--edge);
    background: var(--surface);
    overflow: hidden;
  }
  .mini.rest {
    background: var(--ink);
    border-style: dashed;
  }
  .mname {
    font-size: 9.5px;
    color: var(--paper-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mini.rest .mname {
    color: var(--paper-mute);
  }
  .mfoot {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 7.5px;
    color: var(--paper-mute);
  }
  .mst {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--st-work);
    flex: none;
  }
  .mini.rest .mst {
    background: var(--st-rest);
  }
  /* Exactly one treatment is drawn per panel, so a panel is a comparison
     rather than three cards wearing every idea at once. */
  .mrail,
  .mband,
  .mst {
    display: none;
  }
  .mini[data-design="rail"] .mrail {
    display: block;
    position: absolute;
    left: 3px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 2px;
    background: var(--st-work);
  }
  .mini.rest[data-design="rail"] .mrail {
    background: var(--st-rest);
    opacity: 0.6;
  }
  .mini[data-design="band"] .mband {
    display: block;
    position: absolute;
    left: 6px;
    right: 6px;
    top: 0;
    height: 3px;
    border-radius: 0 0 2px 2px;
    background: var(--st-work);
  }
  .mini.rest[data-design="band"] .mband {
    background: var(--st-rest);
    opacity: 0.6;
  }
  .mini[data-design="dot"] .mst {
    display: block;
  }
  .plabel {
    font-size: 12px;
    color: var(--paper);
  }
  .pdet {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .chosen {
    position: absolute;
    top: 13px;
    right: 13px;
    font-size: 9px;
    letter-spacing: 0.03em;
    color: var(--st-work);
    background: color-mix(in oklab, var(--ink) 82%, transparent);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid color-mix(in oklab, var(--st-work) 45%, var(--edge));
  }
  .gdone {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--paper-dim);
  }
  .gdone .tick {
    flex: none;
  }
  .hint.dim {
    margin-left: auto;
    color: var(--paper-faint);
  }
  .galso {
    margin: 0;
    padding-top: 2px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--paper-faint);
    max-width: 82ch;
  }
  @media (max-width: 760px) {
    .panels {
      grid-template-columns: 1fr;
    }
  }
</style>
