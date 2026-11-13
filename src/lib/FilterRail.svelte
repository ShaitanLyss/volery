<script lang="ts">
  /* The filter rail (§11.3): one row of dimensions above the chart, a chip for
     each one that carries a choice, and a searchable picker for the values.
     Everything it decides is in `filterrail.ts`; this file is geometry, focus
     and paint, the split the room keeps from `analyticsroom.ts`.

     **Three states per value, walked by one key.** Off, included, excluded:
     Enter (or a click) steps one way round, alt-click jumps to excluded. A
     checkbox needs a second gesture for "not this", and "hide DeepSeek" is the
     thing people actually want, so it cannot be the hidden one.

     **An empty pick removes the dimension.** An empty list already means *none
     of them*, which is a different question from *all of them* (§9.1), and the
     rail must not be able to ask the first by accident. So the last value
     switched off takes its dimension with it.

     The values come from the rows the surface already read: no query is spent
     on a picker, and a dimension with nothing in it this window is not offered
     at all — which is also how a session filter disappears over a year, since
     an hourly row carries no session. */
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import type { Dimension, Filter, UsageRow } from "./analytics";
  import {
    ALL,
    activeOf,
    chipSaid,
    countOf,
    dropped,
    labelOf,
    stored,
    toggled,
    valuesOf,
    withDimension,
  } from "./filterrail";
  import { tipOf } from "./tipped.svelte";

  let {
    filter,
    rows,
    onchange,
  }: {
    filter: Filter;
    /** The window's rows after nothing: the picker offers what exists, unfiltered,
     *  so un-excluding a value is always possible. */
    rows: readonly UsageRow[];
    onchange: (next: Filter) => void;
  } = $props();

  const active = $derived(activeOf(filter));
  /* Offered only where this window has something to choose between. A picker
     with one value is a menu that cannot change an answer. */
  const offered = $derived(ALL.filter((d) => valuesOf(rows, d.dim).length > 0));

  let picking = $state<Dimension | null>(null);
  let adding = $state(false);
  let query = $state("");
  let at = $state(0);
  let search = $state<HTMLInputElement>();
  let root = $state<HTMLElement>();

  const values = $derived.by(() => {
    if (!picking) return [];
    const all = valuesOf(rows, picking);
    const q = query.trim().toLowerCase();
    return q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
  });

  const chosen = $derived(picking ? (filter[picking] ?? []) : []);

  function stateOf(value: string): "off" | "in" | "out" {
    if (chosen.includes(stored(value, true))) return "out";
    if (chosen.includes(value)) return "in";
    return "off";
  }

  function set(next: Filter) {
    onchange(next);
  }

  function open(dim: Dimension) {
    picking = dim;
    adding = false;
    query = "";
    at = 0;
    void tick().then(() => search?.focus());
  }

  function shut(refocus = true) {
    const was = picking;
    picking = null;
    adding = false;
    query = "";
    if (refocus && was) {
      void tick().then(() => root?.querySelector<HTMLElement>(`[data-chip="${was}"]`)?.focus());
    }
  }

  /** Off → in → out → off. One gesture, three readings, and the last one takes
   *  the dimension away when nothing is left. */
  function cycle(value: string, force?: "in" | "out") {
    if (!picking) return;
    const now = stateOf(value);
    let values: string[];
    if (force === "out" && now !== "out") values = toggled(chosen, value, true);
    else if (now === "off") values = toggled(chosen, value, false);
    else if (now === "in") values = toggled(chosen, value, true);
    else values = dropped(chosen, value);
    set(withDimension(filter, picking, values));
  }

  function remove(dim: Dimension) {
    set(withDimension(filter, dim, []));
    if (picking === dim) shut(false);
  }

  /* The picker is a list with a field: the arrows walk it, Enter steps the
     highlighted value, Escape closes. Typing filters, which is the whole reason
     the field is there — an account list is longer than the box. */
  function pickerKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      shut();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      at = Math.max(0, Math.min(values.length - 1, at + step));
      void tick().then(() => root?.querySelector<HTMLElement>(`[data-value="${at}"]`)?.scrollIntoView({ block: "nearest" }));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const value = values[at];
      if (value !== undefined) cycle(value, e.altKey ? "out" : undefined);
    }
  }

  function addKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      adding = false;
      void tick().then(() => root?.querySelector<HTMLElement>("[data-add]")?.focus());
    }
  }

  /** Focus for `f`, which the shell routes here (§11.5). The first chip, or the
   *  way to make one. */
  export function focus(): void {
    void tick().then(() => {
      root?.querySelector<HTMLElement>("[data-chip], [data-add]")?.focus();
    });
  }
</script>

<div class="rail" bind:this={root} role="group" aria-label="filters">
  <span class="label">filters</span>

  {#each active as a (a.dim)}
    <span class="chipbox">
      <button
        type="button"
        class="chip"
        class:on={picking === a.dim}
        data-chip={a.dim}
        {@attach tipOf(() => (`${chipSaid(a.dim, a.values)} · click to change it (f reaches these)`))}
        onclick={() => (picking === a.dim ? shut() : open(a.dim))}
        onkeydown={(e) => {
          if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            e.stopPropagation();
            remove(a.dim);
          }
        }}
        >{chipSaid(a.dim, a.values)}</button
      >
      <button
        type="button"
        class="x"
        {@attach tipOf(() => (`remove the ${labelOf(a.dim)} filter`))}
        aria-label={`remove the ${labelOf(a.dim)} filter`}
        onclick={() => remove(a.dim)}><Icon name="x" small /></button
      >
    </span>
  {:else}
    <span class="none">nothing narrowed</span>
  {/each}

  {#if offered.length}
    <button
      type="button"
      class="add"
      data-add
      {@attach tipOf("narrow by another dimension")}
      onclick={() => {
        adding = !adding;
        picking = null;
      }}>+ filter</button
    >
  {/if}

  {#if countOf(filter)}
    <button type="button" class="clear" {@attach tipOf("drop every filter")} onclick={() => set({})}>clear</button>
  {/if}

  {#if picking}
    <div
      class="picker"
      role="dialog"
      tabindex="-1"
      aria-label={`${labelOf(picking)} filter`}
      onkeydown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        shut();
      }}
    >
      <div class="top">
        <span class="what">{labelOf(picking)}</span>
        <span class="grow"></span>
        <span class="hint">enter includes, again excludes</span>
      </div>
      <input
        bind:this={search}
        bind:value={query}
        type="text"
        placeholder={`search ${valuesOf(rows, picking).length} values`}
        aria-label={`search ${labelOf(picking)} values`}
        onkeydown={pickerKey}
        oninput={() => (at = 0)}
      />
      {#if values.length === 0}
        <p class="empty">nothing in this window matches that.</p>
      {:else}
        <ul role="listbox" aria-label={labelOf(picking)} aria-multiselectable="true">
          {#each values as value, i (value)}
            {@const state = stateOf(value)}
            <li
              role="option"
              aria-selected={state !== "off"}
              tabindex="-1"
              data-value={i}
              class:hot={at === i}
              class:in={state === "in"}
              class:out={state === "out"}
              onmouseenter={() => (at = i)}
              onclick={(e) => cycle(value, e.altKey ? "out" : undefined)}
              onkeydown={() => {}}
            >
              <span class="mark" aria-hidden="true">{state === "in" ? "✓" : state === "out" ? "✕" : ""}</span>
              <span class="name">{value}</span>
              {#if state === "out"}<span class="word">not</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if adding}
    <div
      class="picker chooser"
      role="dialog"
      tabindex="-1"
      aria-label="narrow by"
      onkeydown={addKey}
    >
      <div class="top"><span class="what">narrow by</span></div>
      <ul role="listbox" aria-label="dimensions">
        {#each offered as d (d.dim)}
          <li
            role="option"
            aria-selected="false"
            tabindex="0"
            onclick={() => open(d.dim)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open(d.dim);
              }
            }}
          >
            <span class="name">{d.label}</span>
            <span class="word">{valuesOf(rows, d.dim).length}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .rail {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px;
    font: 12px var(--cv-ui, var(--util));
  }
  .label {
    color: var(--paper-faint);
    margin-right: 2px;
  }
  .none {
    color: var(--paper-faint);
    font-style: italic;
  }
  .chipbox {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--edge);
    border-radius: 7px;
    overflow: hidden;
    background: color-mix(in oklab, var(--paper) 6%, transparent);
  }
  .chip {
    border: 0;
    background: transparent;
    color: var(--paper);
    font: inherit;
    padding: 3px 8px;
    cursor: pointer;
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.on,
  .chip:hover {
    background: color-mix(in oklab, var(--paper) 9%, transparent);
  }
  .x {
    border: 0;
    border-left: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-mute);
    padding: 0 5px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .x:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 9%, transparent);
  }
  .add,
  .clear {
    border: 1px dashed var(--edge);
    border-radius: 7px;
    background: transparent;
    color: var(--paper-dim);
    font: inherit;
    padding: 3px 9px;
    cursor: pointer;
  }
  .clear {
    border-style: solid;
  }
  .add:hover,
  .clear:hover {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .chip:focus-visible,
  .x:focus-visible,
  .add:focus-visible,
  .clear:focus-visible,
  li:focus-visible {
    outline: 1px solid var(--paper-faint);
    outline-offset: 1px;
  }

  .picker {
    position: absolute;
    top: calc(100% - 4px);
    left: 16px;
    z-index: 12;
    width: min(320px, 100%);
    max-height: 320px;
    display: flex;
    flex-direction: column;
    padding: 8px;
    gap: 6px;
    border-radius: 9px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: var(--raised);
    box-shadow: 0 18px 40px -18px color-mix(in srgb, var(--shade) 90%, transparent);
  }
  .picker.chooser {
    width: min(240px, 100%);
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .what {
    color: var(--paper);
  }
  .grow {
    flex: 1;
  }
  .hint {
    color: var(--paper-faint);
    font-size: 11px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--edge);
    border-radius: 6px;
    background: color-mix(in oklab, var(--paper) 4%, transparent);
    color: var(--paper);
    font: inherit;
    padding: 4px 7px;
  }
  input:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    min-height: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 6px;
    color: var(--paper-dim);
    cursor: pointer;
    white-space: nowrap;
  }
  li.hot {
    background: color-mix(in oklab, var(--paper) 8%, transparent);
    color: var(--paper);
  }
  li.out .name {
    text-decoration: line-through;
    text-decoration-color: var(--paper-faint);
  }
  .mark {
    width: 12px;
    text-align: center;
    color: var(--paper-mute);
  }
  li.in .mark {
    color: var(--st-work);
  }
  li.out .mark {
    color: var(--st-fail);
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .word {
    color: var(--paper-faint);
    font-size: 11px;
  }
  .empty {
    margin: 2px 0 4px;
    color: var(--paper-faint);
  }
</style>
