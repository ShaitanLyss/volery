<script lang="ts">
  /* The pane beside the thread (`docs/chat-mode.md` §3, §4.4, working.html):
     what the conversation is doing that its words do not say — its plan stood
     on its end, the files it has handled, the conversations it started, what it
     has running in the background, and a side question asked beside it.

     Closed by default (the live parts, §6.4), opened with Ctrl+. or the bar's
     toggle. Everything here is somebody else's reading: the plan is
     `timeline.ts`, the files `store::files_handled_by` (async, read once a turn
     and not on every frame), the children `Elsewhere.kin`, the jobs
     `conv.jobs`. A card on another wall has no files or jobs here, and says so
     rather than drawing an empty list that reads as "none". */
  import { effective, subsOf, type Timeline } from "./timeline";
  import type { CardHandle, Cards } from "./cards.svelte";
  import type { Trail } from "./handoff";
  import { cardName } from "./naming";
  import { shortPath } from "./handoff";
  import { untrack } from "svelte";
  import { useFiles } from "./paths.svelte";

  /* A file it touched opens the way any path in its words does — the scope
     `ChatView` set from the card's root, and the one gesture that opens a
     path (`App.svelte::goToPath`). */
  const opener = useFiles();

  type Tab = "plan" | "files" | "linked" | "jobs" | "aside";

  let {
    card,
    cards,
    timeline,
    kin,
    trail,
    onselect,
  }: {
    card: CardHandle;
    cards: Cards;
    /** Its live plan, if it has one. */
    timeline: Timeline | null;
    /** Who started whom, child to parent. */
    kin: readonly { child: string; parent: string }[];
    /** Read the files it has handled — the one read here that crosses to Rust,
     *  and only for a card on this wall. */
    trail?: (id: string) => Promise<Trail | null>;
    onselect: (id: string) => void;
  } = $props();

  let tab = $state<Tab>("plan");

  const children = $derived(
    kin.filter((k) => k.parent === card.id).map((k) => cards.find(k.child)).filter((c): c is CardHandle => !!c),
  );
  const jobs = $derived(card.face.jobs ?? []);
  const asides = $derived(
    (card.readable.lines ?? []).filter((l) => l.kind === "asked" || l.kind === "aside"),
  );

  /* The files, read when the tab is open and again when a turn settles — not
     on every delta. A card on another wall has none here. */
  let files = $state<Trail | null>(null);
  let reading = $state(false);
  let unread = $state(false);
  /** Whose files `files` are. */
  let filesOf = "";
  const turns = $derived(card.face.working ? -1 : (card.gist.turns ?? 0));
  $effect(() => {
    const id = card.id;
    if (tab !== "files" || !trail || !card.conv) return;
    void turns;
    /* Another conversation's files are not this one's while the read is out. */
    if (untrack(() => files) && filesOf !== id) files = null;
    filesOf = id;
    let live = true;
    reading = true;
    void trail(id).then((t) => {
      if (!live) return;
      unread = !t;
      if (t) files = t;
      reading = false;
    });
    return () => {
      live = false;
    };
  });

  const tabs = $derived<{ id: Tab; label: string; n?: number }[]>([
    { id: "plan", label: "plan" },
    { id: "files", label: "files" },
    { id: "linked", label: "linked", n: children.length || undefined },
    { id: "jobs", label: "jobs", n: jobs.length || undefined },
    { id: "aside", label: "side question" },
  ]);

  function onTabKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const at = tabs.findIndex((t) => t.id === tab);
    const to = tabs[(at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    tab = to.id;
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${to.id}"]`)?.focus();
  }
</script>

<aside class="pane" aria-label="beside the conversation">
  <div class="tabs" role="tablist" tabindex="-1" onkeydown={onTabKey}>
    {#each tabs as t (t.id)}
      <button
        type="button"
        role="tab"
        data-tab={t.id}
        aria-selected={tab === t.id}
        tabindex={tab === t.id ? 0 : -1}
        class:on={tab === t.id}
        onclick={() => (tab = t.id)}>{t.label}{#if t.n}<span class="n">{t.n}</span>{/if}</button
      >
    {/each}
  </div>

  <div class="body" role="tabpanel">
    {#if tab === "plan"}
      {#if timeline}
        <h5>{timeline.title}</h5>
        <p class="meta">{timeline.plan.steps.filter((s) => effective(s) === "done").length} of {timeline.plan.steps.length} done</p>
        <ol class="vt">
          {#each timeline.plan.steps as s, i (i)}
            {@const st = effective(s)}
            <li class="ms" class:d={st === "done"} class:a={st === "active"}>
              <span class="node" aria-hidden="true"><i></i></span>
              <span class="lbl">{s.title}</span>
              {#if subsOf(s).length}
                <span class="subs">
                  {#each subsOf(s) as x, j (j)}
                    <span class:d={x.state === "done"} class:a={x.state === "active"}>{x.title}</span>
                  {/each}
                </span>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty">no plan — a conversation draws one when it is working through several steps.</p>
      {/if}
    {:else if tab === "files"}
      {#if !card.conv}
        <p class="empty">its files are on {card.remote?.host ?? "another machine"}, not here.</p>
      {:else if reading && !files}
        <p class="empty">reading…</p>
      {:else if unread && !files}
        <p class="empty">its files could not be read just now.</p>
      {:else if files && files.files.length}
        <div class="files">
          {#each files.files as f (f.path)}
            <button type="button" onclick={() => opener()?.go(f.path, null, "open")} title={f.path}>
              <span class="p">{shortPath(f.path, files.root)}</span>
              <span class="op">{f.op === "write" ? "edited" : "read"}{f.count > 1 ? ` ×${f.count}` : ""}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="empty">it has not opened a file yet.</p>
      {/if}
    {:else if tab === "linked"}
      {#if children.length}
        {#each children as c (c.id)}
          <button type="button" class="kid" onclick={() => onselect(c.id)}>
            <i class="st" class:work={c.face.working} class:ask={!!c.ask} class:fail={c.face.tier === "fail"}></i>
            <span>{cardName(c.face.title, "").text || "a conversation"}</span>
            <span class="note">{c.face.working ? c.face.doing : "at rest"}</span>
          </button>
        {/each}
      {:else}
        <p class="empty">it has not started any conversations.</p>
      {/if}
    {:else if tab === "jobs"}
      {#if jobs.length}
        <ul class="jobs">
          {#each jobs as j, i (i)}<li>{j.label}</li>{/each}
        </ul>
      {:else}
        <p class="empty">nothing running in the background.</p>
      {/if}
    {:else}
      {#if asides.length}
        {#each asides as l, i (i)}
          <p class={l.kind}>{l.text}</p>
        {/each}
      {:else}
        <p class="empty">ask beside it with <code>/btw</code> and a question — the answer comes here, and the conversation is not interrupted.</p>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .pane {
    flex: none;
    width: 300px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--cv-hair, var(--edge));
    background: linear-gradient(180deg, color-mix(in oklab, var(--cv-sheet, var(--ink)) 92%, var(--well)), var(--cv-sheet, var(--ink)));
    font-family: var(--cv-ui, var(--util));
    font-size: 13px;
    animation: slide var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translateX(12px);
    }
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pane {
      animation-name: fade;
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
  .tabs {
    display: flex;
    gap: 2px;
    padding: 10px 10px 0;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    /* Five tabs in 300px: they fit, and where a large reading size makes them
       not, they scroll without a bar drawn under them. */
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    height: 32px;
    padding: 0 8px;
    font-size: 12.5px;
    color: var(--paper-mute);
    border-bottom: 2px solid transparent;
    white-space: nowrap;
  }
  .tabs button.on {
    color: var(--paper);
    border-bottom-color: var(--paper-dim);
  }
  .tabs .n {
    color: var(--cv-note, var(--paper-mute));
    margin-left: 4px;
  }
  .body {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  h5 {
    margin: 0 0 2px;
    font: 500 14px var(--cv-ui, var(--util));
    color: var(--paper);
  }
  .meta,
  .empty {
    margin: 0 0 16px;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .vt {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ms {
    position: relative;
    display: grid;
    grid-template-columns: 22px 1fr;
    column-gap: 10px;
    padding-bottom: 14px;
  }
  .ms::before {
    content: "";
    position: absolute;
    left: 10.5px;
    top: 18px;
    bottom: -2px;
    width: 1px;
    background: var(--rule);
  }
  .ms:last-child::before {
    display: none;
  }
  .node {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
  }
  .node i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--paper-faint);
    background: var(--cv-sheet, var(--ink));
  }
  .ms.d .node i {
    border-color: var(--paper-mute);
    background: var(--paper-mute);
  }
  .ms.a .node i {
    border-color: var(--st-work);
    background: var(--st-work);
  }
  .lbl {
    color: var(--paper-dim);
    padding-top: 2px;
  }
  .ms.d .lbl {
    color: var(--paper-mute);
  }
  .ms.a .lbl {
    color: var(--paper);
    font-weight: 500;
  }
  .subs {
    grid-column: 2;
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 6px;
    font-size: 12.5px;
    color: var(--paper-mute);
  }
  .subs span.a {
    color: var(--paper);
  }
  .subs span.d {
    text-decoration: line-through;
    text-decoration-color: var(--paper-faint);
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .files button {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    font: 350 11.5px var(--mono);
    color: var(--paper-dim);
  }
  .files .p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .files .op {
    margin-left: auto;
    color: var(--cv-note, var(--paper-mute));
    white-space: nowrap;
  }
  .kid {
    display: grid;
    grid-template-columns: 14px 1fr;
    column-gap: 8px;
    width: 100%;
    padding: 6px 0;
    color: var(--paper-dim);
  }
  .kid .note {
    grid-column: 2;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .st {
    width: 7px;
    height: 7px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--st-rest);
  }
  .st.work {
    background: var(--st-work);
  }
  .st.ask {
    background: var(--st-ask);
  }
  .st.fail {
    background: var(--st-fail);
  }
  .jobs {
    margin: 0;
    padding-left: 1.1em;
    color: var(--paper-dim);
  }
  .asked {
    margin: 0 0 6px;
    color: var(--paper);
  }
  .aside {
    margin: 0 0 14px;
    font-family: var(--body);
    color: var(--paper-dim);
    white-space: pre-wrap;
  }
</style>
