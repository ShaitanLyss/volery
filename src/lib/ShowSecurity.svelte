<script lang="ts">
  /* The security chapter, with the uncomfortable part made into something you
   * can operate.
   *
   * A list of controls reads as reassurance. Taking the key and watching what
   * it buys is harder to nod past, and it is the same sentence the other card
   * will need when the second factor lands: here is the door, here is what
   * happens without it.
   */
  import {
    SECURITY_FACTS,
    SECURITY_HEADLINE,
    SECURITY_PLANS,
    SECURITY_STAGE,
    theftStory,
  } from "./showcase";

  let stolen = $state(false);
  let second = $state(false);

  const hardened = SECURITY_STAGE === "hardened";
  const guarded = $derived(hardened || second);
  const story = $derived(theftStory(SECURITY_STAGE, stolen, guarded));
  const plans = SECURITY_PLANS[SECURITY_STAGE];

  const toneWord = { ok: "on this machine", warn: "worth knowing", gap: "still a gap" } as const;
</script>

<div class="security">
  <p class="headline">{SECURITY_HEADLINE[SECURITY_STAGE]}</p>

  <div class="theft" class:leaking={stolen && !guarded} class:sealed={!stolen || guarded}>
    <div class="diagram">
      <div class="node here">
        <span class="tag">this wall</span>
        <span class="nm">your laptop</span>
      </div>

      <div class="wire">
        {#if stolen && !guarded}
          <span class="line open"></span>
          <span class="lineword">reads the frames</span>
        {:else}
          <span class="line"></span>
          <span class="lineword">{stolen ? "ciphertext, no membership" : "sealed frames"}</span>
        {/if}
      </div>

      <div class="node far">
        <span class="tag">the flyway</span>
        <span class="nm">the other wall</span>
      </div>

      {#if stolen}
        <div class="thief" class:blocked={guarded}>
          <span class="tag">someone else</span>
          <span class="nm">{guarded ? "holds the key" : "holds the key and joins"}</span>
          <span class="door">{guarded ? "the door asks for a second factor" : "the door opens"}</span>
        </div>
      {/if}
    </div>

    <div class="controls">
      <button type="button" class="switch" class:on={stolen} role="switch" aria-checked={stolen} onclick={() => (stolen = !stolen)}>
        <span class="knob" aria-hidden="true"></span>
        <span class="sword">steal the wall key</span>
      </button>
      {#if !hardened}
        <button type="button" class="switch" class:on={second} role="switch" aria-checked={second} onclick={() => (second = !second)}>
          <span class="knob" aria-hidden="true"></span>
          <span class="sword">add the second factor</span>
        </button>
      {:else}
        <span class="shippedline">the second factor is shipped</span>
      {/if}
    </div>

    <div class="verdict" aria-live="polite">
      <span class="vtitle">{story.title}</span>
      <p class="vbody">{story.body}</p>
    </div>
  </div>

  <div class="facts">
    {#each SECURITY_FACTS as f (f.label)}
      <div class="fact">
        <div class="fhead">
          <span class="flabel">{f.label}</span>
          <span class="ftone" data-tone={f.tone}>{toneWord[f.tone]}</span>
        </div>
        <p class="fvalue">{f.value}</p>
      </div>
    {/each}
  </div>

  <div class="plans">
    <div class="phead">
      <span class="ptitle">what changes</span>
      <span class="pstage">{hardened ? "shipped" : "planned, and written down so it can be checked"}</span>
    </div>
    {#each plans as p (p.title)}
      <div class="plan">
        <span class="chip" data-stage={p.status}>{p.status}</span>
        <div class="pwords">
          <span class="pname">{p.title}</span>
          <p class="pbody">{p.body}</p>
        </div>
      </div>
    {/each}
  </div>

  <p class="floor">A project card still holds the repository with both hands. That is the same authority a terminal gives it, and no part of this chapter changes it.</p>
</div>

<style>
  .security {
    display: grid;
    gap: 16px;
  }
  .headline {
    margin: 0;
    font: 14px/1.6 var(--body);
    color: var(--paper-dim);
    max-width: 70ch;
  }
  .theft {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    overflow: hidden;
    transition: border-color var(--dur-step, 240ms) var(--ease-out, ease-out);
  }
  .theft.leaking {
    border-color: color-mix(in oklab, var(--st-fail) 52%, var(--edge));
  }
  .theft.sealed {
    border-color: color-mix(in oklab, var(--st-work) 34%, var(--edge));
  }
  .diagram {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 20px 18px 14px;
    min-height: 150px;
  }
  .node {
    width: 150px;
    flex: none;
    display: grid;
    gap: 2px;
    padding: 9px 10px;
    border-radius: 8px;
    border: 1px solid var(--edge);
    background: var(--raised);
  }
  .tag {
    font-size: 8.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .nm {
    font-size: 11.5px;
    color: var(--paper-dim);
  }
  .wire {
    flex: 1;
    position: relative;
    min-width: 60px;
    height: 44px;
    display: grid;
    place-items: center;
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    top: 18px;
    height: 1px;
    background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--paper-mute) 65%, transparent), transparent);
  }
  .line.open {
    height: 2px;
    background: repeating-linear-gradient(90deg, var(--st-fail) 0 6px, transparent 6px 11px);
    opacity: 0.9;
  }
  .lineword {
    position: relative;
    font-size: 9.5px;
    color: var(--paper-faint);
    background: var(--surface);
    padding: 0 6px;
    white-space: nowrap;
  }
  .thief {
    position: absolute;
    right: 18px;
    bottom: 12px;
    width: 190px;
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px dashed color-mix(in oklab, var(--st-fail) 60%, var(--edge));
    background: color-mix(in oklab, var(--st-fail) 6%, var(--well));
    animation: rise var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  .thief.blocked {
    border-color: color-mix(in oklab, var(--st-ask) 55%, var(--edge));
    background: color-mix(in oklab, var(--st-ask) 5%, var(--well));
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(5px);
    }
  }
  .door {
    font-size: 9.5px;
    color: var(--paper-mute);
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 11px 16px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    flex-wrap: wrap;
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 10px 0 4px;
    border-radius: 16px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      color var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .switch:hover {
    color: var(--paper-dim);
  }
  .switch.on {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 22%);
  }
  .knob {
    width: 20px;
    height: 16px;
    border-radius: 9px;
    background: var(--rule);
    position: relative;
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .knob::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--paper-mute);
    transition: transform var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .switch.on .knob {
    background: color-mix(in oklab, var(--st-ask) 45%, var(--rule));
  }
  .switch.on .knob::after {
    transform: translateX(4px);
    background: var(--paper);
  }
  .shippedline {
    font-size: 10.5px;
    color: var(--st-work);
  }
  .verdict {
    display: grid;
    gap: 3px;
    padding: 12px 16px 14px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    background: color-mix(in oklab, var(--well) 42%, transparent);
  }
  .vtitle {
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--paper);
  }
  .vbody {
    margin: 0;
    font: 12.5px/1.6 var(--body);
    color: var(--paper-mute);
    max-width: 76ch;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  @media (max-width: 820px) {
    .facts {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .fact {
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--edge) 72%, transparent);
    background: color-mix(in oklab, var(--well) 34%, transparent);
  }
  .fhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .flabel {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .ftone {
    margin-left: auto;
    font-size: 9px;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .ftone[data-tone="ok"] {
    color: color-mix(in oklab, var(--st-work) 80%, var(--paper-mute));
  }
  .ftone[data-tone="warn"] {
    color: color-mix(in oklab, var(--st-ask) 72%, var(--paper-mute));
  }
  .ftone[data-tone="gap"] {
    color: color-mix(in oklab, var(--st-fail) 78%, var(--paper-mute));
  }
  .fvalue {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.52;
    color: var(--paper-mute);
  }
  .plans {
    display: grid;
    gap: 8px;
  }
  .phead {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .ptitle {
    font: 400 18px/1.2 var(--display);
    color: var(--paper);
  }
  .pstage {
    margin-left: auto;
    font-size: 10px;
    color: var(--paper-faint);
  }
  .plan {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 10px;
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    background: color-mix(in oklab, var(--well) 30%, transparent);
  }
  .chip {
    justify-self: start;
    align-self: start;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 8.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-mute);
    border: 1px solid var(--edge);
  }
  .chip[data-stage="planned"] {
    color: color-mix(in oklab, var(--st-ask) 75%, var(--paper-mute));
    border-color: color-mix(in oklab, var(--st-ask) 40%, var(--edge));
  }
  .chip[data-stage="shipped"] {
    color: color-mix(in oklab, var(--st-work) 78%, var(--paper-mute));
    border-color: color-mix(in oklab, var(--st-work) 40%, var(--edge));
  }
  .pwords {
    display: grid;
    gap: 3px;
  }
  .pname {
    font-size: 12px;
    color: var(--paper-dim);
  }
  .pbody {
    margin: 0;
    font: 11.5px/1.55 var(--body);
    color: var(--paper-mute);
  }
  .floor {
    margin: 0;
    padding: 11px 13px;
    border-radius: 9px;
    border: 1px dashed color-mix(in oklab, var(--st-fail) 30%, var(--edge));
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--paper-mute);
  }
  @media (max-width: 720px) {
    .diagram {
      flex-wrap: wrap;
    }
    .thief {
      position: static;
      width: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .thief {
      animation: none;
    }
  }
</style>
