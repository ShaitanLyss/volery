/* The studio's side of the control surface.
 *
 * Rust takes an op off a loopback socket and emits it here; this dispatches it
 * and replies. See src-tauri/src/control.rs for why any of this exists.
 *
 * Two rules kept this honest, and they are worth stating because breaking
 * either would turn a green run into a lie:
 *
 *  1. **Drive the app's own seams, not its internals.** Injecting a stream event
 *     goes out as a real `conv:event` and comes back through Rust to the same
 *     listener the supervisor talks to. A dropped file goes out as a real
 *     `tauri://drag-drop`. So these ops exercise the wiring, not a parallel
 *     path built to be easy to test.
 *
 *  2. **Say which pointer you mean.** `click` dispatches a synthetic event: it
 *     proves the handlers are connected to each other and nothing more.
 *     `real.click` moves the actual cursor through Win32. Only the second can
 *     see the bug that shipped here twice — Chromium retargeting a *real* click
 *     after `setPointerCapture` is invisible to any event you dispatch yourself.
 *
 * There is no `eval` op, on purpose. A fixed vocabulary is a description of
 * what the app can be asked to do; an eval hole is a description of nothing. */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { Conversation } from "./conversation.svelte";
import { NO_PREFERENCE, composeAnswer, isComplete, panelsOf, stepAt } from "./asking";
import { stripAnsi } from "./ansi";
import type { Ambience } from "./ambience.svelte";
import { living, type EffectKind } from "./ambience";
import { readingScale } from "./layout";
import { pressed, type Kind } from "./pick";
import { spotOf } from "./glass";
import type { Board } from "./images.svelte";
import type { Widgets } from "./widgets.svelte";
import type { Meter } from "./meter.svelte";
/* The singleton rather than a host field: `crowds` is reached the same way
   `clock` is, by every module that needs it, because there is exactly one
   poller and nothing chooses which. */
import { crowds } from "./crowds.svelte";
/* And the same, for the one question asked of the network at launch. */
import { releases } from "./release.svelte";
import type { Ledger } from "./ledger.svelte";
/* Aliased throughout: `tierOf` is also an Azure DevOps verb in this file, and
   the two taxonomies must not be able to be mistaken for one another. */
import {
  ordered as orderedWindows,
  resetIn,
  tierOf as windowTier,
  said as windowSaid,
} from "./limits";
import type { DevOps } from "./devops.svelte";
import type { Shell } from "./shell.svelte";
import type { Finder } from "./finder.svelte";
import type { Bang } from "./bang.svelte";
import {
  needsMe,
  reviewSaid,
  reviewTierOf,
  shortRef,
  tallyReviews,
  tallyRuns,
  tierOf,
} from "./azdo";
import { amount, readings, type Measure } from "./usage";
import { limitIn, runIn, variantOf, type WidgetKind } from "./widgets";
import type { Cycle } from "./cycle.svelte";
import { elapsed, phaseOf, phraseFor, standing } from "./timing";
import type { Skein } from "./skein.svelte";
import type { Studio } from "./studio.svelte";
import type { Undo } from "./undo.svelte";
import { shifted, standsOf } from "./undo";
import type { Attention } from "./attention.svelte";
import type { Actions } from "./actions.svelte";

export type Endpoint = { port: number; token: string };

/** The handles a pair of hands would have. Passed in rather than imported so
 *  the control surface owns no state of its own and can't drift from the UI. */
export type ControlHost = {
  skein: Skein;
  studio: Studio;
  board: Board;
  widgets: Widgets;
  /** The wall's undo stack. Here because it is the one thing on the wall whose
   *  correctness is entirely about *sequences* of gestures — that a drag is one
   *  step and a territory is one step, that a redo comes back to the same place
   *  — and a sequence of real gestures is what this suite is for. */
  undo: Undo;
  meter: Meter;
  /** The one transcript reader behind the usage widget. */
  ledger: Ledger;
  /** The one Azure DevOps connection, so `azdo` can drive the real poll rather
   *  than a path beside it. */
  devops: DevOps;
  /** The studio's one pomodoro cycle. The break it enforces takes the whole
   *  window, so a test that cannot drive it cannot see the one thing in the app
   *  that stops you. */
  pomodoro: Cycle;
  ambience: Ambience;
  attention: Attention;
  actions: Actions;
  /** The shell behind Alt+I. It holds a real process a person types into, and
   *  it is the one thing on this wall whose panel and whose session are
   *  separate facts — which is exactly the sort of thing only a test from
   *  outside can hold both halves of at once. */
  shell: Shell;
  /** The finder behind the space-leader chords. Here for the leader above all:
   *  a chord is a *sequence* of keypresses with a stopwatch in it, and the only
   *  thing that can hold both halves of that at once — that the second key
   *  fires and that the wrong second key falls through to the draft — is a test
   *  pressing real keys from outside. */
  finder: Finder;
  /** The `!` line's session. Here for the leak count above all: it holds two
   *  subscriptions and a batch timer, and a superseded generation of it would go
   *  on writing another card's output into a transcript. */
  bang: Bang;
  canvas: () =>
    | {
        toCanvas(x: number, y: number): { x: number; y: number };
        fitAll(): void;
        toggleGlass(
          kind: "card" | "image" | "widget" | "region",
          id: string,
        ): void;
      }
    | undefined;
  focusedId: () => string | null;
  setFocused: (id: string | null) => void;
  /** Letting go of everything, the wall's own way — same function the ground
   *  click and Escape call, so the op cannot drift from the gesture. */
  deselect: () => void;
  draft: () => string;
  setDraft: (text: string) => void;
  /** What the slash palette is offering for the draft as it stands. */
  commands: () => { name: string }[];
  /** And what its second stage is offering, once a command that takes a value
   *  has been named. Reported apart from `commands` because the two stages are
   *  never both up: an empty `commands` is a palette that is down *or* one that
   *  has moved on to the values, and from outside those look identical. */
  choices: () => string[];
  targets: () => Conversation[];
  waiting: () => Conversation[];
  clashing: () => string[];
  /** Resolves to the card it opened, which this only ever awaits — the op finds
   *  the new conversation by diffing ids, so it needs nothing from the value. */
  openIn: (dir: string, worktree?: string) => Promise<unknown>;
  /** The same, for a card with no project. Separate rather than a flag on
   *  `openIn`, because it takes no directory: where a chat card stands is
   *  Skein's business and nothing a caller gets to choose. */
  openChat: () => Promise<unknown>;
  /** Open a card on a project's half-finished merge, prompt already sent. */
  resolveConflicts: (cwd: string) => Promise<void>;
  submit: (broadcast: boolean) => Promise<void>;
  flags: () => Record<string, boolean>;
  setFlag: (name: string, value: boolean) => void;
  /** Which project's shell Alt+I would land in — the same reading the panel
   *  takes, and a project root rather than any one card's directory. */
  shellCwd: () => string;
};

type Op = Record<string, any>;
type Handler = (op: Op) => unknown | Promise<unknown>;

const MAX_ERRORS = 40;

/** Which Control is allowed to serve.
 *
 *  Editing this file makes Vite swap `App.svelte` in place, which constructs a
 *  second Control while the first one's `listen` is still attached — nothing
 *  unregisters it. Both then answered every op, and because ops *act*, one
 *  `open` spawned two agents and wrote two conversation rows before this was
 *  caught. Rust accepts only the first reply, so the second spawn left no trace
 *  in the response: the harness reported one card and had made two.
 *
 *  The counter has to live outside this module. A module-scoped `let` is
 *  re-evaluated by the very reload it is guarding against, so each generation
 *  would start its own count and every instance would believe it was newest —
 *  which is precisely the bug, wearing a guard. */
const SLOT = "__skeinControlGeneration";

function claim(): number {
  const w = window as unknown as Record<string, number>;
  w[SLOT] = (w[SLOT] ?? 0) + 1;
  return w[SLOT];
}

function newest(): number {
  return (window as unknown as Record<string, number>)[SLOT] ?? 0;
}

function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Let Svelte flush and the browser paint. Every op returns after this, so a
 *  snapshot taken straight after a mutation sees the mutation. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await raf();
  await raf();
}

/** Strip reactive proxies and anything else that won't survive the IPC. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** A parked ask as a test can see it.
 *
 *  `question` and `options` are the question *currently* being asked, kept
 *  under their old names so a test written before questions were plural still
 *  reads. Everything else is here because a stepper is otherwise invisible from
 *  outside: a call parked on three decisions with two answered has the same
 *  card, the same tier and the same clock as one parked on three with none. */
function askSnapshot(ask: Conversation["pendingAsk"]) {
  if (!ask) return null;
  const step = stepAt(ask.answers);
  return {
    askId: ask.askId,
    question: ask.questions[step].question,
    options: ask.questions[step].options.map((o) => o.label),
    step,
    count: ask.questions.length,
    headers: ask.questions.map((q) => q.header),
    answers: [...ask.answers],
    dropped: ask.dropped,
    complete: isComplete(ask.answers),
    /* How many designs each question offers to show. Same reason the stepper's
       fields are here: a question whose three options carry three mockups and
       one whose options carry none are the same question, the same card and the
       same tier from outside, and the whole feature lives in the difference. */
    previews: ask.questions.map((q) => panelsOf(q).length),
  };
}

/** What has been spent and what is left, as a test can see it.
 *
 *  Both windows at both measures, because which one a widget happens to be
 *  drawing is a property of that widget rather than of the ledger — and a test
 *  that had to switch the `measure` knob to read the other number would be
 *  testing the menu instead of the arithmetic. `watchers` and `ready` are apart
 *  from the widget count for the reason `meter.sampling` is: a usage widget with
 *  a stopped reader draws whatever it last saw and looks identical from outside.
 *
 *  `scanning` and `asking` are reported apart from each other and from
 *  `watchers` because the two halves now start and stop independently — a widget
 *  set to the allowance runs no transcript pass at all, and one set to cost makes
 *  no request. A snapshot that reported only a watcher count could not tell those
 *  apart, and "the reader I thought was running is not" is exactly the failure
 *  this field exists to catch.
 *
 *  `resetsIn` on the block is the *inferred* five-hour boundary off the
 *  transcripts; `allowance.windows[].resetsIn` is the account's own, off the
 *  wire. Both are reported, because they are different claims and the whole
 *  point of the second one is that it does not have to be guessed at.
 *
 *  Deliberately no token and no fragment of one — `source` says only where the
 *  credential was found. A snapshot gets written to a file; see `azdo.md`. */
function ledgerSnapshot(h: ControlHost) {
  const now = Date.now();
  const at = (measure: Measure) => {
    const r = readings(h.ledger.slices, now, measure);
    return {
      block: amount(r.block.totals, measure),
      week: amount(r.week.totals, measure),
      blockFrac: r.block.frac,
      weekFrac: r.week.frac,
    };
  };
  const r = readings(h.ledger.slices, now, "cost");
  const limits = h.ledger.limits;
  return {
    watchers: h.ledger.watchers,
    scanning: h.ledger.scanning,
    asking: h.ledger.asking,
    ready: h.ledger.ready,
    at: h.ledger.at || null,
    slices: h.ledger.slices.length,
    /* Whether the five-hour block is open at all. Nothing said for five hours
       is a real state, and the one the face draws as rested. */
    resting: r.block.resetsIn === null,
    resetsIn: r.block.resetsIn,
    unpriced: r.week.totals.unpriced,
    cost: at("cost"),
    tokens: at("tokens"),
    fault: h.ledger.fault,
    /* The account's own reading. Null rather than an empty shape when nothing
       has answered yet, so "not asked" and "asked, no windows" stay apart. */
    allowance: limits
      ? {
          at: limits.at,
          source: limits.source,
          plan: limits.plan,
          overage: limits.overage?.enabled ?? false,
          windows: orderedWindows(limits.windows).map((w) => ({
            kind: w.kind,
            group: w.group,
            said: windowSaid(w),
            used: w.used,
            tier: windowTier(w),
            scope: w.scope,
            active: w.active,
            resetsAt: w.resetsAt,
            resetsIn: resetIn(w, now),
          })),
        }
      : null,
    allowanceFault: h.ledger.limitsFault,
  };
}

/** Azure DevOps as a test can see it.
 *
 *  The two halves are reported apart all the way down, because they genuinely
 *  fail apart: probed 2026-08-14, the credential this machine holds reads pull
 *  requests and is refused on builds, so `reviews.fault` being null while
 *  `runs.fault` is set is the *normal* broken state rather than an odd one. A
 *  single fault field would have made that indistinguishable from both halves
 *  working.
 *
 *  `watchers` is apart from the widget count for the reason `meter.sampling` is:
 *  a pipelines widget on the wall with a stopped poller draws whatever it last
 *  saw and looks identical from outside. `orgs` is here because it is the one
 *  way to see that the wall's project roots were read at all — an empty list is
 *  a wall with no Azure DevOps repo on it, which is a different silence from a
 *  wall whose pipelines are quiet, and `emptySaid` distinguishes them on the
 *  face.
 *
 *  Deliberately reports no credential and no fragment of one. What rung was
 *  accepted is Rust's business; a snapshot is read by a test harness and written
 *  to a file, and a token in either is a token leaked. */
function devopsSnapshot(h: ControlHost) {
  const half = (
    k: "runs" | "reviews",
  ): {
    watchers: number;
    ready: boolean;
    at: number | null;
    rows: number;
    orgs: string[];
    asked: number;
    fault: string | null;
  } => {
    const it = h.devops[k];
    return {
      watchers: h.devops.watchers[k],
      ready: it.ready,
      at: it.at || null,
      rows: it.rows.length,
      orgs: [...it.orgs],
      asked: it.asked,
      fault: it.fault,
    };
  };
  const now = Date.now();
  return {
    polling: h.devops.polling,
    runs: {
      ...half("runs"),
      /* The tallies, so a test can assert on what the header says without
         re-implementing the taxonomy — which is the whole thing `azdo.ts` exists
         to own. */
      ...tallyRuns(h.devops.runs.rows, now),
    },
    reviews: {
      ...half("reviews"),
      ...tallyReviews(h.devops.reviews.rows),
    },
  };
}

/** The undo stack as a test can see it.
 *
 *  The labels rather than the acts, because a label is what the gesture *was*
 *  and it is what the menu says out loud — a test asserting on the two names is
 *  asserting on the same string a person reads, which no snapshot of positions
 *  can be. The depths come with them because that is the half that says a
 *  gesture fused: a drag of sixty frames and a drag of one both leave `undoing`
 *  saying "moving a widget", and only `back` tells you which happened. */
function undoSnapshot(h: ControlHost) {
  return {
    back: h.undo.past.done.length,
    forward: h.undo.past.undone.length,
    undoing: h.undo.goingBack,
    redoing: h.undo.goingForward,
    /* Every act on the stack, oldest first. A sequence is the thing being
       tested; a test that could only see the head would have to undo the stack
       to read it, which is the gesture under test. */
    acts: h.undo.past.done.map((a) => a.label),
  };
}

/** The cycle as a test can see it.
 *
 *  `posture` is the field that matters and the reason this is not just the raw
 *  state: a break pushed back, a break being taken and a focus running all have
 *  an `on` cycle with an odd-or-even `done`, and telling them apart from outside
 *  by arithmetic would mean re-implementing `timing.ts` in the harness. `resting`
 *  is reported beside it because that — and only that — is what puts the rest
 *  screen over the window. */
function pomodoroSnapshot(h: ControlHost) {
  const c = h.pomodoro.cycle;
  const phase = phaseOf(c);
  return {
    on: c.on,
    paused: c.paused,
    /* Whether anything on the wall is showing it. Reported apart from the
       widget count for the reason `meter.sampling` is: a cycle nobody has a
       view of and a cycle simply paused by hand look identical from outside,
       and only one of them starts again by itself when a widget goes back up. */
    watched: h.pomodoro.watched(),
    posture: h.pomodoro.posture,
    resting: h.pomodoro.resting,
    phase: phase.kind,
    phrase: phraseFor(phase),
    number: phase.number,
    done: c.done,
    leftSeconds: Math.round(h.pomodoro.left),
    returningSeconds: h.pomodoro.returning,
    pushed: c.pushed,
    cadence: c.cadence,
    per: c.per,
    fault: h.pomodoro.fault,
  };
}

export class Control {
  endpoint = $state<Endpoint | null>(null);

  /** Anything the page threw. Silent front-end errors are exactly what a
   *  screenshot can't show me, so they ride along in every snapshot. */
  #errors: { at: number; text: string }[] = [];
  #host: ControlHost;
  #ops: Record<string, Handler>;
  readonly #gen: number;
  #unlisten: (() => void) | null = null;

  constructor(host: ControlHost) {
    this.#gen = claim();
    this.#host = host;
    this.#ops = this.#table();
    this.#watchErrors();
    void this.#attach();
  }

  /** True only for the instance the live component tree belongs to. */
  get current(): boolean {
    return this.#gen === newest();
  }

  detach() {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  get live(): boolean {
    return this.endpoint !== null;
  }

  #note(text: string) {
    this.#errors.push({ at: Date.now(), text: clip(text, 400) });
    if (this.#errors.length > MAX_ERRORS) this.#errors = this.#errors.slice(-MAX_ERRORS);
  }

  #watchErrors() {
    window.addEventListener("error", (e) => {
      this.#note(`${e.message} @ ${e.filename}:${e.lineno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.#note(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`);
    });
    const original = console.error;
    console.error = (...args: unknown[]) => {
      this.#note(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      original(...args);
    };
  }

  async #attach() {
    const ep = await invoke<Endpoint | null>("control_endpoint").catch(() => null);
    if (!ep) return;
    this.endpoint = ep;

    this.#unlisten = await listen<{ rid: string; op: Op }>("control:op", async (e) => {
      /* A superseded instance must neither answer nor act. Silence is correct:
         the live instance is listening to the same event and will reply. */
      if (!this.current) {
        this.detach();
        return;
      }
      const { rid, op } = e.payload;
      let value: unknown;
      try {
        const name = String(op?.op ?? "");
        const fn = this.#ops[name];
        if (!fn) {
          value = {
            ok: false,
            error: `no op "${name}"`,
            ops: Object.keys(this.#ops).sort(),
          };
        } else {
          const result = await fn(op);
          await settle();
          value = { ok: true, ...(result && typeof result === "object" ? result : { result }) };
        }
      } catch (err) {
        value = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      /* Who answered. If this ever disagrees with `generation` from /health, a
         superseded studio is serving and nothing else in the reply is
         trustworthy — which took twenty minutes to work out the first time. */
      await invoke("control_reply", {
        rid,
        value: plain({ ...(value as object), gen: this.#gen }),
      }).catch(() => {});
    });

    /* Only now can an op be delivered, so only now do we admit to being here. */
    await invoke("control_attach", { generation: this.#gen }).catch(() => {});
  }

  /* ── lookups ─────────────────────────────────────────────────────────── */

  /** Find a card by id, by exact title, or by 1-based index on the wall.
   *  Tests read better as `{"card": "caravan"}` than as a pasted uuid. */
  #card(op: Op, key = "id"): Conversation {
    const want = op[key] ?? op.card ?? op.conversationId;
    const convs = this.#host.skein.convs;
    if (want === undefined || want === null) {
      const f = convs.find((c) => c.id === this.#host.focusedId());
      if (f) return f;
      throw new Error("no card named and none focused");
    }
    if (typeof want === "number") {
      const c = convs[want];
      if (!c) throw new Error(`no card at index ${want}`);
      return c;
    }
    const s = String(want);
    const hit =
      convs.find((c) => c.id === s) ??
      convs.find((c) => c.title === s) ??
      convs.find((c) => c.title.toLowerCase().includes(s.toLowerCase())) ??
      convs.find((c) => c.project.toLowerCase().includes(s.toLowerCase()));
    if (!hit) throw new Error(`no card matching "${s}"`);
    return hit;
  }

  #cards(op: Op): Conversation[] {
    const want = op.ids ?? op.cards;
    if (!Array.isArray(want)) return [this.#card(op)];
    return want.map((w) => this.#card({ id: w }));
  }

  #el(op: Op): HTMLElement {
    const sel = String(op.selector ?? "");
    if (!sel) throw new Error("no selector given");
    const all = document.querySelectorAll<HTMLElement>(sel);
    const at = Number(op.index ?? 0);
    const el = all[at];
    if (!el) {
      throw new Error(`selector "${sel}" matched ${all.length} elements, wanted #${at}`);
    }
    return el;
  }

  /* ── what the wall looks like right now ──────────────────────────────── */

  #snapshot() {
    const h = this.#host;
    return {
      focusedId: h.focusedId(),
      selected: [...h.studio.selected],
      /* The whole selection, spanning all four kinds, in the order it was
         picked. `selected` above is the same fact narrowed to cards, kept
         because that is what the dock has always meant by the gathering — but a
         wall where a card, a project, a widget and an image can be held at once
         needs a reading that can *say* so, or `test:wall` could assert on a
         box-select without being able to see three quarters of what it caught.
         Flat strings rather than objects, because a `kind:id` pair is what
         `pick.ts` keys on and what a test wants to compare. */
      picks: h.studio.picks.map((p) => `${p.kind}:${p.id}`),
      draft: h.draft(),
      flags: h.flags(),
      loaded: h.skein.loaded,
      fault: h.skein.fault,
      /* Whether SKEIN_NO_SERVERS suppressed the eager start, so a test that
         finds every group idle can tell which kind of idle it is. */
      serversQuiet: h.skein.serversQuiet,
      /* The same distinction one layer up: a wall of dormant cards left alone
         by SKEIN_NO_WAKE and one whose every wake failed look identical from
         out here. `rousing` says the queue is still working along the wall, so
         a test that finds a card dormant can tell "not yet" from "not going
         to". */
      wakeQuiet: h.skein.wakeQuiet,
      rousing: h.skein.rousing,
      /* The day's spend, and the local midnight it is measured from. Reported
         apart for the reason `panel.reading` and `panel.linePx` are: a session
         total and a day's are the same lone number from out here, and only the
         cutoff says which window this one is. */
      spend: h.skein.spend,
      spendSince: h.skein.spendSince,
      heldTokens: h.skein.heldTokens,
      live: h.skein.live,
      viewport: {
        x: h.studio.x,
        y: h.studio.y,
        scale: h.studio.scale,
        lod: h.studio.lod,
      },
      /** How the panel is set up to be read from. Both halves, and they are
       *  different claims: `reading` is the multiplier the studio holds,
       *  `linePx` is the size a line is actually drawn at. A `--read` that
       *  never reached a rule would leave the first one moving and the second
       *  one still. Null with no panel open, which is not the same as zero. */
      panel: {
        reading: readingScale(h.studio.readScale),
        linePx: (() => {
          const line = document.querySelector(".lines .line");
          if (!line) return null;
          const px = parseFloat(getComputedStyle(line).fontSize);
          return Number.isFinite(px) ? Math.round(px * 100) / 100 : null;
        })(),
        /** Where the reading has got to, and how far it could go. Both, because
         *  either alone is unreadable from outside: a `scrollTop` of 0 is the
         *  top of a long transcript and also every position of one that does not
         *  fill its panel, and the ctrl+arrow keys are a no-op in the second
         *  case for perfectly good reasons. Null with no panel open. */
        ...(() => {
          const el = document.querySelector(".lines");
          if (!el) return { scrollTop: null, scrollMax: null };
          return {
            scrollTop: Math.round(el.scrollTop),
            scrollMax: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)),
          };
        })(),
      },
      /* The pane in front of the wall, and the two things about it that are in
         no item's own row. `w`/`h` is what `glassAt` keeps things inside, so a
         widget clamped to an edge and one dragged there look identical without
         it. The rect is the whole of "over the transcript, never over the dock
         or the title bar" — the pane is a box inside `main.wall`, so a test
         compares it with the header's and the dock's and sees them not meet.
         Null would mean the canvas is not up at all. */
      glass: (() => {
        const el = document.querySelector(".glass");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          items: el.childElementCount,
        };
      })(),
      projects: h.skein.projects.map((p) => ({
        id: p.id,
        name: p.name,
        root: p.root_path,
        /* Where the territory sits. Null means the grid is still deciding, which
           after a load should be true of nothing — see `#settlePlaces`. */
        x: p.x,
        y: p.y,
        /* And where it is *drawn*, if it has been stuck to the glass. Reported
           beside `x`/`y` rather than instead of them, because the claim worth
           seeing from outside is that sticking a territory changed neither. */
        glass: spotOf(p),
      })),
      /* What is crossing the wall right now, and what a cap has cut short.
         `cut` is reported because `MAX_STRANDS` silently dropping strands
         during a big broadcast is exactly the kind of bound that reads from
         outside as "the wall missed one" — see the note on `retire`. */
      flights: {
        live: h.skein.flights.all.map((f) => ({
          id: f.id,
          from: f.from,
          to: f.to,
          delivered: f.delivered,
          broadcast: f.broadcast,
          fan: f.fan,
          age: Date.now() - f.at,
        })),
        cut: h.skein.flights.cut,
        waiting: { ...h.skein.flights.inbox },
      },
      /* What is standing on the billboard. `watchers` is reported beside it for
         `listeners`' reason: the reader is idle until a widget attaches, so an
         empty `notices` on a wall with nothing hung up is the feature working
         rather than an empty board. */
      board: {
        watchers: h.skein.board.watchers,
        notices: h.skein.board.notices.map((n) => ({
          id: n.id,
          scope: n.scope,
          from: n.from,
          subject: n.subject,
          paths: n.paths,
          stale: n.stale,
        })),
      },
      cards: h.skein.convs.map((c) => ({
        id: c.id,
        /* Equal to `id` until the card is cleared, and the only way to see from
           outside that a clear actually repointed it. */
        sessionId: c.sessionId,
        project: c.project,
        cwd: c.cwd,
        worktree: c.worktree,
        /* Reported for the reason `aside` and `busy` are: from outside, a chat
           card and a project card differ in nothing a snapshot already carries
           — same tier, same activity, same everything — while the argv behind
           them is the whole point. This is the only way a test can see which
           one it got. */
        kind: c.kind,
        title: c.title,
        /* Beside the title for the reason `aside` is beside `tier`: a card you
           named and a card the transcript happened to name the same thing are
           the same string from out here, and the difference is whether the next
           settling turn takes it back. */
        namedByHand: c.namedByHand,
        tier: c.tier,
        activity: c.activity,
        dormant: c.dormant,
        /* What separates a crash from a card restored off disk — both are
           dormant, and only one of them is something to announce. */
        died: c.died,
        working: c.working,
        ending: c.ending,
        everSpoke: c.everSpoke,
        interrupted: c.interrupted,
        /* Reported beside `tier` rather than inferred from it: a card that is
           set aside and one that is merely resting both read `rest`, which is
           the intended effect and therefore the thing a test cannot see. */
        aside: c.aside,
        /* Reported beside `working` for that same reason, and it is the sharper
           case: a card mid-turn and a card whose turn ended over a background
           job both read `work`, which is the whole point of the change — so
           `working: false, busy: true` is the only way to see from outside that
           a job is what is holding the colour. */
        busy: c.busy,
        /* What another card sent here while this one was dormant, still
           waiting. Reported beside `dormant` for the reason `aside` is beside
           `tier`: a sleeping card with post and one without are the same card
           from out here, and the difference is what happens the moment it
           wakes. */
        inbox: h.skein.flights.inbox[c.id] ?? 0,
        jobs: c.jobs.map((j) => ({
          toolId: j.toolId,
          taskId: j.taskId,
          kind: j.kind,
          label: j.label,
          state: j.state,
          seconds: Math.floor((Date.now() - j.since) / 1000),
        })),
        /* The agent's own plan. `done` is reported rather than left to be
           counted, so a test and the card face cannot disagree about it. */
        plan: {
          total: c.plan.length,
          done: c.planDone,
          items: c.plan.map((t) => ({
            n: t.n,
            subject: t.subject,
            activeForm: t.activeForm,
            status: t.status,
          })),
        },
        idleSeconds: c.idleSeconds,
        ctx: c.ctx,
        ctxTokens: c.ctxTokens,
        contextWindow: c.contextWindow,
        model: c.model ?? null,
        costUsd: c.costUsd,
        turns: c.turns,
        lastError: c.lastError,
        streaming: clip(c.streaming, 200),
        lineCount: c.lines.length,
        lastLine: c.lines.length ? clip(c.lines[c.lines.length - 1].text, 160) : null,
        /* `question` and `options` are the question *currently being asked*,
           kept under their old names so a test written against a single-question
           ask still reads. `step`, `answers` and the rest are the only way to
           see a stepper from outside: a call parked on three decisions with two
           answered looks, from here, exactly like one parked on three with none
           — same card, same tier, same clock. */
        pendingAsk: askSnapshot(c.pendingAsk),
        seats: c.seats.map((s) => ({
          id: s.id,
          persona: s.persona,
          state: s.state,
          thought: clip(s.thought, 120),
          verdict: s.verdict,
          /* Null for a subagent, an array for a workflow — which is the only
             way to see from outside that a card convened a *crowd* rather than
             a seat, since the two are the same row in every other field. Its
             emptiness is meaningful too: a workflow may declare no phases. */
          phases: s.crew ? s.crew.phases : null,
        })),
        /* Carries the glass spot as well as the wall one — a card stuck to the
           pane and a card that was merely never pinned both have `pinned:
           false`, so the pair is the only thing that tells them apart. */
        placement: h.studio.placements[c.id] ?? null,
      })),
      images: h.board.images.map((i) => ({
        id: i.id,
        path: i.path,
        x: i.x,
        y: i.y,
        w: i.w,
        h: i.h,
        rotation: i.rotation,
        z: i.z,
        glass: spotOf(i),
        selected: h.studio.isPicked("image", i.id),
      })),
      /* The instruments, and whether anything is actually sampling for them.
         `sampling` is reported apart from the widget count for the same reason
         the ambience's `drawing` is: a meter on the wall with a dead sampler
         and one with a live one look identical from outside. */
      widgets: h.widgets.items.map((w) => ({
        id: w.id,
        kind: w.kind,
        variant: variantOf(w),
        config: { ...w.config },
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        glass: spotOf(w),
        selected: h.studio.isPicked("widget", w.id),
      })),
      /* What can be taken back, and what it is called. */
      undo: undoSnapshot(h),
      pomodoro: pomodoroSnapshot(h),
      meter: {
        watchers: h.meter.watchers,
        sampling: !!h.meter.latest,
        at: h.meter.latest?.at ?? null,
        scope: h.meter.latest?.scope ?? null,
        procs: h.meter.latest?.procs.length ?? 0,
        fault: h.meter.fault,
      },
      /* How far the running workflows have got, and whether anything is still
         reading their journals. `watchers` is apart from the readings for
         `meter.sampling`'s reason twice over: a crowd on the wall with a stopped
         poller draws its last count and looks identical from outside, and a
         watcher with no reading is the honest first seconds of a run. It is also
         the only way to see from a test that the poller *stopped* — a workflow
         that settled and left its directory being read every four seconds
         forever is the leak this shape exists to make visible. */
      crowds: {
        watchers: crowds.watchers,
        runs: Object.entries(crowds.seen).map(([toolId, p]) => ({
          toolId,
          out: p.out,
          back: p.back,
        })),
        fault: crowds.fault,
      },
      /* Whether a newer Volery is out and how far taking it has got. Visible
         from a test because the whole feature is otherwise invisible: it draws
         nothing on a wall that is up to date, which is the ordinary case and is
         also exactly what a check that silently failed looks like. `fault` is
         reported here and drawn nowhere — an app that complained in its own
         chrome about being unable to reach GitHub would be nagging about its
         plumbing. */
      update: {
        stage: releases.stage,
        version: releases.offer?.version ?? null,
        fault: releases.fault,
      },
      /* What has been spent, and whether anything is reading it. `watchers` is
         apart from the widget count for the reason `meter.sampling` is: a usage
         widget on the wall with a stopped reader and one with a live reader look
         identical from outside, and only one of them is telling the truth.
         Both windows are reported at both measures, since which one a widget
         happens to be showing is not the whole of what the ledger knows. */
      ledger: ledgerSnapshot(h),
      /* What Azure DevOps is saying, and whether anything is asking it. The two
         halves fail apart, so they are reported apart — see `devopsSnapshot`. */
      azdo: devopsSnapshot(h),
      /* What the wall is doing when nobody is asking it anything.
         `canvas` and `drawing` are reported apart on purpose: one is whether the
         backdrop is on the page at all, the other whether anything in the
         profile would paint. A canvas with a dead frame loop and a canvas
         clearing sixty times a second look identical from outside. */
      ambience: {
        activeId: h.ambience.activeId,
        active: h.ambience.active?.name ?? null,
        canvas: !!document.querySelector("canvas.backdrop"),
        drawing: living(h.ambience.active),
        profiles: h.ambience.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          layers: p.layers.map((l) => ({
            id: l.id,
            kind: l.kind,
            on: l.on,
            opacity: l.opacity,
            params: { ...l.params },
          })),
        })),
      },
      /* What each territory offers, and how its last press of each verb went.
         Reported off the same `chipsFor` the wall draws from, so a test cannot
         pass against a vocabulary the chips never had. */
      actions: h.skein.projects.map((p) => ({
        root: p.root_path,
        facts: h.actions.facts[p.root_path] ?? null,
        status: h.actions.status[p.root_path] ?? null,
        chips: h.actions.chipsFor(p.root_path),
        runs: h.actions.recent(p.root_path).map((r) => ({
          id: r.id,
          action: r.action,
          state: r.state,
          pct: r.pct,
          note: r.note,
          logLines: r.log.length,
          lastLog: r.log.length ? clip(r.log[r.log.length - 1], 160) : null,
        })),
      })),
      groups: h.skein.groups.map((g) => ({
        id: g.group.id,
        label: g.group.label,
        projectId: g.group.project_id,
        running: g.running,
        overall: g.overall,
        health: { ...g.health },
        logLines: g.log.length,
        lastLog: g.log.length ? clip(g.log[g.log.length - 1].line, 160) : null,
      })),
      /* What the dock is offering for the draft as it stands, so a test can see
         the palette without reading the DOM. Empty for every draft that is not
         a bare slash-name — including `/commit`, which is the agent's command
         and is not Skein's to intercept. */
      commands: h.commands().map((c) => c.name),
      choices: h.choices(),
      targets: h.targets().map((c) => c.id),
      waiting: h.waiting().map((c) => c.id),
      clashing: h.clashing(),
      blocked: h.skein.blocked.map((c) => c.id),
      /* One studio should hold one set of subscriptions. If these climb across
         an edit, a superseded generation is still listening — and still acting,
         which is how one `result` event became two `turn` rows. */
      listeners: {
        skein: h.skein.listenerCount,
        attention: h.attention.listenerCount,
        actions: h.actions.listenerCount,
        shell: h.shell.listenerCount,
        bang: h.bang.listenerCount,
      },
      /* The panel and the session are two facts, and the whole shape of this
         thing is that closing one does not end the other. The flat fields are
         the *active* shell — the one the panel is showing — so a test written
         when there was one shell still reads what it read.

         `sessions` is the second half, and it is why this cannot be inferred:
         there is one shell per project now, and a shell running a build in a
         project nobody is looking at is invisible in every other reading here.
         `key` is the project root, which is also the id Rust holds it under. */
      shell: {
        open: h.shell.open,
        active: h.shell.activeKey,
        live: h.shell.live,
        busy: h.shell.busy,
        program: h.shell.program,
        cwd: h.shell.cwd,
        where: h.shell.where,
        lines: h.shell.lines.length,
        sessions: h.shell.sessions.map((session) => ({
          key: session.key,
          live: session.live,
          busy: session.busy,
          cwd: session.cwd,
          lines: session.lines.length,
        })),
      },
      /* The panel and the chord in progress are reported apart, the way the
         shell's panel and session are: a half-typed leader is a state the app
         is in with nothing on screen but a caption, and from outside it is
         otherwise invisible. */
      finder: {
        open: h.finder.open,
        mode: h.finder.mode,
        root: h.finder.root,
        query: h.finder.query,
        pending: h.finder.pending,
        at: h.finder.at,
        rows: h.finder.rows.length,
        files: h.finder.files.length,
        hits: h.finder.hits.length,
        literal: h.finder.literal,
        busy: h.finder.busy,
        /* Which file the viewer is on, or null for the list — the one step
           whose whole content is that it happened. */
        sheet: h.finder.sheet?.path ?? null,
        sheetLine: h.finder.sheetLine,
        rendered: h.finder.rendered,
        raw: h.finder.raw,
        fault: h.finder.fault,
      },
      attention: {
        windowFocused: h.attention.focused,
        chime: h.attention.chime,
        /* Reported apart from `chime`, which says only whether a card's sound is
           permitted: an alarm rings regardless, and a bell that never rang is
           otherwise invisible from outside — nothing in the DOM records a
           sound. Same argument as `meter.sampling`. */
        sounded: [...h.attention.sounded],
        items: h.attention.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          detail: clip(i.detail, 120),
          waitedSeconds: i.waitedSeconds,
        })),
      },
      /* What is actually on screen, as opposed to what state says. A card in
         the model but not in the DOM is a rendering bug the model can't see. */
      dom: {
        cardNodes: [...document.querySelectorAll<HTMLElement>("[data-conv]")].map((n) => {
          const r = n.getBoundingClientRect();
          const card = n.querySelector<HTMLElement>(".card");
          return {
            id: n.dataset.conv!,
            tier: card?.dataset.st ?? null,
            dormant: card?.hasAttribute("data-dormant") ?? null,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        }),
        imageNodes: document.querySelectorAll("[data-image]").length,
        seatNodes: document.querySelectorAll("[data-seat]").length,
        transcriptOpen: !!document.querySelector(".side"),
        askOpen: !!document.querySelector(".ask"),
        /* A drag on the wall must be a gesture, never a text selection. That
           distinction is invisible to a synthetic pointer — only a real one
           makes Chromium start selecting — so the count is reported here rather
           than asserted anywhere in the app. */
        selectionChars: (window.getSelection()?.toString() ?? "").length,
        /* Where the keyboard is pointed. Typing on the wall is supposed to move
           it into the dock's field, and "the draft changed" alone would not
           show that focus went with it. */
        focusedTag: document.activeElement?.tagName ?? null,
      },
      errors: [...this.#errors],
    };
  }

  /* ── the vocabulary ──────────────────────────────────────────────────── */

  #table(): Record<string, Handler> {
    const h = this.#host;

    /** Emit an event the way Rust emits it, then let the UI settle. Going
     *  through Tauri rather than calling `ingest` directly is the whole point:
     *  the listener under test is the one the supervisor talks to. */
    const asRust = async (name: string, payload: unknown) => {
      await emit(name, payload);
      await settle();
    };

    return {
      /* ── reading ── */

      ops: () => ({ ops: Object.keys(this.#ops).sort() }),

      snapshot: () => this.#snapshot(),

      /** One card, in full — including its whole transcript.
       *
       *  `history` is reported apart from `lines` because that is how the card
       *  holds it: one comes off the file, the other off the wire, and a test
       *  that could not tell them apart could not see the scrollback appear. */
      card: (op) => {
        const c = this.#card(op);
        return {
          card: {
            ...this.#snapshot().cards.find((x) => x.id === c.id),
            /* `state` is reported only when a line has one, so a settled
               transcript reads exactly as it did before this existed — and an
               optimistic echo that never got claimed is visible from outside. */
            lines: c.lines.map((l) => ({
              kind: l.kind,
              text: clip(l.text, 400),
              ...(l.state ? { state: l.state } : {}),
            })),
            historyState: c.historyState,
            historyPartial: c.historyPartial,
            history: c.history.map((l) => ({ kind: l.kind, text: clip(l.text, 400) })),
          },
        };
      },

      /** Query the rendered page. Text, geometry, and computed styles, because
       *  "is the ring amber" is a question about paint, not about state. */
      dom: (op) => {
        const sel = String(op.selector ?? "");
        if (!sel) throw new Error("dom needs a selector");
        const nodes = [...document.querySelectorAll<HTMLElement>(sel)];
        const wanted: string[] = Array.isArray(op.styles) ? op.styles.map(String) : [];
        const read = (n: HTMLElement) => {
          const r = n.getBoundingClientRect();
          const cs = wanted.length ? getComputedStyle(n) : null;
          return {
            tag: n.tagName.toLowerCase(),
            classes: n.className?.toString() ?? "",
            text: clip((n.textContent ?? "").trim().replace(/\s+/g, " "), 240),
            data: { ...n.dataset },
            disabled: (n as HTMLButtonElement).disabled ?? null,
            visible: r.width > 0 && r.height > 0,
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              cx: Math.round(r.x + r.width / 2),
              cy: Math.round(r.y + r.height / 2),
            },
            styles: cs
              ? Object.fromEntries(wanted.map((p) => [p, cs.getPropertyValue(p).trim()]))
              : undefined,
          };
        };
        return { count: nodes.length, nodes: nodes.slice(0, Number(op.limit ?? 25)).map(read) };
      },

      /** Poll the snapshot until a dotted path matches. Saves a caller from a
       *  sleep-and-hope loop over HTTP. */
      wait: async (op) => {
        const path = String(op.path ?? "");
        if (!path) throw new Error("wait needs a path, e.g. cards.0.tier");
        const deadline = Date.now() + Number(op.timeoutMs ?? 15000);
        const at = (o: any) =>
          path.split(".").reduce((v, k) => (v == null ? v : v[k]), o as any);
        const matches = (v: unknown) =>
          "equals" in op ? JSON.stringify(v) === JSON.stringify(op.equals) : !!v;

        let last: unknown;
        for (;;) {
          last = at(this.#snapshot());
          if (matches(last)) return { path, value: plain(last), waitedMs: 0 };
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${path} to be ${JSON.stringify(op.equals ?? "truthy")}; ` +
                `it is ${JSON.stringify(last)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      },

      /** Is the peek window actually up? The only question about attention that
       *  state can't answer, because showing it is a side effect. */
      peek: async () => {
        const { Window } = await import("@tauri-apps/api/window");
        const w = await Window.getByLabel("peek");
        return {
          exists: !!w,
          visible: (await w?.isVisible().catch(() => false)) ?? false,
          position: w ? await w.outerPosition().catch(() => null) : null,
          windowFocused: h.attention.focused,
          items: h.attention.items.length,
        };
      },

      "errors.clear": () => {
        this.#errors = [];
        return {};
      },

      /* ── the same gestures a hand makes ── */

      focus: (op) => {
        const c = this.#card(op);
        h.setFocused(c.id);
        h.studio.selectOnly(c.id);
        return { id: c.id };
      },

      select: (op) => {
        h.studio.pickCards(this.#cards(op).map((c) => c.id));
        return { selected: [...h.studio.selected] };
      },

      /** The whole selection, across all four kinds, as `kind:id` strings.
       *
       *  `select` above is cards and cards only, which is what it has always
       *  been and what the dock's gathering means. This is the handle a hand now
       *  has and that one cannot express: a card, its project, a widget and a
       *  reference held together, which is what a box-select produces and
       *  therefore what a test about one has to be able to arrange without
       *  drawing a rectangle. It replaces the selection rather than adding, the
       *  way a plain press does; `image.select`/`widget.select` carry the `add`
       *  modifier for the other half.
       *
       *  Anything unparseable is refused rather than dropped: a typo'd kind that
       *  silently selected nothing would make a passing assertion about an empty
       *  selection mean nothing at all. */
      pick: (op) => {
        const raw = Array.isArray(op.picks) ? (op.picks as unknown[]) : [];
        const kinds = new Set<Kind>(["card", "image", "widget", "region"]);
        const picks = raw.map((r) => {
          const [kind, ...rest] = String(r).split(":");
          if (!kinds.has(kind as Kind) || !rest.length) {
            throw new Error(`"${r}" is not a kind:id — one of ${[...kinds].join(", ")}`);
          }
          return { kind: kind as Kind, id: rest.join(":") };
        });
        h.studio.pick(picks);
        return {
          picks: h.studio.picks.map((p) => `${p.kind}:${p.id}`),
          selected: [...h.studio.selected],
        };
      },

      /** The gathering *and* the focus, because on the wall they are one
       *  gesture: a click on bare ground, or Escape. */
      deselect: () => {
        h.deselect();
        return { focusedId: h.focusedId(), selected: [...h.studio.selected] };
      },

      /** Press a project's chip — the same call the wall's own button makes,
       *  including its rule that a second press cancels a running one. */
      action: async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        const id = String(op.id ?? op.action ?? "");
        if (!root || !id) throw new Error("action needs a project and an id");
        /* Not awaited: a build takes minutes, and the op that starts it must
           not hold the socket for all of them. `wait` on the snapshot is how a
           test follows it — the same way it follows a turn. */
        void h.actions.run(root, id);
        await settle();
        return { root, id, state: h.actions.runOf(root, id)?.state ?? null };
      },

      "action.cancel": async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        const id = String(op.id ?? op.action ?? "");
        await h.actions.cancel(root, id);
        return { root, id, state: h.actions.runOf(root, id)?.state ?? null };
      },

      /** Re-read what every project is doing, rather than waiting out the poll. */
      "action.poll": async () => {
        await h.actions.poll();
        return { status: plain(h.actions.status) };
      },

      /** Fetch every git project now, rather than waiting out its five minutes.
       *  The fetch itself is fire-and-forget, so the status this answers with is
       *  from before it landed — `action.poll` again to see what it found. */
      "action.fetch": async () => {
        await h.actions.fetchNow();
        return { status: plain(h.actions.status) };
      },

      /** Press a torn territory's badge. Spawns a real agent and sends it a real
       *  prompt — the same seam the chip goes through, and the same cost. */
      "action.resolve": async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        if (!root) throw new Error("action.resolve needs a project");
        const before = new Set(h.skein.convs.map((c) => c.id));
        await h.resolveConflicts(root);
        await settle();
        const fresh = h.skein.convs.find((c) => !before.has(c.id));
        return { root, id: fresh?.id ?? null };
      },

      /** Open a conversation in a folder — the same call the folder picker and
       *  a dropped directory both land on. */
      open: async (op) => {
        const dir = String(op.dir ?? op.cwd ?? "");
        if (!dir) throw new Error("open needs a dir");
        const before = new Set(h.skein.convs.map((c) => c.id));
        await h.openIn(dir, op.worktree ? String(op.worktree) : undefined);
        await settle();
        const fresh = h.skein.convs.find((c) => !before.has(c.id));
        return { id: fresh?.id ?? null, fault: h.skein.fault };
      },

      /** Open a card with no project — the ground menu's own arm.
       *
       *  Takes nothing: a chat card has no directory to be given, which is the
       *  whole of what makes it one. The `kind` comes back so a test can see it
       *  got the card it asked for, since nothing else in the snapshot differs. */
      chat: async () => {
        const before = new Set(h.skein.convs.map((c) => c.id));
        await h.openChat();
        await settle();
        const fresh = h.skein.convs.find((c) => !before.has(c.id));
        return {
          id: fresh?.id ?? null,
          kind: fresh?.kind ?? null,
          cwd: fresh?.cwd ?? null,
          fault: h.skein.fault,
        };
      },

      /** Speak to one card. Wakes it if dormant, exactly as the dock does. */
      send: async (op) => {
        const c = this.#card(op);
        const text = String(op.text ?? "");
        if (!text) throw new Error("send needs text");
        await h.skein.send(c, text);
        return { id: c.id, dormant: c.dormant, fault: h.skein.fault };
      },

      /** Run the rousing queue — the same pass `load` starts behind the painted
       *  wall, not a copy of it, so what a test drives is what a launch does.
       *
       *  It returns when the queue has finished, which for a wall of restored
       *  cards is `ROUSE_GAP_MS` apiece. Note this one *can* spend money: an
       *  interrupted card is sent a resume prompt. `wall.test.ts` only ever has
       *  `.scratch/` cards, and none of them is interrupted. */
      rouse: async () => {
        const woken = await h.skein.rouse();
        return {
          woken,
          dormant: h.skein.convs.filter((c) => c.dormant).map((c) => c.id),
          interrupted: h.skein.convs.filter((c) => c.interrupted).map((c) => c.id),
          fault: h.skein.fault,
        };
      },

      /** End the turn a card is in the middle of, the way Escape and the dock's
       *  button both do. The card is still there afterwards — that is the half
       *  worth asserting, so the process is reported back alongside the tier. */
      stop: async (op) => {
        const c = this.#card(op);
        await h.skein.stop(c);
        return {
          id: c.id,
          working: c.working,
          dormant: c.dormant,
          tier: c.tier,
          ending: c.ending,
          fault: h.skein.fault,
        };
      },

      broadcast: async (op) => {
        const cards = this.#cards(op);
        const text = String(op.text ?? "");
        if (!text) throw new Error("broadcast needs text");
        await h.skein.broadcast(cards, text);
        return { ids: cards.map((c) => c.id), fault: h.skein.fault };
      },

      /* ── the roster ────────────────────────────────────────────────────
       *
       * Driving `relay.rs`'s two tools by hand, so a test can exercise a send
       * without an agent taking a turn to make one — the same seam `rouse` and
       * `broadcast` are driven through, and for the same reason: the op calls
       * the shipped path rather than a copy of it.
       */

      /** What one card can see of the others. `scope` defaults to its project,
       *  exactly as the tool does. */
      roster: async (op) => {
        const card = this.#card(op);
        return {
          roster: await invoke("relay_roster", {
            id: card.id,
            scope: op.scope === undefined ? null : String(op.scope),
          }),
        };
      },

      /** Send a message from one card to another. `to` takes everything the
       *  tool does — a handle, a title, a list, or `project` / `skein`.
       *
       *  Reports the receipt verbatim, which is the whole of what the sending
       *  agent is told: a refusal is a normal answer here, not an error, so a
       *  test asserts on the same sentence a model would read. */
      relay: async (op) => {
        const card = this.#card(op);
        const message = String(op.message ?? op.text ?? "");
        if (!message) throw new Error("relay needs a message");
        const receipt = await invoke<string>("relay_send", {
          id: card.id,
          to: (op.to ?? "project") as unknown,
          message,
        });
        await settle();
        return {
          receipt,
          flights: h.skein.flights.all.map((f) => ({ from: f.from, to: f.to })),
        };
      },

      /* ── the billboard ─────────────────────────────────────────────────
       *
       * Driving `board.rs` by hand, the same seam the roster ops use. `board`
       * reads it as a card would — through the tool, so a test sees the words a
       * model sees — where `notices` reads the rows the wall draws. Both, and
       * not one, because the two readings are what must not drift: the tool's
       * says STALE in prose and the wall's says `stale: true`, off one number.
       */

      board: async (op) => {
        const card = this.#card(op);
        return {
          reading: await invoke<string>("relay_board", {
            id: card.id,
            scope: op.scope === undefined ? null : String(op.scope),
          }),
        };
      },

      /** Every notice as the wall has it, which is what a billboard widget
       *  draws. Refreshed first, since a control-surface read must not depend
       *  on a widget being hung up to have attached the reader. */
      notices: async () => {
        await h.skein.board.refresh(true);
        return {
          notices: h.skein.board.notices.map((n) => ({
            id: n.id,
            scope: n.scope,
            from: n.from,
            subject: n.subject,
            body: n.body,
            paths: n.paths,
            stale: n.stale,
          })),
          fault: h.skein.board.fault,
        };
      },

      /** Put one up. With `id`, as that card; without, as you — which are two
       *  genuinely different notices, since only yours has no author to sweep
       *  away when a card closes. */
      post: async (op) => {
        const subject = String(op.subject ?? "");
        if (!subject) throw new Error("post needs a subject");
        const body = String(op.body ?? op.text ?? subject);
        const paths = Array.isArray(op.paths) ? op.paths.map(String) : [];
        if (op.id === undefined) {
          await h.skein.board.post(subject, body, paths, null);
          return { by: "you", fault: h.skein.board.fault };
        }
        const card = this.#card(op);
        const receipt = await invoke<string>("relay_post", {
          id: card.id,
          subject,
          body,
          paths,
          scope: op.scope === undefined ? null : String(op.scope),
        });
        await h.skein.board.refresh(true);
        return { by: card.id, receipt };
      },

      /** Take one down — by notice id as you, or by subject as the card that
       *  posted it, which is the path an agent actually walks. */
      unpost: async (op) => {
        if (op.id !== undefined && op.subject === undefined && op.card === undefined) {
          await h.skein.board.unpost(String(op.id));
          return { by: "you", fault: h.skein.board.fault };
        }
        const card = this.#card(op, op.card !== undefined ? "card" : "id");
        const receipt = await invoke<string>("relay_unpost", {
          id: card.id,
          subject: op.subject === undefined ? null : String(op.subject),
          all: op.all === true,
        });
        await h.skein.board.refresh(true);
        return { by: card.id, receipt };
      },

      /** Pretend a card just wrote to a file, so the serve-on-first-contact
       *  path can be exercised without an agent taking a turn to edit one. */
      touch: async (op) => {
        const card = this.#card(op);
        const path = String(op.path ?? "");
        if (!path) throw new Error("touch needs a path");
        await invoke("board_touch", { conversationId: card.id, path });
        await settle();
        return {
          flights: h.skein.flights.all.map((f) => ({ from: f.from, to: f.to })),
          lines: h.skein.convs
            .find((c) => c.id === card.id)
            ?.lines.filter((l) => l.kind === "relay")
            .map((l) => l.note),
        };
      },

      /** Type into the dock without sending — for testing the target readout,
       *  the Ctrl+Enter gate, and the placeholder. */
      type: (op) => {
        h.setDraft(String(op.text ?? ""));
        return { draft: h.draft() };
      },

      /** Submit the draft through the dock's own path, including its rule that
       *  a multi-card send needs the modifier. */
      submit: async (op) => {
        await h.submit(!!op.broadcast);
        return { draft: h.draft(), targets: h.targets().map((c) => c.id) };
      },

      /** Put a card by, or pick it back up — the card menu's own arm.
       *
       *  `aside` defaults to true, so `aside card=x` is the gesture and
       *  `aside card=x aside=false` is the way back. The tier is returned
       *  because it is the whole mechanism: everything that treats a card as
       *  waiting reads it, so a card that went aside without going `rest` has
       *  not actually been set aside. */
      aside: async (op) => {
        const c = this.#card(op);
        h.skein.setAside(c, op.aside === undefined ? true : !!op.aside);
        return { id: c.id, aside: c.aside, tier: c.tier, fault: h.skein.fault };
      },

      /** Call a card something else, the way `/rename` does.
       *
       *  `namedByHand` comes back beside the title because the title alone
       *  cannot show what the gesture bought: a card renamed and a card that
       *  happens to have that title read identically, and the whole of the
       *  change is that the next settling turn will not take the name back. */
      rename: async (op) => {
        const c = this.#card(op);
        await h.skein.rename(c, String(op.name ?? ""));
        return {
          id: c.id,
          title: c.title,
          namedByHand: c.namedByHand,
          fault: h.skein.fault,
        };
      },

      /** Start a card over. The card keeps its id and its place; only the
       *  session behind it changes, which is what `sessionId` in the snapshot
       *  is there to show. */
      clear: async (op) => {
        const c = this.#card(op);
        const before = c.sessionId;
        await h.skein.clear(c);
        return {
          id: c.id,
          was: before,
          sessionId: c.sessionId,
          dormant: c.dormant,
          fault: h.skein.fault,
        };
      },

      close: async (op) => {
        const c = this.#card(op);
        await h.skein.close(c);
        return { closed: c.id, remaining: h.skein.convs.length };
      },

      /* Answer one question, or the whole sheet.
       *
       * `text` fills in the question currently being asked and steps on, which
       * is the gesture the panel offers; several answers in order fill several.
       * Nothing is sent until the sheet is complete — the same rule the panel
       * follows, and the reason this op cannot just forward a string. `rest`
       * leaves whatever is unanswered to the agent, so a test that only cares
       * about the first decision does not have to invent answers to the rest. */
      answer: async (op) => {
        const c = this.#card(op);
        const ask = c.pendingAsk;
        if (!ask) throw new Error(`${c.title} is not waiting on an answer`);

        const given: string[] = Array.isArray(op.answers)
          ? op.answers.map(String)
          : op.text !== undefined || op.answer !== undefined
            ? [String(op.text ?? op.answer)]
            : [];

        /* `at` writes one nominated question rather than the one in hand — the
           revision the review is for, and equally the out-of-order answer the
           panel allows. There is no order to enforce: `composeAnswer` pairs
           each answer with its own question by index and emits them as asked,
           so the sheet reads the same however it was filled. */
        if (typeof op.at === "number") {
          const i = Math.trunc(op.at);
          if (i < 0 || i >= ask.questions.length) {
            throw new Error(`no question ${i} in this ask`);
          }
          if (given.length !== 1) {
            throw new Error("`at` names one question, so it takes one answer");
          }
          ask.answers[i] = given[0];
        } else {
          for (const text of given) {
            const i = stepAt(ask.answers);
            ask.answers[i] = text;
            if (isComplete(ask.answers)) break;
          }
        }
        if (op.rest === true) {
          for (let i = 0; i < ask.answers.length; i++) {
            if (ask.answers[i] === null) ask.answers[i] = NO_PREFERENCE;
          }
        }

        /* A single question sends on the answer, as the panel does. Several
           stop at the review — reading the third is often what changes your
           mind about the first, so the send is its own act — and this op has to
           stop there too, or it would be testing a path no hand can take. */
        const alone = ask.questions.length === 1;
        const ready = isComplete(ask.answers);
        if (!ready || (!alone && op.send !== true)) {
          return {
            id: c.id,
            sent: false,
            reviewing: ready && !alone,
            step: stepAt(ask.answers),
            answers: [...ask.answers],
          };
        }
        const text = composeAnswer(ask.questions, ask.answers);
        await h.skein.answerAsk(c);
        return { id: c.id, sent: true, text };
      },

      /* ── standing in for the supervisor ──────────────────────────────
       *
       * These emit the events Rust emits. Nothing here fakes card state; it
       * feeds the wire and lets the fold do its work. That makes a whole
       * committee, a context ring at 91%, or a crashed turn reachable in a
       * millisecond and for no tokens. */

      feed: async (op) => {
        const c = this.#card(op);
        const events: unknown[] = Array.isArray(op.events)
          ? op.events
          : op.event !== undefined
            ? [op.event]
            : [];
        if (!events.length) throw new Error("feed needs `event` or `events`");
        for (const event of events) {
          await asRust("conv:event", { id: c.id, event });
        }
        return { id: c.id, fed: events.length, tier: c.tier, activity: c.activity };
      },

      stderr: async (op) => {
        const c = this.#card(op);
        await asRust("conv:stderr", { id: c.id, line: String(op.line ?? "") });
        return { id: c.id };
      },

      exit: async (op) => {
        const c = this.#card(op);
        const code = op.code === null ? null : Number(op.code ?? 0);
        await asRust("conv:exit", { id: c.id, code });
        return { id: c.id, dormant: c.dormant, tier: c.tier };
      },

      /** Park a question on a card without an agent to ask it. The real MCP
       *  path is reachable too — /health reports `mcpPort`, and POSTing a
       *  `tools/call` to /mcp/<id> there exercises the whole round trip. */
      ask: async (op) => {
        const c = this.#card(op);
        const askId = op.askId ? String(op.askId) : crypto.randomUUID();
        await asRust("ask:opened", {
          conversation_id: c.id,
          ask_id: askId,
          question: String(op.question ?? "Which way?"),
          options: Array.isArray(op.options)
            ? op.options.map((o: any) =>
                typeof o === "string" ? { label: o } : { label: String(o.label), detail: o.detail ?? null },
              )
            : [],
        });
        return { id: c.id, askId, tier: c.tier };
      },

      "server.log": async (op) => {
        await asRust("server:log", {
          group_id: String(op.groupId ?? ""),
          label: String(op.label ?? ""),
          line: String(op.line ?? ""),
          stderr: !!op.stderr,
        });
        return {};
      },

      "server.state": async (op) => {
        await asRust("server:state", {
          group_id: String(op.groupId ?? ""),
          label: String(op.label ?? ""),
          state: String(op.state ?? "up"),
        });
        return {};
      },

      "server.toggle": async (op) => {
        const g = h.skein.groups.find(
          (g) => g.group.id === op.groupId || g.group.label === op.label,
        );
        if (!g) throw new Error("no such server group");
        await (g.running ? h.skein.stopGroup(g) : h.skein.startGroup(g));
        return { id: g.group.id, running: g.running };
      },

      /* ── the wall itself ── */

      /** A dropped file, delivered the way the OS delivers it — including the
       *  physical-pixel payload, so the DPI conversion is under test too. */
      drop: async (op) => {
        const paths: string[] = Array.isArray(op.paths)
          ? op.paths.map(String)
          : op.path
            ? [String(op.path)]
            : [];
        if (!paths.length) throw new Error("drop needs `path` or `paths`");
        const dpr = window.devicePixelRatio || 1;
        /* The caller thinks in CSS pixels; the OS payload is physical. */
        const x = Number(op.x ?? window.innerWidth / 2);
        const y = Number(op.y ?? window.innerHeight / 2);
        await emit("tauri://drag-drop", {
          paths,
          position: { x: Math.round(x * dpr), y: Math.round(y * dpr) },
        });
        /* A drop imports files and may spawn a process; give it real time. */
        await new Promise((r) => setTimeout(r, Number(op.settleMs ?? 900)));
        await settle();
        return {
          images: h.board.images.length,
          cards: h.skein.convs.length,
          fault: h.skein.fault ?? h.board.fault,
        };
      },

      "image.add": async (op) => {
        const at = h.canvas()?.toCanvas(Number(op.x ?? 300), Number(op.y ?? 300)) ?? {
          x: Number(op.x ?? 300),
          y: Number(op.y ?? 300),
        };
        const img = await h.board.add(String(op.path ?? ""), at.x, at.y);
        return { id: img?.id ?? null, fault: h.board.fault };
      },

      /** A pasted image, delivered as a real `paste` event over a real cursor.
       *
       *  It cannot reach the OS clipboard from out here — nothing in a webview
       *  can put a bitmap on it — so the bytes are carried in a `DataTransfer`
       *  the way Chromium carries them. Everything after that is the app's own:
       *  the pointermove goes to the same window listener the mouse uses, and
       *  the paste to the handler in `App`, which writes the file through Rust
       *  and places it. What this cannot see is whether WebView2 hands a
       *  screenshot over as a file in the first place; that needs a hand on
       *  ctrl+V.
       *
       *  Default bytes are a 1×1 PNG — small, and *valid*, so a wrong answer
       *  from the decoder shows up as a placement rather than hiding behind the
       *  fallback size. */
      "image.paste": async (op) => {
        const b64 = String(
          op.data ??
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        );
        const raw = atob(b64);
        const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const file = new File([bytes], "pasted.png", {
          type: String(op.type ?? "image/png"),
        });

        const surface = document.querySelector(".surface");
        if (!surface) throw new Error("no wall to paste onto");
        const box = surface.getBoundingClientRect();
        const x = box.left + Number(op.x ?? box.width / 2);
        const y = box.top + Number(op.y ?? box.height / 2);

        /* Where the cursor is *is* the argument here, so it has to arrive the
           way a cursor does rather than be handed to the paste. */
        surface.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: x,
            clientY: y,
            bubbles: true,
          }),
        );

        const dt = new DataTransfer();
        dt.items.add(file);
        /* Both on the clipboard at once is what copying from a web page gives,
           and is the only way to ask whether the draft still gets its text. */
        if (op.text !== undefined) dt.setData("text/plain", String(op.text));

        const before = h.board.images.length;
        (op.into === "draft"
          ? (document.querySelector(".field textarea") ?? window)
          : window
        ).dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          }),
        );

        await new Promise((r) => setTimeout(r, Number(op.settleMs ?? 400)));
        await settle();
        const img = h.board.images[h.board.images.length - 1];
        return {
          added: h.board.images.length - before,
          id: img?.id ?? null,
          at: img ? { x: img.x, y: img.y, w: img.w, h: img.h } : null,
          fault: h.board.fault,
        };
      },

      "image.update": (op) => {
        const id = String(op.id ?? h.studio.pickedOf("image")[0] ?? "");
        const patch: Record<string, number> = {};
        for (const k of ["x", "y", "w", "h", "rotation", "z"]) {
          if (op[k] !== undefined) patch[k] = Number(op[k]);
        }
        h.board.update(id, patch);
        return { id, patch };
      },

      "image.remove": async (op) => {
        const id = String(op.id ?? h.studio.pickedOf("image")[0] ?? "");
        await h.board.remove(id);
        return { id, remaining: h.board.images.length };
      },

      /** Pick an image, or let go of every image with no id.
       *
       *  `add` is the modifier a hand holds: without it this replaces the whole
       *  selection, which is what a plain press does, and with it the image
       *  joins whatever is already held — the shift-click. Same op on the
       *  widget side, so the two read alike. */
      "image.select": (op) => {
        if (!op.id) h.studio.dropKind("image");
        else if (op.add) h.studio.pick(pressed(h.studio.picks, { kind: "image", id: String(op.id) }, { shift: true }));
        else h.studio.only("image", String(op.id));
        return { selected: h.studio.pickedOf("image") };
      },

      /* ── the instruments ──────────────────────────────────────────────
       *
       * The same four verbs an image has, because they are the same kind of
       * thing to the wall. `widget.set` goes through `Widgets.set`, which is
       * what the menu calls — an op that wrote the config object itself could
       * pass a variant the catalogue has never heard of and prove nothing. */
      "widget.add": async (op) => {
        const at = h.canvas()?.toCanvas(Number(op.x ?? 300), Number(op.y ?? 300)) ?? {
          x: Number(op.x ?? 300),
          y: Number(op.y ?? 300),
        };
        const w = await h.widgets.add(String(op.kind ?? "clock") as WidgetKind, at.x, at.y);
        return { id: w?.id ?? null, kind: w?.kind ?? null, fault: h.widgets.fault };
      },

      "widget.set": (op) => {
        const id = String(op.id ?? h.studio.pickedOf("widget")[0] ?? "");
        const key = String(op.key ?? "variant");
        h.widgets.set(id, key, op.value as string | number | boolean);
        const w = h.widgets.items.find((w) => w.id === id);
        if (!w) throw new Error(`no widget ${id}`);
        /* What it *became*, not what was asked for: the config is normalised on
           the way back off disk, so an unknown value has to be visible here. */
        return { id, config: { ...w.config } };
      },

      "widget.update": (op) => {
        const id = String(op.id ?? h.studio.pickedOf("widget")[0] ?? "");
        const patch: Record<string, number> = {};
        for (const k of ["x", "y", "w", "h", "z"]) {
          if (op[k] !== undefined) patch[k] = Number(op[k]);
        }
        h.widgets.update(id, patch);
        return { id, patch };
      },

      "widget.remove": async (op) => {
        const id = String(op.id ?? h.studio.pickedOf("widget")[0] ?? "");
        await h.widgets.remove(id);
        return { id, remaining: h.widgets.items.length };
      },

      "widget.select": (op) => {
        if (!op.id) h.studio.dropKind("widget");
        else if (op.add) h.studio.pick(pressed(h.studio.picks, { kind: "widget", id: String(op.id) }, { shift: true }));
        else h.studio.only("widget", String(op.id));
        return { selected: h.studio.pickedOf("widget") };
      },

      /* ── taking it back ───────────────────────────────────────────────
       *
       * The same two calls the keyboard and the ground's menu make, so the op
       * cannot drift from the gesture. What each answers is the label of the act
       * it applied, or null for "there was nothing that way" — which is the one
       * distinction a snapshot of depths cannot make on its own, since a press
       * with nothing to undo and a press that undid something trivial both leave
       * the stack where it was. */
      undo: async () => {
        const undid = h.undo.back();
        /* Settled before answering, as every op that changes the wall is: a step
           writes several records and the claim worth testing is what is *drawn*
           afterwards. */
        await settle();
        return { undid, ...undoSnapshot(h) };
      },
      redo: async () => {
        const redid = h.undo.forward();
        await settle();
        return { redid, ...undoSnapshot(h) };
      },

      /** Start from a clean history. For a test that has arranged the wall and
       *  wants the gestures it is *about* to make to be the only ones on the
       *  stack. */
      "undo.clear": () => {
        h.undo.clear();
        return undoSnapshot(h);
      },

      /** Drive a timer without pressing its buttons. The face's own gestures go
       *  through the same `Widgets.update` this does, so nothing here is a
       *  parallel path — it is the seam the buttons sit on. */
      "timer.set": (op) => {
        const id = String(op.id ?? h.studio.pickedOf("widget")[0] ?? "");
        const w = h.widgets.items.find((w) => w.id === id);
        if (!w) throw new Error(`no widget ${id}`);
        const patch: Record<string, number> = {};
        for (const k of ["since", "banked", "sinceOff", "bankedOff"]) {
          if (op[k] !== undefined) patch[k] = Number(op[k]);
        }
        h.widgets.update(id, { config: { ...w.config, ...patch } });
        const after = h.widgets.items.find((w) => w.id === id)!;
        const now = Date.now();
        return {
          id,
          run: runIn(after),
          limit: limitIn(after),
          /* The reading, not just the numbers: a `rung` that never arrives is
             the failure this op exists to catch, and it is invisible in the
             two epochs alone. */
          standing: standing(runIn(after), limitIn(after), now),
          elapsed: elapsed(runIn(after), now),
        };
      },

      /** What has been spent. `read` takes a fresh reading rather than waiting
       *  for the next beat — the same `#tick` the timer drives, so this is the
       *  seam and not a path beside it. It reads nothing unless a usage widget
       *  is up, which is the property the widget's `attach` buys and an op must
       *  not be able to take away. */
      usage: async (op) => {
        if (op.read) await h.ledger.refresh();
        return ledgerSnapshot(h);
      },

      /** What Azure DevOps is saying. `read` takes both readings now rather than
       *  waiting out a twenty-second and a sixty-second beat — the same
       *  `refresh` the timers sit on, so this is the seam and not a path beside
       *  it, and like `usage` it asks nothing unless a widget is attached.
       *
       *  `rows` is the one op here that hands back the list itself, and only
       *  when asked for: it is the only way to assert that the taxonomy reached
       *  the face — a snapshot counting three failed runs cannot show *which*
       *  three, and the tier of a specific run is precisely what
       *  `test/azdo.test.ts` proves in the pure layer and a wall test has to
       *  confirm end to end. Capped, since a busy org has hundreds. */
      azdo: async (op) => {
        if (op.read) await h.devops.refresh();
        const snap = devopsSnapshot(h);
        if (!op.rows) return snap;
        const cap = Math.max(1, Math.min(100, Number(op.cap ?? 20)));
        return {
          ...snap,
          runRows: h.devops.runs.rows.slice(0, cap).map((r) => ({
            id: r.id,
            project: r.project,
            pipeline: r.pipeline,
            status: r.status,
            result: r.result,
            tier: tierOf(r),
            branch: shortRef(r.branch),
            mine: r.mine,
            url: r.url,
          })),
          reviewRows: h.devops.reviews.rows.slice(0, cap).map((r) => ({
            id: r.id,
            repo: r.repo,
            number: r.number,
            title: r.title,
            tier: reviewTierOf(r),
            said: reviewSaid(r),
            needsMe: needsMe(r),
            mine: r.mine,
            url: r.url,
          })),
        };
      },

      /** The cycle. `op.do` is the gesture — begin, push, finish, pause,
       *  resume — and the answer is always the whole posture, because a break
       *  that was pushed back and one that was never due look identical from
       *  outside if you only report the phase. */
      pomodoro: (op) => {
        const p = h.pomodoro;
        const verb = op.do ? String(op.do) : "";
        if (verb === "begin") p.begin();
        else if (verb === "push") p.push();
        else if (verb === "finish") p.finish();
        else if (verb === "pause") p.pause();
        else if (verb === "resume") p.resume();
        else if (verb === "tick") p.tick(Number(op.at ?? Date.now()));
        else if (verb === "set") p.set(String(op.key) as "cadence" | "per", String(op.value));
        else if (verb) throw new Error(`no such gesture: ${verb}`);
        return pomodoroSnapshot(h);
      },

      /** Take a project off the wall — the same call the territory's menu
       *  makes. The suite needs it: now that a territory outlives its last
       *  card, a test run would leave one behind every time. */
      forget: async (op) => {
        const cwd = String(op.cwd ?? "");
        if (!cwd) throw new Error("forget needs a cwd");
        const gone = await h.skein.forgetProject(cwd);
        return { cwd, gone, fault: h.skein.fault };
      },

      /** Pin a card at a canvas position — the same two calls a drag makes when
       *  it lets go, so a wall can be arranged without lending out the mouse.
       *  Not a parallel path: `real.drag` ends in exactly these. */
      pin: async (op) => {
        const c = this.#card(op);
        const x = Number(op.x ?? 0);
        const y = Number(op.y ?? 0);
        const was = h.studio.placements[c.id] ? { ...h.studio.placements[c.id] } : null;
        h.studio.pin(c.id, x, y);
        /* The placement is read back out rather than rebuilt from x/y: it also
           carries where the card is drawn on the glass, and `pin` deliberately
           leaves that alone. */
        await h.skein.savePlacement(c.id, h.studio.placements[c.id]);
        /* And recorded, because a drag's release records — an op that moved a
           card the undo stack had never heard of would be the parallel path
           `control.md`'s first rule is about. */
        h.undo.did("moving a card", [
          {
            at: "placement",
            id: c.id,
            was,
            now: { ...h.studio.placements[c.id] },
          },
        ]);
        await settle();
        return { id: c.id, placement: h.studio.placements[c.id] ?? null };
      },

      /** Stick a card, an image, a widget or a territory to the glass, or put
       *  it back on the wall.
       *
       *  `at` moves something already on the pane; without it this is the menu
       *  item, which lands the thing where it already looked to be. Either way
       *  it goes through `Canvas.toggleGlass` / the same setters a drag ends in
       *  — a second path would be a second answer to where things land.
       *
       *  It returns the wall position as well as the glass one, because the
       *  claim worth testing is that the first did not change. */
      glass: async (op) => {
        const kinds = ["card", "image", "widget", "region"] as const;
        const kind = kinds.find((k) => k === String(op.kind ?? "card"));
        if (!kind) throw new Error(`no such thing to stick: ${op.kind}`);
        /* A card is nominated the way every card op nominates one (id, title or
           the focused one); everything else has only an id, and a territory's
           id is its root path. */
        const id =
          kind === "card"
            ? this.#card(op).id
            : String(op.id ?? op.cwd ?? op.root ?? "");
        if (!id) throw new Error("glass needs an id");

        const at =
          op.x === undefined || op.y === undefined
            ? undefined
            : { x: Number(op.x), y: Number(op.y) };

        if (at) {
          /* Moving it: the same writes the drag's release makes. An image and a
             widget record themselves from inside `update`; the other two are
             recorded here, where the drag's release would have. */
          if (kind === "card") {
            const was = h.studio.placements[id] ? { ...h.studio.placements[id] } : null;
            h.studio.stick(id, at);
            await h.skein.savePlacement(id, h.studio.placements[id]);
            h.undo.did("moving a card on the glass", [
              { at: "placement", id, was, now: { ...h.studio.placements[id] } },
            ]);
          } else if (kind === "region") {
            const p = h.skein.projects.find((q) => q.root_path === id);
            h.skein.stickProject(id, at);
            if (p) {
              h.undo.did("moving a territory on the glass", [
                {
                  at: "territory",
                  id,
                  was: {
                    x: p.x ?? null,
                    y: p.y ?? null,
                    glassX: p.glassX ?? null,
                    glassY: p.glassY ?? null,
                  },
                  now: {
                    x: p.x ?? null,
                    y: p.y ?? null,
                    glassX: at.x,
                    glassY: at.y,
                  },
                },
              ]);
            }
          } else if (kind === "image") h.board.update(id, { glassX: at.x, glassY: at.y });
          else h.widgets.update(id, { glassX: at.x, glassY: at.y });
        } else {
          h.canvas()?.toggleGlass(kind, id);
        }
        await settle();

        if (kind === "card") {
          const p = h.studio.placements[id] ?? null;
          return { kind, id, glass: spotOf(p), placement: p };
        }
        if (kind === "region") {
          const p = h.skein.projects.find((p) => p.root_path === id) ?? null;
          return {
            kind,
            id,
            glass: spotOf(p),
            at: p ? { x: p.x, y: p.y } : null,
          };
        }
        const it =
          kind === "image"
            ? h.board.images.find((i) => i.id === id)
            : h.widgets.items.find((w) => w.id === id);
        return {
          kind,
          id,
          glass: spotOf(it),
          at: it ? { x: it.x, y: it.y } : null,
        };
      },

      /** Put a territory somewhere — the same call the drag makes when it lets
       *  go. Omitting x and y hands it back to the grid, as the territory menu's
       *  "tidy back onto the grid" does. The cards it carries are moved by the
       *  drag itself, so this op moves the territory and nothing else. */
      place: async (op) => {
        const cwd = String(op.cwd ?? op.root ?? "");
        if (!cwd) throw new Error("place needs a cwd");
        const x = op.x === undefined || op.x === null ? null : Number(op.x);
        const y = op.y === undefined || op.y === null ? null : Number(op.y);
        /* Observed rather than predicted, exactly as the menu's own handler does
           it: handing a territory back to the grid runs `#settlePlaces`, which
           can move one nobody named. See `stands`/`shifted` in `App.svelte`. */
        const before = standsOf(h.skein.projects);
        h.skein.placeProject(cwd, x, y);
        h.undo.did(
          x === null || y === null ? "settling a territory back in" : "moving a territory",
          shifted(before, standsOf(h.skein.projects)),
        );
        await settle();
        return {
          cwd,
          project: this.#snapshot().projects.find((p) => p.root === cwd) ?? null,
        };
      },

      /* ── the wall's ambience ──────────────────────────────────────────
       *
       * The same calls the panel's own controls make, which is the whole rule
       * here: no op reaches past the class into the renderer. A test can only
       * ask for what a hand could ask for, and then read `snapshot.ambience`
       * for what the wall says it is doing. */

      /** Show a profile — by id, by name, or `null` for a bare wall. */
      "ambience.use": async (op) => {
        const want = op.id ?? op.profile ?? op.name ?? null;
        let id: string | null = null;
        if (want !== null && want !== undefined) {
          const s = String(want);
          const hit =
            h.ambience.profiles.find((p) => p.id === s) ??
            h.ambience.profiles.find((p) => p.name === s) ??
            h.ambience.profiles.find((p) => p.name.toLowerCase().includes(s.toLowerCase()));
          if (!hit) throw new Error(`no ambience profile matching "${s}"`);
          id = hit.id;
        }
        await h.ambience.use(id);
        return { activeId: h.ambience.activeId, drawing: living(h.ambience.active) };
      },

      "ambience.profile": async (op) => {
        const what = String(op.do ?? "create");
        if (what === "create") {
          const p = await h.ambience.create(String(op.name ?? "new profile"));
          return { id: p.id, name: p.name };
        }
        if (what === "duplicate") {
          const p = await h.ambience.duplicate(String(op.id ?? h.ambience.activeId ?? ""));
          return { id: p?.id ?? null, name: p?.name ?? null };
        }
        if (what === "rename") {
          const id = String(op.id ?? h.ambience.activeId ?? "");
          h.ambience.rename(id, String(op.name ?? ""));
          return { id, name: h.ambience.profiles.find((p) => p.id === id)?.name ?? null };
        }
        if (what === "delete") {
          const id = String(op.id ?? h.ambience.activeId ?? "");
          await h.ambience.destroy(id);
          return { deleted: id, remaining: h.ambience.profiles.length };
        }
        throw new Error(`ambience.profile: no such thing as "${what}"`);
      },

      /** Add, remove, reorder, switch off, or turn one knob of a layer on the
       *  profile that is showing. */
      "ambience.layer": (op) => {
        const a = h.ambience;
        const active = a.active;
        if (!active) throw new Error("no ambience profile is showing");
        const what = String(op.do ?? "add");

        if (what === "add") {
          a.addLayer(String(op.kind ?? "swirls") as EffectKind);
          return { layers: active.layers.map((l) => ({ id: l.id, kind: l.kind })) };
        }
        /* By id, or by kind — a test reads better as `{"layer": "leaves"}` than
           as a uuid it had to fish out of a snapshot first. */
        const want = String(op.id ?? op.layer ?? op.kind ?? "");
        const l =
          active.layers.find((x) => x.id === want) ??
          active.layers.find((x) => x.kind === want);
        if (!l) throw new Error(`no layer matching "${want}"`);

        if (what === "remove") a.removeLayer(l.id);
        else if (what === "move") a.moveLayer(l.id, Number(op.by ?? 1));
        else if (what === "reset") a.resetLayer(l.id);
        else if (what === "set") {
          const patch: { on?: boolean; opacity?: number } = {};
          if (op.on !== undefined) patch.on = !!op.on;
          if (op.opacity !== undefined) patch.opacity = Number(op.opacity);
          a.setLayer(l.id, patch);
        } else if (what === "param") {
          const key = String(op.key ?? "");
          if (!key) throw new Error("ambience.layer param needs a key");
          a.setParam(l.id, key, Number(op.value));
        } else throw new Error(`ambience.layer: no such thing as "${what}"`);

        return {
          layers: a.active?.layers.map((x) => ({
            id: x.id,
            kind: x.kind,
            on: x.on,
            opacity: x.opacity,
            params: { ...x.params },
          })),
        };
      },

      viewport: (op) => {
        if (op.x !== undefined) h.studio.x = Number(op.x);
        if (op.y !== undefined) h.studio.y = Number(op.y);
        if (op.scale !== undefined) h.studio.scale = Number(op.scale);
        return { viewport: { x: h.studio.x, y: h.studio.y, scale: h.studio.scale, lod: h.studio.lod } };
      },

      fit: () => {
        h.canvas()?.fitAll();
        return { viewport: { x: h.studio.x, y: h.studio.y, scale: h.studio.scale, lod: h.studio.lod } };
      },

      /** Drive the floating shell.
       *
       *  `do` is the gesture: `show`, `select`, `hide`, `send`, `stop`, `close`,
       *  `clear`. Every one of them is the function the panel's own control
       *  calls, so an op cannot pass where a click would fail.
       *
       *  `cwd` on `show` and `select` names *which project's* shell, since
       *  there is one per project — the same key the wall picks by itself when
       *  you touch a card, and the one thing a test cannot do by touching a
       *  card because it wants to name the project rather than find a card in
       *  it. Everything else acts on whichever shell is showing.
       *
       *  Returns the tail of the scrollback as well as the state, because what
       *  a shell did is only ever visible in what it printed — and `text` is
       *  stripped of its colour on the way out, the way everything that *reads*
       *  a line in this app is (see actions.md). */
      shell: async (op) => {
        const what = String(op.do ?? "show");
        if (what === "show") await h.shell.show(String(op.cwd ?? h.shellCwd()));
        else if (what === "select") await h.shell.select(String(op.cwd ?? h.shellCwd()));
        else if (what === "hide") h.shell.hide();
        else if (what === "send") await h.shell.send(String(op.text ?? ""));
        else if (what === "stop") await h.shell.stop();
        else if (what === "close") await h.shell.close();
        else if (what === "clear") h.shell.clear();
        else throw new Error(`no such shell gesture: ${what}`);

        const tail = Number(op.tail ?? 20);
        return {
          shell: {
            open: h.shell.open,
            active: h.shell.activeKey,
            live: h.shell.live,
            busy: h.shell.busy,
            program: h.shell.program,
            cwd: h.shell.cwd,
            others: h.shell.others.map((o) => o.key),
            lines: h.shell.lines.slice(-tail).map((l) => ({
              kind: l.kind,
              failed: !!l.failed,
              text: stripAnsi(l.text),
            })),
          },
        };
      },

      /** Drive the finder.
       *
       *  `do` is the gesture: `show`, `hide`, `type`, `step`, `pick`, `look`,
       *  `back`, `swap`, `raw`. Every one of them is the function the panel's
       *  own keyboard calls, so an op cannot pass where a keypress would fail.
       *
       *  There is deliberately no op for *the chord itself* — that is what the
       *  `key` op is for, pressing space then f then f at the window the way a
       *  hand does, which is the only thing that can see the leader losing a
       *  race with the bare-printable branch below it in `onGlobalKey`.
       *
       *  Returns the head of the list as well as the state, because what a
       *  search did is only ever visible in what it found. */
      find: async (op) => {
        const what = String(op.do ?? "show");
        if (what === "show") {
          await h.finder.show(
            String(op.mode ?? "files") === "grep" ? "grep" : "files",
            String(op.cwd ?? h.shellCwd()),
          );
        } else if (what === "hide") h.finder.hide();
        else if (what === "type") h.finder.type(String(op.text ?? ""));
        else if (what === "step") h.finder.step(Number(op.by ?? 1));
        else if (what === "pick") h.finder.pick(Number(op.at ?? 0));
        else if (what === "look") await h.finder.look();
        else if (what === "back") h.finder.back();
        else if (what === "swap") await h.finder.swap();
        else if (what === "raw") h.finder.toggleRaw();
        else throw new Error(`no such finder gesture: ${what}`);

        const head = Number(op.head ?? 20);
        return {
          finder: {
            open: h.finder.open,
            mode: h.finder.mode,
            root: h.finder.root,
            query: h.finder.query,
            at: h.finder.at,
            count: h.finder.rows.length,
            files: h.finder.files.length,
            literal: h.finder.literal,
            sheet: h.finder.sheet?.path ?? null,
            sheetLine: h.finder.sheetLine,
            rendered: h.finder.rendered,
            fault: h.finder.fault,
            rows: h.finder.rows.slice(0, head).map((r) => ({
              path: r.path,
              line: r.line,
              text: r.text === null ? null : clip(r.text, 120),
            })),
          },
        };
      },

      flag: (op) => {
        const name = String(op.name ?? "");
        if (op.value !== undefined) h.setFlag(name, !!op.value);
        return { flags: h.flags() };
      },

      /* ── input ── */

      /** A wheel over the wall, at a point in the surface.
       *
       *  Non-passive by necessity on the app's side, so this dispatches a real
       *  `WheelEvent` at the element the listener is bound to and lets the same
       *  handler decide what it means. `shift` is what separates panning from
       *  zooming — see the note in Canvas.svelte.
       *
       *  `target: "panel"` aims it at the transcript instead, which is the
       *  other surface with a hand-bound non-passive wheel listener and which
       *  reads it the other way round: ctrl resizes the reading, bare scrolls.
       *  Same op rather than a second one, because it is the same gesture at a
       *  different address — and it goes through the real listener rather than
       *  setting the size, so a `--read` that never reached the column would
       *  still show up as a failure. */
      wheel: async (op) => {
        const panel = op.target === "panel";
        const el = document.querySelector<HTMLElement>(panel ? ".detail" : ".surface");
        if (!el) {
          throw new Error(
            panel ? "no transcript panel to wheel over" : "no wall surface to scroll over",
          );
        }
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: Number(op.dx ?? 0),
            deltaY: Number(op.dy ?? 0),
            clientX: r.left + Number(op.x ?? r.width / 2),
            clientY: r.top + Number(op.y ?? r.height / 2),
            shiftKey: !!op.shift,
            ctrlKey: !!op.ctrl,
            bubbles: true,
            cancelable: true,
          }),
        );
        await settle();
        const s = h.studio;
        return {
          viewport: { x: s.x, y: s.y, scale: s.scale, lod: s.lod },
          reading: readingScale(s.readScale),
        };
      },

      /** Right-click something, and report what the wall offered instead of
       *  Chromium's menu.
       *
       *  `defaultPrevented` is the interesting half: it is the only way from
       *  out here to see that the native menu was suppressed, since the menu
       *  itself is drawn by the OS and is invisible to the DOM. An empty
       *  `items` with `defaultPrevented` true is the correct answer for a
       *  target with nothing to offer — see menu.ts. */
      menu: async (op) => {
        const el = this.#el(op);
        const r = el.getBoundingClientRect();
        const ev = new MouseEvent("contextmenu", {
          clientX: op.x !== undefined ? Number(op.x) : r.x + r.width / 2,
          clientY: op.y !== undefined ? Number(op.y) : r.y + r.height / 2,
          button: 2,
          buttons: 2,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        await settle();
        return {
          defaultPrevented: ev.defaultPrevented,
          open: !!document.querySelector(".menu"),
          items: [...document.querySelectorAll<HTMLElement>("[data-menu]")].map(
            (n) => n.dataset.menu,
          ),
        };
      },

      /** A synthetic click. Proves the handlers are connected; proves nothing
       *  about how Chromium routes a real one. Use real.click for that. */
      click: (op) => {
        const el = this.#el(op);
        el.click();
        return { clicked: el.className?.toString() ?? el.tagName };
      },

      key: (op) => {
        const target: EventTarget =
          op.selector ? this.#el(op) : (document.querySelector("textarea") ?? window);
        const ev = new KeyboardEvent("keydown", {
          key: String(op.key ?? "Enter"),
          ctrlKey: !!op.ctrl,
          shiftKey: !!op.shift,
          metaKey: !!op.meta,
          /* Alt is a modifier this wall binds — it is the whole of Alt+I — so
             a surface that could not press it could not test the one binding
             that fires while you are typing. */
          altKey: !!op.alt,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(ev);
        return { key: String(op.key ?? "Enter"), defaultPrevented: ev.defaultPrevented };
      },

      /** The real cursor, the real button. Aim by selector or by CSS point. */
      "real.click": async (op) => {
        const p = op.selector
          ? (() => {
              const r = this.#el(op).getBoundingClientRect();
              if (r.width === 0 || r.height === 0) {
                throw new Error(`"${op.selector}" has no box — nothing to aim at`);
              }
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          : { x: Number(op.x), y: Number(op.y) };
        await invoke("control_real_click", { x: p.x, y: p.y, restore: !!op.restore });
        await settle();
        return { at: { x: Math.round(p.x), y: Math.round(p.y) } };
      },

      /** Hover, then aim: a control that only exists on hover needs the mouse
       *  parked over its parent before its box is real. */
      "real.hover": async (op) => {
        const r = this.#el(op).getBoundingClientRect();
        await invoke("control_real_click", {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          restore: false,
        });
        await settle();
        return { at: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } };
      },

      "real.drag": async (op) => {
        const p = op.selector
          ? (() => {
              const r = this.#el(op).getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          : { x: Number(op.x), y: Number(op.y) };
        await invoke("control_real_drag", {
          x: p.x,
          y: p.y,
          dx: Number(op.dx ?? 0),
          dy: Number(op.dy ?? 0),
          steps: Number(op.steps ?? 12),
          /** The left button draws a selection band; "right" and "middle" both
           *  pan, and the right one must not leave a menu behind. All three are
           *  reachable, because a pan that only a hand can make is a claim no
           *  run can check — see `control.md`. */
          button: op.button ? String(op.button) : null,
        });
        await settle();
        return { from: { x: Math.round(p.x), y: Math.round(p.y) }, dx: op.dx ?? 0, dy: op.dy ?? 0 };
      },
    };
  }
}
