<script lang="ts">
  import type { Skein, GroupRuntime } from "./skein.svelte";
  import type { Actions } from "./actions.svelte";
  import { ansiVar, parseAnsi } from "./ansi";
  import { parseSpecs } from "./specs";
  /* Both logs below follow their own tail: opened, they show the newest line,
     and they keep showing it while the group talks — unless you scroll back,
     which is the whole of the behaviour. See follow.ts. */
  import { stickToTail } from "./follow";

  let { skein, actions }: { skein: Skein; actions: Actions } = $props();

  let addingFor = $state<string | null>(null);
  let label = $state("dev");
  /* pnpm, not npm — and not even that if the project says otherwise. The
     placeholder is a suggestion people accept, so it had better be the command
     that works in this repo rather than the one that gets typed out of habit. */
  let draft = $state("pnpm dev :5173");
  let openLog = $state<string | null>(null);
  /* Which action run has its output open. Runs and server groups share the id
     space here only in the sense that one of them is open at a time. */
  let openRun = $state<string | null>(null);

  /** What `+ group` should start you with, for this project. */
  function suggest(root: string): string {
    const f = actions.facts[root];
    const dev = f?.scripts.includes("dev") ? "dev" : "start";
    return `${f?.manager ?? "pnpm"} ${dev} :5173`;
  }

  async function add(projectId: string) {
    const specs = parseSpecs(draft);
    if (!specs.length) return;
    await skein.addGroup(projectId, label.trim() || "dev", specs);
    addingFor = null;
  }

  function dotClass(g: GroupRuntime) {
    return g.overall;
  }
</script>

<section class="servers">
  <!-- Said once, at the top, rather than on every group: nothing started
       because nothing was asked to. Without this a wall of idle groups reads as
       a wall of groups that failed, and the chips say `idle` either way. -->
  {#if skein.serversQuiet}
    <p class="quiet">
      SKEIN_NO_SERVERS is set — nothing was started on load. Groups still start
      when you click them.
    </p>
  {/if}

  {#if skein.projects.length === 0}
    <p class="none">
      No projects yet — open a conversation somewhere and its directory becomes
      one.
    </p>
  {/if}

  {#each skein.projects as project (project.id)}
    {@const groups = skein.groupsFor(project.id)}
    <div class="project">
      <div class="head">
        <span class="name">{project.name}</span>
        <span class="path">{project.root_path}</span>
        <span class="grow"></span>
        <button
          class="ghost"
          onclick={() => {
            addingFor = addingFor === project.id ? null : project.id;
            if (addingFor) draft = suggest(project.root_path);
          }}
        >
          {addingFor === project.id ? "cancel" : "+ group"}
        </button>
      </div>

      {#if addingFor === project.id}
        <div class="add">
          <input bind:value={label} placeholder="group name" class="lbl" />
          <textarea
            bind:value={draft}
            rows="2"
            spellcheck="false"
            placeholder={"one command per line\nnpm run dev :5173"}
          ></textarea>
          <button class="go" onclick={() => add(project.id)}>Add</button>
        </div>
      {/if}

      <!-- What the territory's chips have been asked to do. A chip can carry a
           state and one line; a failed build is a hundred lines, and this is
           where they live. -->
      {#each actions.recent(project.root_path) as r (r.id)}
        <div class="group">
          <span class="dot {r.state === 'ok' ? 'up' : r.state === 'running' ? 'starting' : r.state === 'failed' ? 'exited' : ''}"></span>
          <span class="glabel">{r.action}</span>
          <span class="svc" data-h={r.state === "ok" ? "up" : r.state === "failed" ? "exited" : "idle"}>
            {r.state}{#if r.pct !== null && r.state === "running"}<i>{r.pct}%</i>{/if}
          </span>
          {#if r.note}<span class="path">{r.note}</span>{/if}
          <span class="grow"></span>
          {#if r.state === "running"}
            <button class="ghost" onclick={() => actions.cancel(r.root, r.action)}>stop</button>
          {:else}
            <button class="ghost" onclick={() => actions.run(r.root, r.action)}>again</button>
          {/if}
          <button
            class="ghost"
            onclick={() => (openRun = openRun === r.id ? null : r.id)}
          >
            log{r.log.length ? ` (${r.log.length})` : ""}
          </button>
        </div>

        {#if openRun === r.id}
          <pre class="log" {@attach stickToTail}>{#each r.log.slice(-200) as l}<span class="ln">{#each parseAnsi(l) as s}<span
                  style:color={s.color === null ? null : ansiVar(s.color)}
                  style:font-weight={s.bold ? "600" : null}
                  style:opacity={s.dim ? 0.6 : null}>{s.text}</span
                >{/each}
</span>{/each}{#if !r.log.length}<span class="quiet">nothing yet</span>{/if}</pre>
        {/if}
      {/each}

      {#each groups as g (g.group.id)}
        <div class="group">
          <span class="dot {dotClass(g)}"></span>
          <span class="glabel">{g.group.label}</span>
          {#if g.flood}
            <!-- Said beside the name rather than in the log, which is the one
                 place a flood makes unreadable. -->
            <span class="flood"
              >{g.flood.stopped
                ? "stopped by the wall — it was flooding its log"
                : `flooding · ~${g.flood.rate.toLocaleString("en")} lines/s`}</span
            >
          {/if}
          {#each g.group.servers as s}
            <span class="svc" data-h={g.health[s.label] ?? "idle"}>
              {s.label}{#if s.port}<i>:{s.port}</i>{/if}
            </span>
          {/each}
          <span class="grow"></span>
          {#if g.running}
            <button class="ghost" onclick={() => skein.stopGroup(g)}>stop</button>
            <button class="ghost" onclick={() => skein.startGroup(g)}>restart</button>
          {:else}
            <button class="ghost" onclick={() => skein.startGroup(g)}>start</button>
          {/if}
          <button
            class="ghost"
            onclick={() => (openLog = openLog === g.group.id ? null : g.group.id)}
          >
            log{g.log.length ? ` (${g.log.length})` : ""}
          </button>
          <button class="ghost danger" onclick={() => skein.removeGroup(g)}>×</button>
        </div>

        {#if openLog === g.group.id}
          <!-- Servers run through pipes with colour asked for (`force_colour`),
               so their output arrives with it intact. -->
          <pre class="log" {@attach stickToTail}>{#each g.log.slice(-120) as l}<span class="ln"><span
                  class="src">{l.label}</span> │ {#each parseAnsi(l.line) as s}<span
                  style:color={s.color === null
                    ? null
                    : ansiVar(s.color)}
                  style:font-weight={s.bold ? "600" : null}
                  style:opacity={s.dim ? 0.6 : null}>{s.text}</span
                >{/each}
</span>{/each}{#if !g.log.length}<span class="quiet">nothing yet</span>{/if}</pre>
        {/if}
      {/each}
    </div>
  {/each}
</section>

<style>
  .servers {
    flex: 0 0 auto;
    max-height: 42vh;
    overflow-y: auto;
    border-bottom: 1px solid var(--edge);
    background: var(--well);
    padding: 0.7rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    position: relative;
    z-index: 1;
  }
  .none {
    margin: 0;
    font-family: var(--util);
    font-size: 0.76rem;
    color: var(--paper-faint);
  }

  /* A state, not a fault — so no `--st-fail`. It reads a shade brighter than
     `.none` because it explains what you are looking at. */
  .quiet {
    margin: 0 0 0.6rem;
    font-family: var(--util);
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--paper-mute);
    border-left: 1px solid var(--rule);
    padding-left: 0.55rem;
  }

  .project {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .name {
    font-family: var(--util);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-dim);
  }
  .path {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1 1 auto;
  }

  .group {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--util);
    font-size: 0.72rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.3rem 0.45rem;
  }
  .glabel {
    color: var(--paper);
    font-weight: 600;
  }
  .svc {
    color: var(--paper-mute);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.02rem 0.42rem;
    font-size: 0.66rem;
  }
  .svc i {
    font-style: normal;
    color: var(--paper-faint);
  }
  .svc[data-h="up"] {
    border-color: color-mix(in srgb, var(--st-work) 50%, var(--edge));
    color: var(--paper-dim);
  }
  .svc[data-h="exited"] {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--st-fail);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--paper-faint);
    flex: 0 0 auto;
  }
  .dot.up {
    background: var(--st-work);
  }
  .dot.starting {
    background: var(--st-soft);
  }
  .dot.exited {
    background: var(--st-fail);
  }

  .ghost {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.12rem 0.4rem;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .ghost.danger:hover {
    color: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
  }

  .add {
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
  }
  .add .lbl {
    width: 110px;
  }
  .add input,
  .add textarea {
    font-family: var(--mono);
    font-size: 0.7rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-dim);
    padding: 0.3rem 0.45rem;
    resize: vertical;
  }
  .add textarea {
    flex: 1 1 auto;
  }
  .go {
    font-family: var(--util);
    font-size: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.3rem 0.6rem;
    cursor: pointer;
  }

  .log {
    margin: 0;
    font-family: var(--mono);
    font-size: 0.64rem;
    line-height: 1.5;
    color: var(--paper-mute);
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.6rem;
    max-height: 16vh;
    overflow: auto;
    white-space: pre-wrap;
  }
  .log .src {
    color: var(--paper-faint);
  }
  .log .quiet {
    color: var(--paper-faint);
  }
  /* Rust, because a flood is a failure of the group's — the one colour this
     wall spends on that. */
  .flood {
    color: var(--st-fail);
    font-size: 0.85em;
  }
</style>
