import { describe, expect, test } from "bun:test";
import {
  availableAt,
  blockersFor,
  capFor,
  choose,
  cleanAccount,
  cleanAccounts,
  cleanCaps,
  cleanLabel,
  exportAccounts,
  EXPORT_VERSION,
  importAccounts,
  mergeAccounts,
  ordered,
  sayBlocked,
  sayCeiling,
  sayImported,
  sayUnmeasured,
  sayUnsigned,
  speaksWith,
  several,
  standingOf,
  swapNote,
  usable,
  type Account,
  type AccountDoc,
  type Allowance,
} from "../src/lib/accounts";
import type { Window } from "../src/lib/limits";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 7, 19, 12, 0, 0);

function win(over: Partial<Window> = {}): Window {
  return {
    kind: "session",
    group: "session",
    used: 0,
    severity: "normal",
    resetsAt: null,
    scope: null,
    active: false,
    ...over,
  };
}

function acct(label: string, over: Partial<Account> = {}): Account {
  return { label, rank: 0, enabled: true, caps: {}, signedIn: true, ...over };
}

/** An account with nothing spent on it. */
function fresh(at = T0): Allowance {
  return {
    ok: true,
    at,
    windows: [
      win({ kind: "session", used: 5, resetsAt: at + 2 * HOUR, active: true }),
      win({ kind: "weekly_all", group: "weekly", used: 10, resetsAt: at + 72 * HOUR }),
    ],
  };
}

function spent(sessionPct: number, weeklyPct = 10, at = T0): Allowance {
  return {
    ok: true,
    at,
    windows: [
      win({ kind: "session", used: sessionPct, resetsAt: at + 2 * HOUR, active: true }),
      win({ kind: "weekly_all", group: "weekly", used: weeklyPct, resetsAt: at + 72 * HOUR }),
    ],
  };
}

describe("caps", () => {
  test("no cap set leaves the server's ceiling", () => {
    expect(capFor(acct("a"), "session", false)).toBe(100);
  });

  test("a cap set is the ceiling", () => {
    expect(capFor(acct("a", { caps: { session: 80 } }), "session", false)).toBe(80);
  });

  test("a cap only applies to the window it names", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(capFor(a, "weekly_all", false)).toBe(100);
  });

  /* A slider dragged to the end must not quietly come to mean "and past the
     real limit too". */
  test("a cap above 100 is not a cap", () => {
    expect(capFor(acct("a", { caps: { session: 150 } }), "session", false)).toBe(100);
  });

  test("a cap of zero is honoured, not read as unset", () => {
    expect(capFor(acct("a", { caps: { session: 0 } }), "session", false)).toBe(0);
  });

  test("a bypass lifts your ceiling to the server's", () => {
    expect(capFor(acct("a", { caps: { session: 80 } }), "session", true)).toBe(100);
  });
});

describe("what blocks an account", () => {
  test("nothing, on a fresh account", () => {
    expect(blockersFor(acct("a"), fresh().ok ? (fresh() as any).windows : [], false)).toEqual([]);
  });

  test("your cap blocks, and is marked as yours", () => {
    const a = acct("a", { caps: { session: 80 } });
    const b = blockersFor(a, (spent(85) as any).windows, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("you");
    expect(b[0]!.window.kind).toBe("session");
  });

  test("a cap blocks at exactly the cap, not one point past it", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(blockersFor(a, (spent(80) as any).windows, false)).toHaveLength(1);
    expect(blockersFor(a, (spent(79.9) as any).windows, false)).toHaveLength(0);
  });

  test("a spent window blocks with no cap set at all, and is marked the server's", () => {
    const b = blockersFor(acct("a"), (spent(100) as any).windows, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  /* The server's word is taken below 100 because it knows things this does
     not — an org restriction, a spend limit, a refusal already issued. */
  test("a rejection wins below 100", () => {
    const w = [win({ kind: "session", used: 12, severity: "rejected" })];
    const b = blockersFor(acct("a"), w, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  test("a bypass clears your caps", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(blockersFor(a, (spent(85) as any).windows, true)).toHaveLength(0);
  });

  /* The load-bearing one. Nothing may promise work through a real refusal. */
  test("a bypass does not clear the server's ceiling", () => {
    const a = acct("a", { caps: { session: 80 } });
    const b = blockersFor(a, (spent(100) as any).windows, true);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  test("a bypass does not clear a rejection either", () => {
    const w = [win({ used: 3, severity: "exceeded" })];
    expect(blockersFor(acct("a"), w, true)).toHaveLength(1);
  });

  test("caps on two windows both block independently", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(85, 60) as any).windows, false);
    expect(b).toHaveLength(2);
  });
});

describe("when an account comes back", () => {
  test("the latest blocker, since work needs every window clear", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(85, 60) as any).windows, false);
    expect(availableAt(b)).toBe(T0 + 72 * HOUR);
  });

  test("unknown when any blocker names no reset", () => {
    const b = blockersFor(acct("a"), [win({ used: 100, resetsAt: null })], false);
    expect(availableAt(b)).toBeNull();
  });

  test("null for nothing blocking, which is not the same as unknown", () => {
    expect(availableAt([])).toBeNull();
  });
});

describe("standing", () => {
  test("ready when under every ceiling", () => {
    expect(standingOf(acct("a"), fresh(), false).state).toBe("ready");
  });

  test("switched off is unusable rather than blocked", () => {
    const s = standingOf(acct("a", { enabled: false }), fresh(), false);
    expect(s.state).toBe("unusable");
  });

  test("not being signed in is unusable, and says what to do", () => {
    const s = standingOf(acct("a", { signedIn: false }), fresh(), false);
    expect(s.state).toBe("unusable");
    if (s.state === "unusable") expect(s.why).toContain("sign in");
  });

  /* The regression this suite exists for. An account whose allowance cannot be
     read is an account that has not been *measured* — it is not an account that
     cannot be *used*, and conflating the two took the whole feature down for
     every account, because the credential Skein's own sign-in minted was
     refused by the allowance endpoint and `ok` was false forever. Every send
     met "no account available" for an account that ran turns perfectly well.
     See `standingOf`. */
  test("an unread allowance is ready but unmeasured, not unusable", () => {
    const s = standingOf(acct("a"), undefined, false);
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.unmeasured).toContain("has not been read");
  });

  test("a faulted reading is ready, and carries the fault as the reason", () => {
    const s = standingOf(acct("a"), { ok: false, fault: "offline" }, false);
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.unmeasured).toBe("offline");
  });

  /* And the other half of it: an account that *was* measured and is full is
     still blocked. Softening the unread case must not soften this one, or a
     spent account would go on being sent work. */
  test("a measured account that is full is still blocked", () => {
    const s = standingOf(acct("a"), spent(100), false);
    expect(s.state).toBe("blocked");
  });

  /* A cap cannot be applied to a reading nobody has, which is the cost of the
     softening above and is stated as a test so it cannot be lost by accident:
     an account with a cap of 0 — "never start work here" — is still ready while
     unmeasured. It is guarded instead by the server's own refusal, which is
     what `markSpent` and the reactive swap are for. */
  test("an unmeasured account is ready even with a cap that would block it", () => {
    const s = standingOf(acct("a", { caps: { session: 0 } }), undefined, false);
    expect(s.state).toBe("ready");
  });
});

describe("the waterfall", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1, caps: { weekly_all: 50 } });
  const three = acct("three", { rank: 2 });

  test("rank order, not registry order", () => {
    expect(ordered([three, one, two]).map((a) => a.label)).toEqual(["one", "two", "three"]);
  });

  test("the first account gets the work while it is under its cap", () => {
    const c = choose([one, two, three], {
      one: fresh(),
      two: fresh(),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: null });
  });

  /* The core of what was asked for: consume one fully, then move on. Not
     "spread the load" — account one at 85% is past *your* cap, and two is
     nearly empty, and a headroom policy would have been using two all along. */
  test("falls to the second only once the first is past its cap", () => {
    const c = choose([one, two, three], {
      one: spent(85),
      two: fresh(),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("and to the third once the second is past its own, different cap", () => {
    const c = choose([one, two, three], {
      one: spent(85),
      two: spent(10, 55),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "three", swapFrom: null });
  });

  test("an account with no token is stepped over, not waited for", () => {
    const c = choose([acct("one", { rank: 0, signedIn: false }), two], {
      two: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("a switched-off account is stepped over", () => {
    const c = choose([acct("one", { rank: 0, enabled: false }), two], {
      one: fresh(),
      two: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });
});

describe("sticking to an account", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1 });

  /* A card swaps when it must, not when it could. Account one has come back
     and outranks two, but this card is mid-conversation on two and moving it
     would re-read its whole context uncached for no gain. */
  test("a running card stays put even when a better-ranked account frees up", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: "two" });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("but new work still goes to the lowest available account", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: null });
    expect(c.kind === "use" && c.label).toBe("one");
  });

  test("a card sticks only to an account it is still allowed on", () => {
    const c = choose([one, two], { one: fresh(), two: spent(100) }, { stickTo: "two" });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: "two" });
  });

  test("swapFrom is set only when the account actually changes", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: "one" });
    expect(c.kind === "use" && c.swapFrom).toBeNull();
  });
});

describe("when nothing is available", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1, caps: { session: 80 } });

  test("holds, rather than failing", () => {
    const c = choose([one, two], { one: spent(85), two: spent(90) });
    expect(c.kind).toBe("hold");
  });

  /* The earliest door to open — the opposite of the rule within one account,
     and right for the same reason: there, work needs every window clear; here
     it needs any one account. */
  test("holds until the first account comes back, not the last", () => {
    const c = choose([one, two], {
      one: { ok: true, at: T0, windows: [win({ used: 90, resetsAt: T0 + 3 * HOUR })] },
      two: { ok: true, at: T0, windows: [win({ used: 90, resetsAt: T0 + 1 * HOUR })] },
    });
    expect(c.kind === "hold" && c.until).toBe(T0 + 1 * HOUR);
  });

  test("an account with an unknown return does not make the wall's unknown", () => {
    const c = choose([one, two], {
      one: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: null })] },
      two: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: T0 + HOUR })] },
    });
    expect(c.kind === "hold" && c.until).toBe(T0 + HOUR);
  });

  test("unknown only when no blocked account names a reset", () => {
    const c = choose([one], {
      one: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: null })] },
    });
    expect(c.kind === "hold" && c.until).toBeNull();
  });

  /* A hold is a wait; "none" is a thing to go and fix. They must not be the
     same answer. */
  test("nothing usable is 'none', not a hold that never ends", () => {
    const c = choose([acct("one", { signedIn: false })], {});
    expect(c.kind).toBe("none");
  });

  test("an empty registry says so", () => {
    const c = choose([], {});
    expect(c).toEqual({ kind: "none", why: "no accounts are set up" });
  });

  test("one shared reason is said rather than generalised away", () => {
    const c = choose(
      [acct("one", { rank: 0, signedIn: false }), acct("two", { rank: 1, signedIn: false })],
      {},
    );
    expect(c.kind === "none" && c.why).toContain("sign in");
  });

  test("a bypass still holds when the accounts are genuinely spent", () => {
    const c = choose([one, two], { one: spent(100), two: spent(100) }, { bypass: true });
    expect(c.kind).toBe("hold");
  });

  test("but a bypass gets through when only your caps were in the way", () => {
    const c = choose([one, two], { one: spent(85), two: spent(90) }, { bypass: true });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: null });
  });
});

describe("the one window an account speaks with", () => {
  /* The whole point of the change: with several subscriptions the week fills
     over days while the five hours refill four times a day, so the max was the
     weekly figure on every row from about Wednesday and the column stopped
     saying anything about the session anybody was in. */
  test("the five hours speak even when the week is fuller", () => {
    const w = speaksWith(acct("a"), (spent(12, 68) as any).windows);
    expect(w.window!.kind).toBe("session");
    expect(w.window!.used).toBe(12);
    expect(w.ceiling).toBeNull();
  });

  test("a spent week takes over, and says whose ceiling it is", () => {
    const w = speaksWith(acct("a"), (spent(12, 100) as any).windows);
    expect(w.window!.kind).toBe("weekly_all");
    expect(w.ceiling!.by).toBe("server");
  });

  /* The case `tierOf` cannot see at all: 60% is calm by every threshold either
     side knows, and it is a stop. */
  test("your own threshold takes over too, well below 100", () => {
    const w = speaksWith(acct("a", { caps: { weekly_all: 60 } }), (spent(12, 65) as any).windows);
    expect(w.window!.kind).toBe("weekly_all");
    expect(w.window!.used).toBe(65);
    expect(w.ceiling!.by).toBe("you");
  });

  /* A cap on the *session* is a reason to hold work back and not a reason to
     stop drawing the session — the five hours are what this row is for, and
     they are already the window being shown. */
  test("a cap on the five hours does not hand the row to the week", () => {
    const w = speaksWith(acct("a", { caps: { session: 50 } }), (spent(80, 20) as any).windows);
    expect(w.window!.kind).toBe("session");
    expect(w.ceiling).toBeNull();
  });

  /* The server's word below 100, which `blockersFor` already honours for the
     reason stated there — it knows about org restrictions this does not. */
  test("a refused week takes over below 100", () => {
    const windows: Window[] = [
      win({ kind: "session", used: 4 }),
      win({ kind: "weekly_all", group: "weekly", used: 30, severity: "rejected" }),
    ];
    const w = speaksWith(acct("a"), windows);
    expect(w.window!.kind).toBe("weekly_all");
    expect(w.ceiling!.by).toBe("server");
  });

  test("the fullest stopped week speaks, scoped or not", () => {
    const windows: Window[] = [
      win({ kind: "session", used: 4 }),
      win({ kind: "weekly_all", group: "weekly", used: 100 }),
      win({ kind: "weekly_scoped", group: "weekly", used: 100, scope: "Opus" }),
    ];
    const w = speaksWith(acct("a", { caps: { weekly_scoped: 10 } }), windows);
    expect(w.window!.used).toBe(100);
  });

  /* An account whose server names no session window draws its fullest window
     rather than an em dash — losing the reading entirely would be worse than
     showing the wrong clock, and no account has ever been in this state. */
  test("with no session window it falls back to the fullest", () => {
    const windows: Window[] = [win({ kind: "weekly_all", group: "weekly", used: 30 })];
    expect(speaksWith(acct("a"), windows).window!.kind).toBe("weekly_all");
  });

  test("nothing read yet is nothing to say", () => {
    expect(speaksWith(acct("a"), []).window).toBeNull();
  });

  /* Rust for a cap of yours is only honest if the tooltip says why, since 60%
     in rust with no word about a cap is a face that looks broken. */
  test("the short wording keeps the two ceilings apart", () => {
    const mine = speaksWith(acct("a", { caps: { weekly_all: 60 } }), (spent(1, 65) as any).windows);
    const theirs = speaksWith(acct("a"), (spent(1, 100) as any).windows);
    expect(sayCeiling(mine.ceiling!)).toBe("at your cap");
    expect(sayCeiling(theirs.ceiling!)).toBe("spent");
  });
});

describe("wording", () => {
  test("your cap and the account being spent read differently", () => {
    const yours = blockersFor(acct("a", { caps: { session: 80 } }), (spent(85) as any).windows, false);
    const theirs = blockersFor(acct("a"), (spent(100) as any).windows, false);
    expect(sayBlocked(yours)).toContain("your cap");
    expect(sayBlocked(theirs)).toContain("spent");
  });

  test("the fullest blocker speaks for the set", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(99, 55) as any).windows, false);
    expect(sayBlocked(b)).toContain("5 hours");
  });

  test("nothing blocking says nothing", () => {
    expect(sayBlocked([])).toBe("");
  });

  /* An unmeasured account says the consequence rather than only the cause: the
     reason it could not be read is already a sentence from Rust, and what a
     person needs off the face is that a ceiling they set is not in force. */
  test("an unmeasured account names the caps, not just the reason", () => {
    const said = sayUnmeasured("its allowance has not been read yet");
    expect(said).toContain("caps");
    expect(said).toContain("has not been read");
  });

  /* The cost is named because it is the part with a cost, and the note is
     written at all because an app spawning with --dangerously-skip-permissions
     owes you a record of what it did on its own. */
  test("a swap note names both accounts and the re-read", () => {
    const note = swapNote("one", "two", "at your cap on the 5 hours");
    expect(note).toContain("one");
    expect(note).toContain("two");
    expect(note).toContain("uncached");
  });
});

describe("whether there is a choice to be made at all", () => {
  /* Everything the feature draws on the wall hangs off this — the account
     beside a card's project name, and the account knob on the usage widget.
     With one account all of it is a word that never varies. */

  test("one signed-in account is not a choice", () => {
    expect(several([acct("one")])).toBe(false);
  });

  test("two are", () => {
    expect(several([acct("one"), acct("two")])).toBe(true);
  });

  test("none is not", () => {
    expect(several([])).toBe(false);
  });

  /* Counted over what could actually take work, so registering a second
     account you have not signed into yet does not switch the wall into a mode
     it cannot use. */
  test("a registered account with no token does not make a choice", () => {
    expect(several([acct("one"), acct("two", { signedIn: false })])).toBe(false);
  });

  test("nor does a switched-off one", () => {
    expect(several([acct("one"), acct("two", { enabled: false })])).toBe(false);
  });

  test("usable is what it is counted over", () => {
    const list = [
      acct("one"),
      acct("two", { signedIn: false }),
      acct("three", { enabled: false }),
      acct("four"),
    ];
    expect(usable(list).map((a) => a.label)).toEqual(["one", "four"]);
    expect(several(list)).toBe(true);
  });
});

describe("carrying the waterfall between machines", () => {
  /* The precedent is `theme.test.ts`'s export block, and the one thing that is
     different is the one thing worth most of these tests: an export carries the
     shape of the waterfall and never a credential, so every imported row has to
     be visibly unsigned rather than plausibly signed in. */

  const three = [
    acct("work", { rank: 0, caps: { session: 80, weekly: 60 } }),
    acct("perso", { rank: 1, enabled: false }),
    acct("team", { rank: 2, signedIn: false }),
  ];

  test("the document is a versioned wrapper round the accounts", () => {
    const doc = JSON.parse(exportAccounts(three));
    expect(doc.skeinAccounts).toBe(EXPORT_VERSION);
    expect(doc.accounts.map((a: AccountDoc) => a.label)).toEqual(["work", "perso", "team"]);
  });

  /* The whole point of the format, and the assertion to break if anybody ever
     adds a field for convenience: `signedIn` is computed by looking for a file
     on *this* machine, so putting it in a document would be a claim about a
     disk the document is about to leave. */
  test("no credential and no claim about one travels", () => {
    const text = exportAccounts(three);
    expect(text).not.toContain("signedIn");
    expect(text).not.toContain("signed_in");
    for (const a of JSON.parse(text).accounts) expect("signedIn" in a).toBe(false);
  });

  /* A cap is your decision about your own spending rather than anything about a
     credential, and it is the most tedious thing in the panel to re-enter. */
  test("your caps travel", () => {
    const doc = JSON.parse(exportAccounts(three));
    expect(doc.accounts[0].caps).toEqual({ session: 80, weekly: 60 });
  });

  /* And so does `enabled`, because an account held in reserve by being switched
     off is a decision as real as its rank — and switching one on can spend
     nothing while there is no credential behind it. */
  test("so does whether an account is switched off", () => {
    const doc = JSON.parse(exportAccounts(three));
    expect(doc.accounts.find((a: AccountDoc) => a.label === "perso").enabled).toBe(false);
    expect(doc.accounts.find((a: AccountDoc) => a.label === "work").enabled).toBe(true);
  });

  /* `rank` is only meaningful as an ordering — a document a person reads should
     not have gaps in it inviting a guess about what went missing. */
  test("ranks come out dense and in order, whatever they were", () => {
    const sparse = [
      acct("c", { rank: 90 }),
      acct("a", { rank: 3 }),
      acct("b", { rank: 40 }),
    ];
    const doc = JSON.parse(exportAccounts(sparse));
    expect(doc.accounts.map((a: AccountDoc) => [a.label, a.rank])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("a round trip is the same waterfall", () => {
    const back = importAccounts(exportAccounts(three));
    expect(back).toEqual([
      { label: "work", rank: 0, enabled: true, caps: { session: 80, weekly: 60 } },
      { label: "perso", rank: 1, enabled: false, caps: {} },
      { label: "team", rank: 2, enabled: true, caps: {} },
    ]);
  });

  /* Three shapes, because all three are things a person plausibly pastes and
     refusing two of them teaches nothing. */
  test("the wrapper, a bare array and a single account all read", () => {
    const one = { label: "work", rank: 0, enabled: true, caps: {} };
    expect(importAccounts(JSON.stringify({ skeinAccounts: 1, accounts: [one] }))).toHaveLength(1);
    expect(importAccounts(JSON.stringify([one]))).toHaveLength(1);
    expect(importAccounts(JSON.stringify(one))).toHaveLength(1);
  });

  test("text that is not JSON is nothing rather than a throw", () => {
    expect(importAccounts("")).toEqual([]);
    expect(importAccounts("not json at all")).toEqual([]);
    expect(importAccounts("null")).toEqual([]);
    expect(importAccounts("7")).toEqual([]);
  });

  test("a document with no accounts in it is the same nothing", () => {
    expect(importAccounts(JSON.stringify({ skeinAccounts: 1, accounts: [] }))).toEqual([]);
  });

  /* An entry with no usable label is a fragment, not an account whose name got
     lost — and inventing one puts a row in the waterfall over a credential
     store that does not exist and cannot be signed into. */
  test("an entry with no usable label is dropped, not repaired", () => {
    expect(cleanAccount({ rank: 0, caps: {} })).toBeNull();
    expect(cleanAccount({ label: "" })).toBeNull();
    expect(cleanAccount({ label: 7 })).toBeNull();
    expect(cleanAccount("work")).toBeNull();
    /* `..` and `.` name real directories under the credential store root, and
       `sign_out` removes one recursively — the dots clause in
       `accounts.rs::is_label` is not decoration. */
    expect(cleanAccount({ label: ".." })).toBeNull();
    expect(cleanAccount({ label: "." })).toBeNull();
  });

  test("a label is repaired into something Rust will take, keeping its case", () => {
    expect(cleanLabel("Work Laptop")).toBe("Work-Laptop");
    expect(cleanLabel("  perso  ")).toBe("perso");
    expect(cleanLabel("a/b\\c")).toBe("a-b-c");
    expect(cleanLabel("work.2")).toBe("work.2");
    expect(cleanLabel("x".repeat(200))).toHaveLength(64);
    expect(cleanLabel("téam")).toBe("t-am");
    expect(cleanLabel(null)).toBe("");
  });

  test("a missing field degrades rather than refusing the row", () => {
    /* Absent means on: a hand-written `{"label":"work"}` is somebody asking for
       an account, and one that arrives switched off for want of a field it
       never had is a row that does nothing and does not say why. */
    expect(cleanAccount({ label: "work" })).toEqual({
      label: "work",
      rank: Number.MAX_SAFE_INTEGER,
      enabled: true,
      caps: {},
    });
    /* And a missing rank sorts last rather than to zero, which is the head of
       the queue and not a place a field that was never there may claim. */
    const list = cleanAccounts([{ label: "nowhere" }, { label: "first", rank: 0 }]);
    expect(list.map((a) => a.label)).toEqual(["first", "nowhere"]);
  });

  test("caps are clamped and quoted numbers taken", () => {
    /* Clamped rather than dropped, which is what the panel's own field does and
       changes nothing: `capFor` reads anything above 100 as no cap anyway. */
    expect(cleanCaps({ session: 150, weekly: -4, scoped: 60.4 })).toEqual({
      session: 100,
      weekly: 0,
      scoped: 60,
    });
    /* A document somebody edited by hand plausibly quotes its numbers. */
    expect(cleanCaps({ session: "80" })).toEqual({ session: 80 });
    expect(cleanCaps({ session: "eighty", weekly: null, other: {} })).toEqual({});
    expect(cleanCaps(null)).toEqual({});
    expect(cleanCaps([1, 2])).toEqual({});
    /* A cap of zero is honoured — `capFor` says why — so it must survive the
       normalizer rather than reading as unset. */
    expect(cleanCaps({ session: 0 })).toEqual({ session: 0 });
  });

  test("a repaired label still passes what Rust asks of one", () => {
    /* The same rule as `accounts.rs::is_label`, one layer up, so a pasted
       document is repaired into something addable instead of refused a row at a
       time with the reason on the far side of an IPC boundary. */
    const ok = (s: string) =>
      s.length > 0 &&
      s.length <= 64 &&
      /^[A-Za-z0-9._-]+$/.test(s) &&
      [...s].some((c) => c !== ".");
    for (const raw of ["Work Laptop", "a/b\\c", "..\\..\\etc", "x".repeat(90), "té am", "--x--"]) {
      const l = cleanLabel(raw);
      if (l) expect(ok(l)).toBe(true);
    }
  });

  /* ── what a merge does ──────────────────────────────────────────────── */

  test("imports are appended, and what is here keeps its order", () => {
    const here = [acct("work", { rank: 0 }), acct("perso", { rank: 1 })];
    const merge = mergeAccounts(here, importAccounts(exportAccounts([acct("spare")])));
    expect(merge.order).toEqual(["work", "perso", "spare"]);
    expect(merge.added.map((a) => [a.label, a.rank])).toEqual([["spare", 2]]);
  });

  /* The order is where the next turn's money goes, so a paste must not be able
     to insert itself at the head of the queue — and an imported row is unsigned
     by construction, so interleaving would scatter rows `choose` skips through
     the one list whose whole meaning is its sequence. */
  test("a rank-0 import does not take the head of the queue", () => {
    const here = [acct("work", { rank: 0 })];
    const merge = mergeAccounts(here, [
      { label: "cheeky", rank: 0, enabled: true, caps: {} },
    ]);
    expect(merge.order).toEqual(["work", "cheeky"]);
  });

  test("imports keep their own relative order among themselves", () => {
    const merge = mergeAccounts([acct("work")], [
      { label: "third", rank: 9, enabled: true, caps: {} },
      { label: "second", rank: 5, enabled: true, caps: {} },
    ]);
    /* `mergeAccounts` takes them as given — `cleanAccounts` is what sorts a
       document, so the sort is asserted through the real read path. */
    const sorted = importAccounts(
      JSON.stringify([
        { label: "third", rank: 9 },
        { label: "second", rank: 5 },
      ]),
    );
    expect(mergeAccounts([acct("work")], sorted).order).toEqual(["work", "second", "third"]);
    expect(merge.order).toEqual(["work", "third", "second"]);
  });

  /* Renamed rather than overwritten, for `mergeThemes`'s reason with a sharper
     edge: overwriting `work`'s caps would be a silent change to where your money
     stops on an account that has a live credential behind it. */
  test("a colliding label is renamed, and the one already here is untouched", () => {
    const here = [acct("work", { caps: { session: 80 } })];
    const merge = mergeAccounts(here, [
      { label: "work", rank: 0, enabled: true, caps: { session: 20 } },
    ]);
    expect(merge.added).toEqual([
      { label: "work-2", rank: 1, enabled: true, caps: { session: 20 } },
    ]);
    expect(merge.renamed).toEqual([{ from: "work", to: "work-2" }]);
    expect(merge.order).toEqual(["work", "work-2"]);
  });

  test("and again, when the rename itself collides", () => {
    const here = [acct("work"), acct("work-2")];
    const merge = mergeAccounts(here, [{ label: "work", rank: 0, enabled: true, caps: {} }]);
    expect(merge.added[0]!.label).toBe("work-3");
  });

  /* Stricter than the store on purpose: SQLite would hold `work` and `Work` as
     two rows, but the label is a directory name and this is a Windows-first app,
     so those two rows would be two accounts over one credential store. */
  test("a collision is case-insensitive, because the label is a directory", () => {
    const merge = mergeAccounts([acct("work")], [
      { label: "Work", rank: 0, enabled: true, caps: {} },
    ]);
    expect(merge.added[0]!.label).toBe("Work-2");
    expect(merge.renamed).toEqual([{ from: "Work", to: "Work-2" }]);
  });

  test("two entries in one document claiming a label become one", () => {
    const back = importAccounts(
      JSON.stringify([
        { label: "work", rank: 0, caps: { session: 10 } },
        { label: "Work", rank: 1, caps: { session: 90 } },
      ]),
    );
    expect(back).toHaveLength(1);
    expect(back[0]!.caps).toEqual({ session: 90 });
  });

  test("a rename cannot grow a label past what Rust will take", () => {
    const long = "w".repeat(64);
    const merge = mergeAccounts([acct(long)], [{ label: long, rank: 0, enabled: true, caps: {} }]);
    expect(merge.added[0]!.label).toHaveLength(64);
    expect(merge.added[0]!.label.endsWith("-2")).toBe(true);
  });

  test("nothing incoming leaves the order exactly as it was", () => {
    const here = [acct("work"), acct("perso", { rank: 1 })];
    expect(mergeAccounts(here, [])).toEqual({
      added: [],
      order: ["work", "perso"],
      renamed: [],
    });
  });

  /* ── and where an imported row lands ────────────────────────────────── */

  /* The honest state, and the reason the panel has anything to say at all: an
     imported account is known about and cannot be spent. Not "blocked", which
     is a clock to wait on — `unusable`, which is a thing to go and do. */
  test("an imported account is unusable until it is signed in here", () => {
    const [doc] = importAccounts(exportAccounts([acct("work", { caps: { session: 80 } })]));
    const landed: Account = { ...doc!, signedIn: false };
    const standing = standingOf(landed, undefined, false);
    expect(standing.state).toBe("unusable");
    if (standing.state === "unusable") expect(standing.why).toContain("not signed in");
    expect(usable([landed])).toEqual([]);
    /* And it cannot take the next turn away from the account that can. */
    const choice = choose([acct("here"), landed], {});
    expect(choice).toEqual({ kind: "use", label: "here", swapFrom: null });
  });

  test("a paste on a machine with nothing signed in is a wall that says so", () => {
    const landed = importAccounts(exportAccounts([acct("work"), acct("perso")])).map(
      (d): Account => ({ ...d, signedIn: false }),
    );
    const choice = choose(landed, {});
    expect(choice.kind).toBe("none");
    if (choice.kind === "none") expect(choice.why).toContain("not signed in");
  });

  /* ── the words ──────────────────────────────────────────────────────── */

  test("the receipt names what an export cannot carry", () => {
    const said = sayImported(3, 0);
    expect(said).toContain("3");
    expect(said).toContain("credential");
    expect(said).toContain("sign in");
  });

  /* A label matching a credential store already on this machine — signed in
     from a terminal, or left behind by a `remove`, which does not delete the
     store — lands genuinely usable, and "sign in to each" is wrong about it. */
  test("and does not say it about the rows that need nothing", () => {
    expect(sayImported(2, 2)).toContain("already signed in");
    expect(sayImported(2, 2)).not.toContain("sign in to each");
    expect(sayImported(3, 1)).toContain("1 already signed in");
  });

  test("nothing is a real answer with its own words", () => {
    expect(sayImported(0, 0)).toBe("nothing in that");
  });

  /* Said for as long as it is true, `sayUnmeasured`'s rule and the same
     argument: an imported account is indistinguishable from a working one until
     something asks it to take a turn. */
  test("the standing line names the labels, up to three of them", () => {
    expect(sayUnsigned([])).toBe("");
    expect(sayUnsigned(["work"])).toContain("work is");
    expect(sayUnsigned(["work", "perso"])).toContain("work, perso are");
    const many = sayUnsigned(["one", "two", "three", "four", "five"]);
    expect(many).toContain("one, two, three and 2 more are");
    expect(many).not.toContain("four");
    expect(many).toContain("credential");
  });
});
