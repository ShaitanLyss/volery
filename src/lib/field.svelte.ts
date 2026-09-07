import type { Command } from "./commands";
import {
  cliCommand,
  matchChoices,
  matchCommands,
  resolveCommand,
  slashAt,
  spansWhole,
  typingChoice,
} from "./commands";
import { bangOf, isBang } from "./bang";

/** What is being typed, and what the typing currently means.
 *
 *  Lifted out of `App.svelte` when the dock became `Dock.svelte`, and the line
 *  it is cut along is worth stating: everything here is a fold over the draft
 *  text and the two dismissals, using only the pure modules. Nothing in it
 *  knows about a card, a project, or the wall — so the dock can own the whole
 *  cluster, and the one reading the *wall* needs (`preview`, drawn on the face
 *  of an unnamed card) is available without the wall having to reach inside a
 *  component for it. That reading is the reason this is a class rather than
 *  state living in `Dock.svelte`: it is genuinely shared, and a `$bindable`
 *  echoing a derivation back up to the parent is the same knot tied twice.
 *
 *  The named-for-what-it-is rule the rest of the app follows: `Field` is the
 *  box you type in, `Dock` is the strip it sits in, and `drafts.ts` — a
 *  different thing with a similar name — is where a card's unsent text is kept
 *  while you are looking at another card. See `.claude/rules/commands.md` and
 *  `.claude/rules/bang.md` for what the two vocabularies mean; this only holds
 *  which one is being spoken. */
export class Field {
  /** The text itself. Two-way with the textarea, and the one thing here that
   *  anything outside the dock writes — a command that rewrites the line, a
   *  completion that lands in it, a card switch that swaps the draft out. */
  text = $state("");

  /** Which palette entry is lit — an index into whichever list is up. Clamped
   *  at use, since the list shortens as you type and an index left past the end
   *  would light nothing. */
  at = $state(0);

  /** Where the caret is, or null for "wherever the text ends".
   *
   *  Only the first stage of the palette needs it, and only since a slash-name
   *  stopped having to be the whole draft — `slashAt` asks which word the caret
   *  is in. Reported by the dock off the textarea, and **null is a real value
   *  rather than a missing one**: nothing has said where the caret is until
   *  something types, and the end of the text is both the honest answer to that
   *  and exactly what this behaved as before the field had one. Everything that
   *  rewrites the text without going through a keystroke — a completion, a card
   *  switch, `reset` — either sets it or puts it back to null, so a position
   *  left over from a draft that is gone can never narrow the palette. */
  caret = $state<number | null>(null);

  /** The rows the palette offers beside Volery's own: the project's own command
   *  files, then the card's skills, composed by `paletteExtras`.
   *
   *  Given rather than discovered, which keeps this class ignorant of cards and
   *  of Rust the way the rest of it is — the dock hands over whatever belongs to
   *  whichever card a send would reach. Empty is the ordinary state of a card
   *  that has never taken a turn in a project that keeps no commands of its own,
   *  and it costs nothing: the palette is then exactly the one it has always
   *  been. */
  extra = $state<Command[]>([]);

  /** Escape dismissed the palette for this draft — the text stays, so `/clear`
   *  can still be sent to an agent as words if that is what you meant. */
  commandsOff = $state(false);

  /** Escape said "I did not mean a shell line" for this draft. The text stays,
   *  exactly as it does for the palette: a prompt beginning with `!` is a
   *  perfectly ordinary thing to say to an agent ("!! this is the bug"), and
   *  that is the way to say it. */
  bangOff = $state(false);

  /** How many times a press has been refused for want of the reach modifier.
   *
   *  A gathering costs Ctrl+Enter — friction that scales with reach, and with
   *  permissions bypassed a broadcast is the most destructive gesture in the
   *  app. But the gate used to `return` and say nothing at all: the press did
   *  nothing, the draft stayed in the box, and the only difference from a dead
   *  keyboard was that you were expected to notice `Ctrl ↵` already written
   *  beside the field.
   *
   *  So the press gets an answer, and the answer is that reading — the dock
   *  flashes the key it wanted rather than putting up prose about it. A counter
   *  rather than a flag because two refusals in a row have to be two flashes,
   *  and `{#key}` in `Dock.svelte` is what makes the second one retrigger. */
  refused = $state(0);

  /** That press wanted a modifier it did not have. */
  refuse() {
    this.refused += 1;
  }

  /** The slash-name the caret is in, and where it starts and stops — what a
   *  completion replaces, and what tells the two Enters apart. */
  token = $derived(this.commandsOff ? null : slashAt(this.text, this.caret));

  commands = $derived(
    this.commandsOff ? [] : matchCommands(this.text, this.caret, this.extra),
  );

  /** The second stage: a command with a fixed set of values, named but not yet
   *  given one. `/model ` is not a thing that can be run, so the palette stays
   *  up past the space and offers the values — see `typingChoice`. */
  choosing = $derived(this.commandsOff ? null : typingChoice(this.text));
  choices = $derived(this.commandsOff ? [] : matchChoices(this.text));

  commandPick = $derived(
    this.commands.length
      ? this.commands[Math.min(this.at, this.commands.length - 1)]
      : null,
  );
  choicePick = $derived(
    this.choices.length
      ? this.choices[Math.min(this.at, this.choices.length - 1)]
      : null,
  );

  /** Is anything being chosen? The keys the palette borrows are borrowed by
   *  both of its stages. */
  palette = $derived(this.commands.length > 0 || this.choices.length > 0);

  /** Is the palette choosing the whole draft, or a word inside a sentence?
   *
   *  Enter runs what is lit only in the first case. In the second the lit row is
   *  a completion and nothing more — running it would send `/dataviz` and throw
   *  away the "make a chart of" in front of it.
   *
   *  The values stage is always whole: `typingChoice` is anchored at the head,
   *  so a draft that has reached it is `/name value` and nothing else. */
  whole = $derived(
    this.choosing !== null ||
      (this.token ? spansWhole(this.text, this.token) : false),
  );

  /** Is the field a shell line? */
  banging = $derived(!this.bangOff && isBang(this.text));

  /** The command in it, or null while it is still only a `!`. */
  bangText = $derived(this.banging ? bangOf(this.text) : null);

  /** What an unnamed card should wear while you type.
   *
   *  An unnamed card shows the draft as the name it is about to have — but a
   *  command is not a name. It is withheld while the palette is lit, because
   *  `/clear` is about to be *run* rather than sent; and withheld for one of
   *  the CLI's own, because `/model sonnet` is sent but is not something said
   *  to the agent, and `#deliver` will not name the card from it either. The
   *  two have to agree, or the face previews a name the send does not give it.
   *
   *  `/rename` is the one command that has a name in it, and so is the one case
   *  where the preview is the argument rather than nothing: what a card is about
   *  to be called is exactly what this gesture is for, and drawing `/rename the
   *  auth work` in the title line would preview a name no card will ever wear.
   *  `titleFromPrompt` does the cutting in `cardName` either way, so the preview
   *  is cut the same way `Skein.rename` is about to cut it. */
  preview = $derived.by(() => {
    /* A `!` line is not a name either, and for the strongest version of the
       reason: it is not even said to the agent. `#deliver` never sees it, so a
       card previewing `!bun run check` would be showing a name no card can ever
       wear. */
    if (this.banging) return "";
    const found = resolveCommand(this.text);
    if (found?.cmd.name === "rename") return found.arg;
    /* Withheld for a palette that is choosing the *whole* draft, which is what
       "a command is not a name" was always about. A palette open over a word
       inside a sentence is an autocomplete: the sentence is still going to be
       sent, and still going to name the card, so blanking the face while you
       complete a skill in the middle of it would preview an emptiness no card
       ever wears. A skill's own name is a fine name for a card — unlike one of
       the CLI's, it is something you said to the agent. */
    if ((this.palette && this.whole) || found || cliCommand(this.text)) return "";
    return this.text;
  });

  /** Replace the whole draft, and put the caret back to meaning its end.
   *
   *  Every write that replaces the *entire* line goes through here rather than
   *  assigning `text` — clearing after a send, a command completing itself, a
   *  card handing its draft back, the control surface typing for a test. They
   *  all share one property and it is easy to forget one of them: the position
   *  the textarea last reported was measured against a line that no longer
   *  exists, and a caret that outlives its sentence is how a palette ends up
   *  matching a word nobody can see. Null is not "unknown" here, it is the
   *  answer — the caret is about to be at the end, which is where every one of
   *  these callers then puts it.
   *
   *  A write that replaces only *part* of the line — a completion landing in the
   *  middle of a sentence — sets a real position instead, and does not come
   *  through here. */
  put(text: string) {
    this.text = text;
    this.caret = null;
  }

  /** Put the field back to a bare prompt with the given text in it.
   *
   *  Both dismissals are cleared and the lit row is reset, because all three are
   *  statements about the draft that is being replaced. Switching cards, sending,
   *  and clearing all land here rather than each remembering the list.
   *
   *  The caret goes with them, and for the same reason plus a sharper one: a
   *  position measured against text that is gone is not stale, it is about a
   *  different sentence. Null puts it back to the end of whatever is here now,
   *  which is where the textarea will put it anyway. */
  reset(text = "") {
    this.text = text;
    this.bangOff = false;
    this.commandsOff = false;
    this.at = 0;
    this.caret = null;
  }
}
