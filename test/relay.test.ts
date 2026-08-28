import { describe, expect, test } from "bun:test";
import {
  RELAY_MARK,
  WAKE_MARK,
  handleOf,
  isRelayPrompt,
  isWakePrompt,
  relayBody,
  relayCap,
  relayFrom,
} from "../src/lib/relay";
import { isResumePrompt } from "../src/lib/rousing";

/* Written by hand rather than imported, because the other end of this is in
 * Rust and there is nothing to import. It is a transcription of
 * `relay::envelope`, and the two agreeing is the whole contract — a change to
 * either that is not made to both is a message drawn as something you typed. */
const envelope = (name: string, handle: string, project: string, body: string) =>
  `${RELAY_MARK} from "${name}" (${handle}) in ${project} —\n\n${body}\n\n` +
  "(This came from another agent on the Skein wall, not from the user. " +
  "Act on it if it bears on your work, reply with the `send` tool if it " +
  "needs an answer, and say nothing back if it does not.)";

const orphaned = (handle: string, body: string) =>
  `${RELAY_MARK} from a card that has since been closed (${handle}) —\n\n${body}`;

const sample = envelope(
  "store schema",
  "aaaaaaaa",
  "skein",
  "I have taken v14 for the relay table. Rebase before you add a migration.",
);

describe("recognising one", () => {
  test("knows the envelope Rust writes", () => {
    expect(isRelayPrompt(sample)).toBe(true);
    expect(isRelayPrompt(orphaned("bbbbbbbb", "hello"))).toBe(true);
  });

  test("and nothing else", () => {
    expect(isRelayPrompt("have a look at store.rs")).toBe(false);
    expect(isRelayPrompt("")).toBe(false);
    /* The nearest neighbour: the other line in this app that is drawn in a
       register nobody typed it in. Neither may claim the other's. */
    expect(
      isRelayPrompt(
        "You were part-way through a turn when Skein closed. Pick it back up.",
      ),
    ).toBe(false);
    expect(isResumePrompt(sample)).toBe(false);
  });
});

describe("who it came from", () => {
  test("the name, the handle and the project", () => {
    expect(relayFrom(sample)).toEqual({
      name: "store schema",
      handle: "aaaaaaaa",
      project: "skein",
    });
  });

  test("a sender closed since keeps its handle, which is all there is left", () => {
    const f = relayFrom(orphaned("bbbbbbbb", "hello"))!;
    expect(f.handle).toBe("bbbbbbbb");
    expect(f.project).toBeNull();
  });

  /* Degrading rather than refusing, the bargain `normalizeAsk` strikes: a
     header this build cannot parse is still a message the agent was given and
     acted on. Redrawing it as something you typed is the one outcome that is
     not allowed — it is the entire reason this file exists. */
  test("a header from some later build is still a relay, from nobody", () => {
    const odd = `${RELAY_MARK} sent 2026-08-19 by aaaaaaaa via skein\n\nwhat?`;
    expect(isRelayPrompt(odd)).toBe(true);
    expect(relayFrom(odd)!.name).toBe("another card");
  });

  test("something that is not one is nobody at all", () => {
    expect(relayFrom("just a prompt")).toBeNull();
  });
});

describe("the body", () => {
  test("is the message, without the header or the note to the model", () => {
    expect(relayBody(sample)).toBe(
      "I have taken v14 for the relay table. Rebase before you add a migration.",
    );
    expect(relayBody(sample)).not.toContain("not from the user");
  });

  test("survives a message with blank lines and parentheses in it", () => {
    const body = "two things:\n\n- store.rs (v14)\n\n- and the ladder in STEPS";
    expect(relayBody(envelope("a", "aaaaaaaa", "skein", body))).toBe(body);
  });

  test("a message that itself ends in a note is not eaten by it", () => {
    const body = "done\n\n(this parenthesis is mine)";
    expect(relayBody(envelope("a", "aaaaaaaa", "skein", body))).toBe(body);
  });

  test("leaves anything that is not a relay exactly as it is", () => {
    expect(relayBody("a plain prompt")).toBe("a plain prompt");
  });
});

describe("the fold's cap", () => {
  /* `nowrap` with an ellipsis in a panel a third of a window wide — the same
     constraint `RESUME_CAP` is written to. It names the sender, because a
     cut-off first sentence names nothing. */
  test("names the sender and is short enough to read", () => {
    expect(relayCap(sample)).toBe("from store schema");
    expect(relayCap(sample).length).toBeLessThan(40);
  });

  test("says something even for an envelope it could not read", () => {
    expect(relayCap(`${RELAY_MARK} ???`)).toBe("from another card");
  });
});

/* The fourth shape, and the only one with no author at all: the wall telling a
 * parent that cards it opened have stopped. Transcribed from `spawn::envelope`
 * the same way `envelope` above transcribes `relay::envelope` — the two ends
 * agreeing is the whole contract, and there is nothing to import across it. */
const settled = (what: string) =>
  `${RELAY_MARK} from the wall —\n\n${what}\n\n` +
  "(This came from the wall rather than from anybody, so nobody is waiting on " +
  "a reply and there is nothing to acknowledge.)";

describe("a notice from the wall", () => {
  const one = settled('A card you opened has stopped: "roster tiering" (3f08dc99). 2 of your 9 are still working.');

  test("is drawn as not-you, like every other thing wearing this mark", () => {
    expect(isRelayPrompt(one)).toBe(true);
  });

  /* The point of the fourth shape. Falling through to the catch-all would say
     "from another card", which is the panel inventing an author for a line that
     has none — the one thing this file exists to stop, in a new dress. */
  test("names the wall rather than inventing a card", () => {
    expect(relayFrom(one)).toEqual({ name: "the wall", handle: "", project: null });
    expect(relayCap(one)).toBe("from the wall");
  });

  test("keeps what it says and drops the note addressed to the model", () => {
    expect(relayBody(one)).toBe(
      'A card you opened has stopped: "roster tiering" (3f08dc99). 2 of your 9 are still working.',
    );
  });
});

/* The fifth shape, and the only one under the other mark: a note you left
 * yourself, handed back when the time came. Transcribed from `later::envelope`
 * — which is the whole contract, since the string is written by Rust and read
 * here and there is nothing to import across it. If that format changes, the
 * `WAKE` regex degrades to "you, earlier" rather than to "you typed this", and
 * the last test below is what pins that. */
const woken = (ago: string, note: string) =>
  `${WAKE_MARK} you asked to be woken about this ${ago}, and it is now:\n\n${note}\n\n` +
  "(This is your own note to yourself, handed back by the wall — nobody else " +
  "wrote it and nobody is waiting on a reply. If the thing you were waiting for " +
  "still has not happened, `wake_me` again rather than sleeping; if it has, " +
  "carry on and say so.)";

describe("a wake", () => {
  const one = woken("8 minutes ago", "check whether the release pipeline went green");

  /* The bug this whole describe is the guard for: `later.rs` gave a wake its
     own mark on purpose and nothing in src/ knew the string, so it fell through
     to the plain `user` arm and was drawn as something you typed. */
  test("is drawn as not-you, even though it is under the other mark", () => {
    expect(isRelayPrompt(one)).toBe(true);
    expect(isWakePrompt(one)).toBe(true);
  });

  test("is not confused with a relay in either direction", () => {
    expect(isWakePrompt(sample)).toBe(false);
    expect(isWakePrompt("have a look at store.rs")).toBe(false);
    expect(isRelayPrompt("have a look at store.rs")).toBe(false);
  });

  /* Naming you rather than "another card" is the point of it having its own
     shape at all — `later.rs` is right that there is nobody at the other end,
     and a cap saying "from another card" would be the panel inventing one. */
  test("names you as the author, and carries how long ago you asked", () => {
    expect(relayFrom(one)).toEqual({ name: "you, 8 minutes ago", handle: "", project: null });
    expect(relayCap(one)).toBe("from you, 8 minutes ago");
    expect(relayCap(one).length).toBeLessThan(40);
  });

  test("keeps the note you wrote and drops the paragraph addressed to the model", () => {
    expect(relayBody(one)).toBe("check whether the release pipeline went green");
  });

  /* Degrades the way `relayFrom` degrades everywhere else: a header this build
     cannot parse is still a line you did not type, so it loses the elapsed
     phrase and keeps the one fact that matters. */
  test("degrades to you-earlier when the header changes shape", () => {
    const odd = `${WAKE_MARK} time is up:\n\nlook at the deploy`;
    expect(isRelayPrompt(odd)).toBe(true);
    expect(relayFrom(odd)).toEqual({ name: "you, earlier", handle: "", project: null });
    expect(relayCap(odd)).toBe("from you, earlier");
  });
});

describe("handles", () => {
  /* Must agree with `relay::handle_of`, which is what the agent is given and
     what it sends back. */
  test("are the head of the id", () => {
    expect(handleOf("aaaaaaaa-1111-4111-8111-111111111111")).toBe("aaaaaaaa");
    expect(handleOf("short")).toBe("short");
  });
});
