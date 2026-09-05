import { describe, expect, test } from "bun:test";

import {
  RESUME_CAP,
  RESUME_FAILED_CAP,
  ROUSE_GAP_MS,
  isJobsPrompt,
  isResumePrompt,
  unansweredRousePrompt,
  ALREADY_ROUSED_NOTE,
  jobsLines,
  jobsPrompt,
  resumePrompt,
  rouseOrder,
} from "../src/lib/rousing";

/** A card, as much of one as the ordering reads. */
const card = (id: string, dormant: boolean, interrupted = false) => ({
  id,
  dormant,
  interrupted,
});

describe("rouseOrder", () => {
  test("a card with a process is left alone", () => {
    const awake = card("a", false);
    expect(rouseOrder([awake, card("b", true)]).map((c) => c.id)).toEqual(["b"]);
  });

  test("the ones that lost a turn go first", () => {
    const order = rouseOrder([
      card("quiet-1", true),
      card("lost", true, true),
      card("quiet-2", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["lost", "quiet-1", "quiet-2"]);
  });

  test("everything else keeps the wall's own order", () => {
    const order = rouseOrder([
      card("a", true),
      card("b", true),
      card("c", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("an interrupted card that is somehow already awake is not woken twice", () => {
    /* Not a hypothetical: the queue re-reads `dormant` when a card's turn comes
       up, and by then you may have spoken to it yourself. Whatever this returns
       is a list of spawn calls, and a spawn against a live child is an error. */
    expect(rouseOrder([card("a", false, true)])).toEqual([]);
  });

  test("a card put by is left where you put it", () => {
    /* `aside` says stop counting this as waiting. Handing it a process back at
       every launch is that instruction ignored — including when it lost a turn,
       since setting a card aside mid-turn is the gesture that says not now. */
    const order = rouseOrder([
      { id: "put-by", dormant: true, interrupted: false, aside: true },
      { id: "put-by-mid-turn", dormant: true, interrupted: true, aside: true },
      { id: "ordinary", dormant: true, interrupted: false },
    ]);
    expect(order.map((c) => c.id)).toEqual(["ordinary"]);
  });

  test("nothing on the wall is nothing to do", () => {
    expect(rouseOrder([])).toEqual([]);
  });

  /* The strongest thing setting a card aside means. Rousing spawns a process
     per dormant card; a card put by for later is exactly one you have said you
     are not carrying on with, so giving it a process back at every launch is
     that instruction ignored. */
  test("a card set aside is left where it was put", () => {
    const order = rouseOrder([
      { ...card("parked", true), aside: true },
      card("ordinary", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["ordinary"]);
  });

  test("and set aside outranks having lost a turn", () => {
    /* Setting a card aside mid-turn is precisely the gesture that says "not
       this, not now" — so it must not be resumed with the rest of them. */
    const order = rouseOrder([
      { ...card("parked", true, true), aside: true },
      card("lost", true, true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["lost"]);
  });

  test("the order is a new list — the wall's own is not reshuffled", () => {
    const cards = [card("a", true), card("lost", true, true)];
    rouseOrder(cards);
    expect(cards.map((c) => c.id)).toEqual(["a", "lost"]);
  });
});

describe("the pacing", () => {
  test("there is a gap, and it is not so long the wall never finishes", () => {
    expect(ROUSE_GAP_MS).toBeGreaterThan(0);
    expect(ROUSE_GAP_MS).toBeLessThanOrEqual(2000);
  });
});

describe("resumePrompt", () => {
  const p = resumePrompt();

  test("it says why it is speaking", () => {
    expect(p).toContain("skein closed");
  });

  test("it sends the agent to look before it carries on", () => {
    expect(p).toContain("git status");
  });

  test("it says to stop rather than guess", () => {
    /* The load-bearing half. An agent that guesses at its own half-finished
       work produces something that looks finished, which is worse than the
       question it should have asked. */
    expect(p.toLowerCase()).toContain("stop");
    expect(p.toLowerCase()).toContain("guess");
  });

  test("it is wrapped, because the panel renders GFM breaks", () => {
    for (const line of p.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("the cap it wears folded says who is talking", () => {
    expect(RESUME_CAP).toContain("skein");
    expect(RESUME_FAILED_CAP).toContain("skein");
  });

  test("the cap is short enough to stand in a third of a window", () => {
    /* It is drawn `nowrap` with an ellipsis, so anything past about here is a
       cap that says "resumed by skein — the turn was cu…". */
    expect(RESUME_CAP.length).toBeLessThanOrEqual(48);
    expect(RESUME_FAILED_CAP.length).toBeLessThanOrEqual(48);
  });
});

describe("isResumePrompt", () => {
  test("it knows its own prompt", () => {
    expect(isResumePrompt(resumePrompt())).toBe(true);
  });

  test("it survives the prompt being rewritten below the first line", () => {
    /* Anchored rather than compared whole, so every transcript already on disk
       goes on folding when a sentence in the middle of it is edited. */
    const head = resumePrompt().split("\n").slice(0, 3).join("\n");
    expect(isResumePrompt(head + "\n" + "and something else entirely")).toBe(true);
  });

  test("something you typed is not it", () => {
    expect(isResumePrompt("carry on")).toBe(false);
    expect(isResumePrompt("")).toBe(false);
  });

  test("an agent quoting it back is not it", () => {
    /* Anchored to the start: the prompt inside a sentence is speech about the
       prompt, and speech does not fold. */
    expect(isResumePrompt(`skein told me: ${resumePrompt()}`)).toBe(false);
  });
});

/** A lost job, as much of one as the prompts read. */
const lost = (
  label: string,
  outputPath: string | null = null,
  startedAt = 0,
) => ({ toolId: `t-${label}`, label, kind: "shell", outputPath, startedAt });

describe("jobsLines", () => {
  const NOW = 3_600_000; // one hour past the epoch, so `ago` has room

  test("names the job, its kind, when it started and where to read it", () => {
    const [line] = jobsLines(
      [lost("import-write", "C:/tmp/import-write.out", NOW - 25 * 60_000)],
      NOW,
    );
    expect(line).toContain("import-write");
    expect(line).toContain("shell");
    expect(line).toContain("25m ago");
    expect(line).toContain("C:/tmp/import-write.out");
  });

  test("says so plainly when there is nowhere to look", () => {
    /* A path is only ever handed over when a file is really at it, so this is
       the ordinary case for a Monitor and for anything whose output the
       machine has since cleaned up — and an agent sent to read a file that is
       not there reads that as the work having vanished. */
    const [line] = jobsLines([lost("watching ci", null, NOW)], NOW);
    expect(line).toContain("no output file was kept");
    expect(line).not.toContain("output at");
  });

  test("the age is rounded, not precise, and reads in the wall's register", () => {
    expect(jobsLines([lost("a", null, NOW)], NOW)[0]).toContain("just now");
    expect(jobsLines([lost("a", null, NOW - 90 * 60_000)], NOW)[0]).toContain(
      "1h 30m ago",
    );
    expect(jobsLines([lost("a", null, NOW - 120 * 60_000)], NOW)[0]).toContain(
      "2h ago",
    );
  });

  test("one line per job, in the order given", () => {
    const lines = jobsLines([lost("first"), lost("second")], NOW);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second");
  });
});

describe("jobsPrompt", () => {
  test("carries every job, and tells the agent to check rather than redo", () => {
    const text = jobsPrompt([lost("import-write", "C:/tmp/x.out", 0)], 60_000);
    expect(text).toContain("import-write");
    expect(text).toContain("C:/tmp/x.out");
    /* The two states are far apart — orphaned-and-finished, or killed part-way
       — and only looking tells them apart. A prompt that assumed either would
       be wrong half the time, and the expensive half re-runs a database write
       that already landed. */
    expect(text).toMatch(/check what actually happened/);
    expect(text).toContain("before re-running anything that writes");
  });

  test("it does not claim the turn was cut off", () => {
    /* This is the case where the turn ended perfectly well and only the *work*
       outlived the process. Sending a card looking for a half-written file it
       never had is the failure this wording exists to avoid. */
    const text = jobsPrompt([lost("a")], 0);
    expect(text).not.toContain("part-way through a turn");
    expect(isResumePrompt(text)).toBe(false);
  });

  test("it says who is speaking, like the other three app-composed prompts", () => {
    /* The invariant `7585a431` was decided against: every prompt the app sends
       on its own behalf names skein, so a card can tell it from something you
       typed. Asserted here because this was the only one of the four that never
       said so anywhere. */
    expect(jobsPrompt([lost("a")], 0)).toContain("skein");
  });

  test("it asks for a tail rather than the whole log", () => {
    /* A subagent's output file is its entire transcript, and a build log is
       megabytes. The agent is trusted to choose, but the default is named. */
    expect(jobsPrompt([lost("a")], 0)).toMatch(/tail.*grep|grep.*tail/);
  });
});

describe("isJobsPrompt", () => {
  test("recognises its own prompt, so both folds agree", () => {
    expect(isJobsPrompt(jobsPrompt([lost("a")], 0))).toBe(true);
  });

  test("and tells the two prompts apart", () => {
    /* They fold to different caps: one says the turn was cut off, the other
       that the turn was fine and the work was not. */
    expect(isJobsPrompt(resumePrompt())).toBe(false);
    expect(isResumePrompt(jobsPrompt([lost("a")], 0))).toBe(false);
  });

  test("a card quoting one has not been sent one", () => {
    expect(isJobsPrompt(`it said: ${jobsPrompt([lost("a")], 0)}`)).toBe(false);
  });
});

describe("resumePrompt carrying lost jobs", () => {
  test("with none, it is exactly what it always was", () => {
    expect(resumePrompt([], 0)).toBe(resumePrompt());
  });

  test("with some, it names them and stays a resume prompt", () => {
    const text = resumePrompt([lost("suite", "C:/tmp/suite.out", 0)], 60_000);
    expect(text).toContain("suite");
    expect(text).toContain("C:/tmp/suite.out");
    /* Both facts are true of this card and it gets one prompt, not two — so
       the cap has to stay the one that says the turn was cut off. */
    expect(isResumePrompt(text)).toBe(true);
    expect(text).toContain("pick the work back up");
  });
});

/* ── not sending what the session already holds ────────────────────────────
 *
 * A rouse prompt goes down the child's stdin like anything you type, so the CLI
 * records it as an ordinary `user` message and `--resume` puts it back in front
 * of the model. A card sent one that died before answering therefore comes back
 * already holding it — and the rouse that follows composed a second, identical
 * copy and sent it beside the first. Sink `01e00f30`. */
describe("unansweredRousePrompt", () => {
  const you = (text: string) => ({ kind: "you", text });
  const said = (text: string) => ({ kind: "text", text });
  const resume = you(resumePrompt());
  const jobsy = you(jobsPrompt([lost("a")], 0));

  test("nothing to guard against on an ordinary transcript", () => {
    expect(unansweredRousePrompt([])).toBeNull();
    expect(unansweredRousePrompt([you("go"), said("done")])).toBeNull();
  });

  test("a prompt nothing answered is one the model already has", () => {
    expect(unansweredRousePrompt([said("earlier"), resume])).toBe("resume");
    expect(unansweredRousePrompt([said("earlier"), jobsy])).toBe("jobs");
  });

  test("speech settles it — the turn it opened happened", () => {
    /* And a later crash is a *new* turn, which is worth a new prompt. Without
       this the guard would fire for the rest of the session's life and a card
       genuinely cut off would come back to nothing. */
    expect(unansweredRousePrompt([resume, said("looked, carried on")])).toBeNull();
    expect(unansweredRousePrompt([resume, { kind: "tool", text: "git status" }])).toBeNull();
  });

  test("a prompt queued behind it does not answer it", () => {
    /* Your own words, a note, a message from another card: all of them are
       things sitting in the queue in front of an agent that has still not
       spoken since the resume prompt arrived. */
    expect(unansweredRousePrompt([resume, you("go")])).toBe("resume");
    expect(unansweredRousePrompt([resume, { kind: "meta", text: "swapped" }])).toBe("resume");
    expect(unansweredRousePrompt([resume, { kind: "relay", text: "from a card" }])).toBe("resume");
  });

  test("the newest unanswered one wins, whichever it is", () => {
    expect(unansweredRousePrompt([said("x"), resume, jobsy])).toBe("jobs");
    expect(unansweredRousePrompt([said("x"), jobsy, resume])).toBe("resume");
  });

  test("an agent quoting one has not been sent one", () => {
    /* Same bargain `isResumePrompt` strikes, inherited: the test is anchored to
       the first line, so speech about the prompt is not the prompt. */
    expect(unansweredRousePrompt([you(`it said: ${resumePrompt()}`)])).toBeNull();
  });

  test("the note says who did what, in the cap's own register", () => {
    expect(ALREADY_ROUSED_NOTE).toContain("skein");
    expect(ALREADY_ROUSED_NOTE).toBe(ALREADY_ROUSED_NOTE.toLowerCase());
  });
});
