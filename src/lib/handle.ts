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

export type Verb =
  | "glass"
  | "close"
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
 *  - `person`: a person's close, which the other wall allows whatever its
 *    switch says.
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
      case "person":
        // `Elsewhere.close` refuses an unheard wall itself and says why, so
        // the row stays and the refusal is the answer.
        if (remote.closes || !remote.unheard) out.add(v);
        break;
      case "local":
        break;
      default:
        if (!remote.unheard && remote.acts.has(v)) out.add(v);
    }
  }
  return out;
}

/** The verbs that cross as an `act` (`flyway/act.rs`): every one whose cost
 *  reaches the other machine and is not a person's close, which has its own
 *  road. `test/handle.test.ts` holds this against `act.rs`'s `VERBS`. */
export const ACTS: readonly Verb[] = VERBS.filter((v) => ["work", "cosmetic", "read"].includes(COST[v]));

/** What a shadow's face says, as far as an act's arguments need it. */
export type ActFace = { aside: boolean; bypassCaps: boolean; working: boolean };

/** A menu row on a card elsewhere, as the verb and arguments its wall is
 *  asked — or null for a row that is not an act. A setting crosses as the
 *  state wanted, never as a toggle, so a gesture made against a face one
 *  snapshot old cannot flip it the wrong way; a clear says whether the card
 *  was working when it was chosen, so the owner can refuse one that has
 *  *started* a turn since. */
export function actFor(id: string, face: ActFace): { verb: Verb; args: Record<string, unknown> } | null {
  if (id.startsWith("account:")) return { verb: "account", args: { account: id.slice(8) } };
  switch (id) {
    case "aside":
      return { verb: "aside", args: { on: !face.aside } };
    case "bypass":
      return { verb: "bypass", args: { on: !face.bypassCaps } };
    case "clear":
      return { verb: "clear", args: { sawWorking: face.working } };
    case "wake":
    case "copy-resume":
    case "copy-cwd":
      return { verb: id, args: {} };
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
  if (verb === "clear" && card.working && args.sawWorking !== true)
    return `it has started a turn on ${me} since you chose that — look at it before clearing it`;
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
  switch (COST[verb]) {
    case "local":
      return `that is on ${remote.host}`;
    case "work":
    case "cosmetic":
    case "read":
      return remote.unheard
        ? `${remote.host} has not been heard from`
        : `${remote.host} needs updating to do that from here`;
    default:
      return `not available on ${remote.host}`;
  }
}
