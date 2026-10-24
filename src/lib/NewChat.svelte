<script lang="ts">
  /* A new conversation (`docs/chat-mode.md` §6.3, `docs/chat-mode/empty.html`):
     a greeting, the message box in the middle of the sheet, and on it the one
     choice a new conversation asks for — **where it works** — as a chip with a
     default, the last place you used, so a returning person types and sends.
     Three suggestions that change with the place, and a quiet line about what
     is still running elsewhere.

     The sheet with nothing selected *is* this: Ctrl+Shift+O and *new
     conversation* clear the selection, and the first send opens the card
     (`Starter.start`) and hands the draft to the composer, the one send path.
     The draft is the window's one `Field`, so what is typed here survives
     reading another conversation and coming back. */
  import PromptBox from "./PromptBox.svelte";
  import PickMenu, { type PickRow } from "./PickMenu.svelte";
  import ModelMenu from "./ModelMenu.svelte";
  import GettingReady from "./GettingReady.svelte";
  import Icon from "./Icon.svelte";
  import { onMount } from "svelte";
  import type { Skein } from "./skein.svelte";
  import type { Field } from "./field.svelte";
  import type { Composer } from "./composer.svelte";
  import type { Starter } from "./starting.svelte";
  import type { ChatRow, Group } from "./chatview";
  import {
    choosesMachine,
    ideasFor,
    machineOptions,
    placeLabel,
    placesOf,
    placesOn,
    samePlace,
    type Place,
  } from "./starting";

  let {
    skein,
    field,
    composer,
    starter,
    rows,
    groups,
  }: {
    skein: Skein;
    field: Field;
    composer: Composer;
    starter: Starter;
    rows: ChatRow[];
    groups: Group[];
  } = $props();

  const projects = $derived(
    skein.projects.filter((p) => !skein.isChatHome(p.root_path)).map((p) => ({ name: p.name, dir: p.root_path })),
  );
  /* The row of the wall the conversation is bound for, when it is not this one. */
  const there = $derived(starter.machine === null ? null : (starter.roster.find((r) => r.host === starter.machine) ?? null));
  const options = $derived(there ? placesOn(there, rows, starter.place) : placesOf(projects, rows, starter.place));
  let placing = $state(false);
  let machining = $state(false);
  /* Drawn only when another machine could take the work: one machine is nothing
     to choose between. */
  const machined = $derived(choosesMachine(starter.roster));
  const machineRows = $derived<PickRow[]>(
    machineOptions(starter.roster, starter.place).map((m) => ({
      id: m.host ?? "",
      label: m.label,
      note: m.note || undefined,
      icon: "wall" as const,
      on: m.host === starter.machine,
      off: !m.ok,
    })),
  );

  const pickRows = $derived<PickRow[]>([
    ...options.map((o) => ({
      id: key(o.place),
      label: o.label,
      note: o.note || undefined,
      aside: o.count ? String(o.count) : "",
      icon: o.place.kind === "chat" ? ("globe" as const) : ("folder" as const),
      on: samePlace(o.place, starter.place),
      sep: o.place.kind === "chat" && options.length > 1,
    })),
    /* Another machine opens only in the projects it holds. */
    ...(there ? [] : [{ id: "open", label: "open a folder…", aside: "ctrl O", icon: "plus" as const }]),
  ]);

  function pickMachine(id: string) {
    machining = false;
    starter.chooseMachine(id === "" ? null : id, projects, rows);
    void composer.focus();
  }

  function key(p: Place): string {
    return p.kind === "chat" ? "chat" : p.kind === "project" ? `p:${p.name}` : `f:${p.dir}`;
  }

  function pick(id: string) {
    placing = false;
    if (id === "open") {
      void starter.pickFolder().then(() => composer.focus());
      return;
    }
    const o = options.find((x) => key(x.place) === id);
    if (o) starter.choose(o.place);
    void composer.focus();
  }

  const needs = $derived(groups.find((g) => g.key === "needs")?.rows.length ?? 0);
  const working = $derived(groups.find((g) => g.key === "working")?.rows.length ?? 0);
  const blocked = $derived(starter.ready === "missing" || starter.ready === "signed-out");
  const empty = $derived(!field.text.trim());

  /* A machine that went quiet while chosen is this machine again. */
  $effect(() => {
    starter.settleMachine(projects, rows);
  });

  onMount(() => {
    starter.settle(projects, rows);
    if (starter.auth === null) void starter.check();
    void composer.focus();
  });

  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      if (!blocked) void starter.start();
      return;
    }
    if (e.altKey && !e.ctrlKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      e.stopPropagation();
      if (starter.place.kind !== "chat" && !there) starter.plan = !starter.plan;
      return;
    }
    composer.key(e);
  }

  /* The place menu's own key, from anywhere while the empty sheet is up. */
  function onWindowKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      placing = !placing;
    }
    /* The machine's, the `e` family's letter: elsewhere. */
    if (machined && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault();
      placing = false;
      machining = !machining;
    }
  }

  function idea(text: string) {
    field.text = text;
    field.caret = null;
    void composer.focus();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="hello">
  <svg class="big" viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="nc-markg" x1="0.15" y1="0.95" x2="0.9" y2="0.1">
        <stop offset="0" stop-color="var(--st-work)" />
        <stop offset="1" stop-color="var(--st-ask)" />
      </linearGradient>
    </defs>
    <circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--edge)" stroke-width="3.4" />
    <path d="M12 3.8a8.2 8.2 0 1 1-8 6.4" fill="none" stroke="url(#nc-markg)" stroke-width="3.4" stroke-linecap="round" />
  </svg>
  <h1>what are we working on?</h1>

  <GettingReady {starter} />

  <form
    class="box"
    aria-label="a new conversation"
    onsubmit={(e) => {
      e.preventDefault();
      if (!blocked) void starter.start();
    }}
  >
    <PromptBox
      bind:text={field.text}
      bind:el={composer.input}
      shots={field.shots}
      name="prompt"
      accepts={() => true}
      oncaret={(c) => (field.caret = c)}
      onkeydown={onkey}
      oninput={composer.edited}
      placeholder="describe it the way you'd tell a person — drop files or pictures anywhere"
      spellcheck={true}
      rows={2}
    />
    <div class="row">
      <span class="wrap">
        <button
          type="button"
          class="place"
          aria-haspopup="menu"
          aria-expanded={placing}
          title="where this conversation works (ctrl+shift+P)"
          onclick={() => (placing = !placing)}
        >
          <Icon name={starter.place.kind === "chat" ? "globe" : "folder"} small />{placeLabel(starter.place)}<Icon
            name="chev-d"
            small
          />
        </button>
        {#if placing}
          <PickMenu rows={pickRows} label="where it works" onpick={pick} onclose={() => (placing = false)} />
        {/if}
      </span>
      {#if machined}
        <span class="wrap">
          <button
            type="button"
            class="place"
            class:there
            aria-haspopup="menu"
            aria-expanded={machining}
            title="which machine it works on (ctrl+shift+E)"
            onclick={() => ((machining = !machining), (placing = false))}
          >
            <Icon name="wall" small />{starter.machine ?? "this machine"}<Icon name="chev-d" small />
          </button>
          {#if machining}
            <PickMenu rows={machineRows} label="which machine" onpick={pickMachine} onclose={() => (machining = false)} />
          {/if}
        </span>
      {/if}
      {#if starter.place.kind !== "chat" && !there}
        <button
          type="button"
          class="toggle"
          class:on={starter.plan}
          aria-pressed={starter.plan}
          title="plan first — read and propose, change nothing (alt+P)"
          onclick={() => (starter.plan = !starter.plan)}
        >
          <Icon name="plan" small />plan first
        </button>
      {/if}
      <span class="grow"></span>
      <ModelMenu card={null} {starter} />
      <button
        type="submit"
        class="send"
        class:idle={empty || blocked}
        disabled={empty || blocked || starter.starting}
        title={blocked ? "claude code has to be ready first" : "start it (enter)"}
        aria-label="start the conversation"
      >
        <Icon name="up" />
      </button>
    </div>
  </form>

  <div class="ideas">
    {#each ideasFor(starter.place) as text (text)}
      <button type="button" class="idea" onclick={() => idea(text)}>{text}</button>
    {/each}
  </div>
</div>

{#if needs || working}
  <p class="flock">
    {#if working}<span><i class="st work"></i>{working} working</span>{/if}
    {#if needs}<span><i class="st ask"></i>{needs} {needs === 1 ? "needs" : "need"} you</span>{/if}
    <span class="quiet">— they keep going while you start this one</span>
  </p>
{/if}

<style>
  .hello {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 0 40px;
    min-height: 100%;
  }
  .big {
    width: 46px;
    height: 46px;
    margin-bottom: 18px;
  }
  h1 {
    margin: 0 0 26px;
    font: 400 36px/1.15 var(--display);
    color: var(--paper);
    letter-spacing: -0.005em;
  }
  .box {
    position: relative;
    width: min(700px, calc(100% - 48px));
    border-radius: var(--cv-r-xl, 26px);
    padding: 14px 12px 10px 16px;
    background: linear-gradient(
      180deg,
      color-mix(in oklab, var(--cv-lift, var(--surface)) 100%, var(--paper) 3%),
      var(--cv-lift, var(--surface))
    );
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    box-shadow:
      0 1px 0 color-mix(in oklab, var(--paper) 7%, transparent) inset,
      0 18px 40px -20px color-mix(in srgb, var(--shade) 95%, transparent),
      0 2px 6px -2px color-mix(in srgb, var(--shade) 40%, transparent);
    font-family: var(--cv-ui, var(--util));
    --pb-bg: transparent;
    --pb-border: 0;
    --pb-pad: 2px 0 10px;
    --pb-size: 15px;
    --pb-max: 40vh;
    --pb-font: var(--cv-ui, var(--util));
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grow {
    flex: 1;
  }
  .wrap {
    position: relative;
    display: inline-flex;
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .place {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 10px 0 11px;
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--paper);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .place :global(svg) {
    color: var(--paper-mute);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--paper-mute);
    border: 1px dashed var(--cv-hair, var(--edge));
  }
  .toggle.on {
    color: var(--paper);
    border-color: var(--paper-mute);
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .send {
    display: inline-grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--cv-sheet, var(--ink));
    background: radial-gradient(
      circle at 35% 25%,
      color-mix(in oklab, var(--paper) 100%, var(--surface) 10%),
      var(--paper) 60%,
      color-mix(in oklab, var(--paper) 85%, var(--shade))
    );
    box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--shade) 80%, transparent);
    transition: transform var(--dur-quick, 160ms) var(--ease-pop, ease-out);
  }
  .send:active:not(:disabled) {
    transform: scale(0.92);
  }
  .send.idle,
  .send:disabled {
    background: color-mix(in oklab, var(--raised) 100%, var(--paper) 6%);
    color: var(--paper-faint);
    box-shadow: none;
    cursor: default;
  }
  .ideas {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 16px;
    width: min(760px, calc(100% - 48px));
  }
  .idea {
    display: inline-flex;
    align-items: center;
    height: 34px;
    padding: 0 13px;
    border-radius: 999px;
    font-family: var(--cv-ui, var(--util));
    font-size: 12.5px;
    color: var(--paper-dim);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 55%, transparent);
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      transform var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .idea:hover {
    border-color: var(--paper-faint);
    transform: translateY(-1px);
  }
  @media (prefers-reduced-motion: reduce) {
    .idea,
    .send {
      transition-property: border-color;
    }
  }
  .flock {
    position: absolute;
    bottom: 18px;
    left: 0;
    right: 0;
    margin: 0;
    display: flex;
    justify-content: center;
    gap: 16px;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-mute);
  }
  .flock span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .flock .quiet {
    color: var(--cv-note, var(--paper-mute));
  }
  .st {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .st.work {
    background: var(--st-work);
  }
  .st.ask {
    background: var(--st-ask);
  }
</style>
