<script lang="ts">
  /* The behaviour tab's table, shared by both presentations.
   *
   * One table with four groupings (§11.9): every call, the MCP servers alone,
   * the skills invoked by name, and the subagents. The grouping is the caller's
   * — it arrives as `view` — and this file decides only order and how a null
   * reads. Two tables with two column decisions is exactly how a skin change
   * becomes a data change, so both presentations mount this.
   *
   * **A dash means the measure does not exist; a measured zero is a zero.** No
   * completed call has no percentile, and a cost no turn claimed is not free,
   * so both print a dash with the reason in the cell's title. A healthy tool's
   * error count and a zero-byte result are readings and print as `0`. Sorting
   * puts a dash last whichever way the column runs, because a dash at the top
   * of a descending column is a reader asking why.
   */
  import { count } from "./usage";
  import {
    TOOL_VIEWS,
    bytesSaid,
    cellOf,
    columnsFor,
    sortToolLines,
    type ToolColumn,
    type ToolLine,
    type ToolSort,
    type ToolView,
  } from "./analyticsbehaviour";

  let {
    lines,
    view = "tools",
    compact = false,
  }: {
    lines: ToolLine[];
    view?: ToolView;
    /** The page sets this: the same columns, tighter. */
    compact?: boolean;
  } = $props();

  let sort = $state<ToolSort>("calls");
  let dir = $state<"asc" | "desc">("desc");

  /* The sort is the table's own and resets when the grouping changes: `Skill`
     ordered by p95 is a question about one row, and carrying the head across a
     view change would leave a column lit that the reader did not choose here. */
  let sortFor = $state<ToolView>("tools");
  $effect(() => {
    if (sortFor === view) return;
    sortFor = view;
    sort = "calls";
    dir = "desc";
  });

  const columns = $derived(columnsFor(view));
  const rows = $derived(sortToolLines(lines, sort, dir));

  function head(column: ToolColumn) {
    if (sort === column.key) dir = dir === "desc" ? "asc" : "desc";
    else {
      sort = column.key;
      /* A name reads A to Z first; a measure reads biggest first. */
      dir = column.key === "name" ? "asc" : "desc";
    }
  }

  /** The number behind a dash, said on the cell so the reason is never a guess. */
  function cellTitle(line: ToolLine, key: ToolSort): string | undefined {
    switch (key) {
      case "p50":
        return !line.p50
          ? "no call completed, so there is no latency to take a median of"
          : line.p50.basis === "buckets"
            ? "estimated from hourly latency bands"
            : "exact over tool rows";
      case "p95":
        return !line.p95
          ? "no call completed, so there is no latency to take a percentile of"
          : line.p95.basis === "buckets"
            ? "estimated from hourly latency bands"
            : "exact over tool rows";
      case "errorRate":
        return line.errorRate === null
          ? "no calls in this window"
          : `${count(line.errors)} failed of ${count(line.calls)}`;
      case "errors":
        return line.errors > 0
          ? `${count(line.errors)} of ${count(line.calls)} calls returned an error`
          : "no call returned an error";
      case "cost":
        return line.cost > 0 ? "apportioned from the turn that made the call" : "no turn claimed these calls";
      case "bytes":
        return line.bytes > 0 ? bytesSaid(line.bytes) : "no bytes came back from these calls";
      default:
        return undefined;
    }
  }
</script>

<div class="bh-tblwrap">
  <table class="bh-table" aria-label={`${TOOL_VIEWS.find((v) => v.key === view)?.label ?? "tools"} in this window`}>
    <thead>
      <tr>
        {#each columns as column (column.key)}
          <th
            scope="col"
            class:bh-num={column.numeric}
            aria-sort={sort === column.key ? (dir === "asc" ? "ascending" : "descending") : "none"}
          >
            <button type="button" title={`sort by ${column.label}`} onclick={() => head(column)}>
              {compact ? column.short : column.label}
              {#if sort === column.key}<span class="bh-arrow" aria-hidden="true">{dir === "asc" ? "↑" : "↓"}</span>{/if}
            </button>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as line (line.key)}
        <tr>
          {#each columns as column (column.key)}
            {#if column.key === "name"}
              <th scope="row" class="bh-name" title={line.kind === "mcp" ? `mcp · ${line.server}` : line.kind}>
                <span class="bh-what">{line.name}</span>
                {#if view === "tools"}
                  {#if line.server}
                    <span class="bh-server">{line.server}</span>
                  {:else if line.kind === "builtin"}
                    <span class="bh-server bh-builtin" title="a built-in has no server">built-in</span>
                  {:else}
                    <!-- A skill or a subagent is not a built-in with no server:
                         emptiness means the kind, and the kind is said. -->
                    <span class="bh-server bh-builtin">{line.kind}</span>
                  {/if}
                {/if}
              </th>
            {:else}
              <td class:bh-num={column.numeric} title={cellTitle(line, column.key)}>{cellOf(line, column.key)}</td>
            {/if}
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .bh-tblwrap {
    overflow-x: auto;
    scrollbar-width: thin;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 60%, transparent);
  }
  .bh-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-dim);
  }
  .bh-table th,
  .bh-table td {
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
  }
  .bh-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: color-mix(in oklab, var(--raised) 92%, var(--paper) 4%);
    font-size: 9.5px;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
    font-weight: 400;
    padding: 0;
  }
  .bh-table thead button {
    width: 100%;
    padding: 6px 10px;
    text-align: inherit;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .bh-table thead button:hover,
  .bh-table thead button:focus-visible {
    color: var(--paper);
  }
  .bh-table thead button:focus-visible {
    outline: 1px solid var(--accent, var(--paper-faint));
    outline-offset: -2px;
  }
  .bh-num {
    text-align: right !important;
    font-variant-numeric: tabular-nums;
  }
  .bh-table tbody tr:last-child th,
  .bh-table tbody tr:last-child td {
    border-bottom: 0;
  }
  .bh-table tbody tr:hover {
    background: color-mix(in oklab, var(--raised) 82%, var(--paper) 2%);
  }
  .bh-name {
    font-weight: 400;
    color: var(--paper);
  }
  .bh-what {
    font-family: var(--cv-ui, var(--util));
  }
  .bh-server {
    margin-left: 7px;
    font-size: 10px;
    color: var(--paper-faint);
  }
  .bh-builtin {
    font-style: italic;
    opacity: 0.55;
  }
  .bh-arrow {
    margin-left: 3px;
    color: var(--paper-faint);
  }
</style>
