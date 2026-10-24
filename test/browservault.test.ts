import { describe, expect, test } from "bun:test";
// @ts-expect-error a plain CommonJS module the browser host loads; no types
import vault from "../src-tauri/src/browservault.cjs";

const { mergeStates, readVault } = vault as {
  mergeStates: (v: unknown, c: unknown[], now: number) => { cookies: any[]; origins: any[] };
  readVault: (t: string) => { cookies: any[]; origins: any[] };
};

const cookie = (name: string, value: string, expires = 2000, domain = "app.test") => ({
  name,
  value,
  domain,
  path: "/",
  expires,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});
const NOW = 1000;
const valueOf = (s: { cookies: any[] }, name: string) => s.cookies.find((c) => c.name === name)?.value;

describe("merging saved sign-ins", () => {
  test("a value that changed since the vault beats one that did not", () => {
    const v = { cookies: [cookie("sid", "old")], origins: [] };
    const a = { cookies: [cookie("sid", "old", 9000)], origins: [] };
    const b = { cookies: [cookie("sid", "new", 1500)], origins: [] };
    expect(valueOf(mergeStates(v, [a, b], NOW), "sid")).toBe("new");
    expect(valueOf(mergeStates(v, [b, a], NOW), "sid")).toBe("new");
  });

  test("among changed values the later expiry wins, and a session cookie counts as latest", () => {
    const v = { cookies: [cookie("sid", "old")], origins: [] };
    const a = { cookies: [cookie("sid", "a", 5000)], origins: [] };
    const b = { cookies: [cookie("sid", "b", 3000)], origins: [] };
    const s = { cookies: [cookie("sid", "session", -1)], origins: [] };
    expect(valueOf(mergeStates(v, [a, b], NOW), "sid")).toBe("a");
    expect(valueOf(mergeStates(v, [a, s, b], NOW), "sid")).toBe("session");
  });

  test("a tie goes to the later capture", () => {
    const v = { cookies: [], origins: [] };
    const a = { cookies: [cookie("sid", "a", 5000)], origins: [] };
    const b = { cookies: [cookie("sid", "b", 5000)], origins: [] };
    expect(valueOf(mergeStates(v, [a, b], NOW), "sid")).toBe("b");
  });

  test("nothing is removed by a capture that lacks it, and expired cookies go", () => {
    const v = { cookies: [cookie("keep", "1"), cookie("stale", "1", 10)], origins: [] };
    const out = mergeStates(v, [{ cookies: [cookie("other", "x")], origins: [] }], NOW);
    expect(out.cookies.map((c) => c.name).sort()).toEqual(["keep", "other"]);
  });

  test("the same name on two domains is two cookies", () => {
    const out = mergeStates({ cookies: [] }, [{ cookies: [cookie("sid", "a", 5000, "a.test"), cookie("sid", "b", 5000, "b.test")] }], NOW);
    expect(out.cookies).toHaveLength(2);
  });

  test("local storage: a changed key lands, an unchanged copy elsewhere does not undo it", () => {
    const v = { cookies: [], origins: [{ origin: "https://app.test", localStorage: [{ name: "token", value: "old" }, { name: "theme", value: "dark" }] }] };
    const changed = { origins: [{ origin: "https://app.test", localStorage: [{ name: "token", value: "new" }] }] };
    const stale = { origins: [{ origin: "https://app.test", localStorage: [{ name: "token", value: "old" }] }] };
    const out = mergeStates(v, [changed, stale], NOW);
    const items = Object.fromEntries(out.origins[0].localStorage.map((i: any) => [i.name, i.value]));
    expect(items).toEqual({ token: "new", theme: "dark" });
  });

  test("an origin only a capture knows is added", () => {
    const out = mergeStates({}, [{ origins: [{ origin: "https://new.test", localStorage: [{ name: "k", value: "v" }] }] }], NOW);
    expect(out.origins).toEqual([{ origin: "https://new.test", localStorage: [{ name: "k", value: "v" }] }]);
  });

  test("a vault that will not parse reads as empty rather than throwing", () => {
    expect(readVault("{not json")).toEqual({ cookies: [], origins: [] });
    expect(readVault(JSON.stringify({ cookies: [cookie("a", "1")] })).cookies).toHaveLength(1);
  });
});

describe("the browser's own context, read over plain CDP", () => {
  const { stateFromCdp } = vault as { stateFromCdp: (c: unknown, o: unknown, now: number) => { cookies: any[]; origins: any[] } };

  test("cookies come out in the vault's shape, a session one as -1 and a missing sameSite as Lax", () => {
    const s = stateFromCdp(
      [
        { name: "sid", value: "a", domain: "app.test", path: "/", expires: -1, session: true, httpOnly: true, secure: true, sameSite: "Strict" },
        { name: "pref", value: "b", domain: "app.test", path: "", expires: 5000.7, session: false },
        { name: "old", value: "c", domain: "app.test", path: "/", expires: 10, session: false },
        { name: "", value: "d", domain: "app.test" },
      ],
      [],
      NOW,
    );
    expect(s.cookies).toEqual([
      { name: "sid", value: "a", domain: "app.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Strict" },
      { name: "pref", value: "b", domain: "app.test", path: "/", expires: 5000, httpOnly: false, secure: false, sameSite: "Lax" },
    ]);
  });

  test("localStorage is grouped by origin, and a page with no origin carries none", () => {
    const s = stateFromCdp(
      [],
      [
        { origin: "https://app.test", entries: [["token", "t1"]] },
        { origin: "https://app.test", entries: [["theme", "dark"]] },
        { origin: "null", entries: [["x", "y"]] },
        { origin: "https://empty.test", entries: [] },
      ],
      NOW,
    );
    expect(s.origins).toEqual([{ origin: "https://app.test", localStorage: [{ name: "token", value: "t1" }, { name: "theme", value: "dark" }] }]);
  });

  test("what it makes is something the merge takes", () => {
    const s = stateFromCdp([{ name: "sid", value: "new", domain: "app.test", path: "/", expires: 9000 }], [], NOW);
    expect(valueOf(mergeStates({ cookies: [cookie("sid", "old")], origins: [] }, [s], NOW), "sid")).toBe("new");
  });
});

describe("only a web origin is ever saved", () => {
  const { stateFromCdp, webOrigin } = vault as {
    stateFromCdp: (c: unknown, o: unknown, now: number) => { cookies: any[]; origins: any[] };
    webOrigin: (o: unknown) => boolean;
  };

  /* Every new card is seeded from the vault and Playwright opens each saved
     origin to restore it, so one that is not a web origin would fail them all. */
  test("what counts as one", () => {
    expect(webOrigin("https://app.test")).toBe(true);
    expect(webOrigin("http://localhost:8081")).toBe(true);
    for (const o of ["not a url", "chrome://new-tab-page", "file://", "null", "https://app.test/path", "javascript:alert(1)", "", 3]) {
      expect(webOrigin(o)).toBe(false);
    }
  });

  test("the browser's own context keeps only web origins", () => {
    const s = stateFromCdp([], [{ origin: "chrome://new-tab-page", entries: [["k", "v"]] }, { origin: "https://ok.test", entries: [["k", "v"]] }], NOW);
    expect(s.origins.map((o) => o.origin)).toEqual(["https://ok.test"]);
  });

  test("a vault already holding one is read and merged without it", () => {
    const v = readVault(JSON.stringify({ cookies: [], origins: [{ origin: "not a url", localStorage: [{ name: "k", value: "v" }] }] }));
    expect(v.origins).toEqual([]);
    const merged = mergeStates({ cookies: [], origins: [] }, [{ cookies: [], origins: [{ origin: "file://", localStorage: [{ name: "k", value: "v" }] }] }], NOW);
    expect(merged.origins).toEqual([]);
  });

  /* Its key is spelled differently by Chrome and Playwright, and a cookie the
     seeding rejects fails the whole seed. */
  test("a partitioned cookie is left out rather than translated", () => {
    const s = stateFromCdp([{ name: "p", value: "1", domain: "app.test", path: "/", expires: -1, partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } }], [], NOW);
    expect(s.cookies).toEqual([]);
  });
});
