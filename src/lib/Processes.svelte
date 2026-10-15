<script lang="ts">
  /* Everything one card is holding, and the way to end any of it.
   *
   * The performance widget answers "what is this costing" and unfolds far
   * enough to see why; this answers "what is actually in there", which is a
   * different question and wants a different amount of room. A card's tree is
   * routinely a dozen processes — a `cmd → node` per stdio MCP server, a
   * `conhost`, a `bash` per tool call — and a widget sized to a wall cannot
   * show a dozen of anything without becoming the thing it measures.
   *
   * The list comes from the card's **job**, not from walking parent pointers,
   * and that is what makes it complete: a parent walk goes blind the moment an
   * intermediate process exits, which is precisely the shape of the leaks worth
   * finding. See `jobs::Job::pids`.
   *
   * Ending one is `taskkill /T` — the process and everything under it — because
   * ending a process and orphaning its children is the bug this whole panel
   * came out of. */

  import type { Meter } from "./meter.svelte";
  import { bytes, members, pct, since } from "./perf";

  let {
    meter,
    id,
    title,
    onclose,
  }: {
    meter: Meter;
    /** The conversation whose tree this is. */
    id: string;
    title: string;
    onclose: () => void;
  } = $props();

  /* The panel asks for samples in its own right. A meter that only ran while a
     performance widget happened to be on the wall would make this panel show a
     frozen list, or nothing at all, on most walls. */
  const ASK = "panel:processes";
  $effect(() => {
    meter.attach(ASK, { scope: "skein", limit: 400 });
    return () => meter.detach(ASK);
  });

  const sample = $derived(meter.latest);
  const procs = $derived(sample ? members(sample, `conversation:${id}`) : []);
  const cores = $derived(sample?.cores ?? 1);
  const stray = $derived(procs.filter((p) => p.orphan).length);
</script>

<section class="procs" aria-label="processes">
  <header>
    <h2 title={title}>{title}</h2>
    <button class="close" title="close" onclick={onclose}>close</button>
  </header>

  {#if !sample}
    <p class="quiet">reading the process table…</p>
  {:else if !procs.length}
    <p class="quiet">nothing — this card holds no process</p>
  {:else}
    <ul>
      {#each procs as p (p.pid)}
        <li class:orphan={p.orphan}>
          <span class="name" title="pid {p.pid}">{p.name}</span>
          <span class="pid">{p.pid}</span>
          <span class="age">{since(p.age)}</span>
          <span class="cpu">{pct(p.cpu, cores)}</span>
          <span class="mem">{bytes(p.mem)}</span>
          <button
            class="end"
            title="end this process and anything under it"
            onclick={() => meter.end(p.pid)}>end</button
          >
        </li>
      {/each}
    </ul>

    <!-- Said out loud rather than left to be inferred from the marks. The
         sweep takes these on its own within the minute, so a number here that
         is anything but briefly non-zero means the sweep has stopped — and a
         reaper that died and one with nothing to do look identical. -->
    <p class="foot">
      {procs.length} process{procs.length === 1 ? "" : "es"}{stray
        ? ` · ${stray} answering to nothing, going shortly`
        : ""}
    </p>
  {/if}

  {#if meter.fault}
    <p class="fault">{meter.fault}</p>
  {/if}
</section>

<style>
  .procs {
    position: absolute;
    z-index: 6;
    top: 3.2rem;
    right: 1rem;
    width: min(34rem, 60vw);
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    /* Opaque, like everything else standing on the wall — the ambience is
       drawn behind all of it, and an instrument you can see the weather
       through is not an instrument. */
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    box-shadow: 0 8px 30px color-mix(in srgb, var(--shade) 32%, transparent);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--edge);
  }
  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ul {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.3rem 0;
    list-style: none;
    overflow-y: auto;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto auto auto auto auto;
    align-items: baseline;
    gap: 0.9ch;
    padding: 0.14rem 0.7rem;
    font-size: 0.7rem;
    color: var(--paper-dim);
    white-space: nowrap;
  }
  li:hover {
    background: var(--raised);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pid,
  .age,
  .cpu,
  .mem {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }

  /* A mute and a mark, never a colour. An orphan is not a failure — rust here
     would say the card had broken, when what happened is that a process lost
     the thing above it. */
  li.orphan .name {
    color: var(--paper);
  }
  li.orphan .name::after {
    content: " · answers to nothing";
    color: var(--paper-faint);
    font-size: 0.62rem;
  }

  .end {
    border: none;
    background: none;
    padding: 0 0.25rem;
    color: var(--paper-faint);
    font-family: inherit;
    font-size: 0.62rem;
    cursor: pointer;
    opacity: 0;
  }
  li:hover .end,
  .end:focus-visible {
    opacity: 1;
  }
  .end:hover {
    color: var(--paper);
    background: var(--raised);
    border-radius: 2px;
  }

  .close {
    border: none;
    background: none;
    padding: 0 0.2rem;
    color: var(--paper-faint);
    font-family: inherit;
    font-size: 0.68rem;
    cursor: pointer;
  }
  .close:hover {
    color: var(--paper);
  }

  .quiet,
  .foot,
  .fault {
    margin: 0;
    padding: 0.45rem 0.7rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
  }
  .foot {
    border-top: 1px solid var(--edge);
    color: var(--paper-faint);
  }
  .fault {
    color: var(--rust, var(--paper));
  }
</style>
