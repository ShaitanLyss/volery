<script lang="ts">
  /* Chat view: one conversation in front of you, every other one down the
     side, a message box at the foot (`docs/chat-mode.md`).

     A second *presentation* of the same wall, and that is the whole of its
     architecture: it reads the one `Skein` through the card handles, sends
     through the one composer, draws the one queue (`front.svelte.ts`) and the
     one column (`Thread.svelte`). It forks nothing. What it owns is the
     arrangement — the sidebar's groups are `chatview.ts`'s, the sheet's light
     is the tokens' — and the few gestures that only make sense here.

     Selecting a conversation is `onselect`, which in App sets the focus and
     nothing else: never `focusCard`, which would reveal the card on a wall that
     is offstage and pan it, and never the wall's selection, which is a
     gathering Lyss may have built (§5.2). */
  import { clock } from "./conversation.svelte";
  import type { Skein } from "./skein.svelte";
  import type { CardHandle, Cards } from "./cards.svelte";
  import type { Field } from "./field.svelte";
  import type { Bang } from "./bang.svelte";
  import type { Composer } from "./composer.svelte";
  import type { Front } from "./front.svelte";
  import type { Snippet } from "svelte";
  import { untrack } from "svelte";
  import { groups, nextNeeding as nextOf, projectsOf, step as stepOf, walkOrder, type ChatRow } from "./chatview";
  import { scopeFiles, scopePictures } from "./paths.svelte";
  import { selectionMarkdown } from "./copy";
  import { stepBy, landing } from "./outline";
  import { nudgeReading } from "./layout";
  import { Follow } from "./follow.svelte";
  import { cardName } from "./naming";
  import Sidebar from "./Sidebar.svelte";
  import Thread from "./Thread.svelte";
  import HuntBar from "./HuntBar.svelte";
  import MessageBox from "./MessageBox.svelte";
  import Icon from "./Icon.svelte";
  import WindowControls from "./WindowControls.svelte";

  let {
    skein,
    cards,
    front,
    composer,
    field,
    bang,
    selected,
    kin,
    reading = 1,
    watching = true,
    sidebar = $bindable(true),
    onselect,
    onwall,
    onmenu,
    onnew,
    onsearch,
    onproject,
    onaccount,
    onread,
    extras,
    band,
  }: {
    skein: Skein;
    cards: Cards;
    front: Front;
    composer: Composer;
    field: Field;
    bang: Bang;
    /** The conversation in front of you — the wall's focus. */
    selected: string | null;
    /** Who started whom (`Elsewhere.kin`), child to parent. */
    kin: readonly { child: string; parent: string }[];
    /** The reading size the wall's panel is set at (ctrl+wheel), shared. */
    reading?: number;
    /** Whether the window is in front — the follow re-pins on coming back. */
    watching?: boolean;
    sidebar?: boolean;
    onselect: (id: string) => void;
    onwall: () => void;
    onmenu: (e: MouseEvent, id: string) => void;
    onnew: () => void;
    onsearch: () => void;
    onproject: (name: string) => void;
    onaccount?: () => void;
    onread?: (next: number) => void;
    /** What the window's own title bar carries in either view — the update
     *  offer, the control chip — drawn in this one's. */
    extras?: Snippet;
    /** The fault line and the drawers, drawn at the head of the sheet. */
    band?: Snippet;
  } = $props();

  const card = $derived(cards.find(selected));

  /* ── the sidebar's rows ─────────────────────────────────────────────── */

  const parentOf = $derived(new Map(kin.map((k) => [k.child, k.parent])));

  /** One card, as the sidebar sees it. The rules are `chatview.ts`'s; this
   *  only reads the handle. */
  function rowOf(h: CardHandle): ChatRow {
    const f = h.face;
    const conv = h.conv;
    const resting = (f as { restingSince?: number | null }).restingSince ?? null;
    const notice = h.notices[0] ?? null;
    const ask = h.ask;
    /* Which of how many a multi-question call is on: the first one not yet
       answered. */
    const nth = ask ? Math.min(ask.questions.length, ask.answers.filter((a) => a !== null).length + 1) : 1;
    const lastAt = f.working
      ? clock.t
      : Math.max(resting ?? 0, conv?.lastActive ?? 0) || clock.t;
    return {
      id: h.id,
      title: cardName(f.title, "").text || "new conversation",
      project: conv ? (conv.kind === "chat" ? null : f.project) : f.project || null,
      host: h.remote?.host ?? null,
      working: f.working,
      doing: f.working ? f.doing : "",
      asking: ask
        ? { text: ask.questions[nth - 1]?.question ?? "a question", nth, of: ask.questions.length }
        : null,
      deferred: null,
      notice: notice
        ? {
            kind:
              notice.kind === "error"
                ? "failed"
                : notice.kind === "card"
                  ? "own"
                  : notice.kind === "question"
                    ? "question"
                    : "done",
            text: notice.text,
          }
        : null,
      failed: f.tier === "fail",
      aside: f.aside,
      lastAt,
      turnAt: f.working ? (conv?.turnSince ?? null) : null,
      lastWords: f.lastWords ?? "",
      parent: parentOf.get(h.id) ?? null,
    };
  }

  const rows = $derived(cards.all.map(rowOf));
  const gs = $derived(groups(rows, clock.t));
  const folders = $derived(projectsOf(rows, skein.projects.map((p) => p.name), clock.t));

  /** Ctrl+Tab and Ctrl+Shift+Tab: the next conversation in the sidebar's
   *  order, not the wall's (§5.2). */
  export function walk(by: 1 | -1) {
    const to = stepOf(walkOrder(gs), selected, by);
    if (to) onselect(to);
  }

  /** Alt+↓ and `space d n`: the next thing that needs you. False when nothing
   *  does, for the caller to say so. */
  export function nextNeeding(): boolean {
    const to = nextOf(gs, selected);
    if (!to) return false;
    onselect(to);
    return true;
  }

  /* ── the conversation in front of you ───────────────────────────────── */

  /* Paths in what it says count from its directory; its pictures are read off
     this disk only when it is here. The scopes are the mounter's to set, as
     the panel sets them (`chatview.md`), and they default to off. */
  scopeFiles(() => (card?.conv?.kind === "project" ? card.conv.cwd : null) ?? null);
  scopePictures(() => (card?.conv?.kind === "project" ? card.conv.cwd : null) ?? null);

  let scroller: HTMLDivElement | undefined = $state();
  let thread = $state<ReturnType<typeof Thread> | undefined>();
  const follow = new Follow();

  /* A different conversation is a fresh view, starting at its tail. */
  $effect(() => {
    void selected;
    untrack(() => follow.fresh());
  });
  /* Coming back to the window honours the tail (the panel's argument). */
  $effect(() => {
    void watching;
    untrack(() => follow.keepTail());
  });

  /** Ctrl+F: the thread's find, over this sheet's column. */
  export function hunt() {
    thread?.finder().open();
  }

  /** Ctrl+↑↓ and Ctrl+PgUp/PgDn, with the caret in the message box — the
   *  panel's keys, reading this column. */
  export function step(kind: "line" | "page", dir: -1 | 1) {
    const el = scroller;
    if (!el) return;
    follow.stepped();
    const line = el.querySelector(".line");
    const px = line ? parseFloat(getComputedStyle(line).lineHeight) : NaN;
    const delta = dir * stepBy(kind, Number.isFinite(px) && px > 0 ? px : 26, el.clientHeight);
    el.scrollTop = landing(el.scrollTop, delta, el.scrollHeight, el.clientHeight);
  }

  /** The top of the thread — Home, with the caret outside the message box. */
  export function top() {
    follow.stepped();
    if (scroller) scroller.scrollTop = 0;
  }

  function onCopy(e: ClipboardEvent) {
    const md = selectionMarkdown();
    if (!md) return;
    e.clipboardData?.setData("text/plain", md);
    e.preventDefault();
  }

  /* Ctrl+wheel over the sheet sizes the reading, as over the panel. */
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = nudgeReading(reading, e.deltaY);
      if (next !== reading) onread?.(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /** The status the sheet's pool of light takes — the conversation's own,
   *  and nothing at rest (§8.2). */
  const pool = $derived(
    !card ? "rest" : card.ask || card.face.tier === "ask" ? "ask" : card.face.tier === "fail" ? "fail" : card.face.working ? "work" : "rest",
  );

  const title = $derived(card ? cardName(card.face.title, "").text || "new conversation" : "chat");
  const ctx = $derived(card ? Math.round((card.face.ctx ?? 0) * 100) : 0);
  const place = $derived(
    !card ? null : card.conv?.kind === "chat" ? "chat" : card.face.project + (card.remote ? ` · on ${card.remote.host}` : ""),
  );
  /* The account this conversation spends, for the foot. A card on no named
     account is on whatever Claude Code itself is signed in as, which is the
     usual case and not a fault — the allowance reading beside it is phase 5's
     (§5.7). */
  const account = $derived({
    name: card?.face.accountLabel ?? "claude code",
    line: card?.face.accountLabel ? "this conversation's account" : "as this computer is signed in",
  });
</script>

<div class="chat" class:nosidebar={!sidebar}>
  <header class="bar" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="cv-markg" x1="0.15" y1="0.95" x2="0.9" y2="0.1">
            <stop offset="0" stop-color="var(--st-work)" />
            <stop offset="1" stop-color="var(--st-ask)" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="12" r="8.2" fill="none" stroke="var(--edge)" stroke-width="3.4" />
        <path d="M12 3.8a8.2 8.2 0 1 1-8 6.4" fill="none" stroke="url(#cv-markg)" stroke-width="3.4" stroke-linecap="round" />
      </svg>
      <span class="word" data-tauri-drag-region>volery</span>
      <button
        class="iconbtn"
        type="button"
        title={sidebar ? "hide the sidebar (ctrl+shift+S)" : "show the sidebar (ctrl+shift+S)"}
        aria-pressed={sidebar}
        onclick={() => (sidebar = !sidebar)}><Icon name="side" /></button
      >
    </div>
    <div class="where" data-tauri-drag-region>
      <span class="title" data-tauri-drag-region>{title}</span>
      {#if place}
        <span class="chip"><Icon name={card?.conv?.kind === "chat" ? "globe" : "folder"} small />{place}</span>
      {/if}
      {#if card?.conv?.gear === "planning"}
        <span class="chip plan">planning</span>
      {/if}
    </div>
    <span class="grow" data-tauri-drag-region></span>
    {#if card}
      <span class="ctx" title="how full this conversation's memory is">
        <i class="ring" style:--p={ctx}></i>{ctx}%
      </span>
    {/if}
    {@render extras?.()}
    <div class="views" role="group" aria-label="view">
      <button type="button" onclick={onwall} title="the wall — every conversation at once (ctrl+shift+M, or space then w v)">
        <Icon name="wall" small />wall
      </button>
      <button type="button" class="on" aria-pressed="true" title="chat — one conversation at a time">
        <Icon name="chat" small />chat
      </button>
    </div>
    <span class="winctl"><WindowControls /></span>
  </header>

  {#if sidebar}
    <Sidebar
      groups={gs}
      projects={folders}
      {selected}
      {account}
      {onselect}
      {onnew}
      {onsearch}
      {onproject}
      {onmenu}
      {onaccount}
    />
  {/if}

  <main class="sheet" data-tier={pool} aria-label="conversation">
    {@render band?.()}
    <section class="thread" data-attach-to="prompt" style:--read={reading * 1.2}>
      {#if thread?.finder().on}
        <HuntBar hunt={thread.finder()} onclose={() => composer.input?.focus()} />
      {/if}
      <div class="scroll" bind:this={scroller} oncopy={onCopy} {@attach follow.attach}>
        <!-- Keyed on the conversation: a different one is a fresh view (its
             folds start closed, as the panel's do), and it arrives by rising
             6px over `--dur-step` rather than snapping in (§9.2). -->
        {#key selected}
          <div class="col">
            {#if card}
              <Thread bind:this={thread} {card} />
            {:else}
              <div class="greeting">
                <h1>what shall we work on?</h1>
                <p>pick a conversation on the left, or start a new one.</p>
              </div>
            {/if}
          </div>
        {/key}
      </div>
      <div class="foot">
        <MessageBox {field} {bang} {composer} {card} />
      </div>
    </section>
  </main>
</div>

<style>
  .chat {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: 264px minmax(0, 1fr);
    grid-template-rows: 44px minmax(0, 1fr);
    background: var(--cv-ground, var(--well));
    color: var(--paper);
    font-family: var(--cv-ui, var(--util));
    font-size: 13.5px;
    line-height: 1.45;
    /* Rises in over the wall going offstage (§9.2): opacity and a scale from
       1.015, once, over `--dur-stage`. */
    animation: rise var(--dur-stage, 520ms) var(--ease-move, ease-in-out) both;
  }
  .chat.nosidebar {
    grid-template-columns: 0 minmax(0, 1fr);
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  :global(html[data-motion="still"]) .col {
    animation-name: fade;
    animation-duration: var(--dur-quick, 160ms);
  }
  @media (prefers-reduced-motion: reduce) {
    .col {
      animation-name: fade;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: scale(1.015);
    }
  }
  :global(html[data-motion="still"]) .chat {
    animation-duration: var(--dur-quick, 160ms);
    animation-name: fade;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat {
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
  }

  /* ── the title bar, which is the window's drag region ─────────────────── */
  .bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 0 0 14px;
    min-width: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 238px;
    flex: none;
  }
  .chat.nosidebar .brand {
    width: auto;
  }
  .mark {
    width: 20px;
    height: 20px;
  }
  .word {
    font-family: var(--display);
    font-size: 17px;
    letter-spacing: 0.01em;
  }
  .brand .iconbtn {
    margin-left: auto;
  }
  .iconbtn {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: var(--paper-mute);
    transition:
      background var(--dur-tap, 90ms) var(--ease-out, ease-out),
      color var(--dur-tap, 90ms) var(--ease-out, ease-out);
  }
  .iconbtn:hover {
    background: color-mix(in oklab, var(--surface) 80%, transparent);
    color: var(--paper);
  }
  .where {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding-left: 14px;
  }
  .where .title {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--paper-dim);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 55%, transparent);
    white-space: nowrap;
  }
  .chip.plan {
    border-style: dashed;
  }
  .grow {
    flex: 1;
    align-self: stretch;
  }
  .ctx {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--paper-mute);
  }
  .ring {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: conic-gradient(
      var(--paper-dim) calc(var(--p) * 1%),
      color-mix(in oklab, var(--edge) 90%, transparent) 0
    );
    mask: radial-gradient(circle, transparent 4.2px, #000 4.6px);
  }
  .views {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: 10px;
    background: color-mix(in oklab, var(--surface) 70%, transparent);
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .views button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border-radius: var(--cv-r-s, 7px);
    font-size: 12px;
    color: var(--paper-mute);
  }
  .views button.on {
    background: var(--raised);
    color: var(--paper);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--shade) 40%, transparent);
    cursor: default;
  }
  .winctl {
    align-self: stretch;
    display: flex;
  }

  /* ── the sheet, lit from above ───────────────────────────────────────── */
  .sheet {
    grid-column: 2;
    grid-row: 2;
    position: relative;
    margin: 0 8px 8px 0;
    min-height: 0;
    min-width: 0;
    border-radius: 14px;
    overflow: hidden;
    /* The lamp, the grain over it, the sheet's own slight gradient: light, not
       paint. Static, so rastered once (`theme.md`). */
    background:
      var(--cv-grain, none),
      radial-gradient(90% 55% at 50% -8%, var(--cv-lamp, transparent), transparent 72%),
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--cv-sheet, var(--ink)) 100%, var(--paper) 1.5%),
        var(--cv-sheet, var(--ink)) 40%
      );
    background-blend-mode: soft-light, normal, normal;
    border: 1px solid var(--cv-hair, var(--edge));
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--shade) 30%, transparent),
      0 18px 40px -24px color-mix(in srgb, var(--shade) 90%, transparent);
    display: flex;
    flex-direction: column;
  }
  .chat.nosidebar .sheet {
    margin-left: 8px;
  }
  .thread {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* The agent answers in a book's voice and you write in the UI's (§8.3):
       the column is the studio's serif, and your bubble takes the UI face
       through `--you-face` below. */
    font-family: var(--body);
    /* The prose at the reading size, in the reading colour (§8.1, §8.3); the
       thread reads both, and is not reached into. */
    --tx-prose: var(--cv-prose, var(--paper-dim));
    --tx-round: 0rem;
    --tx-round-rule: transparent;
    /* Your half, as a bubble on the right (§7.2): the thread's own knobs. */
    --you-align: flex-end;
    --you-width: fit-content;
    --you-fill: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 4%), var(--raised));
    --you-radius: 19px 19px 6px 19px;
    --you-rule: 1px solid color-mix(in oklab, var(--edge) 80%, var(--paper) 5%);
    --you-edge: 1px solid color-mix(in oklab, var(--edge) 80%, var(--paper) 5%);
    --you-first-top: color-mix(in oklab, var(--edge) 80%, var(--paper) 5%);
    --you-pad-l: 15px;
    --you-pad-r: 15px;
    --you-pad-t: 10px;
    --you-pad-b: 11px;
    --you-face: var(--cv-ui, var(--util));
    --you-size: 14.5px;
  }
  /* The pool: the status of the conversation in front of you, as light at the
     foot of the thread. Static once drawn; only its opacity moves between
     states, once, over `--dur-scene`. */
  .thread::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 340px;
    pointer-events: none;
    z-index: 0;
    background: radial-gradient(52% 78% at 50% 104%, var(--pool, transparent), transparent 74%);
    opacity: var(--pool-on, 0);
    transition: opacity var(--dur-scene, 360ms) var(--ease-out, ease-out);
  }
  .sheet[data-tier="work"] {
    --pool: var(--cv-pool-work, transparent);
    --pool-on: 1;
  }
  .sheet[data-tier="ask"] {
    --pool: var(--cv-pool-ask, transparent);
    --pool-on: 1;
  }
  .sheet[data-tier="fail"] {
    --pool: var(--cv-pool-fail, transparent);
    --pool-on: 1;
  }
  .scroll {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 34px 0 26px;
    /* The column fades out under the message box, so it reads as passing
       beneath rather than being cut. */
    mask: linear-gradient(180deg, transparent 0, #000 26px, #000 calc(100% - 18px), transparent);
  }
  .col {
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
    width: min(var(--cv-measure, 44rem), calc(100% - 64px));
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: calc(1.1rem * var(--read, 1));
    min-height: 100%;
    justify-content: flex-end;
  }
  .col :global(.line) {
    max-width: none;
  }
  .col :global(.line.you) {
    max-width: 78%;
  }
  .foot {
    position: relative;
    z-index: 2;
    padding: 0 0 18px;
  }
  .greeting {
    margin: auto 0;
    text-align: center;
  }
  .greeting h1 {
    margin: 0 0 8px;
    font-family: var(--cv-ui-display, var(--display));
    font-weight: 400;
    font-size: 28px;
    color: var(--paper);
  }
  .greeting p {
    margin: 0;
    color: var(--cv-note, var(--paper-mute));
  }
  .sheet :global(.hunt) {
    top: 10px;
    right: 18px;
  }
</style>
