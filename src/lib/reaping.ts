/* Letting a card that nobody has been near for hours put its process down.
 *
 * `rousing.ts` is the other end of this argument and most of the reasoning is
 * already there: a `claude.exe` is not one process but a dozen — a node, a
 * `conhost`, and a `cmd → node` per stdio MCP server — held for as long as the
 * wall is up whether or not you ever speak to it. Rousing answered "which
 * dormant cards should be handed a process at launch" and narrowed it to almost
 * none. This answers the question one step later: **nothing ever gives a
 * process back, so a card you finished with at nine in the morning is still
 * holding one at midnight.**
 *
 * Measured on this wall on 2026-09-12 (sink `44e1e8c6`): 41 cards, of which 3
 * working, 9 idle and 29 dormant — and exactly 12 `claude` processes, which is
 * 3 + 9. So the model was already right and only the transition was missing: a
 * dormant card genuinely holds nothing. Each of those nine idle processes was
 * 588–759 MB private, ~6 GB between them, on a machine with 15.4 GB physical
 * and 1.5 GB actually available. Six of the nine had been idle over eleven
 * hours; one 18.7; and one of them was *dead* — killed by the NUL-byte bug,
 * unable to ever resume, still holding 660 MB. What that cost, concretely, was
 * a Nova production build that needs 2–4 GB and had 0.8, with the honest advice
 * being "go and close some cards by hand".
 *
 * ### Dormancy is lossless, and that is what makes this safe rather than clever
 *
 * A reaped card keeps its transcript, its context, its title, its place, its
 * project and its session id. Waking it is `--resume`, which hands the model
 * the whole conversation back off disk — the same path a wall coming back from
 * a restart already uses for every card on it, thirty times a launch. What it
 * costs is a second or two, and `Skein.stir` already spends that on the first
 * keystroke into a draft, so the ordinary way back in does not even show it.
 *
 * Because nothing is lost, **nothing is sent**. A reaped card is not prompted
 * when it comes back and is told nothing by Skein in the session, for the
 * reason `rousing.ts` spent a whole redesign learning: a prompt costs a turn, an
 * allowance and an agent, and spending those on a card nobody asked about is the
 * wrong default. The model has its context; there is no gap to explain to it.
 * The line in the transcript (`restNote`) is for **you**, in `meta`, in the same
 * register as the account-swap note — the one thing an app spawning
 * `--dangerously-skip-permissions` children owes you is that nothing it did on
 * its own is invisible afterwards.
 *
 * ### What must not be reaped
 *
 * This is the whole difficulty, and a reaper that stands down a card holding
 * work is worse than no reaper at all. `keptFrom` is the single place that
 * decides, and it is a list rather than a judgement — every arm is a thing that
 * would be *lost*, not a thing that would be inconvenient:
 *
 *  - **`working`** — a turn is open. Obvious, and it is also why `idleSeconds`
 *    reads zero for such a card anyway; stated explicitly so the gate does not
 *    depend on that.
 *  - **`asking`** — a parked `ask_user`. The `tools/call` is being held open by
 *    the very process this would kill, so the agent's question would be answered
 *    into a pipe with nothing on the other end.
 *  - **`jobs`** — background work the agent started and is waiting on. The
 *    notification arrives down the stream that would be closed, and `markExited`
 *    would (correctly) report the jobs as orphaned. This is the exclusion Lyss
 *    named first and it is the reason `busy` exists as a separate reading from
 *    `working`.
 *  - **`unheard`** — a job that reported in and the card never stirred
 *    (`Conversation.unwoken`). The news is sitting in the CLI's own queue,
 *    undelivered; killing the process throws it away with nothing left to say
 *    it existed. A job in flight and a job whose ending nobody picked up are the
 *    same fact one beat apart.
 *  - **`wake`** — an armed `wake_me`. See below; this one was nearly left out.
 *  - **`children`** — a card with a live child on the wall. A parent that spawned
 *    six cards and is waiting to be reported to is holding background work one
 *    level out, and the report is a relay — which *queues* for a dormant card
 *    rather than waking it. Cheap to check, because `Skein.kin` is already in
 *    memory for the roots the wall draws. It converges the right way round:
 *    leaves go dormant first, and their parent becomes reapable once they have.
 *  - **`aside`** — you put this card by on purpose. `close` refuses one outright
 *    and the rousing queue skips one, both on the argument that setting a card
 *    aside is you saying you are coming back to it. Reaping it behind your back
 *    is the same instruction ignored a third time.
 *
 * And two that are not exclusions but states with nothing to do: `dormant`
 * (already), `retiring` (a kill is in flight).
 *
 * #### The `wake_me` exclusion is real, and the shortcut that would remove it is not
 *
 * The item filing this flagged a possible simplification: dormant cards are
 * re-activated when another card speaks to them, so perhaps a `wake_me` just
 * wakes the card and no exclusion is needed. **Both halves of that turn out to
 * be false, and the same line of Rust says so.** `relay::send` and
 * `later::serve_due` both go through `supervisor::deliver`, which fails for a
 * card with no process — and both then write the message to the inbox
 * `spawn_conversation` drains, where it waits until somebody next speaks to the
 * card. The sender is told ("queued … that card is dormant"). A wake is not.
 *
 * So a reaped card's timer would not fire at its time; it would fire whenever
 * you next happened to type into that card, which is exactly the failure
 * `wake_me` exists to prevent. `later.rs`'s own comment reasons from this being
 * "the rare path — going dormant in between means Skein restarted", and a
 * reaper without this exclusion is precisely what makes that comment untrue.
 *
 * The alternative — having the waker *rouse* a dormant card — is a real design
 * and deliberately not taken here: it spends a process and an API turn on a
 * sleeping card with nobody there, which `relay.md` settles as the wrong
 * default for the relay and which applies verbatim to a wake. The exclusion is
 * cheap, bounded (`MAX_ARMED` is 3 per card and a wake may be at most 12 hours
 * out) and lifts on its own the moment the wake is served.
 *
 * ### Why this is not a fourth poller
 *
 * CLAUDE.md names exactly three places in this app that go and look, and says
 * anything proposing to be the fourth owes one of their shapes and the same
 * argument. This is none of them, because **the event already exists**: the
 * wall's one-second `clock` in `conversation.svelte.ts` is the only wake-up on
 * an idle machine, it is already folded by `idleSeconds` on every card, and the
 * question this asks is a function of exactly that number. `App.svelte` reads
 * `clock.t` in an `$effect` and calls the pass, beside the effect that drives
 * the peek off the same tick and for the same stated reason.
 *
 * What *is* left over is the memory reading, and it is bounded three ways in
 * the shape `release.svelte.ts` uses for update checks:
 *
 *  - **Not asked at all unless somebody could be reaped.** No card can go under
 *    `REST_FLOOR_S` whatever the pressure, so a wall whose longest idle is under
 *    fifteen minutes asks nothing — which is most walls most of the time, and
 *    every wall for its first quarter of an hour.
 *  - **Not asked at all when the setting is off**, before anything else.
 *  - **Never twice inside `ASK_FLOOR_MS`.** A minute's stale answer cannot
 *    change a decision measured in hours.
 *
 * ### The threshold, the knob, and why pressure only ever shortens it
 *
 * Reaping at thirty minutes on a machine with room is annoying; at 8 GB free it
 * does not need to reap at all. But a knob that says "three hours" and does not
 * reap at three hours is a knob you stop believing, so the rule is one-sided:
 * **the setting is the longest you will ever wait, and pressure only brings it
 * in.** `waitFor` is the whole of that — the baseline down to `REST_FLOOR_S` as
 * available memory falls from `AMPLE` to `TIGHT`, clamped at both ends and
 * eased in rather than straight, for the reason stated there. On the machine as measured (1.5 GB available) a three-hour baseline
 * comes out around twenty minutes, which is the case this was filed about.
 *
 * It is a setting rather than a fixed policy because a wall that stands your
 * card down at a threshold you cannot see is a wall you stop trusting; it is
 * *one* setting because the second knob would be the pressure curve, and a
 * curve is not a thing anybody can hold an opinion about until it has been wrong
 * once. The default and the ramp were chosen with Lyss on 2026-09-13.
 *
 * This module is the pure half: the choices, the arithmetic, the gate, the
 * order, and the words. */

/** How long a card may be idle before it puts its process down.
 *
 *  `null` is off. Stored in `localStorage` rather than the database, for
 *  `motion.svelte.ts`'s reason and more strongly: this is a judgement about
 *  *this machine's* memory, and carrying it to another machine in a wall export
 *  would be carrying the wrong answer. */
export type RestId = "never" | "1h" | "3h" | "8h";

export type Rest = {
  id: RestId;
  /** The menu line. Self-describing rather than "3h", since these sit in the
   *  ground menu under no heading — the same arrangement the motion picks have,
   *  which say "less motion" and not "less". */
  label: string;
  /** Seconds, or null for off. */
  after: number | null;
};

/** Chosen with Lyss: three hours as the baseline, against nine cards on the
 *  measured wall of which six were past eleven hours. Well clear of a lunch, a
 *  meeting or an afternoon spent in another territory. */
export const REST_DEFAULT: RestId = "3h";

export const RESTS: readonly Rest[] = [
  { id: "never", label: "idle cards keep their process", after: null },
  { id: "1h", label: "idle cards rest after an hour", after: 60 * 60 },
  { id: "3h", label: "idle cards rest after three hours", after: 3 * 60 * 60 },
  { id: "8h", label: "idle cards rest after eight hours", after: 8 * 60 * 60 },
];

/** Where the choice is kept. Namespaced like `skein.motion`, and still spelled
 *  `skein` for the reason CLAUDE.md gives about every other durable name here:
 *  a rename orphans the setting on every machine that already has one. */
export const REST_KEY = "skein.rest";

/** What `reap_survey` answers — see `src-tauri/src/reap.rs`. */
export type Survey = {
  /** Bytes the machine could still hand out, or null where nothing would say. */
  available: number | null;
  total: number;
  /** Of the ids asked about, those holding an armed `wake_me`. */
  awaiting_wake: string[];
  /** Of the ids asked about, those the supervisor has a turn open for. */
  mid_turn: string[];
};

/** A stored or menu-supplied value, made into one of the four.
 *
 *  Degrades to the default rather than throwing, the bargain every normalizer in
 *  this codebase strikes: a value written by a newer build, or by hand, must not
 *  be able to leave the wall with no policy at all. */
export function restFor(id: unknown): RestId {
  return RESTS.some((r) => r.id === id) ? (id as RestId) : REST_DEFAULT;
}

/** The wait that `id` names, in seconds, or null for off. */
export function waitOf(id: RestId): number | null {
  return RESTS.find((r) => r.id === id)?.after ?? null;
}

/** The shortest wait pressure may ever bring the threshold down to.
 *
 *  Fifteen minutes, and it is a correctness bound rather than taste: it is what
 *  lets the pass ask nothing at all until some card has been idle that long, and
 *  it is the distance between "you stepped away from this" and "you are using
 *  this and thinking". A wake costs a second or two, so being wrong here is
 *  cheap — but being wrong here *repeatedly*, on the card you are working in, is
 *  the wall fighting you. */
export const REST_FLOOR_S = 15 * 60;

/** Available memory at or above which the baseline stands unshortened. */
export const AMPLE_BYTES = 4 * 1024 * 1024 * 1024;

/** Available memory at or below which the wait is the floor.
 *
 *  One gigabyte, because that is roughly what a single card holds — a wall with
 *  less than one card's worth of headroom cannot start anything, which is the
 *  state the measurement was taken in. */
export const TIGHT_BYTES = 1024 * 1024 * 1024;

/** How rarely the machine may be asked about its memory. */
export const ASK_FLOOR_MS = 60_000;

/** The wait that actually applies, given the setting and what is left of the
 *  machine.
 *
 *  One-sided on purpose: the result is never longer than `baseline`, so the
 *  menu line is always the truth about the longest a card will sit. `available`
 *  is null when there is no reading — a survey that failed, or one not asked
 *  for — and ignorance shortens nothing. */
export function waitFor(baseline: number, available: number | null): number {
  const floor = Math.min(baseline, REST_FLOOR_S);
  if (available === null) return baseline;
  if (available >= AMPLE_BYTES) return baseline;
  if (available <= TIGHT_BYTES) return floor;
  const room = (available - TIGHT_BYTES) / (AMPLE_BYTES - TIGHT_BYTES);
  /* Squared, and the curve is the argument. A straight line between the two
     anchors spends most of its range being generous where it matters least: at
     1.5 GB free — the reading the whole item was filed about — it gives 42
     minutes, which is not the behaviour of a wall that cannot start a build.
     Pressure is not linear in how bad it is, because the last gigabyte is the
     one that decides whether anything can be spawned at all and the third is
     merely comfort. Easing in holds the wait near the setting while there is
     real room (3 GB free still leaves ~1h30 of a three-hour baseline) and
     collapses it towards the floor as the machine runs out: 2 GB → ~33m,
     1.5 GB → ~20m, 1.2 GB → ~16m. */
  return Math.round(floor + room * room * (baseline - floor));
}

/** The little of a card the gate needs.
 *
 *  Structural rather than `Conversation`, so this file stays pure — the same
 *  bargain `Rousable` strikes next door. */
export type Restable = {
  dormant: boolean;
  retiring: boolean;
  working: boolean;
  /** A parked `ask_user`. Named as the field rather than as a boolean, and read
   *  for truthiness, so `Conversation` satisfies this shape with nothing added
   *  to it — the same bargain `Rousable` strikes next door. A type that needs an
   *  adapter written for it is a type that will drift from the thing it
   *  describes. */
  pendingAsk: unknown;
  /** Background work in flight: `Conversation.busy`. */
  busy: boolean;
  /** A job that reported in and the card never stirred for. */
  unwoken: unknown;
  aside: boolean;
  /** Null if this card has never rested — spawned and then abandoned without a
   *  word — which is the case `idleSeconds` reads as zero and cannot speak for.
   *  Only its null-ness is used; the epoch itself is never read here. */
  restingSince: number | null;
  /** Seconds since the card went quiet. Zero when `restingSince` is null. */
  idleSeconds: number;
  /** Seconds since this card's *current* process started.
   *
   *  The second clock, and it is load-bearing rather than belt-and-braces. A
   *  card idle twelve hours that you stir by typing gets a process back with its
   *  neglect clock untouched — `stir` deliberately does not reset it, since
   *  typing at a card is not attending to it — so on the neglect clock alone the
   *  pass would stand that process down a second after spawning it, while you
   *  were still typing the sentence. A process that is thirty seconds old has
   *  not been idle for three hours, whatever any other clock says. It also gives
   *  every roused card at launch a full wait's grace, which is the right answer
   *  for the same reason: rousing just decided those cards were wanted. */
  awakeSeconds: number;
};

/** Facts about a card that only Rust or the rest of the wall can answer. */
export type Around = {
  /** This card has an armed, unserved `wake_me`. */
  wake: boolean;
  /** This card has a child on the wall that still has a process. */
  children: boolean;
  /** The supervisor has a turn open for this card that the front end cannot see
   *  yet — a prompt written into its stdin whose echo has not come back.
   *
   *  `card.working` is not this question. It turns true on the CLI's replayed
   *  `user` event, which is the far end of stdin → parse → stdout → reader
   *  thread → `emit` → `ingest`; `Supervisor::liveness(id).1` turns true at the
   *  write. Every reap in between takes a prompt nobody kept a copy of — see
   *  `reap::Survey::mid_turn` for which of the four senders loses what. */
  midTurn: boolean;
};

/** Why a card is being left alone — or `null`, meaning nothing is.
 *
 *  A reason rather than a boolean because every one of these is a claim that can
 *  be wrong in the expensive direction, and a test that can only see "no" cannot
 *  say which arm said it. */
export type Kept =
  | "dormant"
  | "retiring"
  | "working"
  | "sending"
  | "asking"
  | "jobs"
  | "unheard"
  | "wake"
  | "children"
  | "aside"
  | "recent";

export function keptFrom(card: Restable, around: Around, wait: number): Kept | null {
  /* Nothing to do, ahead of everything that is a refusal — a dormant card has
     no process to stand down and a retiring one is already losing it. */
  if (card.dormant) return "dormant";
  if (card.retiring) return "retiring";

  if (card.working) return "working";
  /* Above `asking` and below `working` because it is the same fact one beat
     earlier: a turn the supervisor has opened and this side has not heard about
     yet. It is its own arm rather than folded into `working` for the reason the
     whole of `Kept` is a reason and not a boolean — an arm that fires here means
     a prompt was in flight, which is a different thing to have learned than a
     card that was busy. */
  if (around.midTurn) return "sending";
  if (card.pendingAsk) return "asking";
  if (card.busy) return "jobs";
  if (card.unwoken) return "unheard";
  if (around.wake) return "wake";
  if (around.children) return "children";
  if (card.aside) return "aside";

  return quietFor(card) >= wait ? null : "recent";
}

/** How long this card has been both awake and unspoken-to.
 *
 *  The `min` of the two clocks, because either one being short is a reason not
 *  to reap and neither alone is sufficient. A card that has never rested at all
 *  — spawned by `stir` and then abandoned mid-sentence — has no neglect clock to
 *  read, and the honest reading of it is the age of the process nobody has said
 *  anything to. */
export function quietFor(card: Restable): number {
  return card.restingSince === null
    ? card.awakeSeconds
    : Math.min(card.idleSeconds, card.awakeSeconds);
}

/** Could anything on this wall be reaped under *any* pressure?
 *
 *  The bound that keeps the pass free. `REST_FLOOR_S` is the shortest wait
 *  `waitFor` can ever return, so a wall where nothing has been quiet that long
 *  cannot produce a reaping however little memory is left — and therefore has no
 *  reason to ask the machine how much there is. Deliberately does *not* consult
 *  `Around`: those answers cost the very call this is deciding whether to make.
 *  An excluded card that gets this far only costs the survey it was going to
 *  cost anyway. */
export function worthAsking(cards: readonly Restable[]): boolean {
  return cards.some(
    (c) =>
      !c.dormant &&
      !c.retiring &&
      !c.working &&
      quietFor(c) >= REST_FLOOR_S,
  );
}

/** Which cards to stand down, longest-quiet first.
 *
 *  The order matters only for the chronicle line and for which goes first if
 *  something fails half-way — but it is the order a person would pick by hand,
 *  and a reaper that agrees with the hand it is replacing is one you can check. */
export function toRest<T extends Restable>(
  cards: readonly T[],
  around: (card: T) => Around,
  wait: number,
): T[] {
  return cards
    .filter((c) => keptFrom(c, around(c), wait) === null)
    .sort((a, b) => quietFor(b) - quietFor(a));
}

/** A span in the register the rest of the wall uses. */
export function saidFor(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The line the card carries in its own transcript.
 *
 *  `meta`, and it says three things in one sentence each: that the process is
 *  gone, that nothing else is, and how to get it back. The last is not padding —
 *  a card whose transcript ends "its process was stood down" and says nothing
 *  about what that means reads as a card that broke.
 *
 *  Names the wait that actually applied rather than the setting, and says so
 *  when pressure shortened it. That is the whole answer to "a threshold you
 *  cannot read off the menu": the menu carries the promise and the line carries
 *  what happened. */
export function restNote(quiet: number, wait: number, baseline: number): string {
  const why =
    wait < baseline
      ? ` — the wall was short of memory, so the wait came in from ${saidFor(baseline)} to ${saidFor(wait)}`
      : "";
  return (
    `nothing had been said to this card for ${saidFor(quiet)}${why}, so skein let it ` +
    `put its process down. nothing else has gone: the transcript, the context, ` +
    `the session and this card's place on the wall are all as they were. speak ` +
    `to it and it resumes where it left off.`
  );
}

/** The chronicle's line for one pass.
 *
 *  One row per pass rather than per card, because a wall left overnight reaps
 *  its long-idle cards together and nine rows saying the same thing at the same
 *  second is the noise `chronicle.md` says the register exists to cut through.
 *  It qualifies under that file's one rule — *what happened to you, never what
 *  you did* — because this is the one thing on the wall that changes a card's
 *  state without a gesture of yours behind it.
 *
 *  Volery's own voice (`source: "volery"`), not the cards': it is one decision
 *  about several of them, and attributing it to whichever card happened to be
 *  first would read as that card having done something. */
export function restMark(names: readonly string[]): string {
  return names.length === 1
    ? `stood “${names[0]}” down to rest`
    : `stood ${names.length} idle cards down to rest`;
}

/** And the detail under it: who, and how long each had been quiet.
 *
 *  Named rather than counted while there is room, because "5 cards" is a number
 *  you cannot check and a list is one you can. Beyond `NAMED` it becomes a count
 *  again — a register row is one line of a small widget, not a report. */
const NAMED = 4;

export function restDetail(
  entries: readonly { name: string; quiet: number }[],
  wait: number,
  baseline: number,
): string {
  const shown = entries
    .slice(0, NAMED)
    .map((e) => `${e.name} (${saidFor(e.quiet)})`)
    .join(", ");
  const rest = entries.length > NAMED ? ` and ${entries.length - NAMED} more` : "";
  const why =
    wait < baseline
      ? `; the wait was ${saidFor(wait)} rather than ${saidFor(baseline)}, the wall being short of memory`
      : "";
  return `${shown}${rest}${why}`;
}
