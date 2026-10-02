import { describe, expect, test } from "bun:test";

import {
  CACHE_WANT,
  DEFAULT_TERMS,
  drawn,
  pick,
  SOURCES,
  sourceById,
  wanted,
  type Fetcher,
} from "../src/lib/sketch";

/** A fetcher that answers from a table, and records what it was asked. */
function stub(answers: Record<string, string>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string) => {
    asked.push(url);
    const key = Object.keys(answers).find((k) => url.includes(k));
    if (!key) throw new Error(`nothing stubbed for ${url}`);
    return answers[key];
  }) as Fetcher & { asked: string[] };
  f.asked = asked;
  return f;
}

describe("the catalogue", () => {
  test("every source says what it is and whether it takes a term", () => {
    for (const s of SOURCES) {
      expect(s.about.length).toBeGreaterThan(10);
      expect(typeof s.takesTerm).toBe("boolean");
      expect(sourceById(s.id)).toBe(s);
    }
    expect(sourceById("nope")).toBe(null);
  });

  test("the default terms are things to draw", () => {
    expect(DEFAULT_TERMS.length).toBeGreaterThan(5);
    expect(new Set(DEFAULT_TERMS).size).toBe(DEFAULT_TERMS.length);
  });
});

describe("choosing what to fetch", () => {
  test("never a source that is switched off", () => {
    for (const roll of [0, 0.3, 0.6, 0.99]) {
      expect(wanted(["photo"], [], roll)?.source.id).toBe("photo");
      expect(wanted(["artic"], [], roll)?.source.id).toBe("artic");
    }
  });

  test("nothing on means nothing to fetch", () => {
    expect(wanted([], DEFAULT_TERMS, 0.5)).toBe(null);
  });

  test("a source that takes no terms is never handed one", () => {
    /* A photograph fetched "for Hokusai" is a reference that lies about why it
       is on your screen. */
    for (const roll of [0, 0.4, 0.9]) {
      expect(wanted(["photo"], ["Hokusai"], roll)?.term).toBe(null);
    }
  });

  test("an empty term list means the defaults rather than no term", () => {
    const w = wanted(["artic"], [], 0.5);
    expect(w?.term).not.toBe(null);
    expect(DEFAULT_TERMS).toContain(w!.term!);
  });

  test("your own terms win", () => {
    const w = wanted(["met"], ["drapery"], 0.5);
    expect(w?.term).toBe("drapery");
  });
});

describe("the art institute", () => {
  const artic = sourceById("artic")!;

  test("one request, and a usable reference out of it", async () => {
    const get = stub({
      "api.artic.edu": JSON.stringify({
        data: [
          {
            id: 129884,
            title: "The Great Wave",
            artist_title: "Hokusai",
            image_id: "abc-123",
            is_public_domain: true,
          },
        ],
      }),
    });
    const ref = await artic.find(get, 0.5, "Hokusai");
    expect(get.asked.length).toBe(1);
    expect(get.asked[0]).toContain("q=Hokusai");
    expect(ref?.id).toBe("artic-129884");
    expect(ref?.url).toContain("abc-123");
    expect(ref?.credit).toContain("Hokusai");
    expect(ref?.credit).toContain("art institute");
  });

  test("a work with no image is not a reference", async () => {
    const get = stub({
      "api.artic.edu": JSON.stringify({
        data: [{ id: 1, title: "x", artist_title: "y", image_id: null }],
      }),
    });
    expect(await artic.find(get, 0.5, "x")).toBe(null);
  });

  test("something that is not public domain is skipped", async () => {
    const get = stub({
      "api.artic.edu": JSON.stringify({
        data: [{ id: 1, title: "x", image_id: "i", is_public_domain: false }],
      }),
    });
    expect(await artic.find(get, 0.5, "x")).toBe(null);
  });

  test("a captive portal answering html is not a crash", async () => {
    /* The actual failure to plan for: a 200 with a login page in it. */
    const get = stub({ "api.artic.edu": "<!DOCTYPE html><html>sign in</html>" });
    expect(await artic.find(get, 0.5, "x")).toBe(null);
  });
});

describe("the met", () => {
  const met = sourceById("met")!;

  test("two requests, ids then the object", async () => {
    const get = stub({
      "/search": JSON.stringify({ objectIDs: [437133] }),
      "/objects/": JSON.stringify({
        title: "Self-Portrait",
        artistDisplayName: "Rembrandt",
        primaryImageSmall: "https://images.metmuseum.org/x.jpg",
      }),
    });
    const ref = await met.find(get, 0, "Rembrandt");
    expect(get.asked.length).toBe(2);
    expect(ref?.id).toBe("met-437133");
    expect(ref?.url).toContain("images.metmuseum.org");
    expect(ref?.credit).toContain("Rembrandt");
  });

  test("no results is null, and costs one request", async () => {
    const get = stub({ "/search": JSON.stringify({ objectIDs: [] }) });
    expect(await met.find(get, 0.5, "zzzz")).toBe(null);
    expect(get.asked.length).toBe(1);
  });

  test("an object with no picture is not a reference", async () => {
    const get = stub({
      "/search": JSON.stringify({ objectIDs: [1] }),
      "/objects/": JSON.stringify({ title: "a pot", primaryImageSmall: "" }),
    });
    expect(await met.find(get, 0, "pot")).toBe(null);
  });
});

describe("photographs", () => {
  const photo = sourceById("photo")!;

  test("a listing becomes a reference with its photographer on it", async () => {
    const get = stub({
      "/v2/list": JSON.stringify([
        { id: "237", author: "Andre Spieker", download_url: "https://picsum.photos/x" },
      ]),
    });
    const ref = await photo.find(get, 0.5, null);
    expect(ref?.id).toBe("photo-237");
    expect(ref?.credit).toContain("Andre Spieker");
    expect(ref?.url).toContain("/id/237/");
  });

  test("an empty page is null rather than a broken reference", async () => {
    const get = stub({ "/v2/list": "[]" });
    expect(await photo.find(get, 0.5, null)).toBe(null);
  });
});

describe("how long it took", () => {
  test("counted up, and said the way you would say it", () => {
    expect(drawn(0)).toBe("0s");
    expect(drawn(42_000)).toBe("42s");
    expect(drawn(61_000)).toBe("1m 01s");
    expect(drawn(9 * 60_000 + 7_000)).toBe("9m 07s");
    expect(drawn(-5)).toBe("0s");
  });
});

describe("picking", () => {
  test("in range at either end, and null from nothing", () => {
    expect(pick([1, 2, 3], 0)).toBe(1);
    expect(pick([1, 2, 3], 0.999)).toBe(3);
    expect(pick([1, 2, 3], 1)).toBe(3);
    expect(pick([], 0.5)).toBe(null);
  });
});

describe("the cache", () => {
  test("twelve is about two weeks of mornings", () => {
    expect(CACHE_WANT).toBeGreaterThan(5);
    expect(CACHE_WANT).toBeLessThan(40);
  });
});
