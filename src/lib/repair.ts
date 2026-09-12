/** Repairing a conversation a tool call made unsendable.
 *
 *  The doing of it is `src-tauri/src/repair/`, which owns the file; this is the
 *  part with an opinion — when to reach for a repair, what the card says about
 *  one, and how long the untouched original is kept.
 *
 *  Why it exists at all: a tool that reads a binary as text puts characters
 *  into the transcript that the API will not take, and the whole conversation
 *  goes back over the wire every turn — so one bad tool result breaks every
 *  request after it, permanently. `HEAL_BUDGET` in `classify.ts` was written
 *  for a truncation that clears on its own, and against this it spends two
 *  whole conversations on retries that cannot work. Found 2026-08-19; see the
 *  module doc in `repair/mod.rs` for the session it was found in.
 */

/** What the repair took out. Mirrors `RepairReport` in `repair/text.rs`; the
 *  snake_case is the wire shape, since Rust serialises its own field names. */
export type RepairReport = {
  /** Records that carried contamination. */
  records: number;
  /** Characters removed from the conversation. */
  chars_removed: number;
  /** NUL and other C0 control characters found. */
  nuls: number;
  /** Characters the CLI had already stood in for when it captured them. */
  undecodable: number;
  /** The tool calls whose output carried it, and the file each names. */
  culprits: Culprit[];
  /** Where the untouched original is kept. */
  backup: string;
};

/** One tool call that put the characters there. Mirrors `Culprit` in
 *  `repair/text.rs`. */
export type Culprit = {
  /** The tool — `Bash`, `Read`, `Grep`. */
  tool: string;
  /** What it was asked to do, short enough to say on a card. */
  command: string;
  /** The file it names, where one could be had. */
  path: string | null;
  /** Whether `path` was handed to Skein or read out of a shell line. */
  declared: boolean;
};

/** How many turns must go well before the kept original is thrown away.
 *
 *  Not zero, which is the tempting number. A repair that broke the session does
 *  not announce itself — it shows up as the *next* turn failing, and by then
 *  the only copy of what the conversation used to be would be gone. Two turns
 *  of an agent working normally is the evidence that the repair was right, and
 *  it is cheap: the backup is one file beside one session.
 *
 *  Two rather than one because the turn immediately after a repair is the one
 *  most likely to be short — an agent reading the note and saying "understood"
 *  is not proof that the conversation still holds together. */
export const REPAIR_SETTLE_TURNS = 2;

/** Is this failure one a repair could even address?
 *
 *  Only the truncated body. An overload is somebody else's weather and there is
 *  nothing in this conversation to mend; running a repair on one would rewrite
 *  a session to fix a queue somewhere else. */
export function repairWorthTrying(kind: string | null): boolean {
  return kind === "malformed";
}

/** A count, for prose rather than for a field. */
function count(n: number): string {
  return n.toLocaleString("en-GB");
}

/** A command short enough to sit on a card, with the part that identifies it.
 *
 *  Cut from the front — but not before dropping the navigation, and that
 *  qualifier is the whole of what this function knows. The first version took
 *  sixty characters off the front on the reasoning that the front of a shell
 *  line says which command it is, and against the real case it produced
 *  ``Bash cd /c/Users/lyss.delprat/.local/bin && echo "=== oauth…`` — sixty
 *  characters that name a directory and not one that names the command which
 *  broke the conversation. `cd … &&` is preamble; a reader identifying a tool
 *  call needs the verb. */
export function sayCommand(command: string, max = 100): string {
  const flat = command
    .replace(/\s+/g, " ")
    /* Anywhere, not only at the start: the tool's own name comes first, so the
       navigation is usually the second word rather than the first. */
    .replace(/(^|\s)cd\s+\S+\s*&&\s*/g, "$1")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** What the transcript says when a repair has happened.
 *
 *  Lowercase and quiet like the rest of the wall, and specific on purpose: this
 *  is Skein having rewritten a file belonging to another program, on its own
 *  initiative, and the one thing it owes for that is an account precise enough
 *  to check. The count, the tool call, and where the original went. */
export function sayRepair(report: RepairReport): string {
  const bits: string[] = [];
  if (report.nuls > 0) bits.push(`${count(report.nuls)} nul characters`);
  if (report.undecodable > 0) bits.push(`${count(report.undecodable)} undecodable`);
  const what = bits.length ? bits.join(" and ") : `${count(report.chars_removed)} characters`;
  const where =
    report.records === 1 ? "one tool result" : `${count(report.records)} tool results`;
  const first = report.culprits[0];
  const from = first ? ` from \`${sayCommand(first.command)}\`` : "";
  return `repaired — took ${what} out of ${where}${from}; ${sayWhereTheyStillAre(report)}`;
}

/** The clause that stops this happening again tomorrow.
 *
 *  The old line ended *"the conversation could not be sent while they were in
 *  it"*, which is true and is the less useful half. A repair takes the
 *  characters out of the **conversation** and deliberately does not go near the
 *  file — rewriting another program's transcript is already the most invasive
 *  thing in this app that is not a spawn — so when the bytes came from a source
 *  file, the file still has them and the next read is the same death. Two cards
 *  burned five turns on that loop on 2026-09-11 and neither was ever told which
 *  file to stop reading (sink `08de8ed3`).
 *
 *  So the card says where they still are when it can, and what it did when it
 *  cannot. The hedge on an undeclared path is not politeness: a notice that
 *  names the wrong file sends the next card to clean something that was never
 *  dirty, which is worse than naming none. */
export function sayWhereTheyStillAre(report: RepairReport): string {
  const first = report.culprits[0];
  const path = first?.path;
  if (!path) return "the conversation could not be sent while they were in it";
  return first.declared
    ? `they are still in ${path}, which this did not touch`
    : `they are probably still in ${path} — that is read out of the command, so check it — and this did not touch it`;
}

/** The file Skein would put its name to, or nothing.
 *
 *  Only a path the tool was *handed* — `Read`'s `file_path`, not a word picked
 *  out of a shell line. This is the gate for anything that acts on a repair
 *  rather than merely reporting one: warning the wall about a poisoned file in
 *  a shared tree is exactly what the billboard is for, and the card that finds
 *  it is by construction the card that just died, so Skein is the only thing
 *  left that can post. But a wall-level notice is read by every card in the
 *  tree and acted on without checking, so it gets the certain tier and nothing
 *  else. See `.claude/rules/repair.md`. */
export function poisonedPath(report: RepairReport): string | null {
  return report.culprits.find((c) => c.declared && c.path)?.path ?? null;
}

/** And what it says when Skein looked and the conversation was clean.
 *
 *  Said only once per turn, and worth saying: the whole complaint against the
 *  old give-up line was that it named a cause nobody had checked. Having
 *  checked is a different claim and the card is allowed to make it. */
export function sayNothingToRepair(): string {
  return "nothing corrupt in this conversation — so the break was on the wire, not in it";
}

/** Whether enough has gone right since a repair to stop keeping the original. */
export function backupSettled(goodTurnsSince: number): boolean {
  return goodTurnsSince >= REPAIR_SETTLE_TURNS;
}
