<script lang="ts">
  /* One Asana project's board, and its cards where you put them.
   *
   * Named for what it draws rather than for the service, the way `Basin`,
   * `Gatehouse`, `Billboard` and `Keyring` are — and there is a hard reason on
   * top of the convention: `Asana.svelte` beside `asana.svelte.ts` is two paths
   * differing in case alone, which TypeScript on Windows reads as one file
   * included twice and refuses to compile. The same trap `creds.svelte.ts` was
   * renamed out of; see `.claude/rules/integrations.md`.
   *
   * The reading Asana's own board gives you already — except that this one is
   * on the wall beside the cards doing the work, at the size you chose, with no
   * tab to go and find. That is the whole argument for drawing it here, and it
   * is the same one the pipelines widget makes.
   *
   * **This one writes**, which makes it the first widget on this wall that
   * does, and the floor is drawn deliberately narrow: a card can be moved
   * between columns and nothing else. No create, no complete, no rename, no
   * comment, no delete. The argument `Pipelines` makes about not offering
   * "re-run failed jobs" beside a job list is stronger here — a wall you glance
   * at is not a place for a destructive verb, and a drag is a gesture you can
   * make by accident. A move is reversible by dragging it back, which is what
   * makes it the one write worth having.
   *
   * ## The drag is pointer events, not HTML5 drag-and-drop
   *
   * Deliberate, and not merely conservative. Every gesture on this wall is
   * built on pointer events — `Canvas`'s pan and marquee, a card's drag, a
   * widget's resize — so this is the mechanism that is already proved in this
   * webview, and it is the one whose interaction with `Canvas` is understood.
   * HTML5 `dragstart` also fires only *after* the pointer has travelled, which
   * is exactly the window in which `Canvas` claims the press and starts moving
   * the widget instead.
   *
   * Which is the other half: a card carries `data-grip`, so `Canvas.handleOf`
   * leaves the press alone entirely (see its comment — the wall's handler is on
   * an ancestor in the capture phase, so `stopPropagation` here could not help).
   * That hands this component the whole gesture, including the part the wall
   * normally owns: **the press is a click until it has travelled 4px.** Same
   * rule, same slop, stated once for the wall and obeyed here because nothing
   * else can. Under 4px a card opens in Asana; past it, it moves.
   *
   * ## What is optimistic and what is true
   *
   * `plan` in `asana.ts` decides where the card is drawn and what Asana is told
   * in one call, so the two cannot disagree — the trap being that `addTask`
   * with no position means *top of the column*, not "where you dropped it".
   * `asana.svelte.ts` owns the timing: the redraw is instant, a poll landing
   * mid-save is dropped, a refusal rolls back and says so, and either way a
   * reconciling read follows because Asana decides the final ordering. Nothing
   * here waits on the network. */

  import { Asana, type Named } from "./asana.svelte";
  import {
    boardReading,
    columnOf,
    dueReading,
    emptySaid,
    todayIso,
    type Card,
    type Column,
  } from "./asana";
  import { clock } from "./conversation.svelte";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    asana,
    onopen,
    onkeyring,
    onconfig,
  }: {
    widget: Widget;
    /** The one connection behind however many board widgets are up — idle, and
     *  reading nothing, until one attaches. */
    asana: Asana;
    /** Out to the browser, for a card. `Skein.openLink`, which is `open.rs`:
     *  where a click goes is the studio's to decide, not an instrument's. */
    onopen: (url: string) => void;
    /** Ask for the tokens panel. Asana has no credential ladder behind it, so
     *  an unstored token is the *whole* reason this widget is blank — which
     *  makes the way to fix it worth putting on the empty state rather than
     *  only in a menu. Routed out for the reason `onopen` is. */
    onkeyring?: () => void;
    /** Choose the project. A widget's own config, written the way a timer
     *  writes its run — `config_json` is one opaque column, so this costs no
     *  command and no migration.
     *
     *  It is drawn *here* rather than only in the right-click menu because a
     *  board with no project is not a board: the knob is the widget's entire
     *  content until it is set, and a first-run state whose only affordance is
     *  a menu you have to know about is a widget that looks broken. */
    onconfig?: (key: string, value: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const project = $derived(textOf(widget, "project", ""));
  const open = $derived(textOf(widget, "showing", "open") === "open");

  /* The wall's own one-second tick, taken directly — the same rune `Clock` and
     `Pipelines` read, and the reason none of them adds a wake-up to an idle
     machine. Only the date matters here, so this recomputes a string once a
     second and changes it once a day. */
  const today = $derived(todayIso(new Date(clock.t)));

  /* Asking is what makes the poller run at all: with no board widget up,
     nothing asks Asana anything. Two effects rather than one, for the reason
     `Perf.svelte` and `Pipelines` give — a tracking effect's cleanup fires on
     every change, so a single one would detach and reattach on every redraw,
     and this effect tracks the project and the filter on purpose so that
     changing either re-attaches to the right reading. */
  $effect(() => {
    asana.attach(widget.id, project, open);
  });
  $effect(() => () => asana.detach(widget.id));

  const watch = $derived(asana.watch(project, open));
  const board = $derived(watch?.board ?? null);
  const said = $derived(
    emptySaid(asana.token.held(), project, board, watch?.ready ?? false),
  );
  /** What is typed into the picker's filter. */
  let sieve = $state("");
  /** Whether the picker has been opened out to every project. */
  let browsing = $state(false);

  /** The projects to offer, once the connection has them.
   *
   *  **Yours first, and by default only yours.** Measured against the real
   *  workspace on 2026-09-03, this account's token can see **64 projects** and
   *  is a *member* of three — and those three are exactly the ones Asana's own
   *  sidebar shows under Work. A picker that opened on all 64 would bury the
   *  answer nine times in ten, so the default is the short list and the long
   *  one is a press away.
   *
   *  Typing counts as browsing, which is why a filter searches everything
   *  rather than only what is shown: somebody typing a name has already told
   *  you they are looking past the default. Substring and case-insensitive —
   *  a project name is a phrase somebody typed rather than a path, so there is
   *  nothing here for a fuzzy score to prefer. */
  const choices: Named[] = $derived.by(() => {
    const q = sieve.trim().toLowerCase();
    const from = q || browsing ? asana.projects : asana.mine;
    return q ? from.filter((p) => p.name.toLowerCase().includes(q)) : from;
  });

  /** How many are being kept back, so the affordance can say how much it
   *  opens rather than merely that it opens something. */
  const rest = $derived(asana.projects.length - asana.mine.length);

  /* ── the drag ────────────────────────────────────────────────────────────*/

  /** A press on a card, which is a click until it has travelled. */
  let held = $state<{
    task: string;
    url: string;
    /** Where the press started, in client space, for the 4px test. */
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);

  /** Where it would land: a column, and the card it would sit above (null being
   *  the end of that column). Held apart from `held` so the indicator can
   *  redraw without the press object being replaced on every move. */
  let overCol = $state<string | null>(null);
  let overBefore = $state<string | null>(null);

  /** 4px, the wall's own slop. Stated in `Canvas.groundDown` for every gesture
   *  the wall answers; repeated here because a grip owns its whole press and
   *  there is nothing else to inherit it from. */
  const SLOP = 4;

  function press(e: PointerEvent, card: Card) {
    /* Left button only. A right-click is the widget's menu, which is the wall's
       to answer — and it reaches here because `data-grip` took the press off
       the wall, so it has to be handed back by not claiming it. */
    if (e.button !== 0) return;
    held = { task: card.gid, url: card.url, sx: e.clientX, sy: e.clientY, moved: false };
    overCol = null;
    overBefore = null;
  }

  /* Window-level rather than on the card, the same arrangement `Canvas` uses
     for its own gestures: a pointer that leaves the card mid-drag — which is
     the entire point of a drag — must not stop the gesture, and a release
     outside the widget still has to end it. */
  function moveAt(e: PointerEvent) {
    if (!held) return;
    if (!held.moved) {
      if (Math.abs(e.clientX - held.sx) < SLOP && Math.abs(e.clientY - held.sy) < SLOP) {
        return;
      }
      held.moved = true;
    }
    aimAt(e.clientX, e.clientY);
  }

  /** What is under the pointer, in the board's own vocabulary.
   *
   *  `elementFromPoint` rather than arithmetic over stored rects, because the
   *  board is inside a canvas that is scaled and panned — client coordinates
   *  are the one space both the pointer and the DOM agree on, and the browser
   *  has already done the transform. It also means a column that has been
   *  scrolled needs no bookkeeping here. */
  function aimAt(x: number, y: number) {
    const at = document.elementFromPoint(x, y) as HTMLElement | null;
    const col = at?.closest<HTMLElement>("[data-col]");
    if (!col) {
      /* Off the board entirely. The aim is cleared rather than kept, so
         releasing out here drops nothing — a gesture that wandered off is a
         gesture you abandoned. */
      overCol = null;
      overBefore = null;
      return;
    }
    overCol = col.dataset.col ?? null;
    const over = at?.closest<HTMLElement>("[data-card]");
    if (!over) {
      /* The column but not a card — its padding, or the tail past the last
         one. Both mean the end. */
      overBefore = null;
      return;
    }
    /* Above or below, by the card's own middle. The top half means "land above
       this one"; the bottom half means "above whichever comes next", which at
       the end of a column is the end of it — and `null` is how `plan` spells
       that. */
    const r = over.getBoundingClientRect();
    const above = y < r.top + r.height / 2;
    overBefore = above ? (over.dataset.card ?? null) : (over.dataset.next || null);
  }

  function release() {
    const was = held;
    held = null;
    const col = overCol;
    const before = overBefore;
    overCol = null;
    overBefore = null;
    if (!was) return;
    if (!was.moved) {
      /* It never travelled, so it was a click. */
      onopen(was.url);
      return;
    }
    if (col === null) return;
    void asana.move(project, open, was.task, col, before);
  }

  /** Escape abandons a drag in progress. Anything that runs a gesture on this
   *  wall owns the key while it is running — the same contract every panel has
   *  — and a drag you cannot get out of without dropping somewhere is a drag
   *  you have to undo instead. */
  function abandon(e: KeyboardEvent) {
    if (e.key !== "Escape" || !held) return;
    held = null;
    overCol = null;
    overBefore = null;
    e.stopPropagation();
  }

  /** Whether the insertion line goes above this card. */
  function lineAbove(col: Column, card: Card): boolean {
    return !!held?.moved && overCol === col.gid && overBefore === card.gid;
  }

  /** And whether it goes at the end of this column. */
  function lineAtEnd(col: Column): boolean {
    return !!held?.moved && overCol === col.gid && overBefore === null;
  }

  function why(card: Card, col: Column): string {
    const due = dueReading(card.due, today);
    const bits = [col.name, card.assignee, due?.text].filter(Boolean);
    return `${card.name}\n${bits.join(" · ")}`;
  }

  /** The column a card started in, so the one being dragged can be faded where
   *  it still sits rather than vanishing from under the pointer. */
  const liftedFrom = $derived(held?.moved && board ? columnOf(board, held.task) : null);
</script>

<svelte:window
  onpointermove={held ? moveAt : undefined}
  onpointerup={held ? release : undefined}
  onkeydown={held ? abandon : undefined}
/>

<div class="board" data-variant={variant} class:dragging={!!held?.moved}>
  <header>
    <span class="what" title={board?.name ?? "asana"}>{board?.name ?? "asana"}</span>
    {#if board}
      <!-- What it holds and what it cost, the same as the pipelines widget's:
           this is somebody else's server and the wall should be honest about
           asking it. -->
      <span class="tally">{boardReading(board)}</span>
    {/if}
  </header>

  {#if said}
    <div class="empty">
      <p>{said}</p>
      {#if !asana.token.held() && onkeyring}
        <button class="verb" onclick={() => onkeyring?.()}>store one</button>
      {:else if !project}
        <!-- The picker *is* the widget until a project is chosen. A first-run
             state whose only affordance is a right-click menu you have to know
             about is a widget that reads as broken. -->
        {#if asana.projectsFault}
          <p class="oops">{asana.projectsFault}</p>
        {:else if !asana.projectsReady}
          <p class="dim">finding your projects…</p>
        {:else if asana.projects.length === 0}
          <p class="dim">this token can see no projects</p>
        {:else}
          <!-- An `input` is one of the things `Canvas.handleOf` already leaves
               alone, so a drag across it selects text instead of carrying the
               wall away. Nothing to mark. -->
          <input
            class="sieve"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="which project?"
            bind:value={sieve}
          />
          <ul class="pick" data-text>
            {#each choices as p (p.gid)}
              <li>
                <button class="verb" onclick={() => onconfig?.("project", p.gid)}>
                  {p.name}
                </button>
              </li>
            {/each}
            {#if choices.length === 0}
              <li class="dim">nothing matches</li>
            {/if}
            <!-- The way to the other sixty-one. Not shown once you are already
                 browsing or filtering, both of which are past it. -->
            {#if !browsing && !sieve.trim() && rest > 0}
              <li>
                <button class="verb faint" onclick={() => (browsing = true)}>
                  browse the other {rest}…
                </button>
              </li>
            {/if}
          </ul>
        {/if}
      {/if}
    </div>
  {:else if board && variant === "counts"}
    <!-- The compact reading: how much is in each column and nothing else. A
         different reading of the same fact rather than a lesser one — this is
         the shape that still says something at the size of a card, where a
         board says nothing at all. Deliberately not draggable: it is a gauge,
         and a column with no cards drawn in it has nothing to drop *between*. -->
    <ul class="counts" data-text>
      {#each board.columns as col (col.gid || col.name)}
        {@const n = col.cards.length}
        {@const most = Math.max(1, ...board.columns.map((k: Column) => k.cards.length))}
        <li>
          <span class="name">{col.name}</span>
          <span class="bar"><i style:width="{(n / most) * 100}%"></i></span>
          <span class="n">{n}</span>
        </li>
      {/each}
    </ul>
  {:else if board}
    <div class="lanes">
      {#each board.columns as col (col.gid || col.name)}
        <!-- `data-col` is what the drag hit-tests against. The unsectioned pile
             carries an empty one, which is honest: it is a real place a card
             can be and not a place one can be put, since there is no section to
             POST to — `plan` refuses it, and this is why it can be hovered
             without becoming a target. -->
        <section class="lane" data-col={col.gid}>
          <h4>
            <span class="cname">{col.name}</span>
            <span class="cn">{col.cards.length}</span>
          </h4>
          <!-- `data-text`: a drag inside a column means moving a card or
               selecting a word, never carrying the wall away. Same marker a
               log's lines carry, and the same reason. -->
          <ul class="cards" data-text>
            {#each col.cards as card, i (card.gid)}
              {#if lineAbove(col, card)}
                <li class="line" aria-hidden="true"></li>
              {/if}
              <!-- `data-next` is the card *after* this one, so the bottom half
                   of a card can mean "above whichever comes next" without the
                   hit test having to know an index. Empty at the end of the
                   column, which reads as null and is how `plan` spells the
                   end. -->
              <li
                class="card"
                data-card={card.gid}
                data-next={col.cards[i + 1]?.gid ?? ""}
                data-grip
                class:lifting={held?.moved && held.task === card.gid}
                class:done={card.completed}
                title={why(card, col)}
                onpointerdown={(e) => press(e, card)}
              >
                <span class="cardname">{card.name}</span>
                <span class="meta">
                  {#if card.assignee}<span class="who">{card.assignee}</span>{/if}
                  {#if dueReading(card.due, today)}
                    {@const due = dueReading(card.due, today)!}
                    <span class="due" class:late={due.late}>{due.text}</span>
                  {/if}
                </span>
              </li>
            {/each}
            {#if lineAtEnd(col)}
              <li class="line" aria-hidden="true"></li>
            {/if}
            <!-- The tail. It is what makes the empty part of a column a drop
                 target for "the end", and it is why a column with nothing in it
                 can be dropped into at all. -->
            <li class="tail" aria-hidden="true"></li>
          </ul>
        </section>
      {/each}
    </div>
  {/if}

  {#if watch?.refused}
    <!-- The card has already gone back where it came from, so this sentence is
         the only remaining evidence that anything happened — which is why it is
         dismissed rather than cleared by the next redraw. -->
    <button class="oops" onclick={() => asana.dismiss(project, open)}>
      {watch.refused}
    </button>
  {:else if watch?.fault}
    <p class="oops quiet">{watch.fault}</p>
  {/if}
</div>

<style>
  .board {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    overflow: hidden;
    font-size: 0.72rem;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 0 0 auto;
  }
  .what {
    font-family: var(--display);
    font-size: 0.84rem;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tally {
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── the empty states ──────────────────────────────────────────────────*/

  .empty {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    overflow: hidden;
  }
  .empty p {
    margin: 0;
    color: var(--paper-faint);
    line-height: 1.4;
  }
  .dim {
    color: var(--paper-faint);
  }
  .pick {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  /* Monospace like every other field in this app, and sized to the widget
     rather than to the panel it is not in. */
  .sieve {
    font-family: var(--mono);
    font-size: 0.68rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.2rem 0.35rem;
    width: 100%;
    box-sizing: border-box;
    flex: 0 0 auto;
  }
  .sieve:focus {
    outline: none;
    border-color: var(--rule);
  }
  .sieve::placeholder {
    color: var(--paper-faint);
  }

  .verb {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.22rem 0.45rem;
    cursor: pointer;
    text-align: left;
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .verb:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  /* The way past the default, which is not one of the choices — so it is drawn
     as a quieter thing than the rows above it rather than as another row. */
  .faint {
    border-color: transparent;
    color: var(--paper-faint);
  }

  /* ── the board ─────────────────────────────────────────────────────────*/

  .lanes {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    gap: 0.4rem;
    overflow-x: auto;
  }
  .lane {
    flex: 0 0 10.5rem;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-height: 0;
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.3rem;
    /* Nothing standing on the wall may be transparent — the backdrop draws
       behind everything, and a leaf drifting through a column would be the
       same bug a dormant card once had. See `.claude/rules/ambience.md`. */
    background: var(--ink);
  }
  h4 {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .cname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cn {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
    overflow-y: auto;
    min-height: 0;
    flex: 1 1 auto;
    /* The other half of `data-text` — see `LogTail`'s `.log`, where the same
       pair is explained: the attribute takes the press off the wall and this is
       what makes the selection it allows actually happen. */
    user-select: text;
  }

  .card {
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--surface);
    padding: 0.28rem 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    cursor: grab;
    /* A card is the one thing here that is dragged, so it must not also be
       text you select by accident mid-gesture. The column around it keeps
       `user-select: text`, which is what a drag across the gaps still means. */
    user-select: none;
  }
  .card:hover {
    border-color: var(--rule);
  }
  /* Where the card came from, while it is being carried. Faded rather than
     removed: a card that vanishes from under the pointer takes the sense of
     what is being moved with it, and the column's height would jump. */
  .lifting {
    opacity: 0.35;
    border-style: dashed;
  }
  /* Ticked, which is not the same as being in a "done" column — see
     `asana.ts`. Struck through rather than coloured, because colour is status
     on this wall and "finished" is the one status that is good news. */
  .done .cardname {
    text-decoration: line-through;
    color: var(--paper-faint);
  }
  .cardname {
    color: var(--paper-mute);
    line-height: 1.3;
    /* Two lines, then ellipsis. A card's name is the whole of what it is and
       the first few words are nearly always enough; three would make a column
       of four cards. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.6rem;
    color: var(--paper-faint);
    overflow: hidden;
  }
  .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .due {
    margin-left: auto;
    white-space: nowrap;
  }
  /* Overdue is the one status a date carries on its own. Today is not late —
     colouring it would make every board red by lunchtime. */
  .due.late {
    color: var(--st-fail);
  }

  /* Where it would land. Not a colour: this is a position rather than a status,
     and the wall's colour is spoken for. */
  .line {
    height: 0;
    border-top: 2px solid var(--paper);
    margin: 0.05rem 0;
    list-style: none;
  }
  .tail {
    list-style: none;
    flex: 1 1 auto;
    min-height: 0.8rem;
  }
  /* While a card is in the air, nothing else should look pressable. */
  .dragging .card {
    cursor: grabbing;
  }

  /* ── the compact reading ───────────────────────────────────────────────*/

  .counts {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    user-select: text;
  }
  .counts li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .counts .name {
    flex: 0 1 auto;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 45%;
  }
  .counts .bar {
    flex: 1 1 auto;
    height: 3px;
    background: var(--edge);
    border-radius: 2px;
    overflow: hidden;
  }
  .counts .bar i {
    display: block;
    height: 100%;
    background: var(--paper-faint);
  }
  .counts .n {
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    min-width: 1.4em;
    text-align: right;
  }

  /* ── what went wrong ───────────────────────────────────────────────────*/

  .oops {
    flex: 0 0 auto;
    text-align: left;
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--st-fail);
    background: color-mix(in srgb, var(--st-fail) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-fail) 30%, var(--edge));
    border-radius: 3px;
    padding: 0.25rem 0.35rem;
    cursor: pointer;
    margin: 0;
    max-height: 3.4rem;
    overflow: hidden;
  }
  /* A reading that failed, as opposed to a save that was refused. Quieter,
     because the rows already drawn are still there and a blip heals itself on
     the next beat — where a refused move has already been taken back. */
  .quiet {
    background: none;
    border: 0;
    padding: 0.1rem 0;
    cursor: default;
  }
</style>
