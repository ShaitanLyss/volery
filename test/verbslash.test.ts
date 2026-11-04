import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, matchChoices, matchCommands, paletteExtras, resolveCommand, stirsCard, typingChoice } from "../src/lib/commands";
import { VERBS, VERB_SLASH, rowVerb, type Verb } from "../src/lib/handle";
import { CHORDS } from "../src/lib/leader";
import { menuFor } from "../src/lib/menu";
import {
  SLASHED,
  VERB_COMMANDS,
  VERB_NAMES,
  chordFor,
  menuRefusal,
  oneAtATime,
  settled,
  unoffered,
  verbNamed,
  verbOf,
  verbTakesWall,
  wallCommands,
  wallValues,
} from "../src/lib/verbslash";

/** `Verb`'s members, read off the source so the runtime half does not rest on
 *  the compiler alone (`test/handle.test.ts`'s shape). */
function declaredVerbs(): string[] {
  const src = readFileSync(join(import.meta.dir, "../src/lib/handle.ts"), "utf8");
  const m = /export type Verb =([\s\S]*?);/.exec(src);
  expect(m).not.toBeNull();
  return [...m![1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!).sort();
}

/* What `claude` 2.1.x answered `initialize` with on 2026-11-03
   (`bun tools/probe-skills.ts initialize`), built-ins and the skills on this
   machine: the names a verb's command could shadow. */
const CLI_NAMES = [
  "advisor", "agents", "auto-mode-setup", "autocompact", "batch", "clear", "color", "compact", "config",
  "context", "debug", "doctor", "effort", "extra-usage", "fast", "focus", "goal", "heapdump", "import", "init",
  "insights", "list-agents", "loop", "mcp", "model", "output-style", "recap", "reload-plugins", "reload-skills",
  "rename", "run", "schedule", "security-review", "simplify", "skill-doctor", "team-onboarding", "usage",
  "usage-credits", "verify", "design", "design-sync", "dataviz", "update-config", "code-review", "docs", "pdf",
  "morning", "docx", "pptx", "xlsx",
];
const CLI_ALIASES = ["reset", "new", "settings", "name", "cost", "stats", "peers", "review", "checkup", "proactive", "routines"];

describe("every verb is a slash command, or says why not", () => {
  test("the registry decides every verb the source declares", () => {
    const declared = declaredVerbs();
    expect(declared.length).toBeGreaterThan(15);
    expect(Object.keys(VERB_SLASH).sort()).toEqual(declared);
    expect([...VERBS].sort()).toEqual(declared);
  });

  test("there are no exceptions — Lyss asked for none", () => {
    const exceptions = VERBS.filter((v) => "noSlash" in VERB_SLASH[v]);
    expect(exceptions).toEqual([]);
    /* And if one is ever written, it is a sentence somebody can act on. */
    for (const v of exceptions) expect((VERB_SLASH[v] as { noSlash: string }).noSlash.length).toBeGreaterThan(40);
  });

  test("renew, the one that was missing, is a command that runs the verb", () => {
    const r = resolveCommand("/renew");
    expect(r?.cmd.verb).toBe("renew");
    expect(verbOf(r!.cmd, r!.arg)).toEqual({ verb: "renew", args: {} });
    expect(matchCommands("/ren").map((c) => c.name)).toContain("renew");
  });

  test("names are typable, unique, lowercase, and say what they do", () => {
    const names = SLASHED.map(([, s]) => s.slash);
    expect(new Set(names).size).toBe(names.length);
    for (const [, s] of SLASHED) {
      expect(s.slash).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(s.summary).toBe(s.summary.toLowerCase());
      expect(s.detail.length).toBeGreaterThan(20);
    }
    /* None takes a name one of Volery's other commands has. */
    const others = COMMANDS.filter((c) => !c.verb).map((c) => c.name);
    for (const n of names) expect(others).not.toContain(n);
  });

  test("no verb shadows the CLI's own vocabulary, but `/clear`, which was decided long ago", () => {
    for (const n of VERB_NAMES) {
      if (n === "clear") continue;
      expect(CLI_NAMES).not.toContain(n);
      expect(CLI_ALIASES).not.toContain(n);
    }
  });

  test("a skill or project command by a verb's name is never offered beside it", () => {
    const rows = paletteExtras(
      [{ name: "move", description: "a project command" }, { name: "renew", description: "a skill" }, { name: "dataviz", description: "" }],
      [],
      false,
    );
    expect(rows.map((r) => r.name)).toEqual(["dataviz"]);
  });
});

describe("the fixed rows and the rows off the wall", () => {
  test("every verb without wall values is in the catalogue, reachable by its name", () => {
    for (const [v, s] of SLASHED) {
      if (verbTakesWall(v)) {
        expect(COMMANDS.find((c) => c.name === s.slash)).toBeUndefined();
        continue;
      }
      const row = COMMANDS.find((c) => c.name === s.slash);
      expect(row?.verb).toBe(v);
      expect(matchCommands(`/${s.slash}`)).toContain(row!);
    }
    expect(VERB_COMMANDS.length).toBe(SLASHED.filter(([v]) => !verbTakesWall(v)).length);
  });

  test("a wall verb's row is there only with values — an account wants two", () => {
    expect(wallCommands({}).map((c) => c.name)).toEqual([]);
    const one = [{ value: "a", summary: "a" }];
    expect(wallCommands({ account: one, move: one, regroup: one, hand: one }).map((c) => c.name).sort()).toEqual(
      ["hand", "move", "regroup"],
    );
    expect(wallCommands({ account: [...one, { value: "b", summary: "b" }] }).map((c) => c.name)).toEqual(["account"]);
  });

  test("/clear and /account are what they were", () => {
    const clear = resolveCommand("/clear");
    expect(clear?.cmd.verb).toBe("clear");
    expect(clear?.cmd.summary).toBe("start this card fresh");
    /* A sentence after it is a sentence, sent to the agent. */
    expect(resolveCommand("/clear the deck")).toBeNull();
    const two = [{ value: "lyss", summary: "ready" }, { value: "tx-team", summary: "ready" }];
    const acc = resolveCommand("/account tx-team", two)!;
    expect(verbOf(acc.cmd, acc.arg)).toEqual({ verb: "account", args: { account: "tx-team" } });
  });

  test("/provider carries claude and deepseek, and the menu row asks the same verb", () => {
    const cmd = VERB_COMMANDS.find((c) => c.name === "provider")!;
    expect(cmd.choices?.map((c) => c.value)).toEqual(["claude", "deepseek"]);
    const moved = resolveCommand("/provider deepseek")!;
    expect(verbOf(moved.cmd, moved.arg)).toEqual({ verb: "provider", args: { provider: "deepseek" } });
    expect(rowVerb("provider:claude")).toEqual({ verb: "provider", args: { provider: "claude" } });
  });

  test("the keep is a pair, and keeps the palette up past the space", () => {
    expect(matchChoices("/keep ").map((c) => c.value)).toEqual(["wall", "glass"]);
    expect(typingChoice("/keep g")?.cmd.verb).toBe("keep");
    const r = resolveCommand("/keep glass")!;
    expect(verbOf(r.cmd, r.arg)).toEqual(rowVerb("keep:glass"));
    const w = resolveCommand("/keep wall")!;
    expect(verbOf(w.cmd, w.arg)).toEqual(rowVerb("keep:wall"));
  });

  test("the chord beside a row is the leader table's own keys", () => {
    expect(chordFor("renew")).toBe("cn");
    expect(chordFor("close")).toBe("cc");
    expect(chordFor("regroup")).toBeUndefined();
    for (const c of [...VERB_COMMANDS, ...wallCommands({ move: [{ value: "x", summary: "x" }] })]) {
      if (!c.chord) continue;
      expect(CHORDS.some((k) => k.keys === c.chord && k.verb.kind === "card")).toBe(true);
    }
  });
});

describe("the same lists the right-click offers", () => {
  const target = {
    kind: "card" as const,
    id: "c1",
    groupings: [
      { id: "t-9", name: "Docs Work" },
      { id: "t-10", name: "docs work" },
    ],
    walls: ["AU-LT-288"],
    plan: true,
    presets: [{ id: "quick", label: "a quick question", note: "haiku, low" }],
    pinned: true,
  };

  test("values are typable words that send what the menu row sends", () => {
    const v = wallValues(target);
    expect(v.regroup!.map((c) => c.value)).toEqual(["docs-work", "docs-work-2"]);
    expect(v.move!.map((c) => c.value)).toEqual(["au-lt-288"]);
    expect(v.hand!.map((c) => c.value)).toEqual(["a-quick-question"]);
    for (const list of Object.values(v)) for (const c of list!) expect(c.value).toMatch(/^\S+$/);
    const rows = wallCommands(v);
    const by = (n: string) => rows.find((c) => c.name === n)!;
    expect(verbOf(by("regroup"), "docs-work-2")).toEqual(rowVerb("regroup:t-10"));
    expect(verbOf(by("move"), "au-lt-288")).toEqual(rowVerb("move:AU-LT-288"));
    expect(verbOf(by("hand"), "a-quick-question")).toEqual(rowVerb("hand:quick"));
  });

  test("every row the card's menu draws has a command that asks the same", () => {
    const v = wallValues(target);
    const rows = [...COMMANDS, ...wallCommands({ ...v, account: [{ value: "a", summary: "" }, { value: "b", summary: "" }] })];
    const ids: string[] = [];
    const walk = (items: ReturnType<typeof menuFor>) => {
      for (const i of items) {
        if (i.kind !== "item") continue;
        if ("items" in i && i.items) walk(i.items as ReturnType<typeof menuFor>);
        else ids.push(i.id);
      }
    };
    walk(
      menuFor({
        ...target,
        dormant: true,
        spoken: true,
        accounts: true,
        accountPicks: [
          { id: "a", label: "a", on: true },
          { id: "b", label: "b", on: false },
        ],
      } as Parameters<typeof menuFor>[0]),
    );
    const verbs = new Set(ids.map((id) => rowVerb(id)?.verb).filter(Boolean) as Verb[]);
    expect(verbs.size).toBeGreaterThan(10);
    for (const v of verbs) expect(rows.some((c) => c.verb === v)).toBe(true);
  });

  test("the menu's conditions hold: groupings only on the wall, presets only with a plan", () => {
    expect(wallValues({ ...target, view: "chat" }).regroup).toBeUndefined();
    expect(wallValues({ ...target, plan: false }).hand).toBeUndefined();
    expect(wallValues({ ...target, verbs: new Set<Verb>(["close"]) })).toEqual({});
    expect(wallValues(null)).toEqual({});
  });

  test("a host typed as the machine spells it resolves to the value", () => {
    const v = wallValues(target);
    expect(resolveCommand("/move AU-LT-288", v)?.arg).toBe("au-lt-288");
    expect(resolveCommand("/move elsewhere", v)).toBeNull();
  });
});

describe("what is said when a command cannot run", () => {
  test("a verb's name with nothing to offer says the menu's silence", () => {
    expect(verbNamed("/move")).toBe("move");
    expect(verbNamed("/move somewhere")).toBe("move");
    expect(verbNamed("/moved")).toBeNull();
    expect(verbNamed(" /move")).toBeNull();
    expect(unoffered("move", "/move")).toContain("no other machine");
    expect(unoffered("regroup", "/regroup x")).toContain("no other grouping");
    expect(unoffered("account", "/account x", { account: [{ value: "a", summary: "" }] })).toContain("only one account");
  });

  test("a value the card does not have names the ones it does", () => {
    const why = unoffered("move", "/move nowhere", { move: [{ value: "lab", summary: "" }] });
    expect(why).toBe('/move takes one of lab — not "nowhere"');
  });

  test("unpin is refused on a card that is not pinned, as the menu would not offer it", () => {
    expect(menuRefusal("pin", { kind: "card", pinned: false } as never)).toContain("not pinned");
    expect(menuRefusal("pin", { kind: "card", pinned: true } as never)).toBeNull();
    expect(menuRefusal("renew", { kind: "card" } as never)).toBeNull();
  });
});

describe("what the review found", () => {
  test("an abbreviation never lights the close ahead of a gentler name", () => {
    expect(matchCommands("/cl")[0]?.name).toBe("clear");
    expect(matchCommands("/clo")[0]?.name).toBe("close");
    expect(matchCommands("/close")[0]?.name).toBe("close");
  });

  test("the menu's view and account gates hold for the command too", () => {
    expect(menuRefusal("glass", { kind: "card", view: "chat" } as never)).toContain("wall");
    expect(menuRefusal("keep", { kind: "card", view: "chat" } as never)).toContain("wall");
    expect(menuRefusal("glass", { kind: "card", view: "wall" } as never)).toBeNull();
    expect(menuRefusal("bypass", { kind: "card", accounts: false } as never)).toContain("no accounts");
    expect(menuRefusal("bypass", { kind: "card", accounts: true } as never)).toBeNull();
  });

  test("a gathering takes the per-card verbs, and not the ones with one answer on screen", () => {
    for (const v of ["close", "processes", "copy-resume", "copy-cwd", "glass", "move", "regroup", "hand"] as Verb[])
      expect(oneAtATime(v)).not.toBeNull();
    for (const v of ["aside", "bypass", "stop", "wake", "clear", "renew", "account", "keep", "pin"] as Verb[])
      expect(oneAtATime(v)).toBeNull();
  });

  test("a toggle over a gathering says the side, off the card in the ring", () => {
    expect(settled("aside", {}, { kind: "card", aside: true } as never)).toEqual({ on: false });
    expect(settled("bypass", {}, { kind: "card", bypassing: false } as never)).toEqual({ on: true });
    expect(settled("renew", {}, { kind: "card" } as never)).toEqual({});
  });

  test("a card on another wall is offered that wall's accounts", () => {
    const v = wallValues({
      kind: "card",
      host: "lab-b",
      accountPicks: [
        { id: "Work", label: "Work", on: true },
        { id: "home", label: "home", on: false },
      ],
    });
    expect(v.account!.map((c) => c.value)).toEqual(["work", "home"]);
    const row = wallCommands(v).find((c) => c.name === "account")!;
    expect(verbOf(row, "work")).toEqual(rowVerb("account:Work"));
    /* A card here keeps the waterfall's list, which `App` hands in. */
    expect(wallValues({ kind: "card", accountPicks: [{ id: "a", label: "a", on: true }] }).account).toBeUndefined();
  });

  test("typing a verb into a dormant card does not wake it", () => {
    for (const n of ["/move lab", "/account x", "/regroup docs", "/hand deep", "/renew"]) expect(stirsCard(n)).toBe(false);
    expect(stirsCard("move the file")).toBe(true);
  });
});
