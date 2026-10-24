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
