/* The studio, in the front end: projects, conversations, dev servers, and the
 * traffic between them and Rust.
 *
 * The restore model is lazy *in the paint*. On launch the wall draws itself
 * entirely from SQLite — every card in its pinned position, drawn hollow — with
 * nothing spawned and nothing awaited, which is what makes the first frame
 * instant however many cards are on it. Dev servers then start eagerly, because
 * they are the slow thing and nothing about them is speculative.
 *
 * Behind that painted wall, two passes run and neither is awaited: the
 * transcripts are read (`#fillHistory`) and the cards are roused (`#rouse`).
 * Rousing gives each card its process back and asks any card that was mid-turn
 * when the app closed to pick that turn up — see ./rousing.ts. A card you speak
 * to before the queue reaches it is simply skipped, so the two never fight. */

import { invoke } from "@tauri-apps/api/core";
import { blockersFor, bypassNote, sayBlocked, swapNote, type Choice } from "./accounts";
import { waterfall } from "./waterfall.svelte";
import { listen } from "@tauri-apps/api/event";
import {
  NO_ANSWER_NOTE,
  blankAnswers,
  composeAnswer,
  normalizeAsk,
  overflowOf,
} from "./asking";
import {
  contextWindowFor,
  healDelayMs,
  healNote,
  HOLD_LINE,
  NUDGE_BUDGET,
  nudgeGaveUpNote,
  nudgeNote,
  NUDGE_PROMPT_TEXT,
  NUDGE_TEXT,
  WAKE_GRACE_S,
  windowForObserved,
} from "./classify";
import {
  repairWorthTrying,
  sayNothingToRepair,
  sayRepair,
  type RepairReport,
} from "./repair";
import { Conversation, type ConvKind } from "./conversation.svelte";
import { foldTranscript, trimOverlap } from "./history";
import { layout, type Placement } from "./layout";
import type { Kin } from "./lineage";
import { Listeners } from "./listeners";
import { Flights, type SentEvent } from "./relay.svelte";
import { Board } from "./board.svelte";
import { Sink } from "./sink.svelte";
import { cliCommand, isEffort } from "./commands";
import type { Preset } from "./presets";
import { UNNAMED, isNamed, titleFromPrompt } from "./naming";
import {
  ROUSE_GAP_MS,
  type LostJob,
  jobsPrompt,
  resumePrompt,
  rouseOrder,
} from "./rousing";
import { dayStart } from "./usage";
import type { Studio } from "./studio.svelte";

export type Project = {
  id: string;
  name: string;
  root_path: string;
  /** Where its territory was put, or null while the grid still decides. */
  x: number | null;
  y: number | null;
  /** Where its territory is *drawn* if it has been stuck to the glass, in
   *  screen pixels, or null for one standing on the wall. Independent of the
   *  pair above, which stays whatever the wall says — see `glass.ts`. */
  glassX: number | null;
  glassY: number | null;
};

/** A conversation Claude Code recorded, as read off disk by `sessions.rs`.
 *
 *  Field names are the Rust struct's, so they arrive snake_case. `model` is the
 *  bare API name with no window tier — the transcript has no `system/init` in
 *  it — which is why `ctx_tokens` is a count rather than a fraction. */
export type Session = {
  id: string;
  cwd: string;
  branch: string | null;
  title: string | null;
  model: string | null;
  ctx_tokens: number;
  born_at: string | null;
  last_at: string | null;
  bytes: number;
};

export type ServerSpec = {
  label: string;
  command: string;
  cwd: string | null;
  port: number | null;
};

export type ServerGroup = {
  id: string;
  project_id: string;
  label: string;
  autostart: boolean;
  start_order: number;
  servers: ServerSpec[];
};

export type ServerHealth = "idle" | "starting" | "up" | "exited";

export class GroupRuntime {
  readonly group: ServerGroup;
  running = $state(false);
  health = $state<Record<string, ServerHealth>>({});
  log = $state<{ label: string; line: string; stderr: boolean }[]>([]);

  constructor(group: ServerGroup) {
    this.group = group;
  }

  /** One state for the whole group, for the chip on the wall. */
  overall = $derived.by<ServerHealth>(() => {
    const vals = this.group.servers.map((s) => this.health[s.label] ?? "idle");
    if (vals.some((v) => v === "exited")) return "exited";
    if (vals.length && vals.every((v) => v === "up")) return "up";
    if (vals.some((v) => v === "starting" || v === "up")) return "starting";
    return "idle";
  });
}

const MAX_LOG = 400;

/** How often the wall re-tries cards that are holding, when the per-hold timer
 *  cannot help — a blocker that named no reset leaves nothing to aim at, and
 *  only a fresh reading can say. A minute is well under Rust's own poll floor
 *  in the common case, which is what makes it cheap: `releaseHeld` asks, and is
 *  usually answered out of the cache without touching the network. */
const HOLD_SWEEP_MS = 60_000;

export class Skein {
  projects = $state<Project[]>([]);
  convs = $state<Conversation[]>([]);
  groups = $state<GroupRuntime[]>([]);
  fault = $state<string | null>(null);
  loaded = $state(false);
  /** `SKEIN_NO_SERVERS` was set, so no group was started on load. Kept as state
   *  rather than checked where it is needed, because it has to be *sayable*: a
   *  wall whose servers are all down for a reason must not look like a wall
   *  whose servers all failed. */
  serversQuiet = $state(false);
  /** `SKEIN_NO_WAKE` was set, so no card was roused on load. Kept for the same
   *  reason `serversQuiet` is: a wall left dormant on purpose and a wall whose
   *  every wake failed look identical, and the difference is worth saying. */
  wakeQuiet = $state(false);
  /** The rousing queue is working its way along the wall. */
  rousing = $state(false);

  /** Where chat cards stand (`store::chat_home`), once Rust has said.
   *
   *  Held because the wall has to be able to recognise that one territory:
   *  everything it offers — a new conversation, a worktree to branch — is a
   *  thing a chat card cannot have, and a `+` there that quietly made an
   *  ordinary card would put an agent with the whole machine in Skein's own
   *  data folder. Null until `load` has asked, which is the honest state and
   *  reads as "not the chat territory" everywhere it is consulted. */
  chatHome = $state<string | null>(null);

  isChatHome(rootPath: string): boolean {
    return this.chatHome !== null && rootPath === this.chatHome;
  }

  #byId = new Map<string, Conversation>();

  /** Wakes in flight, by card id — see `#spawn`. One attempt per card, shared
   *  by everybody who asks for it while it is running. */
  #waking = new Map<string, Promise<"spawned" | "already" | "failed">>();
  /** Heals waiting to fire, by conversation id. Held rather than fired and
   *  forgotten because a timer that outlives this Skein is the same leak
   *  `detach` exists for — in dev that is every file save, and what it would
   *  cost is a prompt re-sent by an instance whose wall is already gone. */
  #heals = new Map<string, ReturnType<typeof setTimeout>>();
  /** Nudges waiting to fire, by conversation id. Kept separately from `#heals`
   *  because the two can be owed at once and mean opposite things — a heal
   *  re-sends a turn that never reached a model, a nudge asks a card to look at
   *  work that finished — and collapsing them into one map would silently drop
   *  whichever was owed second. */
  #nudges = new Map<string, ReturnType<typeof setTimeout>>();
  #studio: Studio;
  /** Held so `detach` can give them back — see ./listeners.ts for why that
   *  matters to a class with no lifecycle of its own. */
  #listeners = new Listeners();

  /** What is crossing the wall between cards, and what is waiting undelivered.
   *
   *  Owned here rather than given a `listen()` of its own, for the reason
   *  `listeners.ts` gives: a second subscriber is a second thing to release in
   *  `App.svelte`'s `onDestroy`, and the one that gets forgotten goes on
   *  drawing for a wall nobody can see. */
  flights = new Flights();

  /** The billboard, and the one reader behind however many are hung on the
   *  wall. Idle until one is — see `board.svelte.ts`. Owned here for the reason
   *  `flights` is: this is the only place that talks to Rust. */
  board = new Board();

  /** Who opened whom, for the roots the wall draws behind its cards.
   *
   *  Read once at launch and then only ever appended to, because a spawn
   *  *emits*: `spawn:asked` carries the pair, so there is nothing to poll and no
   *  second question to ask. Rows whose ends are not both on the wall are
   *  dropped in `lineage.ts::familiesOf` rather than swept from here — a card
   *  closed and then restored from the same session would otherwise lose a root
   *  that is still true, and the table itself is deliberately never swept.
   *
   *  `born` is set only for a pair this session saw arrive, and it is the whole
   *  of how a new root grows out while a restored one is simply there. */
  kin = $state<Kin[]>([]);

  /** Where the wall should draw an image a card has pinned, and who draws it.
   *
   *  A hook rather than a `listen()` in `App.svelte`, for the reason
   *  `listeners.ts` gives and `board.others` already follows: this class is the
   *  only thing that talks to Rust, and a second subscription is a second thing
   *  to release in `onDestroy` — the one that gets forgotten goes on writing
   *  rows for a wall nobody can see. The images live in `App.svelte`'s `Board`,
   *  which is why this is handed out rather than called from here. */
  onPin:
    | ((
        path: string,
        x: number,
        y: number,
        mark: { id: string; by: string },
      ) => void)
    | null = null;

  /** And an agent changing one it already pinned. Separate from `onPin` because
   *  the two do different things to the same list: one adds a row, the other
   *  edits, moves or removes one that is already there. */
  onRepin:
    | ((
        id: string,
        change: {
          path: string | null;
          place: string | null;
          remove: boolean;
          card: { x: number; y: number };
        },
      ) => void)
    | null = null;

  /** The sink, and the one reader behind however many are hung on the wall.
   *  Idle until one is — see `sink.svelte.ts`. Owned here for `board`'s
   *  reason. */
  sink = new Sink();

  constructor(studio: Studio) {
    this.#studio = studio;
    this.#wire();
    /* The wall is itself a watcher, not only the accounts panel: the waterfall
       has to be readable at the moment somebody sends, and a registry first
       read *during* a send would make the first prompt of every session take
       the unmanaged path. With no accounts registered this costs one local
       call and then nothing, since `poll` asks for no labels. */
    waterfall.attach("wall");
    this.#holdSweep = setInterval(() => {
      /* Only when something is actually waiting. The per-hold timer is the
         precise way out and this is the backstop for the case it cannot cover:
         a blocker that named no reset, so there was no instant to aim at. */
      if (this.convs.some((c) => c.held)) void this.releaseHeld();
    }, HOLD_SWEEP_MS);
  }

  #holdSweep: ReturnType<typeof setInterval> | null = null;

  /** This Skein has been let go of — see `detach`. Read by the rousing queue,
   *  which is the one loop here that outlives a single tick. */
  #gone = false;

  /** Stop listening. Called when the component that built this goes away, which
   *  in dev is every time a file is edited. Without it a superseded Skein keeps
   *  ingesting events and writing rows for a wall nobody can see. */
  detach() {
    this.#gone = true;
    this.#listeners.detach();
    waterfall.detach("wall");
    if (this.#holdSweep !== null) clearInterval(this.#holdSweep);
    this.#holdSweep = null;
    for (const t of this.#holds.values()) clearTimeout(t);
    this.#holds.clear();
    for (const t of this.#heals.values()) clearTimeout(t);
    this.#heals.clear();
    for (const t of this.#nudges.values()) clearTimeout(t);
    this.#nudges.clear();
  }

  /** How many subscriptions are live, so the control surface can prove there is
   *  exactly one Skein listening. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      listen<{ id: string; event: any }>("conv:event", (e) => {
        const c = this.#byId.get(e.payload.id);
        if (!c) return;
        c.ingest(e.payload.event);
        this.#persistConv(c, e.payload.event);
        this.#writeJobs(c);
        /* After the persist, deliberately. The turn that just broke is a `turn`
           row like any other and belongs in the ledger whether or not it is
           about to be tried again — a retry that swallowed the failed attempt
           would make the day's figure understate what the wall actually
           spent. */
        this.#heal(c);
        this.#nudge(c);
        this.#settleRepair(c);
      }),
    );
    keep(
      listen<{ id: string; line: string }>("conv:stderr", (e) => {
        this.#byId.get(e.payload.id)?.noteStderr(e.payload.line);
      }),
    );
    keep(
      listen<{ id: string; code: number | null }>("conv:exit", (e) => {
        this.#byId.get(e.payload.id)?.markExited(e.payload.code);
      }),
    );

    keep(
      /* `ask` is the tool call's arguments, exactly as the model wrote them —
         Rust reads nothing out of them (see `AskOpened`). Normalizing here is
         what lets a question shape change without touching Rust, and what
         keeps a malformed payload from parking a card with nothing to click. */
      listen<{
        conversation_id: string;
        ask_id: string;
        ask: { question?: unknown; options?: unknown; questions?: unknown };
      }>("ask:opened", (e) => {
        const c = this.#byId.get(e.payload.conversation_id);
        if (!c) return;
        const raw = e.payload.ask ?? {};
        const questions = normalizeAsk(raw);
        c.pendingAsk = {
          askId: e.payload.ask_id,
          questions,
          answers: blankAnswers(questions),
          dropped: overflowOf(raw),
          since: Date.now(),
        };
        c.activity = questions.length > 1 ? "asked you a few things" : "asked you";
      }),
    );

    keep(
      /* `answered` is false when ask.rs gave up rather than when you replied —
         the ten minutes ran out, or the card was closed mid-question. A card
         that finds its own ask still parked here is one that never answered, so
         the transcript says so: the agent went on regardless, and a panel that
         showed the question and then nothing at all leaves that unaccounted
         for. An answered ask has already cleared `pendingAsk` in `answerAsk`
         and drawn its own line, so this loop finds nothing to do. */
      listen<{ ask_id: string; answered: boolean }>("ask:closed", (e) => {
        for (const c of this.#byId.values()) {
          if (c.pendingAsk?.askId !== e.payload.ask_id) continue;
          c.pendingAsk = null;
          if (!e.payload.answered) c.note(NO_ANSWER_NOTE);
        }
      }),
    );

    keep(
      /* One event per recipient, so a broadcast is a strand each rather than
         one event the webview has to fan out — which would mean the wall
         deciding who a message reached, a question only `relay.rs` can
         answer. */
      listen<SentEvent>("relay:sent", (e) => {
        this.flights.sent(e.payload);
      }),
    );

    keep(
      /* Every write to the billboard goes through `board.rs`, which emits — so
         there is an event for every change there is and nothing here polls.
         `refresh` is a no-op when nothing is looking at it, which is the whole
         of what keeps a wall with no billboard up from ever reading the
         table. */
      listen<{ project_id: string | null }>("board:changed", () => {
        void this.board.refresh();
      }),
    );

    keep(
      /* Same bargain, one table over. */
      listen<{ project_id: string | null }>("sink:changed", () => {
        void this.sink.refresh();
      }),
    );

    keep(
      /* An agent has made something to look at and `pin.rs` has copied it into
         our own storage. Where it goes is this side's knowledge — a card's drawn
         position comes out of `layout`, which Rust has never heard of — and so
         is how big it is, which only the webview can answer. */
      listen<{
        id: string;
        parent_id: string;
        cwd: string;
        worktree: string | null;
        prompt: string;
        title: string | null;
      }>(
        "spawn:asked",
        (e) => {
          const { id, parent_id, cwd, worktree, prompt, title } = e.payload;
          /* The root is recorded before the card is opened, and `born` is
             stamped here rather than read back off the row: this is the moment
             it happened, and a growth animation timed off a later query would
             start from whenever the query answered. Rust has already written
             the row (`record_spawn`), so nothing is being claimed early — this
             is the same fact, in the frame that draws it. */
          this.kin = [...this.kin, { child: id, parent: parent_id, born: Date.now() }];
          void this.openSpawned(id, cwd, worktree, prompt, title);
        },
      ),
    );

    keep(
      /* And the other end of the same gesture: a card taking one of its own
         children off the wall. Through `close` like any other closing, which is
         `openSpawned`'s argument in reverse — the ordering that gesture depends
         on (the card leaves the wall *before* the three bookkeeping calls, per
         `restore.md`) lives in exactly one place, and a second path would be
         the one that forgets it.

         `spawn.rs` has already checked that this card may be closed by that
         one; the guard here is only that it is still on the wall. Two calls in
         quick succession for the same card is otherwise a second round of
         bookkeeping against a row already marked closed. */
      listen<{ id: string; parent_id: string }>("close:asked", (e) => {
        const conv = this.#byId.get(e.payload.id);
        if (conv) void this.close(conv);
      }),
    );

    keep(
      listen<{ conversation_id: string; path: string; image_id: string }>(
        "pin:asked",
        (e) => {
          const spot = this.spotBeside(e.payload.conversation_id);
          this.onPin?.(e.payload.path, spot.x, spot.y, {
            id: e.payload.image_id,
            by: e.payload.conversation_id,
          });
        },
      ),
    );

    keep(
      listen<{
        conversation_id: string;
        image_id: string;
        path: string | null;
        place: string | null;
        remove: boolean;
      }>("repin:asked", (e) => {
        /* The card's spot travels with it, because `beside the card` is the one
           move that needs to know where the card is and `pin.rs` has no way to
           find out — the layout is computed here. Sent unconditionally rather
           than only for that move: working out whether it is needed would be
           this reading the meaning of a word the board is about to read anyway. */
        const spot = this.spotBeside(e.payload.conversation_id);
        this.onRepin?.(e.payload.image_id, {
          path: e.payload.path,
          place: e.payload.place,
          remove: e.payload.remove,
          card: spot,
        });
      }),
    );

    keep(
      listen<{ group_id: string; label: string; line: string; stderr: boolean }>(
        "server:log",
        (e) => {
          const g = this.groups.find((g) => g.group.id === e.payload.group_id);
          if (!g) return;
          g.log.push({
            label: e.payload.label,
            line: e.payload.line,
            stderr: e.payload.stderr,
          });
          if (g.log.length > MAX_LOG) g.log = g.log.slice(-MAX_LOG);
        },
      ),
    );
    keep(
      listen<{ group_id: string; label: string; state: ServerHealth }>(
        "server:state",
        (e) => {
          const g = this.groups.find((g) => g.group.id === e.payload.group_id);
          if (!g) return;
          g.health = { ...g.health, [e.payload.label]: e.payload.state };
        },
      ),
    );
  }

  /** Paint the wall from disk, then start the servers. No agent is spawned. */
  async load() {
    /* What today has cost so far, before anything is painted — the figure and
       the ground's warmth are about the day rather than about this run of the
       app, so a launch at four in the afternoon must not start them at zero.
       Not awaited, and outside the try: it reports its own failure by leaving
       the last figure alone, and the wall is correct without it. */
    this.dayTick(Date.now());

    try {
      const s = await invoke<{
        projects: Project[];
        conversations: any[];
        server_groups: ServerGroup[];
      }>("load_studio");

      this.projects = s.projects;

      /* Learned off the wall where it can be: a chat card's cwd *is* the chat
         home, so a wall holding one knows where it is on the first frame with
         no round trip to wait for. */
      this.chatHome =
        s.conversations.find((r) => r.kind === "chat")?.cwd ?? null;
      /* And asked for when it cannot, because a territory outlives its last
         card. Close every chat card and the `chat` territory stays on the wall
         with nothing in it to learn from — and an unrecognised chat territory
         offers `new conversation here`, which spawns a *project* card: the
         whole machine, `--dangerously-skip-permissions` and all, wearing the
         label `chat` in the territory called `chat` because a project card
         takes its name from its directory's basename. A chat card that has
         lost its sandbox has to be the thing you can see; that one is
         indistinguishable from the sandbox working.

         Not awaited — the wall is painted and correct without it, and the only
         thing it decides is what one territory's menu offers. It also creates
         the directory, which is why it is asked on every launch rather than
         only when a chat card is made: an empty folder beside the database is
         a smaller thing to carry than that card is. */
      void this.#chatHome().catch(() => {});

      for (const row of s.conversations) {
        const c = Conversation.restore(row);
        this.#byId.set(c.id, c);
        /* A row exists for a card that has been pinned *or* stuck to the glass,
           and the two are independent — a card can be stuck without ever having
           been dragged, in which case `x`/`y` are the zeros the row was minted
           with and `pinned` is false, so the wall flows it exactly as before. */
        if (row.x !== null && row.y !== null) {
          this.#studio.placements[c.id] = {
            x: row.x,
            y: row.y,
            pinned: row.pinned,
            glassX: row.glassX ?? null,
            glassY: row.glassY ?? null,
          };
        }
      }
      this.convs = [...this.#byId.values()];
      /* After the cards, not before: territories are packed against their real
         heights, and a wall of projects that all looked empty would pack tight
         enough to overlap the moment the cards arrived. Anything from before
         territories could be moved has no position at all, and this is where it
         becomes memory rather than something re-derived on every load. */
      this.#settlePlaces();

      this.groups = s.server_groups.map((g) => new GroupRuntime(g));
      this.loaded = true;

      /* What each card was told while the app was shut. Behind the painted
         wall, like the scrollback below and for the same reason: an inbox mark
         is worth having and is worth nothing on the first frame. */
      void invoke<Record<string, number>>("relay_inboxes")
        .then((counts) => this.flights.seed(counts ?? {}))
        .catch(() => {});

      /* And who opened whom. Behind the wall for the same reason, with one
         difference worth stating: a root is *structure* rather than status, so
         arriving a beat late is a wall that draws its own shape a beat late and
         never a wall that says something untrue in the meantime. `born` is left
         unset, so every restored root is drawn already grown — the alternative
         is twenty cards sprouting at launch as though each had just been
         opened. */
      void invoke<[string, string][]>("lineage")
        .then((pairs) => {
          this.kin = (pairs ?? []).map(([child, parent]) => ({ child, parent }));
        })
        .catch(() => {});

      /* Scrollback is filled in behind the painted wall. Not awaited: the wall
         is already on screen and correct without it, and a card whose file is
         still being read simply has nothing under its title yet.

         This does not compromise lazy restore, which is about *processes* —
         reading a transcript spawns nothing and costs a file read. Waiting for
         a click to do it meant every card was blank until you touched it, and
         the one thing you might want before touching a card is to see what it
         was doing. */
      void this.#fillHistory(this.convs);

      /* And the processes come back, behind the same painted wall and awaited
         no more than the transcripts are. Started before the servers rather
         than after: the server loop below sleeps between groups and would hold
         the whole queue behind however many groups this workspace has. */
      void this.#rouse();

      /* Originals a repair kept and nothing came back to collect. The ordinary
         path is `#settleRepair`, a turn or two after the repair; this is for
         the exits that never reach it — Skein killed, the card closed, the wall
         torn down mid-countdown. Not awaited and its answer is not read: it is
         housekeeping in somebody else's directory, and a launch must not turn
         on whether it worked. Same argument as the job objects in
         `supervisor.rs` — "Skein cleans up after itself" is worth only what
         runs when Skein does not get to finish. */
      void invoke("sweep_repair_backups").catch(() => {});

      /* Servers start eagerly, staged by start_order — backend before
         frontend, because the frontend usually wants the backend up.

         Unless asked not to: `SKEIN_NO_SERVERS=1` leaves every group listed and
         clickable but starts none of them, which is what makes it safe to run a
         second Skein against the same store — two instances racing for every
         port in the workspace leave both walls showing `exited`. Asked of Rust
         rather than read from a query string, since only the process knows its
         own environment. */
      this.serversQuiet = await invoke<boolean>("servers_quiet").catch(() => false);
      if (!this.serversQuiet) {
        for (const g of this.groups.filter((g) => g.group.autostart)) {
          await this.startGroup(g);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (err) {
      this.fault = String(err);
    }
  }

  projectFor(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** `worktree` branches the conversation into its own git worktree via the
   *  CLI's own `--worktree`, so we never shell out to git ourselves.
   *
   *  `preset` is the model and effort the card is opened with, from the `+`'s
   *  right-click. Absent is not a default standing in for one — it is the card
   *  taking whatever Claude Code is configured for, which is what every card
   *  did before presets and what a plain click still does. */
  async open(
    cwd: string,
    worktree?: string,
    preset?: Preset,
  ): Promise<Conversation | null> {
    return this.#openIn(cwd, worktree?.trim() || null, "project", null, preset);
  }

  /** A card with no project.
   *
   *  It is spawned with no tools but `WebSearch` and `WebFetch`, so it can look
   *  something up and can read no file, run no command and reach nothing on
   *  this machine — `supervisor.rs::chat_argv` is where that is decided and
   *  what it was probed against. This is for the conversation that is not about
   *  a repository: a question, a bit of reading, something you would otherwise
   *  have opened a browser tab and a chat window for.
   *
   *  Its cwd is a folder of Skein's own (`chat_home`) rather than anywhere on
   *  the wall. Somewhere is needed — the CLI is spawned in a directory and the
   *  transcript path is derived from it — but nothing about the card wants a
   *  project, and pointing it at one would be the wall claiming a relationship
   *  the card does not have. */
  async openChat(): Promise<Conversation | null> {
    try {
      return await this.#openIn(await this.#chatHome(), null, "chat");
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** A card another card asked for. `spawn.rs` has already decided that it may
   *  exist, where it stands and what its id is; this is the opening.
   *
   *  Through `#openIn` like every other card, which is the whole point: a
   *  spawned card is not a special kind of thing, and a second birth path is the
   *  one that drifts. It gets the brief as its first turn through `send`, so the
   *  prompt is echoed into its transcript exactly as a typed one is — the agent
   *  that wrote it should be readable there, not merely inferable from what the
   *  card does next.
   *
   *  A title, if one was given, is set as an ordinary title rather than one
   *  named by hand: it is a label to tell cards apart until the card names
   *  itself from its own first turn, and `read_ai_title` should be free to
   *  replace it. See `naming.md`.
   *
   *  `cwd` is the parent's own directory or the root of a territory the parent
   *  named — `spawn.rs` resolves which against the wall's projects, and a card
   *  opened in another one needs nothing of its own here: `#openIn` calls
   *  `ensure_project`, which finds the existing territory by its `root_path`
   *  rather than making a second one. So this is the same line `new
   *  conversation here` takes in that project, which is the point of having
   *  Rust decide where and the wall decide nothing.
   *
   *  `worktree` is the parent's branch, or null — and it is the difference
   *  between a card opened *beside* its parent and one opened in the main tree
   *  four hours of work behind it. Resolved in `spawn.rs` for the same reason
   *  `cwd` is; this passes it on and decides nothing. */
  async openSpawned(
    id: string,
    cwd: string,
    worktree: string | null,
    prompt: string,
    title: string | null,
  ): Promise<void> {
    const conv = await this.#openIn(cwd, worktree, "project", id);
    if (!conv) return;
    if (title) {
      conv.title = title;
      void invoke("update_conversation", { id, title }).catch(() => {});
    }
    await this.send(conv, prompt);
  }

  /** Ask Rust where chat cards go, remembering the answer. Rust creates the
   *  directory, so this is also what makes it exist. */
  async #chatHome(): Promise<string> {
    if (this.chatHome === null) {
      this.chatHome = await invoke<string>("chat_home");
    }
    return this.chatHome;
  }

  async #openIn(
    cwd: string,
    wt: string | null,
    kind: ConvKind,
    /** The id to use, when somebody else has already minted one and told an
     *  agent about it. `spawn.rs` does: it hands the caller the child's handle in
     *  the same tool call, so the agent can `send` to it without a round of
     *  `list` and a guess about which card is new — which means the id has to be
     *  decided before the card exists, and this is the one door that lets it
     *  be. */
    given: string | null = null,
    /** What the card is set up as, where something chose. See `presets.ts`. */
    preset?: Preset,
  ): Promise<Conversation | null> {
    try {
      const project = await invoke<Project>("ensure_project", { rootPath: cwd });
      if (!this.projects.some((p) => p.id === project.id)) {
        this.projects = [...this.projects, project];
        /* A new territory flows into the first free cell — once, here, and then
           it is somewhere rather than wherever the list implies. */
        this.#settlePlaces();
      }
      const id = given ?? crypto.randomUUID();
      /* The row goes in *before* the spawn, which is the other way round from
         how this read for most of the app's life. `spawn_conversation` asks the
         store what kind of card this is rather than being told (see
         `store::kind_of`), so the row has to exist by the time it looks — and a
         chat card whose row lands late is a chat card spawned with every tool
         the machine has. It costs nothing: the insert is local and the spawn is
         a process. */
      await invoke("record_conversation", {
        id,
        projectId: project.id,
        cwd,
        worktree: wt,
        kind,
        /* Onto the row rather than into the spawn call, and that is the whole
           of how a preset holds: `spawn_conversation` reads the model and the
           effort back out of the store (`store::setup_of`), so the wake that
           happens tomorrow morning is set up the same way as the open that
           happened today. Passing them to the spawn would have worked exactly
           once. */
        model: preset?.model ?? null,
        effort: preset?.effort ?? null,
      });
      /* A brand-new card takes the lowest-ranked account with room, which is
         `choose` with nothing to stick to. Resolved here rather than left to
         the first send so the card spawns on the right subscription once,
         instead of spawning and immediately being moved. Null when the wall
         manages no accounts — every card before this feature. */
      const opening = waterfall.list.length > 0 ? waterfall.next() : null;
      const account = opening?.kind === "use" ? opening.label : null;
      /* No `worktree` here: `spawn_conversation` reads it back off the row for
         the reason it reads `kind` and the preset off the row. It was the one
         thing still travelling as an argument, `wake` was the call site that
         never passed it, and a card that came back in the main tree is what
         that cost. See `store::worktree_of`. */
      await invoke("spawn_conversation", { id, cwd, accountLabel: account });
      const conv = new Conversation(id, cwd, project.id, wt, kind);
      if (preset) {
        /* Drawn from the first frame rather than from the first turn. The alias
           is what was asked for — `system/init` answers with the resolved id
           (`opus[1m]` → `claude-opus-5[1m]`, probed 2026-08-20) and
           `#adoptModel` replaces it, tier and all. `contextWindowFor` already
           reads the `[1m]` in an alias, so the ring is the right size in the
           meantime. */
        conv.model = preset.model;
        conv.contextWindow = contextWindowFor(preset.model);
        conv.effort = preset.effort;
      }
      /* What it was actually spawned with, so the next send sticks to it rather
         than treating the card as unattached and moving it. */
      conv.accountLabel = account;
      if (account) void invoke("set_conversation_account", { id, accountLabel: account });
      /* We just spawned it, so it has a process — even though `system/init`
         has not arrived yet. It cannot: claude emits init only after it
         receives its first message. Leaving this dormant meant `send` tried to
         wake an already-running process and the first message never landed. */
      conv.dormant = false;
      conv.activity = "ready";
      this.#byId.set(id, conv);
      this.convs = [...this.convs, conv];
      /* A brand-new session has no transcript, so this settles on "none"
         immediately. It runs anyway so that "every card on the wall has been
         read for" holds without exception — including the `--worktree` case,
         where the CLI may have branched from a session that does have one. */
      void this.loadHistory(conv);
      return conv;
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Conversations Claude Code has recorded that no card points at yet.
   *
   *  Filtered here rather than in Rust because the wall is the thing that knows
   *  what is on it. A session whose card was *closed* stays in this list on
   *  purpose — closing takes a card off the wall without deleting the row, and
   *  adopting it again is how you bring it back. */
  async importable(): Promise<Session[]> {
    /* By session, not by card: what `list_sessions` returns are sessions, and
       after a card has been cleared its own fresh session is not its id. Keyed
       on `id` the wall would offer to adopt a session that is already standing
       on it — and, correctly, would go on offering the one that was cleared,
       which is exactly how a clear is undone. */
    const known = new Set(this.convs.map((c) => c.sessionId));
    try {
      const all = await invoke<Session[]>("list_sessions");
      return all.filter((s) => !known.has(s.id));
    } catch (err) {
      this.fault = String(err);
      return [];
    }
  }

  /** Put a session started outside Skein on the wall.
   *
   *  Nothing is copied and nothing moves: the row points at the transcript
   *  where the CLI wrote it, and waking the card resumes that same session in
   *  place. The card arrives dormant, which is the honest state — it has a
   *  history and no process — and lazy restore already knows how to draw that. */
  async importSession(s: Session): Promise<Conversation | null> {
    try {
      const project = await invoke<Project>("ensure_project", {
        rootPath: s.cwd,
      });
      if (!this.projects.some((p) => p.id === project.id)) {
        this.projects = [...this.projects, project];
        this.#settlePlaces();
      }

      const window = windowForObserved(s.model ?? undefined, s.ctx_tokens);
      const frac = Math.min(1, s.ctx_tokens / window);
      await invoke("import_conversation", {
        id: s.id,
        projectId: project.id,
        cwd: s.cwd,
        title: s.title,
        model: s.model,
        lastCtxFrac: frac,
        /* Its own age, not the moment it was adopted. */
        bornAt: s.born_at ? Date.parse(s.born_at) : null,
      });

      const conv = Conversation.restore({
        id: s.id,
        cwd: s.cwd,
        project_id: project.id,
        title: s.title ?? UNNAMED,
        model: s.model,
        interrupted: false,
        last_ctx_frac: frac,
        /* Non-null so the card counts as having spoken, and therefore wakes
           with `--resume`. See `import_conversation` — we know a transcript
           exists, not how its last turn ended. */
        last_ending: "ok",
      });
      /* `restore` can only infer tokens back out of the fraction, against the
         window a bare model id implies. Here the true count is in hand, so it
         is set directly rather than round-tripped through 200k. */
      conv.contextWindow = window;
      conv.ctxTokens = s.ctx_tokens;

      this.#byId.set(conv.id, conv);
      this.convs = [...this.convs, conv];
      /* An adopted card is the case that most needs this: it is nothing *but*
         history until you speak to it. */
      void this.loadHistory(conv);
      return conv;
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Take a project off the wall for good.
   *
   *  A territory outlives its last card on purpose, so this is the only way one
   *  ever leaves — otherwise every folder ever opened stays forever. Its dev
   *  servers are stopped first: the rows go with the project, and a running
   *  group whose row has been deleted is a process nothing owns. */
  async forgetProject(cwd: string): Promise<boolean> {
    try {
      const project = this.projects.find((p) => p.root_path === cwd);
      if (project) {
        for (const g of this.groupsFor(project.id).filter((g) => g.running)) {
          await this.stopGroup(g);
        }
        this.groups = this.groups.filter((g) => g.group.project_id !== project.id);
      }
      const gone = await invoke<boolean>("forget_project", { rootPath: cwd });
      if (gone) this.projects = this.projects.filter((p) => p.root_path !== cwd);
      return gone;
    } catch (err) {
      /* Refusing because something is still open there is the common case, and
         it is worth saying out loud rather than doing nothing. */
      this.fault = String(err);
      return false;
    }
  }

  /** Give a dormant card a process again, resuming its history in place.
   *
   *  True means it has a process, whoever gave it one. Use `#spawn` where the
   *  difference matters. */
  async wake(conv: Conversation): Promise<boolean> {
    return (await this.#spawn(conv)) !== "failed";
  }

  /** The spawn itself, and **at most one at a time per card**.
   *
   *  `wake` used to be the whole of this and its guard was `conv.dormant`,
   *  read before an `await` and cleared after it — which is no guard at all
   *  once two callers arrive inside the same window, and three of them can:
   *  the rousing queue (which walks the wall spawning cards that take seconds
   *  apiece), a click on `wake`, and a prompt sent to a dormant card. Rust's
   *  own guard was the same shape and has been made atomic (`Supervisor::claim`),
   *  so a second spawn is now *refused* rather than granted — but a refusal is
   *  still an error the second caller has to interpret, and the second caller
   *  is usually `rouse`, which would then decide the card had failed to wake.
   *
   *  So the two callers share one attempt instead of racing over one: whoever
   *  arrives second awaits the promise the first is already holding and gets
   *  the same answer. Single-flight, keyed by id, cleared in a `finally` — a
   *  key left behind is a card that can never be woken again, which is the one
   *  failure worse than the one this fixes.
   *
   *  `"spawned"` this call started the process; `"already"` it had one, or
   *  something outside this instance is looking after it; `"failed"` it has
   *  none and the card has been told so. */
  async #spawn(conv: Conversation): Promise<"spawned" | "already" | "failed"> {
    if (!conv.dormant) return "already";
    const inflight = this.#waking.get(conv.id);
    if (inflight) return inflight;
    const attempt = this.#spawnNow(conv).finally(() => this.#waking.delete(conv.id));
    this.#waking.set(conv.id, attempt);
    return attempt;
  }

  async #spawnNow(conv: Conversation): Promise<"spawned" | "already" | "failed"> {
    conv.activity = "waking…";
    try {
      await invoke("spawn_conversation", {
        id: conv.id,
        /* Not the card id: a cleared card keeps its own id and points at a
           fresh session. They are the same for every card that has never been
           cleared, which is most of them. */
        sessionId: conv.sessionId,
        cwd: conv.cwd,
        /* Whether this resumes is not ours to say — `spawn_conversation` looks
           for the transcript. We used to pass `everSpoke`, which answers "did a
           turn ever finish" and so sent a card killed mid-first-turn back with
           `--session-id` against an id that already had a transcript.
           Nor is which tree it works in. This used to pass `worktree: null`,
           which was true of nothing and was read as "the project root": every
           worktree card woken by a click, a send, a rouse or an account swap
           came back in the main tree with its history filed under the wrong
           slug. The row has known all along; the spawn asks it now. */
        /* Which subscription this card spends. Null is "whoever Claude Code is
           signed in as", which is every card on a wall with no accounts
           registered. Passed explicitly rather than omitted: a missing Tauri
           arg silently becomes `None`, so an omission reads identically to a
           bug (CLAUDE.md, on arg names). */
        accountLabel: conv.accountLabel,
      });
      conv.dormant = false;
      return "spawned";
    } catch (err) {
      /* Belt and braces: if the supervisor says it is already running, then it
         is awake, whatever this card believed about itself. Said apart from a
         spawn we performed, because the caller that cares is `rouse` — a card
         somebody else already has a process for is not one this launch found
         cut off and revived, and prompting it costs money and starts an agent
         in a repository another instance is already working in. */
      if (String(err).includes("already open")) {
        conv.dormant = false;
        /* Or the card stands there saying `waking…` about a wake that is over.
           `rouse` says "ready" for the cards it woke and no longer reaches this
           one, which is precisely why the line has to be cleared here. */
        conv.activity = "ready";
        return "already";
      }
      this.fault = String(err);
      conv.activity = "could not wake";
      return "failed";
    }
  }

  /** Ask Rust whether this instance was told to leave the wall alone, then
   *  rouse it. Called once, from `load`, and never awaited. */
  async #rouse() {
    /* Asked of Rust rather than read from a query string, since only the
       process knows its own environment — the same shape as `servers_quiet`. */
    this.wakeQuiet = await invoke<boolean>("wake_quiet").catch(() => false);
    if (this.wakeQuiet) return;
    await this.rouse();
  }

  /** Give every dormant card its process back, and ask the ones that were
   *  mid-turn when the app closed to pick that turn up.
   *
   *  Lazy restore was always about the *paint* — a wall of thirty cards drawn
   *  from SQLite with nothing spawned, so the first frame costs a query. What it
   *  bought at the other end was a wall that could not do anything until you had
   *  clicked each card in turn, and, worse, a card left half-way through editing
   *  a repo when the app closed sitting there saying `interrupted` until somebody
   *  noticed. So the processes come back on their own, behind the painted wall.
   *
   *  Four things keep that from being reckless:
   *
   *  - **Nothing here is awaited by `load`.** The wall is on screen and correct
   *    before the first spawn, and stays interactive throughout — this is a
   *    queue running underneath it, not a slower launch.
   *  - **Interrupted cards go first** (`rouseOrder`), because they are the ones
   *    with work standing still.
   *  - **You outrank the queue.** A card is re-checked at the moment its turn
   *    comes up: one you have already woken is skipped, and one that is already
   *    working is not sent anything, so speaking to a card during the launch
   *    cannot land a resume prompt on top of what you just said.
   *  - **Only an interrupted card is prompted.** Waking is free — a `claude -p`
   *    with nothing on its stdin costs a process and no tokens — but a prompt
   *    spends money and starts an agent editing a repo, so it is reserved for
   *    the cards that demonstrably lost a turn. `SKEIN_NO_WAKE=1` turns the
   *    whole pass off.
   *
   *  Public because the control surface drives this seam rather than a copy of
   *  it, and re-entrant only in the sense that it refuses to be: a second call
   *  while the queue is running returns immediately. */
  async rouse(): Promise<number> {
    if (this.rousing) return 0;
    this.rousing = true;
    let woken = 0;
    try {
      for (const conv of rouseOrder(this.convs)) {
        /* Editing a front-end file rebuilds App.svelte and constructs a second
           Skein while this loop is still walking the wall — and unlike a
           listener, a loop cannot be unsubscribed. Left running it would spawn
           against ids the live Skein is also spawning against, and send a second
           copy of every resume prompt. Checked each time round rather than once,
           since the queue outlives many ticks. */
        if (this.#gone) break;
        /* Asked again here, not when the order was taken: everything between
           this card and the head of the queue took a second or so, and any of
           it is long enough for you to have got there first. */
        if (!conv.dormant) continue;
        /* And long enough for you to have closed it. `rouseOrder` took a
           snapshot, and `close` removes from `convs` rather than from that — so
           without this a card shut during the launch pass is still walked up to
           and *woken*, spawning an agent against a row that has just been marked
           closed and a card nothing on the wall can see. Membership is asked of
           `#byId` rather than by rebuilding the order, because the order is a
           priority and not a list of who is still here. */
        if (!this.#byId.has(conv.id)) continue;
        const lost = conv.interrupted;
        /* `#spawn`, not `wake`, because the answer this queue needs is *did we
           start it* rather than *does it have a process*. They differ in one
           case and that case is the expensive one: a second Skein against the
           same store (the pairing `SKEIN_NO_WAKE` exists for — see the module
           note in `rousing.ts`) has already given this card a process and
           already sent it whatever it needed, so a resume prompt from here is a
           second agent told to pick up a turn somebody else is picking up, in
           the same working tree, with `--dangerously-skip-permissions`. That is
           the shape of the wall coming back as several instances of itself, each
           independently committing the same piece of work. */
        const started = await this.#spawn(conv);
        if (started === "failed") continue;
        if (started === "already") continue;
        woken += 1;
        /* What this card had in flight and never heard the end of. Asked after
           the wake rather than before, so a card whose spawn failed is not told
           about work it has no process to go and look at. */
        const jobs = await invoke<LostJob[]>("pending_jobs", {
          conversationId: conv.id,
        }).catch(() => [] as LostJob[]);
        if (lost && !conv.working) {
          /* Sent as an ordinary prompt, and the panel folds it away behind
             `RESUME_CAP` — which is what says the line is Skein's and not one
             you typed. It used to be a `meta` note written above the prompt
             here, with the whole prompt drawn below; see `rousing.ts`. */
          await this.send(conv, resumePrompt(jobs, Date.now()));
          await this.#toldAboutJobs(conv, jobs);
        } else if (jobs.length && !conv.working) {
          /* A second reason to prompt a card, and the only one added since the
             rule was "interrupted cards only". It meets that rule's bar: a row
             in `job` is work that demonstrably started and demonstrably was
             never reported on, which is as narrow a signal as `interrupted`
             and is deleted the moment the card *is* told. What it is not is a
             card that merely finished a turn — those still get nothing. */
          await this.send(conv, jobsPrompt(jobs, Date.now()));
          await this.#toldAboutJobs(conv, jobs);
        } else {
          /* `wake` left it saying "waking…", which was true for as long as the
             call took and is now a card standing ready with nothing to do. */
          conv.activity = "ready";
        }
        await new Promise((r) => setTimeout(r, ROUSE_GAP_MS));
      }
    } finally {
      this.rousing = false;
    }
    return woken;
  }

  /** Try a turn again that broke before it reached a model.
   *
   *  The decision is the card's (`Conversation.pendingHeal`, and
   *  `wasMalformedRequest` for why it is safe); this is only the doing of it.
   *  It lives here because sending is a Rust call and a `Conversation` never
   *  makes one.
   *
   *  Deferred rather than immediate, and the wait is for the person watching
   *  rather than for the API: a card that failed and re-sent inside the same
   *  tick reads as a card that did nothing, and the note saying so would be
   *  gone before it could be read.
   *
   *  Three things can happen between scheduling and firing, and all three mean
   *  drop it. The wall can be torn down — `detach` clears the map. The card can
   *  be cleared, which is a new session that has never heard the prompt. And
   *  you can say something yourself, which is the important one: a heal is
   *  Skein finishing what you asked for, so the moment you take the card back
   *  it has nothing left to finish. `working` covers the last of those, since
   *  `echo` opens the turn from the gesture. */
  #heal(conv: Conversation) {
    const heal = conv.pendingHeal;
    if (!heal) return;
    conv.pendingHeal = null;
    /* One in flight per card. The map is keyed by id, so a second would
       overwrite the handle and leak the first — and there is no path that wants
       two anyway, since a heal only ever comes from a settled turn. */
    if (this.#heals.has(conv.id)) return;
    /* The server has refused this account, which is newer than anything the
       poll knows and is the actual refusal rather than a percentage implying
       one. Marked *before* the delay so that when `send` runs, `choose` has
       already stopped offering the account that just said no — without this the
       card would re-send to the same subscription and fail identically until
       the budget ran out. */
    if (heal.kind === "limited" && conv.accountLabel) {
      waterfall.markSpent(conv.accountLabel);
    }
    conv.activity =
      heal.kind === "overloaded"
        ? "overloaded — waiting…"
        : heal.kind === "limited"
          ? "out of allowance — moving account…"
          : "trying again…";
    /* Rolled once, here, rather than inside the delay: the note the card writes
       has to name the same wait the timer is actually set to, or a card that
       said "in 15s" and went at 19 is an instrument that lies about itself. */
    const wait = healDelayMs(heal.kind, heal.attempt, Math.random());
    const t = setTimeout(async () => {
      this.#heals.delete(conv.id);
      if (this.#gone) return;
      if (conv.working) return;
      conv.note(healNote(heal.kind, heal.attempt, wait));
      /* Look before re-sending, and only on the first attempt.
         `wasMalformedRequest` cannot tell the two causes apart — a body cut
         short in transit clears on a retry, and one the *conversation* cannot
         express never will — so before this the second cause spent the whole
         budget re-sending an identical failure and then blamed the size. The
         look is one file read and it answers which failure this is. */
      if (heal.attempt === 1 && repairWorthTrying(heal.kind)) {
        await this.#repair(conv);
        if (this.#gone || conv.working) return;
      }
      void this.send(conv, heal.text);
    }, wait);
    this.#heals.set(conv.id, t);
  }

  /** Take the unsendable characters out of a card's session, if there are any.
   *
   *  Says what it found either way. A clean conversation is a real finding and
   *  the card is allowed to state it — the complaint against the line this
   *  replaced was that it named a cause nobody had checked, and having checked
   *  is a different claim. A repair that *fails* is noted and swallowed: the
   *  re-send is still worth making, and a card that refused to try because it
   *  could not rewrite a file would have turned a recoverable turn into a dead
   *  one over a permission error. */
  async #repair(conv: Conversation) {
    try {
      const report = await invoke<RepairReport | null>("repair_session", {
        cwd: conv.cwd,
        sessionId: conv.sessionId,
      });
      if (report) {
        conv.markRepaired(sayRepair(report));
        await this.#recycle(conv);
      } else conv.note(sayNothingToRepair());
    } catch (e) {
      conv.note(`could not check this conversation for corruption — ${e}`);
    }
  }

  /** Restart a card's process so it reads the repaired session off disk.
   *
   *  **A repair to the file is invisible to a live process**, and this is the
   *  half of the feature that was missing when it shipped. `claude -p` is
   *  long-lived here and holds the conversation in memory: it built every
   *  request from that, so rewriting the transcript underneath it changed
   *  precisely nothing, and the re-send that followed failed identically to the
   *  send that triggered the repair. Observed 2026-08-19 — a session repaired
   *  at 13:39 and spoken to at 13:46 answered `400 … char 400492` from a
   *  process that had been up since 11:28, while the file on disk was clean.
   *
   *  So the child is killed and the card left dormant, and the send that
   *  follows wakes it — `spawn_conversation` finds the transcript and resumes
   *  from it, which is the read that finally picks the repair up. The general
   *  shape is worth carrying: **mending state on disk does nothing for a
   *  process that already loaded it.**
   *
   *  `retiring` before the kill, or our own exit code lands on the card as a
   *  crash — the same ordering `clear` needs, and for the same reason. */
  async #recycle(conv: Conversation) {
    // Nothing is holding the old history, so there is nothing to restart.
    if (conv.dormant) return;
    try {
      conv.retiring = true;
      await invoke("close_conversation", { id: conv.id });
      await this.#awaitDormant(conv);
    } catch (e) {
      conv.retiring = false;
      conv.note(`could not restart this card after the repair — ${e}`);
    }
  }

  /** Wait until a card's process has actually gone.
   *
   *  `close_conversation` returns when the kill has been *asked for*; the card
   *  learns it happened from `conv:exit`, an event later. Waking in between
   *  spawns a second process against a card that exit is about to mark dormant
   *  — leaving the wall with a live child it believes is asleep, and the next
   *  send spawning a third. Polling rather than a promise because the exit
   *  arrives through the same listener every other event does, and routing one
   *  event two ways is how a card ends up with two owners.
   *
   *  A timeout returns false rather than throwing: the send that follows is
   *  still worth making, and a card that would not die is not a reason to
   *  swallow the prompt. */
  async #awaitDormant(conv: Conversation, ms = 4_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (!conv.dormant && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      if (this.#gone) return false;
    }
    return conv.dormant;
  }

  /** Throw away a kept original once the card has taken a turn or two.
   *
   *  Read off the card the same way `pendingHeal` is, and for the same reason:
   *  the decision belongs to the thing folding the events and the file belongs
   *  to Rust. */
  #settleRepair(conv: Conversation) {
    if (!conv.pendingBackupDiscard) return;
    conv.pendingBackupDiscard = false;
    void invoke("discard_repair_backup", {
      cwd: conv.cwd,
      sessionId: conv.sessionId,
    }).catch(() => {
      /* A backup that will not delete is a stray file, not a broken card.
         `sweep_repair_backups` collects it on some later launch. */
    });
  }

  /** Drop a heal waiting on this card, for the paths that invalidate one. */
  #dropHeal(conv: Conversation) {
    const t = this.#heals.get(conv.id);
    if (t !== undefined) clearTimeout(t);
    this.#heals.delete(conv.id);
    conv.pendingHeal = null;
  }

  /** Supply the turn a card was owed and did not take.
   *
   *  Two silences, one mechanism. A **job** was reported in and the agent did
   *  not stir; a **prompt** of yours was written to the child's stdin and the
   *  wire never echoed it back. Both are the CLI's input queue holding
   *  something nothing takes off it, and both are ended by the same gesture:
   *  send anything at all, and the queue flushes.
   *
   *  The prompt half is the more dangerous of the two, because of what the
   *  transcript does while it waits — `#settleEchoes` takes the pending mark off
   *  a queued line as soon as the process speaks, so the card comes to rest with
   *  your words drawn exactly like words that were answered. See
   *  `Conversation.unacknowledged`.
   *
   *  The CLI enqueues a `<task-notification>` rather than delivering it, and
   *  nothing takes it off that queue — 0 dequeues in 506, measured; see
   *  `classify.ts`. About half the time something else flushes the queue and the
   *  agent wakes anyway. The rest of the time the card has been told its work
   *  finished and does not stir, and in a terminal that is invisible because a
   *  person is sat there typing the nudge without noticing they did.
   *
   *  So this is that person. Sending *anything* flushes the queue, which is why
   *  `NUDGE_TEXT` is nearly empty: the notification the agent then reads is the
   *  CLI's own, complete, and better than anything Skein could paraphrase from
   *  a summary line.
   *
   *  It is the same shape as `#heal` and for the same reasons — deferred so the
   *  card visibly says what it is about to do, one in flight per card, and
   *  dropped by every path that invalidates it. The `working` check at the top
   *  of the timer is the important one: it covers the agent waking on its own
   *  during the grace, which is the majority case and must cost nothing. */
  #nudge(conv: Conversation) {
    const nudge = conv.pendingNudge;
    if (!nudge) return;
    conv.pendingNudge = null;
    if (this.#nudges.has(conv.id)) return;
    const t = setTimeout(async () => {
      this.#nudges.delete(conv.id);
      if (this.#gone) return;
      /* Woke on its own, or you got there first. Either way there is nothing
         left to flush and a prompt here would be Skein talking to itself.
         Asked of whichever silence this nudge is for: the prompt case is
         cleared by `#claimEcho`, which is the wire acknowledging one, and the
         job case by a turn opening. The usual outcome on the prompt side is
         precisely this return — the CLI drains its queue in about three seconds
         and the grace is twelve. */
      if (conv.working || conv.dormant) return;
      const prompt = nudge.kind === "prompt";
      if (prompt ? conv.awaiting === 0 : conv.unwoken === null) return;
      if (prompt) conv.promptNudgeAttempts = nudge.attempt;
      else conv.nudgeAttempts = nudge.attempt;
      conv.note(nudgeNote(nudge.attempt, nudge.kind));
      await this.send(conv, prompt ? NUDGE_PROMPT_TEXT : NUDGE_TEXT);
      /* The budget is spent and the card is still holding your words. Said out
         loud, once, for the reason `#settleJob` says its own version once: a
         card that has stopped trying must not look like one that never had to.
         The job side says this from the fold, which has a notification to count;
         this side has no second event to hang it on, so it is said here. */
      if (prompt && nudge.attempt >= NUDGE_BUDGET) conv.note(nudgeGaveUpNote("prompt"));
    }, WAKE_GRACE_S * 1000);
    this.#nudges.set(conv.id, t);
  }

  /** Drop a nudge waiting on this card. Same paths as `#dropHeal`, and one
   *  more: you speaking to the card yourself is the flush it was waiting for. */
  #dropNudge(conv: Conversation) {
    const t = this.#nudges.get(conv.id);
    if (t !== undefined) clearTimeout(t);
    this.#nudges.delete(conv.id);
    conv.pendingNudge = null;
  }

/* ── which subscription a card spends ──────────────────────────────────
   *
   * `.claude/rules/accounts.md` is the reasoning and `accounts.ts` is every
   * decision. What lives here is only the doing of it, because sending and
   * spawning are Rust calls and a `Conversation` never makes one — the same
   * division `#heal` already draws.
   */

  /** Held cards waiting on an account, and the timer that will try each again.
   *  One per card: a second hold on the same card would overwrite the handle
   *  and leak the first, which is the trap `#heals` is keyed to avoid. */
  #holds = new Map<string, ReturnType<typeof setTimeout>>();

  /** Whether the wall is managing accounts at all.
   *
   *  An empty registry is not a failure and must not behave like one: it is
   *  every wall that existed before this feature, and every card on one spawns
   *  as whoever Claude Code is signed in as. So the mechanism is skipped rather
   *  than reporting that nothing is available — which is what `choose` would
   *  otherwise say, correctly and uselessly. */
  get #managing(): boolean {
    return waterfall.list.length > 0;
  }

  /** Put this card on an account that will take work, moving it if it is not on
   *  one. False means nothing would, and the prompt has already been held.
   *
   *  This is the proactive half, and it runs before every send. It cannot be
   *  sufficient alone: the reading behind it is up to a minute old by
   *  `limits.rs`'s own floor, another machine may be spending the same account,
   *  and a five-hour window can cross a cap inside that minute. `#heal`'s
   *  `limited` arm is the reactive half that catches those. */
  async #settleAccount(conv: Conversation, text: string | null): Promise<boolean> {
    if (!this.#managing) return true;

    const choice: Choice = waterfall.next({
      bypass: conv.bypassCaps,
      stickTo: conv.accountLabel,
    });

    if (choice.kind === "use") {
      if (choice.label !== conv.accountLabel) {
        await this.#moveTo(conv, choice.label, choice.swapFrom);
      }
      return true;
    }

    if (choice.kind === "hold") {
      if (text !== null) this.#hold(conv, text, choice);
      else conv.activity = HOLD_LINE;
      /* The turn `echo` opened is given back. A prompt that never left is not a
         turn beginning, and a card left `working` through a hold read celadon
         for as long as the window took to turn over — up to five hours of the
         wall claiming it was burning tokens while it sat doing nothing. It also
         locked out `#heal` and `#nudge`, both of which refuse a working card.
         The line itself stays pending and awaited: `releaseHeld` sends this very
         text, and the replay needs a line to claim. */
      conv.echoHeld(conv.held?.why ?? HOLD_LINE);
      return false;
    }

    /* Nothing usable and no clock to watch: every account switched off, or none
       signed in. A fault rather than a hold, because a hold that can never end
       is a card that has quietly stopped working.
       And a fault has to be *marked* as one. This used to set the face and
       nothing else: the prompt was abandoned with no hold to release it and no
       timer to try again, while the turn `echo` opened stayed open — so the card
       sat celadon and working over a prompt that no longer existed anywhere but
       in a line drawn as though it had been sent. `echoFailed` is what says a
       send never left, and it is what this always meant. */
    if (text !== null) conv.echoFailed(text, "no account available");
    else conv.activity = "no account available";
    this.fault = choice.why;
    return false;
  }

  /** Move a card onto another account.
   *
   *  A running process's environment cannot be changed, so this is the only
   *  mechanism there is: end the child and spawn a new one against the same
   *  session id, which comes back `--resume` because the transcript is on disk
   *  in a config directory every account shares. The card keeps its context,
   *  its scrollback and everything it had read.
   *
   *  `retiring` before the kill, exactly as `clear` does it, or the exit code
   *  from our own `close_conversation` lands on the card as a crash.
   *
   *  Left **dormant** rather than respawned here: `#deliver` wakes it on the
   *  very next line and waking is the one path that knows how to report a spawn
   *  that failed. Spawning here as well would be two spawns racing for one
   *  session id.
   *
   *  And it waits for the old child to actually be gone before saying so, which
   *  is the same guard `#recycle` has and for the same reason — `#deliver` wakes
   *  on the very next line, so this is the tightest close-then-spawn window in
   *  the app. Rust no longer *loses* the new process if the old reader thread is
   *  late (`Conv::generation`), but the wall would still be spawning against a
   *  session the previous child had not finished letting go of.
   *
   *  The note goes in the transcript rather than only on the face, and names
   *  the re-read. Skein spawns with `--dangerously-skip-permissions`; the one
   *  thing an app like that owes you is that nothing it did on its own is
   *  invisible afterwards, and a card that moved itself onto the subscription
   *  you were holding in reserve is precisely that. */
  async #moveTo(conv: Conversation, to: string, from: string | null) {
    try {
      if (!conv.dormant) {
        conv.retiring = true;
        await invoke("close_conversation", { id: conv.id });
        /* `markExited` sets `dormant` when the exit lands; this is the backstop
           for the timeout, where it did not. A card that would not die is not a
           reason to swallow the prompt — `#awaitDormant` says so — so the wake
           below still happens either way. */
        await this.#awaitDormant(conv);
        conv.dormant = true;
      }
      conv.accountLabel = to;
      void invoke("set_conversation_account", { id: conv.id, accountLabel: to });
      if (from) conv.note(swapNote(from, to, this.#whyLeft(conv, from)));
    } catch (err) {
      conv.retiring = false;
      this.fault = String(err);
    }
  }

  /** Why a card is leaving the account it was on, in the words the accounts
   *  panel uses for the same condition — so the line in the transcript and the
   *  row in the panel say the same thing about the same fact. */
  #whyLeft(conv: Conversation, from: string): string {
    const acct = waterfall.list.find((a) => a.label === from);
    const allowance = waterfall.allowances[from];
    if (!acct) return "that account is no longer in the order";
    if (!allowance?.ok) return allowance?.fault ?? "that account could not be asked about";
    const blockers = blockersFor(acct, allowance.windows, conv.bypassCaps);
    return blockers.length > 0 ? sayBlocked(blockers) : "that account stopped taking work";
  }

  /** Keep a prompt until an account can take it.
   *
   *  Nothing is lost and nothing is silently dropped: the card says what it is
   *  waiting for and until when, and goes the moment one frees up. There are
   *  two ways out and it needs neither of them to be reliable — a timer aimed
   *  at the first door to open, and the allowance poll, which sweeps every held
   *  card whenever it learns anything. A blocker that named no reset makes
   *  `until` null and leaves the poll as the only way out, which is right:
   *  there is nothing to aim a timer at. */
  #hold(conv: Conversation, text: string, choice: Extract<Choice, { kind: "hold" }>) {
    const blocked = choice.standings.find((st) => st.state === "blocked");
    conv.held = {
      text,
      why: blocked?.state === "blocked" ? sayBlocked(blocked.blockers) : HOLD_LINE,
      until: choice.until,
    };
    conv.activity = conv.held.why;

    const existing = this.#holds.get(conv.id);
    if (existing !== undefined) clearTimeout(existing);
    if (choice.until === null) return;

    /* A little past the reset rather than exactly on it. The server's clock and
       this one are not the same clock, and a release that fires a second early
       spends a whole uncached conversation to be told no. */
    const wait = Math.max(1_000, choice.until - Date.now() + 2_000);
    this.#holds.set(
      conv.id,
      setTimeout(() => {
        this.#holds.delete(conv.id);
        void this.releaseHeld();
      }, wait),
    );
  }

  /** Try every held card again — the timer above, and the allowance poll, both
   *  come here, so a hold ends on whichever arrives first. */
  async releaseHeld() {
    if (this.#gone) return;
    /* A fresh reading before deciding. The whole reason a card is held is that
       an allowance was full, and releasing against a three-minute-old figure is
       how a card gets woken in order to be refused. Rust's floor makes this
       cheap when it has just been asked. */
    await waterfall.poll();
    for (const conv of this.convs) {
      const held = conv.held;
      if (!held) continue;
      if (this.#gone) return;
      const choice = waterfall.next({ bypass: conv.bypassCaps, stickTo: conv.accountLabel });
      if (choice.kind !== "use") {
        /* Still nothing. Re-armed against the new time rather than left with a
           dead timer: the poll would reach it anyway, but a held card whose
           countdown has stopped reads as one that has been forgotten. */
        if (choice.kind === "hold") this.#hold(conv, held.text, choice);
        continue;
      }
      conv.held = null;
      this.#holds.delete(conv.id);
      conv.note("an account freed up — sending what was held");
      /* The turn `echoHeld` gave back is taken again here rather than at the
         `echo` that never happens on this path — the line was drawn when you
         typed it, minutes or hours ago, and only the sending is new. */
      conv.echoResumed();
      await this.#deliver(conv, held.text);
    }
  }

  /** Drop a hold and the prompt with it. */
  #dropHold(conv: Conversation) {
    const t = this.#holds.get(conv.id);
    if (t !== undefined) clearTimeout(t);
    this.#holds.delete(conv.id);
    conv.held = null;
  }

  /** Turn your caps off for one card, or back on.
   *
   *  Said in the transcript for as long as it is true, the rule `swapNote`
   *  follows: a card quietly spending a reserve you set aside is the thing that
   *  must not be quiet. It cannot cross the accounts' own limits — nothing
   *  can — so a bypassed card with every subscription genuinely spent is held
   *  exactly like any other. */
  setBypass(conv: Conversation, on: boolean) {
    conv.bypassCaps = on;
    void invoke("set_conversation_bypass", { id: conv.id, bypass: on }).catch((err) => {
      this.fault = String(err);
    });
    conv.note(bypassNote(on));
    /* A bypass is very often made *at* a card that is already holding, so it
       takes effect now rather than at the next thing you type. */
    if (on && conv.held) void this.releaseHeld();
  }

  /** Speak to one card.
   *
   *  Drawn before it is delivered, deliberately: waking a dormant card spawns a
   *  process and resumes a session, and a transcript that shows nothing until
   *  that finishes has swallowed what you typed. `Conversation.echo` marks the
   *  line pending until the wire echoes it back, so the transcript still says
   *  which words the agent has and which are merely on their way. */
  async send(conv: Conversation, text: string) {
    conv.echo(text);
    await this.#deliver(conv, text);
  }

  async #deliver(conv: Conversation, text: string) {
    /* Ahead of the wake, and it has to be. `#moveTo` ends the card's process to
       change the account, so settling first means the wake below spawns once,
       already on the right subscription — where settling after would spawn on
       the old account and immediately kill what it had just started.

       A false answer means the prompt is held (or the wall has no usable
       account) and `#settleAccount` has already said so on the card, so there
       is nothing to fail here: the text is kept, not lost. The echoed line is
       left standing to be sent when an account frees up. */
    if (!(await this.#settleAccount(conv, text))) return;
    if (conv.dormant && !(await this.wake(conv))) {
      conv.echoFailed(text, "could not wake");
      return;
    }
    /* The card face has been wearing this name since you started typing it, cut
       by this same function — so `titleFromPrompt` is shared rather than inlined
       here, or the card would visibly rename itself the moment you sent it.
       A card is named after the first thing you *say*, and one of the CLI's own
       commands is not said to the agent at all: `/model sonnet` describes how
       this card is set up, and a card called `model sonnet` would be wearing
       its settings where its subject belongs. The face withholds the same draft
       while you type it, for the same reason. */
    if (!isNamed(conv.title) && !cliCommand(text)) {
      conv.title = titleFromPrompt(text);
      void invoke("update_conversation", { id: conv.id, title: conv.title });
    }
    try {
      await invoke("send_prompt", { id: conv.id, text });
      /* The lost turn has been answered for — by you, or by the rousing queue's
         resume prompt, and it does not matter which. The card stops saying so
         at once; what it must *not* do is write that through, which is a change
         from how this read for most of the app's life.

         The stored flag now means "a turn is open on this card", written by
         `send_prompt` itself and cleared when the `result` lands
         (`store::set_mid_turn`) — so the row was set true a moment ago by the
         very call above, and clearing it here would be this card reporting the
         turn it has just begun as already finished. Quit while it ran and
         nothing would come back to resume: the underfiring half of the same bug
         the flag was rewritten to fix. */
      conv.interrupted = false;
      /* Speaking to a card is picking it back up, so there is no second gesture
         to remember. "Later" is what setting it aside meant, and a prompt is
         later arriving — the alternative is an agent working away on a card
         that has opted out of telling you it has finished. Only on a delivered
         prompt: a send that never left has changed nothing about the card. */
      if (conv.aside) this.setAside(conv, false);
    } catch (err) {
      this.fault = String(err);
      conv.echoFailed(text, "not sent");
    }
  }

  /** Put a card by, or pick it back up.
   *
   *  The whole of the mechanism: `Conversation.aside` feeds `urgencyFor`, and
   *  everything that reads a tier follows from there — the waiting cycle, the
   *  dock's count, the peek and the card's own colour all go quiet together.
   *  Nothing is stopped, nothing is closed, nothing on disk moves; a card set
   *  aside keeps its process if it has one, its transcript, and its place.
   *
   *  Written through immediately rather than at the next settling turn, because
   *  a card set aside is very often one that will never take another turn —
   *  `update_conversation` otherwise only ever runs off a `result`, and waiting
   *  for one would lose the flag on exactly the cards it was meant for. */
  setAside(conv: Conversation, aside: boolean) {
    conv.aside = aside;
    void invoke("update_conversation", { id: conv.id, aside }).catch((err) => {
      this.fault = String(err);
    });
  }

  /** Stop the turn a card is in the middle of, and keep the card.
   *
   *  The counterpart of `send`, not of `close`: the process, the session and
   *  everything it has read stay exactly where they are, and the next prompt
   *  goes down the same stdin. What the agent had written by then is kept too —
   *  the CLI emits the half-finished message before it emits the aborted
   *  `result` — so stopping a turn costs you nothing you had already read.
   *
   *  Only ever aimed at a card that is working. A dormant one has no process to
   *  write to and a resting one has no turn to end, and in both cases the
   *  gesture belongs to whatever else Escape does. */
  async stop(conv: Conversation) {
    /* Ahead of the working guard, and it has to be: a card waiting to try again
       is not working — that is the whole state — so without this Escape did
       nothing to the one card on the wall visibly about to act on its own. It
       is also the plainest reading of the key. Whatever else Escape means here,
       aimed at a card that says "trying again…" it means don't. */
    if (conv.pendingHeal || this.#heals.has(conv.id)) {
      this.#dropHeal(conv);
      conv.activity = "left it";
      return;
    }
    /* And a card holding for an account, by exactly the same argument. It is
       not working — that is the whole state — and it is visibly about to act on
       its own the moment an allowance frees up. Escape aimed at one means
       don't, and it takes the held prompt with it: a hold you cancelled that
       fired anyway two hours later would be the worst of both. */
    if (conv.held) {
      this.#dropHold(conv);
      conv.activity = "left it";
      return;
    }
    /* And the same for a card about to be nudged, by the same argument: it is
       not working, it is visibly about to act on its own, and Escape aimed at
       it means don't. The stall itself is cleared too, not just the timer — the
       card stays amber otherwise, asking for the very thing you just refused. */
    if (conv.pendingNudge || this.#nudges.has(conv.id)) {
      this.#dropNudge(conv);
      conv.unwoken = null;
      conv.activity = "left it";
      return;
    }
    if (!conv.working || conv.dormant) return;
    /* Said before the round trip rather than after: the aborted `result` comes
       back inside a few tens of milliseconds and settles the card on "stopped",
       and a line written after the await would overwrite the true answer with
       an announcement of the question. */
    conv.activity = "stopping…";
    try {
      await invoke("interrupt_conversation", { id: conv.id });
    } catch (err) {
      this.fault = String(err);
      conv.activity = "could not stop";
    }
  }

  /** Start this card over: same card, same place, a brand-new session.
   *
   *  What Claude Code's own `/clear` does, on a wall where the terminal window
   *  is a card. There is no way to ask a running `claude -p` to forget its
   *  context — the CLI's `/clear` is a TUI gesture and never reaches the
   *  stream — so this is the honest equivalent: end the process and point the
   *  card at a fresh session id. The card stays dormant afterwards, exactly as
   *  a restored one does, and the next thing you say to it spawns it.
   *
   *  Nothing is destroyed. The old transcript stays where Claude Code wrote it,
   *  so `adopt a recorded session…` puts it back on the wall as its own card —
   *  which is the whole reason this is not offered as a danger item.
   *
   *  Order matters: `retiring` before the kill, or the exit code from our own
   *  `close_conversation` lands as a crash on the fresh session that replaced
   *  it. It is only set when there is a child to kill, since nothing would
   *  clear it otherwise and a later genuine crash would go unreported. */
  async clear(conv: Conversation) {
    this.#dropHeal(conv);
    this.#dropNudge(conv);
    try {
      if (!conv.dormant) {
        conv.retiring = true;
        await invoke("close_conversation", { id: conv.id });
      }
      const sessionId = crypto.randomUUID();
      await invoke("clear_conversation", { id: conv.id, sessionId });
      /* The card keeps its id and takes a new session, so anything remembered
         about the old one would be reported at the next launch against a
         session that never ran it. */
      await invoke("forget_jobs", { conversationId: conv.id }).catch(() => {});
      conv.clear(sessionId);
    } catch (err) {
      conv.retiring = false;
      this.fault = String(err);
    }
  }

  /** Call a card something else, and have it stay called that.
   *
   *  The one thing on this wall that is purely yours: a card's name is drawn by
   *  Skein, stored by Skein and never travels down stdin, so unlike `/compact`
   *  or `/model` there is nothing at the other end to ask. `rename_session` is
   *  on the CLI's control route and is deliberately not used — it renames the
   *  *session*, which is a file on disk, and the thing you are looking at when
   *  you rename a card is the card.
   *
   *  Cut by `titleFromPrompt`, the same function the first prompt is cut by, so
   *  a long name lands on the wall the way every other long name has. Which
   *  also means an empty one is refused here as well as by `resolveCommand`:
   *  there is no gesture for taking a card's name away, and a card silently
   *  falling back to `a new thread` is not what anybody typing this meant.
   *
   *  Written through at once rather than at the next settling turn, for
   *  `setAside`'s reason and one more: the card most likely to be renamed is a
   *  dormant one you are tidying up, which may never take another turn. */
  async rename(conv: Conversation, name: string) {
    const title = titleFromPrompt(name);
    if (!title) return;
    conv.title = title;
    conv.namedByHand = true;
    try {
      await invoke("update_conversation", {
        id: conv.id,
        title,
        namedByHand: true,
      });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Resolve a parked question. The agent's turn resumes from exactly where it
   *  stopped — no new turn, no re-prompt, no lost context.
   *
   *  One call is one parked HTTP request and therefore one reply, however many
   *  questions it asked, so the answers are composed here and sent together.
   *  That is the constraint the panel's stepper is shaped around: you answer
   *  them one at a time, but nothing leaves until the last one is given.
   *
   *  `answer` overrides the sheet — the one-question case still sends exactly
   *  the text of the option you clicked, unchanged from before questions were
   *  plural. */
  async answerAsk(conv: Conversation, answer?: string) {
    const ask = conv.pendingAsk;
    if (!ask) return;
    const text =
      answer !== undefined
        ? answer
        : composeAnswer(ask.questions, ask.answers);
    conv.pendingAsk = null;
    conv.activity = "responding";
    try {
      await invoke("answer_ask", { askId: ask.askId, answer: text });
      /* Only once it has landed. The parked request is a local handoff and
         returns in a millisecond, so there is nothing to be gained by drawing
         it optimistically the way `echo` does for a prompt — and an answer
         drawn for a call that had already timed out would be the transcript
         claiming the agent read something it never got. */
      conv.answered(text);
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Every card currently blocked on a question. These are facts, not
   *  inferences, so they sort ahead of anything merely overdue. */
  blocked = $derived(this.convs.filter((c) => c.pendingAsk));

  /* ── the horizon ─────────────────────────────────────────────────────
   *
   * Global usage, kept as one number so the ground itself can carry it. The
   * design's argument is that a running total belongs in your peripheral
   * vision, not in a corner you have to go and read.
   *
   * **The window is the local day, not the session.** It was the session — a sum
   * of `costUsd` over the cards currently on the wall — and that made the figure
   * a reading of *how long Skein had been open* as much as of anything spent.
   * Restart the app after a heavy morning and the ground went cold and the
   * number went back to nothing, so the one thing the horizon exists to say
   * ("today is getting expensive") was reset by the gesture most likely to
   * follow a heavy morning. Closing a card took its spend off the wall too.
   *
   * So it comes off the `turn` table instead, which is where every settled turn
   * has always written what it cost — the same figure survives a restart, keeps
   * what a closed card spent, and rolls over at midnight rather than at launch.
   * It is still this studio's spend and not the account's: a turn taken in a
   * terminal writes no `turn` row, which is what the usage widget reads
   * transcripts for. */

  /** What this wall has spent today, in dollars. Held rather than derived: the
   *  cards on screen no longer have the whole answer between them. */
  spend = $state(0);

  /** The local midnight the figure is measured from — the fact `spend` alone
   *  cannot show, since a day's spend and a session's look identical from
   *  outside until one of them is dated. */
  spendSince = $state(0);

  /** Re-read the day's spend if the day has rolled over underneath us.
   *
   *  Driven by the studio's existing one-second tick rather than a timer of its
   *  own — the wall has one wake-up a second and this does not add a second one
   *  — and it is a comparison of two numbers on every tick but the one a day.
   *  A wall left open overnight has to roll over on its own, or the morning's
   *  ground is still carrying last night's warmth. */
  dayTick(now: number) {
    const since = dayStart(now);
    if (since === this.spendSince) return;
    this.spendSince = since;
    void this.#readSpend();
  }

  /** Ask the table what the day has cost. The table is the only source: a turn
   *  is added to the figure by being *recorded*, never by being added here as
   *  well, or the two would drift and only one of them would survive a
   *  restart. */
  async #readSpend() {
    try {
      this.spend = await invoke<number>("spend_since", { since: this.spendSince });
    } catch {
      /* Leave the last good figure up. A failed read is not a day that cost
         nothing, and the ground going cold would say it was. */
    }
  }

  /** Total context held open across the wall. Not a cost — a weight. */
  heldTokens = $derived(this.convs.reduce((sum, c) => sum + c.ctxTokens, 0));

  /** How many cards are actually burning tokens right now. */
  live = $derived(this.convs.filter((c) => c.working).length);

  /** Send one prompt to several cards.
   *
   *  Dormant targets wake first, so lazy restore and broadcast compose without
   *  a special case. Sends are sequential rather than parallel: waking three
   *  `claude` processes at once is a thundering herd, and the ordering is
   *  visible on the wall anyway.
   *
   *  Every target is drawn first, in one pass, before any of them is delivered
   *  to: what you sent went to all of them at once, and a line appearing on the
   *  fourth card two seconds after the first would read as four separate
   *  gestures. */
  async broadcast(convs: Conversation[], text: string) {
    for (const c of convs) c.echo(text);
    for (const c of convs) {
      await this.#deliver(c, text);
    }
  }

  /** Which of these cards have already edited the same files as each other.
   *
   *  This is the collision feature paying a dividend before it exists: the
   *  moment before a prompt fans out is exactly when you want to know that two
   *  of your targets share a working tree. */
  async sharedTree(convs: Conversation[]): Promise<string[]> {
    if (convs.length < 2) return [];
    const ids = new Set(convs.map((c) => c.id));
    const clashing = new Set<string>();
    await Promise.all(
      convs.map(async (c) => {
        try {
          const others = await invoke<string[]>("overlapping_conversations", {
            conversationId: c.id,
          });
          if (others.some((o) => ids.has(o))) clashing.add(c.id);
        } catch {
          /* the warning is a courtesy, not a gate */
        }
      }),
    );
    return [...clashing];
  }

  /** Take a card off the wall for good.
   *
   *  **The wall is changed first and the bookkeeping follows it**, which is the
   *  other way round from how this read until it was found to be wrong. Closing
   *  used to await three commands and remove the card afterwards, so the whole
   *  gesture was hostage to all three: one that never answered left the card
   *  standing there with its process already killed — dormant, hollow, dashed,
   *  and refusing to go — while the row behind it had already been marked
   *  closed. That is the one disagreement nothing here can recover from, and it
   *  reads exactly like a bug in the drawing: the only way out was restarting
   *  Skein, at which point `load_studio`'s `closed_at IS NULL` swept up a card
   *  the wall had been insisting on for an hour.
   *
   *  So the removal is the first thing that happens and it cannot fail — three
   *  assignments, no `await` in front of any of them. The same bargain
   *  `Conversation.echo` strikes one subsystem over (see CLAUDE.md): a gesture
   *  is drawn when it is made, and the honesty is kept by *reporting* what went
   *  wrong rather than by refusing to draw it. `fault` is where that is said.
   *
   *  `retiring` is deliberately not set the way `clear` sets it. It is what
   *  stops our own kill being read as a crash, and it is `markExited` that reads
   *  it — which this card can no longer reach, having left `#byId` on the line
   *  above. There is nothing left to mislead.
   *
   *  `forget` rather than `unpin`, and that is not a detail: `unpin` means "let
   *  it flow again", so it deliberately *keeps* a card's glass spot, and a card
   *  that has gone for good would have left one behind for the rest of the
   *  session. See `Studio.forget`. */
  async close(conv: Conversation) {
    /* Or the timer fires against a card that is no longer on the wall, waking a
       process for a conversation this call has just closed. */
    this.#dropHeal(conv);
    this.#dropNudge(conv);

    this.#byId.delete(conv.id);
    this.convs = this.convs.filter((c) => c.id !== conv.id);
    this.#studio.forget(conv.id);

    try {
      await invoke("close_conversation", { id: conv.id });
      await invoke("close_conversation_record", { id: conv.id });
      /* Closing sets `closed_at` and deletes no row, so the foreign key never
         fires — see `migrate_v17`. Same bargain the billboard's sweep strikes. */
      await invoke("forget_jobs", { conversationId: conv.id }).catch(() => {});
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Write a card's placement down.
   *
   *  It takes the whole placement rather than a position and a flag, because
   *  the row carries two positions now — where the card belongs on the wall,
   *  and where it is drawn if it has been stuck to the glass. They answer
   *  different questions and are set by different gestures, so a caller that
   *  spelled out only the one it had changed would silently clear the other:
   *  dragging a territory would un-stick every card in it, and there would be
   *  no error anywhere to see it by. One argument, always complete. */
  savePlacement(id: string, p: Placement) {
    void invoke("save_placement", {
      conversationId: id,
      x: p.x,
      y: p.y,
      pinned: p.pinned,
      glassX: p.glassX ?? null,
      glassY: p.glassY ?? null,
    }).catch(() => {});
  }

  /** Stick a territory to the glass at a point in glass pixels, or take it off
   *  with `null`.
   *
   *  Its own command rather than more arguments on `place_project`, whose two
   *  nulls already mean something else entirely ("hand it back to the grid").
   *  The wall position is untouched: a territory on the pane still holds its
   *  cell, so taking it off puts it back among its neighbours exactly where it
   *  was and nothing else on the wall moves. Same write-through as
   *  `placeProject` — a drag asks for the new position on the next frame, and
   *  waiting for SQLite would drop the territory back for one of them. */
  stickProject(cwd: string, at: { x: number; y: number } | null) {
    this.projects = this.projects.map((p) =>
      p.root_path === cwd
        ? { ...p, glassX: at?.x ?? null, glassY: at?.y ?? null }
        : p,
    );
    void invoke("stick_project", {
      rootPath: cwd,
      x: at?.x ?? null,
      y: at?.y ?? null,
    }).catch(() => {});
  }

  /* ── where the territories sit ────────────────────────────────────────
   *
   * The wall reads a territory's position off the project row, so this updates
   * the row in hand *and* on disk: a drag asks for the new position on the very
   * next frame, and waiting for SQLite to answer would drop the territory back
   * where it started for one of them. */

  /** Put a territory somewhere. Nulls settle it back in among the others. */
  placeProject(cwd: string, x: number | null, y: number | null) {
    this.projects = this.projects.map((p) =>
      p.root_path === cwd ? { ...p, x, y } : p,
    );
    void invoke("place_project", { rootPath: cwd, x, y }).catch(() => {});
    /* Settling it back still ends in a position of its own — see `#settlePlaces`
       for why nothing is left unsettled for long. */
    if (x === null || y === null) this.#settlePlaces();
  }

  /** Re-pack every territory, as if the wall were being arranged fresh.
   *
   *  A deliberate gesture, on the wall's own menu — never automatic. The packing
   *  is dense, so a project that has grown a lot since it was placed can end up
   *  reaching into its neighbour; this is how you ask for the whole wall to be
   *  laid out again around what is actually standing on it now. */
  tidyProjects() {
    this.projects = this.projects.map((p) => ({ ...p, x: null, y: null }));
    this.#settlePlaces();
  }

  /** Write down where the packing put any territory that has no position yet.
   *
   *  Settling is for the moment a project first appears — or is asked for — and
   *  not a state to live in. Left unsettled, a territory's position would depend
   *  on the project list *and* on how many cards each project happens to be
   *  holding, so the wall would rearrange itself every time a conversation was
   *  opened or closed, and the cards pinned inside a territory that moved —
   *  absolute canvas coordinates, by design — would be left standing where the
   *  territory used to be.
   *
   *  Idempotent, and cheap: a project that has a position is left alone. */
  #settlePlaces() {
    const { regions } = layout(this.convs, this.#studio.placements, this.projects);
    for (const p of this.projects) {
      if (p.x !== null && p.y !== null) continue;
      const r = regions.find((r) => r.cwd === p.root_path);
      if (r) this.placeProject(p.root_path, r.x, r.y);
    }
  }

  /** Where a card is standing, for something to be put down beside it.
   *
   *  Off the same `layout` the canvas draws from, so a pinned image lands beside
   *  the card you are looking at rather than beside where the card would be if
   *  the wall were arranged differently. A card the layout does not know — closed
   *  between the pin and the event — falls to the origin, which is a visible
   *  wrong answer rather than a silent one: the image is on the wall and can be
   *  dragged, where a refusal would be a file in storage and nothing drawn.
   *
   *  The card's own corner, and not the spot the image takes. Choosing that
   *  needs the image's real size and therefore has to happen after it has been
   *  measured, which only the board can do — `pinSpot` has the argument, and
   *  `Board.pinned` is where it is called from.
   */
  spotBeside(id: string): { x: number; y: number } {
    const { laid } = layout(this.convs, this.#studio.placements, this.projects);
    const mine = laid.find((l) => l.conv.id === id);
    if (!mine) return { x: 0, y: 0 };
    return { x: mine.x, y: mine.y };
  }


  /* ── dev servers ──────────────────────────────────────────────────── */

  async startGroup(g: GroupRuntime) {
    const project = this.projectFor(g.group.project_id);
    try {
      await invoke("start_group", {
        group: g.group,
        cwd: project?.root_path ?? ".",
      });
      g.running = true;
    } catch (err) {
      this.fault = String(err);
    }
  }

  async stopGroup(g: GroupRuntime) {
    try {
      await invoke("stop_group", { groupId: g.group.id });
    } catch (err) {
      this.fault = String(err);
    }
    g.running = false;
    g.health = {};
  }

  /** `was` is for a group being put back rather than made — an imported layout
   *  (see `portage.ts`). It matters for exactly one reason and it is a safety
   *  one: `autostart` here has always been hard-coded true, which is right for a
   *  group you are creating by hand and wrong for one arriving in a document,
   *  because the load path starts every autostart group at launch. An import
   *  that quietly armed somebody else's dev servers would be a file that runs
   *  commands. So a carried group brings its own answer, and only a group made
   *  by hand gets the optimistic default. */
  async addGroup(
    projectId: string,
    label: string,
    servers: ServerSpec[],
    was?: { autostart: boolean; startOrder: number },
  ) {
    const group: ServerGroup = {
      id: crypto.randomUUID(),
      project_id: projectId,
      label,
      autostart: was?.autostart ?? true,
      start_order: was?.startOrder ?? this.groups.length,
      servers,
    };
    try {
      await invoke("save_server_group", { group });
      this.groups = [...this.groups, new GroupRuntime(group)];
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** New servers under an existing group, same row.
   *
   *  For rerooting a territory (`portage.svelte.ts`): a group whose servers
   *  still start in a folder from another machine is a group that looks right
   *  and does nothing. `save_server_group` upserts on the id, so this is the
   *  same row rather than a second one — which matters, because the running
   *  `GroupRuntime` is keyed on it and a new id would orphan whatever is up. */
  async reworkGroup(g: GroupRuntime, servers: ServerSpec[]) {
    const group: ServerGroup = { ...g.group, servers };
    try {
      await invoke("save_server_group", { group });
      this.groups = this.groups.map((x) => (x === g ? new GroupRuntime(group) : x));
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Where a territory points, changed.
   *
   *  Written through in hand as well as on disk, the same bargain
   *  `placeProject` strikes — the wall matches cards to territories by path on
   *  the very next frame. The *name* is deliberately left alone: a territory
   *  arriving in an imported layout is named for the folder it had where it was
   *  written, which is nearly always what you want to go on calling it, and a
   *  rename that happened as a side effect of pointing at a folder would be one
   *  you had to notice to undo. */
  rootedAt(id: string, rootPath: string) {
    this.projects = this.projects.map((p) => (p.id === id ? { ...p, root_path: rootPath } : p));
  }

  async removeGroup(g: GroupRuntime) {
    await this.stopGroup(g);
    try {
      await invoke("delete_server_group", { id: g.group.id });
    } catch (err) {
      this.fault = String(err);
    }
    this.groups = this.groups.filter((x) => x !== g);
  }

  /** Open a link the transcript rendered, outside the app.
   *
   *  Not a navigation: this window is the studio, undecorated and with nowhere
   *  to go back to, so following an `href` in it would be a one-way trip. Rust
   *  checks the scheme again — see `open.rs`. */
  async openLink(href: string) {
    try {
      await invoke("open_external", { url: href });
    } catch (err) {
      this.fault = String(err);
    }
  }

  groupsFor(projectId: string): GroupRuntime[] {
    return this.groups.filter((g) => g.group.project_id === projectId);
  }

  /** Read every card's transcript, a few at a time.
   *
   *  Bounded rather than fired all at once: each read crosses IPC carrying up
   *  to the tail cap, and a wall of thirty cards would otherwise ask for all
   *  thirty files in the same tick. Four keeps the disk busy without a spike. */
  async #fillHistory(convs: Conversation[]) {
    const queue = [...convs];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        await this.loadHistory(c);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  /** Fill a card's scrollback from the transcript on disk.
   *
   *  Nothing else can: `--resume` hands the model its history but puts none of
   *  it on the wire, which is why a card the app has not seen speak is blank
   *  without this. Runs once per card — see the note on `Conversation.history`
   *  — from the wall's own load, and again when a card is opened or adopted so
   *  that no card is ever left waiting to be clicked. */
  async loadHistory(c: Conversation) {
    if (c.historyState !== "unread") return;
    c.historyState = "loading";
    try {
      const t = await invoke<{ text: string; dropped_bytes: number } | null>(
        "read_transcript",
        /* The id alone: where the file is depends on the directory the child
           runs in, which is not `c.cwd` for a card on a branch, and the store
           is the one place that holds both halves of that. */
        { id: c.id },
      );
      if (!t) {
        /* No file at all — a card that was opened and never spoken to. */
        c.historyState = "none";
        return;
      }
      const h = foldTranscript(t.text, { partial: t.dropped_bytes > 0 });
      /* The card may have started speaking while the file was being read, in
         which case the turn is in both places. The wire wins. */
      c.history = c.lines.length ? trimOverlap(h.lines, c.lines) : h.lines;
      c.historyPartial = h.partial || h.dropped > 0;
      c.historyState = h.lines.length ? "ready" : "none";
    } catch {
      c.historyState = "error";
    }
  }

  /* ── persistence of live state ────────────────────────────────────── */

  /** Claude Code writes a generated title into the transcript as the session
   *  takes shape. It never reaches the stream, so we go and read it — a card
   *  called "Wire the supervisor to job objects" beats one called by whatever
   *  the first prompt happened to say.
   *
   *  Unless you have said what it is called. This runs at every settling turn,
   *  so without the guard a rename would hold until the card next spoke and
   *  then come undone on its own — which is worse than not having renamed it,
   *  because by then you have looked away and are trusting the wall. A generated
   *  title beats a prompt's first line; it does not beat you. */
  /** How hard this card is thinking, read off the transcript.
   *
   *  The wire carries no effort — probed 2026-08-20 against claude 2.1.233,
   *  where `system/init` names the model and the tools and says nothing about
   *  it, and an `assistant` event carries none either even when `--effort` was
   *  passed explicitly. The session file records it on every assistant record.
   *  So this is the same arrangement as `#adoptAiTitle` one method down: a fact
   *  about the session that only exists on disk, fetched at the settling turn.
   *
   *  Cheaper than the title read, deliberately, because it runs on the same
   *  path: `read_session_effort` works back from the end of the file in a
   *  doubling window, where `read_ai_title` reads the whole of it.
   *
   *  Written back to the row so a dormant card can say what it thinks at
   *  without spawning anything — and so the next spawn can be told, which is
   *  what makes a level chosen once hold across a wake. */
  async #adoptEffort(c: Conversation) {
    if (c.effortStated) {
      c.effortStated = false;
      return;
    }
    try {
      const effort = await invoke<string | null>("read_session_effort", { id: c.id });
      if (!isEffort(effort) || effort === c.effort) return;
      c.effort = effort;
      await invoke("update_conversation", { id: c.id, effort });
    } catch {
      /* No transcript yet is the normal case early in a session, and a build
         of Claude Code that records no effort is a footer with one fewer thing
         in it — neither is worth a line anywhere. */
    }
  }

  async #adoptAiTitle(c: Conversation) {
    if (c.namedByHand) return;
    try {
      const title = await invoke<string | null>("read_ai_title", { id: c.id });
      if (!title || title === c.title) return;
      c.title = title;
      await invoke("update_conversation", { id: c.id, title });
    } catch {
      /* No transcript yet is the normal case early in a session. */
    }
  }

  /** Forget the jobs a card has now been told about.
   *
   *  **Without this the same prompt is sent at every launch forever**, which is
   *  the failure `interrupted` had for most of its life — written once, read
   *  once, and nothing ever unset it. A row exists to carry one piece of news
   *  across one restart; once it has been carried it is spent.
   *
   *  Cleared only after the send, and only for what was actually reported: a
   *  prompt that never left has told the card nothing, and a job that started
   *  while the prompt was in flight has not been mentioned to anybody. */
  async #toldAboutJobs(conv: Conversation, jobs: LostJob[]) {
    if (!jobs.length) return;
    for (const j of jobs) {
      await invoke("settle_job", { toolId: j.toolId }).catch(() => {});
    }
  }

  /** Write down what background work started and what reported in.
   *
   *  Drained on every event rather than at the `result`, because that is the
   *  whole point of the table: a job outlives the turn that started it, and the
   *  crash this exists for lands somewhere in between. `#persistConv`'s bargain
   *  — write at the settling turn, a dormant card shows what it reached — is
   *  exactly the wrong one here, and is the shape of the bug `set_mid_turn`
   *  was written to fix one file over: **bookkeeping that records how far
   *  something got must not wait for the getting there.**
   *
   *  Nothing is awaited and a failure is swallowed. What a lost write costs is
   *  one line in a resume prompt tomorrow; what awaiting it would cost is the
   *  ingest path, on every event, for every card on the wall. */
  #writeJobs(c: Conversation) {
    if (!c.jobWrites.length) return;
    const writes = c.jobWrites;
    c.jobWrites = [];
    for (const w of writes) {
      if (w.op === "settle") {
        void invoke("settle_job", { toolId: w.toolId }).catch(() => {});
      } else {
        void invoke("record_job", {
          toolId: w.toolId,
          conversationId: c.id,
          /* The session rather than the card, because a cleared card keeps its
             id and takes a new session — and the output path is built from the
             session. See `migrate_v17`. */
          sessionId: c.sessionId || c.id,
          taskId: w.taskId,
          kind: w.kind,
          label: w.label,
          outputPath: w.outputPath,
        }).catch(() => {});
      }
    }
  }

  /** Keep the row current enough that a dormant card can show what it reached
   *  without ever spawning the session behind it. */
  #persistConv(c: Conversation, ev: any) {
    if (ev?.type === "result") {
      void this.#adoptAiTitle(c);
      void this.#adoptEffort(c);
      void invoke("update_conversation", {
        id: c.id,
        model: c.model ?? null,
        lastCtxFrac: c.ctx,
        /* `lastEnding`, not `lastTier`: the column holds how the turn *ended*
           (ok / question / asked / error), which is a fact about the turn. The
           tier is a derived colour that decays with neglect, so persisting it
           would restore a card as whatever urgency it happened to be wearing.
           The name has to match the command's `last_ending` parameter too — an
           unknown key is silently dropped, and the COALESCE then leaves the
           column NULL, which is what made every restored card claim it had
           never spoken and wake with --session-id instead of --resume. */
        lastEnding: c.ending,
      }).catch(() => {});
      /* `c.lastTurn`, not `c.ctxTokens` and not `c.costUsd`: the ring's
         occupancy is a reading of the last request rather than a count of what
         this turn spent, and `costUsd` is the session's running total. Both
         were being written here as if they were per-turn facts, which is what
         made the table unreadable — see `store.rs::record_turn`. */
      void invoke("record_turn", {
        conversationId: c.id,
        statusTier: c.tier,
        inTokens: c.lastTurn.in,
        outTokens: c.lastTurn.out,
        cacheReadTokens: c.lastTurn.cacheRead,
        cacheWriteTokens: c.lastTurn.cacheWrite,
        usd: c.lastTurn.usd,
      })
        /* And the day's figure moves, once the row is actually in — the write
           is what the reading is of. Chained rather than added to `spend` here,
           so there is one source for that number and not two that can drift.
           A SUM over the turn table costs less than the round trip carrying
           it. */
        .then(() => this.#readSpend())
        .catch(() => {});
    } else if (ev?.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const path = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof path !== "string") continue;
        const op = b.name === "Read" ? "read" : "write";
        void invoke("record_file_touch", {
          conversationId: c.id,
          path,
          op,
        }).catch(() => {});
        /* And the billboard, which may have a notice covering this file that
           this card has not been shown. Beside the touch rather than folded
           into it because they answer different questions — one is a ledger of
           what happened, the other reaches out — and only this one is about
           *writes*: reading a file somebody else is rewriting is not a clash,
           it is how you find out. Fire and forget; `board.rs::on_touch` decides
           whether there is anything to say. */
        if (op === "write") {
          void invoke("board_touch", { conversationId: c.id, path }).catch(() => {});
        }
      }
    }
  }
}
