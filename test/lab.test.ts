import { describe, expect, test } from "bun:test";
import { badName, deletable, dllMissing, FLAG_INSTALLED, flywayHost, identifierOf, MAX_LABS, mayTakeDown, plan, portsFor } from "../tools/lab.ts";

describe("a lab name", () => {
  test("is narrow, because it becomes two folders and a mutex", () => {
    for (const ok of ["a", "alpha", "b-2", "0", "sixteen-chars-ok"]) expect(badName(ok)).toBeNull();
    for (const bad of ["", "..", "A", "-x", "a.b", "a/b", "a\\b", "a b", "seventeen-chars-x"]) {
      expect(badName(bad)).not.toBeNull();
    }
  });

  test("cannot be a verb", () => {
    for (const verb of ["down", "list", "up", "help"]) expect(badName(verb)).not.toBeNull();
  });

  test("is never the studio's identifier", () => {
    expect(identifierOf("studio")).toBe("dev.skein.lab.studio");
    expect(identifierOf("a")).not.toBe("dev.skein.lab");
  });
});

describe("a lab's port", () => {
  test("is the same every run, and off the studio's and the bare lab's", () => {
    expect(portsFor("alpha")).toEqual(portsFor("alpha"));
    const all = portsFor("alpha");
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(1420);
    expect(all).not.toContain(1421);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(1430);
  });

  test("differs between names, so two labs rarely even probe", () => {
    expect(portsFor("a")[0]).not.toBe(portsFor("b")[0]);
  });
});

describe("a lab's flyway host", () => {
  test("is never this machine's own name", () => {
    expect(flywayHost("a", "QUEERISFREEDOM")).toBe("lab-a.queerisfreedom");
    expect(flywayHost(null, "QUEERISFREEDOM")).toBe("lab.queerisfreedom");
    expect(flywayHost("a", "QUEERISFREEDOM").toLowerCase()).not.toBe("queerisfreedom");
  });

  test("tells two names and two machines apart, inside key.rs's clip", () => {
    expect(flywayHost("a", "m")).not.toBe(flywayHost("b", "m"));
    expect(flywayHost("a", "m1")).not.toBe(flywayHost("a", "m2"));
    expect(flywayHost("sixteen-chars-ok", "DESKTOP-ABCDEFGHIJKLMNO").length).toBeLessThanOrEqual(40);
  });
});

describe("the command line", () => {
  test("bare is today's lab, flags passed through", () => {
    expect(plan([])).toEqual({ kind: "bare", passthrough: [], real: false });
    expect(plan(["--release"])).toEqual({ kind: "bare", passthrough: ["--release"], real: false });
    expect(plan([FLAG_INSTALLED, "--release"])).toEqual({ kind: "bare", passthrough: ["--release"], real: true });
  });

  test("a name is a named lab, with its flags", () => {
    expect(plan(["a"])).toEqual({ kind: "up", name: "a", frozen: false, build: true, peer: null, real: false });
    expect(plan(["a", FLAG_INSTALLED])).toMatchObject({ kind: "up", name: "a", real: true });
    expect(plan(["a", FLAG_INSTALLED, "--peer", "b"]).kind).toBe("refused");
    expect(plan(["up", "a", "--frozen", "--no-build", "--peer", "b"])).toEqual({
      kind: "up",
      name: "a",
      frozen: true,
      build: false,
      peer: "b",
      real: false,
    });
  });

  test("down names its labs, or all of them", () => {
    expect(plan(["down", "a", "b"])).toEqual({ kind: "down", names: ["a", "b"], force: false });
    expect(plan(["down", "--all"])).toEqual({ kind: "down", names: "all", force: false });
    expect(plan(["down", "a", "--force"])).toEqual({ kind: "down", names: ["a"], force: true });
    expect(plan(["down"]).kind).toBe("refused");
  });

  test("the way onto the installed wall's flyway cannot be typed by accident", () => {
    expect(FLAG_INSTALLED).toContain("installed");
    expect(plan(["a", "--real-flyway"]).kind).toBe("refused");
    expect(plan(["a", "--real"]).kind).toBe("refused");
  });

  test("anything it does not understand is refused rather than guessed at", () => {
    expect(plan(["Alpha"]).kind).toBe("refused");
    expect(plan(["a", "--frozn"]).kind).toBe("refused");
    expect(plan(["a", "--peer"]).kind).toBe("refused");
    expect(plan(["down", "../x"]).kind).toBe("refused");
  });
});

test("the cap is small, and the missing-DLL exit is recognised in every spelling", () => {
  expect(MAX_LABS).toBeLessThanOrEqual(3);
  for (const code of [53, 0xc0000135, -1073741515]) expect(dllMissing(code)).toBe(true);
  expect(dllMissing(0)).toBe(false);
  expect(dllMissing(null)).toBe(false);
});

describe("taking a lab down", () => {
  test("a live lab is its launcher's — the down --all that took another card's mid-demo", () => {
    expect(mayTakeDown("mva", "6fa1e4b6", true, "bbadc88b", false)).toContain("card 6fa1e4b6");
    expect(mayTakeDown("a", null, true, "bbadc88b", false)).toContain("terminal");
    expect(mayTakeDown("a", "bbadc88b", true, null, false)).not.toBeNull();
  });

  test("your own, a gone one's leftovers, or --force", () => {
    expect(mayTakeDown("a", "bbadc88b", true, "bbadc88b", false)).toBeNull();
    expect(mayTakeDown("a", null, true, null, false)).toBeNull();
    expect(mayTakeDown("a", undefined, true, null, false)).toBeNull();
    expect(mayTakeDown("a", "6fa1e4b6", false, "bbadc88b", false)).toBeNull();
    expect(mayTakeDown("a", "6fa1e4b6", true, "bbadc88b", true)).toBeNull();
  });
});

describe("what down may delete", () => {
  const R = "C:\\Users\\x\\AppData\\Roaming";
  const L = "C:\\Users\\x\\AppData\\Local";

  test("exactly the lab's two folders", () => {
    expect(deletable(`${R}\\dev.skein.lab.a`, "a", R, L)).toBe(true);
    expect(deletable(`${L}\\dev.skein.lab.a`, "a", R, L)).toBe(true);
    expect(deletable(`${L}\\DEV.SKEIN.LAB.A`, "a", R, L)).toBe(true);
  });

  test("never a neighbour, a prefix, a parent or a child", () => {
    for (const path of [
      `${R}\\dev.skein.studio`,
      `${R}\\dev.skein.lab`,
      `${L}\\dev.skein.lab`,
      `${R}\\dev.skein.lab.ab`,
      `${R}\\dev.skein.lab.b`,
      `${R}\\dev.skein.lab.a\\skein.db`,
      `${R}\\dev.skein.lab.a\\..\\dev.skein.studio`,
      R,
      L,
      `C:\\elsewhere\\dev.skein.lab.a`,
      "",
    ]) {
      expect(deletable(path, "a", R, L)).toBe(false);
    }
  });

  test("nothing at all without a valid name or both roots", () => {
    expect(deletable(`${R}\\dev.skein.lab.`, "", R, L)).toBe(false);
    expect(deletable(`${R}\\dev.skein.lab...`, "..", R, L)).toBe(false);
    expect(deletable("\\dev.skein.lab.a", "a", "", L)).toBe(false);
  });
});
