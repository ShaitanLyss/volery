/* The small thing between you and the wall when you come back.
 *
 * Lyss's ask, and the reasoning is hers: *"unlock toys are fun actions to do
 * when i'm back to actually unlock volery and get back to work … the idea is to
 * get fun and stimulate the brain, it shouldn't take too long, 5 mins max"*.
 *
 * So this is not a lock. **The bypass is there from the first frame**, small and
 * quiet — asked for in those words, and it is the right answer for a reason
 * beyond preference: a gate that actually held the door would be a gate you
 * resent on the morning you are late, and one morning of that is the end of the
 * feature. It works because you want it to, and the only thing the design owes
 * you is that wanting it is easy.
 *
 * The pure half: which toy, what it asks, and whether you got it. The drawing is
 * `Gate.svelte`. Everything here is a function of a seed and your answer, so the
 * puzzles are tested rather than eyeballed — which matters more than it looks,
 * because a generated puzzle with no solution is a gate that cannot be passed
 * except by the bypass, and it would look exactly like you being bad at it.
 */

/* ── the catalogue ────────────────────────────────────────────────────────── */

export type ToyId = "motus" | "calculus" | "rotate";

export type ToySpec = {
  id: ToyId;
  label: string;
  /** One line under the title. What it is, not how to play — the rules are in
   *  the thing itself, and a paragraph of instructions at seven in the morning
   *  is a bypass pressed. */
  about: string;
};

export const TOYS: readonly ToySpec[] = [
  { id: "motus", label: "motus", about: "six letters, the first one free" },
  { id: "calculus", label: "dérivée", about: "differentiate it, or integrate it" },
  { id: "rotate", label: "casse-tête", about: "same shape, or its mirror?" },
];

export function isToyId(v: unknown): v is ToyId {
  return typeof v === "string" && TOYS.some((t) => t.id === v);
}

/** Which one you get. Never the one you had last, so two mornings in a row are
 *  two different puzzles — the rotation `away.ts` makes for the same reason one
 *  layer out. */
export function pickToy(last: ToyId | null, roll: number): ToyId {
  const from = TOYS.filter((t) => t.id !== last);
  const pool = from.length ? from : TOYS;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[i].id;
}

/* ── motus ────────────────────────────────────────────────────────────────── */

/** Six-letter French words, upper case and unaccented.
 *
 *  Unaccented because the game is played on a keyboard at seven in the morning
 *  and `É` is a dead key away on half of them — a puzzle that is hard to *type*
 *  is not hard in the way anybody wanted. The answers are common words on
 *  purpose: this is a warm-up, not a vocabulary test, and the pleasure is in
 *  the deduction rather than in knowing a rare word.
 *
 *  A guess is **not** checked against this list. The list is what answers are
 *  drawn from; rejecting a guess because it is a real word this file happens not
 *  to carry is the one failure that reads as the gate being broken. */
export const MOTUS_WORDS: readonly string[] = [
  "BALLON", "BANANE", "BATEAU", "BONNET", "BOUGIE", "BOUTON",
  "BRAISE", "BRONZE", "CAMION", "CANARD", "CARNET", "CARTON",
  "CASQUE", "CERISE", "CHAISE", "CHARME", "CHEVAL", "CIGARE",
  "CIMENT", "COLLER", "COMETE", "COPAIN", "CORDON", "COUSIN",
  "CRAYON", "CUISSE", "DANGER", "DANSER", "DESERT", "DESSIN",
  "DIVERS", "DONNER", "DORMIR", "DOUBLE", "ECLAIR", "ECOLES",
  "ECRIRE", "EFFORT", "ELEVER", "EMPIRE", "ENCRES", "ENFANT",
  "ENTREE", "EPAULE", "ESPACE", "ESPOIR", "ETOILE", "FACILE",
  "FERMER", "FIGURE", "FLECHE", "FLEURS", "FORCES", "FORMER",
  "FRAISE", "GARAGE", "GARDER", "GATEAU", "GLACES", "GRANDE",
  "HERBES", "HIVERS", "HOMMES", "IMAGES", "JARDIN", "JAUNES",
  "JOUEUR", "JUSTES", "LAMPES", "LANGUE", "LAPINS", "LARGES",
  "LETTRE", "LIVRES", "MAISON", "MANGER", "MARCHE", "MATINS",
  "MESURE", "METIER", "MIROIR", "MONDES", "MONTER", "MOTEUR",
  "NATURE", "NEIGES", "NOMBRE", "NUAGES", "OCEANS", "OISEAU",
  "ORANGE", "OUVRIR", "PAPIER", "PARLER", "PARTIR", "PASSER",
  "PENSER", "PERDRE", "PETITE", "PIERRE", "PLAGES", "PLANTE",
  "PLUIES", "POCHES", "POMMES", "PORTER", "POULET", "PRINCE",
  "RACINE", "RAISON", "RAPIDE", "RENDRE", "RESTER", "REVOIR",
  "ROUGES", "ROUTES", "RUBANS", "SABLES", "SAISON", "SALADE",
  "SAVOIR", "SIGNAL", "SOLEIL", "SOMMET", "SORTIR", "SOUPES",
  "SUCRES", "TABLES", "TEMPLE", "TENDRE", "TERRES", "TIMBRE",
  "TOMBER", "TOURNE", "TRESOR", "TROUVE", "VALISE", "VENDRE",
  "VERRES", "VILLES", "VIOLON", "VOISIN", "VOYAGE",
];

export type Mark = "here" | "there" | "no";

/** Motus's own marking, which is Wordle's and is got wrong the same way.
 *
 *  A letter that appears twice in the guess and once in the answer earns one
 *  mark, not two — so the marking is two passes: exact positions first, then
 *  the leftovers matched against what is left of the answer. A single pass
 *  gives you two yellows for one letter, which teaches the player something
 *  false and is the classic bug in every reimplementation of this game. */
export function markGuess(guess: string, answer: string): Mark[] {
  const g = guess.toUpperCase().split("");
  const a = answer.toUpperCase().split("");
  const marks: Mark[] = g.map(() => "no");
  const left = new Map<string, number>();

  for (let i = 0; i < g.length; i++) {
    if (g[i] === a[i]) marks[i] = "here";
    else left.set(a[i], (left.get(a[i]) ?? 0) + 1);
  }
  for (let i = 0; i < g.length; i++) {
    if (marks[i] === "here") continue;
    const n = left.get(g[i]) ?? 0;
    if (n > 0) {
      marks[i] = "there";
      left.set(g[i], n - 1);
    }
  }
  return marks;
}

export const MOTUS_ROWS = 6;

export function motusState(rows: string[], answer: string): "won" | "lost" | "playing" {
  if (rows.some((r) => r.toUpperCase() === answer.toUpperCase())) return "won";
  return rows.length >= MOTUS_ROWS ? "lost" : "playing";
}

export function motusWord(roll: number): string {
  const i = Math.min(
    MOTUS_WORDS.length - 1,
    Math.max(0, Math.floor(roll * MOTUS_WORDS.length)),
  );
  return MOTUS_WORDS[i];
}

/* ── calculus ─────────────────────────────────────────────────────────────── */

/* A tiny expression language, because the answer has to be *checked*.
 *
 * Checking symbolically would mean a computer algebra system; checking by
 * string comparison would reject `2x` for `2*x` and `x^2/2` for `0.5x²`, which
 * is a gate that fails you for being right. So the answer is parsed and
 * compared **numerically** at a handful of sample points against the known
 * derivative — which accepts every spelling of the same function, including the
 * ones nobody thought of, and is about sixty lines. */

type Node = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  sqrt: Math.sqrt,
  abs: Math.abs,
};

/** Parse an expression in `x`, or `null` if it is not one.
 *
 *  Recursive descent over `+ - * / ^`, unary minus, parentheses, the functions
 *  above, `pi` and `e`. Implicit multiplication is accepted — `2x`, `3sin(x)`,
 *  `x(x+1)` — because that is how a person writes maths by hand, and a parser
 *  that refused it would be marking handwriting rather than calculus. */
export function parseExpr(src: string): Node | null {
  const s = src.toLowerCase().replace(/\s+/g, "").replace(/²/g, "^2").replace(/³/g, "^3");
  if (!s) return null;
  let i = 0;

  const peek = () => s[i];
  const eat = (c: string) => (s[i] === c ? (i++, true) : false);

  function expr(): Node | null {
    /* The first factor is taken into its own binding before the loop, so
       `left` is a `Node` rather than a `Node | null` that the reassignment
       below re-widens — otherwise each closure's type is defined in terms of
       the variable it is about to be assigned to, and the inference is
       circular. */
    const first = term();
    if (!first) return null;
    let left: Node = first;
    for (;;) {
      if (eat("+")) {
        const r = term();
        if (!r) return null;
        const l = left;
        left = (x) => l(x) + r(x);
      } else if (eat("-")) {
        const r = term();
        if (!r) return null;
        const l = left;
        left = (x) => l(x) - r(x);
      } else return left;
    }
  }

  function term(): Node | null {
    const first = unary();
    if (!first) return null;
    let left: Node = first;
    for (;;) {
      if (eat("*")) {
        const r = unary();
        if (!r) return null;
        const l = left;
        left = (x) => l(x) * r(x);
      } else if (eat("/")) {
        const r = unary();
        if (!r) return null;
        const l = left;
        left = (x) => l(x) / r(x);
      } else if (isImplicit()) {
        const r = unary();
        if (!r) return null;
        const l = left;
        left = (x) => l(x) * r(x);
      } else return left;
    }
  }

  /** Whether what comes next starts a factor, which is what makes `2x` a
   *  product without an operator between them. */
  function isImplicit(): boolean {
    const c = peek();
    return c !== undefined && (c === "(" || /[a-z0-9.]/.test(c));
  }

  function unary(): Node | null {
    if (eat("-")) {
      const r = unary();
      return r ? (x) => -r(x) : null;
    }
    if (eat("+")) return unary();
    return power();
  }

  function power(): Node | null {
    const base = atom();
    if (!base) return null;
    if (eat("^")) {
      /* Right-associative, so `x^2^3` is `x^(2^3)` as it is everywhere else. */
      const e = unary();
      if (!e) return null;
      return (x) => Math.pow(base(x), e(x));
    }
    return base;
  }

  function atom(): Node | null {
    if (eat("(")) {
      const e = expr();
      if (!e || !eat(")")) return null;
      return e;
    }
    const num = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      const v = Number(num[0]);
      return () => v;
    }
    /* Letters are matched as a *prefix of what is left*, longest meaningful
       token first, rather than by taking the whole run of letters and asking
       what it is. Implicit multiplication is why: with whitespace stripped,
       `2x sin(x)` is `2xsin(x)`, and a greedy word match reads `xsin` — which
       is not x, not a function, and not anything, so a perfectly good
       derivative was marked wrong. Functions come first because `exp` has to
       beat `e`, and `pi` before `x` only for tidiness. */
    const rest = s.slice(i);
    for (const name of Object.keys(FUNCS)) {
      if (!rest.startsWith(name)) continue;
      i += name.length;
      const f = FUNCS[name];
      const arg = eat("(")
        ? ((): Node | null => {
            const e = expr();
            return e && eat(")") ? e : null;
          })()
        : power();
      if (!arg) return null;
      return (x) => f(arg(x));
    }
    if (rest.startsWith("pi")) {
      i += 2;
      return () => Math.PI;
    }
    if (rest.startsWith("x")) {
      i += 1;
      return (x) => x;
    }
    if (rest.startsWith("e")) {
      i += 1;
      return () => Math.E;
    }
    return null;
  }

  const out = expr();
  return out && i === s.length ? out : null;
}

/** Sample points. Chosen away from 0, away from each other, and inside the
 *  domain of every function a problem here can produce — `ln` and `sqrt` are in
 *  the vocabulary, so a sample at a negative x would make a correct answer
 *  compare NaN to NaN and be marked wrong. */
const SAMPLES = [0.37, 0.81, 1.23, 1.94, 2.61];

/** Whether two functions are the same one, as far as anybody cares.
 *
 *  A relative tolerance rather than an absolute one: the derivatives here reach
 *  the hundreds at x≈2.6, and an absolute epsilon that is right for `cos` is
 *  nonsense for `6x^5`. A sample that is NaN or infinite on *both* sides is
 *  skipped rather than failed — that is a point outside the domain, not a wrong
 *  answer — but at least three have to survive, or a function that is undefined
 *  almost everywhere would pass by having nothing to disagree about. */
export function sameFunction(a: Node, b: Node): boolean {
  let checked = 0;
  for (const x of SAMPLES) {
    const p = a(x);
    const q = b(x);
    const bad = (v: number) => !Number.isFinite(v);
    if (bad(p) && bad(q)) continue;
    if (bad(p) || bad(q)) return false;
    const scale = Math.max(1, Math.abs(p), Math.abs(q));
    if (Math.abs(p - q) / scale > 1e-6) return false;
    checked++;
  }
  return checked >= 3;
}

export type Sum = {
  kind: "derive" | "integrate";
  /** What is asked, written the way it would be on paper. */
  of: string;
  /** One correct spelling of the answer, for the giving-up line. Any function
   *  equal to it is accepted — see `checkSum`. */
  answer: string;
  /** For an integral: the constant is not asked for, and saying so stops the
   *  argument about whether `+ C` was required. */
  note: string | null;
};

const SUMS: readonly Sum[] = [
  { kind: "derive", of: "x^4 - 3x^2 + 7x", answer: "4x^3 - 6x + 7", note: null },
  { kind: "derive", of: "sin(x) * x^2", answer: "2x sin(x) + x^2 cos(x)", note: null },
  { kind: "derive", of: "exp(2x)", answer: "2 exp(2x)", note: null },
  { kind: "derive", of: "ln(x^2 + 1)", answer: "2x / (x^2 + 1)", note: null },
  { kind: "derive", of: "x / (x + 1)", answer: "1 / (x + 1)^2", note: null },
  { kind: "derive", of: "sqrt(x) * cos(x)", answer: "cos(x)/(2 sqrt(x)) - sqrt(x) sin(x)", note: null },
  { kind: "derive", of: "x^2 exp(-x)", answer: "2x exp(-x) - x^2 exp(-x)", note: null },
  { kind: "derive", of: "tan(x)", answer: "1 / cos(x)^2", note: null },
  {
    kind: "integrate",
    of: "3x^2 + 2x",
    answer: "x^3 + x^2",
    note: "the constant is assumed — no need to write + C",
  },
  {
    kind: "integrate",
    of: "cos(x)",
    answer: "sin(x)",
    note: "the constant is assumed — no need to write + C",
  },
  {
    kind: "integrate",
    of: "1/x",
    answer: "ln(x)",
    note: "for x > 0, and the constant is assumed",
  },
  {
    kind: "integrate",
    of: "exp(3x)",
    answer: "exp(3x)/3",
    note: "the constant is assumed — no need to write + C",
  },
  {
    kind: "integrate",
    of: "x sqrt(x)",
    answer: "2 x^2 sqrt(x) / 5",
    note: "the constant is assumed — no need to write + C",
  },
];

export function makeSum(roll: number): Sum {
  const i = Math.min(SUMS.length - 1, Math.max(0, Math.floor(roll * SUMS.length)));
  return SUMS[i];
}

/** Whether what you wrote is the answer.
 *
 *  For an integral, **any antiderivative counts** — the two differ by a
 *  constant, and demanding the particular one in the table would be marking a
 *  convention rather than the calculus. So the comparison for an integral is of
 *  the *difference* against a constant, which is the same `sameFunction` call
 *  with one subtraction in front of it. */
export function checkSum(sum: Sum, written: string): boolean {
  const got = parseExpr(written);
  const want = parseExpr(sum.answer);
  if (!got || !want) return false;
  if (sum.kind === "derive") return sameFunction(got, want);
  const diff = (x: number) => got(x) - want(x);
  const c = diff(SAMPLES[0]);
  if (!Number.isFinite(c)) return false;
  return sameFunction(diff, () => c);
}

/* ── the casse-tête ───────────────────────────────────────────────────────── */

export type Cell = [number, number, number];
export type Figure = { cells: Cell[] };

/** A mental-rotation pair: two block figures, and whether the second is the
 *  first turned or the first reflected.
 *
 *  Shepard and Metzler's task, which is the one everybody has seen and is
 *  genuinely the thing it claims to be — the time it takes goes up linearly
 *  with the angle between them, which is as close as a puzzle gets to being
 *  measurably a rotation happening in your head. Exactly the five minutes of
 *  waking up Lyss asked for, and unlike the other two it needs no vocabulary
 *  and no maths. */
export function makePuzzle(roll: number): { a: Figure; b: Figure; same: boolean } {
  const rnd = seeded(roll);
  /* A figure whose mirror is also a rotation of it is *chiral in name only*,
     and asking "same, or its mirror?" about one has two right answers — so the
     gate marks you wrong for the true one, which is the single worst thing a
     puzzle can do. Grow until the figure is genuinely handed; ten cubes in a
     self-avoiding walk almost always are, so the loop is a guard rather than a
     search, and it gives up rather than spinning. */
  let a = growFigure(rnd);
  let handed = chiral(a);
  for (let tries = 0; tries < 24 && !handed; tries++) {
    a = growFigure(rnd);
    handed = chiral(a);
  }
  /* And if it gave up, the pair is a rotation — which is answerable whatever
     the figure's symmetry. The one answer that can be wrong is "mirror", so
     that is the one never offered about a shape we are not sure of. */
  const same = handed ? rnd() > 0.5 : true;
  const base = same ? a : mirror(a);
  let b = base;
  /* At least one turn, or the two are drawn identically and the question
     answers itself. */
  const turns = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < turns; i++) b = turn(b, Math.floor(rnd() * 3));
  return { a, b: normalize(b), same };
}

/** A small deterministic generator, so a puzzle is a function of its seed and
 *  can be asserted. `Math.random` would make every assertion below a coin
 *  toss. */
function seeded(roll: number): () => number {
  let s = Math.floor(roll * 2 ** 31) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** A self-avoiding walk of unit cubes. Ten of them, which is enough to be hard
 *  and few enough to read at a glance. */
function growFigure(rnd: () => number): Figure {
  const cells: Cell[] = [[0, 0, 0]];
  const seen = new Set(["0,0,0"]);
  const dirs: Cell[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let at: Cell = [0, 0, 0];
  let guard = 0;
  while (cells.length < 10 && guard++ < 400) {
    const d = dirs[Math.floor(rnd() * dirs.length)];
    const next: Cell = [at[0] + d[0], at[1] + d[1], at[2] + d[2]];
    const key = next.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(next);
    at = next;
  }
  return normalize({ cells });
}

/** Whether a figure and its mirror are genuinely different shapes. */
function chiral(f: Figure): boolean {
  const m = mirror(f);
  return !rotations(f).some((p) => sameFigure(p, m));
}

function mirror(f: Figure): Figure {
  return normalize({ cells: f.cells.map(([x, y, z]) => [-x, y, z] as Cell) });
}

/** A quarter turn about one axis. Three of them generate the whole rotation
 *  group, which is why the generator above only needs to pick among three. */
function turn(f: Figure, axis: number): Figure {
  const r = (c: Cell): Cell => {
    const [x, y, z] = c;
    if (axis === 0) return [x, -z, y];
    if (axis === 1) return [z, y, -x];
    return [-y, x, z];
  };
  return normalize({ cells: f.cells.map(r) });
}

/** Slide to the origin and sort, so two figures that are the same set of cubes
 *  compare equal however they were built. */
function normalize(f: Figure): Figure {
  const min = [0, 1, 2].map((i) => Math.min(...f.cells.map((c) => c[i])));
  const cells = f.cells
    .map(([x, y, z]) => [x - min[0], y - min[1], z - min[2]] as Cell)
    .sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  return { cells };
}

/** Whether two figures are the same set of cubes. Used by the tests rather than
 *  by the game — the game knows the answer because it made it — and it is what
 *  catches a generator that produced a "mirrored" pair that is secretly the
 *  same shape, which happens whenever a figure is accidentally symmetric. */
export function sameFigure(a: Figure, b: Figure): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.cells.length !== nb.cells.length) return false;
  return na.cells.every((c, i) => c.every((v, j) => v === nb.cells[i][j]));
}

/** Every rotation of a figure — the 24 of them — so a test can ask whether two
 *  figures are the same shape rather than whether they are in the same pose. */
export function rotations(f: Figure): Figure[] {
  const out: Figure[] = [];
  const seen = new Set<string>();
  const stack = [normalize(f)];
  while (stack.length) {
    const cur = stack.pop()!;
    const key = cur.cells.map((c) => c.join(",")).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cur);
    for (const axis of [0, 1, 2]) stack.push(turn(cur, axis));
  }
  return out;
}
