<script lang="ts">
  /* The week against the plan, drawn in the room (§14.3).
   *
   * One small chart per account that has a plan: the readings the week has
   * taken, the line the plan set from its opening to its reset, and where the
   * recent rate puts it at the reset. **The projection is drawn even when it
   * leaves the box**, because a week heading past 100% is the interesting case;
   * the line stops at the top and the sentence carries the figure.
   *
   * Everything it decides is in `pace.ts` (`planWeeksOf`); this file is
   * geometry and paint, the same split the room keeps from `analyticsroom.ts`.
   *
   * Colour: the actual line is ink, the plan is a faint rule, and the
   * projection is amber only where it lands past the plan. A chart that
   * coloured a calm week would spend the one channel status uses.
   */

  import { paceSaid, paceTier, type PlanWeek } from "./pace";
  import { tipOf } from "./tipped.svelte";

  let { weeks, now }: { weeks: readonly PlanWeek[]; now: number } = $props();

  const pct = (v: number) => Math.round(v * 100);
  const xOf = (w: PlanWeek, at: number) => ((at - w.opened) / (w.reset - w.opened)) * 100;
  const yOf = (used: number) => 100 - Math.min(100, Math.max(0, used));

  /** The readings, oldest to newest, in the plot's own 0–100 box. */
  function line(w: PlanWeek): string {
    return w.points.map((p) => `${xOf(w, p.at).toFixed(2)},${yOf(p.used).toFixed(2)}`).join(" ");
  }

  /** From the last reading to where the rate puts the reset. Clamped to the
   *  box at both ends: the chart is the window, and running out is reaching
   *  its top rather than drawing over the page. */
  function will(w: PlanWeek): string {
    const from = Math.max(0, Math.min(100, xOf(w, now)));
    const to = yOf(w.projected * 100);
    return `${from.toFixed(2)},${yOf(w.used).toFixed(2)} 100,${to.toFixed(2)}`;
  }

  /** Eight day boundaries from the opening to the reset, each as the date a
   *  person reads. The last one is the reset itself. */
  function ticks(w: PlanWeek): { x: number; label: string }[] {
    const out: { x: number; label: string }[] = [];
    for (let day = 0; day <= 7; day++) {
      const at = w.opened + day * 24 * 3_600_000;
      out.push({
        x: (day / 7) * 100,
        label: new Date(at).toLocaleDateString("en-GB", { day: "numeric" }),
      });
    }
    return out;
  }

  function said(w: PlanWeek): string {
    return `the week is at ${pct(w.pace.actual)} against a plan of ${pct(w.expected)} by now · ${paceSaid(w.pace)}`;
  }

  function title(w: PlanWeek): string {
    return (
      `${w.account}'s week: ${pct(w.used)}% used against a plan of ${pct(w.expected)}% by now. ` +
      `At the last few hours' rate it lands at ${pct(w.projected)}% by the reset` +
      `${w.projected > 1 ? ", which runs out before it" : ""}. ` +
      `The faint diagonal is the plan; the solid line is the week; the dashed end is where the rate puts it.`
    );
  }
</script>

{#if weeks.length > 0}
  <div class="an-plan" aria-label="the week against the plan">
    {#each weeks as w (w.account)}
      <div class="an-plan-row" {@attach tipOf(() => title(w))}>
        <div class="an-plan-head">
          <span class="an-plan-what">the week against the plan</span>
          <span class="an-plan-who">{w.account}</span>
        </div>
        <div class="an-plan-read">
          <p class="an-plan-said" class:warm={paceTier(w.pace) === "warm"} class:urgent={paceTier(w.pace) === "urgent"}>
            {said(w)}
          </p>
          <span class="an-grow"></span>
          <span class="an-plan-key"><i class="plan"></i>the plan</span>
          <span class="an-plan-key"><i class="was"></i>the week</span>
          <span class="an-plan-key"><i class="will"></i>at this rate</span>
        </div>
        <div class="an-plan-plot">
          <div class="an-plan-y" aria-hidden="true">
            <span>100%</span>
            <span>50%</span>
            <span>0</span>
          </div>
          <div class="an-plan-box">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <line class="grid" x1="0" y1="50" x2="100" y2="50" vector-effect="non-scaling-stroke" />
              <line class="plan" x1="0" y1="100" x2="100" y2="0" vector-effect="non-scaling-stroke" />
              <polyline class="was" points={line(w)} vector-effect="non-scaling-stroke" />
              <polyline
                class="will"
                class:over={w.projected > 1}
                points={will(w)}
                vector-effect="non-scaling-stroke"
              />
              <line
                class="now"
                x1={Math.max(0, Math.min(100, xOf(w, now))).toFixed(2)}
                y1="0"
                x2={Math.max(0, Math.min(100, xOf(w, now))).toFixed(2)}
                y2="100"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </div>
        </div>
        <div class="an-plan-x" aria-hidden="true">
          {#each ticks(w) as t (t.x)}
            <!-- The ends are pulled inside the plot rather than centred on its
                 edge, or half of the first and last date is drawn outside the
                 room. -->
            <span
              style:left={`${t.x}%`}
              style:transform={t.x === 0 ? "none" : t.x === 100 ? "translateX(-100%)" : "translateX(-50%)"}
            >{t.label}</span>
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .an-plan {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin: 0.1rem 0 0.35rem;
  }
  .an-plan-row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .an-plan-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4ch 1.2ch;
    font-size: 0.68rem;
    color: var(--paper-mute);
  }
  .an-plan-key {
    display: inline-flex;
    align-items: center;
    gap: 0.6ch;
    font-size: 0.62rem;
    color: var(--paper-faint);
  }
  .an-plan-key i {
    display: inline-block;
    width: 2.2ch;
    height: 0;
    border-top: 1px solid var(--paper-faint);
  }
  .an-plan-key i.plan {
    border-top-style: dashed;
  }
  .an-plan-key i.was {
    border-top: 1.6px solid var(--paper-dim);
  }
  .an-plan-key i.will {
    border-top: 1.2px dashed var(--paper-faint);
  }
  .an-plan-what {
    text-transform: lowercase;
    letter-spacing: 0.04em;
    color: var(--paper-dim);
  }
  .an-plan-who {
    font-family: var(--util);
  }
  .an-grow {
    flex: 1;
  }
  .an-plan-read {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4ch 1.2ch;
  }
  .an-plan-said {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-mute);
  }
  .an-plan-said.warm {
    color: var(--st-soft);
  }
  .an-plan-said.urgent {
    color: var(--st-fail);
  }
  .an-plan-plot {
    display: flex;
    gap: 0.5ch;
    align-items: stretch;
    height: 76px;
  }
  .an-plan-y {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    width: 4ch;
    padding: 0.1rem 0;
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .an-plan-box {
    flex: 1;
    min-width: 0;
    border-bottom: 1px solid var(--edge);
    border-left: 1px solid var(--edge);
  }
  .an-plan-box svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .grid {
    stroke: var(--edge);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }
  .plan {
    stroke: var(--paper-mute);
    stroke-width: 1;
    stroke-dasharray: 5 4;
  }
  .was {
    fill: none;
    stroke: var(--paper-dim);
    stroke-width: 1.6;
    stroke-linejoin: round;
  }
  .will {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 1.2;
    stroke-dasharray: 2 3;
  }
  .will.over {
    stroke: var(--st-ask);
  }
  .now {
    stroke: var(--paper-faint);
    stroke-width: 1;
    opacity: 0.55;
  }
  .an-plan-x {
    position: relative;
    height: 1.1rem;
    margin-left: calc(4ch + 0.5ch);
    font-family: var(--util);
    font-size: 0.6rem;
    line-height: 1;
    color: var(--paper-faint);
  }
  .an-plan-x span {
    position: absolute;
    top: 0.15rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
</style>
