import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTS,
  COST,
  VERBS,
  actFor,
  actRefusal,
  canDo,
  carriesTo,
  dockHints,
  panelNotes,
  refusal,
  rowVerb,
  verbsFor,
  type Remote,
} from "../src/lib/handle";
import { menuFor } from "../src/lib/menu";

const lab = (over: Partial<Remote> = {}): Remote => ({
  host: "lab",
  unheard: false,
  acts: new Set(),
  closes: true,
  ...over,
});
const ids = (t: Parameters<typeof menuFor>[0]) =>
  menuFor(t).flatMap((i) => (i.kind === "item" || i.kind === "more" ? [i.id] : []));

describe("which verbs a card can be asked", () => {
  test("a card on this wall has them all, which is the answer its menu always had", () => {
    expect(verbsFor(null)).toBeNull();
    expect(refusal(null, "clear")).toBeNull();
  });

  /* Today's shadow: nothing announced, so what it has always had — and its
     last message kept on this wall, which is this wall's furniture too. */
  test("a wall announcing no verbs gets the glass, the close and the keep", () => {
    expect([...verbsFor(lab())!].sort()).toEqual(["close", "glass", "keep"]);
  });

  test("an announced verb is offered, an unannounced one is not", () => {
    const v = verbsFor(lab({ acts: new Set(["aside", "clear"]) }))!;
    expect(v.has("aside")).toBe(true);
    expect(v.has("clear")).toBe(true);
    expect(v.has("wake")).toBe(false);
  });

  /* Account and ignore-caps are `work`: the owner's money. Allowed remotely
     (Lyss: "i am the owner everywhere") but gated like a prompt. */
  test("account, bypass and clear can be asked remotely once announced", () => {
    const v = verbsFor(lab({ acts: new Set(["account", "bypass", "clear"]) }))!;
    for (const k of ["account", "bypass", "clear"] as const) expect(v.has(k)).toBe(true);
  });

  /* A wall that has gone quiet is offered nothing that would have to reach it,
     whatever it once announced — never queued for a lid to lift. */
  test("an unheard wall offers nothing that has to reach it", () => {
    const v = verbsFor(lab({ unheard: true, acts: new Set(VERBS) }))!;
    /* The keep reaches nothing: a pin of a quiet wall's card says it is quiet. */
    expect([...v].sort()).toEqual(["close", "glass", "keep"]);
    expect(refusal(lab({ unheard: true }), "aside")).toBe("lab has not been heard from");
  });

  test("what is local by nature is never offered, and says where it is", () => {
    const v = verbsFor(lab({ acts: new Set(VERBS) }))!;
    for (const k of VERBS.filter((k) => COST[k] === "local")) {
      expect(v.has(k)).toBe(false);
      expect(refusal(lab(), k)).toBe("that is on lab");
    }
  });

  test("a verb the wall has not been updated for says so", () => {
    expect(refusal(lab(), "clear")).toBe("lab needs updating to do that from here");
  });

  /* The table is complete: every verb has a cost, so a verb added to `Verb`
     cannot slip through ungated. */
  test("every verb has a cost", () => {
    for (const v of VERBS) expect(COST[v]).toBeDefined();
  });
});

describe("the menu a shadow gets is the card's, filtered", () => {
  test("unannounced: glass, the keep and close, as before", () => {
    expect(ids({ kind: "card", host: "lab", verbs: verbsFor(lab()) })).toEqual([
      "glass",
      "keep:wall",
      "keep:glass",
      "close",
    ]);
  });

  test("announced verbs reach the same rows a local card has", () => {
    const verbs = verbsFor(lab({ acts: new Set(["aside", "bypass", "account", "clear", "wake"]) }));
    const got = ids({
      kind: "card",
      host: "lab",
      verbs,
      dormant: true,
      spoken: true,
      accounts: true,
      accountPicks: [
        { id: "a", label: "a", on: true },
        { id: "b", label: "b", on: false },
      ],
    });
    expect(got).toEqual(["wake", "aside", "bypass", "account", "glass", "keep:wall", "keep:glass", "clear", "close"]);
  });

  test("a local card is untouched by any of it", () => {
    expect(ids({ kind: "card" })).toEqual(ids({ kind: "card", verbs: null }));
    expect(ids({ kind: "card" })).toContain("copy-resume");
  });
});

describe("the verbs that cross as an act", () => {
  /* `flyway/act.rs` is the wall's own list of what it will do; the two are held
     equal here, cost and all, so a verb added on one side cannot be offered by
     a build whose other half has never heard of it. */
  test("the table here and act.rs's VERBS are the same verbs at the same costs", () => {
    const src = readFileSync(join(import.meta.dir, "../src-tauri/src/flyway/act.rs"), "utf8");
    const block = src.slice(src.indexOf("pub const VERBS"), src.indexOf("];", src.indexOf("pub const VERBS")));
    const rust = [...block.matchAll(/\("([a-z-]+)", Cost::(\w+)\)/g)].map((m) => [m[1], m[2]!.toLowerCase()]);
    expect(rust.length).toBeGreaterThan(0);
    expect(rust.map(([v]) => v).sort()).toEqual([...ACTS].sort());
    for (const [v, c] of rust) expect(COST[v as keyof typeof COST]).toBe(c as never);
  });

  test("a setting crosses as the state wanted, never as a toggle", () => {
    const face = { aside: true, bypassCaps: false, working: true };
    const asked = (id: string) => {
      const r = rowVerb(id)!;
      return actFor(r.verb, r.args, face);
    };
    expect(asked("aside")).toEqual({ verb: "aside", args: { on: false } });
    expect(asked("bypass")).toEqual({ verb: "bypass", args: { on: true } });
    expect(asked("account:work")).toEqual({ verb: "account", args: { account: "work", sawWorking: true } });
    expect(asked("clear")).toEqual({ verb: "clear", args: { sawWorking: true } });
    expect(asked("copy-cwd")).toEqual({ verb: "copy-cwd", args: {} });
    expect(asked("stop")).toEqual({ verb: "stop", args: {} });
    for (const id of ["glass", "close", "processes", "unpin", "move:lab"]) expect(asked(id)).toBeNull();
  });

  /* A key that says which way it wants the setting is believed over the face,
     which may be a snapshot old. */
  test("a toggle the gesture states is sent as stated", () => {
    const face = { aside: true, bypassCaps: false, working: false };
    expect(actFor("aside", { on: true }, face)).toEqual({ verb: "aside", args: { on: true } });
  });

  /* Stopping a turn ends work and starts none: a person's, like the close, so
     it passes the far wall's switch — but it crosses as an act, where the close
     has its own road. */
  test("a stop is a person's and crosses as an act; the close does not", () => {
    expect(COST.stop).toBe("person");
    expect(ACTS).toContain("stop");
    expect(ACTS).not.toContain("close");
    expect(verbsFor(lab({ acts: new Set(["stop"]) }))!.has("stop")).toBe(true);
    expect(verbsFor(lab())!.has("stop")).toBe(false);
    expect(refusal(lab(), "stop")).toBe("lab needs updating to do that from here");
  });

  /* What the owner checks again at the moment of acting. */
  test("a clear is refused on a card that has started a turn since", () => {
    expect(actRefusal("clear", { sawWorking: false }, { working: true }, [], "lab")).toContain("started a turn");
    expect(actRefusal("clear", { sawWorking: true }, { working: true }, [], "lab")).toBeNull();
    expect(actRefusal("clear", { sawWorking: false }, { working: false }, [], "lab")).toBeNull();
  });

  test("an account this wall cannot put a card on is refused, and so is a verb it does not do", () => {
    expect(actRefusal("account", { account: "work" }, { working: false }, ["work"], "lab")).toBeNull();
    expect(actRefusal("account", { account: "gone" }, { working: false }, ["work"], "lab")).toContain("no account called gone");
    expect(actRefusal("processes", {}, { working: false }, [], "lab")).toContain("does not know");
  });

  test("the copy rows on a remote card say whose machine the answer is from", () => {
    const verbs = verbsFor(lab({ acts: new Set(["copy-resume", "copy-cwd"]) }));
    const rows = menuFor({ kind: "card", host: "lab", verbs }).filter((i) => i.kind === "item");
    const label = (id: string) => rows.find((i) => i.kind === "item" && i.id === id);
    expect(label("copy-resume")).toMatchObject({ label: "copy resume command on lab" });
    expect(label("copy-cwd")).toMatchObject({ label: "copy working directory on lab" });
    const local = menuFor({ kind: "card" }).find((i) => i.kind === "item" && i.id === "copy-cwd");
    expect(local).toMatchObject({ label: "copy working directory" });
  });
});

describe("a move to another account ends the process, as a clear does", () => {
  test("so it is refused on a card that has started a turn since", () => {
    expect(actRefusal("account", { account: "w", sawWorking: false }, { working: true }, ["w"], "lab")).toContain(
      "started a turn",
    );
    expect(actRefusal("account", { account: "w", sawWorking: true }, { working: true }, ["w"], "lab")).toBeNull();
  });
});

describe("one row vocabulary for the menu and the keys", () => {
  test("a row names its verb and the verb's own arguments", () => {
    expect(rowVerb("hand:deep")).toEqual({ verb: "hand", args: { preset: "deep" } });
    expect(rowVerb("regroup:t1")).toEqual({ verb: "regroup", args: { territory: "t1" } });
    expect(rowVerb("move:lab")).toEqual({ verb: "move", args: { host: "lab" } });
    expect(rowVerb("account:work")).toEqual({ verb: "account", args: { account: "work" } });
    expect(rowVerb("unpin")).toEqual({ verb: "pin", args: { on: false } });
    expect(rowVerb("close")).toEqual({ verb: "close", args: {} });
    expect(rowVerb("set:clock")).toBeNull();
  });

  /* Every row the card's menu can draw is one the handle can dispatch, so a
     row added to `cardRows` without a verb behind it fails here rather than
     doing nothing when it is clicked. */
  test("every card row is a verb", () => {
    const everything = menuFor({
      kind: "card",
      dormant: true,
      pinned: true,
      spoken: true,
      accounts: true,
      accountPicks: [
        { id: "a", label: "a", on: true },
        { id: "b", label: "b", on: false },
      ],
      plan: true,
      presets: [{ id: "deep", label: "deep", note: "" }],
      groupings: [{ id: "t", name: "t" }],
      walls: ["lab"],
    });
    const leaves = everything.flatMap((i) =>
      i.kind === "item" ? [i.id] : i.kind === "more" ? i.items.flatMap((x) => (x.kind === "item" ? [x.id] : [])) : [],
    );
    expect(leaves.length).toBeGreaterThan(10);
    for (const id of leaves) expect(rowVerb(id)).not.toBeNull();
  });
});

describe("whether a verb has anything to act on", () => {
  const face = { dormant: false, working: false, spoken: true };
  test("the face decides, the same for a card here and one elsewhere", () => {
    expect(canDo(null, "wake", face)).toEqual({ no: "it is not dormant" });
    expect(canDo(null, "stop", face)).toEqual({ no: "it is not working" });
    expect(canDo(null, "stop", { ...face, working: true })).toBe("yes");
    /* A card holding messages, or about to heal, is at rest by design and
       about to act on its own — Escape aimed at it means don't (sink 864ccaae). */
    expect(canDo(null, "stop", { ...face, pending: true })).toBe("yes");
    expect(canDo(null, "clear", { ...face, spoken: false })).toEqual({ no: "nothing to clear yet" });
    expect(canDo(null, "clear", { ...face, spoken: false, working: true })).toBe("yes");
    expect(canDo(lab({ acts: new Set(["stop"]) }), "stop", { ...face, working: true })).toBe("yes");
  });

  /* Where the card stands is the reason that explains the rest, so it is
     asked first: a quiet wall's card is "not heard from", not "not working". */
  test("a reason about the wall comes before one about the card", () => {
    expect(canDo(lab({ unheard: true, acts: new Set(VERBS) }), "stop", face)).toEqual({
      no: "lab has not been heard from",
    });
    expect(canDo(lab(), "processes", face)).toEqual({ no: "that is on lab" });
  });
});

describe("what the dock says beside a card", () => {
  test("a card here: what sending will do to it", () => {
    expect(dockHints({ dormant: true, aside: true, interrupted: true }, null).map((h) => h.text)).toEqual([
      "dormant — wakes when you type",
      "set aside — sending picks it back up",
      "last turn was interrupted",
    ]);
    expect(dockHints({ dormant: false, aside: false }, null)).toEqual([]);
  });

  /* Where the words go comes first, and a dormant card over there wakes when
     the words arrive — no touch travels to give it a head start. */
  test("a card elsewhere: where the words go, then the same", () => {
    expect(dockHints({ dormant: true, aside: true }, lab())).toEqual([
      { text: "on lab — words only, sent there" },
      { text: "dormant — wakes when your words arrive" },
      { text: "set aside — sending picks it back up" },
    ]);
    const quiet = dockHints({ dormant: true, aside: false }, lab({ unheard: true }));
    expect(quiet).toEqual([{ text: "on lab, not heard from — a prompt would be refused", tone: "warn" }]);
  });

  /* "words only" is said of a wall that can take nothing else, and only of it. */
  test("a wall that takes pictures is not called words only", () => {
    expect(dockHints({ dormant: false, aside: false }, lab({ pictures: true }))).toEqual([{ text: "on lab — sent there" }]);
  });
});

/* A picture travels to a card elsewhere as it reaches a card here; what is
   refused is only what could not honestly arrive, each in a sentence, and
   always before the draft is cleared (`attach.md`, `elsewhere.md`). */
describe("whether a turn can reach a card on another wall", () => {
  /* A real PNG's first bytes, so the type check passes, padded to size. */
  const png = (name: string, chars: number) => ({
    name,
    mediaType: "image/png" as "image/png" | "image/jpeg",
    data: "iVBORw0KGgoAAAAN" + "A".repeat(Math.max(0, chars - 16)),
  });
  const turn = (carried: ReturnType<typeof png>[] = []) => ({
    content: [],
    echo: "look at ",
    shots: carried.map((c) => ({ name: c.name, thumb: "" })),
    carried,
    text: "look at " + carried.map((c) => `[${c.name}]`).join(" "),
  });

  test("words go to any wall that is heard", () => {
    expect(carriesTo(lab(), turn())).toBe("yes");
  });

  test("a picture goes to a wall that takes them", () => {
    expect(carriesTo(lab({ pictures: true }), turn([png("image 1", 400_000)]))).toBe("yes");
  });

  test("a quiet wall is refused first, pictures or not", () => {
    expect(carriesTo(lab({ unheard: true, pictures: true }), turn([png("image 1", 10)]))).toEqual({
      no: "lab has not been heard from — a prompt would be refused",
    });
  });

  /* The old reading refused every picture to every wall. Now only a wall
     that would take the words and not the picture is refused for it. */
  test("a picture to a wall from before them is refused, and words alone are not", () => {
    const why = carriesTo(lab(), turn([png("image 1", 10)]));
    expect(why).toEqual({
      no: "lab runs a Volery from before pictures could be sent to its cards — send the words alone, or update it there",
    });
    expect(carriesTo(lab(), turn([]))).toBe("yes");
  });

  test("past the ceiling is refused whole, in megabytes, never cut down to fit", () => {
    const four = 4 * 1024 * 1024;
    const why = carriesTo(lab({ pictures: true }), turn([png("a", four), png("b", four)]));
    expect(why).toEqual({
      no: "this prompt comes to 8.0 MB and at most 7 MB goes to lab at once — send fewer pictures, or smaller ones",
    });
    expect(carriesTo(lab({ pictures: true }), turn([png("a", four)]))).toBe("yes");
  });

  /* A file named .png that is a JPEG would pass here and be refused by the far
     wall's check after the draft had gone; asked here, the draft stays. */
  test("a picture that is not the type it says is refused before the draft goes", () => {
    const liar = { ...png("photo.png", 40), data: "/9j/4AAQSkZJRgABAQ" + "A".repeat(22) };
    expect(carriesTo(lab({ pictures: true }), turn([liar]))).toEqual({
      no: "photo.png is not the image/png it says it is — save it as what it is and attach it again",
    });
    expect(carriesTo(lab({ pictures: true }), turn([{ ...liar, mediaType: "image/jpeg" }]))).toBe("yes");
  });
});

describe("what a card elsewhere's panel says above its conversation", () => {
  const base = {
    host: "lab",
    unheard: false,
    tailState: "ready",
    tailWhy: null,
    closing: null,
    acting: null,
    open: 0,
    sheets: 0,
  };
  test("always how far back it goes", () => {
    const n = panelNotes(base);
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toContain("older rounds stay there");
  });

  test("a failed read, a close, a refused act and a question each say so, in their tone", () => {
    const n = panelNotes({
      ...base,
      tailState: "error",
      tailWhy: "it timed out",
      closing: { state: "refused", why: "not now" },
      acting: { verb: "copy-cwd", state: "refused", why: "gone" },
      open: 2,
    });
    expect(n.slice(1).map((x) => x.text)).toEqual([
      "could not read its conversation — it timed out",
      "lab did not close it — not now",
      "lab did not copy cwd — gone",
      "parked on 2 questions for you — answer them in the dock, and it goes back to lab",
    ]);
    expect(n.map((x) => x.tone)).toEqual([undefined, undefined, "warn", "warn", "ask"]);
  });

  /* A taken act is not said: the next snapshot shows what it did. */
  test("an act its wall took says nothing; one in flight says it is asking", () => {
    expect(panelNotes({ ...base, acting: { verb: "aside", state: "taken" } })).toHaveLength(1);
    expect(panelNotes({ ...base, acting: { verb: "aside", state: "asked" } })[1]!.text).toBe("asking lab to aside…");
  });

  test("a question left when its wall went quiet is not offered as one still waiting", () => {
    const n = panelNotes({ ...base, unheard: true, sheets: 1 });
    expect(n[1]!.text).toContain("cannot be answered from here until lab is heard again");
  });
});
