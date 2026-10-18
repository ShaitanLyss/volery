/* The window's message to a card: what a key in the field does, what Enter
 * sends and to whom, the slash commands, and the `!` line.
 *
 * This was `App.svelte`'s — `onDraftKey`, `send`, `sendText`, `runCommand`,
 * `runBang`, `completeName`, `takeCompletion`, `askCompletion` and the dock's
 * caret and stir handlers — and came out when chat view needed a second field
 * over the same draft (`docs/chat-mode.md` §7.3). Three layers, and this is the
 * middle one:
 *
 * 1. `PromptBox.svelte` over the field's `Attachments`: paste, drop, chips.
 * 2. **This**: keys, commands, `!` lines, reach, sending. One for the window,
 *    beside `Field` (one draft for the window, since the two views are never
 *    on screen together).
 * 3. The views — the dock, and chat view's message box — two drawings of it.
 *
 * What the views share they share by *being* this: the mounted field registers
 * itself as `input` (whichever view is up), so focusing the draft, setting the
 * caret after a completion and reading where it is all reach the field that is
 * actually on screen. App's single `prompt` ref did that for the dock alone,
 * and a printable key typed with nothing focused would have tried to focus the
 * dock's textarea under chat view and failed, every time.
 *
 * The keys are `composer.ts`'s table, per view. The view is read here
 * (`view.svelte.ts`), never passed. And in chat view the reach is the
 * selected card and nothing else, with broadcast forced off whatever modifier
 * is down: a gathering on the wall would otherwise be broadcast to from a view
 * that cannot show it, by cards running with the bypass flag. */

import { tick } from "svelte";
import type { Conversation } from "./conversation.svelte";
import type { Skein } from "./skein.svelte";
import type { CardHandle } from "./cards.svelte";
import type { Field } from "./field.svelte";
import type { Bang } from "./bang.svelte";
import type { Turn } from "./attach";
import {
  completeAt,
  completionFor,
  completionForChoice,
  resolveCommand,
  stillWriting,
  stirsCard,
  type Command,
} from "./commands";
import { isGear } from "./gears";
import { whyNot, type Verb } from "./handle";
import { BANG, type Completion, type Match, applyCompletion, commandCursor } from "./bang";
import { keyFor, type Step } from "./composer";
import { view } from "./view.svelte";

/** What the window lends the composer: the draft, the wall, and the few
 *  gestures that are the window's — walking the cards needs the canvas's order,
 *  and `/resume` opens a panel App holds. */
export type ComposerHost = {
  field: Field;
  skein: Skein;
  bang: Bang;
  /** The card in the ring, here or on another wall. */
  card: () => CardHandle | null;
  /** What a prompt reaches on the wall: the gathering when there is one, else
   *  the card in the ring. */
  reach: () => CardHandle[];
  /** The gathering on the wall, this wall's cards only. */
  targets: () => Conversation[];
  /** The one card a `!` line runs in (`dockCard`). */
  bangCard: () => Conversation | null;
  cycleTab: (step: 1 | -1, wholeWall: boolean) => void;
  openImport: (force: boolean) => void;
};

export class Composer {
  #h: ComposerHost;

  /** The field on screen — the dock's or chat view's message box, whichever
   *  is mounted, bound by it (`bind:el={composer.input}`). */
  input = $state<HTMLTextAreaElement | undefined>(undefined);

  constructor(host: ComposerHost) {
    this.#h = host;
  }

  /** What a prompt reaches now. On the wall, the gathering or the card in the
   *  ring; in chat view, the selected conversation and nothing else. */
  get reach(): CardHandle[] {
    if (view.current === "chat") {
      const one = this.#h.card();
      return one ? [one] : [];
    }
    return this.#h.reach();
  }

  /** The gathering, this wall's cards only — none in chat view. */
  get targets(): Conversation[] {
    if (view.current === "chat") {
      const one = this.#h.card()?.conv;
      return one ? [one] : [];
    }
    return this.#h.targets();
  }

  /** Put the caret at the end of the draft, after the value has landed. */
  async focus() {
    await tick();
    this.input?.focus();
    this.input?.setSelectionRange(this.#h.field.text.length, this.#h.field.text.length);
  }

  /** Where the caret is, off the field itself.
   *
   *  Everything the palette's first stage does keys on which word the caret is
   *  in, and there is no one event that reports every way it moves — `input`
   *  covers typing, `keyup` the arrows and Home/End, `click` a pointer landing
   *  mid-word, and `focus` coming back to a draft you left. Four cheap handlers
   *  rather than `selectionchange`, which is engine-dependent and would fail
   *  silently by leaving the palette matching the end of the line.
   *
   *  Never called for a write this app made: those go through `Field.put`,
   *  which puts the caret back to meaning the end of the text. */
  caretMoved = () => {
    this.#h.field.caret = this.input?.selectionStart ?? null;
  };

  /** An edit to the draft, as opposed to the caret merely moving in it.
   *
   *  What the edit buys is the card's process. A card at rest no longer gets one
   *  at launch (`rousing.ts`), so the first send of the day would otherwise be a
   *  spawn and a `--resume` waited out with the sentence already typed. Starting
   *  it on the first character spends that second on the time you were using
   *  anyway. Nothing is awaited — `Skein.stir` is a head start, and `#deliver`
   *  still asks for a process and still fails honestly if there is none.
   *
   *  Two things it is asked about first, and both are the stir guard every
   *  field over this draft must share — a second field that stirred without
   *  them brings back `/clear` typed into a dormant card resuming the very
   *  session it was clearing (`restore.md`). A `!` line reaches no agent, so a
   *  card you only run commands in stays dormant; and `stirsCard` refuses an
   *  empty box and a command that is not a turn.
   *
   *  The focused card and not the gathering: twenty would be twenty spawns off
   *  one keystroke, the herd `ROUSE_GAP_MS` exists to avoid. */
  edited = () => {
    this.caretMoved();
    const field = this.#h.field;
    if (field.banging || !stirsCard(field.text)) return;
    this.#h.card()?.stir();
  };

  /** A key in the field. The table is `composer.ts`'s; this carries it out. */
  key = (e: KeyboardEvent) => {
    const { field, bang } = this.#h;
    const s: Step | null = keyFor(
      view.current,
      { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
      {
        banging: field.banging,
        offer: !!bang.offer,
        history: !!this.#h.bangCard(),
        palette: field.palette,
        pick: !!(field.choicePick || field.commandPick),
      },
    );
    if (!s) return;
    if (s.prevent) e.preventDefault();
    if (s.stop) e.stopPropagation();
    switch (s.act) {
      case "offer-move":
        bang.move(s.by);
        return;
      case "offer-take": {
        const lit = bang.lit;
        if (lit && bang.offer) void this.takeCompletion(bang.offer, lit);
        return;
      }
      case "offer-close":
        bang.close();
        return;
      case "offer-drop":
        bang.close();
        return;
      case "bang-complete":
        void this.askCompletion();
        return;
      case "bang-history": {
        const card = this.#h.bangCard();
        if (!card) return;
        const was = bang.step(card, s.by, field.text.slice(BANG.length));
        if (was !== null) {
          e.preventDefault();
          field.text = BANG + was;
          void tick().then(() => this.input?.setSelectionRange(field.text.length, field.text.length));
        }
        return;
      }
      case "bang-leave":
        field.bangOff = true;
        return;
      case "bang-run":
        void this.runBang(s.tell);
        return;
      case "palette-move": {
        const rows = field.choices.length || field.commands.length;
        field.at = (Math.min(field.at, rows - 1) + s.by + rows) % rows;
        return;
      }
      case "palette-off":
        field.commandsOff = true;
        return;
      case "palette-complete":
        /* The values stage replaces the whole line, because it *is* the whole
           line — `typingChoice` is anchored at the head. The names stage
           replaces only the slash-word the caret is in. */
        if (field.choicePick && field.choosing) {
          field.put(completionForChoice(field.choosing.cmd, field.choicePick));
        } else if (field.commandPick) {
          void this.completeName(field.commandPick);
        }
        return;
      case "cycle":
        this.#h.cycleTab(s.by, s.wide);
        return;
      case "send":
        void this.send(s.widen);
        return;
      case "plan":
        void this.togglePlan();
        return;
      case "escape": {
        const card = this.#h.card();
        if (card && card.can("stop") === "yes") void card.do("stop");
        return;
      }
    }
  };

  /** Plan first, on or off, for the conversation in front of you — chat view's
   *  Alt+P. A card on another wall has no gear here, and says so. */
  async togglePlan() {
    const card = this.#h.card();
    const conv = card?.conv;
    if (!conv) {
      if (card) this.#h.skein.fault = "plan first is this wall's — not yet one on another";
      return;
    }
    await this.#h.skein.setGear(conv, conv.gear === "planning" ? "making" : "planning");
  }

  /** Run the `!` line, and hand the result over if that is what was asked.
   *
   *  Cleared before the run rather than after, so the field is ready for the
   *  next thing while a build is still going — a `!` run does not own the
   *  field, and the transcript is where it reports. */
  async runBang(handOver: boolean) {
    const { field, bang } = this.#h;
    const cmd = field.bangText;
    const card = view.current === "chat" ? (this.#h.card()?.conv ?? null) : this.#h.bangCard();
    /* No card with a field you can type in is a card on another wall: a `!`
       line runs in a directory on this machine, and that card has none here.
       Refused out loud, as `send` refuses the same line. */
    if (!card) return field.refuse();
    if (!cmd) return;
    bang.close();
    field.put("");
    await bang.run(card, cmd, handOver);
  }

  /** Put a completion into the `!` line, and the caret after it. The `!` is
   *  added back here because the shell was asked about the *command* and
   *  answers in the command's own offsets — see `commandCursor`. */
  async takeCompletion(offer: Completion, match: Match) {
    const { field, bang } = this.#h;
    const done = applyCompletion(field.text.slice(BANG.length), offer, match);
    field.text = BANG + done.cmd;
    bang.close();
    await tick();
    this.input?.setSelectionRange(done.cursor + BANG.length, done.cursor + BANG.length);
  }

  /** Ask the shell what it would complete, and apply it if there is only one. */
  async askCompletion() {
    const { field, bang } = this.#h;
    const card = this.#h.bangCard();
    if (!card) return;
    const cmd = field.text.slice(BANG.length);
    const at = commandCursor(field.text, this.input?.selectionStart ?? field.text.length);
    const only = await bang.complete(card, cmd, at);
    if (only) await this.takeCompletion(only.offer, only.only);
  }

  /** Put a palette name into the line where the caret is, and leave you there.
   *
   *  What Tab does, and what Enter does when the name is a word inside a
   *  sentence rather than the whole draft. The caret is set on `Field` as well
   *  as on the field, because the field's own report comes from an event and
   *  there is no event here. */
  async completeName(cmd: Command) {
    const field = this.#h.field;
    const span = field.token;
    if (!span) return;
    const done = completeAt(field.text, span, completionFor(cmd));
    field.text = done.text;
    field.caret = done.caret;
    field.at = 0;
    await tick();
    this.input?.setSelectionRange(done.caret, done.caret);
  }

  async runCommand(cmd: Command, broadcast: boolean, arg = "") {
    const { field, skein } = this.#h;
    if (view.current === "chat") broadcast = false;
    const reach = this.reach;
    /* Only the ones that act on cards need one. `/resume` acts on the wall —
       it offers the sessions on disk, which is the same offer whatever is
       standing in front of you — so an empty gathering is no reason to refuse
       it. */
    if (cmd.needsCard && reach.length === 0) return;
    /* A command that takes a value is not finished being chosen, so Enter on it
       means "show me them" rather than running anything — there is nothing yet
       to run. Tab does the identical thing, which is the point: at this row the
       two keys agree. One that takes prose is in exactly the same position with
       nothing typed after it, and gets the same answer. The rule itself is
       `commands.ts`'s (`stillWriting`). */
    if (stillWriting(cmd, arg)) {
      field.put(completionFor(cmd));
      field.at = 0;
      return;
    }
    /* A command reaches as far as a prompt does and costs the same modifier —
       clearing five cards at once should not be easier than talking to them.
       Refused out loud, for `sendText`'s reason. Skipped for one that acts on
       no card: friction here scales with reach. */
    if (cmd.needsCard && reach.length > 1 && !broadcast) return field.refuse();
    /* The CLI's own commands — and a skill, read by the agent — are carried out
       by sending them. Volery has only helped you type it, and the value goes
       with it. */
    if (cmd.by !== "skein") {
      return this.sendText(arg ? `/${cmd.name} ${arg}` : `/${cmd.name}`, broadcast);
    }
    /* The two of Volery's own that are a card's verbs reach a card wherever it
       is, through its handle: `/clear` and `/account` on a card on another
       wall are the right-click's clear and put-it-on, asked of its wall. The
       rest are this wall's own. Asked before the field is cleared, so a lone
       card that cannot be asked keeps the draft and says why. */
    const asVerb: { verb: Verb; args: Record<string, unknown> } | null =
      cmd.name === "clear"
        ? { verb: "clear", args: {} }
        : cmd.name === "account"
          ? { verb: "account", args: { account: arg } }
          : null;
    const lone = cmd.needsCard && reach.length === 1 ? reach[0]! : null;
    const no = !lone
      ? null
      : asVerb
        ? whyNot(lone.can(asVerb.verb))
        : lone.remote
          ? `/${cmd.name} reaches this wall's cards — not yet one on ${lone.remote.host}`
          : null;
    if (no) {
      skein.fault = no;
      return field.refuse();
    }
    field.put("");
    field.at = 0;
    /* Forced open rather than toggled: typing the name is a request for the
       panel and never a request to put it away. */
    if (cmd.name === "resume") return this.#h.openImport(true);
    /* Sequential rather than `Promise.all`, like every other arm: each move or
       clear ends a process, and five at once is a herd aimed at the one thing on
       this wall that is already the slowest. */
    if (asVerb) {
      for (const c of [...reach]) await c.do(asVerb.verb, asVerb.args);
      return;
    }
    const on = [...this.targets];
    if (cmd.name === "rename") {
      /* Reaching the whole gathering, gated by the same modifier above — a
         rename that only took on the focused card would be the dock quietly
         disagreeing with its own target line. */
      for (const c of on) await skein.rename(c, arg);
    } else if (cmd.name === "btw") {
      /* The same question put to five cards at once, each answered against its
         own conversation — a request per card, behind the same modifier. */
      for (const c of on) await skein.askAside(c, arg);
    } else if (cmd.name === "plan") {
      /* The one direction; coming back is `/gear making`. */
      for (const c of on) await skein.setGear(c, "planning");
    } else if (cmd.name === "gear") {
      /* An unrecognised word changes nothing rather than putting a card into a
         gear neither of us meant. */
      if (!isGear(arg)) return field.refuse();
      for (const c of on) await skein.setGear(c, arg);
    }
  }

  /** Say something to every card it reaches, with the reach gate Enter has.
   *  One card is said to through its handle, wherever it is; a gathering is
   *  this wall's. */
  async sendText(text: string, broadcast: boolean) {
    const { field, skein } = this.#h;
    if (view.current === "chat") broadcast = false;
    const reach = this.reach;
    if (!text || reach.length === 0) return;
    /* Friction scales with reach: Enter sends to one, Ctrl+Enter to many. With
       permissions bypassed a broadcast is the most destructive gesture in the
       app, and one modifier is the cheapest possible insurance. The refusal
       flashes `Ctrl ↵`, which is the answer and is already on screen. */
    if (reach.length > 1 && !broadcast) return field.refuse();

    /* Composed *before* the field is cleared, because the attachments live on
       the field and `put("")` prunes every one of them. Composed **per card**,
       because what an attachment becomes depends on where it goes
       (`Attachments.turnFor`). Anything that cannot go is refused here, with
       the draft kept and the reason said beside it. */
    const one = reach.length === 1 ? reach[0]! : null;
    if (one) {
      const turn = await field.shots.turnFor(text, one.reach, one.id);
      if ("refused" in turn) {
        field.shots.refused = turn.refused;
        return field.refuse();
      }
      /* And asked whether it can arrive: a card on another wall takes what its
         wall can take, and nothing at all while its wall is quiet. */
      const carries = one.carries(turn);
      if (carries !== "yes") {
        skein.fault = carries.no;
        return field.refuse();
      }
      field.put("");
      field.at = 0;
      /* `turn.text`, not what was typed: a file's token is its path from here
         on, so the line drawn is the line the agent reads. */
      await one.say(turn.text, turn);
      return;
    }
    const targets = this.targets;
    const turns = new Map<string, Turn>();
    for (const c of targets) {
      const turn = await field.shots.turnFor(text, { chat: c.kind === "chat", afar: false }, c.id);
      if ("refused" in turn) {
        field.shots.refused = `${c.title || c.project}: ${turn.refused}`;
        return field.refuse();
      }
      turns.set(c.id, turn);
    }
    field.put("");
    field.at = 0;
    await skein.broadcast(targets, text, (c) => turns.get(c.id)!);
  }

  /** Enter. One path for a card here and a card on another wall; what differs
   *  is what can travel, and the handle says so where it is asked.
   *
   *  The palette is the trap that made this careful: it opens over a `/` on any
   *  card, and sending its line raw put `/gear planning` in front of a far
   *  agent as a prompt about the word "planning" (`gears.md`). So a half-typed
   *  name completes as it would here, and a whole one is run — or refused, with
   *  the draft kept — and never shipped as text. */
  async send(broadcast = false) {
    const { field } = this.#h;
    if (view.current === "chat") broadcast = false;
    /* With a value lit the line is complete, so Enter runs it — *sends* it if
       it is the CLI's, runs it if it is Volery's own. */
    if (field.choicePick && field.choosing) {
      const { cmd } = field.choosing;
      const value = field.choicePick.value;
      if (cmd.by === "skein") return this.runCommand(cmd, broadcast, value);
      return this.sendText(completionForChoice(cmd, field.choicePick), broadcast);
    }
    /* With the palette open the key means "run what is lit", exactly as in the
       CLI — unless the lit name is a word inside a sentence, where Enter
       completes it and leaves you writing, which is what Tab does. */
    if (field.commandPick) {
      if (!field.whole) return this.completeName(field.commandPick);
      return this.runCommand(field.commandPick, broadcast);
    }

    const text = field.text.trim();
    if (!text || this.reach.length === 0) return;
    /* A command typed in full and sent without the palette ever opening. Only
       Skein's own arrive here: the CLI's, and every unknown name, fall through
       and go to the agent as the prompts they are. */
    const found = resolveCommand(text);
    if (found) return this.runCommand(found.cmd, broadcast, found.arg);

    await this.sendText(text, broadcast);
  }
}
