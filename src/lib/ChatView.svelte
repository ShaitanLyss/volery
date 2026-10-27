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
  import { ctxSaid, groups, nextNeeding as nextOf, projectsOf, step as stepOf, walkOrder, type ChatRow, type Entered, type Ghost } from "./chatview";
  import CtxRing from "./CtxRing.svelte";
  import { scopeFiles } from "./paths.svelte";
  import { selectionMarkdown } from "./copy";
  import { stepBy, landing } from "./outline";
  import { nudgeReading } from "./layout";
  import { Follow } from "./follow.svelte";
  import { cardName } from "./naming";
  import Sidebar from "./Sidebar.svelte";
  import Thread from "./Thread.svelte";
  import HuntBar from "./HuntBar.svelte";
  import MessageBox from "./MessageBox.svelte";
  import NewChat from "./NewChat.svelte";
  import ProjectPage from "./ProjectPage.svelte";
  import PilePage from "./PilePage.svelte";
  import { whois } from "./whois.svelte";
  import Budget from "./Budget.svelte";
  import AccountPop from "./AccountPop.svelte";
  import Lookup from "./Lookup.svelte";
  import type { Starter } from "./starting.svelte";
  import type { Actions } from "./actions.svelte";
  import type { Ledger } from "./ledger.svelte";
  import type { Entry } from "./search";
  import { CHORDS } from "./leader";
  import { COMMANDS } from "./commands";
  import { footOf } from "./allowance";
  import { waterfall } from "./waterfall.svelte";
  import Ask from "./Ask.svelte";
  import Notice from "./Notice.svelte";
  import Toasts from "./Toasts.svelte";
  import { tick } from "svelte";
  import { waitsOnYou } from "./notice";
  import Icon from "./Icon.svelte";
  import WindowControls from "./WindowControls.svelte";
  import SidePane from "./SidePane.svelte";
  import PlanStrip from "./PlanStrip.svelte";
  import PlanDoc from "./PlanDoc.svelte";
  import { provideOthers } from "./others.svelte";
  import { provideCardLinks } from "./cardlinks.svelte";
  import { cardByHandle } from "./chatview";
  import { view } from "./view.svelte";
  import type { Presence } from "./presence.svelte";
  import type { Elsewhere } from "./shadows.svelte";
  import type { Deferred } from "./presence";
  import { answerPutOff, dropPutOff } from "./putoff.svelte";
  import { boost } from "./boost.svelte";
  import { boostView } from "./boostview.svelte";
  import BoostIgnition from "./BoostIgnition.svelte";
  import { onCredits } from "./credits";

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
    presence,
    elsewhere,
    sidebar = $bindable(true),
    onselect,
    onwall,
    onmenu,
    onprojectmenu,
    onclosecard: closeRow,
    onnew,
    onaccount,
    starter,
    actions,
    ledger,
    onpalette,
    onshowwall,
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
    /** Who started whom (`Elsewhere.kin`), child to parent — `unseen` naming
     *  the wall of a parent this wall holds no word from. */
    kin: readonly { child: string; parent: string; unseen?: string }[];
    /** The reading size the wall's panel is set at (ctrl+wheel), shared. */
    reading?: number;
    /** Whether the window is in front — the follow re-pins on coming back. */
    watching?: boolean;
    /** The questions put off (`Presence.filed`): a conversation holding one
     *  needs you, and the pile is where it is answered. Required, so a mount
     *  cannot leave every one of them out of *needs you* without saying so. */
    presence: Presence;
    /** The other walls — a question put off on one of them is answered over
     *  the flyway (`putoff.svelte.ts`). */
    elsewhere: Elsewhere;
    sidebar?: boolean;
    onselect: (id: string) => void;
    onwall: () => void;
    onmenu: (id: string, at: { x: number; y: number }, keyed: boolean) => void;
    /** A project's menu — the territory's, less the rows that arrange the wall
     *  (`menu.ts`'s `region` case). */
    onprojectmenu: (name: string, at: { x: number; y: number }, keyed: boolean) => void;
    /** Close the conversation a sidebar row stands for. */
    onclosecard: (id: string) => void;
    onnew: () => void;
    onaccount?: () => void;
    /** The empty state's choices and its first send (`starting.svelte.ts`). */
    starter: Starter;
    /** A project's actions, for its page (`actions.svelte.ts`). */
    actions: Actions;
    /** This machine's own allowance reading, for the foot (§5.7). */
    ledger: Ledger;
    /** What a pick in Ctrl+K does when it is not a conversation or a project:
     *  a chord, a command, a setting, the sink — App's to run. */
    onpalette: (e: Entry) => void;
    /** A project page's *show it on the wall*. */
    onshowwall: (name: string) => void;
    onread?: (next: number) => void;
    /** What the window's own title bar carries in either view — the update
     *  offer, the control chip — drawn in this one's. */
    extras?: Snippet;
    /** The fault line and the drawers, drawn at the head of the sheet. */
    band?: Snippet;
  } = $props();

  const card = $derived(cards.find(selected));
  /** Its live plan, read where the wall's plate reads it. */
  const timeline = $derived(card ? skein.timelines.liveFor(card.id) : null);

  /* What a thread drawn here can reach of the others: the card a spawn opened,
     the one a relay came from — and selecting it is this view's to say
     (`others.svelte.ts`). */
  provideOthers({
    find: (handle) => cards.find(cardByHandle(handle, cards.all.map((c) => c.id))),
    open: (id) => choose(id),
  });
  /* A card named in prose opens here as a conversation, not on the wall. */
  provideCardLinks({
    find: (handle) => cards.find(cardByHandle(handle, cards.all.map((c) => c.id))),
    open: (c) => choose(c.id),
    revive: (session) =>
      void skein.revive(session).then((got) => {
        if (typeof got === "string") {
          skein.fault = got;
          whois.unrevivable(session);
        } else {
          /* A refusal from an earlier name left in the bar would read as this
             one having failed too. */
          if (skein.fault?.startsWith("that conversation")) skein.fault = null;
          choose(got.id);
        }
      }),
  });

  /* ── the sidebar's rows ─────────────────────────────────────────────── */

  const parentOf = $derived(new Map(kin.map((k) => [k.child, k.parent])));
  /** Each conversation's oldest question put off, the pile's own order. */
  const filedOf = $derived.by(() => {
    const out = new Map<string, { text: string; at: number; n: number }>();
    for (const d of presence.filed) {
      /* Answered from here and held for a wall not heard from: nothing waits
         on you any more (`Deferred.held`). */
      if (d.held) continue;
      const had = out.get(d.conversationId);
      const text = d.questions[0]?.question ?? "a question";
      if (!had || d.askedAt < had.at) out.set(d.conversationId, { text, at: d.askedAt, n: (had?.n ?? 0) + 1 });
      else had.n++;
    }
    return out;
  });
  /** Parents on a wall this one holds no word from: named as out of reach,
   *  never as closed (`chatview.ts::Ghost`). */
  const unseen = $derived(new Set(kin.filter((k) => k.unseen !== undefined).map((k) => k.parent)));

  /** One card, as the sidebar sees it. The rules are `chatview.ts`'s; this
   *  only reads the handle. */
  function rowOf(h: CardHandle): ChatRow {
    const f = h.face;
    const conv = h.conv;
    /* The first notice that waits on you — the dock's queue, by its one rule
       (`Cards.noticing`): an allowance stop is said as `allowance` instead. */
    const notice = h.notices.find(waitsOnYou) ?? null;
    const ask = h.ask;
    const filed = filedOf.get(h.id);
    /* Which of how many a multi-question call is on: the first one not yet
       answered. */
    const nth = ask ? Math.min(ask.questions.length, ask.answers.filter((a) => a !== null).length + 1) : 1;
    /* Off the handle, which answers it for a card anywhere (`restedAt`): a
       card on another wall used to read no rest at all here, and so was dated
       *now* — every one of them "today", however long it had been quiet. An
       age nothing says reads as the oldest, never as now. */
    const lastAt = f.working ? clock.t : (h.restedAt ?? 0);
    /* Background work is work: a turn that launched an agent, a test run or a
       monitor and ended has not finished anything, and the wall already paints
       such a card celadon (`turns.md`, *Work that outlives a turn*). Read off
       `working` alone, a card that sent off a sub-agent left *working* the
       moment its turn closed and was filed in the day's history. */
    const busy = !f.working && f.busy;
    return {
      id: h.id,
      title: cardName(f.title, "").text || "new conversation",
      project: h.gist.kind === "chat" ? null : f.project || null,
      host: h.remote?.host ?? null,
      working: f.working || f.busy,
      doing: f.working
        ? f.doing
        : busy
          ? f.jobs.length === 1
            ? f.jobs[0].label
            : `${f.jobs.length} running in the background`
          : "",
      asking: ask
        ? { text: ask.questions[nth - 1]?.question ?? "a question", nth, of: ask.questions.length }
        : null,
      /* A question you put off is still yours to answer, whatever the card has
         done since — the agent's call returned long ago. It was always `null`
         here, so *needs you* could never hold one (Lyss, 2026-10-20). */
      deferred: filed?.text ?? null,
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
      /* Off the gist, so a card on another wall answers it from its own
         wall's fold, and one from before `owed` says it does not know. */
      owed: h.gist.owed,
      endedOnQuestion: notice?.kind === "question" || h.gist.ending === "question",
      allowance: h.allowance,
      /* Off the gist, so a card on another wall on credits wears it too. */
      credits: onCredits(h.gist.account),
      ctx: h.gist.ctx,
      ctxTokens: h.gist.ctxTokens,
      dormant: f.dormant,
      aside: f.aside,
      lastAt,
      turnAt: h.turnSince,
      /* When what it needs you for began waiting, which orders *needs you*
         wherever the card runs (`queueOrder`). */
      since: ask ? ask.since : (notice?.raisedAt ?? filed?.at ?? h.restedAt ?? null),
      lastWords: f.lastWords ?? "",
      parent: parentOf.get(h.id) ?? null,
    };
  }

  const rows = $derived(cards.all.map(rowOf));
  /* Plain, not $state: the list's memory of where rows entered, written while
     the groups are made and never read to draw anything. */
  const entered: Entered = new Map();
  const gs = $derived(groups(rows, clock.t, unseen, entered));
  /** The rows in the sidebar's order, every group, set aside last — what
   *  Ctrl+K lists before anything is typed and breaks a tie by. `cards.all`
   *  is this wall's cards and then every other's, which put a card here ahead
   *  of an equal match on another wall. */
  const ordered = $derived.by(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return walkOrder(gs, true).flatMap((id) => byId.get(id) ?? []);
  });
  /* The chat home is a territory so that "no project" has an address
     (`store::chat_home`), and is no project: its conversations say *chat*. */
  const folders = $derived(
    projectsOf(
      rows,
      skein.projects.filter((p) => !skein.isChatHome(p.root_path)).map((p) => p.name),
      clock.t,
    ),
  );

  /* ── questions put off, drawn where they were asked ───────────────────── */

  /** The questions the conversation in front of you put off, oldest first —
   *  drawn at the foot of its thread and answered there (Lyss, 2026-10-20:
   *  *"the deferred questions could be shown in the chat"*), as well as in the
   *  pile. */
  const putOff = $derived(
    card ? presence.filed.filter((d) => d.conversationId === card.id).sort((a, b) => a.askedAt - b.askedAt) : [],
  );
  let sending = $state<string | null>(null);
  let putOffFault = $state<{ id: string; why: string } | null>(null);

  async function answerHere(d: Deferred) {
    if (sending) return;
    putOffFault = null;
    sending = d.id;
    const why = await answerPutOff({ presence, skein, elsewhere }, d);
    sending = null;
    if (why) putOffFault = { id: d.id, why };
  }

  async function dropHere(d: Deferred) {
    if (sending) return;
    putOffFault = null;
    const why = await dropPutOff({ presence, skein, elsewhere }, d);
    if (why) putOffFault = { id: d.id, why };
  }

  /** Take back an answer held for a wall not heard from (`Elsewhere.unhold`). */
  function unholdHere(d: Deferred) {
    const s = elsewhere.find(d.conversationId);
    if (s) elsewhere.unhold(s, d.id);
  }

  /* ── a project's page, and ctrl+K ───────────────────────────────────── */

  /** The project whose page is in the sheet, by name, or null. Choosing a
   *  conversation leaves it (§6.7). */
  let page = $state<string | null>(null);
  /** The sink or the billboard as a page (`PilePage.svelte`), opened from the
   *  sidebar, Ctrl+K's sink entry or a chip naming one of their items — which
   *  is `focus`. One page in the sheet at a time, so it and `page` clear each
   *  other. */
  let pile = $state<{ kind: "sink" | "board"; focus: string | null } | null>(null);
  export function openPile(kind: "sink" | "board", focus: string | null = null) {
    pile = { kind, focus };
    page = null;
    drawer = false;
  }
  /* The sidebar counts what is in each pile, so both are read for as long as
     chat view is up (`Sink` and `Board` read nothing until somebody attaches,
     and refresh on their own change events after). */
  $effect(() => {
    skein.sink.attach("chatview");
    skein.board.attach("chatview");
    return () => {
      skein.sink.detach("chatview");
      skein.board.detach("chatview");
    };
  });
  const piles = $derived([
    { kind: "sink" as const, label: "sink", count: skein.sink.items.length },
    { kind: "board" as const, label: "billboard", count: skein.board.notices.length },
  ]);
  const project = $derived(page ? (skein.projects.find((p) => p.name === page) ?? null) : null);

  /** Open a conversation from the sidebar, the page or Ctrl+K — the page, if
   *  one is up, gives way to it. */
  function choose(id: string) {
    page = null;
    pile = null;
    drawer = false;
    onselect(id);
  }

  /** The parent named above a child in the sidebar. Listed, it is selected;
   *  a card of this wall's that was closed is brought back from its recorded
   *  session — `adopt`'s road, the one a timeline's *pick it back up* takes —
   *  and selected; anything else says why it cannot be opened from here. */
  async function openParent(g: Ghost) {
    if (cards.find(g.id)) return choose(g.id);
    if (g.host !== null || g.state !== "closed") {
      skein.fault =
        g.state === "unseen"
          ? `the conversation that started this one is on ${g.host ?? "another wall"}, which has not been heard from`
          : `the conversation that started this one was closed on ${g.host}`;
      return;
    }
    const s = (await skein.importable()).find((x) => x.id === g.id);
    if (!s) {
      skein.fault = "the conversation that started this one was closed, and its session is no longer on disk";
      return;
    }
    const got = await skein.importSession(s);
    if (typeof got === "string") {
      skein.fault = got;
      return;
    }
    choose(got.id);
  }

  /** The sidebar's *projects* group, and Ctrl+K's projects. */
  export function openProject(name: string) {
    page = name;
    pile = null;
  }

  /** A new conversation: the empty sheet, which is App's to clear the
   *  selection for; here, only the page gives way. */
  export function fresh() {
    page = null;
    pile = null;
  }

  let looking = $state(false);
  /** Ctrl+K and the sidebar's *search*. */
  /** Build a finished plan in the conversation that wrote it: out of plan
   *  first — which takes the plan card down (`Conversation.planDoc`) — and
   *  told to go. The same two moves a hand makes on the wall. */
  async function buildHere(conv: NonNullable<CardHandle["conv"]>, path: string) {
    await skein.setGear(conv, "making");
    /* Taken down here too, not only by the gear's ack: a plan written by a
       card already out of plan first (any write into `~/.claude/plans` is one,
       `Conversation`) has no gear change to clear it, and once the go-ahead
       has gone it is being built, not waiting. */
    if (await skein.send(conv, `The plan in ${path} is approved — build it.`)) conv.planDoc = null;
  }

  /* ── what a screen reader hears (§10.2) ─────────────────────────────── */
  /* Streaming is announced by the paragraph, not the token: each answer as it
     settles into a line, and *finished* when the turn ends. Only for the
     conversation in front of you, and nothing on selecting one — arriving at a
     conversation is not news about it. A question announces itself
     (`.inline`, assertive) and is not repeated here. */
  let announce = $state("");
  let heard = { id: "", lines: 0, working: false };
  $effect(() => {
    const c = card;
    const id = c?.id ?? "";
    const lines = c?.readable.lines ?? [];
    const n = lines.length;
    const working = c?.face.working ?? false;
    untrack(() => {
      if (heard.id !== id) {
        heard = { id, lines: n, working };
        return;
      }
      const fresh = lines.slice(heard.lines).filter((l) => l.kind === "text");
      if (fresh.length) announce = fresh[fresh.length - 1].text.slice(0, 600);
      if (heard.working && !working) announce = `${announce ? `${announce} — ` : ""}finished`;
      heard = { id, lines: n, working };
    });
  });

  /* ── narrow windows (§6.8) ──────────────────────────────────────────── */
  /* Below 900px the sidebar is a drawer behind the bar's menu button, with a
     badge counting what needs you, and the pane is a sheet over the thread.
     Below 600px the model chip and the hint line shorten in their own files,
     by media query, since they have nothing to decide. */
  let width = $state(typeof window === "undefined" ? 1280 : window.innerWidth);
  const narrow = $derived(width < 900);
  let drawer = $state(false);
  const needing = $derived(gs.find((g) => g.key === "needs")?.rows.length ?? 0);
  $effect(() => {
    if (!narrow) drawer = false;
  });

  /** The sidebar, shown or hidden — or, in a narrow window, the drawer
   *  opened or closed. The bar's button and Ctrl+Shift+S. */
  export function toggleSidebar() {
    if (narrow) {
      drawer = !drawer;
      return;
    }
    sidebar = !sidebar;
    view.save();
  }

  /** The side pane, open or closed — the bar's toggle and Ctrl+. (§3). */
  export function togglePane() {
    view.pane = !view.pane;
    view.save();
  }

  export function search() {
    looking = true;
  }

  function picked(e: Entry) {
    looking = false;
    if (e.kind === "conversation") choose(e.id);
    else if (e.kind === "project") openProject(e.name);
    else onpalette(e);
  }

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
    void focusAsk();
    return true;
  }

  /* ── what it is waiting on you for, at the end of its thread ──────────── */

  /** This conversation's own items in the queue (`Front.of`): its question at
   *  the front, and its notices. Drawn as the last thing in the thread, because
   *  in chat view the only way to see a conversation is to open it (§5.3). */
  const own = $derived(selected ? front.of(selected) : []);
  const ownAsk = $derived(own.find((t) => t.kind === "ask") ?? null);
  /** The notices drawn inline: a card's own and a given-up error, which stay
   *  until answered with their own buttons (§5.4). A rest — `done` or
   *  `question` — is the *done with it* line at the foot, acknowledged there
   *  and never by being read. */
  const ownNotices = $derived(
    own.filter((t) => t.kind === "notice" && (t.notice.kind === "error" || t.notice.kind === "card")),
  );
  const endedOnQuestion = $derived(
    own.find((t) => t.kind === "notice" && t.notice.kind === "question") ?? null,
  );

  let askPanel = $state<ReturnType<typeof Ask> | undefined>();

  /** Go to the question on purpose — the toast's *answer*, Alt+↓ — and put
   *  the keyboard on its first option. Never on arrival. */
  export async function focusAsk() {
    await tick();
    askPanel?.focusFirst();
    askPanel && scroller?.scrollTo({ top: scroller.scrollHeight });
  }

  /* ── acknowledging its rest (2026-10-21) ──────────────────────────────
     Reading no longer settles anything (`chatview.ts`, beside `restOwed`): a
     rest waits in *needs you* until you say so. *Done with it* is that, the
     same acknowledgement the wall's dock makes of a notice — one flag, both
     views (`Skein.acknowledgeRest`). Offered on the rest itself, whatever the
     turn was called, so a question the classifier missed has it too. */
  const owed = $derived(card && card.gist.owed === true && !card.face.working ? card : null);
  let acking = $state(false);
  async function doneWith() {
    const c = owed;
    if (!c || acking) return;
    acking = true;
    try {
      const why = await c.acknowledgeRest();
      if (why) skein.fault = why;
    } finally {
      acking = false;
    }
  }

  /* ── the conversation in front of you ───────────────────────────────── */

  /* Paths and pictures in what it says count from the card's own root
     (`Readable.root`), wherever the card runs. The scope is the mounter's to
     set, as the panel sets it (`chatview.md`), and it defaults to off. */
  scopeFiles(() => card?.readable.root ?? null);

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

  const title = $derived(
    pile ? (pile.kind === "sink" ? "the sink" : "the billboard") : project ? project.name : card ? cardName(card.face.title, "").text || "new conversation" : "new conversation",
  );
  const ctx = $derived(card ? Math.round((card.gist.ctx ?? 0) * 100) : 0);
  const place = $derived(
    pile ? "across the wall" : project ? "project" : !card ? null : card.gist.kind === "chat" ? "chat" : card.face.project + (card.remote ? ` · on ${card.remote.host}` : ""),
  );
  /* The account this conversation spends, for the foot. A card on no named
     account is on whatever Claude Code itself is signed in as, which is the
     usual case and not a fault — the allowance reading beside it is phase 5's
     (§5.7). */
  /** Which allowance the foot and the line above the message box read: the
   *  managed account this conversation is on — or, before it is on one, the
   *  account the waterfall would put it on — else this machine's own (§5.7). */
  const label = $derived.by(() => {
    if (card?.face.accountLabel) return card.face.accountLabel;
    if (!waterfall.list.length) return null;
    const next = waterfall.next({});
    return next.kind === "use" ? next.label : (waterfall.usable[0]?.label ?? waterfall.list[0]?.label ?? null);
  });
  const windows = $derived.by(() => {
    if (label) {
      const a = waterfall.allowances[label];
      return a?.ok ? a.windows : null;
    }
    return ledger.limits?.windows ?? null;
  });
  const account = $derived(
    footOf(label, windows, label ? null : (ledger.limits?.plan ?? null), starter.ready === "signed-out"),
  );
  /* This machine's own reading is the ledger's, asked for only while chat view
     is up and no account is managed — the waterfall polls its own, and Rust
     floors both (`limits.rs`). */
  $effect(() => {
    if (waterfall.list.length) return;
    ledger.attach("chatview", "allowance");
    return () => ledger.detach("chatview");
  });
  /** The foot's popover: each window, today's spend, *manage accounts*. */
  let pop = $state(false);
</script>

<svelte:window bind:innerWidth={width} />

<div class="chat" class:nosidebar={!sidebar || narrow} class:narrow>
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
      {#if narrow}
        <button
          class="iconbtn menu"
          type="button"
          title={needing ? `conversations — ${needing} need you (ctrl+shift+S)` : "conversations (ctrl+shift+S)"}
          aria-expanded={drawer}
          onclick={toggleSidebar}
          ><Icon name="menu" />{#if needing}<span class="badge" aria-hidden="true">{needing}</span>{/if}</button
        >
      {:else}
        <button
          class="iconbtn"
          type="button"
          title={sidebar ? "hide the sidebar (ctrl+shift+S)" : "show the sidebar (ctrl+shift+S)"}
          aria-pressed={sidebar}
          onclick={toggleSidebar}><Icon name="side" /></button
        >
      {/if}
    </div>
    <div class="where" data-tauri-drag-region>
      <span class="title" data-tauri-drag-region>{title}</span>
      {#if place}
        <span class="chip"><Icon name={card?.gist.kind === "chat" ? "globe" : "folder"} small />{place}</span>
      {/if}
      {#if card?.gist.planning}
        <span class="chip plan">planning</span>
      {/if}
    </div>
    <span class="grow" data-tauri-drag-region></span>
    {#if card}
      <span class="ctx" title={`how full this conversation's memory is — ${ctxSaid(card.gist.ctx, card.gist.ctxTokens)}`}>
        <CtxRing ctx={card.gist.ctx} dormant={card.face.dormant} size={18} />{ctx}%
      </span>
    {/if}
    {@render extras?.()}
    {#if card}
      <button
        class="iconbtn"
        type="button"
        title={view.pane ? "hide the plan, files and linked conversations (ctrl+.)" : "the plan, files and linked conversations (ctrl+.)"}
        aria-pressed={view.pane}
        onclick={togglePane}><Icon name="pane" /></button
      >
    {/if}
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

  {#if narrow && drawer}
    <!-- The drawer: the same sidebar over the sheet, a scrim behind it that
         closes it, Escape too. Choosing a row closes it (`choose`). -->
    <button type="button" class="scrim" aria-label="close the conversations" tabindex="-1" onclick={() => (drawer = false)}
    ></button>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="drawer"
      onkeydown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          drawer = false;
        }
      }}
    >
      <Sidebar
        groups={gs}
        projects={folders}
        {selected}
        {account}
        onselect={choose}
        onparent={openParent}
        {onnew}
        onsearch={search}
        onproject={openProject}
        {onmenu}
        {onprojectmenu}
        onclose={closeRow}
        {piles}
        pileOn={pile?.kind ?? null}
        onpile={(k) => openPile(k)}
        onaccount={() => (pop = !pop)}
      />
    </div>
  {:else if sidebar && !narrow}
    <Sidebar
      groups={gs}
      projects={folders}
      {selected}
      {account}
      onselect={choose}
      onparent={openParent}
      {onnew}
      onsearch={search}
      onproject={openProject}
      {onmenu}
      {onprojectmenu}
      onclose={closeRow}
        {piles}
        pileOn={pile?.kind ?? null}
        onpile={(k) => openPile(k)}
      onaccount={() => (pop = !pop)}
    />
  {/if}

  <main class="sheet" data-tier={pool} aria-label="conversation">
    {#if boost.on}
      <!-- Boost's look, in this room (`boost.md`): the field fills the sheet
           behind the conversation, the wall's own canvases standing down while
           this view is in front, and one field runs at a time. -->
      <canvas class="boost-ground" aria-hidden="true" {@attach boostView.ground}></canvas>
    {/if}
    <p class="sr" aria-live="polite">{announce}</p>
    {@render band?.()}
    <Toasts
      {front}
      {selected}
      focused={watching}
      onanswer={(id) => {
        onselect(id);
        void focusAsk();
      }}
    />
    {#if pile}
      {#key pile}
        <PilePage kind={pile.kind} focus={pile.focus} sink={skein.sink} board={skein.board} />
      {/key}
    {:else if project}
      <ProjectPage
        {skein}
        {actions}
        {project}
        groups={gs}
        onselect={choose}
        onnew={() => {
          starter.chooseHere({ kind: "project", name: project.name, dir: project.root_path });
          page = null;
          onnew();
        }}
        onwall={() => onshowwall(project.name)}
        onmenu={(at, keyed) => onprojectmenu(project.name, at, keyed)}
      />
    {:else}
    <div class="split">
    <section class="thread" data-attach-to="prompt" style:--read={reading * 1.2}>
      {#if boost.on}
        <!-- The reading is never set over a moving field: a veil of the look's
             own dark stands behind the column, feathered at its sides, so the
             battle goes on in the margins and the words stay still. -->
        <div class="veil" aria-hidden="true"></div>
      {/if}
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
              {#if ownAsk && ownAsk.kind === "ask"}
                {@const sheet = ownAsk.ask}
                <div class="inline" aria-live="assertive">
                  <Ask
                    bind:this={askPanel}
                    ask={sheet}
                    card={card.id}
                    project={card.where}
                    title={card.face.title}
                    scripts={card.scripts}
                    onanswer={() => card.answer(sheet)}
                    ondefer={() => card.defer(sheet)}
                    onheld={() => card.holdAsk()}
                  />
                </div>
              {/if}
              {#each ownNotices as t (t.key)}
                {#if t.kind === "notice"}
                  {@const n = t.notice}
                  <div class="inline">
                    <Notice
                      notice={n}
                      project={card.where}
                      title={card.face.title}
                      onack={() => card.acknowledge(n, "")}
                      onclosecard={() => void card.do("close")}
                      onfollow={(text) => card.acknowledge(n, text)}
                    />
                  </div>
                {/if}
              {/each}
              {#if card.conv?.planDoc}
                {@const conv = card.conv}
                {@const path = conv.planDoc ?? ""}
                <div class="inline">
                  <PlanDoc
                    {path}
                    busy={conv.working}
                    onhere={() => void buildHere(conv, path)}
                    onfresh={() => void card.do("hand")}
                  />
                </div>
              {/if}
              {#each putOff as d (d.id)}
                {#if d.held}
                  <p class="ended">
                    answered — waiting for {d.host} to be heard from, then it goes to the card
                    <button type="button" onclick={() => unholdHere(d)}>take it back</button>
                  </p>
                {:else}
                  <!-- A question put off is the same payload a live one is, so
                       it is the same panel — `Vigil.svelte`'s argument — and
                       answered by the same path (`putoff.svelte.ts`). -->
                  <div class="inline" class:sending={sending === d.id}>
                    <Ask
                      ask={{ askId: d.id, questions: d.questions, answers: d.answers, ours: false, since: d.askedAt }}
                      card={card.id}
                      project={card.where}
                      title={card.face.title}
                      scripts={card.scripts}
                      parked={false}
                      onanswer={() => void answerHere(d)}
                    />
                  </div>
                  <p class="ended">
                    you put this off{#if d.host && card.face.elsewhere?.unheard}
                      — {d.host} has not been heard from, so an answer waits here until it is{/if}
                    <button
                      type="button"
                      onclick={() => void dropHere(d)}
                      title="take it off without answering — the agent was told nothing was decided"
                      >not worth answering</button
                    >
                  </p>
                  {#if putOffFault && putOffFault.id === d.id}
                    <p class="ended fault">{putOffFault.why}</p>
                  {/if}
                {/if}
              {/each}
              {#if owed}
                <p class="ended">
                  {endedOnQuestion || owed.gist.ending === "question" ? "it ended on a question" : "it ended its turn"} —
                  your reply goes in the box below
                  <button
                    type="button"
                    disabled={acking}
                    onclick={() => void doneWith()}
                    title="nothing more to say — take it out of needs you (space then d a)">done with it</button
                  >
                  <button
                    type="button"
                    onclick={() => void card.do("close")}
                    title="close this conversation — the same close the wall's notice offers">close</button
                  >
                </p>
              {:else if endedOnQuestion && endedOnQuestion.kind === "notice"}
                {@const q = endedOnQuestion.notice}
                <p class="ended">
                  it ended on a question — your answer goes in the box below
                  <button type="button" onclick={() => void card.acknowledge(q, "")} title="it needs nothing from you — take it out of needs you"
                    >dismiss</button
                  >
                  <button type="button" onclick={() => void card.do("close")} title="close this conversation">close</button>
                </p>
              {/if}
            {:else}
              <NewChat {skein} {field} {composer} {starter} {rows} groups={gs} />
            {/if}
          </div>
        {/key}
      </div>
      {#if card}
        <!-- `data-boost-anchor`: where a limit break on this conversation
             bursts from (`boostview.svelte.ts`), since there is no card. -->
        <div class="foot" data-boost-anchor={card.id}>
          <div class="above"><PlanStrip {timeline} /></div>
          <Budget {card} {windows} onaccounts={() => onaccount?.()} onusage={() => (pop = true)} />
          <MessageBox {field} {bang} {composer} {card} {starter} />
        </div>
      {/if}
    </section>
    {#if card && view.pane}
      <div class="beside" class:over={narrow}>
        <SidePane {card} {cards} {timeline} {kin} trail={(id) => skein.trail(id)} onselect={choose} />
      </div>
    {/if}
    </div>
    {/if}
    {#if boost.on}
      <!-- Its air, over everything in the sheet and catching nothing: the
           ignition's flash and a limit break's shockwave. -->
      <canvas class="boost-air" aria-hidden="true" {@attach boostView.air}></canvas>
      <BoostIgnition />
    {/if}
  </main>

  {#if pop}
    <AccountPop
      name={account.name}
      {windows}
      spend={skein.spend}
      onmanage={() => {
        pop = false;
        onaccount?.();
      }}
      onclose={() => (pop = false)}
    />
  {/if}
  {#if looking}
    <Lookup
      rows={ordered}
      projects={folders.map((f) => f.name)}
      chords={CHORDS}
      commands={COMMANDS.filter((c) => c.by === "skein")}
      onpick={picked}
      onclose={() => (looking = false)}
    />
  {/if}
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

  /* ── boost (`boost.md`) ──
     The look's colours arrive as `--boost-*` on the studio root, only while
     boost is on. The window around the sheet takes the look's dark and the bar
     its light, as the wall's does. The sheet becomes the battlefield: the
     field's canvas sits behind its content (the sheet isolates, so `-1` is
     above its own ground and under everything else), the moments' canvas over
     it. */
  :global(.studio[data-boost]) .chat {
    background: var(--boost-card);
    /* The surfaces chat view lifts things on — the message box, a selected
       row, a button — take the look's dark, a little lit by its light, so
       nothing in the room is left in the studio's brown. Set here, where the
       look is worn, rather than reached for in each component. */
    --cv-lift: color-mix(in oklab, var(--boost-card) 82%, var(--boost-b) 18%);
    --cv-hair: color-mix(in oklab, var(--boost-a) 30%, transparent);
    --surface: color-mix(in oklab, var(--boost-card) 88%, var(--boost-b) 12%);
    --raised: color-mix(in oklab, var(--boost-card) 80%, var(--boost-b) 20%);
  }
  :global(.studio[data-boost]) .bar {
    position: relative;
    background: var(--boost-bar);
  }
  :global(.studio[data-boost]) .bar::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    pointer-events: none;
    background: linear-gradient(90deg, transparent 0%, var(--boost-c) 20%, var(--boost-b) 35%, var(--boost-a) 50%, var(--boost-b) 65%, var(--boost-c) 80%, transparent 100%);
    background-size: 200% 100%;
    animation: boost-sweep 6s linear infinite;
  }
  @keyframes boost-sweep {
    from { background-position: 0% 0; }
    to { background-position: -200% 0; }
  }
  :global(html[data-motion="spare"]) :global(.studio[data-boost]) .bar::after {
    animation-timing-function: steps(24, end);
  }
  :global(html[data-motion="still"]) :global(.studio[data-boost]) .bar::after {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.studio[data-boost]) .bar::after {
      animation: none;
    }
  }
  :global(.studio[data-boost]) .sheet {
    isolation: isolate;
    background: var(--boost-ground);
    border-color: color-mix(in srgb, var(--boost-a) 30%, transparent);
  }
  .boost-ground,
  .boost-air {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .boost-ground {
    z-index: -1;
  }
  .boost-air {
    z-index: 5;
  }
  /* Behind the column and nothing else: the measure plus a margin each side,
     feathered so it reads as the dark gathering under the words rather than as
     a box. Four fifths opaque at its core: enough that what moves behind a
     line of prose is a dim glow rather than a shape, and not so much that the
     sheet becomes a dark slab with the battle pushed to its edges — which the
     first cut, fully opaque, was. */
  .veil {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: min(calc(var(--cv-measure, 44rem) + 7rem), 100%);
    transform: translateX(-50%);
    pointer-events: none;
    --v: color-mix(in srgb, var(--boost-card) 80%, transparent);
    background: linear-gradient(90deg, transparent, var(--v) 3.5rem, var(--v) calc(100% - 3.5rem), transparent);
  }
  /* The thread and, when it is open, the pane beside it (§3). */
  .split {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  /* Heard, not seen. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .beside {
    display: flex;
    min-height: 0;
  }
  /* Narrow: the pane is a sheet over the thread rather than a column beside
     it, which would leave the thread too little to be read in. */
  .beside.over {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 3;
    box-shadow: -18px 0 40px -24px color-mix(in srgb, var(--shade) 90%, transparent);
  }

  /* ── narrow windows (§6.8) ── */
  .chat.narrow .word,
  .chat.narrow .mark {
    display: none;
  }
  .chat.narrow .brand {
    width: auto;
  }
  .menu {
    position: relative;
  }
  .badge {
    position: absolute;
    top: -2px;
    right: -3px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 999px;
    font-size: 10px;
    line-height: 15px;
    font-weight: 600;
    text-align: center;
    color: var(--ink);
    background: var(--st-ask);
  }
  .scrim {
    position: absolute;
    inset: 44px 0 0 0;
    z-index: 20;
    border: 0;
    padding: 0;
    background: color-mix(in srgb, var(--shade) 45%, transparent);
    animation: fade var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  .drawer {
    position: absolute;
    top: 44px;
    left: 0;
    bottom: 0;
    z-index: 21;
    width: min(300px, 86vw);
    display: flex;
    flex-direction: column;
    background: var(--cv-ground, var(--well));
    border-right: 1px solid var(--cv-hair, var(--edge));
    box-shadow: 18px 0 40px -24px color-mix(in srgb, var(--shade) 90%, transparent);
    animation: drawer var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  .drawer > :global(.side) {
    flex: 1 1 auto;
  }
  @keyframes drawer {
    from {
      transform: translateX(-16px);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer {
      animation-name: fade;
    }
  }
  /* Below 600px the bar keeps what it must: the menu, the title, the switch
     as its icons. */
  @media (max-width: 599px) {
    .chat .chip,
    .chat .ctx {
      display: none;
    }
    .views button {
      font-size: 0;
      gap: 0;
    }
  }
  .thread {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
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
    /* A run of machinery as the mockups' quiet card (`.work`). */
    --run-border: 1px solid var(--cv-hair, var(--edge));
    --run-radius: var(--cv-r-m, 12px);
    --run-fill: color-mix(in oklab, var(--surface) 55%, transparent);
    --run-pad: 9px 12px;
    --run-face: var(--cv-ui, var(--util));
    --run-size: 13px;
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
  /* What stands above the message box: the plan, while there is one. */
  .above {
    width: min(calc(var(--cv-measure, 46rem) + 2rem), calc(100% - 48px));
    margin: 0 auto 8px;
    display: flex;
    justify-content: center;
  }
  .above:empty {
    display: none;
  }
  /* Its question and its notices, as the last thing in the thread. No cap on
     their height: the column scrolls (§7.4). */
  .inline {
    --ask-ceiling: none;
    font-family: var(--cv-ui, var(--util));
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  .ended {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 12.5px;
    color: color-mix(in oklab, var(--st-ask) 55%, var(--paper-dim));
  }
  .ended.fault {
    color: var(--st-fail);
  }
  .sending {
    opacity: 0.6;
    pointer-events: none;
  }
  .ended button {
    margin-left: 6px;
    font-size: 12px;
    color: var(--paper-dim);
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 3px;
  }
  .sheet :global(.hunt) {
    top: 10px;
    right: 18px;
  }
</style>
