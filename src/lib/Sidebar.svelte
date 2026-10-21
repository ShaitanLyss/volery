<script lang="ts">
  /* Chat view's sidebar: every conversation on the wall, sorted by what it
     needs from you (`docs/chat-mode.md` §5.1). What goes where is decided in
     `chatview.ts::groups` and nowhere else; this draws the answer.

     Rows travel between groups by FLIP rather than jumping — `animate:flip`
     is transform only, and it ends — and not at all under `still` or a
     system that asked for reduced motion. */
  import { flip } from "svelte/animate";
  import { cubicInOut } from "svelte/easing";
  import Icon from "./Icon.svelte";
  import { fullTitle } from "./tipped.svelte";
  import type { Ghost, Group, Placed, ProjectRow } from "./chatview";

  let {
    groups,
    projects,
    selected,
    account = null,
    onselect,
    onparent,
    onnew,
    onsearch,
    onproject,
    onmenu,
    onprojectmenu,
    piles = [],
    pileOn = null,
    onpile,
    onaccount,
  }: {
    groups: Group[];
    projects: ProjectRow[];
    selected: string | null;
    /** Who is signed in and what binds them, for the foot (§5.7). */
    account?: { name: string; line: string } | null;
    onselect: (id: string) => void;
    /** The parent named above a child: select it, or bring a closed one back
     *  (`chatview.ts::Ghost`). */
    onparent: (g: Ghost) => void;
    onnew: () => void;
    onsearch: () => void;
    onproject: (name: string) => void;
    /** A conversation's menu, opened at `at` — by a right-click, or from the
     *  keyboard (`keyed`), which puts the first row under the keys. */
    onmenu: (id: string, at: At, keyed: boolean) => void;
    /** A project's menu, the same way. */
    onprojectmenu: (name: string, at: At, keyed: boolean) => void;
    /** The wall's two piles — the sink and the billboard — each a page in the
     *  sheet (`PilePage.svelte`), with how much is in it. */
    piles?: { kind: "sink" | "board"; label: string; count: number }[];
    /** Which of them is the page up, if either. */
    pileOn?: "sink" | "board" | null;
    onpile?: (kind: "sink" | "board") => void;
    onaccount?: () => void;
  } = $props();

  type At = { x: number; y: number };

  /* A row's menu has two ways in, and the keyboard one is the house rule (a
     button with no key is unfinished): the context-menu key or Shift+F10 on a
     focused row, opened under the row with the first item focused. The
     keyboard's own `contextmenu` event arrives as well, on Windows at keyup,
     and is let go — a real right-click is the one with `button === 2` — so a
     key press opens one menu, not two. */
  const menuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");
  function under(el: HTMLElement): At {
    const r = el.getBoundingClientRect();
    return { x: r.left + 14, y: r.bottom - 2 };
  }

  /** Set aside starts folded: it is the end of the list on purpose — and
   *  opens by itself when what you selected is in it, which a parent named
   *  above its child, or Ctrl+K, can land you on. */
  let asideOpen = $state(false);
  $effect(() => {
    if (selected && groups.some((g) => g.key === "aside" && g.rows.some((p) => p.row.id === selected))) asideOpen = true;
  });

  /** What a parent's label offers: the parent itself, its recorded session
   *  brought back, or nothing — a card closed on another wall, or a wall not
   *  heard from, is named and cannot be reached from here. */
  function reaches(g: Ghost): string | null {
    if (g.state === "here") return `open “${g.label}”, the conversation that started this one`;
    if (g.state === "closed" && g.host === null) return "bring back the conversation that started this one, from its recorded session";
    return null;
  }

  /** How long a row's travel takes, or nothing when the wall is asked to keep
   *  still. Read when the move happens rather than once, so changing the
   *  setting is heard by the next move. */
  function travel(): number {
    const still =
      document.documentElement.dataset.motion === "still" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    return still ? 0 : 360;
  }

  /** What a row is called to a screen reader: its title, then its state in
   *  words — the dot's colour is never the only telling (§10.2). */
  function nameOf(p: Placed): string {
    const state =
      p.tone === "ask"
        ? "needs you"
        : p.tone === "fail"
          ? "failed"
          : p.tone === "work"
            ? "working"
            : p.tone === "done"
              ? "finished"
              : "";
    return [p.row.title, state, p.sub ?? ""].filter(Boolean).join(", ");
  }

  /* §5.1's order: what is live, then the projects, then history and what was
     set aside. */
  const LIVE = new Set(["needs", "working", "finished"]);
  const live = $derived(groups.filter((g) => LIVE.has(g.key)));
  const rest = $derived(groups.filter((g) => !LIVE.has(g.key)));

  const initial = $derived((account?.name ?? "?").trim().slice(0, 1).toUpperCase());
</script>

<nav class="side" aria-label="conversations">
  <button class="new" type="button" onclick={onnew} title="a new conversation (ctrl+shift+O)">
    <Icon name="plus" />new conversation<kbd>ctrl shift O</kbd>
  </button>
  <button class="find" type="button" onclick={onsearch} title="search conversations and everything else (ctrl+K)">
    <Icon name="search" />search<kbd>ctrl K</kbd>
  </button>

  <div class="list">
    {#each live as g (g.key)}
      {@render group(g)}
    {/each}
    {@render folders()}
    {@render kept()}
    {#each rest as g (g.key)}
      {@render group(g)}
    {/each}
  </div>

  <div class="me">
    <span class="avatar" aria-hidden="true">{initial}</span>
    <button class="who" type="button" onclick={() => onaccount?.()} title="accounts and allowance">
      <b>{account?.name ?? "not signed in"}</b>
      {#if account?.line}<span>{account.line}</span>{/if}
    </button>
  </div>
</nav>

{#snippet group(g: Group)}
  <section class="group" aria-label={g.label}>
    {#if g.key === "aside"}
      <h2>
        <button class="fold" type="button" aria-expanded={asideOpen} onclick={() => (asideOpen = !asideOpen)}>
          <Icon name={asideOpen ? "chev-d" : "chev-r"} small />{g.label}<span class="n">{g.rows.length}</span>
        </button>
      </h2>
    {:else}
      <h2>{g.label}{#if LIVE.has(g.key)}<span class="n">{g.rows.length}</span>{/if}</h2>
    {/if}
    {#if g.key !== "aside" || asideOpen}
      <ul>
        {#each g.rows as p (p.row.id)}
          <li animate:flip={{ duration: travel(), easing: cubicInOut }}>{@render row(p)}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet row(p: Placed)}
  {#if p.ghost}
    {@const g = p.ghost}
    {@const reach = reaches(g)}
    {#if reach}
      <button type="button" class="ghost" class:gone={g.state !== "here"} title={reach} aria-label={reach} onclick={() => onparent(g)}
        >{g.label}{#if g.state !== "here"}<span class="act"> · open it</span>{/if}</button
      >
    {:else}
      <div class="ghost gone" title={g.state === "unseen" ? "its wall has not been heard from" : "closed on its own wall"}>{g.label}</div>
    {/if}
  {/if}
  <button
    type="button"
    class="row {p.tone}"
    data-row={p.row.id}
    class:on={p.row.id === selected}
    class:kid={p.depth > 0}
    style:--depth={p.depth}
    aria-current={p.row.id === selected ? "true" : undefined}
    aria-label={nameOf(p)}
    onclick={() => onselect(p.row.id)}
    {@attach fullTitle(() => p.row.title, (el) => el.querySelector<HTMLElement>(".t"))}
    oncontextmenu={(e) => {
      e.preventDefault();
      if (e.button === 2) onmenu(p.row.id, { x: e.clientX, y: e.clientY }, false);
    }}
    onkeydown={(e) => {
      if (!menuKey(e)) return;
      e.preventDefault();
      onmenu(p.row.id, under(e.currentTarget), true);
    }}
  >
    <i class="st {p.tone}" aria-hidden="true"></i>
    <span class="t">{p.row.title}</span>
    <span class="aside" title={p.aside}>{p.aside}</span>
    {#if p.sub}<span class="sub">{p.sub}</span>{/if}
  </button>
{/snippet}

{#snippet folders()}
  {#if projects.length}
    <section class="group" aria-label="projects">
      <h2>projects</h2>
      <ul>
        {#each projects as f (f.name)}
          <li>
            <button
              type="button"
              class="row folder"
              onclick={() => onproject(f.name)}
              oncontextmenu={(e) => {
                e.preventDefault();
                if (e.button === 2) onprojectmenu(f.name, { x: e.clientX, y: e.clientY }, false);
              }}
              onkeydown={(e) => {
                if (!menuKey(e)) return;
                e.preventDefault();
                onprojectmenu(f.name, under(e.currentTarget), true);
              }}
              aria-label="{f.name}, {f.count} conversations"
            >
              <Icon name="folder" small />
              <span class="t">{f.name}</span>
              <span class="aside">
                {#if f.live.length}<span class="dots">{#each f.live as t, i (i)}<i class={t}></i>{/each}</span>{/if}
                <span class="count">{f.count}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

{#snippet kept()}
  {#if piles.length && onpile}
    <section class="group" aria-label="across the wall">
      <h2>across the wall</h2>
      <ul>
        {#each piles as p (p.kind)}
          <li>
            <button
              type="button"
              class="row folder"
              class:on={pileOn === p.kind}
              aria-current={pileOn === p.kind ? "true" : undefined}
              onclick={() => onpile(p.kind)}
              title={p.kind === "sink" ? "the sink — what cards noticed and did not stop for" : "the billboard — standing notices about work in progress"}
            >
              <Icon name={p.kind === "sink" ? "list" : "pin"} small />
              <span class="t">{p.label}</span>
              <span class="aside"><span class="count">{p.count}</span></span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

<style>
  .side {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 2px 10px 10px 10px;
    font-family: var(--cv-ui, var(--util));
    font-size: 13.5px;
    line-height: 1.45;
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
  kbd {
    margin-left: auto;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    color: var(--cv-note, var(--paper-mute));
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
  }
  .new {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 36px;
    padding: 0 10px 0 11px;
    border-radius: 10px;
    color: var(--paper);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 8%);
    box-shadow:
      0 1px 0 color-mix(in oklab, var(--paper) 6%, transparent) inset,
      0 4px 12px -6px color-mix(in srgb, var(--shade) 70%, transparent);
  }
  .find {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 34px;
    margin-top: 6px;
    padding: 0 10px 0 11px;
    border-radius: 10px;
    color: var(--paper-mute);
    transition: background var(--dur-tap, 90ms) var(--ease-out, ease-out);
  }
  .find:hover {
    background: color-mix(in oklab, var(--surface) 70%, transparent);
  }

  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 8px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .group h2 {
    margin: 0 0 4px;
    padding: 0 10px;
    font: 500 11.5px/1.2 var(--cv-ui, var(--util));
    color: var(--paper-mute);
    letter-spacing: 0.01em;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .group h2 .n {
    color: var(--cv-note, var(--paper-mute));
    font-weight: 400;
  }
  .fold {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: inherit;
  }

  .row {
    position: relative;
    width: 100%;
    display: grid;
    /* The title keeps its room and the place gives way. `1fr auto` let the
       place take what it wanted, and a card on another wall says where in a
       long phrase (`portfolio · on lab-cva.queerisfreedom`), which squeezed its
       title to a letter or to nothing (found driving two labs, 2026-10-19). */
    grid-template-columns: 14px minmax(7em, 1fr) minmax(0, auto);
    align-items: center;
    column-gap: 9px;
    min-height: 32px;
    padding: 5px 9px 5px calc(10px + var(--depth, 0) * 16px);
    border-radius: 9px;
    color: var(--paper-dim);
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .row:hover {
    background: color-mix(in oklab, var(--surface) 70%, transparent);
  }
  .row .t {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row .sub {
    grid-column: 2 / 4;
    font-size: 12px;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 1px;
  }
  .row .aside {
    font-size: 11.5px;
    color: var(--cv-note, var(--paper-mute));
    white-space: nowrap;
    min-width: 0;
    /* Where a row is, or how long its turn has run, is read in passing; its
       title is what you are looking for. Whole on hover (`title`). */
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
  }
  .folder .aside {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
  }
  .row.on {
    background: linear-gradient(
      90deg,
      color-mix(in oklab, var(--raised) 100%, var(--paper) 3%),
      color-mix(in oklab, var(--surface) 90%, transparent)
    );
    color: var(--paper);
    box-shadow: 0 0 0 1px var(--cv-hair, var(--edge)) inset;
  }
  .row.done .t {
    font-weight: 500;
  }
  /* A row that needs you carries its status as light from one edge — the
     wash (§8.2). Achromatic everywhere else. */
  .row.ask {
    background: linear-gradient(
      90deg,
      color-mix(in oklab, var(--st-ask) calc(15% * var(--ch-bloom, 1) + 4%), transparent),
      transparent 80%
    );
    color: var(--paper);
  }
  .row.ask .sub {
    color: color-mix(in oklab, var(--st-ask) 55%, var(--paper-dim));
  }
  .row.fail .sub {
    color: color-mix(in oklab, var(--st-fail) 60%, var(--paper-dim));
  }

  /* A child, joined to its parent by a hairline. */
  .row.kid::before {
    content: "";
    position: absolute;
    left: calc(var(--depth, 1) * 16px);
    top: -6px;
    bottom: 50%;
    width: 9px;
    border-left: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    border-bottom-left-radius: 6px;
  }
  .ghost {
    display: block;
    width: 100%;
    padding: 2px 10px 0 34px;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-radius: 6px;
  }
  button.ghost:hover {
    color: var(--paper-dim);
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 3px;
  }
  .ghost.gone {
    font-style: italic;
  }
  .ghost .act {
    font-style: normal;
  }

  /* Status: the dot carries the colour, and a working one breathes. The breath
     is opacity on a pseudo — the compositor's own — and only while working, so
     a sidebar with nothing working presents nothing (`motion.md`). */
  .st {
    position: relative;
    width: 14px;
    height: 14px;
    display: grid;
    place-items: center;
  }
  .st::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-rest);
  }
  .st.work::before {
    background: var(--st-work);
  }
  .st.ask::before {
    background: var(--st-ask);
  }
  .st.fail::before {
    background: var(--st-fail);
  }
  .st.done::before {
    background: transparent;
    box-shadow: 0 0 0 1.5px var(--paper-mute) inset;
  }
  .st.rest::before {
    width: 6px;
    height: 6px;
    background: transparent;
    box-shadow: 0 0 0 1.3px var(--paper-faint) inset;
  }
  .st.work::after,
  .st.ask::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in oklab, var(--st-work) 55%, transparent), transparent 70%);
    animation: breathe 2.4s var(--ease-move, ease-in-out) infinite alternate;
  }
  .st.ask::after {
    background: radial-gradient(circle, color-mix(in oklab, var(--st-ask) 60%, transparent), transparent 70%);
    animation: none;
    opacity: 0.9;
  }
  @keyframes breathe {
    from {
      opacity: 0.25;
    }
    to {
      opacity: 1;
    }
  }
  :global(html[data-motion="spare"]) .st::after {
    animation-timing-function: steps(6, end);
  }
  :global(html[data-motion="still"]) .st::after {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .st::after {
      animation: none;
    }
  }

  .folder .dots {
    display: inline-flex;
    gap: 3px;
  }
  .folder .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
  }
  .folder .dots i.ask {
    background: var(--st-ask);
  }
  .folder .dots i.fail {
    background: var(--st-fail);
  }
  .folder .count {
    margin-left: 6px;
  }
  .folder :global(svg) {
    color: var(--paper-mute);
  }

  .me {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 0 8px;
    border-top: 1px solid var(--cv-hair, var(--edge));
  }
  .avatar {
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font: 600 12px var(--cv-ui, var(--util));
    color: var(--paper);
    background: radial-gradient(
      circle at 30% 25%,
      color-mix(in oklab, var(--raised) 100%, var(--paper) 10%),
      var(--raised)
    );
    box-shadow:
      0 0 0 2px var(--cv-ground, var(--well)),
      0 0 0 3.5px var(--edge);
  }
  .who {
    display: flex;
    flex-direction: column;
    line-height: 1.25;
    min-width: 0;
  }
  .who b {
    font-weight: 500;
    font-size: 13px;
    color: var(--paper);
  }
  .who span {
    font-size: 11.5px;
    color: var(--paper-mute);
  }
</style>
