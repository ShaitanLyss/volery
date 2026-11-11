<script lang="ts">
  /* The things around the agents. Ten rows, one detail, because a grid of ten
   * cards would read as a feature list and the useful question is never "what
   * is there" but "what does it need from me, and what can it reach".
   */
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons";
  import { DESK, type DeskThing } from "./showcase";

  const GLYPH: Record<string, IconName> = {
    flyway: "globe",
    screens: "screen",
    phone: "chat",
    browser: "search",
    editor: "pen",
    shell: "term",
    pipelines: "pipe",
    asana: "board",
    spotify: "wave",
    timers: "clock",
  };

  const WHERE: Record<DeskThing["where"], string> = {
    machine: "this machine",
    wire: "another machine",
    service: "a service outside",
  };

  let at = $state("flyway");
  const thing = $derived(DESK.find((d) => d.id === at) ?? DESK[0]);
</script>

<div class="desk">
  <div class="rows" role="listbox" aria-label="the rest of the desk" tabindex="0" data-tour-focus
    onkeydown={(e) => {
      const i = DESK.findIndex((d) => d.id === at);
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        at = DESK[(i + 1) % DESK.length].id;
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        at = DESK[(i - 1 + DESK.length) % DESK.length].id;
      }
    }}
  >
    {#each DESK as d (d.id)}
      <button
        type="button"
        class="row"
        class:on={at === d.id}
        role="option"
        aria-selected={at === d.id}
        onclick={() => (at = d.id)}
      >
        <span class="glyph"><Icon name={GLYPH[d.id] ?? "gear"} small /></span>
        <span class="words">
          <span class="nm">{d.name}</span>
          <span class="ln">{d.line}</span>
        </span>
        <span class="where">{WHERE[d.where]}</span>
      </button>
    {/each}
  </div>

  <div class="fact" aria-live="polite">
    <div class="fhead">
      <span class="fname">{thing.name}</span>
      <span class="fwhere">{WHERE[thing.where]}</span>
    </div>
    <p class="fline">{thing.line}</p>
    <dl class="fdl">
      <div>
        <dt>needs</dt>
        <dd>{thing.needs}</dd>
      </div>
      <div>
        <dt>cost</dt>
        <dd>{thing.cost}</dd>
      </div>
    </dl>
    <p class="fnote">Every row here is optional. A wall with none of them still runs agents.</p>
  </div>
</div>

<style>
  .desk {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
    gap: 16px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .desk {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .rows {
    display: grid;
    gap: 2px;
    padding: 5px;
    border-radius: 11px;
    border: 1px solid color-mix(in oklab, var(--edge) 78%, transparent);
    background: color-mix(in oklab, var(--well) 55%, transparent);
    outline: none;
  }
  .rows:focus-visible {
    border-color: color-mix(in oklab, var(--edge) 50%, var(--paper) 22%);
  }
  .row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    text-align: left;
    font: inherit;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    cursor: pointer;
  }
  .row:hover {
    background: color-mix(in oklab, var(--raised) 55%, transparent);
  }
  .row.on {
    background: linear-gradient(90deg, color-mix(in oklab, var(--raised) 90%, transparent), color-mix(in oklab, var(--raised) 40%, transparent));
    border-color: color-mix(in oklab, var(--edge) 75%, transparent);
  }
  .glyph {
    display: flex;
    color: var(--paper-faint);
  }
  .row.on .glyph {
    color: var(--paper-dim);
  }
  .words {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .nm {
    font-size: 12px;
    color: var(--paper-dim);
  }
  .row.on .nm {
    color: var(--paper);
  }
  .ln {
    font-size: 10.5px;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where {
    font-size: 9px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .fact {
    display: grid;
    gap: 12px;
    padding: 15px 16px 16px;
    border-radius: 12px;
    border: 1px solid color-mix(in oklab, var(--edge) 78%, transparent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    box-shadow: 0 24px 50px -42px var(--shade, #000);
  }
  .fhead {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .fname {
    font: 400 20px/1.2 var(--display);
    color: var(--paper);
  }
  .fwhere {
    margin-left: auto;
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .fline {
    margin: 0;
    font: 13px/1.6 var(--body);
    color: var(--paper-dim);
  }
  .fdl {
    display: grid;
    gap: 9px;
    margin: 0;
    padding-top: 3px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
  }
  .fdl div {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr);
    gap: 10px;
  }
  .fdl dt {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
    padding-top: 2px;
  }
  .fdl dd {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--paper-mute);
  }
  .fnote {
    margin: 0;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
</style>
