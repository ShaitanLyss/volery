<script lang="ts">
  /* A fan-out, and the four resources each child was given.
   *
   * This is the part of the wall that a terminal cannot show at all: when one
   * card opens five, each one can be a different model, at a different
   * effort, on a different account or provider, on a different machine. The
   * point is not that the knobs exist. It is that the coordinator chooses them
   * per piece, in the same call that writes the briefs.
   */
  import room from "./assets/analytics-room.png";
  import {
    ADMISSION_SAID,
    ANALYTICS,
    ASSIGNMENTS,
    ASSIGNMENT_SUMMARY,
    BOOST_SAID,
    COORDINATE,
    SLEEP_SAID,
    USAGE_SAID,
  } from "./showcase";

  let picked = $state(ASSIGNMENTS[1].id);
  let boost = $state(false);
  let ruling = $state<"build" | "ask" | "decline" | "fold">("build");

  const chosen = $derived(ASSIGNMENTS.find((a) => a.id === picked) ?? ASSIGNMENTS[0]);
  const said = $derived(COORDINATE.rulings.find((r) => r.verb === ruling) ?? COORDINATE.rulings[0]);

  const FACTS = [
    { key: "model", at: "model" },
    { key: "effort", at: "effort" },
    { key: "whose money", at: "source" },
    { key: "where it runs", at: "host" },
  ] as const;
</script>

<div class="means">
  <div class="stage">
    <div class="coord">
      <span class="proj">portfolio</span>
      <span class="job">Land the billing split</span>
      <span class="foot"><i></i>coordinator · opus 5.5 · high</span>
    </div>

    <div class="fan"><span>opens five cards, each with its own four choices</span></div>

    <div class="workers" tabindex="-1" data-tour-focus>
      {#each ASSIGNMENTS as a (a.id)}
        <button type="button" class="worker" class:on={picked === a.id} onclick={() => (picked = a.id)}>
          <span class="wjob">{a.job}</span>
          <span class="wspec">{a.model} · {a.effort}</span>
          <span class="wplace">{a.source}</span>
          <span class="whost">{a.host}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="detail" aria-live="polite">
    <div class="dhead">
      <span class="djob">{chosen.job}</span>
      <span class="dsum">{ASSIGNMENT_SUMMARY}</span>
    </div>
    <dl class="dfacts">
      {#each FACTS as f (f.key)}
        <div>
          <dt>{f.key}</dt>
          <dd>{chosen[f.at]}</dd>
        </div>
      {/each}
    </dl>
    <p class="dwhy">{chosen.why}</p>
  </div>

  <!-- The workflow the knobs above exist to serve. A pile of items, one card
       ruling on each, one gate where the work lands. -->
  <div class="coordinate">
    <div class="chead">
      <span class="ctitle">{COORDINATE.title}</span>
      <span class="chint">what happens to each item in the pile</span>
    </div>
    <p class="clede">{COORDINATE.lede}</p>
    <div class="rules" role="group" aria-label="what the coordinator does with an item">
      {#each COORDINATE.rulings as r (r.verb)}
        <button
          type="button"
          class="rule"
          class:on={ruling === r.verb}
          aria-pressed={ruling === r.verb}
          onclick={() => (ruling = r.verb)}
        >
          {r.verb}
        </button>
      {/each}
    </div>
    <p class="rline" aria-live="polite">{said.line}</p>
    <p class="gate"><span class="gmark" aria-hidden="true"></span>{COORDINATE.gate}</p>
  </div>

  <div class="notes">
    <div class="note">
      <div class="nhead">
        <span class="ntitle">boost</span>
        <button type="button" class="switch" class:on={boost} role="switch" aria-checked={boost} onclick={() => (boost = !boost)}>
          <span class="knob" aria-hidden="true"></span>
          <span class="nstate">{boost ? "on" : "off"}</span>
        </button>
      </div>
      <p>{BOOST_SAID}</p>
      {#if boost}
        <p class="lit">The wall keeps going on credits, and the cards it covers wear the look.</p>
      {/if}
    </div>
    <div class="note">
      <span class="ntitle">admission</span>
      <p>{ADMISSION_SAID}</p>
    </div>
    <div class="note">
      <span class="ntitle">sleep</span>
      <p>{SLEEP_SAID}</p>
    </div>
    <div class="note">
      <span class="ntitle">the allowance</span>
      <p>{USAGE_SAID}</p>
    </div>
  </div>

  <!-- The reading that ties the chapter together, at the stage its card says
       to claim it: the recorder is real and running, the interface is not. -->
  <div class="analytics">
    <div class="ahead">
      <span class="atitle">analytics</span>
      <span class="achip">{ANALYTICS.label}</span>
    </div>
    <p class="alede">{ANALYTICS.lede}</p>
    <div class="agrid">
      <figure class="shot">
        <img
          src={room}
          alt="A design of the analytics room: weekly allowance at 61%, spend today, fleet burn, a week charted against the plan, cost by model, burn by hour, cards against cost, and one card's audit with its changes."
        />
        <figcaption>{ANALYTICS.figure}</figcaption>
      </figure>
      <div class="apoints">
        {#each ANALYTICS.points as p (p.title)}
          <div class="apoint">
            <span class="apt">{p.title}</span>
            <span class="apl">{p.line}</span>
          </div>
        {/each}
      </div>
    </div>
    <p class="acaveat">{ANALYTICS.caveat}</p>
    <p class="aafter">{ANALYTICS.after}</p>
  </div>
</div>

<style>
  .means {
    display: grid;
    gap: 14px;
  }
  .stage {
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background:
      radial-gradient(1px 1px at 10px 10px, color-mix(in oklab, var(--paper) 7%, transparent) 99%, transparent) 0 0 / 24px 24px,
      var(--ink);
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .coord {
    justify-self: start;
    width: 240px;
    display: grid;
    gap: 3px;
    padding: 9px 11px;
    border-radius: 8px;
    border: 1px solid color-mix(in oklab, var(--st-work) 48%, var(--edge));
    background: var(--surface);
    box-shadow: 0 0 24px -8px color-mix(in oklab, var(--st-work) 55%, transparent);
  }
  .proj {
    font-size: 8.5px;
    letter-spacing: 0.02em;
    color: var(--paper-faint);
  }
  .job {
    font-size: 11.5px;
    color: var(--paper-dim);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 8.5px;
    color: var(--paper-mute);
  }
  .foot i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    box-shadow: 0 0 6px var(--st-work);
  }
  .fan {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .fan::before {
    content: "";
    width: 14px;
    height: 1px;
    background: var(--rule);
  }
  .fan::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, var(--rule), transparent);
  }
  .workers {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 7px;
    outline: none;
  }
  .worker {
    display: grid;
    gap: 2px;
    padding: 8px 9px;
    text-align: left;
    font: inherit;
    border-radius: 7px;
    border: 1px solid var(--edge);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      box-shadow var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .worker:hover,
  .worker:focus-visible {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 28%);
    outline: none;
  }
  .worker.on {
    border-color: color-mix(in oklab, var(--paper) 45%, var(--edge));
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--paper) 30%, transparent);
  }
  .wjob {
    font-size: 10.5px;
    color: var(--paper-dim);
    line-height: 1.3;
  }
  .worker.on .wjob {
    color: var(--paper);
  }
  .wspec {
    font-size: 9.5px;
    color: var(--paper-mute);
  }
  .wplace,
  .whost {
    font-size: 8.5px;
    color: var(--paper-faint);
  }
  .detail {
    display: grid;
    gap: 8px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: color-mix(in oklab, var(--surface) 55%, transparent);
  }
  .dhead {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .djob {
    font: 400 17px/1.2 var(--display);
    color: var(--paper);
  }
  .dsum {
    margin-left: auto;
    font-size: 10px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .dfacts {
    display: flex;
    gap: 22px;
    margin: 0;
    flex-wrap: wrap;
  }
  .dfacts div {
    display: grid;
    gap: 1px;
  }
  .dfacts dt {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .dfacts dd {
    margin: 0;
    font-size: 11.5px;
    color: var(--paper-dim);
    white-space: nowrap;
  }
  .dwhy {
    margin: 0;
    font: 12px/1.55 var(--body);
    color: var(--paper-mute);
    max-width: 80ch;
  }
  .coordinate {
    display: grid;
    gap: 7px;
    padding: 12px 14px 11px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background:
      linear-gradient(180deg, color-mix(in oklab, var(--raised) 40%, transparent), transparent);
  }
  .chead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .ctitle {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper);
  }
  .chint {
    font-size: 10px;
    color: var(--paper-faint);
  }
  .clede {
    margin: 0;
    font: 12px/1.55 var(--body);
    color: var(--paper-mute);
    max-width: 84ch;
  }
  .rules {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding-top: 2px;
  }
  .rule {
    height: 24px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .rule:hover,
  .rule:focus-visible {
    color: var(--paper-dim);
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 20%);
  }
  .rule.on {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--paper) 40%, var(--edge));
    background: color-mix(in oklab, var(--raised) 60%, transparent);
  }
  .rline {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--paper-dim);
    max-width: 84ch;
  }
  .gate {
    display: flex;
    gap: 8px;
    margin: 0;
    padding-top: 4px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .gmark {
    flex: none;
    align-self: center;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    border: 1px solid var(--paper-faint);
  }
  .analytics {
    display: grid;
    gap: 9px;
    padding: 12px 14px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: var(--ink);
  }
  .ahead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .atitle {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper);
  }
  .achip {
    font-size: 9.5px;
    letter-spacing: 0.03em;
    color: var(--paper-mute);
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--edge);
    background: var(--raised);
  }
  .alede {
    margin: 0;
    font: 12px/1.55 var(--body);
    color: var(--paper-mute);
    max-width: 88ch;
  }
  .agrid {
    display: grid;
    grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .shot {
    margin: 0;
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 8px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
  }
  .shot figcaption {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-faint);
  }
  .apoints {
    display: grid;
    gap: 7px;
  }
  .apoint {
    display: grid;
    gap: 1px;
    padding: 7px 9px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
    background: color-mix(in oklab, var(--surface) 55%, transparent);
  }
  .apt {
    font-size: 10.5px;
    color: var(--paper-dim);
  }
  .apl {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .acaveat {
    margin: 0;
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .aafter {
    margin: 0;
    padding-top: 4px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
    font-size: 11px;
    line-height: 1.5;
    color: var(--paper-mute);
  }
  @media (max-width: 820px) {
    .agrid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .notes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  @media (max-width: 820px) {
    .notes {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .note {
    display: grid;
    gap: 4px;
    padding: 10px 11px;
    border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, transparent);
    background: color-mix(in oklab, var(--well) 35%, transparent);
  }
  .nhead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ntitle {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .note p {
    margin: 0;
    font-size: 11px;
    line-height: 1.52;
    color: var(--paper-mute);
  }
  .note .lit {
    color: color-mix(in oklab, var(--st-ask) 78%, var(--paper-mute));
  }
  .switch {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    padding: 0 6px 0 3px;
    border-radius: 12px;
    border: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 9.5px;
    cursor: pointer;
  }
  .switch.on {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--st-ask) 45%, var(--edge));
  }
  .knob {
    width: 16px;
    height: 12px;
    border-radius: 7px;
    background: var(--rule);
    position: relative;
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .knob::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 2px;
    width: 8px;
    height: 8px;
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
</style>
