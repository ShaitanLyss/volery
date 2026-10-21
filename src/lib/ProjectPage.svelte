<script lang="ts">
  /* A project's page (`docs/chat-mode.md` §6.7, `docs/chat-mode/project.html`).

     A project is a folder, and the page says so first: the path, the branch,
     when it was last worked in. Its conversations, filterable by state, with the
     first line of what each last said. Beside them, three cards:

     - **instructions** — the territory's standing instructions, what every
       conversation here is told (`guidance.md`), written with
       `Skein.setProjectGuidance`;
     - **what conversations here may do** — act, or read only, worded as what
       read-only really does: its file-editing tools are switched off and it is
       told not to change anything (`Skein.setProjectReadOnly`). A conversation
       already running does not hear either until it next starts, and the page
       says so rather than implying otherwise;
     - **the folder** — show it in Explorer, its dev servers, its actions
       (`actions.ts`: build, test, pull…), and show it on the wall.

     Opened from the sidebar's *projects* group; selecting a conversation leaves
     it. */
  import Icon from "./Icon.svelte";
  import type { Skein, Project } from "./skein.svelte";
  import type { Actions } from "./actions.svelte";
  import type { Group } from "./chatview";
  import { ageOf } from "./chatview";
  import { clock } from "./conversation.svelte";
  import { FILTERS, countsOf, filtered, lineOf, rowsOf, type Filter } from "./projectview";

  let {
    skein,
    actions,
    project,
    groups,
    onselect,
    onnew,
    onwall,
  }: {
    skein: Skein;
    actions: Actions;
    project: Project;
    groups: Group[];
    onselect: (id: string) => void;
    /** *New conversation here*: the empty state, with this folder as its place. */
    onnew: () => void;
    /** *Show it on the wall*. */
    onwall: () => void;
  } = $props();

  let filter = $state<Filter>("all");
  const all = $derived(rowsOf(groups, project.name));
  const counts = $derived(countsOf(all));
  const shown = $derived(filtered(all, filter));
  const last = $derived(all.reduce((t, p) => Math.max(t, p.row.lastAt), 0));
  const branch = $derived(actions.status[project.root_path]?.branch ?? null);
  const chips = $derived(actions.chipsFor(project.root_path).filter((c) => !c.idle));
  const servers = $derived(skein.groupsFor(project.id));

  /* Instructions, edited in place. */
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let area: HTMLTextAreaElement | undefined = $state();

  function edit() {
    draft = project.instructions;
    editing = true;
    queueMicrotask(() => area?.focus());
  }
  async function save() {
    saving = true;
    try {
      await skein.setProjectGuidance(project.id, draft.trim());
      editing = false;
    } catch {
      /* `setProjectGuidance` has said why in the fault line; the draft stays. */
    } finally {
      saving = false;
    }
  }
  function areaKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = false;
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === " ") {
      /* A space typed here is a space, never the leader. */
      e.stopPropagation();
    }
  }

  function when(at: number, working: boolean): string {
    if (working) return "now";
    if (!at) return "";
    const d = clock.t - at;
    return d < 60_000 ? "now" : ageOf(d);
  }
</script>

<div class="page">
  <header class="head">
    <span class="glyph" aria-hidden="true"><Icon name="folder" /></span>
    <div class="who">
      <h1>{project.name}</h1>
      <div class="path">
        <code>{project.root_path}</code>
        {#if branch}<span>· {branch}</span>{/if}
        {#if last}<span>· {when(last, false) === "now" ? "worked in just now" : `worked in ${when(last, false)} ago`}</span>{/if}
      </div>
    </div>
    <span class="grow"></span>
    <button type="button" class="primary" onclick={onnew} title="a new conversation in this folder (ctrl+shift+O)">
      <Icon name="plus" small />new conversation here
    </button>
  </header>

  <section class="convs" aria-label="its conversations">
    <div class="filters" role="group" aria-label="show">
      {#each FILTERS as f (f.key)}
        {#if f.key === "all" || counts[f.key]}
          <button type="button" class:on={filter === f.key} aria-pressed={filter === f.key} onclick={() => (filter = f.key)}>
            {#if f.key === "needs"}<i class="st ask"></i>{:else if f.key === "working"}<i class="st work"></i>{/if}
            {f.label} {counts[f.key]}
          </button>
        {/if}
      {/each}
    </div>
    {#if shown.length}
      <ul>
        {#each shown as p (p.row.id)}
          <li>
            <button type="button" class="conv {p.tone}" data-row={p.row.id} onclick={() => onselect(p.row.id)}>
              <i class="st {p.tone}" aria-hidden="true"></i>
              <b>{p.row.title}</b>
              <span class="when">{when(p.row.lastAt, p.row.working)}</span>
              <span class="line">{lineOf(p)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="none">no conversations here yet — start one with the button above.</p>
    {/if}
  </section>

  <aside>
    <section class="card">
      <h2>instructions<span class="grow"></span>
        {#if !editing}<button type="button" class="quiet" onclick={edit}>edit</button>{/if}
      </h2>
      <p class="sub">every conversation in this project is told this</p>
      {#if editing}
        <textarea bind:this={area} bind:value={draft} rows="6" onkeydown={areaKey} aria-label="instructions for this project"></textarea>
        <div class="acts">
          <button type="button" class="btn" disabled={saving} onclick={() => void save()}>save (ctrl+enter)</button>
          <button type="button" class="quiet" onclick={() => (editing = false)}>cancel</button>
        </div>
        <p class="sub">conversations already running hear it the next time they start</p>
      {:else if project.instructions.trim()}
        <p class="instr">{project.instructions}</p>
      {:else}
        <p class="instr none">nothing yet</p>
      {/if}
    </section>

    <div class="card" role="radiogroup" aria-label="what conversations here may do">
      <h2>what conversations here may do</h2>
      <button
        type="button"
        class="radio"
        class:on={!project.readOnly}
        role="radio"
        aria-checked={!project.readOnly}
        onclick={() => void skein.setProjectReadOnly(project.id, false)}
      >
        <i></i>change files and run commands<small>what every project does: the agent acts, then tells you what it did</small>
      </button>
      <button
        type="button"
        class="radio"
        class:on={project.readOnly}
        role="radio"
        aria-checked={project.readOnly}
        onclick={() => void skein.setProjectReadOnly(project.id, true)}
      >
        <i></i>read only<small>its file-editing tools are switched off here, and it is told not to change anything</small>
      </button>
    </div>

    <section class="card">
      <h2>the folder</h2>
      <div class="links">
        <button type="button" onclick={() => void skein.showInExplorer(project.root_path)}>
          <Icon name="folder" />show it in explorer
        </button>
        {#each servers as g (g.group.id)}
          <button type="button" onclick={() => void (g.running ? skein.stopGroup(g) : skein.startGroup(g))}>
            <Icon name="term" />{g.running ? "stop" : "start"} {g.group.label}
          </button>
        {/each}
        {#each chips as c (c.id)}
          <button type="button" title={c.title} class:busy={c.state === "running"} onclick={() => void actions.run(project.root_path, c.id)}>
            <Icon name={c.state === "running" ? "stop" : "arrow-r"} />{c.label}{#if c.state === "running"}<span class="note">running</span>{/if}
          </button>
        {/each}
        <button type="button" onclick={onwall} title="the wall, with this project on it (ctrl+shift+M)">
          <Icon name="wall" />show it on the wall
        </button>
      </div>
    </section>
  </aside>
</div>

<style>
  .page {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 34px 44px 28px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    grid-template-rows: auto 1fr;
    column-gap: 34px;
    align-content: start;
    font-family: var(--cv-ui, var(--util));
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .page {
      animation: none;
    }
  }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .head {
    grid-column: 1 / -1;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 26px;
  }
  .glyph {
    width: 48px;
    height: 48px;
    flex: none;
    border-radius: 14px;
    display: grid;
    place-items: center;
    color: var(--paper-dim);
    background: linear-gradient(160deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 8%), var(--raised));
    border: 1px solid var(--cv-hair, var(--edge));
    box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--shade) 90%, transparent);
  }
  .glyph :global(svg) {
    width: 22px;
    height: 22px;
  }
  h1 {
    margin: 0;
    font: 400 30px/1.1 var(--display);
    color: var(--paper);
  }
  .path {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    font-size: 12.5px;
    color: var(--paper-mute);
  }
  .path code {
    font: 350 12px var(--mono);
    color: var(--paper-dim);
  }
  .grow {
    flex: 1;
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 14px;
    border-radius: 10px;
    font-size: 13px;
    color: var(--cv-sheet, var(--ink));
    background: var(--paper);
    white-space: nowrap;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }
  .filters button {
    height: 28px;
    padding: 0 11px;
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--paper-mute);
    border: 1px solid var(--cv-hair, var(--edge));
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .filters button.on {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    border-color: var(--paper-faint);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  .conv {
    width: 100%;
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: start;
    padding: 12px 6px;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .conv:hover {
    background: color-mix(in oklab, var(--surface) 50%, transparent);
  }
  .conv .st {
    margin-top: 5px;
  }
  .conv b {
    font-weight: 500;
    font-size: 14px;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .conv .line {
    grid-column: 2;
    margin-top: 3px;
    font: 13.5px/1.5 var(--body);
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .conv.ask .line {
    color: color-mix(in oklab, var(--st-ask) 55%, var(--paper-dim));
  }
  .conv.fail .line {
    color: color-mix(in oklab, var(--st-fail) 60%, var(--paper-dim));
  }
  .when {
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
    text-align: right;
  }
  .none {
    color: var(--cv-note, var(--paper-mute));
    font-size: 13px;
  }
  .card {
    border-radius: 14px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
    padding: 14px 15px;
    margin-bottom: 14px;
  }
  .card h2 {
    margin: 0 0 4px;
    font: 500 13px var(--cv-ui, var(--util));
    color: var(--paper);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card .sub {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--paper-mute);
  }
  .instr {
    margin: 0;
    font: 13.5px/1.55 var(--body);
    color: var(--paper-dim);
    white-space: pre-wrap;
  }
  .instr.none {
    color: var(--cv-note, var(--paper-mute));
  }
  .quiet {
    font-size: 12px;
    color: var(--paper-mute);
  }
  .quiet:hover {
    color: var(--paper);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--cv-sheet, var(--ink)) 80%, transparent);
    color: var(--paper);
    font: 13.5px/1.5 var(--body);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 8px 0;
  }
  .btn {
    height: 28px;
    padding: 0 11px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--paper);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .radio {
    width: 100%;
    display: grid;
    grid-template-columns: 16px 1fr;
    column-gap: 9px;
    padding: 7px 0;
    font-size: 13px;
    color: var(--paper-dim);
  }
  .radio i {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--paper-faint);
    margin-top: 2px;
    box-sizing: border-box;
  }
  .radio.on i {
    border-color: var(--paper);
    box-shadow:
      0 0 0 3px var(--cv-sheet, var(--ink)) inset,
      0 0 0 7px var(--paper) inset;
  }
  .radio.on {
    color: var(--paper);
  }
  .radio small {
    grid-column: 2;
    font-size: 11.5px;
    color: var(--paper-mute);
  }
  .links {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .links button {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 30px;
    font-size: 13px;
    color: var(--paper-dim);
  }
  .links button:hover {
    color: var(--paper);
  }
  .links :global(svg) {
    color: var(--paper-mute);
  }
  .links .note {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--cv-note, var(--paper-mute));
  }
  .st {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: transparent;
    box-shadow: 0 0 0 1.3px var(--paper-faint) inset;
  }
  .st.work {
    background: var(--st-work);
    box-shadow: none;
  }
  .st.ask {
    background: var(--st-ask);
    box-shadow: none;
  }
  .st.fail {
    background: var(--st-fail);
    box-shadow: none;
  }
  .st.done {
    box-shadow: 0 0 0 1.5px var(--paper-mute) inset;
  }
</style>
