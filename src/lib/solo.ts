import { REGION_GAP, regionWidth } from "./layout";

/* Flying solo, said in words. The design is `.claude/rules/solo.md`; this is
 * what the plate in the empty strip, the flyway panel's section and a peer's
 * roster row say about it.
 *
 * Pure, so every sentence is a thing a test can read rather than something you
 * open the app to find out — `flyway.ts`'s bargain. Nothing here decides
 * whether the shutter is down: that is one setting in Rust (`here::SOLO`), read
 * by every door at the moment it is asked. These are the readings of it.
 *
 * **The word is kept to the surface.** "The books" and "the traffic" are how the
 * rule reasons about two fabrics; a person is told which of their own things
 * still work. */

/** The two sentences that carry the whole idea, one for each surface. The
 *  plate is read standing next to the empty strip, so it leads with what the
 *  person keeps; the panel has the room to name both halves. */
export const PLATE_SAYS =
  "Your accounts, allowance and usage still sync. No cards, questions, notices or screens cross.";

export const PANEL_SAYS =
  "accounts, allowance, usage and analytics stay; cards, questions, notices, screens, boards and sinks do not cross";

/** The button that puts the shutter down, and the one that lifts it. */
export function soloButton(on: boolean): string {
  return on ? "fly with the others" : "fly solo";
}

/** The chord, as a panel says one — the house form `"… (space then i s)"`, with
 *  the words a person reads rather than the glyphs. */
export const SOLO_CHORD = "space then i s";

/** A moment as somebody standing at the plate would say it: `friday 18:04`
 *  within the last week, and a date beyond it, since "solo since friday" three
 *  Mondays later is a sentence that has stopped meaning anything. Local time,
 *  because that is the clock the person is reading. */
export function whenStarted(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const at = `${hh}:${mm}`;
  const week = 7 * 24 * 60 * 60 * 1000;
  if (now - ms < week) return `${days[d.getDay()]} ${at}`;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  return `${d.getDate()} ${months[d.getMonth()]} ${at}`;
}

/** `solo since friday 18:04`, or nothing at all when it is not — a line that
 *  says "not solo" belongs nowhere, since the absence of the plate says it. */
export function soloSince(since: number | null, now = Date.now()): string {
  if (since === null || since <= 0) return "";
  /* A start in the future is a clock that moved, not a wall that started
     tomorrow: read it as now rather than drawing a time nobody will reach. */
  return `solo since ${whenStarted(Math.min(since, now), now)}`;
}

/** What a peer's roster row says about it. A solo wall is heard and its numbers
 *  still arrive, so this replaces the ordinary load line rather than prefixing
 *  it — its territories are withheld and "0 of 0 working · no territories" would
 *  be a wall that is closed, which it is not. */
export const SOLO_ROSTER_LINE = "solo — flying alone; its accounts and spend still report";

/** How many cards on this wall were opened by another wall and keep running.
 *  Flying solo stops traffic, not work: a card is a conversation somebody may
 *  still want, and leaving the flyway has always left those alone. The plate
 *  says the number so the choice is visible rather than silent. */
export function openedHere(born: readonly (string | null | undefined)[]): number {
  return born.filter((h) => !!h).length;
}

/** The plate's one extra line, or nothing when no card here came from anywhere
 *  else. Singular and plural are spelled out: `1 cards` is the tell that a
 *  sentence was assembled rather than written. */
export function openedElsewhere(n: number): string {
  if (n <= 0) return "";
  if (n === 1) return "1 card here was opened from another wall and keeps running.";
  return `${n} cards here were opened from another wall and keep running.`;
}

/** The panel's line while solo, about the *work from other walls* switch: the
 *  switch's stored value is kept for the return, but the shutter is the larger
 *  boundary and wins while it is down. */
export const ACCEPTING_IS_CLOSED = "closed anyway while flying solo — the shutter is the larger boundary";

/** What the chrome mark says about the state it wears. The label is `solo`; this
 *  is the title, where the rest is spelled out. */
export function chromeTitle(on: boolean): string {
  return on
    ? "flying solo — your accounts, allowance and usage still sync; cards, questions, notices and screens do not cross (space then i s)"
    : "the flyway (space then k)";
}

/** Where the plate stands while solo: the head of the left strip the other
 *  walls' sections would occupy, one column wide.
 *
 *  **The same arithmetic `shadow.ts::standElsewhere` places a section with**,
 *  because it is the same strip — the wall's left margin, which is the edge
 *  that stays put as territories flow rightward. `beside` is everything already
 *  standing on this wall; `cols` is `ELSEWHERE_COLS`, passed rather than
 *  imported so this file stays a reading of the rule rather than a second copy
 *  of the layout's constants.
 *
 *  **A wall with nothing on it puts the plate at the origin.** With no
 *  neighbours the formula would place it a strip-width left of nothing, which
 *  is off the wall entirely — and an empty wall has no sections to be absent
 *  from, so there is no strip to stand in. */
export function plateSpot(
  beside: readonly { x: number; y: number }[],
  cols: number,
  gap = REGION_GAP,
): { x: number; y: number; w: number } {
  const w = regionWidth(1);
  if (!beside.length) return { x: 0, y: 0, w };
  return {
    x: Math.min(...beside.map((b) => b.x)) - regionWidth(cols) - gap * 2,
    y: Math.min(...beside.map((b) => b.y)),
    w,
  };
}
