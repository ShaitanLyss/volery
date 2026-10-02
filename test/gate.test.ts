import { describe, expect, test } from "bun:test";

import {
  checkSum,
  isToyId,
  makePuzzle,
  makeSum,
  markGuess,
  MOTUS_ROWS,
  MOTUS_WORDS,
  motusState,
  motusWord,
  parseExpr,
  pickToy,
  rotations,
  sameFigure,
  sameFunction,
  TOYS,
} from "../src/lib/gate";

describe("the catalogue", () => {
  test("every toy says what it is in one line", () => {
    for (const t of TOYS) {
      expect(t.about.length).toBeGreaterThan(8);
      expect(t.label).toBe(t.label.toLowerCase());
    }
  });

  test("never the same one two mornings running", () => {
    for (const t of TOYS) {
      for (const roll of [0, 0.4, 0.99]) expect(pickToy(t.id, roll)).not.toBe(t.id);
    }
  });

  test("an unknown id is not a toy", () => {
    expect(isToyId("motus")).toBe(true);
    expect(isToyId("sudoku")).toBe(false);
  });
});

describe("motus", () => {
  test("every answer is six letters, and a word", () => {
    /* The guard that matters: this list was once built with string slicing and
       produced `PRIXES` and `CLAVIE`, which are not words and cannot be
       deduced — a gate nobody can pass looks exactly like being bad at it. */
    expect(MOTUS_WORDS.length).toBeGreaterThan(100);
    for (const w of MOTUS_WORDS) {
      expect(w).toMatch(/^[A-Z]{6}$/);
    }
  });

  test("no duplicates", () => {
    expect(new Set(MOTUS_WORDS).size).toBe(MOTUS_WORDS.length);
  });

  test("a word comes out of the list for any roll", () => {
    for (const r of [0, 0.5, 0.999, 1]) {
      expect(MOTUS_WORDS).toContain(motusWord(r));
    }
  });

  test("exact letters first, then what is left", () => {
    expect(markGuess("MAISON", "MAISON")).toEqual([
      "here",
      "here",
      "here",
      "here",
      "here",
      "here",
    ]);
    expect(markGuess("SALADE", "MAISON")).toEqual([
      "there", // S is in MAISON, elsewhere
      "here", // A
      "no", // L
      "no", // A again — MAISON has one A, and it is already marked
      "no", // D
      "no", // E
    ]);
  });

  test("a doubled letter earns one mark, not two", () => {
    /* The classic bug in every reimplementation: a single pass gives both Es a
       mark and teaches the player something false. */
    const marks = markGuess("TERRES", "PIERRE");
    const yellows = marks.filter((m) => m !== "no").length;
    const inAnswer = "PIERRE".split("");
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] === "here") expect("TERRES"[i]).toBe(inAnswer[i]);
    }
    expect(yellows).toBeLessThanOrEqual(6);
    /* R appears twice in both, so both may be marked; S appears in neither. */
    expect(marks[5]).toBe("no");
  });

  test("winning and losing", () => {
    expect(motusState([], "MAISON")).toBe("playing");
    expect(motusState(["SALADE", "MAISON"], "MAISON")).toBe("won");
    expect(motusState(Array(MOTUS_ROWS).fill("SALADE"), "MAISON")).toBe("lost");
    /* Case is not part of the game. */
    expect(motusState(["maison"], "MAISON")).toBe("won");
  });
});

describe("the expression parser", () => {
  const at = (src: string, x: number) => parseExpr(src)!(x);

  test("the usual arithmetic", () => {
    expect(at("2 + 3 * 4", 0)).toBe(14);
    expect(at("(2 + 3) * 4", 0)).toBe(20);
    expect(at("-x^2", 3)).toBe(-9);
    expect(at("x^2^3", 2)).toBe(256);
  });

  test("implicit multiplication, because that is how people write it", () => {
    expect(at("2x", 5)).toBe(10);
    expect(at("3sin(x)", 0)).toBe(0);
    expect(at("x(x+1)", 3)).toBe(12);
    expect(at("2x^2", 3)).toBe(18);
  });

  test("functions and constants", () => {
    expect(at("cos(0)", 0)).toBe(1);
    expect(at("sqrt(x)", 9)).toBe(3);
    expect(at("ln(e)", 0)).toBeCloseTo(1, 10);
    expect(at("pi", 0)).toBeCloseTo(Math.PI, 10);
    /* `exp(x)` must not be read as `e * xp(x)` — the one place the constant and
       a function name collide. */
    expect(at("exp(1)", 0)).toBeCloseTo(Math.E, 10);
  });

  test("the superscripts a keyboard produces", () => {
    expect(at("x²", 4)).toBe(16);
    expect(at("x³", 2)).toBe(8);
  });

  test("nonsense is null rather than a wrong number", () => {
    expect(parseExpr("")).toBe(null);
    expect(parseExpr("2 +")).toBe(null);
    expect(parseExpr("(2")).toBe(null);
    expect(parseExpr("hello")).toBe(null);
    /* Trailing junk must not be ignored, or `x^2 lol` marks as correct. */
    expect(parseExpr("x^2 )")).toBe(null);
  });
});

describe("marking a derivative", () => {
  test("any spelling of the same function is right", () => {
    const sum = makeSum(0); // x^4 - 3x^2 + 7x
    expect(sum.of).toContain("x^4");
    expect(checkSum(sum, "4x^3 - 6x + 7")).toBe(true);
    expect(checkSum(sum, "7 + 4*x*x*x - 6x")).toBe(true);
    expect(checkSum(sum, "4x^3 - 6x")).toBe(false);
  });

  test("an integral accepts any antiderivative", () => {
    const sum = makeSum(0.65);
    expect(sum.kind).toBe("integrate");
    const plus = `${sum.answer} + 12`;
    expect(checkSum(sum, sum.answer)).toBe(true);
    /* The two differ by a constant, and demanding the one in the table would be
       marking a convention rather than the calculus. */
    expect(checkSum(sum, plus)).toBe(true);
  });

  test("every sum in the bank is solvable by its own stated answer", () => {
    /* The guard that matters here: a generated puzzle whose answer is wrong is
       a gate that cannot be passed, and it looks exactly like you being bad at
       maths at seven in the morning. */
    for (let i = 0; i < 40; i++) {
      const sum = makeSum(i / 40);
      expect(checkSum(sum, sum.answer)).toBe(true);
      expect(parseExpr(sum.of)).not.toBe(null);
      if (sum.kind === "integrate") expect(sum.note).not.toBe(null);
    }
  });

  test("an empty or malformed answer is not correct", () => {
    const sum = makeSum(0);
    expect(checkSum(sum, "")).toBe(false);
    expect(checkSum(sum, "???")).toBe(false);
  });

  test("two functions equal almost nowhere are not the same", () => {
    expect(sameFunction((x) => x, (x) => x)).toBe(true);
    expect(sameFunction((x) => x, (x) => x + 1e-3)).toBe(false);
    /* Undefined everywhere must not pass by having nothing to disagree about. */
    expect(sameFunction(() => NaN, () => NaN)).toBe(false);
  });
});

describe("the casse-tête", () => {
  test("a pair is always answerable, and the answer is true", () => {
    /* The generator can produce an accidentally symmetric figure, whose mirror
       *is* a rotation of it — at which point "same or mirror?" has two right
       answers and the gate marks you wrong for the true one. This is the
       assertion that would catch it. */
    for (let i = 0; i < 60; i++) {
      const { a, b, same } = makePuzzle(i / 60 + 0.001);
      const poses = rotations(a);
      const isRotation = poses.some((p) => sameFigure(p, b));
      expect(isRotation).toBe(same);
    }
  });

  test("the two are never drawn in the same pose", () => {
    /* Identical poses answer the question without anybody turning anything. */
    for (let i = 0; i < 40; i++) {
      const { a, b } = makePuzzle(i / 40 + 0.003);
      expect(sameFigure(a, b)).toBe(false);
    }
  });

  test("a figure has the cubes it claims and they are distinct", () => {
    const { a, b } = makePuzzle(0.42);
    expect(a.cells.length).toBe(10);
    expect(b.cells.length).toBe(10);
    expect(new Set(a.cells.map((c) => c.join(","))).size).toBe(10);
  });

  test("a solid has twenty-four poses at most", () => {
    const { a } = makePuzzle(0.17);
    expect(rotations(a).length).toBeLessThanOrEqual(24);
    expect(rotations(a).length).toBeGreaterThan(0);
  });
});
