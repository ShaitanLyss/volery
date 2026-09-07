/* Skein's own slash commands: what exists, and what a half-typed draft means.
 *
 * Pure, so the vocabulary can be tested without a dock in the way — the
 * component turns a chosen command into calls, and never decides what a draft
 * matches. Same split as ./menu.ts.
 *
 * The load-bearing rule here is what this file does *not* claim. `claude` has
 * slash commands of its own — the ones in `.claude/commands/`, and the built-ins
 * — and they work in `--print` mode, so a prompt beginning with `/` is perfectly
 * ordinary traffic. Skein therefore intercepts only the names it knows and lets
 * everything else through verbatim: `/commit` is the project's command and must
 * reach the agent unread. Swallowing unknown commands would silently break every
 * custom command anybody has written, and the failure would look like the agent
 * ignoring them.
 *
 * `by` is how that rule survived the second batch of commands. `/clear` and
 * `/rename` are Skein's: there is nothing on the wire that does either — a card
 * is this window's idea and so is what it is called — so this window does them
 * itself. `/compact`, `/model` and `/effort` are the *CLI's*, and Skein does not
 * carry them out at all — it offers them, completes them, and then sends the
 * text you typed as the prompt it always was. So the palette became a way to
 * *find* the commands the agent already answers, without this file taking
 * custody of a single one of them.
 *
 * `/resume` is Skein's for the same reason `/clear` is, and the probe below is
 * why rather than the argument being made twice: the CLI's own `/resume` is a
 * picker drawn by its TUI and it refuses the request outright down this pipe,
 * exactly as `/rewind` does. Sending it would put "isn't available in this
 * environment" in the transcript of a card that has a perfectly good way to do
 * the thing — the sessions on disk are already read here, for the adoption
 * panel — so this window answers it.
 *
 * Probed 2026-08-14 against claude 2.1.232 with `tools/probe-commands.ts`,
 * spawning with Skein's exact argv and sending each as a `user` message:
 *
 *   /compact       system/status "compacting", then a status carrying
 *                  compact_result, then a fresh system/init and a result
 *   /model sonnet  result.result "Set model to Sonnet 5 for this session only"
 *   /effort high   result.result "Set effort level to high (this session only)…"
 *   /rewind        result.result "/rewind isn't available in this environment."
 *   /resume        result.result "/resume isn't available in this environment."
 *
 * The same probe asked the other route — a `control_request` on stdin — and got
 * `Unsupported control request subtype` for `compact`, `rewind` and `set_effort`.
 * `set_model` *is* on that route and succeeds, and is deliberately not used:
 * sending the text puts a line in the transcript saying what you did, where a
 * control message changes the model with nothing to show for it.
 *
 * ── and everything else under the slash, which is the agent's ──────────────
 *
 * The catalogue below is fixed because it is *this window's* vocabulary. What
 * the agent answers to is not: it depends on the directory, on which plugins are
 * installed and scoped to it, on the project's own `.claude/commands/`, and on
 * which build of Claude Code is behind it. So nothing here may name one of
 * those, and `vocabRow` turns a published row into a palette row.
 *
 * **The CLI publishes the whole list, with descriptions, before any prompt.**
 * One `control_request { subtype: "initialize" }` on a child's stdin answers in
 * about 1.2 seconds with `commands: [{ name, description, argumentHint,
 * aliases }]` — 57 of them on this machine. `slash.rs` owns that request and its
 * measurements, including the two wrong designs it replaced: a walk of
 * `.claude/commands/` that reinvented one field worse, and a schema column
 * holding what `system/init` had said, because init only arrives after a card's
 * first message. Neither was needed. Read that header before changing anything
 * here about where a name comes from.
 *
 * What this file still decides is **where in a line a name may sit**, and that
 * is the one thing `initialize` does not say. `/compact` and `/commit` are
 * *parsed by the CLI*, so they only mean anything at the head of a prompt. A
 * skill is parsed by nothing: the model reads the prompt and invokes it through
 * the `Skill` tool (`tools/probe-skill.ts` caught the whole shape — a
 * `tool_result` saying "Launching skill: …", then the skill's own text injected
 * as a `user` message). So a skill's name is prose and may sit anywhere, and
 * `by === "skill"` is the whole test. `system/init`'s `skills` array is the only
 * authoritative label of which is which, it arrives with a card's first turn,
 * and until then `paletteExtras` treats every row as mid-line-eligible — see
 * its note on why not knowing means offering *more*. */

/** One of a command's fixed values, offered the way the commands are. */
export type Choice = {
  /** Typed after the name. */
  value: string;
  /** One line, lowercase, in the dock's voice. */
  summary: string;
};

export type Command = {
  /** Typed after the slash. Lowercase, no spaces. */
  name: string;
  /** One line, lowercase, in the dock's voice. */
  summary: string;
  /** What it will actually do, shown on the highlighted entry only. */
  detail: string;
  /** Does it act on the cards the dock is pointed at?
   *
   *  True for every command that was here first, and the flag existed as the
   *  literal `true` because of it. `/resume` is the first one that acts on the
   *  *wall* instead — it opens the catalogue of sessions on disk, which is the
   *  same catalogue whatever card you happen to be looking at. So it is not
   *  refused on an empty gathering, and it does not cost the reach modifier: a
   *  gesture that reaches nothing cannot reach five things, and charging
   *  Ctrl+Enter for it would be friction scaled to a number that is always
   *  one. */
  needsCard: boolean;
  /** Who carries it out: this window, the `claude` at the other end of stdin,
   *  or the *agent* reading the prompt. A `cli` command is sent as the prompt it
   *  is; Skein only helps you type it, and never intercepts it.
   *
   *  `skill` is the third and is not a fourth kind of interception — it is sent
   *  exactly as a `cli` command is. It is a separate word because the *reader*
   *  differs, and that is what decides where in a line the name may sit: the CLI
   *  parses its own commands at the head of a prompt, while a skill is invoked
   *  by the model through the `Skill` tool, so its name is prose and may sit
   *  anywhere in the sentence. See `slashAt`. It also keeps skills out of
   *  `cliCommand`, which must stay a question about the CLI: a card named after
   *  `/dataviz make me a chart` is named after something you said. */
  by: "skein" | "cli" | "skill";
  /** The values it takes, when they are a fixed set. A command with choices is
   *  incomplete until it has one, so Enter on it opens the values rather than
   *  running anything. */
  choices?: Choice[];
  /** It puts something up to choose from rather than doing a thing.
   *
   *  Only for the dock to draw with: the palette's ellipsis is the menus' own
   *  convention for a gesture that opens something further, and it is the whole
   *  of what tells you `/resume` is about to offer you a list rather than resume
   *  something. Deliberately not derived from `needsCard` — a command that acts
   *  on no card is not thereby one that opens a panel, and reading one off the
   *  other would make the ellipsis appear on the next such command by accident.
   *  `choices` implies it and does not need it: those values are drawn by this
   *  same palette, one stage on. */
  opens?: boolean;
  /** It takes the rest of the line, as prose. The other half of `choices` and
   *  never both: one is a set to pick from and the other is something only you
   *  can supply, so the palette offers the values for the first and closes at
   *  the space for the second.
   *
   *  A command without it is exact and whole — `/clear the deck` is a sentence
   *  and goes to the agent. Incomplete without it, the same way `/model` is:
   *  `/rename` alone names nothing. */
  takesText?: boolean;
  /** What the agent's own row says it takes — `"<model>"`, `"[interval]
   *  [prompt]"`, `"branch"`. The CLI's `argumentHint`, absent where there is
   *  none.
   *
   *  Deliberately **not** `takesText`, which is a stronger claim: that one makes
   *  a command *incomplete* without an argument, so Enter opens a space rather
   *  than running anything. `/loop` takes an interval and is perfectly runnable
   *  without one, and a row that could never be sent would be worse than a row
   *  that sends early. All this decides is whether a completion leaves a space
   *  to write in, and whether the row shows what goes there. */
  hint?: string;
  /** Other names the same thing answers to, as the CLI publishes them: `review`
   *  for `code-review`, `committee` for `tx-toolkit:committee`, `reset` and
   *  `new` for `clear`.
   *
   *  Matched but never *drawn* as a row of their own, which is the whole of the
   *  design: an alias is a way to *find* a name, not a second name for the
   *  palette to list. Listing them would put five rows in front of you for one
   *  thing, and it is the canonical name that gets sent — so what you pick is
   *  what the agent sees. */
  aliases?: string[];
};

/* The models `--model` takes as aliases, read out of the 2.1.232 binary
   (`opus`, `opus[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, `fable`, `opusplan`).
   The `[1m]` pair earn their place on this wall in particular: the context ring
   is drawn against the window tier, and switching to one is the gesture for a
   card that is running out of room.

   `opusplan` earned its place the day the wall got a second gear. It used to be
   left off with the note "it is plan mode's upgrade model, and every card here
   spawns with permissions bypassed" — which was true of every card and is no
   longer true of any: `/gear planning` is exactly the state it is for, and a
   card that plans on Opus and executes on Sonnet is the pairing it names. */
const MODELS: Choice[] = [
  { value: "opus", summary: "the most capable, 200k of room" },
  { value: "opus[1m]", summary: "the same model with a million tokens of room" },
  { value: "sonnet", summary: "quicker and cheaper, 200k of room" },
  { value: "sonnet[1m]", summary: "quicker, with a million tokens of room" },
  { value: "haiku", summary: "fastest and cheapest — for small, mechanical work" },
  { value: "fable", summary: "the newest family" },
  { value: "opusplan", summary: "opus while planning, sonnet while making" },
];

/* Why `/plan` is Volery's to answer, when the rule at the top of this file is
   that unknown names go through untouched.

   Because the CLI knows the name and *refuses* it down this pipe. Probed
   2026-08-25 against 2.1.241 with Skein's exact argv, sending `/plan` as a
   `user` message:

     /plan     result.result "/plan isn't available in this environment."

   which is `/resume` and `/rewind`'s answer exactly, and puts this in the case
   that argument already settled: sending it would leave "isn't available in
   this environment" in the transcript of a card that has a perfectly good way
   to do the thing. So this window answers it.

   It is a second name for `/gear planning` rather than a replacement, which is
   two ways to do one thing and was chosen deliberately. `/gear` is the pair —
   it can say *making* as well, and it is where the palette shows you that a
   gear is a thing a card has. `/plan` is the word somebody actually types, and
   under the old arrangement it matched nothing at all: `matchCommands` is
   prefix-then-contains, and "gear" contains neither. A verb nobody can guess is
   a verb nobody uses. */

/** The two gears, and what each one costs you.
 *
 *  The vocabulary is `gears.ts`'s; these are the words the dock says. Kept
 *  beside the other choice sets rather than in `gears.ts` because a summary is
 *  the palette's voice — the same split `MODELS` keeps, where what `--model`
 *  accepts is the CLI's business and what to call it here is ours. */
export const GEAR_CHOICES: Choice[] = [
  {
    value: "planning",
    summary: "read, search and think — cannot change anything",
  },
  { value: "making", summary: "the machine, as every card has always been" },
];

/** The five levels `--effort` names, narrowest first. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/** Is this string one of the levels? */
export function isEffort(v: string | null | undefined): v is Effort {
  return !!v && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/* `--effort <level>` names these five, and the CLI's own answer describes the
   level it set ("Comprehensive implementation with extensive testing and
   documentation" for high). The summaries here say what you are buying rather
   than repeat the level's name back. */
const EFFORTS: (Choice & { value: Effort })[] = [
  { value: "low", summary: "answer briefly, and stop" },
  { value: "medium", summary: "the usual amount of thinking" },
  { value: "high", summary: "think it through, test it, write it down" },
  { value: "xhigh", summary: "more of that, and slower" },
  { value: "max", summary: "everything it has" },
];

/* Adding a command is one entry here plus one arm where the dock runs them —
   or no arm at all, if it is the CLI's. Keep the summaries short enough to read
   at a glance and the details honest about what is lost. */
export const COMMANDS: Command[] = [
  {
    name: "compact",
    summary: "fold this context into a summary",
    detail:
      "the agent keeps a summary of what has happened and drops the rest — the transcript on this wall is untouched",
    needsCard: true,
    by: "cli",
  },
  {
    name: "model",
    summary: "change which model this card talks to",
    detail: "this session only, taking effect on the next turn",
    needsCard: true,
    by: "cli",
    choices: MODELS,
  },
  {
    name: "effort",
    summary: "how hard to think about it",
    detail: "this session only, taking effect on the next turn",
    needsCard: true,
    by: "cli",
    choices: EFFORTS,
  },
  {
    name: "rename",
    summary: "call this card something else",
    detail:
      "the name you give it stands — Claude Code's generated title stops replacing it",
    needsCard: true,
    by: "skein",
    takesText: true,
  },
  {
    name: "plan",
    summary: "let this card think, without letting it build",
    detail:
      "the same as `/gear planning`, which is the word people reach for — its writing tools come off and the turn ends in a document rather than a diff. `/gear making` is the way back",
    needsCard: true,
    by: "skein",
  },
  {
    name: "gear",
    summary: "what this card is allowed to do",
    detail:
      "planning takes its writing tools away and ends the turn in a document rather than a diff — the card, the session and the context all survive the change",
    needsCard: true,
    by: "skein",
    choices: GEAR_CHOICES,
  },
  {
    name: "clear",
    summary: "start this card fresh",
    detail:
      "a new session in the same place — the old one stays on disk and can be adopted back",
    needsCard: true,
    by: "skein",
  },
  {
    name: "btw",
    summary: "ask a side question without interrupting",
    detail:
      "forks the conversation, asks, and answers beside it — the card's own turn is not touched and nothing is added to its transcript. costs a request against its account, and the answer is gone when the wall closes",
    needsCard: true,
    by: "skein",
    takesText: true,
  },
  {
    name: "resume",
    summary: "put a recorded session back on the wall",
    detail:
      "every conversation Claude Code has on disk here — closed cards, cleared ones, and anything a terminal started — offered as a card to adopt",
    needsCard: false,
    by: "skein",
    opens: true,
  },
];

/** The name being typed, while it is still only a name.
 *
 *  Null once there is a space, because by then the choosing of a *name* is
 *  over. What happens after that space is `typingChoice`'s question.
 *
 *  Anchored at the head, and stays that way: this asks whether the **draft** is
 *  a name, which is the question the dismissal and the preview both want. Where
 *  the *caret* is, is `slashAt`'s question and a different one. */
export function typingName(draft: string): string | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** A slash-name sitting in a draft, and where it starts and stops.
 *
 *  `from` is the slash itself and `to` is one past the last character of the
 *  name, so `[from, to)` is exactly what a completion replaces. */
export type Span = { from: number; to: number; name: string };

/* What a name may be made of. Wider than `typingName`'s pattern by exactly one
   character — the colon, which is how a plugin's skills are named
   (`tx-toolkit:committee`) and the only punctuation the wire has ever put in
   one. Underscore is here because a name is a name; nothing uses it yet. */
const NAME_CHAR = /[A-Za-z0-9:_-]/;

/** The slash-name the caret is inside, or null.
 *
 *  This is the trigger for the palette's first stage, and it replaced an
 *  anchored match on the whole draft. The reason is skills: a command is parsed
 *  by the CLI and so only means anything at the head of a prompt, but a skill is
 *  read by the *agent*, which makes its name an ordinary word in a sentence —
 *  "use /dataviz for the chart" is a perfectly good prompt, and it had no
 *  completion at all.
 *
 *  **The slash must begin a word**, which is the whole of what keeps this from
 *  firing on prose. `src/lib/clear.ts`, `and/or`, `12/3` and `C:/Users` all
 *  contain a slash and none of them opens anything, because the character
 *  before it is not whitespace. A leading space still says prose for the head
 *  case — `resolveCommand` refuses ` /clear` for that reason — but it cannot say
 *  so here, since a slash *inside* a line is by definition preceded by one. What
 *  separates the two is `from`: a span at 0 is a command being typed, anywhere
 *  else is a word inside a sentence, and `matchCommands` is where that
 *  difference is spent.
 *
 *  The name is the **whole** token rather than the part before the caret, so
 *  putting the caret back into the middle of a name you have already typed
 *  matches the name you can see. That also makes a stale caret harmless: any
 *  position inside the token gives the same answer, which matters because the
 *  caret is reported by a textarea and the text can be replaced without it. */
export function slashAt(draft: string, caret?: number | null): Span | null {
  /* Null is "wherever the text ends", which is both the honest reading of a
     caret nothing has reported yet and exactly the behaviour this had before
     there was a caret at all. Clamped rather than trusted: the draft can be
     rewritten under a position that was true a keystroke ago. */
  const at = Math.max(0, Math.min(caret ?? draft.length, draft.length));
  let i = at;
  while (i > 0 && NAME_CHAR.test(draft[i - 1])) i--;
  if (i === 0 || draft[i - 1] !== "/") return null;
  const from = i - 1;
  if (from > 0 && !/\s/.test(draft[from - 1])) return null;
  let to = at;
  while (to < draft.length && NAME_CHAR.test(draft[to])) to++;
  return { from, to, name: draft.slice(from + 1, to).toLowerCase() };
}

/** Is this span the entire draft, or a word with prose around it?
 *
 *  The rule Enter turns on. A span that *is* the draft is a command being
 *  chosen, so Enter runs what is lit — the behaviour the palette has always
 *  had. A span with anything around it is a word being typed, and running the
 *  lit entry there would throw away the rest of the sentence, so Enter
 *  completes it instead and leaves you writing. */
export function spansWhole(draft: string, span: Span): boolean {
  return span.from === 0 && span.to === draft.length;
}

/** The draft with `insert` put where the span was, and where the caret lands.
 *
 *  The head case comes out identical to replacing the whole draft, which is what
 *  completing used to do — so this is the general form of that rather than a
 *  second way of doing it. */
export function completeAt(
  draft: string,
  span: Span,
  insert: string,
): { text: string; caret: number } {
  return {
    text: draft.slice(0, span.from) + insert + draft.slice(span.to),
    caret: span.from + insert.length,
  };
}


/** One markdown file in a `.claude/commands/` directory, as `slash.rs` reports
 *  it. Opaque here beyond these three fields. */
export type SlashCommand = {
  /** What is typed after the slash. A plugin's skills and a command in a
   *  subdirectory are both spelled with a colon. */
  name: string;
  /** What it does, in its author's words. Empty where the CLI gave none. */
  description?: string | null;
  /** What it takes after the name — `"<model>"`, `"[interval] [prompt]"`. Empty
   *  for one that takes nothing. */
  argumentHint?: string | null;
  /** Shorter names for the same thing, as the CLI publishes them. */
  aliases?: string[] | null;
};

/** One name the agent answers to, as a row the palette can draw.
 *
 *  Everything drawn here is the **CLI's own account of itself**, which is the
 *  whole point of asking rather than working it out: the description is the
 *  author's, the hint is what the thing takes, and the provenance the CLI writes
 *  into the description (`… (project)`, `(tx-toolkit) …`) comes free. An earlier
 *  version of this function invented a summary from the shape of the name,
 *  because the only source then in use — `system/init`'s `skills` array —
 *  carries names and nothing else. See `slash.rs`.
 *
 *  `by` is the one judgement left, and it decides *where in a line the name may
 *  sit* rather than who runs it — nothing here is intercepted either way.
 *  `skill` for a name the model invokes out of the prose, `cli` for everything
 *  else, which the CLI parses at the head of a prompt. Which is which comes from
 *  `system/init`; `paletteExtras` holds that decision. */
export function vocabRow(said: SlashCommand, isSkill: boolean): Command {
  const described = (said.description ?? "").trim();
  const hint = (said.argumentHint ?? "").trim();
  return {
    name: said.name,
    /* A name with no description at all is possible and must still read as
       something: the CLI gives even a frontmatter-less command file a line off
       its body, so this is the empty-string case rather than the usual one. */
    summary: described || (isSkill ? "a skill this card has" : "the agent's own command"),
    detail: isSkill
      ? `${described || "a skill this card has"} — sent as the prompt it is, and the agent runs the skill itself, so the name can sit anywhere in a sentence`
      : `${described || "the agent's own command"} — sent as the prompt it is, and the CLI reads it, which is why it only means anything at the start of a line`,
    needsCard: true,
    by: isSkill ? "skill" : "cli",
    /* Not `takesText`, which would make the row *incomplete* and stop Enter
       ever sending it. This only says whether a completion leaves a space to
       write in — see `completionFor`. */
    hint: hint || undefined,
    aliases: (said.aliases ?? [])
      .map((a) => (a ?? "").trim().toLowerCase())
      .filter((a) => a && a !== said.name),
  };
}

/** The rows the palette offers beside Volery's own, in the order to show them.
 *
 *  The list arrives whole from `slash.rs` — one `initialize` request, every name
 *  the agent answers to, in the CLI's own order, which puts a project's own
 *  commands first and then the skills and then the built-ins. That order is
 *  kept: it is locality, and it is the order anybody reading this palette has
 *  already learned from the CLI itself.
 *
 *  `skills` is the *labelling* half and comes from a different place —
 *  `system/init`, folded per card — because nothing in the `initialize` reply
 *  says which names are skills, and the palette needs that to know which may sit
 *  mid-sentence.
 *
 *  **Not knowing yet means offering more, not less.** A card that has taken no
 *  turn has no `skills` array, and the honest fallback is to treat every row as
 *  mid-line-eligible rather than none: picking a command inside a sentence only
 *  ever *inserts its text*, since Enter completes rather than runs once there is
 *  prose around it, so the cost of being wrong that way is a row you did not
 *  want. The cost the other way is the whole feature missing on a fresh card.
 *  `skillsKnown` is the flag rather than `skills.length`, because a card whose
 *  agent genuinely has no skills is a real answer and must narrow the palette
 *  exactly as a populated one does.
 *
 *  Volery's own names win any collision, and the first of any duplicate wins the
 *  rest: two rows under one name would be a palette whose `{#each}` keys
 *  collide, and "what does `/clear` do here" has one answer. */
export function paletteExtras(
  vocab: readonly SlashCommand[] = [],
  skills: readonly string[] = [],
  skillsKnown = false,
): Command[] {
  const isSkill = new Set(skills.map((s) => (s ?? "").trim().toLowerCase()).filter(Boolean));
  const seen = new Set(COMMANDS.map((c) => c.name));
  const out: Command[] = [];
  for (const one of vocab) {
    const name = (one?.name ?? "").trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(vocabRow({ ...one, name }, skillsKnown ? isSkill.has(name) : true));
  }
  return out;
}

/** May Enter *run* this lit row, given what has actually been typed?
 *
 *  The rule exists because the palette stopped being nine names this window
 *  owns, and the two things it has to hold at once pull opposite ways.
 *
 *  `/cle` + Enter clears, as it does in the CLI. That is a shorthand worth
 *  having and it is documented behaviour here.
 *
 *  `/commit` + Enter must send `/commit`. It is the project's own command and
 *  the rule at the top of this file says it reaches the agent unread — and it
 *  very nearly stopped doing so, because `committee` is the alias the CLI
 *  publishes for `tx-toolkit:committee` and `"committee".startsWith("commit")`.
 *  Enter would have run a skill nobody named.
 *
 *  Prefix-versus-containing does not separate those: both are prefix hits. What
 *  separates them is **whose catalogue the row is from**. `COMMANDS` is nine
 *  names, closed, this window's, and known to whoever is typing — a prefix there
 *  is an abbreviation. The agent's vocabulary is dozens of names, open, and
 *  different in every directory, so a prefix there can silently be a *different
 *  command from the one you typed in full*, which is exactly what the standing
 *  rule forbids. So: abbreviation for ours, exactness for theirs.
 *
 *  Nothing is narrowed and nothing hidden either way — the row is drawn, Tab
 *  takes it, the arrows reach it. All this decides is which key claims it, and
 *  when Enter declines, the draft goes to the agent as the words it is.
 *
 *  An empty name is a browse — `/` alone lights the first row on purpose — so it
 *  may run anything. */
export function mayRunOn(cmd: Command, typed: string): boolean {
  const name = typed.trim().toLowerCase();
  if (!name) return true;
  /* Asked of the catalogue rather than of `by`: `/compact` and `/model` are the
     CLI's to carry out but they are *this file's* to offer, so `/comp` is an
     abbreviation like any other. What matters is whether this window chose the
     name, not who runs it. */
  const ours = COMMANDS.some((c) => c.name === cmd.name);
  if (ours) return cmd.name.startsWith(name);
  return [cmd.name, ...(cmd.aliases ?? [])].includes(name);
}

/** What the palette should offer for this draft, in the order to show it.
 *
 *  Empty for anything that is not a slash-name under the caret — which is also
 *  how an unknown name disappears quietly: it matches nothing here, no palette
 *  opens, and Enter sends it to the agent like any other prompt.
 *
 *  **Everything at the head, skills anywhere.** Volery's own commands are
 *  carried out by this window; the CLI's built-ins and a project's own command
 *  files are *parsed* by the CLI when a prompt begins with them. None of those
 *  three reads the middle of a prompt, so offering one there would be offering
 *  something that cannot run from there. A skill is different in kind — the model
 *  reads it out of the prose and invokes it through its own `Skill` tool — so it
 *  is offered wherever the caret is, and `by === "skill"` is the whole test.
 *
 *  `extra` arrives already composed and deduplicated by `paletteExtras`; this
 *  only decides which of it is reachable from where the caret is. */
export function matchCommands(
  draft: string,
  caret?: number | null,
  extra: readonly Command[] = [],
): Command[] {
  const span = slashAt(draft, caret);
  if (span === null) return [];
  const pool =
    span.from === 0
      ? [...COMMANDS, ...extra]
      : extra.filter((c) => c.by === "skill");
  const name = span.name;
  if (!name) return pool;
  /* Three bands, best first, and a row appears in exactly one of them.
     `leads` is a prefix of the name or of one of its aliases — the case you
     meant, so `/rev` puts `code-review` at the top through `review`, and
     `/committee` finds `tx-toolkit:committee` through the alias the CLI
     publishes for exactly that. `holds` is anything merely containing it, which
     is what keeps `/ear` finding `clear`.
     An alias is a way to *find* a name and never a row of its own: what is
     drawn and what is sent is the canonical name, so what you pick is what the
     agent sees. */
  const names = (c: Command) => [c.name, ...(c.aliases ?? [])];
  const leads = (c: Command) => names(c).some((n) => n.startsWith(name));
  const holds = (c: Command) => names(c).some((n) => n.includes(name));
  return [
    ...pool.filter(leads),
    ...pool.filter((c) => !leads(c) && holds(c)),
  ];
}

/** The named command, exactly.
 *
 *  Case-folded, since the palette completes in lowercase but nothing stops you
 *  typing it yourself. */
function byName(name: string): Command | null {
  const want = name.trim().toLowerCase();
  return COMMANDS.find((c) => c.name === want) ?? null;
}

/** A command whose name is settled and whose *value* is being typed.
 *
 *  This is the one place the "palette closes at the first space" rule bends,
 *  and it bends rather than breaks: that rule is there because the palette is
 *  for choosing, and a command left picking over free text would be claiming a
 *  choice is still to be made. A command with a fixed set of values has not
 *  finished being chosen at the space — `/model` alone is not a thing that can
 *  be run — so the palette stays up and offers the values. `/compact`, whose
 *  argument is prose, closes it as everything did before.
 *
 *  Null past the second space, for the original reason: by then the value has
 *  been picked too. */
export function typingChoice(
  draft: string,
): { cmd: Command; part: string } | null {
  const m = /^\/([a-z0-9-]+) ([^\s]*)$/i.exec(draft);
  if (!m) return null;
  const cmd = byName(m[1]);
  if (!cmd?.choices) return null;
  return { cmd, part: m[2].toLowerCase() };
}

/** What the palette should offer once a command with values is named. */
export function matchChoices(draft: string): Choice[] {
  const at = typingChoice(draft);
  if (!at) return [];
  const all = at.cmd.choices ?? [];
  if (!at.part) return [...all];
  const starts = all.filter((c) => c.value.startsWith(at.part));
  const rest = all.filter(
    (c) => !c.value.startsWith(at.part) && c.value.includes(at.part),
  );
  return [...starts, ...rest];
}

/** A Skein command and what it was given. */
export type Resolved = {
  cmd: Command;
  /** Whitespace-trimmed, empty for a command that takes nothing. */
  arg: string;
};

/** The Skein command this draft *is*, if any — the test `send` applies before
 *  handing a prompt to the agent.
 *
 *  Exact and whole unless the command says otherwise: `/clear` is ours,
 *  `/clearing` is not, and `/clear the deck` is not either — reading `/clear`
 *  out of that would throw away the rest of what was typed. A `takesText`
 *  command inverts exactly that clause and nothing else, so `/rename the auth
 *  work` is ours and carries its argument, while a bare `/rename` is not: it
 *  names nothing, and a command that cannot be carried out must fall through
 *  rather than be swallowed.
 *
 *  Only ever a `skein` command, and that is the point rather than a filter: a
 *  `cli` command has nothing here to run, because carrying it out *is* sending
 *  it, so it must fall through to the ordinary prompt path exactly as
 *  `/commit` does.
 *
 *  A `choices` command resolves with its bare name — the form Enter turns into
 *  an open palette — or with **one of its own values**, and nothing else. That
 *  is the third clause and the newest. `/gear planning` pasted whole is Volery's
 *  to run; `/gear sideways` is not, and falls through to the agent as the words
 *  it is — the same rule `/clear the deck` follows, and for the same reason.
 *  Until `/gear` this arm was unreachable: every command with choices was the
 *  CLI's, and those are filtered out a line above, so "a choices command with
 *  an argument" simply returned null and nothing noticed.
 *
 *  The name and the argument come out of one parse rather than two, so nothing
 *  can decide this is `/rename` and then disagree about where the name starts. */
export function resolveCommand(draft: string): Resolved | null {
  /* Anchored rather than trimmed at the front, because leading whitespace says
     prose: a line beginning with a space is a sentence that happens to contain
     a slash. Trailing whitespace is nothing of the kind, hence `\s*$` — a
     `/clear ` is the command with a stray space after it. */
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]+?))?\s*$/i.exec(draft);
  if (!m) return null;
  const cmd = byName(m[1]);
  if (cmd?.by !== "skein") return null;
  /* Trimmed rather than trusted to the pattern, which gets this wrong on its
     own: the lazy group hands back a single space for `/rename    `, and an
     argument of one space is a command that resolves, swallows the draft and
     renames nothing — where the rule is that anything Skein cannot carry out
     falls through to the agent as the words it is. */
  const arg = (m[2] ?? "").trim();
  if (cmd.takesText) return arg ? { cmd, arg } : null;
  if (cmd.choices) {
    /* The bare name resolves too, and has to: it is the form Enter turns into
       an open palette (`stillWriting`), so refusing it here would send `/gear`
       to the agent as a prompt rather than offering the two gears. */
    if (!arg) return { cmd, arg: "" };
    return cmd.choices.some((c) => c.value === arg) ? { cmd, arg } : null;
  }
  return arg ? null : { cmd, arg: "" };
}

/** Is this command still being written, rather than ready to run?
 *
 *  The rule the dock's Enter turns on, and it is stated here because it was
 *  wrong in a component where nothing could test it. A command that needs a
 *  value and has not been given one is *incomplete*: Enter opens the space to
 *  write in rather than running anything. `/model` alone offers the models,
 *  `/rename` alone opens somewhere to type a name.
 *
 *  **The `!arg` half is the fix.** The condition used to be
 *  `cmd.choices || (cmd.takesText && !arg)`, so a command with choices was read
 *  as incomplete *even with its value already typed* — `/model opus` pasted
 *  whole came back as an offer of the models rather than as a model. Invisible
 *  for as long as every command with choices was the CLI's, because the
 *  palette's own Enter sends those as text and never asks this question. It
 *  stopped being invisible the moment one of Volery's own had choices:
 *  `/gear planning` reached that line and returned, silently, having done
 *  nothing at all. Found by driving the real wall, which is the only place it
 *  was visible. */
export function stillWriting(cmd: Command, arg: string): boolean {
  return (!!cmd.choices || !!cmd.takesText) && !arg;
}

/** Is this prompt one of the CLI's own commands rather than something said?
 *
 *  Nothing is intercepted on the strength of this — the text goes out either
 *  way. It answers the two questions where the *difference* shows: an unnamed
 *  card must not end up called `compact`, and the card face must not preview
 *  that name while you type it. A card is named after the first thing you say
 *  to the agent, and `/model sonnet` is not said to the agent at all.
 *
 *  Tolerant of an argument, unlike `resolveCommand`, since that is the shape
 *  every one of these has. */
export function cliCommand(text: string): Command | null {
  const m = /^\/([a-z0-9-]+)(\s|$)/i.exec(text.trim());
  if (!m) return null;
  const cmd = byName(m[1]);
  return cmd?.by === "cli" ? cmd : null;
}

/** What Tab puts in the field: the whole name, ready for Enter.
 *
 *  A command that takes a value gets its space too, so completing it opens the
 *  values rather than leaving you at a name that cannot be run — and one that
 *  takes prose gets it for the same reason, with the cursor where the writing
 *  starts instead of against the name.
 *
 *  A row from the agent's own vocabulary gets the space when it says it takes
 *  something — `hint`, which is the CLI's `argumentHint`. It is not `takesText`:
 *  that would make it `stillWriting` with nothing after it, and Enter on
 *  `/dataviz` would never send anything. The space is also what closes the
 *  palette, which is what a completed word should do, and it is what lets a
 *  completion land in the *middle* of a sentence without the caret ending up
 *  hard against the name.
 *
 *  A skill gets it either way, hint or no hint: a skill takes whatever you care
 *  to say after it whether or not the CLI thought to describe that, and it is
 *  the one kind of row that can be completed mid-sentence, where the space is
 *  the difference between carrying on and reaching for the spacebar first. */
export function completionFor(cmd: Command): string {
  return cmd.choices || cmd.takesText || cmd.hint || cmd.by === "skill"
    ? `/${cmd.name} `
    : `/${cmd.name}`;
}

/** The whole line, name and value — what Tab puts in the field at the second
 *  stage, and what Enter sends. */
export function completionForChoice(cmd: Command, choice: Choice): string {
  return `/${cmd.name} ${choice.value}`;
}

/** The level out of the CLI's own answer to `/effort`, or null.
 *
 *  Why parse a sentence rather than remember what was typed: the answer is the
 *  CLI saying what it *did*, and it is the only account of it there is. Nothing
 *  else on the wire carries the effort — not `system/init`, not the `assistant`
 *  events — so between typing `/effort max` and the next turn writing an
 *  assistant record to disk, this line is the whole of what the footer could
 *  know. Skein reads the record afterwards and the two agree; this is what
 *  keeps the footer from showing the level it is replacing for a turn.
 *
 *  Probed 2026-08-20 against claude 2.1.233, sending `/effort xhigh` down
 *  Skein's own argv. The reply is a `result` with `num_turns: 0` and no cost —
 *  the CLI answers this one itself — carrying:
 *
 *    Set effort level to xhigh (this session only): Deeper reasoning than
 *    high, just below maximum (Fable 5, Opus 4.7+, Sonnet 5)
 *
 *  Anchored at the start and matched against the five known levels, so a
 *  reworded tail costs nothing and a sentence that merely mentions a level —
 *  the description after the colon names three models and could as easily name
 *  a level — is not mistaken for one being set. */
export function effortAnswer(said: string | null | undefined): Effort | null {
  if (!said) return null;
  const m = /^\s*set effort level to ([a-z]+)\b/i.exec(said);
  const level = m?.[1]?.toLowerCase();
  return isEffort(level) ? level : null;
}
