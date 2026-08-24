/* What Azure DevOps is saying, and what it means.
 *
 * `azdo.rs` answers in facts — a status string, a result string, a vote as a
 * number on someone else's scale — and this file is where all of that becomes
 * something a wall can be read from. The same split `perf.rs`/`perf.ts` and
 * `usage.rs`/`usage.ts` draw, and the same argument: a taxonomy is knowledge
 * about a service, and knowledge is testable without a browser.
 *
 * So this file holds essentially all Azure-DevOps-specific knowledge, the way
 * `classify.ts` holds all Claude-specific knowledge: the status vocabulary, the
 * vote scale, what a merge status means, how a run is ordered against another
 * one, and what any of it is called in prose. If a second forge ever matters —
 * GitHub checks, GitLab pipelines — this is the file that grows an interface.
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

export type Run = {
  id: string;
  org: string;
  project: string;
  pipeline: string;
  number: string;
  /** `notStarted` | `inProgress` | `completed` | `cancelling` | `postponed`. */
  status: string;
  /** `succeeded` | `partiallySucceeded` | `failed` | `canceled`, or empty. */
  result: string;
  /** `refs/heads/main`, verbatim. */
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
  return r.status !== "completed";
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

/** How a run is said, in the fewest words that are still true. */
export function runSaid(r: Run): string {
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
 * name are different things and the row has no other way to say which. */
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
  if (!ready) return "asking azure devops…";
  if (!orgs.length) return "no azure devops repo on this wall";
  if (unseen > 0 && !scoped) {
    return unseen === 1
      ? "1 project your credential is not on"
      : `${unseen} projects your credential is not on`;
  }
  if (scoped) return what === "runs" ? "nothing running" : "nothing waiting on you";
  return what === "runs" ? "no recent runs" : "no open pull requests";
}
