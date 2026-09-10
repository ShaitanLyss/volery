/* The one brace counter every `tools/lift-*.ts` shares.
 *
 * A lift pulls a few declarations out of a `.rs` file, writes them into a
 * standalone file and hands that to `rustc --test`, so a Rust assertion can be
 * run on a machine with no MSVC toolchain (`.claude/rules/build.md`). Finding
 * where a declaration *ends* is the whole of the extraction, and it was written
 * fifteen times to two standards.
 *
 * ### Why counting every brace on the line is not enough
 *
 * The naive version — walk the characters, `{` up, `}` down — is fine until
 * something being lifted has a brace that is not code. Then the depth never
 * comes back to zero, the block swallows the rest of the file, and rustc
 * reports `error: this file contains an unclosed delimiter` against the
 * `mod tests {` line. In `lift-project.ts` that was four hundred lines from the
 * cause, and nothing anywhere named the string that did it. Sink `4b20ad50`.
 *
 * The cases are not hypothetical and all four are already in this tree:
 *
 * - a `package.json` fixture written out literally in a test, `"{\n  \"version\"…"`
 * - `project.rs`'s `json_line`, whose doc block says "the `{` of the root
 *   object" three lines above the function being delimited
 * - `supervisor.rs`'s `append_prompt`, which is *entirely* format strings —
 *   every `{MCP_PREFIX}` in one opens a phantom block, so `lift-selfhood.ts`
 *   could not have used the naive counter at all
 * - `spawn.rs`'s `spawn_schema`, a `json!` block that is nothing but prose
 *   written for a model to read. It works today only because no tool
 *   description in it happens to contain a brace, which is a property nobody
 *   is maintaining
 *
 * ### What this is and is not
 *
 * `scan` walks a line and counts only braces that are *code*: `"…"` strings
 * with backslash escapes, `r"…"` and `r#"…"#` raw strings, `'c'` character
 * literals, `//` to end of line, and block comments across lines. State is
 * carried between lines because all three of raw strings, block comments and
 * **ordinary strings** span them.
 *
 * That last one is not in the `lift-project.ts` original this was extracted
 * from, and it is the case the tree is fullest of: a Rust `"…"` runs to its
 * closing quote however many lines that takes, and the schemas and prompts
 * these lifts are aimed at are written as one string with `\` continuations
 * over a dozen lines. The original closed the string at the end of the line,
 * so every line of prose after the first was read as *code* — which happens to
 * be harmless while the prose has no braces in it, and is the same latent bug
 * one line lower down. Proved by putting a lone `{` on a continuation line of
 * `spawn.rs`'s `spawn_schema`: the extracted scanner as first written still
 * reported `unclosed delimiter` against `mod tests {`.
 *
 * Not a Rust lexer. Nested block comments count as one; lifetimes are handled
 * only by not matching the char-literal shape; `#[doc = "…"]` is a string like
 * any other, which is correct by accident rather than by design. It has to be
 * right about the braces and nothing else.
 */

/** What `scan` carries between lines, plus what it noticed about the last one. */
export type ScanState = {
  /** Brace depth, counting code braces only. */
  depth: number;
  /** The closing delimiter of a raw string still open, e.g. `"##`, or null. */
  raw: string | null;
  /** Inside an ordinary `"…"` that has not closed yet. */
  str: boolean;
  /** Inside a `/* … *\/` that has not closed yet. */
  comment: boolean;
  /** Whether the line just scanned ended, *in code*, with a semicolon.
   *
   *  Kept here rather than tested with `/;\s*$/` by the caller because the two
   *  disagree exactly where it matters: `const X: &str = "a;";` ends with a
   *  semicolon and `const X: u8 = 1; // why` also does, where the regex sees a
   *  quote and a comment. A `const` is delimited by its semicolon rather than
   *  by a brace, so this is the other half of the same question. */
  semi: boolean;
};

export function freshScan(): ScanState {
  return { depth: 0, raw: null, str: false, comment: false, semi: false };
}

/** From `k`, walk to just past the closing `"` of an ordinary string literal.
 *  Returns `line.length` or more if the string is still open at end of line —
 *  which is either a literal spanning lines or a `\` continuation, and the two
 *  are the same thing to a brace counter. */
function pastString(line: string, k: number): number {
  while (k < line.length && line[k] !== '"') k += line[k] === "\\" ? 2 : 1;
  return k;
}

/** Fold one line into `state`. */
export function scan(line: string, state: ScanState): void {
  let last = "";
  let k = 0;
  const done = () => {
    state.semi = last === ";";
  };

  /* Mid-raw-string from a previous line: skip to its terminator. */
  if (state.raw !== null) {
    const end = line.indexOf(state.raw);
    if (end < 0) return done();
    k = end + state.raw.length;
    last = '"';
    state.raw = null;
  }
  /* Mid-ordinary-string from a previous line: the same, honouring escapes. */
  if (state.str) {
    const end = pastString(line, 0);
    if (end >= line.length) return done();
    k = end + 1;
    last = '"';
    state.str = false;
  }
  if (state.comment) {
    const end = line.indexOf("*/");
    if (end < 0) return done();
    k = end + 2;
    state.comment = false;
  }

  for (; k < line.length; k++) {
    const ch = line[k];
    if (ch === "/" && line[k + 1] === "/") return done();
    if (ch === "/" && line[k + 1] === "*") {
      const end = line.indexOf("*/", k + 2);
      if (end < 0) {
        state.comment = true;
        return done();
      }
      k = end + 1;
      continue;
    }
    if (ch === "r" && (line[k + 1] === '"' || line[k + 1] === "#")) {
      const m = /^r(#*)"/.exec(line.slice(k));
      if (m) {
        const close = `"${m[1]}`;
        const end = line.indexOf(close, k + m[0].length);
        if (end < 0) {
          state.raw = close;
          return done();
        }
        k = end + close.length - 1;
        last = '"';
        continue;
      }
    }
    if (ch === '"') {
      const end = pastString(line, k + 1);
      if (end >= line.length) {
        state.str = true;
        return done();
      }
      k = end;
      last = '"';
      continue;
    }
    /* A char literal, but not a lifetime — `'a` has no closing quote. */
    if (ch === "'") {
      const m = /^'(\\.|[^'\\])'/.exec(line.slice(k));
      if (m) {
        k += m[0].length - 1;
        last = "'";
      }
      continue;
    }
    if (ch === "{") state.depth++;
    else if (ch === "}") state.depth--;
    if (ch.trim() !== "") last = ch;
  }
  done();
}

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[test]` would compile into a file with nothing to
 *  run, and would report that by passing. Same for `#[derive(PartialEq)]`,
 *  which compiles into a different thing and says so only at the assertion. */
export function startOf(lines: string[], i: number): number {
  let from = i;
  while (from > 0) {
    const prev = lines[from - 1].trim();
    if (prev.startsWith("///") || prev.startsWith("//") || prev.startsWith("#[")) {
      from--;
      continue;
    }
    break;
  }
  return from;
}

/** True for a declaration that ends at a semicolon rather than at a brace. */
const SEMI_DECL = /^\s*(pub\s*(\([a-z:]+\))?\s+)?(const|static)\b/;

/** From a declaration line to its end, given as text with its doc comments.
 *
 *  `where` names the file, and is only ever used to say where an unterminated
 *  declaration was — the error a lift throws when a `find` has matched
 *  something this cannot delimit.
 *
 *  Two shapes, and which one is used is decided by the head line:
 *
 *  - a `const` or `static` runs to its **semicolon**, however many continuation
 *    lines that takes. Handled here rather than by the brace walk because a
 *    multi-line string const has no braces at all, so the walk runs past it and
 *    swallows whatever follows until it finds somebody else's closing brace.
 *    Found in `lift-smith.ts` while measuring `SEARCH_HINT_PIPELINES`, four
 *    continuation lines long: the lift compiled with three items defined twice
 *    and rustc named the duplicates rather than the cause.
 *  - everything else runs to the **brace** that brings it back to depth 0, or
 *    to its semicolon if it never opened one — `struct Foo;`, `type X = …;`,
 *    a trait method with no body. */
export function blockAt(lines: string[], i: number, where: string): string {
  const from = startOf(lines, i);
  const state = freshScan();

  if (SEMI_DECL.test(lines[i])) {
    for (let j = i; j < lines.length; j++) {
      scan(lines[j], state);
      if (state.semi && state.depth === 0) return lines.slice(from, j + 1).join("\n");
    }
    throw new Error(`unterminated const at ${where}:${i + 1}`);
  }

  let seen = false;
  for (let j = i; j < lines.length; j++) {
    scan(lines[j], state);
    if (state.depth > 0) seen = true;
    if (seen && state.depth === 0) return lines.slice(from, j + 1).join("\n");
    if (!seen && state.semi && state.depth === 0) return lines.slice(from, j + 1).join("\n");
  }
  throw new Error(`unterminated block at ${where}:${i + 1}`);
}
