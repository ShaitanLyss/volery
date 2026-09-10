<script lang="ts">
  /* What this studio is costing, on the wall it is costing it for.
   *
   * The value of a task manager living in here rather than in the taskbar is
   * entirely in the naming: six cards on the wall are six identical
   * `claude.exe` in anybody else's process list, and the one eating a core is
   * the one you want to go and look at. So a row is a *thing on this wall* —
   * a conversation, a dev server, a build — with its whole process tree folded
   * into it, and clicking it goes there.
   *
   * The folding and the formatting are in `perf.ts` and tested; the sampling is
   * one shared `Meter` for however many of these are up. */

  import { Meter } from "./meter.svelte";
  import {
    bytes,
    fold,
    leftover,
    members,
    pct,
    share,
    since,
    top,
    type Row,
  } from "./perf";
  import { rowsFor, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    meter,
    naming,
    onreveal,
  }: {
    widget: Widget;
    meter: Meter;
    /** A role and its opaque reference, as something to read. */
    naming: (role: string, reference: string | null) => string | null;
    /** Go and look at whatever a row is — the card, mostly. */
    onreveal?: (role: string, reference: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const scope = $derived(textOf(widget, "scope", "skein"));
  /* How many lines this one has room for, off its own height — so dragging it
     taller shows more, and the tail line always describes exactly what is not
     on screen rather than what some separate setting said. */
  const wanted = $derived(rowsFor(widget.h));

  /* Asking is what makes the sampler run at all. Two effects rather than one:
     the cleanup of a tracking effect fires on every change, so a single effect
     would release the process table and rebuild it every time a row was added
     or the scope switched. */
  $effect(() => {
    meter.attach(widget.id, { scope, limit: wanted });
  });
  $effect(() => () => meter.detach(widget.id));

  const sample = $derived(meter.latest);
  const rows = $derived(sample ? fold(sample, naming, scope) : []);
  const cut = $derived(
    sample
      ? top(rows, wanted, leftover(sample, scope))
      : { shown: [] as Row[], rest: null as Row | null },
  );

  /* The two totals across the top. In the studio's scope they are what *we* are
     using — the sum of our own rows — rather than the machine's, or the number
     would not move when a card started thinking. */
  const cores = $derived(sample?.cores ?? 1);
  const ourCpu = $derived(
    rows.reduce((n, r) => n + r.cpu, 0) + (cut.rest?.cpu ?? 0),
  );
  const ourMem = $derived(
    rows.reduce((n, r) => n + r.mem, 0) + (cut.rest?.mem ?? 0),
  );
  /* Held as percent-of-one-core, like every row, so the header can be printed
     with the same `pct` and cannot disagree with the lines under it. */
  const headCpu = $derived(scope === "machine" ? (sample?.cpu ?? 0) * cores : ourCpu);
  const headMem = $derived(scope === "machine" ? (sample?.mem_used ?? 0) : ourMem);

  const busiest = $derived(cut.shown[0] ?? null);
  const memShare = $derived(
    sample && sample.mem_total > 0 ? headMem / sample.mem_total : 0,
  );

  function reveal(r: Row) {
    if (r.reference) onreveal?.(r.role, r.reference);
  }

  /* Which row is unfolded, by key rather than by index — the rows re-sort by
     cost on every sample, so an index would wander onto whatever became third
     while you were reading. One at a time: this is a widget, and the height it
     was given is the height it has. */
  let open = $state<string | null>(null);

  /* Only a card's processes can be ended, because only a card's processes are
     provably ours — a job is the proof, and dev servers and project runs each
     have a visible stop of their own already. */
  const openable = (r: Row) => r.count > 1 || r.role === "conversation";
</script>

<div class="perf" data-variant={variant}>
  <header>
    <span class="what">{scope === "machine" ? "the machine" : "this studio"}</span>
    <span class="tot">{pct(headCpu, cores)}</span>
    <span class="tot">{bytes(headMem)}</span>
  </header>

  {#if meter.fault}
    <p class="fault">{meter.fault}</p>
  {:else if !sample}
    <p class="quiet">taking a reading…</p>
  {:else if variant === "gauges"}
    <!-- Two dials and one name. For a widget dropped to the size of a card,
         where a list of seven would be a list of nothing legible. -->
    <div class="dials">
      {#each [{ k: "cpu", v: share(headCpu, cores), t: pct(headCpu, cores) }, { k: "memory", v: memShare, t: bytes(headMem) }] as g (g.k)}
        <div class="dial">
          <div class="arc" style:--v={g.v}></div>
          <span class="val">{g.t}</span>
          <span class="cap">{g.k}</span>
        </div>
      {/each}
    </div>
    {#if busiest}
      <p class="busiest" title={busiest.label}>
        busiest — <b>{busiest.label}</b>
      </p>
    {/if}
  {:else}
    <ul class="rows" class:bars={variant === "bars"} data-scroll>
      {#each cut.shown as r (r.key)}
        <li>
          <span class="line">
            {#if openable(r)}
              <button
                class="open"
                class:on={open === r.key}
                aria-expanded={open === r.key}
                title={open === r.key ? "fold" : "what these are"}
                onclick={() => (open = open === r.key ? null : r.key)}
              ></button>
            {:else}
              <span class="open"></span>
            {/if}
            <button
              class="row"
              data-role={r.role}
              disabled={!r.reference}
              title="{r.label} — {r.count} process{r.count === 1 ? '' : 'es'}"
              onclick={() => reveal(r)}
            >
              <span class="label">{r.label}</span>
              {#if r.count > 1}<span class="n">{r.count}</span>{/if}
              <span class="cpu">{pct(r.cpu, cores)}</span>
              <span class="mem">{bytes(r.mem)}</span>
            </button>
          </span>
          {#if variant === "bars"}
            <span class="bar" style:--v={share(r.cpu, cores)}></span>
          {/if}
          {#if open === r.key && sample}
            <ul class="procs">
              {#each members(sample, r.key) as p (p.pid)}
                <li class="proc" class:orphan={p.orphan}>
                  <span class="pname" title={p.orphan
                    ? "its parent is gone — the sweep takes this within the minute"
                    : `pid ${p.pid}`}>{p.name}</span>
                  <span class="page">{since(p.age)}</span>
                  {#if r.role === "conversation"}
                    <button
                      class="end"
                      title="end this and anything under it"
                      onclick={() => meter.end(p.pid)}>end</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}

      {#if cut.rest}
        <li>
          <span class="row rest">
            <span class="label">{cut.rest.label}</span>
            <span class="cpu">{pct(cut.rest.cpu, cores)}</span>
            <span class="mem">{bytes(cut.rest.mem)}</span>
          </span>
        </li>
      {/if}

      {#if !cut.shown.length}
        <li class="quiet">
          {scope === "machine" ? "nothing running" : "nothing spawned yet"}
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .perf {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    /* Deliberately paints no background of its own — the wrapper fills, and
       leaving it there is what lets the `frame` knob's `bare` reach this face.
       See the ambience note for why the default is opaque at all. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tot {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }

  .rows {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.16rem 0 0;
    list-style: none;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .rows li {
    position: relative;
  }

  .row {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.12rem 0.2rem;
    border: none;
    border-radius: 2px;
    background: none;
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.68rem;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .row:disabled,
  .row.rest {
    cursor: default;
    color: var(--paper-mute);
  }
  .row:not(:disabled):hover {
    background: var(--raised);
    color: var(--paper);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A conversation is the thing this whole app is about, so it is the one row
     that reads at full strength. Still achromatic: it is not a status. */
  .row[data-role="conversation"] .label {
    color: var(--paper);
  }
  .n {
    font-size: 0.58rem;
    color: var(--paper-faint);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 0.2ch;
  }
  /* A disclosure triangle, drawn rather than typed. `▸` falls through to Segoe
     UI Emoji on this machine and comes out blue — the same trap the stop button
     and the ambience layer arrows each avoid. The empty span on rows that do
     not open keeps every label on one left edge. */
  .open {
    flex: 0 0 auto;
    width: 0.8rem;
    height: 0.8rem;
    position: relative;
    border: none;
    background: none;
    padding: 0;
    cursor: pointer;
  }
  span.open {
    cursor: default;
  }
  button.open::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    border-top: 0.22rem solid transparent;
    border-bottom: 0.22rem solid transparent;
    border-left: 0.3rem solid var(--paper-faint);
    transform: translate(-60%, -50%) rotate(0deg);
    transform-origin: 30% 50%;
    transition: transform 90ms ease-out;
  }
  button.open:hover::before {
    border-left-color: var(--paper);
  }
  button.open.on::before {
    transform: translate(-60%, -50%) rotate(90deg);
  }

  .procs {
    margin: 0 0 0.15rem 0.8rem;
    padding: 0;
    list-style: none;
  }
  .proc {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.06rem 0.2rem;
    font-size: 0.62rem;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .pname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .page {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  /* A mute and a mark, never a colour — the reading `set aside` already
     settles. An orphan is not a failure, and rust here would say the card had
     broken when what has happened is that a process lost its parent. */
  .proc.orphan .pname {
    color: var(--paper);
  }
  .proc.orphan::before {
    content: "";
    width: 0.28rem;
    height: 0.28rem;
    border-radius: 50%;
    background: var(--paper-faint);
    align-self: center;
  }
  .end {
    border: none;
    background: none;
    padding: 0 0.2rem;
    color: var(--paper-faint);
    font-family: inherit;
    font-size: 0.58rem;
    cursor: pointer;
    opacity: 0;
  }
  .proc:hover .end,
  .end:focus-visible {
    opacity: 1;
  }
  .end:hover {
    color: var(--paper);
    background: var(--raised);
    border-radius: 2px;
  }
  .cpu,
  .mem {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
  }
  .cpu {
    min-width: 4.2ch;
    text-align: right;
  }
  .mem {
    min-width: 6ch;
    text-align: right;
    color: var(--paper-mute);
  }

  /* The bar is under the row rather than inside it, so the numbers never move
     as it grows. */
  .bar {
    position: absolute;
    left: 0.2rem;
    right: 0.2rem;
    bottom: 0;
    height: 1px;
    background: var(--edge);
  }
  .bar::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--v) * 100%);
    background: var(--paper-faint);
  }

  .dials {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: space-evenly;
    gap: 0.5rem;
    padding: 0.3rem 0;
  }
  .dial {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }
  /* Drawn in CSS rather than as an SVG for the same reason the stop button's
     square is: one shape, no glyph, nothing to fall through to a font. */
  .arc {
    width: min(15cqw, 34cqh);
    height: min(15cqw, 34cqh);
    border-radius: 50%;
    background: conic-gradient(
      var(--paper-dim) calc(var(--v) * 360deg),
      var(--surface) 0
    );
    mask: radial-gradient(circle, transparent 58%, black 59%);
  }
  .val {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--paper);
  }
  .cap {
    font-size: 0.58rem;
    color: var(--paper-mute);
    letter-spacing: 0.06em;
  }
  .busiest {
    margin: 0;
    padding: 0 0.2rem;
    font-size: 0.62rem;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .busiest b {
    font-weight: 500;
    color: var(--paper-dim);
  }

  .quiet,
  .fault {
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    text-align: center;
  }
  .fault {
    color: var(--st-fail);
    text-align: left;
  }
</style>
