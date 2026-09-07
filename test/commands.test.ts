import { expect, test, describe } from "bun:test";
import {
  COMMANDS,
  EFFORT_LEVELS,
  cliCommand,
  completeAt,
  effortAnswer,
  completionFor,
  completionForChoice,
  mayRunOn,
  matchChoices,
  matchCommands,
  paletteExtras,
  resolveCommand,
  slashAt,
  spansWhole,
  stillWriting,
  vocabRow,
  typingChoice,
  typingName,
} from "../src/lib/commands";

const names = (draft: string) => matchCommands(draft).map((c) => c.name);
const values = (draft: string) => matchChoices(draft).map((c) => c.value);
const named = (name: string) => COMMANDS.find((c) => c.name === name)!;

describe("the palette opens on a slash and closes on a space", () => {
  test("a bare slash offers everything there is", () => {
    expect(names("/")).toEqual(COMMANDS.map((c) => c.name));
  });

  test("typing narrows it", () => {
    expect(names("/cl")).toContain("clear");
    expect(names("/zzz")).toEqual([]);
  });

  test("prose is not a command, however many slashes it has", () => {
    expect(names("what about src/lib/clear.ts")).toEqual([]);
    expect(names("")).toEqual([]);
    /* Leading whitespace says this is a line that happens to start with a
       slash, not a command being typed. */
    expect(names(" /clear")).toEqual([]);
  });

  test("the choosing of a name is over once there is a space", () => {
    expect(typingName("/clear ")).toBeNull();
    expect(names("/clear the deck")).toEqual([]);
  });

  test("a command whose argument is prose closes it, as everything used to", () => {
    /* `/compact` takes free text. Left open over it the palette would be
       claiming a choice is still to be made while you write a sentence. */
    expect(names("/compact focus on the auth work")).toEqual([]);
    expect(typingChoice("/compact focus")).toBeNull();
    expect(values("/compact ")).toEqual([]);
  });
});

describe("a command that takes a value keeps the palette up", () => {
  test("the space opens the values instead of closing the palette", () => {
    /* The rule it bends: the palette is for choosing, and `/model` alone is not
       a thing that can be run — so the choosing is not over at the space. */
    expect(values("/model ")).toEqual([
      "opus",
      "opus[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "fable",
      "opusplan",
    ]);
    expect(values("/effort ")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("typing narrows the values the way it narrows the names", () => {
    expect(values("/model son")).toEqual(["sonnet", "sonnet[1m]"]);
    /* `max` contains an x, so it follows the one that starts with it. */
    expect(values("/effort x")).toEqual(["xhigh", "max"]);
    expect(values("/model zzz")).toEqual([]);
  });

  test("a prefix outranks a mere containing match", () => {
    /* `[1m]` contains `1m`, and so would sort in on a contains-match; the
       prefixes must still come first. `opusplan` is a third prefix match and
       sits with them — it joined the list the day the wall got a second gear,
       since it is the model pairing plan mode is for. */
    expect(values("/model opus")).toEqual(["opus", "opus[1m]", "opusplan"]);
  });

  test("the choosing really is over at the second space", () => {
    expect(typingChoice("/model sonnet ")).toBeNull();
    expect(values("/model sonnet please")).toEqual([]);
  });

  test("only a command that has values gets a second stage", () => {
    expect(typingChoice("/clear ")).toBeNull();
    expect(typingChoice("/zzz ")).toBeNull();
    expect(typingChoice("/model ")?.cmd.name).toBe("model");
  });
});

describe("only Skein's own commands are Skein's", () => {
  test("an exact name resolves", () => {
    expect(resolveCommand("/clear")?.cmd.name).toBe("clear");
    expect(resolveCommand("/CLEAR")?.cmd.name).toBe("clear");
    /* Trailing space is still just the command. */
    expect(resolveCommand("/clear ")?.cmd.name).toBe("clear");
    /* And a command that takes nothing is given nothing, rather than the
       empty string standing in for an argument it never has. */
    expect(resolveCommand("/clear")?.arg).toBe("");
  });

  /* The load-bearing one. `claude` has slash commands of its own — the built-ins
     and everything in `.claude/commands/` — and they work in `--print` mode, so
     a prompt starting with a slash is ordinary traffic. Swallowing an unknown
     name would silently break every custom command anybody has written, and it
     would look like the agent ignoring them. */
  test("an unknown command is not intercepted, so it reaches the agent", () => {
    expect(resolveCommand("/commit")).toBeNull();
    expect(resolveCommand("/review the diff")).toBeNull();
    expect(names("/commit")).toEqual([]);
  });

  test("a name that merely starts with ours is not ours", () => {
    expect(resolveCommand("/clearing")).toBeNull();
    /* Nor is one carrying an argument to a command that takes none: reading
       `/clear` out of it would throw away the rest of what was typed. */
    expect(resolveCommand("/clear everything")).toBeNull();
    expect(resolveCommand("/renamed the file")).toBeNull();
  });

  test("a slash inside a sentence is never a command", () => {
    expect(resolveCommand("run the /clear command for me")).toBeNull();
  });

  /* The whole point of `by`. Carrying out a CLI command *is* sending it, so
     there is nothing for `send` to intercept — it has to fall through to the
     ordinary prompt path exactly as `/commit` does. Intercepting it would mean
     Skein re-implementing a thing the agent already answers. */
  test("a CLI command is not intercepted either", () => {
    expect(resolveCommand("/compact")).toBeNull();
    expect(resolveCommand("/model sonnet")).toBeNull();
    expect(resolveCommand("/effort high")).toBeNull();
  });
});

/* `/rename` is the first Skein command whose argument is the point of it. The
   exact-and-whole rule is inverted for exactly that clause and nothing else:
   what follows the name is not the rest of a sentence that happened to start
   with a slash, it is the name you are giving the card. */
describe("a command that takes the rest of the line", () => {
  test("the argument comes back with the command", () => {
    const found = resolveCommand("/rename the auth work");
    expect(found?.cmd.name).toBe("rename");
    expect(found?.arg).toBe("the auth work");
  });

  test("the name is taken whole, punctuation and slashes included", () => {
    /* Anything after the command's own name is the name being given, so
       nothing in it can be read as a second command or a second argument. */
    expect(resolveCommand("/rename src/lib — the wire")?.arg).toBe(
      "src/lib — the wire",
    );
    expect(resolveCommand("/rename /clear")?.arg).toBe("/clear");
  });

  test("the space between is the separator, not part of the name", () => {
    expect(resolveCommand("/rename   spaced out  ")?.arg).toBe("spaced out");
  });

  test("a bare name resolves to nothing, because it would name nothing", () => {
    /* The same position `/model` is in with no value typed: incomplete rather
       than wrong. The palette holds Enter back before this is reached (it
       completes to `/rename ` instead), so what this covers is the draft that
       arrives with the palette dismissed — which falls through and goes to the
       agent as the words it is, exactly as `/commit` does. */
    expect(resolveCommand("/rename")).toBeNull();
    expect(resolveCommand("/rename ")).toBeNull();
    expect(resolveCommand("/rename    ")).toBeNull();
  });

  test("it is still only ours, and still only by its own name", () => {
    expect(resolveCommand("/renaming this card")).toBeNull();
    expect(resolveCommand("please /rename this card")).toBeNull();
    expect(resolveCommand(" /rename this card")).toBeNull();
    expect(cliCommand("/rename this card")).toBeNull();
  });

  test("the palette closes at the space, as it does for any prose", () => {
    /* Free text, so there is nothing to offer: the same answer `/compact`
       gets, and for the same reason — a palette left up over a name being
       written would be claiming a choice is still to be made. */
    expect(names("/rename the auth work")).toEqual([]);
    expect(typingChoice("/rename the")).toBeNull();
    expect(values("/rename ")).toEqual([]);
  });
});

describe("knowing a CLI command without taking custody of it", () => {
  /* Nothing is intercepted on the strength of this. It answers the two places
     the difference shows: what an unnamed card gets called, and what the card
     face previews while you type. */
  test("it recognises one with or without its argument", () => {
    expect(cliCommand("/compact")?.name).toBe("compact");
    expect(cliCommand("/compact focus on the auth work")?.name).toBe("compact");
    expect(cliCommand("/model sonnet")?.name).toBe("model");
    expect(cliCommand("  /effort high  ")?.name).toBe("effort");
  });

  test("it is not Skein's commands and not anybody else's", () => {
    expect(cliCommand("/clear")).toBeNull();
    expect(cliCommand("/commit")).toBeNull();
    expect(cliCommand("compact the context please")).toBeNull();
    expect(cliCommand("/compacting")).toBeNull();
  });
});

describe("what the keys put in the field", () => {
  test("completion is the whole name, ready to send", () => {
    const clear = named("clear");
    expect(completionFor(clear)).toBe("/clear");
    /* Completing and then sending has to reach the same command the palette
       was lit on, or Tab would be a way to lose your place. */
    expect(resolveCommand(completionFor(clear))?.cmd).toBe(clear);
  });

  test("a command that takes prose is completed with its space too", () => {
    /* For `/model`'s reason one step along: completing to `/rename` alone
       would leave the cursor against a name that cannot be run, with the thing
       it is waiting for one keystroke away and nothing saying so. */
    const rename = named("rename");
    expect(completionFor(rename)).toBe("/rename ");
    /* And what it gives is deliberately *not* runnable yet — a completion that
       resolved would be a Tab that renamed a card to nothing. */
    expect(resolveCommand(completionFor(rename))).toBeNull();
  });

  test("a command that takes a value is completed with its space", () => {
    /* Or completing it would leave you sitting on a name that cannot be run,
       with the values one keystroke away and nothing saying so. */
    expect(completionFor(named("model"))).toBe("/model ");
    expect(typingChoice(completionFor(named("model")))?.cmd.name).toBe("model");
  });

  test("completing a value gives the whole line", () => {
    const model = named("model");
    const opus1m = model.choices!.find((c) => c.value === "opus[1m]")!;
    expect(completionForChoice(model, opus1m)).toBe("/model opus[1m]");
    /* And what it gives has to be a thing the CLI will read as its own. */
    expect(cliCommand(completionForChoice(model, opus1m))).toBe(model);
  });
});

describe("the catalogue is shaped for the dock", () => {
  test("every command can be typed, and says what it does", () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.summary.length).toBeGreaterThan(0);
      /* Lowercase, like the rest of the prose in this UI. */
      expect(c.summary).toBe(c.summary.toLowerCase());
      expect(c.detail.length).toBeGreaterThan(0);
      /* Every entry must be reachable by typing its own name. */
      expect(matchCommands(`/${c.name}`)).toContain(c);
    }
  });

  test("every command is carried out by somebody", () => {
    for (const c of COMMANDS) {
      if (c.by !== "skein") {
        expect(cliCommand(`/${c.name}`)).toBe(c);
        continue;
      }
      /* One that takes prose is only itself once it has some — its bare name
         is incomplete, the way `/model` is. So it is asked with an argument,
         which is the only form of it that can ever be run. */
      const typed = c.takesText ? `/${c.name} something` : `/${c.name}`;
      expect(resolveCommand(typed)?.cmd).toBe(c);
    }
  });

  test("a command takes a fixed set of values or free prose, never both", () => {
    /* They are the two halves of "this is not finished being chosen", and the
       palette answers them differently — it offers the values for one and
       closes at the space for the other. A command claiming both would be a
       palette that has to decide which it is at every keystroke. */
    for (const c of COMMANDS) expect(!!c.choices && !!c.takesText).toBe(false);
  });

  test("only Skein's own commands take prose", () => {
    /* A `cli` command's argument is the CLI's business — `/compact focus on
       auth` is sent verbatim, and nothing here reads it. `takesText` exists so
       that Skein can act on what was typed, which is only ever true of a
       command Skein carries out. */
    for (const c of COMMANDS) if (c.takesText) expect(c.by).toBe("skein");
  });

  test("every value can be typed, and says what it buys", () => {
    for (const c of COMMANDS) {
      if (!c.choices) continue;
      /* A command with an empty list would open a palette with nothing in it. */
      expect(c.choices.length).toBeGreaterThan(0);
      for (const v of c.choices) {
        expect(v.value).toMatch(/^\S+$/);
        expect(v.summary).toBe(v.summary.toLowerCase());
        expect(matchChoices(`/${c.name} ${v.value}`)).toContain(v);
      }
      expect(new Set(c.choices.map((v) => v.value)).size).toBe(c.choices.length);
    }
  });

  test("no two commands share a name", () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });

  test("only Skein's own can open a panel", () => {
    /* `opens` says this row puts something up to choose from. The CLI has no
       way to draw anything in this window, so a `cli` command claiming it would
       be an ellipsis promising a panel that never arrives. */
    for (const c of COMMANDS) if (c.opens) expect(c.by).toBe("skein");
  });

  test("a command that acts on no card is one this window carries out", () => {
    /* The dock skips the reach gate for these, so the gate's own reason has to
       still hold: what is skipped is friction scaled to reach, and only a
       command Skein runs itself can have no reach. A `cli` one is *sent*, once
       per card, so it always has some. */
    for (const c of COMMANDS) if (!c.needsCard) expect(c.by).toBe("skein");
  });
});

describe("/resume, the command that acts on no card", () => {
  const resume = named("resume");

  test("it is Skein's own, because the CLI refuses it down this pipe", () => {
    /* Probed 2026-08-20 with `tools/probe-commands.ts resume`, spawning with
       Skein's exact argv: result.result "/resume isn't available in this
       environment.", num_turns 0 — the same answer `/rewind` gives. The CLI's
       own `/resume` is a picker its TUI draws, so sending the text would put a
       refusal in the transcript of a card that has a working way to do the
       thing. */
    expect(resume.by).toBe("skein");
    expect(cliCommand("/resume")).toBeNull();
    expect(resolveCommand("/resume")?.cmd).toBe(resume);
  });

  test("it needs no card and offers a list", () => {
    expect(resume.needsCard).toBe(false);
    expect(resume.opens).toBe(true);
    /* Neither of the two "not finished being chosen" shapes: the choosing
       happens in the panel, not in the field, so the palette closes at the
       space like anything else that is whole. */
    expect(resume.choices).toBeUndefined();
    expect(resume.takesText).toBeUndefined();
  });

  test("it is reachable the way the others are", () => {
    expect(names("/res")).toContain("resume");
    /* `matchCommands` also matches on containment, and this is the case that
       makes it worth having: `/sum` is a plausible way to grope for it. */
    expect(names("/sum")).toContain("resume");
    expect(completionFor(resume)).toBe("/resume");
  });

  test("it is exact and whole, like /clear", () => {
    /* Nothing to say to it, so prose after the name is prose: `/resume the
       auth work` is a sentence for the agent and must not be read as this. */
    expect(resolveCommand("/resume the auth work")).toBeNull();
    expect(resolveCommand("/resuming")).toBeNull();
    /* A stray trailing space is still the command. */
    expect(resolveCommand("/resume  ")?.cmd).toBe(resume);
  });
});

describe("the effort a card is set to", () => {
  test("the CLI's own answer is where the level comes from", () => {
    /* Verbatim from claude 2.1.233, 2026-08-20 — see `effortAnswer`. */
    expect(
      effortAnswer(
        "Set effort level to xhigh (this session only): Deeper reasoning than high, " +
          "just below maximum (Fable 5, Opus 4.7+, Sonnet 5)",
      ),
    ).toBe("xhigh");
    for (const level of EFFORT_LEVELS) {
      expect(effortAnswer(`Set effort level to ${level} (this session only)`)).toBe(level);
    }
  });

  test("nothing else in a transcript sets one", () => {
    expect(effortAnswer(null)).toBeNull();
    expect(effortAnswer("")).toBeNull();
    /* The other local answers land in the same arm of the same switch. */
    expect(effortAnswer("Set model to Sonnet 5 for this session only")).toBeNull();
    /* A sentence that merely names a level. The description after the colon
       already names three models, and could as easily name a level. */
    expect(effortAnswer("high is the usual amount of thinking")).toBeNull();
    /* A level this build does not know is not a level. */
    expect(effortAnswer("Set effort level to colossal (this session only)")).toBeNull();
  });

  test("the levels offered are the levels recognised", () => {
    const offered = COMMANDS.find((c) => c.name === "effort")?.choices ?? [];
    expect(offered.map((c) => c.value)).toEqual([...EFFORT_LEVELS]);
  });
});

describe("a command with choices, now that one of them is Volery's own", () => {
  /* Until `/gear` every command with choices was the CLI's, and those are
     filtered out before this arm is reached — so "a choices command with an
     argument" returned null and nothing ever noticed. */
  test("it resolves with one of its own values", () => {
    const found = resolveCommand("/gear planning");
    expect(found?.cmd.name).toBe("gear");
    expect(found?.arg).toBe("planning");
    expect(resolveCommand("/gear making")?.arg).toBe("making");
  });

  test("and not with anything else, which falls through to the agent", () => {
    /* The same rule `/clear the deck` follows: a command that cannot be carried
       out must not be swallowed. */
    expect(resolveCommand("/gear sideways")).toBeNull();
    expect(resolveCommand("/gear planning please")).toBeNull();
    expect(resolveCommand("/gear plan")).toBeNull();
  });

  test("a bare name still resolves, so Enter can open the values", () => {
    expect(resolveCommand("/gear")?.arg).toBe("");
  });

  test("the CLI's own are still nobody's business here", () => {
    expect(resolveCommand("/model opus")).toBeNull();
  });
});

describe("whether a command is still being written", () => {
  const gear = COMMANDS.find((c) => c.name === "gear")!;
  const model = COMMANDS.find((c) => c.name === "model")!;
  const rename = COMMANDS.find((c) => c.name === "rename")!;
  const clear = COMMANDS.find((c) => c.name === "clear")!;

  test("a command needing a value and given none is incomplete", () => {
    expect(stillWriting(gear, "")).toBe(true);
    expect(stillWriting(model, "")).toBe(true);
    expect(stillWriting(rename, "")).toBe(true);
  });

  /* The bug this exists for: `cmd.choices` alone read a command as incomplete
     even with its value typed, so `/gear planning` submitted with no palette
     open silently did nothing at all. */
  test("and complete once it has one", () => {
    expect(stillWriting(gear, "planning")).toBe(false);
    expect(stillWriting(model, "opus")).toBe(false);
    expect(stillWriting(rename, "the auth work")).toBe(false);
  });

  test("a command that takes nothing is never incomplete", () => {
    expect(stillWriting(clear, "")).toBe(false);
    expect(stillWriting(clear, "anything")).toBe(false);
  });
});

describe("/plan, the word people actually type", () => {
  const plan = COMMANDS.find((c) => c.name === "plan")!;

  test("it exists, is Volery's to run, and needs no value", () => {
    expect(plan.by).toBe("skein");
    expect(plan.choices).toBeUndefined();
    expect(plan.takesText).toBeUndefined();
    /* So Enter runs it outright rather than opening anything. */
    expect(stillWriting(plan, "")).toBe(false);
  });

  test("it resolves bare, which is the only form of it", () => {
    expect(resolveCommand("/plan")?.cmd.name).toBe("plan");
    expect(resolveCommand("/plan")?.arg).toBe("");
  });

  test("and not with an argument, which falls through as prose", () => {
    /* `/plan the migration` is a sentence for the agent, not a gear change. */
    expect(resolveCommand("/plan the migration")).toBeNull();
  });

  /* The failure that made it exist: `matchCommands` is prefix-then-contains,
     and "gear" contains neither "p" nor "plan", so typing the obvious word
     opened no palette at all and went to the agent as a prompt. */
  test("typing it finds it, where before it found nothing", () => {
    expect(matchCommands("/plan").map((c) => c.name)).toContain("plan");
    expect(matchCommands("/pla").map((c) => c.name)).toContain("plan");
    expect(matchCommands("/p").map((c) => c.name)).toContain("plan");
  });

  test("both ways in still exist, and say different things", () => {
    /* `/gear` is the pair — it is the one that can also say making. */
    expect(resolveCommand("/gear planning")?.arg).toBe("planning");
    expect(resolveCommand("/gear making")?.arg).toBe("making");
  });

  test("its detail names the way back, since the shortcut is one-way", () => {
    expect(plan.detail).toContain("/gear making");
  });
});

/* `/btw`, the side question. Its shape in the catalogue is the whole of what the
 * dock needs, and two of the flags are load-bearing rather than decorative. */
describe("/btw, the question asked beside a conversation", () => {
  const btw = COMMANDS.find((c) => c.name === "btw")!;

  test("is Skein's own, because the CLI has no such thing on this path", () => {
    /* `/btw` lives in the TUI's Ink layer — measured out of the 2.1.241 binary,
       see `aside.rs`. Volery drives `claude --print`, which has no Ink, so a
       `cli` command would be sent as a prompt and read as text. */
    expect(btw.by).toBe("skein");
  });

  test("takes the rest of the line and offers no values", () => {
    /* A side question is prose only you can supply, which is exactly what
       `takesText` is for — and never both, per the invariant above. */
    expect(btw.takesText).toBe(true);
    expect(btw.choices).toBeUndefined();
    expect(btw.opens).toBeUndefined();
  });

  test("needs a card, since it forks that card's own conversation", () => {
    expect(btw.needsCard).toBe(true);
  });

  /* The detail line is the only place the two costs are stated, and both are
     things somebody would want to know before pressing it: it spends a request,
     and the answer does not survive the wall closing. */
  test("says what it costs and what it does not keep", () => {
    expect(btw.detail).toContain("request");
    expect(btw.detail).toContain("gone");
    expect(btw.detail).toContain("transcript");
  });

  test("and is complete only once something has been typed after it", () => {
    expect(resolveCommand("/btw")).toBeNull();
    expect(resolveCommand("/btw ")).toBeNull();
    const done = resolveCommand("/btw which branch is this on?");
    expect(done?.cmd.name).toBe("btw");
    expect(done?.arg).toBe("which branch is this on?");
  });
});

/* ── skills, a project's own commands, and a slash that may sit anywhere ──── */

/** What `initialize` really answers with, trimmed to the shapes that matter —
 *  a plugin's skill with the un-prefixed alias the CLI publishes for it, a
 *  plugin whose name repeats its skill's, three bare skills, a project command
 *  with a hint, one with no description at all, and one from a subdirectory.
 *  Probed 2026-09-07 against claude 2.1.233 with `tools/probe-skills.ts
 *  initialize`; `slash.rs` has the measurements. */
const VOCAB = [
  { name: "commit", description: "stage and commit what this work touched (project)" },
  { name: "bare", description: "No frontmatter at all. (project)" },
  { name: "deep:nested", description: "a command in a subdirectory (project)", argumentHint: "branch" },
  { name: "tx-toolkit:committee", description: "(tx-toolkit) Convene a panel.", aliases: ["committee"] },
  { name: "frontend-design:frontend-design", description: "(frontend-design) Visual design.", aliases: ["frontend-design"] },
  { name: "dataviz", description: "Charts that read as one system." },
  { name: "code-review", description: "Review the current diff.", argumentHint: "[low|medium|high]", aliases: ["review"] },
  { name: "loop", description: "Run a prompt on an interval.", argumentHint: "[interval] [prompt]" },
];

/** Which of those the agent calls skills — `system/init`'s array, the only
 *  authoritative label, and the one thing `initialize` does not say. */
const SKILLS = [
  "tx-toolkit:committee",
  "frontend-design:frontend-design",
  "dataviz",
  "code-review",
  "loop",
];

/** The palette's extra rows with the split known, which is a card that has
 *  taken a turn. */
const extras = paletteExtras(VOCAB, SKILLS, true);

/** And with it unknown — a card that has never spoken. */
const unlabelled = paletteExtras(VOCAB, [], false);

const offered = (draft: string, caret?: number | null) =>
  matchCommands(draft, caret, extras).map((c) => c.name);

const row = (n: string) => extras.find((c) => c.name === n)!;

describe("the slash-name the caret is in", () => {
  test("a name at the head is the whole draft, as it always was", () => {
    expect(slashAt("/clear", null)).toEqual({ from: 0, to: 6, name: "clear" });
    expect(spansWhole("/clear", slashAt("/clear", null)!)).toBe(true);
  });

  test("a name inside a sentence is found, and is not the whole draft", () => {
    const span = slashAt("make a chart with /dataviz", null)!;
    expect(span).toEqual({ from: 18, to: 26, name: "dataviz" });
    expect(spansWhole("make a chart with /dataviz", span)).toBe(false);
  });

  test("the slash has to begin a word, which is what keeps prose out", () => {
    /* Every one of these contains a slash and none of them is a name being
       typed. This is the whole guard: without it the palette would open on a
       path, a fraction and a date. */
    for (const prose of [
      "what about src/lib/clear.ts",
      "and/or",
      "on 12/3",
      "C:/Users/flori",
      "https://example.com/dataviz",
    ]) {
      expect(slashAt(prose, null)).toBeNull();
      expect(offered(prose)).toEqual([]);
    }
  });

  test("a newline counts as the start of a word, and so does a space", () => {
    expect(slashAt("first line\n/dataviz", null)?.name).toBe("dataviz");
    expect(slashAt("use /dataviz", null)?.name).toBe("dataviz");
  });

  test("the name is the whole token, wherever inside it the caret sits", () => {
    /* Putting the caret back into the middle of a name you can already see has
       to match the name you can see — and it is what makes a stale caret
       harmless, since every position inside the token gives one answer. */
    for (const at of [1, 3, 6]) {
      expect(slashAt("/clear", at)?.name).toBe("clear");
    }
  });

  test("a caret before the slash is not in the name", () => {
    expect(slashAt("/clear", 0)).toBeNull();
  });

  test("a caret past the end of the text is clamped rather than trusted", () => {
    /* The draft can be rewritten under a position that was true a keystroke
       ago, and the answer has to be about the text that is here now. */
    expect(slashAt("/clear", 400)?.name).toBe("clear");
    expect(slashAt("/clear", -5)).toBeNull();
  });

  test("null is the end of the text, which is what this did before it had one", () => {
    expect(slashAt("/cle")).toEqual(slashAt("/cle", null));
    expect(slashAt("/cle")).toEqual(slashAt("/cle", 4));
  });

  test("a colon is part of a name, because a plugin's skills are named with one", () => {
    expect(slashAt("/tx-toolkit:committee", null)?.name).toBe(
      "tx-toolkit:committee",
    );
  });
});

describe("everything at the head, skills anywhere", () => {
  test("a bare slash at the head offers everything, ours first", () => {
    /* Locality: this window's own, then the CLI's whole vocabulary in the order
       it published it — which puts a project's own commands before the skills. */
    expect(offered("/")).toEqual([
      ...COMMANDS.map((c) => c.name),
      ...VOCAB.map((v) => v.name),
    ]);
  });

  test("a bare slash inside a sentence offers only the skills", () => {
    /* Volery's own are run here, and the CLI's own and a project's command files
       are parsed by the CLI — none of the three reads the middle of a prompt, so
       offering one there would be offering something that cannot run. */
    expect(offered("please use /")).toEqual(SKILLS);
  });

  test("a name is found at the head beside the commands", () => {
    expect(offered("/dat")).toEqual(["dataviz"]);
    /* Prefix before contains, which is the rule the commands already had. */
    expect(offered("/l")[0]).toBe("loop");
    expect(offered("/l")).toContain("clear");
  });

  test("mid-sentence, a command with the same letters is not offered", () => {
    expect(offered("/c")).toContain("clear");
    expect(offered("/c")).toContain("commit");
    const inside = offered("make a chart with /c");
    expect(inside).not.toContain("clear");
    expect(inside).not.toContain("commit");
    /* Both skills whose name or alias starts with a c, in the order the CLI
       published them — `committee` is an alias, and an alias leads exactly as
       a name does. */
    expect(inside).toEqual(["tx-toolkit:committee", "code-review"]);
  });

  test("not knowing which are skills means offering more, not less", () => {
    /* A card that has taken no turn has no `skills` array, and the honest
       fallback is every row rather than none: picking one mid-sentence only ever
       *inserts its text*, since Enter completes rather than runs once there is
       prose around it. The cost of being wrong that way is a row you did not
       want; the other way it is the whole feature missing on a fresh card. */
    const inside = matchCommands("use /c", null, unlabelled).map((c) => c.name);
    expect(inside).toContain("code-review");
    expect(inside).toContain("commit");
    /* Volery's own are still head-only — those are never in `extra`. */
    expect(inside).not.toContain("clear");
  });

  test("an empty skills array is a real answer and narrows it", () => {
    /* `skillsKnown` rather than `skills.length`: a card whose agent genuinely
       has no skills must narrow the palette exactly as a populated one does. */
    const known = paletteExtras(VOCAB, [], true);
    expect(matchCommands("use /c", null, known)).toEqual([]);
  });

  test("a card with nothing extra gets exactly the palette it always had", () => {
    expect(matchCommands("/")).toEqual(matchCommands("/", null, []));
    expect(offered("/zzz")).toEqual([]);
  });
});

describe("the aliases the CLI publishes", () => {
  test("a name is found through its alias, and the canonical name is what shows", () => {
    /* `review` is `code-review`'s published alias, and `committee` is the
       un-prefixed form of `tx-toolkit:committee` — the only part of it anybody
       types. An alias is a way to *find* a name, never a row of its own. */
    expect(offered("/rev")).toEqual(["code-review"]);
    expect(offered("/committee")).toEqual(["tx-toolkit:committee"]);
    expect(offered("/")).not.toContain("review");
    expect(offered("/")).not.toContain("committee");
  });

  test("an alias that repeats its own name is dropped", () => {
    /* `frontend-design:frontend-design` publishes `frontend-design`, which is a
       real alias; one identical to the name itself would be noise. */
    expect(vocabRow({ name: "x", aliases: ["x", "y"] }, false).aliases).toEqual(["y"]);
  });

  test("aliases are matched mid-sentence too, for a skill", () => {
    expect(
      matchCommands("chart it with /committee", null, extras).map((c) => c.name),
    ).toEqual(["tx-toolkit:committee"]);
  });
});

describe("what the CLI says about each row is what is drawn", () => {
  test("the description is the summary, in its author's words", () => {
    /* The whole reason for asking rather than working it out. An earlier version
       of this invented a summary from the shape of the name, because the only
       source then in use carried names and nothing else. */
    expect(row("dataviz").summary).toBe("Charts that read as one system.");
    expect(row("commit").summary).toBe(
      "stage and commit what this work touched (project)",
    );
    /* Including for the CLI's own built-ins, which are inside a 320MB binary
       and on disk nowhere — the case that used to be unanswerable. */
    expect(row("code-review").summary).toBe("Review the current diff.");
  });

  test("a row with no description at all still reads as something", () => {
    expect(vocabRow({ name: "x" }, true).summary).toBe("a skill this card has");
    expect(vocabRow({ name: "x" }, false).summary).toBe("the agent's own command");
  });

  test("the detail says who reads it, which is what decides where it may sit", () => {
    expect(row("dataviz").detail).toContain("anywhere in a sentence");
    expect(row("commit").detail).toContain("start of a line");
  });

  test("the hint is carried, and is not a claim that the row is incomplete", () => {
    /* `takesText` would make it `stillWriting` with nothing after it, and Enter
       on `/loop` would then never send anything — but `/loop` is perfectly
       runnable bare. */
    expect(row("loop").hint).toBe("[interval] [prompt]");
    expect(row("deep:nested").hint).toBe("branch");
    expect(row("dataviz").hint).toBeUndefined();
    expect(stillWriting(row("loop"), "")).toBe(false);
  });

  test("a row that takes something is completed with a space to write in", () => {
    expect(completionFor(row("loop"))).toBe("/loop ");
    expect(completionFor(row("deep:nested"))).toBe("/deep:nested ");
    /* A skill gets it either way: it takes whatever you say after it whether or
       not the CLI thought to describe that, and it is the one kind of row that
       gets completed mid-sentence. */
    expect(completionFor(row("dataviz"))).toBe("/dataviz ");
    /* And one that takes nothing does not, so Enter sends it as it stands. */
    expect(completionFor(row("commit"))).toBe("/commit");
    expect(completionFor(row("bare"))).toBe("/bare");
  });
});

describe("none of it is intercepted, which is the rule this file opened with", () => {
  test("this window never takes custody of one", () => {
    /* `resolveCommand` answers only for Volery's own, so all of these fall
       through and go to the agent as the prompts they are — exactly what
       `/commit` always did. */
    expect(resolveCommand("/dataviz")).toBeNull();
    expect(resolveCommand("/dataviz make a chart")).toBeNull();
    expect(resolveCommand("/commit")).toBeNull();
  });

  test("a skill is not one of the CLI's, which is a different question", () => {
    /* `cliCommand` decides whether a card may be named after what you typed. A
       skill *is* something you said to the agent, so `/dataviz make a chart` is
       a fine name for a card where `/model sonnet` is not. */
    expect(cliCommand("/dataviz make a chart")).toBeNull();
    expect(row("dataviz").by).toBe("skill");
    expect(row("commit").by).toBe("cli");
  });

  test("every row reaches cards, so it costs the reach modifier like a prompt", () => {
    for (const c of extras) expect(c.needsCard).toBe(true);
  });
});

describe("which key may claim a lit row", () => {
  /* The safety property this file opens with, met from a direction that did not
     exist when it was written. `/commit` is the project's own command and has to
     reach the agent unread — and it very nearly stopped doing so, because
     `committee` is the alias the CLI publishes for `tx-toolkit:committee` and it
     begins with those same letters. */

  test("the offending case is really offered, so this is not hypothetical", () => {
    expect(offered("/commit")).toContain("tx-toolkit:committee");
  });

  test("Enter may not run one of the agent's on a partial name", () => {
    /* Not because it is a weak match — `committee`.startsWith(`commit`) is true.
       Because it is *theirs*, and a prefix of a name in a vocabulary that
       changes per directory can silently be a different command from the one
       you typed in full. */
    expect(mayRunOn(row("tx-toolkit:committee"), "commit")).toBe(false);
    expect(mayRunOn(row("code-review"), "code")).toBe(false);
  });

  test("but typing one of theirs in full does run it", () => {
    expect(mayRunOn(row("tx-toolkit:committee"), "tx-toolkit:committee")).toBe(true);
    /* Including by the alias, which is the only part anybody types. */
    expect(mayRunOn(row("tx-toolkit:committee"), "committee")).toBe(true);
    expect(mayRunOn(row("code-review"), "review")).toBe(true);
  });

  test("an abbreviation of one of ours still runs, as it always has", () => {
    /* "`/cle` + Enter clears, as in the CLI" — nine closed names this window
       owns and whoever is typing knows. */
    const clear = COMMANDS.find((c) => c.name === "clear")!;
    expect(mayRunOn(clear, "cle")).toBe(true);
    expect(mayRunOn(clear, "clear")).toBe(true);
    /* And the CLI's own that *we* offer count as ours: they are this file's to
       put in the palette whoever carries them out. */
    expect(mayRunOn(COMMANDS.find((c) => c.name === "compact")!, "comp")).toBe(true);
  });

  test("a browse may run anything, because nothing has been typed to be wrong about", () => {
    expect(mayRunOn(row("dataviz"), "")).toBe(true);
    expect(mayRunOn(row("dataviz"), "   ")).toBe(true);
  });

  test("it is asked case-insensitively, like everything else here", () => {
    expect(mayRunOn(row("dataviz"), "DATAVIZ")).toBe(true);
    expect(mayRunOn(COMMANDS.find((c) => c.name === "clear")!, "CLE")).toBe(true);
  });
});


describe("what the vocabularies do when they collide", () => {
  test("nothing may shadow one of Volery's own", () => {
    /* Two rows under one name is a palette whose `{#each}` keys collide, and
       "what does `/clear` do here" has one answer. */
    const both = paletteExtras([{ name: "clear", description: "theirs" }], ["clear"], true);
    expect(both).toEqual([]);
    expect(matchCommands("/clear", null, both).map((c) => c.name)).toEqual(["clear"]);
    expect(matchCommands("/clear", null, both)[0].by).toBe("skein");
  });

  test("the first of any duplicate name wins", () => {
    const twice = paletteExtras(
      [
        { name: "dataviz", description: "first" },
        { name: "dataviz", description: "second" },
      ],
      [],
      true,
    );
    expect(twice).toHaveLength(1);
    expect(twice[0].summary).toBe("first");
  });

  test("names arrive lowercased, or a row would be unreachable", () => {
    /* The palette matches in lowercase, so a `Commit.md` findable only by typing
       `/Commit` would be a row nobody can reach. `slash.rs` folds it too; this
       is the belt to that braces. */
    expect(
      paletteExtras([{ name: "Commit" }, { name: " DataViz " }], [], true).map(
        (c) => c.name,
      ),
    ).toEqual(["commit", "dataviz"]);
  });

  test("an empty name is not a row", () => {
    expect(paletteExtras([{ name: "  " }, { name: "" }], [], true)).toEqual([]);
  });
});


describe("where a completion lands", () => {
  test("at the head it replaces the whole draft, as completing used to", () => {
    const span = slashAt("/cle", null)!;
    expect(completeAt("/cle", span, "/clear")).toEqual({
      text: "/clear",
      caret: 6,
    });
  });

  test("mid-sentence it replaces the word and keeps the sentence", () => {
    const draft = "make a chart with /dat for me";
    const span = slashAt(draft, 22)!;
    expect(completeAt(draft, span, "/dataviz ")).toEqual({
      text: "make a chart with /dataviz  for me",
      caret: 27,
    });
  });

  test("the caret lands after what was inserted, not at the end of the line", () => {
    const draft = "/dat and then some more";
    const span = slashAt(draft, 4)!;
    const done = completeAt(draft, span, "/dataviz ");
    expect(done.text.slice(0, done.caret)).toBe("/dataviz ");
  });
});
