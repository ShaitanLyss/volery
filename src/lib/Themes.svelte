<script lang="ts">
  /* The ring, and the knobs of whichever theme is on.
   *
   * Everything here is a thin hand on `ink` (theme.svelte.ts) — this file holds
   * no theme state of its own and computes nothing about a theme, because the
   * catalogue and every decision about it are pure and live in theme.ts where
   * they can be tested. What is genuinely local is the three half-typed things:
   * a name being entered, a value mid-edit, and the word the export button says
   * back. See `.claude/rules/theme.md`.
   *
   * Switching is *live* and there is no preview mode, no apply button and no
   * cancel: the whole point of the feature is comparison, and a panel that made
   * you commit before seeing the result would put a decision where a look
   * belongs. That is affordable only because reverting is exact — `paper` is a
   * theme whose override map is empty, so choosing it is the app with no theme
   * code in it, and it is always one click away at the head of the list. */
  import { ink, KNOB_GROUPS, KNOB_INFO } from "./theme.svelte";
  import { skin, SKIN_GROUPS, SKIN_KNOB_INFO } from "./palette.svelte";
  import type { Entry, Ring } from "./catalogue";

  let { onclose }: { onclose: () => void } = $props();

  /** Which of the two rings is showing.
   *
   *  A tab and not a second panel. The rings are orthogonal — the reading is
   *  set on one and the wall is made of the other — and the gesture the whole
   *  feature exists for is *comparison*, which means holding one still while
   *  you move the other. Two panels would put them side by side and cost the
   *  screen; one panel with a tab keeps the ring you are not moving exactly
   *  where you left it.
   *
   *  Local and not persisted: it is a place in a panel, not a preference, and
   *  a panel that reopens on the tab you used yesterday is one you have to
   *  read before you can use. */
  let axis = $state<"reading" | "skin">("reading");

  /* The seam where the two rings become one. Both hold the same shape over
     disjoint knob sets — see `Ring` in catalogue.ts for why the knobs widen to
     strings here rather than the component being generic over them. */
  const ring = $derived<Ring>((axis === "reading" ? ink : skin) as unknown as Ring);
  const groups = $derived<{ title: string; knobs: string[] }[]>(
    axis === "reading" ? KNOB_GROUPS : SKIN_GROUPS,
  );
  const info = $derived<Record<string, { label: string; takes: string; note: string }>>(
    axis === "reading" ? KNOB_INFO : SKIN_KNOB_INFO,
  );

  /** What this tab calls the thing it lists, for the prose that has to name
   *  it. Two words rather than one generic one — "theme" for a reading and
   *  "skin" for a wall is the vocabulary the rules file already uses, and a
   *  panel that says "entry" would be the only place on the wall that did. */
  const noun = $derived(axis === "reading" ? "theme" : "skin");

  /** The name being typed for a new theme. Local, and cleared on create — a
   *  field that kept its text would offer the same name again next time, which
   *  `freeId` would then quietly number. */
  let naming = $state("");

  /** Which theme's name is being edited, and to what. Two fields rather than
   *  editing the stored label per keystroke: `rename` writes storage and
   *  repaints, and doing that per character means a theme called `d`, `du`,
   *  `dus` in the log of anything watching. */
  let editing = $state<string | null>(null);
  let editLabel = $state("");

  /** What the export button last said back. The panel has no fault bar, and a
   *  word beside the thing that happened beats one at the top of the window —
   *  the same bargain the fence's copy button strikes. */
  let said = $state("");
  let saidTimer = 0;

  function say(word: string) {
    said = word;
    clearTimeout(saidTimer);
    saidTimer = window.setTimeout(() => (said = ""), 1600);
  }

  /* What is actually on the root element for the current theme — the whole
     chain flattened, so a knob an extending theme inherits reads as the value
     it inherits rather than as blank. */
  const over = $derived(ring.over);
  const current = $derived(ring.theme);

  /** The chain, named, for the line under the title. A derived theme that has
   *  lost its base says so here rather than silently drawing without it. */
  const lineage = $derived.by(() => {
    if (!current.from) return null;
    const base = ring.all.find((t) => t.id === current.from);
    return base ? `extends ${base.label}` : `extends ${current.from} — which is gone`;
  });

  function create(how: "extend" | "copy") {
    const label = naming.trim() || `${current.label} mine`;
    naming = "";
    ring.create(label, how, ring.id);
  }

  /** Switch ring. The two half-typed things are cleared on the way across:
   *  an id being renamed or armed for deletion belongs to a ring, and one
   *  carried over is a control pointing at an entry that is not on screen —
   *  which, for the armed delete, is a second click landing somewhere nobody
   *  can see. */
  function pick(next: "reading" | "skin") {
    if (next === axis) return;
    editing = null;
    arming = null;
    naming = "";
    axis = next;
  }

  function commitRename() {
    if (editing) ring.rename(editing, editLabel);
    editing = null;
  }

  /** Which theme's delete is armed, if any.
   *
   *  Two clicks in place rather than a `confirm()`, for one reason of taste and
   *  one of correctness. The taste: an OS dialog over a panel about how the
   *  wall is *set* is the one piece of chrome this app has spent the most
   *  effort not having — `decorations: false`, its own peek instead of a toast,
   *  its own context menu. The correctness: Tauri patches `window.confirm` to
   *  return a **Promise**, and a Promise is always truthy, so `if (confirm(…))`
   *  is a delete that never asks. Arming has neither problem and says more —
   *  the dependents can be named in the button's own words. */
  let arming = $state<string | null>(null);

  /** What deleting this would cost, said out loud rather than discovered.
   *  `resolve` degrades a broken link to "no base", which is the right
   *  behaviour and a bad surprise: a child left pointing at a name that is gone
   *  keeps its own layer and silently loses the one it was built on. */
  function cost(t: Entry<string>): string {
    const kids = ring.children(t.id);
    if (!kids.length) return "delete it";
    return `${kids.map((k) => k.label).join(", ")} ${kids.length === 1 ? "extends" : "extend"} it and will lose that layer`;
  }

  function remove(t: Entry<string>) {
    if (arming !== t.id) {
      arming = t.id;
      return;
    }
    arming = null;
    ring.remove(t.id);
  }

  async function exportAll() {
    if (!ring.customs.length) return say("nothing of yours to copy");
    try {
      await navigator.clipboard.writeText(ring.text());
      say(`copied ${ring.customs.length}`);
    } catch {
      say("no clipboard");
    }
  }

  async function importAll() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return say("no clipboard");
    }
    const n = ring.paste(text);
    /* Zero is the answer for text that is not JSON, for a document with no
       themes in it, and for one whose themes were all unusable — from here
       those are the same event, and naming which would be guessing. */
    say(n ? `took ${n}` : "nothing in that");
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && (editing ? commitRename() : onclose())} />

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag that started inside the panel does not dismiss it. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="panel"
    onmousedown={(e) => {
      e.stopPropagation();
      /* An armed delete is disarmed by any other press in the panel. It is a
         gesture half-made, and one that survived you looking away and doing
         something else would fire on a click you had forgotten was waiting for
         it. This is `mousedown`, which precedes `click`, so it would also clear
         the arming that the delete button's own `click` is about to read — the
         delete button therefore stops propagation on `mousedown` alone. Every
         other control lets it through and so disarms. */
      arming = null;
    }}
    role="dialog"
    aria-label="themes"
    tabindex="-1"
  >
    <div class="head">
      <span class="mark">how it reads</span>
      <span class="grow"></span>
      <span class="hint">{axis === "reading" ? "ctrl+shift+T" : "ctrl+shift+Y"} cycles</span>
      <button class="x" onclick={onclose} title="close">✕</button>
    </div>

    <!-- The two rings. Siblings rather than a hierarchy: neither is a mode of
         the other, and switching tabs must not disturb the ring you are not
         looking at — which is the whole reason they are two rings and not one
         longer list of every combination. -->
    <div class="axes" role="tablist">
      <button
        class="axis"
        class:on={axis === "reading"}
        role="tab"
        aria-selected={axis === "reading"}
        onclick={() => pick("reading")}
      >
        the reading
        <span class="which">{ink.theme.label}</span>
      </button>
      <button
        class="axis"
        class:on={axis === "skin"}
        role="tab"
        aria-selected={axis === "skin"}
        onclick={() => pick("skin")}
      >
        the wall
        <span class="which">{skin.theme.label}</span>
      </button>
    </div>

    {#if axis === "reading"}
      <p class="note">
        How the transcript is set — its ink, its size, its air, its rag. Nothing here is a
        colour: that is the other tab, so a reading and a wall are two choices rather than a
        theme per combination. <b>paper</b> is the app untouched and is always the way back.
      </p>
    {:else}
      <p class="note">
        What the wall is made of — its ground, its ink ramp, its faces, and how much it
        moves. Status colours may move with the ground, because celadon on a pale wall is
        illegible; what they may not do is stop meaning what they mean, and a test holds them
        to their families. <b>studio</b> is the app untouched and is always the way back.
      </p>
    {/if}

    <div class="body">
      <!-- ── the ring ─────────────────────────────────────────────────── -->
      <div class="ring">
        {#each ring.all as t (t.id)}
          <div class="row" class:on={t.id === ring.id}>
            {#if editing === t.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="field name"
                bind:value={editLabel}
                autofocus
                onblur={commitRename}
                onkeydown={(e) => e.key === "Enter" && commitRename()}
              />
            {:else}
              <button
                class="pick"
                onclick={() => {
                  arming = null;
                  ring.set(t.id);
                }}
                title={t.note}
              >
                <span class="label">{t.label}</span>
                <span class="what">{t.note}</span>
              </button>
            {/if}
            {#if !t.builtin && editing !== t.id}
              <button
                class="tiny"
                onclick={() => {
                  editing = t.id;
                  editLabel = t.label;
                }}
                title="rename">rename</button
              >
              <button
                class="tiny go"
                class:armed={arming === t.id}
                onmousedown={(e) => e.stopPropagation()}
                onclick={() => remove(t)}
                title={cost(t)}>{arming === t.id ? "sure?" : "✕"}</button
              >
            {:else if t.builtin}
              <span class="tiny flat" title="a built-in — derive from it to change it"
                >built in</span
              >
            {/if}
          </div>
        {/each}
      </div>

      <!-- ── the knobs of whichever is on ──────────────────────────────── -->
      <div class="knobs">
        <div class="who">
          <span class="label">{current.label}</span>
          {#if lineage}<span class="what">{lineage}</span>{/if}
          {#if current.builtin}
            <span class="what"
              >editing a knob here makes a theme from this one first — a built-in has to keep
              meaning what it says</span
            >
          {/if}
        </div>

        {#each groups as g (g.title)}
          <div class="group">
            <div class="gtitle">{g.title}</div>
            {#each g.knobs as k (k)}
              {@const set = over[k] !== undefined}
              <div class="knob" class:set>
                <label class="kname" for="knob-{k}" title={info[k].note}>
                  {info[k].label}
                </label>
                <input
                  id="knob-{k}"
                  class="field val"
                  value={over[k] ?? ""}
                  placeholder={info[k].takes}
                  spellcheck="false"
                  onchange={(e) => {
                    const v = e.currentTarget.value.trim();
                    /* Empty clears rather than writes an empty declaration, and
                       on a theme that extends something that means "fall back
                       to the base", not "fall back to tokens.css". That is the
                       point of extending — see `withKnob`. */
                    ring.tweak(k, v === "" ? null : v);
                  }}
                />
                <button
                  class="tiny"
                  disabled={!set}
                  title={set ? "clear it" : "not set here"}
                  onclick={() => ring.tweak(k, null)}>↺</button
                >
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <!-- ── making one, and carrying them off the machine ───────────────── -->
    <div class="foot">
      <input
        class="field"
        bind:value={naming}
        placeholder="name a new one"
        spellcheck="false"
        onkeydown={(e) => e.key === "Enter" && create("extend")}
      />
      <button
        class="act"
        onclick={() => create("extend")}
        title="a new theme holding only what you change, following {current.label} as it is edited"
        >extend</button
      >
      <button
        class="act"
        onclick={() => create("copy")}
        title="a new theme with {current.label}'s values inlined, standing alone"
        >copy</button
      >
      <span class="grow"></span>
      {#if said}<span class="said">{said}</span>{/if}
      <button class="act" onclick={exportAll} title="every theme you wrote, to the clipboard"
        >export</button
      >
      <button class="act" onclick={importAll} title="themes from the clipboard, renamed on a clash"
        >import</button
      >
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: min(78ch, 94vw);
    max-height: 80vh;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.6rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .grow {
    flex: 1 1 auto;
  }

  /* The two rings. Achromatic, like every other selection on this wall —
     colour is status, and which tab is showing is not one. The on-state is
     carried by the ground going up a step and the label reaching the top of
     the ink ramp, which is the same pair `.row.on` in the list below uses. */
  .axes {
    display: flex;
    gap: 0.3rem;
    margin: 0.7rem 0 0;
  }
  .axis {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    gap: 0.14rem;
    align-items: flex-start;
    padding: 0.4rem 0.55rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: var(--ch-radius, 4px);
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--paper-mute);
    cursor: pointer;
    text-align: left;
  }
  .axis:hover {
    border-color: var(--rule);
  }
  .axis.on {
    background: var(--raised);
    border-color: var(--rule);
    color: var(--paper);
  }
  /* Which one is on, under the name of the axis — so the tab you are *not*
     looking at still says what it is set to. That is the whole reason the
     rings are separate, and a tab that hid it would make you switch to find
     out. */
  .which {
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .axis.on .which {
    color: var(--paper-mute);
  }
  .hint {
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-mute);
    max-width: 72ch;
  }
  .note b {
    color: var(--paper-dim);
    font-weight: 600;
  }

  /* Two columns: the ring on the left stays put while the knobs on the right
     scroll, because switching theme is the gesture you repeat and it must not
     move under you when the panel it opens is taller than the last one. */
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
    gap: 0.7rem;
    overflow: hidden;
    min-height: 0;
  }
  .ring,
  .knobs {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow-y: auto;
    min-height: 0;
    padding-right: 0.2rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0.1rem 0.15rem;
  }
  .row.on {
    border-color: var(--edge);
    background: var(--ink);
  }
  .pick {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    background: none;
    border: 0;
    padding: 0.25rem 0.35rem;
    text-align: left;
    cursor: pointer;
  }
  .label {
    font-family: var(--body);
    font-size: 0.82rem;
    color: var(--paper-dim);
  }
  .row.on .label {
    color: var(--paper);
  }
  .what {
    font-family: var(--util);
    font-size: 0.63rem;
    line-height: 1.45;
    color: var(--paper-mute);
  }

  .tiny {
    flex: 0 0 auto;
    background: none;
    border: 0;
    padding: 0.15rem 0.3rem;
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .tiny:hover:not(:disabled) {
    color: var(--paper);
  }
  .tiny:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .tiny.flat {
    cursor: default;
  }
  /* Rust is what failure and removal are everywhere else here. */
  .tiny.go:hover {
    color: var(--st-fail);
  }
  /* Armed. Rust outright rather than on hover — the button has stopped being an
     offer and become a thing that will happen if it is clicked again. */
  .tiny.go.armed {
    color: var(--st-fail);
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.1rem 0.15rem 0.3rem;
    border-bottom: 1px solid var(--edge);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding-top: 0.35rem;
  }
  .gtitle {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .knob {
    display: grid;
    grid-template-columns: 9.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.3rem;
  }
  .kname {
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-mute);
    cursor: help;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A knob this theme actually sets, as against one it is inheriting or leaving
     to tokens.css. The difference is the first thing you need from this panel —
     "what did I change" — and it is carried by the label's weight rather than
     by a badge, since a column of badges is a column of furniture. */
  .knob.set .kname {
    color: var(--paper-dim);
  }

  .field {
    min-width: 0;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 0.22rem 0.4rem;
  }
  .field:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .field::placeholder {
    color: var(--paper-faint);
  }
  .field.name {
    flex: 1 1 auto;
    font-family: var(--body);
    font-size: 0.8rem;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.5rem;
    flex: 0 0 auto;
  }
  .foot .field {
    flex: 0 1 16ch;
    font-family: var(--body);
    font-size: 0.78rem;
  }
  .act {
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.24rem 0.55rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-dim);
    cursor: pointer;
  }
  .act:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .said {
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--paper-mute);
  }
</style>
