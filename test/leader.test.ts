import { describe, expect, test } from "bun:test";

import { CHORDS, LAPSE_MS, LEADER, chord, offers } from "../src/lib/leader";

/* These were `finding.test.ts`'s and moved here with the machine they cover.
   Two things changed and nothing else did: a chord fires a *verb* rather than a
   find mode, and the hint carries a label rather than a mode to switch on. */

describe("the space leader", () => {
  test("a bare key with nothing open is not ours", () => {
    const step = chord(null, "q");
    expect(step.kind).toBe("idle");
    expect(step.swallow).toBe(false);
  });

  test("the leader opens a sequence and is swallowed", () => {
    const step = chord(null, LEADER);
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
    expect(step.swallow).toBe(true);
  });

  test("space then f then f finds a file", () => {
    /* The whole gesture, pressed one key at a time the way a hand does it. */
    let open = chord(null, " ").open;
    let step = chord(open, "f");
    expect(step.kind).toBe("pending");
    expect(step.open).toBe("f");
    open = step.open;
    step = chord(open, "f");
    expect(step.kind).toBe("fire");
    expect(step).toMatchObject({ verb: { kind: "find", mode: "files" } });
    expect(step.open).toBeNull();
  });

  test("space then f then w greps", () => {
    const step = chord(chord(chord(null, " ").open, "f").open, "w");
    expect(step).toMatchObject({ kind: "fire", verb: { kind: "find", mode: "grep" } });
  });

  test("space then t then s opens the synth", () => {
    /* The chord the machine was generalised for. Note the assertion is about a
       *verb*: a leader that answered with a find mode could not have had this
       test written for it at all, which is the whole argument for the move. */
    const step = chord(chord(chord(null, " ").open, "t").open, "s");
    expect(step).toMatchObject({ kind: "fire", verb: { kind: "toy", toy: "synth" } });
  });

  test("a key that completes no chord falls through rather than being eaten", () => {
    /* The one that matters. `<space>q` in nvim leaves you with a `q`; a wall
       that swallowed it would be one where a letter occasionally vanished into
       a gesture nobody made. */
    const step = chord("", "q");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(false);
    expect(step.open).toBeNull();
  });

  test("a second letter that completes no chord also falls through", () => {
    const step = chord("f", "z");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(false);
  });

  test("escape abandons the sequence and is the one key that is still ours", () => {
    /* Swallowed, so a press meant as "forget it" does not also deselect the
       card — that would be one key doing two things. */
    const step = chord("f", "Escape");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(true);
  });

  test("a sequence lapses, and the key is reconsidered from scratch", () => {
    /* Not merely dropped: the leader pressed again after a long wait has to
       open a *fresh* sequence rather than be read as the second key of the
       stale one. */
    const step = chord("f", " ", LAPSE_MS + 1);
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
  });

  test("a letter after the lapse belongs to the wall again", () => {
    const step = chord("f", "f", LAPSE_MS + 1);
    expect(step.kind).toBe("idle");
    expect(step.swallow).toBe(false);
  });

  test("inside the timeout the same letter still completes the chord", () => {
    const step = chord("f", "f", LAPSE_MS - 1);
    expect(step).toMatchObject({ kind: "fire", verb: { kind: "find", mode: "files" } });
  });

  test("the leader pressed inside a sequence restarts it", () => {
    const step = chord("f", " ");
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
  });

  test("a modifier on its own leaves the sequence exactly as it was", () => {
    /* Every modifier fires its own keydown, so without this a hand brushing
       Shift between the leader and the letter would abandon the chord. */
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      const step = chord("f", key);
      expect(step.kind).toBe("held");
      expect(step.open).toBe("f");
      expect(step.swallow).toBe(false);
    }
  });

  test("a modifier with nothing open changes nothing either", () => {
    const step = chord(null, "Shift");
    expect(step).toMatchObject({ kind: "held", open: null, swallow: false });
  });

  test("a named key is not a letter in a chord", () => {
    for (const key of ["Tab", "Enter", "ArrowDown", "F11", "Home"]) {
      expect(chord("f", key).kind).toBe("lapse");
    }
  });

  test("shift+F still types the chord", () => {
    /* Which is how a caps-locked keyboard types it, and how a hand that holds
       shift a beat too long does. */
    expect(chord(chord(null, " ").open, "F")).toMatchObject({ kind: "pending", open: "f" });
    expect(chord("f", "F")).toMatchObject({
      kind: "fire",
      verb: { kind: "find", mode: "files" },
    });
  });
});

describe("away mode has two spellings of one verb", () => {
  /* The only chord in the table written twice, and the duplication is the
     point: `z` is what a hand reaches for and `ia` is what a head derives from
     the name. A table that let them drift would give you two features. */
  test("z and ia fire the same thing", () => {
    expect(chord("", "z")).toMatchObject({
      kind: "fire",
      verb: { kind: "presence", act: "toggle" },
    });
    expect(chord("i", "a")).toMatchObject({
      kind: "fire",
      verb: { kind: "presence", act: "toggle" },
    });
  });

  test("i alone is a prefix rather than a chord", () => {
    expect(chord("", "i")).toMatchObject({ kind: "pending", open: "i" });
  });
});

describe("the which-key hint", () => {
  test("the leader alone offers every chord, by its whole letters", () => {
    expect(offers("")).toEqual([
      { keys: "a", label: "archived timelines" },
      { keys: "ff", label: "find file" },
      { keys: "fw", label: "grep" },
      { keys: "gn", label: "another grouping here" },
      { keys: "gr", label: "rename this grouping" },
      { keys: "ia", label: "I'm away / back" },
      { keys: "k", label: "flyway key" },
      { keys: "p", label: "questions that piled up" },
      { keys: "sd", label: "drop something in the sink" },
      { keys: "ss", label: "the sink" },
      { keys: "tc", label: "casse-tête" },
      { keys: "td", label: "dérivée" },
      { keys: "tk", label: "croquis" },
      { keys: "tm", label: "motus" },
      { keys: "ts", label: "synth" },
      { keys: "wd", label: "dock: bottom / top / floating" },
      { keys: "wp", label: "panel: right / left / floating" },
      { keys: "ws", label: "every screen / one screen" },
      { keys: "z", label: "away / back" },
    ]);
  });

  test("one letter in, it offers only what is left to press", () => {
    expect(offers("f")).toEqual([
      { keys: "f", label: "find file" },
      { keys: "w", label: "grep" },
    ]);
  });

  test("the toy shelf is its own branch", () => {
    /* The shelf is why `t` is a family rather than a letter — it was one toy
       for a while and is five now, and none of them cost anything but a row.
       `toys.md` states the bargain; this is it being taken. */
    expect(offers("t")).toEqual([
      { keys: "c", label: "casse-tête" },
      { keys: "d", label: "dérivée" },
      { keys: "k", label: "croquis" },
      { keys: "m", label: "motus" },
      { keys: "s", label: "synth" },
    ]);
  });

  test("the shelf carries the away gate's puzzles, by the same names", () => {
    /* A puzzle met on the way back to work and one opened because you wanted
       it are the same puzzle — so the shelf's verbs are `gate.ts`'s own ids
       rather than a second vocabulary that could drift from it. */
    expect(chord("t", "m")).toMatchObject({
      kind: "fire",
      verb: { kind: "toy", toy: "motus" },
    });
    expect(chord("t", "k")).toMatchObject({
      kind: "fire",
      verb: { kind: "toy", toy: "sketch" },
    });
    for (const id of ["motus", "calculus", "rotate", "sketch"]) {
      expect(CHORDS.some((c) => c.verb.kind === "toy" && c.verb.toy === id)).toBe(true);
    }
  });

  test("so is the window", () => {
    /* Three verbs now: which screens the studio is over, and where each of the
       two things you work *in* is moored. The family was always the argument —
       placing a window is several verbs and they want to sit together in the
       hint — and this is it being taken. */
    expect(offers("w")).toEqual([
      { keys: "d", label: "dock: bottom / top / floating" },
      { keys: "p", label: "panel: right / left / floating" },
      { keys: "s", label: "every screen / one screen" },
    ]);
  });

  test("a completed chord offers nothing — there is nothing left to press", () => {
    expect(offers("ff")).toEqual([]);
  });

  test("every chord in the catalogue is reachable from the leader", () => {
    /* Guards against a chord being added whose first letter nothing offers,
       which would be a binding with no affordance at all. */
    const heads = new Set(offers("").map((o) => o.keys));
    for (const c of CHORDS) expect(heads.has(c.keys)).toBe(true);
  });

  test("every chord has a label", () => {
    /* The hint used to switch on the mode, which is a shape with nowhere for a
       third chord to go — it is why `<space>ts` would have been drawn as
       "grep". A label beside the chord is what stops one shipping without a
       word for what it does. */
    for (const c of CHORDS) expect(c.label.trim().length).toBeGreaterThan(0);
  });

  test("no chord is a prefix of another", () => {
    /* A sequence that both fires and has completions is one the machine has to
       guess about: `chord` checks for a hit before it checks for a prefix, so
       the longer chord would be unreachable. Cheaper to forbid than to define. */
    for (const a of CHORDS) {
      for (const b of CHORDS) {
        if (a === b) continue;
        expect(b.keys.startsWith(a.keys)).toBe(false);
      }
    }
  });
});
