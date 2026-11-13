<script lang="ts">
  /* Where the wall's ambience is built.
   *
   * Nothing here knows what an effect is. The rows come from `EFFECTS` and every
   * control is built off a `ParamSpec` — a label, a range, a step and a unit — so
   * a new knob in ambience.ts appears here with no change to this file, and a new
   * effect costs one entry there and one arm in the renderer's draw switch.
   *
   * There is no apply button, on purpose. The whole argument for editing a
   * backdrop live is that you are looking at the thing you are adjusting; a
   * gesture that ends in "now press this" has already lost. Every change is on
   * the wall as you make it and in the database a quarter-second later. */

  import { EFFECTS, specFor, type Ambience } from "./ambience.svelte";
  import { tipOf } from "./tipped.svelte";

  let { ambience }: { ambience: Ambience } = $props();

  const active = $derived(ambience.active);

  /** What a knob's number should read as beside its slider. */
  function shown(value: number, step: number, unit: string): string {
    const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
  }
</script>

<section class="effects" data-effects>
  <div class="head">
    <span class="name">ambience</span>
    {#each ambience.profiles as p (p.id)}
      <button
        class="chip"
        class:on={p.id === ambience.activeId}
        data-profile={p.id}
        {@attach tipOf("Show this one")}
        onclick={() => ambience.use(p.id)}>{p.name}</button
      >
    {/each}
    <!-- Nothing at all is a real choice and should cost one click, not switching
         every layer off one at a time. -->
    <button
      class="chip add"
      class:on={ambience.activeId === null}
      {@attach tipOf("Stop drawing anything")}
      onclick={() => ambience.use(null)}>bare</button
    >
    <button class="chip add" onclick={() => ambience.create()}>+ profile</button>
    <span class="grow"></span>
    {#if active}
      <input
        class="rename"
        value={active.name}
        spellcheck="false"
        {@attach tipOf("What this profile is called")}
        oninput={(e) => ambience.rename(active.id, e.currentTarget.value)}
      />
      <!-- How most profiles get made: you like what is up there and want to try
           something without losing it. -->
      <button class="ghost" onclick={() => ambience.duplicate(active.id)}>copy</button>
      <button class="ghost danger" onclick={() => ambience.destroy(active.id)}>delete</button>
    {/if}
  </div>

  {#if !active}
    <p class="none">
      The wall is bare. Pick a profile, or start one and stack effects on it.
    </p>
  {:else}
    {#each active.layers as l, i (l.id)}
      {@const spec = specFor(l.kind)}
      <div class="layer" data-layer={l.id} data-kind={l.kind}>
        <label class="on" {@attach tipOf(() => (l.on ? "Drawing" : "Kept, but not drawing"))}>
          <input
            type="checkbox"
            checked={l.on}
            onchange={(e) => ambience.setLayer(l.id, { on: e.currentTarget.checked })}
          />
        </label>
        <span class="glabel">{spec?.label ?? l.kind}</span>
        <span class="note">{spec?.note ?? ""}</span>
        <span class="grow"></span>

        <label class="op" {@attach tipOf("How strongly this layer draws")}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={l.opacity}
            oninput={(e) => ambience.setLayer(l.id, { opacity: Number(e.currentTarget.value) })}
          />
          <em>{Math.round(l.opacity * 100)}%</em>
        </label>

        <!-- Order is paint order: the first layer is furthest back. This is what
             puts the leaves in front of the swirls.
             Words rather than arrows: `↑` falls through to Segoe UI Emoji and
             renders *blue*, and colour on this wall is status. -->
        <button
          class="ghost"
          disabled={i === 0}
          {@attach tipOf("Draw this layer further back")}
          onclick={() => ambience.moveLayer(l.id, -1)}>back</button
        >
        <button
          class="ghost"
          disabled={i === active.layers.length - 1}
          {@attach tipOf("Draw this layer further forward")}
          onclick={() => ambience.moveLayer(l.id, 1)}>front</button
        >
        <button
          class="ghost"
          class:on={ambience.open === l.id}
          onclick={() => (ambience.open = ambience.open === l.id ? null : l.id)}
          >{ambience.open === l.id ? "close" : "adjust"}</button
        >
        <button class="ghost danger" {@attach tipOf("Remove this layer")} onclick={() => ambience.removeLayer(l.id)}
          >×</button
        >
      </div>

      {#if ambience.open === l.id && spec}
        <div class="knobs">
          {#each spec.params as q (q.key)}
            <label class="knob" data-knob={q.key}>
              <span class="klabel">{q.label}</span>
              {#if q.toggle}
                <input
                  class="flag"
                  type="checkbox"
                  checked={l.params[q.key] > 0.5}
                  onchange={(e) =>
                    ambience.setParam(l.id, q.key, e.currentTarget.checked ? 1 : 0)}
                />
                <em>{l.params[q.key] > 0.5 ? "yes" : "no"}</em>
              {:else}
                <input
                  type="range"
                  min={q.min}
                  max={q.max}
                  step={q.step}
                  value={l.params[q.key]}
                  oninput={(e) => ambience.setParam(l.id, q.key, Number(e.currentTarget.value))}
                />
                <em>{shown(l.params[q.key], q.step, q.unit ?? "")}</em>
              {/if}
            </label>
          {/each}
          <!-- Ten sliders is easy to get lost in, and a way back is cheaper than
               an undo stack. -->
          <button class="ghost reset" onclick={() => ambience.resetLayer(l.id)}
            >back to defaults</button
          >
        </div>
      {/if}
    {/each}

    <div class="add-layer">
      <span class="name">stack another</span>
      {#each EFFECTS as e (e.kind)}
        <button class="chip add" {@attach tipOf(() => (e.note))} onclick={() => ambience.addLayer(e.kind)}
          >+ {e.label}</button
        >
      {/each}
    </div>
  {/if}

  {#if ambience.fault}
    <p class="none fail">{ambience.fault}</p>
  {/if}
</section>

<style>
  .effects {
    flex: 0 0 auto;
    max-height: 42vh;
    overflow-y: auto;
    border-bottom: 1px solid var(--edge);
    background: var(--well);
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    position: relative;
    z-index: 1;
  }

  .head,
  .add-layer {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .name {
    font-family: var(--util);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-dim);
    margin-right: 0.2rem;
  }
  .grow {
    flex: 1 1 auto;
  }
  .none {
    margin: 0;
    font-family: var(--util);
    font-size: 0.76rem;
    color: var(--paper-faint);
  }
  .none.fail {
    color: var(--st-fail);
  }

  /* The same chip the territories use, so "a thing you can press on this wall"
     looks like one thing wherever it is. */
  .chip {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.14rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .chip:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .chip.on {
    color: var(--paper);
    border-color: var(--paper-faint);
    background: var(--raised);
  }
  .chip.add {
    color: var(--paper-faint);
    border-style: dashed;
  }
  .chip.add:hover,
  .chip.add.on {
    color: var(--paper);
    border-style: solid;
  }

  .rename {
    font-family: var(--util);
    font-size: 0.72rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.16rem 0.4rem;
    width: 14ch;
  }

  .layer {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--util);
    font-size: 0.72rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.28rem 0.45rem;
  }
  .glabel {
    color: var(--paper);
    font-weight: 600;
    white-space: nowrap;
  }
  /* The one line saying what it does, next to the thing it does it to. */
  .note {
    color: var(--paper-faint);
    font-size: 0.68rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .on {
    display: inline-flex;
    align-items: center;
    cursor: pointer;
  }

  .op {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .op input {
    width: 68px;
  }
  em {
    font-style: normal;
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    min-width: 6ch;
  }

  /* The knobs of one layer. A grid rather than a list: ten of them in a column
     is a wall of controls, and every one of them is short. */
  .knobs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 0.2rem 0.7rem;
    padding: 0.4rem 0.5rem 0.5rem;
    margin: -0.2rem 0 0.2rem;
    border: 1px solid var(--edge);
    border-top: 0;
    border-radius: 0 0 3px 3px;
    background: color-mix(in srgb, var(--surface) 55%, var(--well));
  }
  .knob {
    display: grid;
    /* The label column is fixed so the sliders line up down the grid and can be
       scanned as one thing — and wide enough for the longest label there is
       ("gusts every"), because a knob called "gusts e…" is a knob you have to
       hover to identify. */
    grid-template-columns: 11ch 1fr auto;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--util);
    font-size: 0.68rem;
  }
  .klabel {
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .knob input[type="range"] {
    width: 100%;
    min-width: 0;
  }
  .flag {
    justify-self: start;
  }
  .reset {
    grid-column: 1 / -1;
    justify-self: start;
    margin-top: 0.25rem;
  }

  /* Sliders, in the studio's own greys. Chromium's default is a blue nobody
     asked for, and blue on this wall would read as a status. */
  input[type="range"] {
    appearance: none;
    height: 3px;
    background: var(--edge);
    border-radius: 2px;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--paper-mute);
    border: 0;
  }
  input[type="range"]:hover::-webkit-slider-thumb {
    background: var(--paper);
  }
  input[type="checkbox"] {
    accent-color: var(--paper-mute);
    cursor: pointer;
  }

  .ghost {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.1rem 0.38rem;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .ghost:disabled {
    color: var(--paper-faint);
    opacity: 0.5;
    cursor: default;
  }
  .ghost.on {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .ghost.danger:hover {
    color: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
  }
</style>
