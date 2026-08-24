import { describe, expect, test } from "bun:test";
import {
  APPROVED,
  APPROVED_WITH_SUGGESTIONS,
  NO_VOTE,
  REJECTED,
  SETTLING_MS,
  WAITING_FOR_AUTHOR,
  elapsed,
  emptySaid,
  landable,
  needsMe,
  orderReviews,
  orderRuns,
  reviewSaid,
  reviewTierOf,
  runSaid,
  running,
  scopeReviews,
  scopeRuns,
  shortName,
  shortRef,
  tallyReviews,
  tallyRuns,
  tierOf,
  took,
  voteSaid,
  type Review,
  type Run,
  type Vote,
} from "../src/lib/azdo";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const MIN = 60_000;

/** A run, with only the fields a case cares about spelled out. Defaults to a
 *  build that passed a minute ago, which is the least interesting row there is
 *  and therefore the right thing to vary from. */
function run(over: Partial<Run> = {}): Run {
  return {
    id: "org/proj/1",
    org: "LagardereAWPL",
    project: "NOVA",
    pipeline: "NOVA CI",
    number: "20260814.1",
    status: "completed",
    result: "succeeded",
    branch: "refs/heads/main",
    by: "Lyss DELPRAT",
    queuedAt: NOW - 5 * MIN,
    startedAt: NOW - 5 * MIN,
    finishedAt: NOW - MIN,
    url: "https://dev.azure.com/x",
    mine: false,
    ...over,
  };
}

function vote(over: Partial<Vote> = {}): Vote {
  return { by: "Tom MIU", vote: NO_VOTE, required: false, ...over };
}

function review(over: Partial<Review> = {}): Review {
  return {
    id: "org/repo/1",
    org: "LagardereAWPL",
    project: "RISE",
    repo: "RISE",
    number: 724,
    title: "fix(reporting): issue search",
    by: "RISE Agent",
    draft: false,
    merge: "succeeded",
    target: "refs/heads/main",
    createdAt: NOW - 24 * 60 * MIN,
    url: "https://dev.azure.com/x",
    auto: false,
    mine: false,
    reviewing: false,
    myVote: NO_VOTE,
    votes: [],
    ...over,
  };
}

describe("what a run is", () => {
  test("anything not completed is still going, cancelling and postponed included", () => {
    /* The two that look finished and are not: a build being cancelled is still
       holding an agent, and a postponed one is still going to happen. */
    expect(running(run({ status: "inProgress", result: "" }))).toBe(true);
    expect(running(run({ status: "notStarted", result: "" }))).toBe(true);
    expect(running(run({ status: "cancelling", result: "" }))).toBe(true);
    expect(running(run({ status: "postponed", result: "" }))).toBe(true);
    expect(running(run())).toBe(false);
  });

  test("a running build is celadon whatever result it is carrying", () => {
    expect(tierOf(run({ status: "inProgress", result: "" }))).toBe("work");
    /* A retried build can arrive in progress with the previous result still on
       it, and it must read as running rather than as the old failure. */
    expect(tierOf(run({ status: "inProgress", result: "failed" }))).toBe("work");
  });

  test("partiallySucceeded is amber, not rust", () => {
    /* The load-bearing one. It means the build worked and something
       non-blocking did not, so the fault colour would be a lie about a
       pipeline that produced an artifact — but it is not nothing either. */
    expect(tierOf(run({ result: "partiallySucceeded" }))).toBe("soft");
    expect(tierOf(run({ result: "failed" }))).toBe("fail");
  });

  test("a cancelled build is at rest, like a stopped card", () => {
    /* Nothing went wrong and somebody did it on purpose — the same argument
       `stopped` makes in classify.ts. Note the wire spelling. */
    expect(tierOf(run({ result: "canceled" }))).toBe("rest");
    expect(runSaid(run({ result: "canceled" }))).toBe("cancelled");
  });

  test("a completed run with no result is muted, never a fault", () => {
    /* An unrecognised state is not a failed one, and a widget that invents
       faults is a widget you stop trusting. */
    expect(tierOf(run({ result: "" }))).toBe("rest");
    expect(tierOf(run({ result: "somethingNew" }))).toBe("rest");
  });

  test("status outranks result when saying what it is", () => {
    expect(runSaid(run({ status: "notStarted", result: "" }))).toBe("queued");
    expect(runSaid(run({ status: "inProgress", result: "" }))).toBe("running");
    expect(runSaid(run({ status: "cancelling", result: "" }))).toBe("stopping");
    expect(runSaid(run({ status: "postponed", result: "" }))).toBe("held");
    expect(runSaid(run({ result: "succeeded" }))).toBe("passed");
    expect(runSaid(run({ result: "failed" }))).toBe("failed");
  });
});

describe("how long a run has taken", () => {
  test("a running build is measured to now", () => {
    const r = run({ status: "inProgress", result: "", startedAt: NOW - 3 * MIN, finishedAt: 0 });
    expect(elapsed(r, NOW)).toBe(3 * MIN);
  });

  test("a finished build is measured to its finish, not to now", () => {
    expect(elapsed(run(), NOW)).toBe(4 * MIN);
    /* And stays put as time passes — the whole point of not measuring to now. */
    expect(elapsed(run(), NOW + 60 * MIN)).toBe(4 * MIN);
  });

  test("a queued build is measured from the queue, which is its wait", () => {
    /* It has no start time at all, and the zero would be a reading rather than
       an absence. What is useful before a build starts is how long it has been
       waiting. */
    const r = run({ status: "notStarted", result: "", startedAt: 0, finishedAt: 0 });
    expect(elapsed(r, NOW)).toBe(5 * MIN);
  });

  test("a run with no times at all reads zero rather than an epoch", () => {
    const r = run({ queuedAt: 0, startedAt: 0, finishedAt: 0, status: "notStarted" });
    expect(elapsed(r, NOW)).toBe(0);
  });
});

describe("the vote scale", () => {
  test("every rung reads as itself", () => {
    expect(voteSaid(APPROVED)).toBe("approved");
    expect(voteSaid(APPROVED_WITH_SUGGESTIONS)).toBe("approved with suggestions");
    expect(voteSaid(NO_VOTE)).toBe("no vote");
    expect(voteSaid(WAITING_FOR_AUTHOR)).toBe("waiting on the author");
    expect(voteSaid(REJECTED)).toBe("rejected");
  });
});

describe("is a pull request waiting on me", () => {
  test("asked, has not answered, did not write it", () => {
    expect(needsMe(review({ reviewing: true }))).toBe(true);
  });

  test("a pull request I opened is not waiting on me, even listed as a reviewer", () => {
    /* Probed 2026-08-14: four of this org's eight open PRs had their own author
       down as a *required* reviewer, because that is what the branch policy
       adds. Counting those would make the "wants you" list mostly your own
       work. */
    expect(needsMe(review({ reviewing: true, mine: true }))).toBe(false);
  });

  test("a vote already cast settles it, whichever way it went", () => {
    expect(needsMe(review({ reviewing: true, myVote: APPROVED }))).toBe(false);
    /* Rejecting it puts the ball with the author, so it is no longer yours. */
    expect(needsMe(review({ reviewing: true, myVote: REJECTED }))).toBe(false);
  });

  test("a draft asks nobody for anything", () => {
    expect(needsMe(review({ reviewing: true, draft: true }))).toBe(false);
  });

  test("not being on it at all is not being waited on", () => {
    expect(needsMe(review({ reviewing: false }))).toBe(false);
  });
});

describe("what a pull request is", () => {
  test("conflicts are the fault colour, and outrank wanting you", () => {
    /* The same fact a torn territory draws, arriving by a different route. */
    const r = review({ merge: "conflicts", reviewing: true });
    expect(reviewTierOf(r)).toBe("fail");
    expect(reviewSaid(r)).toBe("conflicts");
  });

  test("blocked by policy is a fault too — it needs a decision, not a wait", () => {
    expect(reviewTierOf(review({ merge: "rejectedByPolicy" }))).toBe("fail");
  });

  test("a draft is muted whatever else is true of it", () => {
    /* Including conflicted: it is not asking anybody for anything yet. */
    expect(reviewTierOf(review({ draft: true, merge: "conflicts" }))).toBe("rest");
    expect(reviewTierOf(review({ draft: true, reviewing: true }))).toBe("rest");
  });

  test("one waiting on me is amber", () => {
    expect(reviewTierOf(review({ reviewing: true }))).toBe("ask");
  });

  test("mine with changes asked warms rather than breaking", () => {
    const r = review({ mine: true, votes: [vote({ vote: WAITING_FOR_AUTHOR })] });
    expect(reviewTierOf(r)).toBe("soft");
    expect(reviewSaid(r)).toBe("changes asked");
  });

  test("mine and ready to land warms too — it is sitting there", () => {
    const r = review({ mine: true, votes: [vote({ vote: APPROVED, required: true })] });
    expect(reviewTierOf(r)).toBe("soft");
    expect(reviewSaid(r)).toBe("ready");
  });

  test("somebody else's, open, unremarkable, says nothing", () => {
    expect(reviewTierOf(review())).toBe("rest");
    expect(reviewSaid(review())).toBe(null);
  });
});

describe("can it land", () => {
  test("only required reviewers count", () => {
    /* A PR held open for a courtesy reviewer on leave is not blocked, and
       counting them would mean nothing is ever ready. */
    const r = review({
      votes: [vote({ vote: APPROVED, required: true }), vote({ vote: NO_VOTE, required: false })],
    });
    expect(landable(r)).toBe(true);
  });

  test("approved with suggestions is an approval", () => {
    expect(
      landable(review({ votes: [vote({ vote: APPROVED_WITH_SUGGESTIONS, required: true })] })),
    ).toBe(true);
  });

  test("one required reviewer who has not voted holds it", () => {
    expect(landable(review({ votes: [vote({ vote: NO_VOTE, required: true })] }))).toBe(false);
  });

  test("a rejection holds it even if everyone else approved", () => {
    const r = review({
      votes: [vote({ vote: APPROVED, required: true }), vote({ vote: REJECTED, required: true })],
    });
    expect(landable(r)).toBe(false);
  });

  test("no approval policy at all lands on the build alone", () => {
    expect(landable(review({ votes: [] }))).toBe(true);
  });

  test("a conflicted or draft PR cannot land whatever the votes say", () => {
    const votes = [vote({ vote: APPROVED, required: true })];
    expect(landable(review({ votes, merge: "conflicts" }))).toBe(false);
    expect(landable(review({ votes, draft: true }))).toBe(false);
  });
});

describe("narrowing what is shown", () => {
  test("live keeps a run that has only just failed", () => {
    /* The reason `live` is not a strict in-progress filter: a pipeline that
       failed ninety seconds ago is the most useful row this widget can draw,
       and it must not vanish at the moment it matters. */
    const justFailed = run({ result: "failed", finishedAt: NOW - 90_000 });
    const old = run({ finishedAt: NOW - SETTLING_MS - MIN });
    const going = run({ status: "inProgress", result: "", finishedAt: 0 });
    const kept = scopeRuns([justFailed, old, going], "live", NOW);
    expect(kept).toHaveLength(2);
    expect(kept).not.toContain(old);
  });

  test("mine is mine whether it is running or not", () => {
    const mine = run({ mine: true, status: "inProgress", result: "" });
    const old = run({ mine: true, finishedAt: NOW - 10 * SETTLING_MS });
    const theirs = run({ mine: false });
    expect(scopeRuns([mine, old, theirs], "mine", NOW)).toEqual([mine, old]);
  });

  test("all is everything", () => {
    const rows = [run(), run({ mine: true })];
    expect(scopeRuns(rows, "all", NOW)).toHaveLength(2);
  });

  test("mine reviews covers both directions of involvement", () => {
    /* A view of only what you wrote cannot tell you somebody is waiting on
       you, and that is the half that matters. */
    const wrote = review({ mine: true });
    const asked = review({ reviewing: true });
    const neither = review();
    expect(scopeReviews([wrote, asked, neither], "mine")).toEqual([wrote, asked]);
  });

  test("waiting is only what is waiting on me", () => {
    const wrote = review({ mine: true });
    const asked = review({ reviewing: true });
    expect(scopeReviews([wrote, asked], "waiting")).toEqual([asked]);
  });
});

describe("ordering", () => {
  test("asking outranks broken", () => {
    /* A fault is a fact that will keep; a thing waiting on you is spending
       somebody's time while it waits. */
    const broken = review({ merge: "conflicts" });
    const wants = review({ reviewing: true });
    expect(orderReviews([broken, wants])[0]).toBe(wants);
  });

  test("among the running, the longest running comes first", () => {
    /* Twenty minutes in is either nearly done or stuck, and either way it is
       the one to look at. */
    const brief = run({ status: "inProgress", result: "", startedAt: NOW - MIN, finishedAt: 0 });
    const long = run({
      status: "inProgress",
      result: "",
      startedAt: NOW - 20 * MIN,
      finishedAt: 0,
    });
    expect(orderRuns([brief, long], NOW)[0]).toBe(long);
  });

  test("among the finished, newest first", () => {
    const older = run({ finishedAt: NOW - 30 * MIN });
    const newer = run({ finishedAt: NOW - MIN });
    expect(orderRuns([older, newer], NOW)[0]).toBe(newer);
  });

  test("reviews go oldest first within a tier — a stale one is worse", () => {
    /* Deliberately the opposite of the runs list: a stale pull request is a
       problem, where a stale build is merely history. */
    const old = review({ reviewing: true, createdAt: NOW - 30 * 24 * 60 * MIN });
    const fresh = review({ reviewing: true, createdAt: NOW - 60 * MIN });
    expect(orderReviews([fresh, old])[0]).toBe(old);
  });

  test("neither ordering mutates what it was given", () => {
    const runs = [run({ id: "a" }), run({ id: "b", status: "inProgress", result: "" })];
    const before = runs.map((r) => r.id);
    orderRuns(runs, NOW);
    expect(runs.map((r) => r.id)).toEqual(before);
  });
});

describe("counting", () => {
  test("runs count what is live and what has just broken", () => {
    const t = tallyRuns(
      [
        run({ status: "inProgress", result: "", finishedAt: 0 }),
        run({ result: "failed", finishedAt: NOW - MIN }),
        /* Old enough that it is history rather than news. */
        run({ result: "failed", finishedAt: NOW - SETTLING_MS - MIN }),
        run(),
      ],
      NOW,
    );
    expect(t).toEqual({ live: 1, failed: 1, waiting: 0, total: 4 });
  });

  test("reviews count what wants you and what is broken", () => {
    const t = tallyReviews([
      review({ reviewing: true }),
      review({ merge: "conflicts" }),
      review(),
    ]);
    expect(t).toEqual({ live: 0, failed: 1, waiting: 1, total: 3 });
  });
});

describe("saying it", () => {
  test("a ref loses its plumbing but a tag keeps its marker", () => {
    /* A build of a tag and a build of a branch of the same name are different
       things, and the row has no other way to say which. */
    expect(shortRef("refs/heads/main")).toBe("main");
    expect(shortRef("refs/heads/feat/thing")).toBe("feat/thing");
    expect(shortRef("refs/tags/v1.2.0")).toBe("tag v1.2.0");
    expect(shortRef("refs/pull/715/merge")).toBe("pr 715");
    expect(shortRef("main")).toBe("main");
  });

  test("a directory display name loses its account type", () => {
    /* Half this org reads like this, and the suffix says nothing about who it
       is. */
    expect(shortName("Nicholas LIANG - Cloud Admin")).toBe("Nicholas LIANG");
    expect(shortName("Lyss DELPRAT")).toBe("Lyss DELPRAT");
    expect(shortName("")).toBe("");
  });

  test("a duration only shows seconds while seconds still move the reading", () => {
    expect(took(0)).toBe("just now");
    expect(took(45_000)).toBe("45s");
    expect(took(4 * MIN)).toBe("4m");
    expect(took(90 * MIN)).toBe("1h 30m");
    expect(took(120 * MIN)).toBe("2h");
    expect(took(3 * 24 * 60 * MIN)).toBe("3d");
    expect(took(21 * 24 * 60 * MIN)).toBe("3w");
  });

  test("the four silences are four different sentences", () => {
    /* Telling them apart is most of what stops this widget reading as broken:
       a wall with no AzDO repo is not a wall whose pipelines are quiet. */
    expect(emptySaid("runs", false, [], false)).toBe("asking azure devops…");
    expect(emptySaid("runs", true, [], false)).toBe("no azure devops repo on this wall");
    expect(emptySaid("runs", true, ["org"], true)).toBe("nothing running");
    expect(emptySaid("runs", true, ["org"], false)).toBe("no recent runs");
    expect(emptySaid("reviews", true, ["org"], true)).toBe("nothing waiting on you");
    expect(emptySaid("reviews", true, ["org"], false)).toBe("no open pull requests");
  });

  test("projects the credential is not on are the fifth silence", () => {
    /* Measured on this org: an `az` sign-in reaches builds in two of six
       projects and is told the other four do not exist. Rust counts those
       rather than faulting, since per-project permissions are the shape of a
       tenant and not an error — but "no recent runs" over four projects that
       refused to answer is the widget claiming to know something it does not. */
    expect(emptySaid("runs", true, ["org"], false, 4)).toBe(
      "4 projects your credential is not on",
    );
    /* Singular, because one is the commonest count and "1 projects" is the
       kind of thing that makes a reading look machine-generated. */
    expect(emptySaid("runs", true, ["org"], false, 1)).toBe(
      "1 project your credential is not on",
    );

    /* Not said when the reading has not landed or there is no org — those are
       about the whole pass and outrank a per-project detail. */
    expect(emptySaid("runs", false, ["org"], false, 4)).toBe("asking azure devops…");
    expect(emptySaid("runs", true, [], false, 4)).toBe("no azure devops repo on this wall");

    /* And not under a scope, where the emptiness has a nearer explanation: you
       asked for what is live and nothing is. Saying the credential is short of
       projects there would blame the wrong thing for an empty list. */
    expect(emptySaid("runs", true, ["org"], true, 4)).toBe("nothing running");

    /* Zero is the ordinary case and must read exactly as it did before. */
    expect(emptySaid("runs", true, ["org"], false, 0)).toBe("no recent runs");
    expect(emptySaid("runs", true, ["org"], false)).toBe("no recent runs");
  });
});
