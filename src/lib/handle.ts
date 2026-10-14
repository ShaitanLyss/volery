/* What a gesture may do to a card, local or on another wall — decided away
 * from the DOM and away from either kind of card.
 *
 * The menu, the dock and the keyboard used to learn what a shadow could do by
 * each growing a branch for it, which is how a shadow came to offer two rows
 * where a card offers fifteen. This is the one table they read instead. A verb
 * is what a person asks of a card; a *cost* is what it would do to the machine
 * the card runs on, and gating follows cost rather than the verb, so the next
 * verb is one line here and inherits the right refusal.
 *
 * Design and reasons: `.claude/rules/elsewhere.md`, "one card handle". Pure,
 * so every row of the table is tested without a window. */

import { CARRY_MOST, carriedCost, looksLike, type Turn } from "./attach";

export type Verb =
  | "glass"
  | "close"
  | "stop"
  | "wake"
  | "aside"
  | "bypass"
  | "account"
  | "clear"
  | "copy-resume"
  | "copy-cwd"
  | "processes"
  | "pin"
  | "regroup"
  | "hand"
  | "move";

/** What a verb does to the card's machine.
 *  - `work`: starts a process, or spends an account — held to the other wall's
 *    "take work from other walls" switch, and never queued for a wall that is
 *    quiet, because a card runs with the machine in its hands and a lid
 *    lifting hours later must not deliver something you have changed your
 *    mind about.
 *  - `person`: a person's, which the other wall allows whatever its switch
 *    says — closing a card and stopping its turn. Both only ever stop work,
 *    and neither can hurt the machine it is stopped on.
 *  - `cosmetic`: changes how the card is kept, nothing it does.
 *  - `read`: the owner answers with text.
 *  - `here`: about *this* wall's own furniture; the other machine is not asked.
 *  - `local`: only means something on the machine the card runs on. */
export type Cost = "work" | "person" | "cosmetic" | "read" | "here" | "local";

export const COST: Record<Verb, Cost> = {
  glass: "here",
  // Where a card stands on *this* wall and what it is handed to are this
  // wall's business until a remote card has a row here — see elsewhere.md.
  pin: "local",
  regroup: "local",
  hand: "local",
  // Its own exchange (`flyway/moving.rs`), not an `act`.
  move: "local",
  processes: "local",
  close: "person",
  /* A turn ended, as Escape ends one here: the context survives and the next
     thing can be said at once. It starts nothing and spends nothing, so it is
     a person's, as the close is — and it crosses as an `act`, where the close
     has a road of its own. */
  stop: "person",
  wake: "work",
  clear: "work",
  // An account is spent where the card runs: the owner's money, the owner's caps.
  account: "work",
  bypass: "work",
  aside: "cosmetic",
  "copy-resume": "read",
  "copy-cwd": "read",
};

export const VERBS = Object.keys(COST) as Verb[];

/** The wall a card is on, when it is not this one. */
export type Remote = {
  host: string;
  /** Not heard from past the fleet's quiet age: nothing is offered that
   *  would have to reach it. */
  unheard: boolean;
  /** The `act:<verb>` words its `Facts::can` announced, without the prefix. A
   *  wall from before a verb existed does not announce it, and the verb is
   *  then not offered — a row that is always refused reads as broken. */
  acts: ReadonlySet<string>;
  /** Whether that wall announced `close_by_person`. */
  closes: boolean;
  /** Whether that wall announced `pictures` — that a person's prompt to one
   *  of its cards may carry them (`fleet::CAN_PICTURES`). Absent is no. */
  pictures?: boolean;
};

/** The verbs on offer for a card. `null` for a card on this wall means all of
 *  them, which is the answer a local card's menu has always had. */
export function verbsFor(remote: Remote | null): ReadonlySet<Verb> | null {
  if (!remote) return null;
  const out = new Set<Verb>();
  for (const v of VERBS) {
    switch (COST[v]) {
      case "here":
        out.add(v);
        break;
      case "local":
        break;
      default:
        // The close has a road of its own (`close_by_person`), and
        // `Elsewhere.close` refuses an unheard wall itself and says why, so
        // the row stays and the refusal is the answer.
        if (v === "close") {
          if (remote.closes || !remote.unheard) out.add(v);
        } else if (!remote.unheard && remote.acts.has(v)) out.add(v);
    }
  }
  return out;
}

/** The verbs that cross as an `act` (`flyway/act.rs`): every one whose cost
 *  reaches the other machine, less the close, which has its own road.
 *  `test/handle.test.ts` holds this against `act.rs`'s `VERBS`. */
export const ACTS: readonly Verb[] = VERBS.filter((v) => v !== "close" && COST[v] !== "here" && COST[v] !== "local");

/** Whether a verb may be done to a card: `"yes"`, or why not in words — which
 *  is what a person acts on, so a verb a card cannot do is said rather than
 *  hidden. The shape every surface asks (`cards.svelte.ts`). */
export type Can = "yes" | { no: string };

/** Whether this turn can reach a card on another wall, asked before the draft
 *  is cleared so a refusal keeps what was typed.
 *
 *  A picture travels (`attach.md`): what a card here can be shown, a card
 *  there can be, by construction — the far wall attaches it exactly as a paste
 *  in its own dock. So what is refused is only what cannot honestly arrive,
 *  each said in a sentence:
 *
 *  - a wall drawn as unheard, which would refuse it — and clearing the draft
 *    into a line nobody is looking at would be the send looking like it went;
 *  - pictures to a wall from before they could travel, which would take the
 *    words and not the pictures — the sentence arriving without the thing it
 *    is about;
 *  - a prompt past `CARRY_MOST`, which no frame between two walls can hold.
 *    Never cut down to fit: a picture dropped to make room is the second case
 *    again;
 *  - a picture whose bytes are not the type it says, which the far wall's
 *    check (`attach::carried_fit`) would refuse after the draft had gone. */
export function carriesTo(remote: Remote, turn: Turn): Can {
  if (remote.unheard) return { no: `${remote.host} has not been heard from — a prompt would be refused` };
  if (!turn.carried.length) return "yes";
  if (!remote.pictures) {
    return {
      no: `${remote.host} runs a Volery from before pictures could be sent to its cards — send the words alone, or update it there`,
    };
  }
  const odd = turn.carried.find((c) => !looksLike(c));
  if (odd) return { no: `${odd.name} is not the ${odd.mediaType} it says it is — save it as what it is and attach it again` };
  const cost = carriedCost(turn);
  if (cost > CARRY_MOST) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    return {
      no: `this prompt comes to ${mb(cost)} MB and at most ${CARRY_MOST / (1024 * 1024)} MB goes to ${remote.host} at once — send fewer pictures, or smaller ones`,
    };
  }
  return "yes";
}

/** The reason, or null where it may. */
export const whyNot = (c: Can): string | null => (c === "yes" ? null : c.no);

/** What a card's face says, as far as whether a verb has anything to act on.
 *  The same for a card here and one elsewhere: a dormant card has no turn to
 *  stop, wherever it is. */
export type VerbFace = { dormant: boolean; working: boolean; spoken: boolean };

/** Whether `verb` may be asked of a card that looks like `face`, standing
 *  where `remote` says. Where it stands is asked first, since a reason about
 *  the wall is the one that explains the rest. */
export function canDo(remote: Remote | null, verb: Verb, face: VerbFace): Can {
  const far = refusal(remote, verb);
  if (far) return { no: far };
  switch (verb) {
    case "wake":
      return face.dormant ? "yes" : { no: "it is not dormant" };
    case "stop":
      return face.working ? "yes" : { no: "it is not working" };
    /* Something to clear means a turn taken or one under way — not a line on
       screen, which a cleared card still has. See the menu's own note. */
    case "clear":
      return face.spoken || face.working ? "yes" : { no: "nothing to clear yet" };
    case "processes":
      return face.dormant ? { no: "it is dormant, so it holds no processes" } : "yes";
    default:
      return "yes";
  }
}

/** A row of the card's right-click, as the verb it asks and that verb's
 *  arguments — the same words for a card here and one elsewhere, so the menu
 *  and the keys dispatch one way. Null for a row that is not a card's verb. */
export function rowVerb(id: string): { verb: Verb; args: Record<string, unknown> } | null {
  const after = (p: string) => id.slice(p.length);
  if (id.startsWith("hand:")) return { verb: "hand", args: { preset: after("hand:") } };
  if (id.startsWith("regroup:")) return { verb: "regroup", args: { territory: after("regroup:") } };
  if (id.startsWith("move:")) return { verb: "move", args: { host: after("move:") } };
  if (id.startsWith("account:")) return { verb: "account", args: { account: after("account:") } };
  if (id === "unpin") return { verb: "pin", args: { on: false } };
  return (VERBS as readonly string[]).includes(id) ? { verb: id as Verb, args: {} } : null;
}

/** What a shadow's face says, as far as an act's arguments need it. */
export type ActFace = { aside: boolean; bypassCaps: boolean; working: boolean };

/** A verb asked of a card elsewhere, as the arguments its wall is sent — or
 *  null for a verb that is not an act. A setting crosses as the state wanted,
 *  never as a toggle, so a gesture made against a face one snapshot old
 *  cannot flip it the wrong way; a clear says whether the card was working
 *  when it was chosen, so the owner can refuse one that has *started* a turn
 *  since. `args` is what the gesture said (`rowVerb`'s), and a toggle it left
 *  unsaid is read off the face. */
export function actFor(
  verb: Verb,
  args: Record<string, unknown>,
  face: ActFace,
): { verb: Verb; args: Record<string, unknown> } | null {
  const on = (now: boolean) => (typeof args.on === "boolean" ? args.on : !now);
  switch (verb) {
    case "aside":
      return { verb, args: { on: on(face.aside) } };
    case "bypass":
      return { verb, args: { on: on(face.bypassCaps) } };
    /* Moving a card to another account ends its process, as a clear does, so
       it carries what the face said too. */
    case "account":
      return { verb, args: { account: String(args.account ?? ""), sawWorking: face.working } };
    case "clear":
      return { verb, args: { sawWorking: face.working } };
    case "wake":
    case "stop":
    case "copy-resume":
    case "copy-cwd":
      return { verb, args: {} };
    default:
      return null;
  }
}

/** What the owning wall checks again at the moment of acting, as
 *  `settle_delete` re-runs its refusals: the card as it is now, not as the
 *  asker drew it. Null if it may go ahead. `accounts` is the labels this wall
 *  can put a card on. */
export function actRefusal(
  verb: string,
  args: Record<string, unknown>,
  card: { working: boolean },
  accounts: readonly string[],
  me: string,
): string | null {
  if (!(ACTS as readonly string[]).includes(verb)) return `${me} does not know how to ${verb} a card from another wall`;
  /* Both end the card's process: a turn it has started since the asker chose
     this is a turn the asker never saw, and is not theirs to kill. */
  if ((verb === "clear" || verb === "account") && card.working && args.sawWorking !== true)
    return `it has started a turn on ${me} since you chose that — look at it before asking again`;
  if (verb === "account") {
    const label = typeof args.account === "string" ? args.account : "";
    if (!accounts.includes(label)) return `there is no account called ${label || "that"} on ${me} that can take work`;
  }
  return null;
}

/** Why a verb is not available on a card on another wall, in words, or null
 *  if it is. For a surface that wants to say so — a key with nothing behind
 *  it — rather than do nothing. */
export function refusal(remote: Remote | null, verb: Verb): string | null {
  if (!remote) return null;
  if (verbsFor(remote)!.has(verb)) return null;
  if (COST[verb] === "local") return `that is on ${remote.host}`;
  return remote.unheard
    ? `${remote.host} has not been heard from`
    : `${remote.host} needs updating to do that from here`;
}

/* ── what the dock and the panel say about a card ───────────────────────── */

/** One clause beside a card's name in the dock, or one line above its
 *  conversation in the panel. `warn` is drawn as something going wrong and
 *  `ask` as something waiting on you — the two hues status is allowed. */
export type Said = { text: string; tone?: "warn" | "ask" };

/** What the dock says beside the card it is aimed at: what sending will do to
 *  it, said before you find out. For a card elsewhere where the words go comes
 *  first — the card already says *where*, and this is the one place that says
 *  what can travel. */
export function dockHints(
  c: { dormant: boolean; aside: boolean; interrupted?: boolean },
  remote: Remote | null,
): Said[] {
  const out: Said[] = [];
  if (remote)
    out.push(
      remote.unheard
        ? { text: `on ${remote.host}, not heard from — a prompt would be refused`, tone: "warn" }
        : { text: remote.pictures ? `on ${remote.host} — sent there` : `on ${remote.host} — words only, sent there` },
    );
  /* "when you type" and not "on send" here: `Skein.stir` starts the spawn on
     the first character. No touch travels, so a card elsewhere wakes when the
     words arrive — said so, rather than promising a head start it will not
     get. Not said of a quiet wall, where the line above already refuses. */
  if (c.dormant && !remote?.unheard)
    out.push({ text: remote ? "dormant — wakes when your words arrive" : "dormant — wakes when you type" });
  /* Said here as well as on the card, because this is the one place where it
     is about to stop being true: a prompt picks the card back up, and a card
     quietly rejoining the waiting cycle is worth one clause of warning. */
  if (c.aside) out.push({ text: "set aside — sending picks it back up" });
  if (c.interrupted) out.push({ text: "last turn was interrupted", tone: "warn" });
  return out;
}

/** What a card elsewhere's panel says above its conversation — what this wall
 *  honestly knows that the conversation cannot say for itself: how far back
 *  it goes, a read that failed, an ask of its wall in flight or refused, and
 *  a question it is parked on. Pure, out of what was `Yonder.svelte`'s markup,
 *  so the panel is one component for both kinds of card. */
export function panelNotes(s: {
  host: string;
  unheard: boolean;
  tailState: string;
  tailWhy: string | null;
  closing: { state: "asked" | "taken" | "refused"; why?: string } | null;
  acting: { verb: string; state: "asked" | "taken" | "refused"; why?: string } | null;
  open: number;
  sheets: number;
}): Said[] {
  const h = s.host;
  const out: Said[] = [
    /* The edges of what is here: how far back it goes, and that a prompt of
       yours is marked until the far wall says it has it. */
    {
      text: `the last of this card's conversation, read from ${h} — older rounds stay there. what you send it is marked until ${h} says it has it.`,
    },
  ];
  /* A refresh that fails keeps what was read, which is right — and was silent,
     so a column that had stopped gaining lines looked exactly like a card that
     had stopped saying anything. */
  if (s.tailState === "error" && s.tailWhy) out.push({ text: `could not read its conversation — ${s.tailWhy}` });
  else if (s.tailWhy)
    out.push({
      text: `this is the conversation as it stood at the last read that worked — the latest read failed: ${s.tailWhy}`,
    });
  /* A close asked of its wall stays drawn until that wall's next snapshot
     drops the card, so what has become of the ask is said where it is. */
  if (s.closing) {
    const c = s.closing;
    out.push(
      c.state === "asked"
        ? { text: `asking ${h} to close it…` }
        : c.state === "taken"
          ? { text: `${h} is closing it — it goes when ${h} next reports` }
          : { text: `${h} did not close it — ${c.why ?? "it refused"}`, tone: "warn" },
    );
  }
  /* A verb asked of its wall, in the closing's own wording. A taken one is not
     said: the face changes when its wall next reports, which is the
     confirmation. */
  if (s.acting && s.acting.state !== "taken") {
    const verb = s.acting.verb.replace("-", " ");
    out.push(
      s.acting.state === "asked"
        ? { text: `asking ${h} to ${verb}…` }
        : { text: `${h} did not ${verb} — ${s.acting.why ?? "it refused"}`, tone: "warn" },
    );
  }
  /* Whether it is stopped on you. Answered in the dock, where a question on
     this wall is. A wall gone quiet takes the offer away and says why: the
     question may have been answered there, or run out of time, and an
     unconfirmed question must not look like one still waiting. */
  if (s.open)
    out.push({
      text: `parked on ${s.open === 1 ? "a question" : `${s.open} questions`} for you — answer ${s.open === 1 ? "it" : "them"} in the dock, and it goes back to ${h}`,
      tone: "ask",
    });
  else if (s.sheets && s.unheard)
    out.push({
      text: `it was asking you something when ${h} went quiet — it may have been answered there, or have run out of time, so it cannot be answered from here until ${h} is heard again`,
    });
  return out;
}
