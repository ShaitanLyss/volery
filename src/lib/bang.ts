/* `!` in the dock: a shell line where a prompt goes.
 *
 * Lifted from the CLI's bash mode, and the gesture is the same — a line you
 * want run rather than answered, typed where you were already typing instead
 * of somewhere else. What it cannot be is the same *mechanism*: Claude Code
 * puts what the command printed into the model's context as
 * `<local-command-stdout>`, and over `claude --print` there is no route to
 * inject context without opening a turn. So the honest arrangement is two
 * gestures rather than one — Enter runs it and the transcript keeps the record;
 * Ctrl+Enter runs it and then *says* it, as a prompt, which costs a turn
 * because it is one. See `.claude/rules/bang.md`.
 *
 * This file is the pure half: what a draft means, how the line is coloured,
 * where a completion lands, and what the agent is told when you hand a run
 * over. Nothing here knows what a shell is. Tested directly
 * (`test/bang.test.ts`).
 */

/** The character that turns the dock into a shell line. */
export const BANG = "!";

/* ── what a draft means ────────────────────────────────────────────────────── */

/** Is the dock a shell line right now?
 *
 *  True for a bare `!`, which is the point: the field has to change the moment
 *  you press the key, not once you have typed something worth running. So this
 *  and `bangOf` are two questions — one is "what is this field", the other is
 *  "is there a command in it".
 *
 *  Anchored rather than trimmed, the same argument `resolveCommand` makes about
 *  a leading slash: a line beginning with a space is prose that happens to
 *  contain a `!`, and `hooray !` is a thing somebody might say to an agent. */
export function isBang(draft: string): boolean {
  return draft.startsWith(BANG);
}

/** The command in a `!` draft, or null when there is nothing to run.
 *
 *  Trimmed at both ends. `!` alone, and `!` with nothing but spaces after it,
 *  give null rather than an empty string — the two are a field that has been
 *  turned into a shell line and not yet typed in, which is not a command and
 *  must not be runnable. Conflating them is how Enter on a bare `!` would spawn
 *  a shell to run nothing at all. */
export function bangOf(draft: string): string | null {
  if (!isBang(draft)) return null;
  const cmd = draft.slice(BANG.length).trim();
  return cmd || null;
}

/** Where the caret is inside the *command*, given where it is in the draft.
 *
 *  One character to the left of itself, because the `!` is in the draft and is
 *  not in the command — and clamped at zero, since a caret sitting before the
 *  `!` is a caret at the start of the command as far as completing it goes.
 *  The completion engine is given the command and answers in the command's own
 *  offsets; getting this by one puts every completion one character out. */
export function commandCursor(draft: string, at: number): number {
  return Math.max(0, Math.min(at - BANG.length, draft.length - BANG.length));
}

/* ── colouring the line ────────────────────────────────────────────────────── */

export type TokKind =
  /** The thing being run: the first word, and the first after every `|` or `;`. */
  | "cmd"
  /** `-Path`, `--verbose`. */
  | "param"
  /** Quoted, either way round. */
  | "str"
  /** `$PWD`, `${env:PATH}`. */
  | "var"
  /** A bare number, which is nearly always an argument worth seeing. */
  | "num"
  /** What joins the parts: pipes, redirections, separators, brackets. */
  | "op"
  /** `#` to the end of the line. */
  | "comment"
  /** Everything else — arguments, paths, whitespace. */
  | "plain";

export type Tok = { text: string; kind: TokKind };

/** Characters that end a bare word. Deliberately short: a path is a word, and
 *  `\`, `/`, `.`, `:`, `-` and `*` all have to stay inside one or every path on
 *  this machine would be shredded into a dozen tokens. */
const BREAKS = new Set([" ", "\t", "\n", "|", ";", "&", "'", '"', "$", "(", ")", "{", "}", "<", ">", ",", "="]);

/** Operators, longest first so `&&` is not read as two `&`. */
const OPS = ["&&", "||", ">>", "2>", "|", ";", "&", "<", ">", "(", ")", "{", "}", ",", "="];

/** After one of these, the next word is a command again rather than an
 *  argument — which is what makes `git log | Select-Object -First 5` colour the
 *  way you read it. */
const RESETS = new Set(["&&", "||", "|", ";", "(", "{"]);

/** Split a shell line into coloured tokens.
 *
 *  The invariant the overlay depends on: the tokens concatenate back to exactly
 *  the input, whitespace and all. The highlight is drawn *behind* a transparent
 *  textarea, so one dropped space and every colour on the line sits over the
 *  wrong character — which is why this returns whitespace as `plain` tokens
 *  instead of skipping it, and why `test/bang.test.ts` asserts the round trip
 *  on every case it has.
 *
 *  A rough PowerShell rather than a real one, on purpose. It is a reading aid:
 *  the cost of getting a token wrong is a word the wrong colour, and the cost
 *  of a parser faithful enough not to is a parser. */
export function tokens(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  /* The next bare word is the thing being run. True at the start, and true
     again after anything in RESETS. */
  let expectCmd = true;

  const push = (text: string, kind: TokKind) => {
    if (text) out.push({ text, kind });
  };

  while (i < line.length) {
    const ch = line[i];

    /* Whitespace, kept rather than skipped — see the invariant above. */
    if (ch === " " || ch === "\t" || ch === "\n") {
      let j = i;
      while (j < line.length && (line[j] === " " || line[j] === "\t" || line[j] === "\n")) j++;
      push(line.slice(i, j), "plain");
      i = j;
      continue;
    }

    /* A comment only where a word could have started, which is what reaching
       here means: the bare-word scan below does not break on `#`, so a `#`
       inside a word is consumed as part of it and only one at the front of a
       word arrives here. That is PowerShell's own rule, and it is why
       `cat a#b.txt` is a file rather than a command and a remark. */
    if (ch === "#") {
      push(line.slice(i), "comment");
      i = line.length;
      continue;
    }

    /* Quoted. Unterminated runs to the end of the line, which is the state a
       string is in for as long as you are typing it — colouring it as a string
       while it is still open is the reading you want. `''` and `""` inside are
       the escapes both dialects use, and are consumed as content. */
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "`" && ch === '"') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          if (line[j + 1] === ch) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, Math.min(j, line.length)), "str");
      i = Math.min(j, line.length);
      expectCmd = false;
      continue;
    }

    /* `$name`, `$env:PATH`, `${anything}`. */
    if (ch === "$") {
      let j = i + 1;
      if (line[j] === "{") {
        while (j < line.length && line[j] !== "}") j++;
        if (j < line.length) j++;
      } else {
        while (j < line.length && /[A-Za-z0-9_:]/.test(line[j])) j++;
      }
      push(line.slice(i, j), "var");
      i = j;
      expectCmd = false;
      continue;
    }

    const op = OPS.find((o) => line.startsWith(o, i));
    if (op) {
      push(op, "op");
      i += op.length;
      if (RESETS.has(op)) expectCmd = true;
      continue;
    }

    /* A bare word, classified once it is whole rather than character by
       character — `--verbose`, `2`, `src/lib/bang.ts` and `git` are told apart
       by what they turn out to be, not by how they start. */
    let j = i;
    while (j < line.length && !BREAKS.has(line[j])) j++;
    const word = line.slice(i, j);
    i = j;
    if (/^-{1,2}[A-Za-z]/.test(word)) {
      push(word, "param");
      /* A parameter does not answer the question of what is being run, so an
         expectation is left standing: `| -foo` is broken either way. */
    } else if (/^\d+(?:\.\d+)?$/.test(word)) {
      push(word, "num");
      expectCmd = false;
    } else {
      push(word, expectCmd ? "cmd" : "plain");
      expectCmd = false;
    }
  }

  return merge(out);
}

/** Fold neighbours of the same kind together.
 *
 *  Purely to keep the overlay's DOM down — a long path is otherwise a span per
 *  segment, and the highlight is redrawn on every keystroke. The concatenation
 *  invariant is untouched by construction. */
function merge(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const tok of toks) {
    const last = out[out.length - 1];
    if (last && last.kind === tok.kind) last.text += tok.text;
    else out.push({ ...tok });
  }
  return out;
}

/* ── completion ────────────────────────────────────────────────────────────── */

/** One thing the shell offers, as it comes back off `TabExpansion2`. */
export type Match = {
  /** What goes into the line. Already quoted by the shell where it needs to be. */
  text: string;
  /** What to draw — the leaf rather than the whole path (`bang.ts`, not
   *  `.\src\lib\bang.ts`). PowerShell's own `ListItemText`. */
  label: string;
  /** `Command`, `ProviderItem`, … — PowerShell's `CompletionResultType`. */
  kind: string;
};

/** The shell's answer: what it would replace, and with what. */
export type Completion = {
  /** Where the replacement starts, in the command's own offsets. */
  index: number;
  /** How much of it goes. */
  length: number;
  matches: Match[];
};

/** What a match is, in the dock's voice.
 *
 *  PowerShell's own names are PascalCase and half of them are jargon
 *  (`ProviderContainer` is a folder). Anything unrecognised is lowercased and
 *  shown as it is, which is a better answer than dropping it — a new result
 *  type is still information about what you are about to insert. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "Command":
      return "command";
    case "ParameterName":
      return "parameter";
    case "ParameterValue":
      return "value";
    case "ProviderContainer":
      return "folder";
    case "ProviderItem":
      return "file";
    case "Variable":
      return "variable";
    case "Property":
      return "property";
    case "Method":
      return "method";
    case "Type":
      return "type";
    case "Namespace":
      return "namespace";
    case "Keyword":
    case "DynamicKeyword":
      return "keyword";
    case "History":
      return "history";
    default:
      return kind.toLowerCase();
  }
}

/** Is this a folder, and therefore a completion you are probably not finished
 *  with? */
export function isContainer(kind: string): boolean {
  return kind === "ProviderContainer" || kind === "Namespace";
}

/** Put a match into the command, and say where the caret goes.
 *
 *  The span comes from the shell rather than from any guess made here, which is
 *  the whole reason completion is worth doing this way: PowerShell knows that
 *  `cat src/li` replaces five characters and `Get-ChildItem -Pa` replaces
 *  three, and nothing on this side has to work out which.
 *
 *  A folder gets a separator appended, so Tab twice walks down a tree instead
 *  of stopping at the first directory and making you type the slash. The
 *  separator matches whatever the completion itself uses, since a `\` inserted
 *  into a path written with `/` is a path that reads as an escape. */
export function applyCompletion(
  cmd: string,
  at: Completion,
  match: Match,
): { cmd: string; cursor: number } {
  /* Clamped rather than trusted. The span describes the command as it was when
     the request went out, and a keystroke can land while it is in flight — a
     stale span would otherwise slice at an index the line no longer has. */
  const start = Math.max(0, Math.min(at.index, cmd.length));
  const end = Math.max(start, Math.min(start + at.length, cmd.length));
  let text = match.text;
  if (isContainer(match.kind) && !/[\\/]$/.test(text)) {
    text += text.includes("/") && !text.includes("\\") ? "/" : "\\";
  }
  return {
    cmd: cmd.slice(0, start) + text + cmd.slice(end),
    cursor: start + text.length,
  };
}

/* ── what a run printed ────────────────────────────────────────────────────── */

/** How many lines of output a run keeps.
 *
 *  The tail, not the head, which is the same call the console's scrollback
 *  makes and for the same reason: the thing that went wrong is at the end. A
 *  cap is needed at all because this text lives in a transcript line, and a
 *  `cargo build` printing forty thousand lines into one would be a card you
 *  cannot scroll. */
export const BANG_LINES = 400;

/** The output as the transcript holds it, and how much never made it.
 *
 *  `dropped` is reported rather than folded into the text, because the two
 *  readers want it differently — the panel draws it as a cap, and the handover
 *  has to *say* it in words, or the agent reasons confidently about output it
 *  was never shown. Silent truncation is the failure mode here. */
export function capOutput(
  lines: string[],
  cap = BANG_LINES,
  /** Lines already gone before these — trimmed as the run went, or never
   *  handed over because they came faster than the wall draws. */
  before = 0,
): { text: string; dropped: number } {
  if (lines.length <= cap) return { text: lines.join("\n"), dropped: before };
  return {
    text: lines.slice(lines.length - cap).join("\n"),
    dropped: before + lines.length - cap,
  };
}

/** What a run's fold says while it is folded.
 *
 *  The command first, because that is what you are looking for when you scroll
 *  back past it, and then how it went. A run still going says so — the cap is
 *  the only thing on screen for a `bun run test` that takes a minute. */
export function runCap(
  cmd: string,
  code: number | null,
  lines: number,
  running: boolean,
): string {
  if (running) return `${BANG}${cmd} · running`;
  const how = code === 0 ? "" : code === null ? " · stopped" : ` · exit ${code}`;
  const much = lines === 1 ? "1 line" : `${lines} lines`;
  return `${BANG}${cmd} · ${much}${how}`;
}

/* ── handing a run to the agent ────────────────────────────────────────────── */

/** The prompt Ctrl+Enter sends: a command, where it ran, and what it said.
 *
 *  Prose and a fence rather than the CLI's own `<local-command-stdout>`
 *  wrapper. That tag is the binary's internal marker for output it injected
 *  itself, and putting it in a prompt would be this window claiming to be the
 *  thing that wrote it — where what actually happened is that you ran a command
 *  and are now telling the agent about it. So it says so, in the same quiet
 *  voice the rest of the wall uses.
 *
 *  The exit code is always stated, including zero. "It worked" is information
 *  the agent would otherwise have to infer from output that may be empty, and a
 *  command that printed nothing at all is exactly the case where the code is
 *  all there is to go on. */
export function handover(
  cmd: string,
  cwd: string,
  code: number | null,
  out: { text: string; dropped: number },
): string {
  const lines = [`i ran this in \`${cwd}\`:`, "", "```console", `$ ${cmd}`];
  if (out.dropped) {
    lines.push(`[… ${out.dropped} earlier lines dropped …]`);
  }
  if (out.text) lines.push(out.text);
  lines.push("```", "");
  lines.push(
    code === null
      ? "it was stopped before it finished."
      : `exit code ${code}.`,
  );
  return lines.join("\n");
}
