/* The seam between what was said and the wall it was said to.
 *
 * `voice.ts` is the whole of the thinking and none of the reaching: it resolves
 * referents against a `Wall` it is handed and produces a `Plan` of steps against
 * a `Hands` it is given. This is the thing that builds both out of the running
 * app, and it is the only file in the subsystem that knows Tauri exists.
 *
 * Named `.svelte.ts` though it declares no rune, because that is the honest
 * label rather than a technicality: every line of it reads live `$state`
 * through the host, so it can only run in the app, and the purity boundary is a
 * statement about what can be tested rather than about which functions were
 * called. The logic worth testing is already next door.
 *
 * ## What it takes, and why that one
 *
 * A `ControlHost` — the same handles `App.svelte` builds for the control
 * surface, which its own comment describes as *"the handles a pair of hands
 * would have"*. A voice is a pair of hands, so this is not an analogy.
 *
 * But it is **not** a client of the control surface, and the distinction is the
 * point. That surface is off unless `SKEIN_CONTROL=1`, binds loopback, writes a
 * token into `%APPDATA%` and lights a chip in the title bar; arming it in every
 * install so voice had somewhere to POST would be a listening socket nobody
 * asked for. The *host* is built unconditionally and is just an object. So voice
 * reaches the same in-process seams the surface does, directly, which is
 * `control.md`'s first rule kept rather than worked around: drive the app's own
 * seams, never a path beside them.
 *
 * ## The file lists, and why they are a cache
 *
 * `Finder.root` is a single `$state("")` and `list()` replaces `files` wholesale
 * for that one root — so the list to hand belongs to whichever territory the
 * finder was last opened on, which is almost never the one you just named.
 * Prefetching every territory is a ripgrep apiece, stale before it is used;
 * fetching inside the parse would make the fast rung async, which is the one
 * thing it must not be. So `wallFor` fetches exactly the territories the
 * sentence mentions, once each, and keeps them. About 100ms the first time a
 * territory is named and nothing after that.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen as onEvent } from "@tauri-apps/api/event";
import type { ControlHost } from "./control.svelte";
import { Listeners } from "./listeners";
import {
  addressedCards,
  addressIn,
  answeredIn,
  carry,
  hear,
  messageTo,
  spoke,
  territoriesIn,
  type Hands,
  type Outcome,
  type Plan,
  type VoiceCard,
  type VoiceTerritory,
  type Wall,
} from "./voice";
import { narrow, replyIn, stewardPrompt, understand } from "./steward";

/** Which rung answered. Carried on every plan, because the two cost different
 *  things and only one of them can be wrong in an interesting way. */
export type Rung = "grammar" | "steward";

/** What became of an utterance.
 *
 *  **`escalate` is gone, and its absence is the feature.** It used to be a
 *  distinct outcome meaning *the grammar could not account for the whole of it*,
 *  kept apart from a failure on the stated grounds that the day the steward
 *  arrived, every call site would otherwise have to be re-read to find out which
 *  one it was handling. That day is this one: escalation is now a step in the
 *  middle of `say()` rather than a thing that comes back out of it, and every
 *  outcome below is an answer. */
export type Heard =
  /** Understood, and not run: at least one step is not something you may do to
   *  the wall without being asked. */
  | { kind: "confirm"; plan: Plan; from: Rung }
  | { kind: "carried"; plan: Plan; outcome: Outcome; from: Rung }
  /** The steward could not tell which thing was meant, and says what it would
   *  need to know. A question *to you*, and the only one here you can answer by
   *  saying the sentence again with a name in it. */
  | { kind: "asked"; question: string }
  /** A fair question about the wall, which is simply not a plan — *"what is the
   *  ring doing?"*. Nothing on this path answers one, and saying so is better
   *  than declining it as though it had been a bad instruction. */
  | { kind: "question"; question: string }
  /** A remark rather than an instruction. Acting on one is the worst thing
   *  available here, so this is the outcome to be glad of. */
  | { kind: "declined"; why: string }
  /** Nothing usable came of it: the steward could not be reached, or answered
   *  something `understand` refused. Never a plan, never partly one. */
  | { kind: "unusable"; why: string };

/** One utterance as `src-tauri/src/voice.rs` hands it over.
 *
 *  Named apart from `Heard` above, which is what *became* of an utterance. The
 *  two are one word in English and two different things here, and conflating
 *  them is how a transcript ends up where a plan was wanted. */
export type Transcript = {
  text: string;
  confidence: "high" | "medium" | "low" | "rejected";
  language: string;
  ms: number;
};

/** How long Alt+V arms the ear for, in milliseconds.
 *
 *  Fifteen seconds: long enough to gather a sentence, short enough that a key
 *  pressed and forgotten does not leave a microphone quietly taking dictation
 *  for the wall. */
const ATTENDING_MS = 15_000;

/** How long a plan may wait and still be confirmed *out loud*, in milliseconds.
 *
 *  Twenty seconds: the length of an exchange. Past that, a yes in the room is
 *  far more likely to be about something else than about a question the wall
 *  asked, and the thing on the other side of it is a prompt delivered to an
 *  agent. Enter is unbounded — see `#askedAt`. */
const SPOKEN_YES_MS = 20_000;

export class Voicing {
  #host: ControlHost;

  /* ── what the wall is doing about your voice ──────────────────────────────
   *
   * Four fields rather than one status enum, because they are not exclusive:
   * a plan can be waiting for a yes *and* the transcript that produced it still
   * worth reading, and the bar that draws them wants both at once.
   *
   * **The one thing this must never be is quiet.** A voice layer that mishears
   * and then does nothing is indistinguishable from one that did not hear you,
   * and the second is the failure people give up over — so `said` holds the
   * transcript whatever came of it, and `says` holds the reason when nothing
   * did. Neither clears on a timer: nothing here schedules anything, and the
   * next utterance or an Escape is what moves it on.
   */

  /** A recognition is open. Also the guard against starting a second one — the
   *  recogniser owns the microphone for the duration and two would fight. */
  listening = $state(false);
  /** The last transcript, kept even when nothing came of it. */
  said = $state("");
  /** A plan understood but not carried out, because at least one step is not
   *  something you may do to the wall without being asked. */
  pending = $state<Plan | null>(null);
  /** What the wall says back, or `""` when it worked — see `spoke()`, which
   *  argues that success saying nothing is a decision rather than an omission. */
  says = $state("");
  /** The words so far, while you are still talking.
   *
   *  **This is what tells you the microphone is working.** A recognition is up
   *  to five seconds of initial silence plus however long you speak, and a bar
   *  that says only *listening…* for all of it cannot be told apart from one
   *  listening to nothing — which is the single most demoralising way for a
   *  voice feature to fail, because there is no way to tell a dead microphone
   *  from a slow one.
   *
   *  A hypothesis is a guess in progress and is routinely wrong until the final
   *  result replaces it, so **nothing acts on this** — it is drawn and thrown
   *  away. It is not a setting: the off position of that knob is the bug. */
  partial = $state("");
  /** How many parses are out. `thinking` is the reading of it.
   *
   *  A count rather than a flag because the open ear dispatches utterances as
   *  they settle and does not wait for the last one: two escalations can be in
   *  flight at once, and with a boolean the *first* to come back cleared the bar
   *  while the second was still out — the "went quiet with a stopwatch on it"
   *  failure this class is otherwise careful about. */
  #parses = $state(0);

  /** The steward has a sentence and has not answered yet.
   *
   *  Its own field rather than a widening of `listening`, which is
   *  `turns.md`'s distinction one layer down: the microphone being open and a
   *  parse being out are two different facts, they have different shapes, and
   *  the bar draws them differently because one of them you can still talk
   *  into. A parse is seconds — 9.3 of them at the median — so a bar that said
   *  nothing across it would be the "misheard and went quiet" failure with a
   *  stopwatch on it. */
  get thinking(): boolean {
    return this.#parses > 0;
  }

  /** One project's file list per root, fetched once and kept.
   *
   *  Plain, not `$state`: nothing draws it, and a fetch landing must not repaint
   *  the wall. No timer runs here; the subscriptions the open ear needs are
   *  `#ears`, and `detach` is what releases them — `App.svelte`'s `onDestroy`
   *  calls it, per the rule that anything holding a Tauri subscription needs
   *  releasing. */
  #files = new Map<string, string[]>();

  /** Which rung proposed the plan now waiting for a yes. Kept so `confirm` can
   *  say the same thing `report` would have. */
  #pendingFrom: Rung = "grammar";

  /** Which utterance the bar is currently about.
   *
   *  **A parse outlives the gesture that started it**, by up to a minute, and
   *  an answer that lands after you have pressed Escape must not quietly become
   *  a plan again — `pending` is armed by Enter from anywhere, so a stale one is
   *  a sentence you dismissed running later under a keystroke you meant for
   *  something else. Same shape as `aside.rs`'s generation: a number, bumped by
   *  whatever supersedes, and the late arrival checks whether it is still the
   *  one being waited for. */
  #gen = 0;

  /** When the plan now waiting was proposed, or 0.
   *
   *  **A spoken yes is bounded and a pressed one is not**, and that asymmetry is
   *  the whole reason this field exists. Enter is an act: you are at the
   *  keyboard, looking at the bar, and however long the plan has been up you
   *  meant that key. A *word* is not — the ear hears the room, "sure" and "go
   *  on" and "ok" are all a yes, and a plan with no expiry meant any of them,
   *  said by anyone, at any distance in time from the question, could put a
   *  prompt into a card spawned with `--dangerously-skip-permissions`.
   *
   *  A spoken **no** is deliberately not bounded: cancelling is never the
   *  dangerous direction, and a wall that refused to let go because you took too
   *  long to say so would be obeying a safety rule by ignoring you. */
  #askedAt = 0;

  constructor(host: ControlHost) {
    this.#host = host;
    /* Same shape as `Control`'s own constructor: the subscriptions are how this
       object hears about anything, so there is no state in which it is built and
       not listening. Released by `detach`. */
    void this.attach();
  }

  /* ── the wall listens ─────────────────────────────────────────────────────
   *
   * Design 3: no key at all. The microphone is simply open, and what decides
   * whether anything happens is whether you said the wall's name or a card's —
   * `addressIn` next door, which is where the whole of that reasoning lives.
   *
   * The shape here is the supervisor's, one subsystem over: a stream in Rust,
   * events on the ordinary pipeline, a fold into `$state`. Nothing polls, and
   * the ear's own truth lives in Rust — `#sync` asks once at startup because a
   * window that reloaded has no memory of what it asked for, and after that
   * every change arrives as an event.
   */

  /** The ear is open: the microphone is on and the room is being transcribed. */
  open = $state(false);
  /** The last thing heard that was not spoken to the wall.
   *
   *  Drawn, faintly, and acted on never. **This is the only evidence an open
   *  microphone is working**, and without it a gate doing its job is
   *  indistinguishable from a dead device — which is the failure people give up
   *  over, and the one this subsystem is organised around not producing. It is
   *  the room's own words, on the user's own screen, and it goes no further:
   *  nothing reads this field but the bar. */
  overheard = $state("");

  /** When Alt+V was last pressed while the ear was open, or 0.
   *
   *  **A key that means "this next one is for you"**, so a sentence can be
   *  spoken to the wall without saying its name — which is what you want when
   *  you are sitting in front of it, and is also the only thing left for that
   *  key to mean once the microphone is already open. It expires, because an
   *  armed microphone you have forgotten about is exactly what addressing exists
   *  to prevent. */
  #attending = 0;

  /** Everything this holds on the wire, released with the object. */
  #ears = new Listeners();

  /** Ask Rust what it is doing, once, and keep up with it after that.
   *
   *  Called by the app at startup. The subscriptions are registered before the
   *  question is asked, so an ear that opens between the two is not missed. */
  async attach(): Promise<void> {
    this.#ears.keep(
      onEvent<{ open: boolean; failed: string | null }>("voice:ear", (e) => {
        this.open = e.payload.open;
        if (!e.payload.open) {
          this.partial = "";
          this.overheard = "";
        }
        /* A microphone that stopped listening says so. The rest of this class
           is careful never to go quiet on a failure and this is the one failure
           that can happen while nobody is even talking. */
        if (e.payload.failed) this.says = e.payload.failed;
      }),
    );
    this.#ears.keep(
      onEvent<string>("voice:hypothesis", (e) => {
        /* Only while the ear owns the microphone — a one-shot `listen()` runs
           its own subscription for the duration of the gesture, and two of them
           writing the same field would have the bar flickering between a guess
           and the same guess. */
        if (this.open && !this.listening) this.partial = e.payload;
      }),
    );
    this.#ears.keep(onEvent<string>("voice:utterance", (e) => void this.heard(e.payload)));
    try {
      this.open = await invoke<boolean>("voice_ear");
    } catch {
      /* An app that cannot answer this is an app with no ear, which is what the
         field already says. */
    }
  }

  /** Let go of the wire. The ear itself is Rust's and outlives the window. */
  detach(): void {
    this.#ears.detach();
  }

  /** Open the ear, or say why it could not be opened. */
  async listenOn(): Promise<void> {
    if (this.open) return;
    /* And not over a one-shot that is still running: Rust refuses this anyway —
       the device is one device and `Ear::claim` is where that is decided — but
       refusing it here means the reason arrives as the bar not changing rather
       than as an error about a microphone you did not know you were holding. */
    if (this.listening) {
      this.says = "still listening to the last one — try again in a moment";
      return;
    }
    this.says = "";
    try {
      await invoke("voice_open");
    } catch (err) {
      this.says = err instanceof Error ? err.message : String(err);
    }
  }

  /** Close it. The state follows the event rather than this call, because the
   *  thread coming down is the thing that makes it true. */
  async listenOff(): Promise<void> {
    this.#attending = 0;
    try {
      await invoke("voice_close");
    } catch (err) {
      this.says = err instanceof Error ? err.message : String(err);
    }
  }

  async toggleEar(): Promise<void> {
    if (this.open) await this.listenOff();
    else await this.listenOn();
  }

  /** Take the next utterance as though it had been addressed to the wall. */
  attend(): void {
    this.#attending = Date.now();
    this.said = "";
    this.says = "go on — the next thing said is for the wall";
  }

  /** One utterance off the open ear.
   *
   *  The order of the three questions below is the design, and it is the order
   *  of how little each costs to be wrong about:
   *
   *  1. **Is this the answer to a question the wall just asked?** Heard without
   *     an address, because you are already in an exchange and nobody prefixes
   *     their own name to *yes*. Exact and whole, so only an actual yes or no
   *     is one.
   *  2. **Was it spoken to the wall at all?** If not it is forgotten here, and
   *     that is the whole of the privacy claim on this side: nothing leaves the
   *     machine either way, and nothing acts on what the room said to itself.
   *  3. **Then the ladder**, exactly as the key's own path runs it — grammar,
   *     then the message a card was addressed with, then the steward.
   */
  async heard(text: string): Promise<void> {
    this.partial = "";
    const attending = this.#attending > 0 && Date.now() - this.#attending < ATTENDING_MS;

    if (this.pending) {
      const answer = answeredIn(text);
      if (answer === "no") {
        this.#attending = 0;
        this.dismiss();
        /* After `dismiss`, which clears it — the bar says what it let go of, and
           this is the one branch where `said` was being written and then wiped
           one line later. */
        this.said = text;
        this.says = "let go";
        return;
      }
      if (answer === "yes") {
        this.said = text;
        this.#attending = 0;
        if (Date.now() - this.#askedAt < SPOKEN_YES_MS) {
          await this.confirm();
          return;
        }
        /* Too old to be an answer to *this*. Let go rather than leaving it
           armed for the next one, and say so — a plan that vanished without a
           word would be the going-quiet failure wearing a safety rule. */
        this.#forget();
        this.says = "that had been waiting too long for a spoken yes — say it again";
        return;
      }
    }

    const wall = await this.wallFor(text);
    const said = addressIn(text, wall);
    if (!said && !attending) {
      /* Not for us. Shown, never acted on — see `overheard`.
         **And it supersedes nothing**: the generation is claimed below this
         return, so a colleague saying "anyway, lunch?" cannot invalidate the
         sentence you spoke to the wall nine seconds ago and leave its answer
         with nowhere to land. Room chatter is inert or it is not a gate. */
      this.overheard = text;
      return;
    }
    const gen = ++this.#gen;
    this.#attending = 0;
    this.overheard = "";

    const to = said?.to ?? [];
    const cards = addressedCards(to);
    /* Attending, the whole sentence is the instruction; addressed, it is
       everything after the name. */
    const rest = said ? said.rest : text;
    this.said = text;
    /* Whatever was waiting is waiting no longer: this utterance was addressed
       to the wall, so it is the one the bar is about now. */
    this.#forget();
    if (!rest) {
      /* Somebody said a name and nothing else. Answered rather than ignored, so
         the wall visibly heard its own name. */
      this.says = "yes?";
      return;
    }

    const what = await this.#routed(cards, rest, text, wall, gen);
    if (gen === this.#gen) this.report(what);
  }

  /** The ladder, with whatever the address already settled.
   *
   *  **One addressed card becomes the referent the grammar falls back on**, so
   *  *"the ring, stop"* stops the ring rather than whatever happens to be in
   *  front — `hear` resolves a missing referent to the focused card, and for an
   *  addressed sentence the addressed card is what "this one" means.
   *
   *  **Several addressed cards skip the grammar entirely**, and that is the one
   *  asymmetry worth stating. The grammar has no way to take a plural referent
   *  it was not told about, so *"the ring and the auth work, stop"* would
   *  resolve `stop` against the *focused* card — a plan about a card nobody
   *  named. A message to both is the reading that cannot be wrong about who,
   *  and it is confirmed before it goes.
   *
   *  The steward is handed the **whole** utterance, address included, because a
   *  name at the front of a sentence is exactly what its prompt is built to
   *  resolve — and stripping it would take away the one thing that said who. */
  async #routed(
    cards: VoiceCard[],
    rest: string,
    whole: string,
    wall: Wall,
    gen: number,
  ): Promise<Heard> {
    if (cards.length < 2) {
      const seen = cards.length === 1 ? { ...wall, focusedId: cards[0].id } : wall;
      const plan = hear(rest, seen);
      if (plan) return await this.#answer(plan, "grammar", false, gen);
    }
    const message = messageTo(cards, rest, wall);
    if (message) return await this.#answer(message, "grammar", false, gen);
    return await this.#escalate(whole, wall, false, gen, rest);
  }

  /* ── the wall, as voice sees it ────────────────────────────────────────── */

  /** The wall right now, with whatever file lists are already to hand. */
  #snapshot(): Wall {
    const cards: VoiceCard[] = this.#host.skein.convs.map((c) => ({
      id: c.id,
      title: c.title,
      project: c.project,
      working: c.working,
    }));
    const territories: VoiceTerritory[] = this.#host.skein.projects.map((p) => ({
      /* `Project.name` is `dir_name(root_path)` — the folder, which is what a
         territory is called out loud. The two fields are kept apart anyway,
         since the day a territory can be labelled is the day the spoken name
         and the folder stop agreeing. */
      project: p.name,
      cwd: p.root_path,
      files: this.#files.get(p.root_path) ?? [],
    }));
    return { cards, territories, focusedId: this.#host.focusedId() };
  }

  /** One territory's files, fetched once.
   *
   *  A root that has gone away leaves an empty list rather than throwing: the
   *  consequence is that a file in it cannot be resolved, which is the same
   *  answer as a file that is not there, and it is not worth failing an
   *  utterance that may not have been about that territory at all. */
  async #list(cwd: string): Promise<void> {
    if (this.#files.has(cwd)) return;
    try {
      const out = await invoke<{ files: string[]; truncated: boolean }>("find_files", {
        root: cwd,
      });
      this.#files.set(cwd, out.files);
    } catch {
      this.#files.set(cwd, []);
    }
  }

  /** Forget the cached lists, so the next sentence sees the tree as it is now.
   *
   *  Nothing calls this on a clock. A file list going stale costs you a file
   *  that will not open by name until you say the territory again, which is a
   *  worse thing to *poll* for than to live with — see the three-pollers
   *  argument in `CLAUDE.md`. The gestures that plainly invalidate it (a branch
   *  changing under a territory, a card finishing a build) can call it. */
  forget(cwd?: string): void {
    if (cwd) this.#files.delete(cwd);
    else this.#files.clear();
  }

  /** The wall, with the file lists this particular sentence is going to need.
   *
   *  Two snapshots rather than one because the question is circular — which
   *  territories to fetch is read off the sentence *against* a wall — and a map
   *  over the cards and projects is cheap enough that resolving it by doing it
   *  twice is better than threading a half-built wall through. */
  async wallFor(utterance: string): Promise<Wall> {
    for (const t of territoriesIn(utterance, this.#snapshot())) await this.#list(t.cwd);
    return this.#snapshot();
  }

  /* ── the hands ─────────────────────────────────────────────────────────── */

  /** The same calls the control surface's ops make, and for the same reason
   *  they do: `focus` selects as well as focuses because that is what the wall's
   *  own gesture does, and a voice that focused without selecting would have
   *  invented a state no mouse can produce. */
  hands(): Hands {
    const h = this.#host;
    /** A card by id, or a throw — which is what turns a card closed between the
     *  parse and the run into `carry`'s `stopped`, naming the step. */
    const card = (id: string) => {
      const c = h.skein.convs.find((x) => x.id === id);
      if (!c) throw new Error(`no card ${id} any more`);
      return c;
    };
    return {
      focus: (id) => {
        const c = card(id);
        h.setFocused(c.id);
        h.studio.selectOnly(c.id);
      },
      select: (ids) => h.studio.pickCards(ids.map((i) => card(i).id)),
      deselect: () => h.deselect(),
      fit: () => {
        const canvas = h.canvas();
        /* Louder than a no-op on purpose. A plan that silently did not move the
           wall is the failure `spoke()` exists to be able to report. */
        if (!canvas) throw new Error("the wall is not drawn yet");
        canvas.fitAll();
      },
      stop: async (id) => {
        await h.skein.stop(card(id));
      },
      aside: (id, aside) => h.skein.setAside(card(id), aside),
      /* The card's own send, the one the dock calls — so a spoken message and a
         typed one are the same act, drawn the same way, echoed the same way, and
         a card that is dormant is woken by either. */
      send: async (id, text) => {
        await h.skein.send(card(id), text);
      },
      broadcast: async (ids, text) => {
        await h.skein.broadcast(ids.map(card), text);
      },
      open: async (cwd) => {
        await h.openIn(cwd);
      },
      lookAt: async (cwd, path) => {
        await h.finder.lookAt(cwd, path);
      },
    };
  }

  /* ── the whole path ────────────────────────────────────────────────────── */

  /** Understand a sentence and, if it may simply happen, do it.
   *
   *  **A plan that needs confirming is never carried out here**, whatever the
   *  caller intended, unless it says so. That gate is in this one function
   *  rather than in each of its callers, because the set of things it protects
   *  is `IMMEDIATE`'s complement — everything the wall can do that is not merely
   *  looking at it — and a caller that forgot would be a broadcast to a wall of
   *  cards spawned with `--dangerously-skip-permissions`. */
  /* `gen` defaults to *now*, which is right for the control surface — it drives
     one sentence at a time and nothing is in flight behind it — and wrong for
     anything that captured a generation before an await. `listen()` omitted it
     and the default was then evaluated after a recognition had been open for up
     to 35 seconds, quietly adopting whatever had superseded it: `#answer`'s
     check passed, the plan ran, and `listen`'s own check suppressed the report.
     The wall moves and says nothing, which is finding #3 rebuilt on the other
     path. **If you captured a generation, pass it.** */
  async say(utterance: string, confirmed = false, gen = this.#gen): Promise<Heard> {
    const wall = await this.wallFor(utterance);
    const plan = hear(utterance, wall);
    /* The ladder, and the rule that decides the rung: the grammar answers only
       when it can account for the entire utterance, so `null` here is *not*
       "did not understand" — it is "this one is the steward's". */
    if (plan) return await this.#answer(plan, "grammar", confirmed, gen);
    return await this.#escalate(utterance, wall, confirmed, gen);
  }

  /** A plan, carried or held for a yes. One place, so the gate above cannot be
   *  true of one rung and not the other.
   *
   *  **`gen` is checked here rather than only around the drawing, and that is
   *  the difference between a stale answer being invisible and a stale answer
   *  moving the wall.** A steward parse is out for seconds; an Escape in the
   *  middle of one is a person saying *no, forget it*, and a plan that ran
   *  anyway because only its *report* was suppressed would be the invariant
   *  this class writes down and then keeps in one place out of two. */
  async #answer(plan: Plan, from: Rung, confirmed: boolean, gen: number): Promise<Heard> {
    if (plan.needs === "confirmation" && !confirmed) return { kind: "confirm", plan, from };
    if (gen !== this.#gen) return { kind: "unusable", why: "let go of before it could run" };
    return { kind: "carried", plan, outcome: await carry(plan, this.hands()), from };
  }

  /** The rung underneath: a small model, the wall in its prompt, and every word
   *  of its reply treated as a proposal rather than as a decision.
   *
   *  **The wall it is shown and the wall its reply is checked against are the
   *  same value**, and that is the only thing in here worth being careful about.
   *  `narrow` cuts each territory's file list down to what this sentence could
   *  be about — without which the prompt carries every path in every named
   *  repository, which is tens of thousands of tokens on every escalated
   *  sentence — and `understand` then checks a proposed path for membership of
   *  the list the model was actually shown. Two different lists would refuse
   *  good replies for a reason nothing could report.
   *
   *  Never throws. A steward that cannot be reached is an answer — an honest
   *  one, naming what went wrong — and the caller is a keystroke.
   *
   *  **A superseded parse is still paid for**, and there is nothing to be done
   *  about that from here: a `--print` child cannot be told to stop wanting its
   *  answer, and killing it would not unspend the request. What is avoided is
   *  the second half of the waste — a stale reply moving the wall — which is
   *  what `gen` is threaded through `#answer` for. */
  async #escalate(
    utterance: string,
    wall: Wall,
    confirmed: boolean,
    gen: number,
    /** What to score the file shortlist against, when that is not the whole
     *  sentence. An address is words the model needs and the scorer does not:
     *  this wall's own territory is *called* volery, so "volery" as a scoring
     *  word is a subsequence of every path under it and fills the sixty slots
     *  with files the sentence was not about. Stripping it costs nothing — a
     *  name is never a filename — and the prompt still carries the whole
     *  utterance, which is where the address has to be. */
    about = utterance,
  ): Promise<Heard> {
    const seen = narrow(wall, about);
    this.#parses++;
    try {
      const said = await invoke<string>("voice_steward", {
        system: stewardPrompt(seen),
        utterance,
      });
      const { reply } = replyIn(said);
      const got = understand(reply, utterance, seen);
      if (got.kind === "plan") return await this.#answer(got.plan, "steward", confirmed, gen);
      if (got.kind === "ask") return { kind: "asked", question: got.question };
      if (got.kind === "question") return { kind: "question", question: got.question };
      if (got.kind === "decline") return { kind: "declined", why: got.why };
      return { kind: "unusable", why: got.why };
    } catch (err) {
      return { kind: "unusable", why: err instanceof Error ? err.message : String(err) };
    } finally {
      this.#parses--;
    }
  }

  /** What the wall says back about an utterance, and what it holds on to.
   *
   *  One place for the same reason `spoke()` is one place: every rung and every
   *  entry point settles into the same four fields, and a second mapping would
   *  be a second vocabulary for the same outcomes. Silence is never a reading —
   *  every branch either sets `pending` or says something. */
  report(what: Heard): void {
    if (what.kind === "confirm") {
      this.pending = what.plan;
      this.#pendingFrom = what.from;
      /* When it was asked, which is what bounds a *spoken* yes — see `heard`. */
      this.#askedAt = Date.now();
      return;
    }
    /* **Every other answer lets go of whatever was waiting.** A plan is a
       question the wall asked about the sentence you just said; answering a
       different sentence is not leaving that question open, it is moving on
       from it. Leaving it armed had three faces: the bar drew a question about
       an utterance two ago, `App.svelte`'s ladder gave Enter and Escape to that
       plan for as long as it stood, and an ambient "sure" ten minutes later
       could fire it. `listen()` has always cleared it on every gesture; `heard`
       is the path that now takes every utterance, and it did not. */
    this.#forget();
    if (what.kind === "carried") {
      this.says = spoke(what.outcome);
      /* Success says nothing, and on a plan the steward proposed that would
         leave the bar showing only the transcript — which is indistinguishable
         from a sentence nothing came of. The wall moved, so this is a receipt
         rather than an announcement, and it is one line. */
      if (!this.says && what.from === "steward") this.says = "done";
      return;
    }
    if (what.kind === "asked") {
      this.says = what.question;
      return;
    }
    if (what.kind === "question") {
      /* Kept apart from a decline on purpose: asking the wall something is one
         of the things voice is for, and answering it needs the addressed card's
         own transcript rather than the wall in a prompt. Saying so is the
         honest end of this path today. */
      this.says = "that is a question rather than an instruction, and nothing here answers one yet";
      return;
    }
    if (what.kind === "declined") {
      this.says = what.why;
      return;
    }
    this.says = what.why;
  }

  /* ── the whole gesture, from a key to the wall moving ─────────────────────── */

  /** Listen for one utterance, understand it, and do what may simply be done.
   *
   *  **Press to talk, not hold to talk**, and the difference is the recogniser's
   *  rather than a shortcut. `RecognizeAsync` is one-shot: it opens the
   *  microphone and ends on its own end-of-speech silence, and there is no "stop
   *  now and give me what you have". So the key press starts it and the release
   *  has nothing to do — pretending otherwise would be a binding that ignores
   *  half of itself. True hold-to-release wants
   *  `SpeechContinuousRecognitionSession`, which is also what the always-on mode
   *  needs, so the two arrive together or not at all.
   *
   *  Never throws. Every way this can fail ends up in `says`, because the caller
   *  is a keystroke and a keystroke has nowhere to put an exception. */
  async listen(): Promise<void> {
    /* With the ear already open there is nothing to open, and the key means the
       one thing left for it to mean: *this next one is for you*, without having
       to say the wall's name to something already listening. */
    if (this.open) {
      this.attend();
      return;
    }
    if (this.listening) return;
    const gen = ++this.#gen;
    this.listening = true;
    this.said = "";
    this.says = "";
    this.partial = "";
    this.#forget();

    /* Subscribed for the duration of this one call and dropped in the `finally`.
       `CLAUDE.md` warns that anything holding a Tauri subscription needs
       releasing, and this is how that is answered without a lifecycle: the
       subscription cannot outlive the gesture, so there is nothing for an
       `onDestroy` to remember and a superseded generation of this class holds
       no listener at all. */
    let hush: (() => void) | null = null;
    try {
      hush = await onEvent<string>("voice:hypothesis", (e) => {
        /* Guarded on `listening` because an event from a recognition that has
           already ended must not repaint a bar showing its result. */
        if (this.listening) this.partial = e.payload;
      });
      const heard = await invoke<Transcript>("voice_listen", {});
      this.said = heard.text;
      /* `listening` goes down before the parse rather than in the `finally`,
         because the microphone is shut by then and a pulsing ear over a parse
         says the wrong thing about what is open. */
      this.listening = false;
      const what = await this.say(heard.text, false, gen);
      /* Dropped rather than drawn if you have moved on — see `#gen`. */
      if (gen === this.#gen) this.report(what);
    } catch (err) {
      /* Where the privacy-policy message arrives, and every other thing the
         recogniser refuses for. `voice.rs::explain` has already turned it into
         a sentence naming what to change. */
      this.says = err instanceof Error ? err.message : String(err);
    } finally {
      this.listening = false;
      this.partial = "";
      hush?.();
    }
  }

  /** Carry out the plan that was waiting for a yes.
   *
   *  Carries the plan that was *already understood* rather than parsing the
   *  words again — the wall may have moved since, and re-reading the sentence
   *  against a changed wall could produce a different plan from the one you were
   *  shown and agreed to. A card that has gone in the meantime comes back
   *  through `carry` as `stopped`, naming the step. */
  async confirm(): Promise<void> {
    const plan = this.pending;
    if (!plan) return;
    const from = this.#pendingFrom;
    /* Saying yes is a deliberate act and supersedes anything still out — and it
       claims a generation of its own so a parse that lands mid-carry cannot
       draw over what the yes did. */
    const gen = ++this.#gen;
    this.#forget();
    const what: Heard = {
      kind: "carried",
      plan,
      outcome: await carry(plan, this.hands()),
      from,
    };
    if (gen === this.#gen) this.report(what);
  }

  /** Let go of a plan that was waiting, without touching what is drawn. */
  #forget(): void {
    this.pending = null;
    this.#pendingFrom = "grammar";
    this.#askedAt = 0;
  }

  /** Let go of what was heard, and of anything waiting on a yes. */
  dismiss(): void {
    /* Which also disowns whatever is still out: a steward answering after this
       has nothing left to land in. */
    this.#gen++;
    this.#forget();
    /* Including the arming: `attend()` puts the wall in a state where the next
       thing anybody in the room says is taken as an instruction, and says so on
       the bar. Escape clears the saying and used to leave the state — an armed
       microphone with nothing drawn to admit it, which is the one disagreement
       between indicator and truth this subsystem may not have. */
    this.#attending = 0;
    this.said = "";
    this.says = "";
    this.partial = "";
    this.overheard = "";
  }

  /** Is there anything to draw? */
  get showing(): boolean {
    return (
      this.open ||
      this.listening ||
      this.thinking ||
      !!this.pending ||
      !!this.said ||
      !!this.says
    );
  }
}
