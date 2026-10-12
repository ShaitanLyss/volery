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
