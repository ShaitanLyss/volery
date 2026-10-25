import { describe, expect, test } from "bun:test";
import { identify, plan, type Entry } from "../tools/prune-target.ts";

const NAMES = ["skein_lib", "skein", "build_script_build", "flyway_probe"];
const DAY = 86_400_000;
const NOW = 100 * DAY;

function at(place: string, name: string, daysAgo: number, bytes = 1): Entry {
  return { place, name, mtimeMs: NOW - daysAgo * DAY, bytes };
}

describe("an artifact is this crate's, by name and hash", () => {
  test("every spelling cargo uses", () => {
    expect(identify("skein_lib-773d07b82a69ac1e.pdb", NAMES)).toEqual({ stem: "skein_lib", hash: "773d07b82a69ac1e" });
    expect(identify("libskein_lib-773d07b82a69ac1e.rlib", NAMES)?.stem).toBe("skein_lib");
    expect(identify("skein_lib-773d07b82a69ac1e.skein_lib.4f1a-cgu.07.rcgu.o", NAMES)?.hash).toBe("773d07b82a69ac1e");
    expect(identify("skein-f8a9adaa0145b5ac", NAMES)?.stem).toBe("skein");
    expect(identify("skein_lib-0n7qv6fbacb67", NAMES)?.hash).toBe("0n7qv6fbacb67");
    expect(identify("flyway-probe-1a2b3c4d5e6f7a8b.exe", NAMES)?.stem).toBe("flyway_probe");
  });

  test("and nothing else", () => {
    for (const other of [
      "libserde_json-0123456789abcdef.rlib",
      "librespot-protocol-0030ee222f899f2a",
      "skein.exe",
      "skein_lib.lib",
      "voice-probe.exe",
      "skein-old",
      "skein-notes-0123456789abcdef.txt",
    ]) {
      expect(identify(other, NAMES)).toBeNull();
    }
  });
});

describe("what goes", () => {
  test("a superseded hash past the age floor goes, whole", () => {
    const old = [at("deps", "skein_lib-aaaaaaaaaaaaaaaa.exe", 9, 10), at("deps", "skein_lib-aaaaaaaaaaaaaaaa.pdb", 9, 400)];
    const now = [at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 0), at("deps", "skein_lib-bbbbbbbbbbbbbbbb.pdb", 0)];
    const p = plan([...old, ...now], NAMES, NOW);
    expect(p.doomed.map((e) => e.name).sort()).toEqual(old.map((e) => e.name).sort());
    expect(p.bytes).toBe(410);
  });

  test("the newest of each target is kept however old it is", () => {
    const p = plan([at("deps", "skein_lib-aaaaaaaaaaaaaaaa.exe", 40), at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 30)], NAMES, NOW);
    expect(p.doomed.map((e) => e.name)).toEqual(["skein_lib-aaaaaaaaaaaaaaaa.exe"]);
  });

  test("anything touched inside the floor is kept", () => {
    const p = plan([at("deps", "skein_lib-aaaaaaaaaaaaaaaa.exe", 2), at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 0)], NAMES, NOW);
    expect(p.doomed).toEqual([]);
    expect(plan([at("deps", "skein_lib-aaaaaaaaaaaaaaaa.exe", 2), at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 0)], NAMES, NOW, 1).doomed).toHaveLength(1);
  });

  /* A group is as new as its newest file: one fresh `.d` keeps the pdb. */
  test("a hash is judged as a group, never file by file", () => {
    const p = plan(
      [at("deps", "skein_lib-aaaaaaaaaaaaaaaa.pdb", 20), at("deps", "skein_lib-aaaaaaaaaaaaaaaa.d", 1), at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 0)],
      NAMES,
      NOW,
    );
    expect(p.doomed).toEqual([]);
  });

  /* The library and the test harness are rebuilt on different days under one
     name; a fresh test build must not make the current library superseded. */
  test("the library is not superseded by a test build", () => {
    const lib = [at("deps", "libskein_lib-aaaaaaaaaaaaaaaa.rlib", 10), at("deps", "skein_lib-aaaaaaaaaaaaaaaa.d", 10)];
    const tests = [at("deps", "skein_lib-bbbbbbbbbbbbbbbb.exe", 0)];
    expect(plan([...lib, ...tests], NAMES, NOW).doomed).toEqual([]);
  });

  test("each place is its own target", () => {
    const p = plan([at("build", "skein-aaaaaaaaaaaaaaaa", 10), at("deps", "skein-bbbbbbbbbbbbbbbb.exe", 0)], NAMES, NOW);
    expect(p.doomed).toEqual([]);
  });

  test("another crate's hashes are never touched", () => {
    const p = plan([at("deps", "libtauri-aaaaaaaaaaaaaaaa.rlib", 90), at("deps", "libtauri-bbbbbbbbbbbbbbbb.rlib", 0)], NAMES, NOW);
    expect(p.doomed).toEqual([]);
  });
});
