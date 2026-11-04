/* Every card verb as a slash command, derived and never listed by hand.
 *
 * Lyss, 2026-11-03: *"I tried to do /renew on a card but it didn't show
 * anything … any action callable on a card should have a slash command version
 * by design with no slash commands being exceptions."* The dock's commands had
 * been a hand list beside `handle.ts`'s verb table — `/clear` and `/account`
 * were verbs because somebody wrote them in, and `renew` became a verb in 0.94
 * with no command because nobody did. CLAUDE.md's *a capability every surface
 * should have is not a prop*, one surface over.
 *
 * So the rows are made here out of `handle.ts::VERB_SLASH`, a mapped type over
 * `Verb` where each verb has a name or a reason (today none has a reason), and
 * run through the card's handle — `handle.do(verb, args)` — so a command acts
 * on a card here or on another wall exactly as the right-click does, and is
 * refused with `can()`'s reason exactly as the right-click is.
 *
 * Two kinds of row, by where their values come from — the split `/account`
 * already drew (`commands.ts`):
 *
 * - **fixed**: no argument, or a pair this file knows (`/keep wall|glass`).
 *   In `COMMANDS`, so the catalogue's claim holds — every row there can be
 *   typed, resolved and carried out with nothing else in hand.
 * - **off the wall**: the list the card's own right-click offers as a submenu
 *   — accounts, the other groupings of its project, the walls it could move
 *   to, the presets a plan can be handed to. Made per draft from `WallValues`
 *   (`wallValues`, off `CardHandle.menu()`), and absent where the menu would
 *   offer nothing, for `/account`'s reason: a row whose values are empty is a
 *   palette with nothing in it.
 *
 * The chord beside a row is `leader.ts`'s `keys` for the same verb, read off
 * `CHORDS` rather than written twice — the action palette (`search.ts`) keys on
 * that string to draw a verb once. Pure, so all of it is tested without a
 * window (`test/verbslash.test.ts`). */

import { VERBS, VERB_SLASH, type Verb, type VerbSlash } from "./handle";
import { CHORDS } from "./leader";
import type { Choice, Command } from "./commands";
import type { MenuTarget } from "./menu";

/** The lists a wall-valued verb takes, as the card's right-click offers them. */
export type WallValues = Partial<Record<Verb, readonly Choice[]>>;

type Named = Extract<VerbSlash, { slash: string }>;

/** The verbs that have a command, with what it is called. */
export const SLASHED: readonly (readonly [Verb, Named])[] = VERBS.flatMap((v) => {
  const s = VERB_SLASH[v];
  return "slash" in s ? [[v, s] as const] : [];
});

/** Every name a verb is typed as — what no extra (a skill, a project's
 *  command) may take from the palette, whether or not its row is drawn now. */
export const VERB_NAMES: ReadonlySet<string> = new Set(SLASHED.map(([, s]) => s.slash));

/** The `c` chord for a verb, as `CHORDS` spells it (`"cn"`), or undefined. */
export function chordFor(verb: Verb): string | undefined {
  return CHORDS.find((c) => c.verb.kind === "card" && c.verb.act === verb)?.keys;
}

/** Off the wall: the values come from the card, so the row may be absent. */
const fromWall = (s: Named) => !!s.takes && "wall" in s.takes;

/** At least this many values for the row to be offered. An account is a
 *  choice only between two — `accounts.ts::accountChoice`'s rule; anything
 *  else is a move, and one place to move to is a real one. */
const fewest = (v: Verb) => (v === "account" ? 2 : 1);

function rowOf(verb: Verb, s: Named, choices?: readonly Choice[]): Command {
  const chord = chordFor(verb);
  const fixed = s.takes && "fixed" in s.takes ? s.takes.fixed : undefined;
  const values = choices ?? fixed;
  return {
    name: s.slash,
    summary: s.summary,
    detail: s.detail,
    needsCard: true,
    by: "skein",
    verb,
    ...(verb === "close" ? { danger: true } : {}),
    ...(chord ? { chord } : {}),
    ...(values ? { choices: values.map((c) => ({ ...c })) } : {}),
  };
}

/** The fixed rows — every verb whose command needs nothing off the wall. */
export const VERB_COMMANDS: readonly Command[] = SLASHED.filter(([, s]) => !fromWall(s)).map(([v, s]) =>
  rowOf(v, s),
);

/** The rows whose values are the card's, present where it has enough of them. */
export function wallCommands(values: WallValues = {}): Command[] {
  const out: Command[] = [];
  for (const [v, s] of SLASHED) {
    if (!fromWall(s)) continue;
    const list = values[v] ?? [];
    if (list.length >= fewest(v)) out.push(rowOf(v, s, list));
  }
  return out;
}

/** Lowercase and spaceless, so a value can be typed and matched — a grouping
 *  is called whatever somebody typed, and `/regroup new grouping` would read
 *  as a value and a sentence. The original goes as `sends`. */
function word(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-") || "-";
}

function typable(rows: { label: string; id: string; summary?: string }[]): Choice[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    let value = word(r.label);
    for (let n = 2; seen.has(value); n++) value = `${word(r.label)}-${n}`;
    seen.add(value);
    return { value, summary: (r.summary ?? r.label).toLowerCase(), sends: r.id };
  });
}

/** What the card's right-click offers as lists, as values — so the palette and
 *  the menu cannot come to offer different things. Read with the menu's own
 *  conditions: groupings only on the wall, the presets only with a plan.
 *  `/account`'s values are the waterfall's, with their standing (`App`), and
 *  are not this function's. */
export function wallValues(t: MenuTarget | null | undefined): WallValues {
  if (!t) return {};
  const wall = t.view !== "chat";
  const has = (v: Verb) => !t.verbs || t.verbs.has(v);
  const out: WallValues = {};
  if (wall && has("regroup") && t.groupings?.length)
    out.regroup = typable(t.groupings.map((g) => ({ id: g.id, label: g.name, summary: `into ${g.name}` })));
  if (has("hand") && t.plan && t.presets?.length)
    out.hand = typable(t.presets.map((p) => ({ id: p.id, label: p.label, summary: p.note || p.label })));
  /* A card on another wall is put on one of *that* wall's accounts, which
     its menu carries; the waterfall's list here is this wall's, and the far
     wall would refuse every one of them (`handle.ts::actRefusal`). */
  if (t.host && has("account") && t.accountPicks?.length)
    out.account = typable(t.accountPicks.map((p) => ({ id: p.id, label: p.label, summary: p.on ? "where it is now" : `on ${t.host}` })));
  if (has("move") && t.walls?.length) out.move = typable(t.walls.map((h) => ({ id: h, label: h, summary: `to ${h}` })));
  return out;
}

/** The verb a command runs and the arguments the right-click's row for the
 *  same choice would carry (`handle.ts::rowVerb`), or null for a command that
 *  is not a verb. `arg` is the typed value; a wall-valued one is sent as the
 *  id its choice carries. */
export function verbOf(cmd: Command, arg: string): { verb: Verb; args: Record<string, unknown> } | null {
  const verb = cmd.verb;
  if (!verb) return null;
  const picked = cmd.choices?.find((c) => c.value.toLowerCase() === arg.toLowerCase());
  const value = picked?.sends ?? picked?.value ?? arg;
  switch (verb) {
    case "account":
      return { verb, args: { account: value } };
    case "provider":
      return { verb, args: { provider: value } };
    case "regroup":
      return { verb, args: { territory: value } };
    case "hand":
      return { verb, args: { preset: value } };
    case "move":
      return { verb, args: { host: value } };
    case "keep":
      return { verb, args: { glass: value === "glass" } };
    case "pin":
      return { verb, args: { on: false } };
    default:
      return { verb, args: {} };
  }
}

/** The verb a draft names by its command, whatever it is given — for a name
 *  whose row is not drawn now, so it can be refused with a reason rather than
 *  sent to the agent as a sentence about moving. */
export function verbNamed(draft: string): Verb | null {
  const m = /^\/([a-z0-9-]+)(?:\s|$)/i.exec(draft);
  if (!m) return null;
  const want = m[1]!.toLowerCase();
  return SLASHED.find(([, s]) => s.slash === want)?.[0] ?? null;
}

/** Does this verb's command take its values off the card (`takes.wall`)? */
export function verbTakesWall(verb: Verb): boolean {
  const s = VERB_SLASH[verb];
  return "slash" in s && fromWall(s);
}

/** Why a verb the card's handle allows still has nothing to do *now*, read off
 *  the same fields its right-click is drawn from — every gate `menu.ts::cardRows`
 *  puts on a row that `handle.ts::canDo` does not, so a command never does
 *  quietly what the menu would not have offered. Null where it may go ahead. */
export function menuRefusal(verb: Verb, t: MenuTarget): string | null {
  const chat = t.view === "chat";
  if ((verb === "glass" || verb === "keep" || verb === "pin") && chat)
    return "that is about where it stands on the wall — the wall is a space then w v away";
  if (verb === "pin" && !t.pinned) return "it is not pinned — it already flows with its grouping";
  if (verb === "bypass" && !t.accounts) return "there are no accounts here to have caps on";
  return null;
}

/** Verbs a gathering does not take at once, each for a reason it says: their
 *  answer is one thing on screen (a close plate, a clipboard, a process list,
 *  a spot on the glass), or their values are one card's. The fixed rest run
 *  per card behind the modifier, as a prompt does. */
export function oneAtATime(verb: Verb): string | null {
  switch (verb) {
    case "close":
      return "/close takes one card at a time — each asks before it goes if it is working";
    case "processes":
    case "copy-resume":
    case "copy-cwd":
    case "glass":
      return `/${(VERB_SLASH[verb] as Named).slash} takes one card at a time`;
    default:
      return verbTakesWall(verb) && verb !== "account"
        ? `/${(VERB_SLASH[verb] as Named).slash} reaches one card at a time — its values are that card's`
        : null;
  }
}

/** A toggle sent to a gathering says which side, read off the focused card,
 *  so a mixed gathering ends up one way rather than each card flipping —
 *  `aside` and `bypass` take `on`, as they do across walls. */
export function settled(verb: Verb, args: Record<string, unknown>, t: MenuTarget): Record<string, unknown> {
  if (verb === "aside") return { ...args, on: !t.aside };
  if (verb === "bypass") return { ...args, on: !t.bypassing };
  return args;
}

/** Why a draft naming a verb's command was not run: the menu's silence, said.
 *  Either the card has nothing to offer for it (no other grouping, one
 *  account), or the value typed is not one it offers. */
export function unoffered(verb: Verb, draft = "", values: WallValues = {}): string {
  const name = (VERB_SLASH[verb] as Named).slash;
  const list = values[verb] ?? [];
  const arg = draft.replace(/^\/\S+\s*/, "").trim();
  if (list.length >= fewest(verb)) {
    const offers = list.map((c) => c.value).join(", ");
    return arg
      ? `/${name} takes one of ${offers} — not "${arg}"`
      : `/${name} takes one of ${offers}`;
  }
  switch (verb) {
    case "account":
      return "there is only one account it could be on — nothing to choose";
    case "regroup":
      return "its project has no other grouping to move it to";
    case "hand":
      return "it has no plan to hand on";
    case "move":
      return "no other machine heard from lately holds its project and takes work";
    default:
      return `/${name} does not take "${arg}"`;
  }
}
