/* What Azure DevOps is saying, and what it means.
 *
 * `azdo.rs` answers in facts — a status string, a result string, a vote as a
 * number on someone else's scale — and this file is where all of that becomes
 * something a wall can be read from. The same split `perf.rs`/`perf.ts` and
 * `usage.rs`/`usage.ts` draw, and the same argument: a taxonomy is knowledge
 * about a service, and knowledge is testable without a browser.
 *
 * So this file holds essentially all forge-specific knowledge, the way
 * `classify.ts` holds all Claude-specific knowledge: the status vocabulary, the
 * vote scale, what a merge status means, how a run is ordered against another
 * one, and what any of it is called in prose. `CLAUDE.md` said that if a second
 * forge ever mattered this is the file that would grow an interface, and it has:
 * **GitHub arrived, and it grew a `forge` discriminator rather than a second
 * file.**
 *
 * The shape that took is worth stating, because it is the one a third forge will
 * be argued against. Rust reports each service's own words — `inProgress` from
 * Azure DevOps, `in_progress` from GitHub — and folds nothing, so every function
 * here that touches a *state* dispatches on `r.forge` and every function that
 * touches something the two genuinely share does not. Ordering, tallying,
 * scoping and `needsMe` are all in the second group and were not touched at all,
 * which is the evidence the seam is in the right place: the questions a wall asks
 * turn out to be forge-independent, and only the vocabulary is not.
 *
 * The alternative — normalising GitHub into Azure DevOps' words in Rust — would
 * have left this file untouched and been a lie. See `forge.rs` for the test a
 * projection has to pass to be allowed, and for the two that pass it.
 *
 * Pure — no runes, no DOM, no `invoke` — so all of it has direct Bun tests.
 *
 * **Colour is status here exactly as it is everywhere else on this wall**, and
 * that constraint is doing real work rather than being observed politely. Azure
 * DevOps' own web UI has a colour for each of a dozen states; this has four,
 * because they are the four the rest of the wall already means (see
 * `classify.ts`). A pipeline that is running is the same celadon a card that is
 * thinking is. A pull request that wants your review is the same amber a card
 * that has been waiting is. Nothing here introduces a hue. */

/* ── what comes off the wire ───────────────────────────────────────────────*/

/** Which service answered. The discriminator every state-reading function here
 *  switches on — see the header. */
export type Forge = "azdo" | "github";

export type Run = {
  id: string;
  forge: Forge;
  org: string;
  project: string;
  pipeline: string;
  number: string;
  /** Azure DevOps: `notStarted` | `inProgress` | `completed` | `cancelling` |
   *  `postponed`. GitHub: `queued` | `in_progress` | `completed` | `waiting` |
   *  `requested` | `pending`. */
  status: string;
  /** Azure DevOps: `succeeded` | `partiallySucceeded` | `failed` | `canceled`.
   *  GitHub: `success` | `failure` | `cancelled` | `skipped` | `timed_out` |
   *  `action_required` | `neutral` | `stale` | `startup_failure`. Empty while it
   *  is still going, on both. */
  result: string;
  /** `refs/heads/main` from Azure DevOps, a bare `main` from GitHub. */
  branch: string;
  by: string;
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
  url: string;
  mine: boolean;
};

export type Vote = { by: string; vote: number; required: boolean };

export type Review = {
  id: string;
  forge: Forge;
  org: string;
  project: string;
  repo: string;
  number: number;
  title: string;
  by: string;
  draft: boolean;
  /** `succeeded` | `conflicts` | `queued` | `rejectedByPolicy` | `notSet`. */
  merge: string;
  target: string;
  createdAt: number;
  url: string;
  auto: boolean;
  mine: boolean;
  reviewing: boolean;
  myVote: number;
  votes: Vote[];
  /** GitHub's rolled-up `approved` | `changesRequested` | `reviewRequired`, and
   *  empty for Azure DevOps, which marks reviewers required instead. Two halves
   *  of the same fact, neither derivable from the other — see `landable`. */
  decision: string;
};

/** The wall's own four, from `classify.ts`. Named rather than imported because
 *  nothing else about that file is wanted here and the two vocabularies must be
 *  free to stay the same by agreement rather than by coupling. */
export type Tier = "work" | "ask" | "soft" | "rest" | "fail";

/* ── runs ──────────────────────────────────────────────────────────────────*/

/** Is this run still going? Everything that is not `completed` is, including
 *  the two states that look finished and are not: a build being cancelled is
 *  still holding an agent, and a postponed one is still going to happen. */
export function running(r: Run): boolean {
  /* Both services happen to spell the terminal state `completed`, which makes
     this look like it needs no dispatch. It is written as one anyway, because
     the agreement is a coincidence rather than a contract: Azure DevOps' other
     four states and GitHub's other five have nothing in common, and a third
     forge saying `finished` would slip through a bare inequality silently. */
  return r.status !== "completed";
}

/** Is this run waiting for a person rather than for a machine?
 *
 * GitHub has a state Azure DevOps does not: `waiting`, a workflow parked because
 * an environment needs somebody to approve the deployment. Nothing is running,
 * nothing has failed, and it will sit there for ever until a human acts — which
 * is the definition of the wall's amber and the reason `action_required` and
 * this are the two GitHub states that most justify not folding the vocabulary.
 *
 * Azure DevOps expresses the same idea as a Checkpoint record inside the
 * timeline rather than as a state on the build, so a build waiting at an
 * approval gate still reads `inProgress`. That is a real gap and it is left
 * alone deliberately: the fix is reading the timeline on every poll, which is a
 * request per running build, and the widget would be paying it for every row to
 * improve the wording on a few. */
export function parked(r: Run): boolean {
  if (r.forge !== "github") return false;
  return r.status === "waiting" || (r.status === "completed" && r.result === "action_required");
}

/** What a run is, as one of the wall's four.
 *
 * `partiallySucceeded` is deliberately **not** a fault. It is what Azure DevOps
 * says when the build worked and something non-blocking did not — a flaky test
 * job, a publish step marked continue-on-error — and drawing it rust would put
 * the fault colour on a pipeline that produced an artifact. It is not `rest`
 * either, since something in there does want looking at eventually, so it takes
 * the warming amber that means exactly that on a card.
 *
 * A cancelled run is `rest` for the reason a stopped card is: nothing went
 * wrong, and somebody did it on purpose. */
export function tierOf(r: Run): Tier {
  if (r.forge === "github") return githubTier(r);
  if (running(r)) return "work";
  switch (r.result) {
    case "failed":
      return "fail";
    case "partiallySucceeded":
      return "soft";
    /* `canceled` is the American spelling on the wire, and the only one. */
    case "canceled":
      return "rest";
    case "succeeded":
      return "rest";
    default:
      /* Completed with no result at all is a shape we have not seen. Muted
         rather than red: an unrecognised state is not a failed one, and a
         pipeline widget that invents faults is a widget you stop trusting. */
      return "rest";
  }
}

/** What a GitHub run is, as one of the wall's four.
 *
 * Nine conclusions against Azure DevOps' four, which is the whole argument for
 * carrying both vocabularies rather than folding one into the other.
 *
 * - **`action_required` and `waiting` are amber**, and they are the states that
 *   justify the whole arrangement: a deployment parked waiting for somebody to
 *   approve it is the wall's `ask` exactly, and it has no Azure DevOps spelling
 *   to have been folded into. Under a projection it would have become `failed`
 *   or `succeeded`, and both are lies about a thing that is simply waiting.
 * - **`timed_out` and `startup_failure` are rust**, with `failure`. A run that
 *   hit the wall clock or could not start its own job did not produce what it
 *   was for, whatever the reason reads like.
 * - **`skipped`, `stale`, `cancelled` and `neutral` are `rest`.** Nothing went
 *   wrong in any of them: a skipped run was excluded by its own conditions, a
 *   stale one was superseded by a newer commit, a neutral one ran and declined
 *   to assert anything. Drawing any of them red would be the widget inventing a
 *   fault, which is the thing `tierOf` has refused to do since it was written.
 *
 * There is no GitHub state that earns `soft`. Azure DevOps' `partiallySucceeded`
 * — the build worked and something non-blocking did not — has no Actions
 * equivalent at the run level, because a job that fails without failing the run
 * is `continue-on-error` and Actions reports the run as plain success. So the
 * amber-at-half-weight simply never appears on a GitHub row, and that is honest
 * rather than a gap: nothing was lost, the service does not draw the
 * distinction. */
function githubTier(r: Run): Tier {
  if (r.status === "waiting") return "ask";
  if (running(r)) return "work";
  switch (r.result) {
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "fail";
    case "action_required":
      return "ask";
    case "success":
    case "cancelled":
    case "skipped":
    case "stale":
    case "neutral":
      return "rest";
    default:
      /* Same floor the Azure DevOps arm keeps: an unrecognised state is muted,
         never red. A widget that invents faults is a widget you stop trusting,
         and GitHub adds conclusions faster than this file will hear about it. */
      return "rest";
  }
}

/** How a run is said, in the fewest words that are still true. */
export function runSaid(r: Run): string {
  if (r.forge === "github") return githubSaid(r);
  switch (r.status) {
    case "notStarted":
      return "queued";
    case "inProgress":
      return "running";
    case "cancelling":
      return "stopping";
    case "postponed":
      return "held";
  }
  switch (r.result) {
    case "succeeded":
      return "passed";
    case "partiallySucceeded":
      return "passed with issues";
    case "failed":
      return "failed";
    case "canceled":
      return "cancelled";
    default:
      return "finished";
  }
}

/** The same, in GitHub's vocabulary.
 *
 * Deliberately the *same words out* as the Azure DevOps arm wherever the two
 * mean the same thing — "running", "passed", "failed". The vocabularies are kept
 * apart on the wire so nothing is lost; they are brought together here, which is
 * the layer where a person reads them, and a widget that said "in_progress" on
 * one row and "running" on the next would be leaking an implementation detail
 * onto the wall. */
function githubSaid(r: Run): string {
  switch (r.status) {
    case "queued":
    case "requested":
      return "queued";
    case "in_progress":
      return "running";
    case "waiting":
      return "waiting for approval";
    case "pending":
      return "pending";
  }
  switch (r.result) {
    case "success":
      return "passed";
    case "failure":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed out";
    case "startup_failure":
      return "could not start";
    case "action_required":
      return "needs approval";
    case "skipped":
      return "skipped";
    case "stale":
      return "superseded";
    case "neutral":
      return "neutral";
    default:
      return "finished";
  }
}

/** How long this run has been going, or how long it took, in milliseconds.
 *
 * A queued build has no start time, and its wait is the useful number rather
 * than a zero — so it is measured from the queue. That means the reading
 * silently changes what it is measuring when the build starts, which is right:
 * before it starts you want to know how long it has been waiting, and after it
 * starts you want to know how long it has been building. */
export function elapsed(r: Run, now: number): number {
  const from = r.startedAt || r.queuedAt;
  if (!from) return 0;
  const to = running(r) ? now : r.finishedAt || now;
  return Math.max(0, to - from);
}

/* ── reviews ───────────────────────────────────────────────────────────────*/

/* Azure DevOps' vote scale, which is not an ordinary one — the gap between
   -5 and -10 is a difference of kind rather than degree, and 5 is an approval
   rather than half of one. Named so nothing downstream compares magic numbers. */
export const APPROVED = 10;
export const APPROVED_WITH_SUGGESTIONS = 5;
export const NO_VOTE = 0;
export const WAITING_FOR_AUTHOR = -5;
export const REJECTED = -10;

export function voteSaid(vote: number): string {
  if (vote >= APPROVED) return "approved";
  if (vote >= APPROVED_WITH_SUGGESTIONS) return "approved with suggestions";
  if (vote <= REJECTED) return "rejected";
  if (vote <= WAITING_FOR_AUTHOR) return "waiting on the author";
  return "no vote";
}

/** Is this pull request waiting on *you*?
 *
 * The one question the widget exists to answer, and it is narrower than "am I a
 * reviewer". A PR you opened is not waiting on you even though Azure DevOps
 * lists you on it — which it does: probed 2026-08-14, four of this org's eight
 * open PRs had their own author down as a required reviewer, because that is
 * what the branch policy adds. And a PR you have already voted on is not
 * waiting on you either, whichever way you voted; if you rejected it, the ball
 * is with the author. So: asked, has not answered, and did not write it. */
export function needsMe(r: Review): boolean {
  return r.reviewing && !r.mine && r.myVote === NO_VOTE && !r.draft;
}

/** What a pull request is, as one of the wall's four.
 *
 * The order of these tests is the whole design. Conflicts first, because a
 * conflicted PR is the only one here that is genuinely *broken* — it is the
 * same fact a torn territory draws, arriving by a different route. Then
 * whatever is waiting on you, because that is what a wall is for. A draft is
 * muted whatever else is true of it: it is not asking anybody for anything yet.
 *
 * `rejectedByPolicy` joins conflicts as a fault because it means the same thing
 * to a person — this cannot land as it stands and needs a decision, not a
 * wait. */
export function reviewTierOf(r: Review): Tier {
  if (r.draft) return "rest";
  if (r.merge === "conflicts" || r.merge === "rejectedByPolicy") return "fail";
  if (needsMe(r)) return "ask";
  /* Yours, and somebody has said no. Amber-warming rather than rust: it is
     work you have to do, not something that has broken. */
  if (r.mine && r.votes.some((v) => v.vote <= WAITING_FOR_AUTHOR)) return "soft";
  /* Yours, everyone required has approved, and it is still sitting there. */
  if (r.mine && landable(r)) return "soft";
  return "rest";
}

/** Has everyone whose approval is required given it?
 *
 * Optional reviewers are excluded deliberately — a PR held open for a courtesy
 * reviewer who is on leave is not blocked, and counting them would mean the
 * widget never says a single PR is ready. Required-with-no-required-reviewers
 * is vacuously true, which is right: a repo with no approval policy lands on
 * the build alone. */
export function landable(r: Review): boolean {
  if (r.draft || r.merge === "conflicts" || r.merge === "rejectedByPolicy") return false;
  /* **The two forges answer opposite halves of this and neither can be derived
     from the other**, which is why `decision` is carried beside the votes rather
     than computed from them.

     Azure DevOps marks each reviewer required or optional and does not roll it
     up, so the question is arithmetic over the votes — and excluding the
     optional ones is the judgement that makes the answer useful, since a PR held
     open for a courtesy reviewer on leave is not blocked.

     GitHub does the reverse: it will not tell you who is required — branch
     protection knows, the pull request payload does not — and hands you the
     rollup instead. So a GitHub row's votes are genuinely all `required: false`,
     and running the Azure DevOps arithmetic over them would find an empty
     required set and answer *vacuously true* for every open pull request on
     GitHub, including ones with changes requested. That is the bug this branch
     exists to prevent, and it is the kind that looks like working code. */
  if (r.forge === "github") return r.decision === "approved";
  const required = r.votes.filter((v) => v.required);
  if (required.some((v) => v.vote <= WAITING_FOR_AUTHOR)) return false;
  return required.every((v) => v.vote >= APPROVED_WITH_SUGGESTIONS);
}

/** Why this row is worth a glance, in a few words — or null when it is simply
 *  open and nothing is remarkable about it. Drawn beside the title, so it has
 *  to earn its width every time. */
export function reviewSaid(r: Review): string | null {
  if (r.draft) return "draft";
  if (r.merge === "conflicts") return "conflicts";
  if (r.merge === "rejectedByPolicy") return "blocked by policy";
  if (needsMe(r)) return "wants you";
  if (r.mine && r.votes.some((v) => v.vote <= REJECTED)) return "rejected";
  if (r.mine && r.votes.some((v) => v.vote <= WAITING_FOR_AUTHOR)) return "changes asked";
  if (r.auto) return "auto-completing";
  if (r.mine && landable(r)) return "ready";
  return null;
}

/* ── one run, opened ───────────────────────────────────────────────────────
 *
 * The other half of what the pipelines widget is for. The list says a build
 * failed; this says which job, and which step of it — which is the question you
 * had to open a browser tab for, and the one the sink item asked to bring
 * in-app.
 *
 * Two levels on both forges, normalised in Rust — see `forge.rs` for why the
 * depth is a decision rather than what either service hands over. What is left
 * here is the same job this file has always done: turning each service's words
 * into one of the wall's four tiers, and into prose.
 *
 * **Raw logs are deliberately not here, and this is the line the ask was read
 * against.** The sink item asks to "consult the run directly in Volery" rather
 * than opening the browser, and a stage/step tree with per-step status and
 * timings answers that: it is what you actually go to the browser to see when a
 * pipeline goes red — *which step*. Streaming the log text is a different and
 * much larger job (Azure DevOps pages logs per record, GitHub serves a zip of
 * them), and it would want `logface.ts`'s substrate, a scrollback budget and a
 * per-step fetch. It is left out on purpose and the external-link button is what
 * covers it: the one thing this panel cannot show you is one click from it. */

/** One step of one stage — an Azure DevOps `Task`, a GitHub step. */
export type Step = {
  name: string;
  status: string;
  result: string;
  startedAt: number;
  finishedAt: number;
};

/** The unit that runs on an agent and owns a log: an Azure DevOps `Job`, a
 *  GitHub job. Named `Stage` because that is what it reads as in a panel. */
export type Stage = {
  name: string;
  status: string;
  result: string;
  startedAt: number;
  finishedAt: number;
  steps: Step[];
};

export type Detail = {
  id: string;
  forge: Forge;
  stages: Stage[];
  /** Whether the run was still going when this reading was taken. Rust's answer
   *  rather than one re-derived here, because a run whose last job has finished
   *  is not necessarily finished — see `forge.rs`. */
  live: boolean;
  fault: string | null;
};

/** What one stage or step is, as one of the wall's four.
 *
 * The same shape as `tierOf` one level down, and deliberately a separate
 * function rather than a clever reuse: a *run* and a *job* are described by
 * different vocabularies even within one service. Azure DevOps' timeline says
 * `succeededWithIssues` where the build above it says `partiallySucceeded` —
 * the same service, the same idea, two spellings — and a shared function would
 * have had to know both anyway while pretending the levels agreed.
 *
 * `skipped` is the state that matters most to get right here, because it is
 * everywhere: a release pipeline draws six stages of which five are skipped on
 * any given run, and a panel that drew those amber or red would be five-sixths
 * alarm. It is `rest`, and `stageSaid` gives it a word so the muting reads as
 * deliberate rather than as a stage that says nothing. */
export function stageTierOf(s: Step | Stage, forge: Forge): Tier {
  if (s.status !== "completed") {
    /* Not started yet and currently running are both "not finished", and they
       are told apart by the start time rather than by the state — Azure DevOps
       says `pending` for both a queued job and one whose agent has not reported,
       and GitHub says `queued`. A stage with no start time has not begun, and
       drawing it celadon would claim work is happening that is not. */
    return s.startedAt ? "work" : "rest";
  }
  if (forge === "github") {
    switch (s.result) {
      case "failure":
      case "timed_out":
      case "startup_failure":
        return "fail";
      case "action_required":
        return "ask";
      default:
        return "rest";
    }
  }
  switch (s.result) {
    case "failed":
      return "fail";
    /* The timeline's spelling of `partiallySucceeded`. Same amber-at-half-weight
       the build-level arm gives it, and the reason both spellings are carried
       verbatim rather than one being corrected into the other in Rust. */
    case "succeededWithIssues":
      return "soft";
    default:
      return "rest";
  }
}

/** A stage or step, in a word. Empty when the state is the ordinary one and the
 *  colour has already said it — a panel that writes "succeeded" down forty rows
 *  is forty rows of width spent on nothing. */
export function stageSaid(s: Step | Stage, forge: Forge): string {
  if (s.status !== "completed") return s.startedAt ? "running" : "waiting";
  if (forge === "github") {
    switch (s.result) {
      case "failure":
        return "failed";
      case "timed_out":
        return "timed out";
      case "startup_failure":
        return "could not start";
      case "action_required":
        return "needs approval";
      case "skipped":
        return "skipped";
      case "cancelled":
        return "cancelled";
      default:
        return "";
    }
  }
  switch (s.result) {
    case "failed":
      return "failed";
    case "succeededWithIssues":
      return "issues";
    case "skipped":
      return "skipped";
    case "canceled":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    default:
      return "";
  }
}

/** How long a stage or step took, or has been going, in milliseconds.
 *
 * `elapsed`'s logic one level down, with the same rule about what is being
 * measured — but *not* the same function, because a run has a queue time to fall
 * back on and a step does not. A step that has not started has no duration at
 * all rather than a duration measured from something else, which is why this
 * returns 0 there and the face draws nothing. */
export function stageTook(s: Step | Stage, now: number): number {
  if (!s.startedAt) return 0;
  const to = s.status === "completed" ? s.finishedAt || s.startedAt : now;
  return Math.max(0, to - s.startedAt);
}

/** Which stage a person opening this panel is actually looking for.
 *
 * The first that failed, or failing that the first still running — because a
 * panel opened on a red pipeline is opened to find out *what broke*, and a
 * twelve-stage run puts that anywhere in the list. Null when nothing stands out,
 * which is the ordinary case for a run that passed and the case where opening
 * anything by default would be a guess.
 *
 * Returned rather than acted on: whether to scroll to it, open it or mark it is
 * the face's business. */
export function worthOpening(d: Detail): Stage | null {
  const broke = d.stages.find((s) => stageTierOf(s, d.forge) === "fail");
  if (broke) return broke;
  return d.stages.find((s) => s.status !== "completed" && s.startedAt) ?? null;
}

/** What the detail panel says when it has no stages to draw.
 *
 * The same discipline `emptySaid` keeps, and for the same reason: a run whose
 * jobs have not been created yet, a run that never started one, and a reading
 * still in flight are three different sentences, and answering all three with an
 * empty box is what makes a panel read as broken. A queued build genuinely has
 * no timeline records at all — Azure DevOps creates them as the agent picks the
 * job up — so this is the *normal* state for the first seconds of a run, not an
 * edge case. */
export function detailSaid(d: Detail | null, run: Run): string {
  if (!d) return "asking…";
  if (d.fault) return d.fault;
  if (d.stages.length) return "";
  if (running(run)) return "waiting for an agent to pick it up";
  return "this run recorded no jobs";
}

/* ── narrowing what is shown ───────────────────────────────────────────────*/

export type RunScope = "live" | "mine" | "all";
export type ReviewScope = "mine" | "waiting" | "all";

/** Which runs a widget set to this scope is about.
 *
 * `live` is the default and the reason the widget exists — what is happening
 * right now, across every project at once, which is the one view Azure DevOps
 * itself does not offer without picking a project first. It deliberately keeps
 * *recently finished* runs too: a pipeline that failed ninety seconds ago is
 * the single most useful row this widget can show, and a strict "in progress"
 * filter makes it vanish at exactly the moment it matters. `SETTLING_MS` is how
 * long a finished run stays. */
export const SETTLING_MS = 15 * 60_000;

export function scopeRuns(runs: Run[], scope: RunScope, now: number): Run[] {
  if (scope === "all") return runs;
  if (scope === "mine") return runs.filter((r) => r.mine);
  return runs.filter(
    (r) => running(r) || now - (r.finishedAt || r.queuedAt) < SETTLING_MS,
  );
}

export function scopeReviews(reviews: Review[], scope: ReviewScope): Review[] {
  if (scope === "all") return reviews;
  if (scope === "waiting") return reviews.filter(needsMe);
  /* "mine" is both directions of involvement — the ones you opened and the ones
     you were asked about. A view of only what you wrote is a view that cannot
     tell you anybody is waiting on you, and that is the half that matters. */
  return reviews.filter((r) => r.mine || r.reviewing);
}

/* ── ordering ──────────────────────────────────────────────────────────────*/

/** Where a tier sits when rows are sorted by how much they want you. One place,
 *  so the two lists cannot disagree about whether amber outranks rust. Asking
 *  outranks broken deliberately: a fault is a fact that will keep, and a thing
 *  waiting on you is spending somebody's time while it waits. */
const WEIGHT: Record<Tier, number> = { ask: 0, fail: 1, work: 2, soft: 3, rest: 4 };

/** Runs, most worth looking at first.
 *
 * Running before finished, and among the running the *longest* running first —
 * a build twenty minutes in is either nearly done or stuck, and either way it
 * is the one to look at. Among the finished, newest first, which is the
 * ordinary reading of a log. */
export function orderRuns(runs: Run[], now: number): Run[] {
  return [...runs].sort((a, b) => {
    const w = WEIGHT[tierOf(a)] - WEIGHT[tierOf(b)];
    if (w) return w;
    if (running(a) && running(b)) return elapsed(b, now) - elapsed(a, now);
    return (b.finishedAt || b.queuedAt) - (a.finishedAt || a.queuedAt);
  });
}

/** Reviews, most worth looking at first. Within a tier, *oldest* first — the
 *  opposite of the runs list and deliberately so: a stale pull request is worse
 *  than a fresh one, where a stale build is merely history. */
export function orderReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => {
    const w = WEIGHT[reviewTierOf(a)] - WEIGHT[reviewTierOf(b)];
    if (w) return w;
    return a.createdAt - b.createdAt;
  });
}

/* ── counting ──────────────────────────────────────────────────────────────*/

export type Tally = { live: number; failed: number; waiting: number; total: number };

/** The header line's numbers, in one pass. Both faces print a summary and both
 *  would otherwise filter the list three times to get it. */
export function tallyRuns(runs: Run[], now: number): Tally {
  let live = 0;
  let failed = 0;
  for (const r of runs) {
    if (running(r)) live++;
    else if (tierOf(r) === "fail" && now - (r.finishedAt || r.queuedAt) < SETTLING_MS) {
      failed++;
    }
  }
  return { live, failed, waiting: 0, total: runs.length };
}

export function tallyReviews(reviews: Review[]): Tally {
  let waiting = 0;
  let failed = 0;
  for (const r of reviews) {
    if (needsMe(r)) waiting++;
    if (reviewTierOf(r) === "fail") failed++;
  }
  return { live: 0, failed, waiting, total: reviews.length };
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** A ref as it is worth reading on a widget two inches wide.
 *
 * `refs/heads/` and `refs/pull/` are noise on every single row — every branch
 * has one — and what is left is the name somebody actually typed. Tags keep
 * their marker, because a build of a tag and a build of a branch of the same
 * name are different things and the row has no other way to say which.
 *
 * **GitHub sends a bare name and this cannot recover the marker**, which is a
 * real loss rather than an oversight, and it is worth knowing about rather than
 * papering over. `head_branch` on a workflow run is `main` for a branch push and
 * `v0.12.0` for a tag push, with nothing distinguishing them — verified against
 * this repo's own release runs, where the tag build reads as a branch called
 * `v0.12.0`. Guessing from the shape (a leading `v`, a dotted number) was
 * considered and refused: a branch genuinely called `v2` is ordinary, and a row
 * that silently mislabels one is worse than a row that declines to label it.
 * The unprefixed name is returned as it arrived. */
export function shortRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice(11);
  if (ref.startsWith("refs/tags/")) return `tag ${ref.slice(10)}`;
  if (ref.startsWith("refs/pull/")) {
    const n = ref.slice(10).split("/")[0];
    return n ? `pr ${n}` : ref;
  }
  return ref;
}

/** A person as one name. Azure DevOps writes display names out of the
 *  directory, so half of this org reads `Nicholas LIANG - Cloud Admin` — the
 *  suffix is an account type and says nothing about who it is. */
export function shortName(name: string): string {
  const cut = name.split(" - ")[0].trim();
  return cut || name;
}

/** A duration, in words that change about as often as they are worth reading.
 *
 * The same discipline `usage.ts::left` and `Rest.svelte::said` keep: never
 * ticking to the second, because a number you can watch is a number you do
 * watch. Seconds are shown under a minute only — a build in its first minute is
 * the one case where the seconds genuinely move the reading. */
export function took(ms: number): string {
  if (!(ms > 0)) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

/** What the whole list is, in one line, when there is nothing in it.
 *
 * Five different silences, and telling them apart is most of what stops this
 * widget reading as broken. A wall with no Azure DevOps repo on it is not a
 * wall whose pipelines are quiet, and neither is a reading that has not landed
 * yet — which is the state a first poll spends several seconds in.
 *
 * The fifth is `unseen`, and it is the one that would otherwise read as a lie.
 * A credential is scoped to some of an organisation's projects and not others —
 * measured on this org, an `az` sign-in reaches builds in two of six — and Rust
 * counts those rather than faulting on them, because per-project permissions are
 * the shape of somebody's tenant and not an error. But a widget that answers "no
 * recent runs" while it was refused four of the six projects it asked about is
 * telling you something it does not know. Only said when the list is *otherwise*
 * empty: with rows to draw, the rows are the answer. */
export function emptySaid(
  what: "runs" | "reviews",
  ready: boolean,
  orgs: string[],
  scoped: boolean,
  unseen = 0,
): string {
  if (!ready) return "asking…";
  /* Named neither service, now that there are two. "no azure devops repo on this
     wall" was exactly true while there was one forge and became a lie the moment
     a GitHub repo could satisfy the same widget — and the failure mode is the
     worst kind, a sentence that reads as authoritative and sends you looking for
     an Azure DevOps problem you do not have. What the widget actually knows is
     that nothing on this wall has pipelines it can see. */
  if (!orgs.length) return "no repo on this wall with pipelines";
  if (unseen > 0 && !scoped) {
    /* "project" covers an Azure DevOps project and a GitHub repository both,
       which is the same stand-in `Run.project` makes and for the same reason:
       it is the coarsest grouping either forge offers under an organisation. */
    return unseen === 1
      ? "1 project your credential is not on"
      : `${unseen} projects your credential is not on`;
  }
  if (scoped) return what === "runs" ? "nothing running" : "nothing waiting on you";
  return what === "runs" ? "no recent runs" : "no open pull requests";
}
