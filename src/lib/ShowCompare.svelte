<script lang="ts">
  /* The comparison, as a table somebody can argue with. Every cell carries
   * what the verdict rests on, so the row is not a scoreboard. Volery has
   * "partly" in it on purpose.
   */
  import { COMPARE, COMPARE_NOTE, TOOLS, type Verdict } from "./showcase";

  let lit = $state<number | null>(null);

  const MARK: Record<Verdict, string> = { yes: "yes", partly: "partly", no: "no" };
</script>

<div class="compare">
  <div class="tablewrap">
    <table class="matrix">
      <thead>
        <tr>
          <th scope="col" class="corner">what you need</th>
          {#each TOOLS as t, i (t.id)}
            <th scope="col" class:vol={t.id === "volery"} class={i > 0 ? "tool" : "tool first"}>
              <span class="nm">{t.name}</span>
              <span class="sub">{t.sub}</span>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each COMPARE as r, ri (r.label)}
          <tr class:lit={lit === ri} onpointerenter={() => (lit = ri)} onpointerleave={() => (lit = null)}>
            <th scope="row" class="rowlab">{r.label}</th>
            {#each r.cells as c, ci (TOOLS[ci].id)}
              <td class:vol={TOOLS[ci].id === "volery"}>
                <span class="cell">
                  <span class="v" data-v={c.v} aria-hidden="true">{c.v === "yes" ? "●" : c.v === "partly" ? "◐" : "·"}</span>
                  <span class="s">{c.said}</span>
                  <span class="sr">{MARK[c.v]}</span>
                </span>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="keyrow">
    <span class="lg"><i data-v="yes"></i>does it</span>
    <span class="lg"><i data-v="partly"></i>with a caveat</span>
    <span class="lg"><i data-v="no"></i>does not</span>
  </div>

  <p class="note">{COMPARE_NOTE}</p>
</div>

<style>
  .compare {
    display: grid;
    gap: 12px;
  }
  .tablewrap {
    overflow-x: auto;
    border-radius: 12px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    background: color-mix(in oklab, var(--well) 45%, transparent);
  }
  .matrix {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    min-width: 860px;
  }
  .matrix th,
  .matrix td {
    text-align: left;
    vertical-align: top;
    padding: 8px 10px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
  }
  .matrix thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface);
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    padding-top: 10px;
    padding-bottom: 9px;
  }
  .corner {
    width: 170px;
    font-weight: 400;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .tool .nm {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: var(--paper-dim);
    white-space: nowrap;
  }
  .tool .sub {
    display: block;
    margin-top: 1px;
    font-size: 9px;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  /* Volery's column stays on screen when the table is wider than the window.
     It is the column the chapter is about, and at 800px it used to sit off the
     right edge with nothing saying so. Opaque, or the cells scrolling under it
     would show through. */
  .matrix th.vol {
    right: 0;
    z-index: 3;
    background: linear-gradient(180deg, color-mix(in oklab, var(--st-work) 12%, var(--surface)), var(--surface));
  }
  .matrix th.vol .nm {
    color: var(--st-work);
  }
  .matrix td.vol {
    position: sticky;
    right: 0;
    z-index: 1;
    background: color-mix(in oklab, var(--st-work) 5%, var(--surface));
  }
  .rowlab {
    font-weight: 400;
    font-size: 11px;
    color: var(--paper-mute);
    position: sticky;
    left: 0;
    background: var(--ink);
    z-index: 2;
  }
  tbody tr.lit .rowlab {
    color: var(--paper);
  }
  tbody tr.lit td {
    background: color-mix(in oklab, var(--raised) 42%, transparent);
  }
  tbody tr.lit td.vol {
    background: color-mix(in oklab, var(--st-work) 10%, var(--raised));
  }
  .cell {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .v {
    flex: none;
    font-size: 9px;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .v[data-v="yes"] {
    color: var(--st-work);
  }
  .v[data-v="partly"] {
    color: var(--st-soft);
  }
  .s {
    color: var(--paper-mute);
    line-height: 1.4;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .keyrow {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    padding: 0 2px;
  }
  .lg {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .lg i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .lg i[data-v="yes"] {
    background: var(--st-work);
  }
  .lg i[data-v="partly"] {
    background: var(--st-soft);
  }
  .note {
    margin: 0;
    font: 12.5px/1.62 var(--body);
    color: var(--paper-mute);
    max-width: 78ch;
  }
</style>
