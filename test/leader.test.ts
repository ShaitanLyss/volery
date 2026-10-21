import { describe, expect, test } from "bun:test";

import { CHORDS, LAPSE_MS, LEADER, actsOnWall, chord, mayLead, offers } from "../src/lib/leader";

describe("where the leader may start", () => {
  test("outside any field, as it always could", () => {
    expect(mayLead(null, false)).toBe(true);
  });

  test("from an empty field — sink 3cd4359c", () => {
    expect(mayLead("", false)).toBe(true);
  });

  test("not from a field with anything in it, where a space is a space", () => {
    expect(mayLead("hello", false)).toBe(false);
    expect(mayLead(" ", false)).toBe(false);
  });

  test("never during an IME composition, whatever the field reads", () => {
    expect(mayLead("", true)).toBe(false);
    expect(mayLead(null, true)).toBe(false);
  });

  test("the whole chord meets an empty field, and a miss falls through as a letter", () => {
    /* The space is swallowed, so the field is still empty for the next key;
       `<space>q` completes nothing and the `q` is the field's. */
    const lead = chord(null, LEADER);
    expect(lead.swallow).toBe(true);
    expect(mayLead("", false)).toBe(true);
    const miss = chord(lead.open, "q");
    expect(miss.kind).toBe("lapse");
    expect(miss.swallow).toBe(false);
  });
});

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

  test("ee reaches a card on another wall, and e alone waits for the verb", () => {
    expect(chord("e", "e")).toMatchObject({ kind: "fire", verb: { kind: "elsewhere", act: "next" } });
    expect(chord("e", "n")).toMatchObject({ kind: "fire", verb: { kind: "elsewhere", act: "new" } });
    expect(chord("", "e")).toMatchObject({ kind: "pending", open: "e" });
  });

  test("cc closes the focused card, and c alone waits for the verb", () => {
    expect(chord("c", "c")).toMatchObject({ kind: "fire", verb: { kind: "card", act: "close" } });
    expect(chord("", "c")).toMatchObject({ kind: "pending", open: "c" });
  });

  test("cg puts the focused card on the glass, or takes it off", () => {
    expect(chord("c", "g")).toMatchObject({ kind: "fire", verb: { kind: "card", act: "glass" } });
  });


  test("u opens the accounts panel — which had no key until its settings travelled", () => {
    expect(chord("", "u")).toMatchObject({ kind: "fire", verb: { kind: "open", what: "accounts" } });
  });
  test("o opens the integrations panel — tokens and event sources", () => {
    expect(chord("", "o")).toMatchObject({ kind: "fire", verb: { kind: "open", what: "integrations" } });
  });
  test("i alone is a prefix rather than a chord", () => {
    expect(chord("", "i")).toMatchObject({ kind: "pending", open: "i" });
  });
});

describe("the which-key hint", () => {
  test("the leader alone offers every chord, by its whole letters", () => {
    expect(offers("")).toEqual([
      { keys: "a", label: "archived timelines" },
      { keys: "ca", label: "set it aside / pick it back up" },
      { keys: "cb", label: "ignore the account caps / respect them" },
      { keys: "cc", label: "close this card" },
      { keys: "cd", label: "copy its working directory" },
      { keys: "cg", label: "this card on the glass / back" },
      { keys: "ck", label: "keep what it last said on the wall" },
      { keys: "cl", label: "keep what it last said on the glass" },
      { keys: "cm", label: "its menu — everything the right-click offers" },
      { keys: "cp", label: "its processes" },
      { keys: "cr", label: "read what it last said" },
      { keys: "cw", label: "wake it" },
      { keys: "cx", label: "clear it — start fresh" },
      { keys: "cy", label: "copy its resume command" },
      { keys: "dc", label: "unsent reply: copy it" },
      { keys: "dn", label: "next thing waiting on you" },
      { keys: "dp", label: "unsent reply: into its card's prompt" },
      { keys: "dr", label: "what the asking card last said" },
      { keys: "dx", label: "unsent reply: drop it" },
      { keys: "ee", label: "a card on another wall" },
      { keys: "en", label: "a new card in this section, there" },
      { keys: "ff", label: "find file" },
      { keys: "fw", label: "grep" },
      { keys: "gg", label: "this grouping on the glass / back" },
      { keys: "gn", label: "another grouping here" },
      { keys: "gr", label: "rename this grouping" },
      { keys: "ia", label: "I'm away / back" },
      { keys: "k", label: "flyway key" },
      { keys: "la", label: "archive the plan" },
      { keys: "lg", label: "plan on the glass / on the wall" },
      { keys: "ll", label: "plan: the whole line / a window" },
      { keys: "ls", label: "plan back in the stack" },
      { keys: "ma", label: "cards left awake come back awake: on / off" },
      { keys: "mi", label: "away when nobody is at the keyboard: on / off" },
      { keys: "mr", label: "reopen after a restart: on / off" },
      { keys: "mw", label: "keep awake on mains: on / off" },
      { keys: "o", label: "the integrations panel" },
      { keys: "p", label: "questions that piled up" },
      { keys: "sd", label: "drop something in the sink" },
      { keys: "ss", label: "the sink" },
      { keys: "tc", label: "casse-tête" },
      { keys: "td", label: "dérivée" },
      { keys: "tk", label: "croquis" },
      { keys: "tm", label: "motus" },
      { keys: "ts", label: "synth" },
      { keys: "u", label: "the accounts panel" },
      { keys: "v0", label: "the wall as its skin is" },
      { keys: "vj", label: "the wall dimmer" },
      { keys: "vk", label: "the wall brighter" },
      { keys: "vv", label: "the themes panel" },
      { keys: "wa", label: "dock: full width / the width the panel leaves" },
      { keys: "wd", label: "dock: bottom / top / floating" },
      { keys: "wg", label: "glass: scaled to any screen / one per screen size" },
      { keys: "wp", label: "panel: right / left / floating" },
      { keys: "ws", label: "every screen / one screen" },
      { keys: "wv", label: "the wall / chat view" },
      { keys: "z", label: "away / back" },
    ]);
  });

  test("the line family is a plan's four moves", () => {
    expect(offers("l")).toEqual([
      { keys: "a", label: "archive the plan" },
      { keys: "g", label: "plan on the glass / on the wall" },
      { keys: "l", label: "plan: the whole line / a window" },
      { keys: "s", label: "plan back in the stack" },
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
    /* Six verbs now: which screens the studio is over, where each of the two
       things you work *in* is moored, how the glass follows the one screen it
       is on, and which of the two views the window draws. The family was always the argument — placing a window is
       several verbs and they want to sit together in the hint — and this is it
       being taken. */
    expect(offers("w")).toEqual([
      { keys: "a", label: "dock: full width / the width the panel leaves" },
      { keys: "d", label: "dock: bottom / top / floating" },
      { keys: "g", label: "glass: scaled to any screen / one per screen size" },
      { keys: "p", label: "panel: right / left / floating" },
      { keys: "s", label: "every screen / one screen" },
      { keys: "v", label: "the wall / chat view" },
    ]);
    expect(chord("w", "g")).toMatchObject({ kind: "fire", verb: { kind: "window", act: "glass" } });
    expect(chord("w", "a")).toMatchObject({ kind: "fire", verb: { kind: "window", act: "extent" } });
  });

  test("so is the machine the wall runs on", () => {
    expect(offers("m")).toEqual([
      { keys: "a", label: "cards left awake come back awake: on / off" },
      { keys: "i", label: "away when nobody is at the keyboard: on / off" },
      { keys: "r", label: "reopen after a restart: on / off" },
      { keys: "w", label: "keep awake on mains: on / off" },
    ]);
    /* The backstop for a question nobody is there to answer, now that a
       question has no deadline: it has to be reachable without the mouse. */
    expect(chord("m", "i")).toMatchObject({ kind: "fire", verb: { kind: "machine", act: "idle" } });
    expect(chord("m", "w")).toMatchObject({ kind: "fire", verb: { kind: "machine", act: "awake" } });
    expect(chord("m", "r")).toMatchObject({ kind: "fire", verb: { kind: "machine", act: "reopen" } });
    /* The other half of the same restart: whether the cards come back with it. */
    expect(chord("m", "a")).toMatchObject({ kind: "fire", verb: { kind: "machine", act: "reawaken" } });
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

describe("which chords want the wall", () => {
  const verbOf = (keys: string) => CHORDS.find((c) => c.keys === keys)!.verb;

  test("the chords that arrange the wall switch to it under chat view", () => {
    for (const keys of ["ws", "wp", "wd", "wa", "wg", "gg", "gn", "gr", "ll", "lg", "ls", "la", "cg", "ck", "cl", "ee", "en", "dp", "dr"]) {
      expect([keys, actsOnWall(verbOf(keys))]).toEqual([keys, true]);
    }
  });

  test("the rest mean the same in either view and run where they are", () => {
    for (const keys of ["wv", "ff", "vv", "dn", "cm", "cc", "cr", "z", "ts"]) {
      expect([keys, actsOnWall(verbOf(keys))]).toEqual([keys, false]);
    }
  });

  test("space w v is the view", () => {
    expect(verbOf("wv")).toEqual({ kind: "window", act: "view" });
  });
});
