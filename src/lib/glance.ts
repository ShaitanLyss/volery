/* A glance: the last thing a card said, read beside whatever you are doing
 * rather than instead of it.
 *
 * The notice already had the reading Lyss liked — the closing message as the
 * transcript renders it, in a scroller with a ceiling (`Said.svelte`). A glance
 * is that same reader opened on demand: from a question in the dock, so what
 * prompted the question can be read without leaving it, and from a card, so a
 * card can be read without moving the ring off the one you are working with.
 *
 * Pure, tested in `test/glance.test.ts`. Nothing here knows a component
 * exists. See `.claude/rules/notice.md`, "The reader is one component". */

type Said = readonly { kind: string; text: string }[];

/** What a glance reads off a card face — `CardFace` structurally, so this file
 *  imports nothing. `lastWords` is optional because a card on another wall has
 *  no such field: its digest carries one line, and its tail carries the rest.
 *
 *  `history` is the scrollback read off disk, which a card restored at launch
 *  holds *instead* of lines: `--resume` replays nothing, so `lines` stays empty
 *  until it speaks again (`Skein.loadHistory`). A card on another wall has
 *  none, since its tail is already its lines. */
export type Sayer = {
  readonly lines: Said;
  readonly history?: Said;
  readonly lastWords?: string;
  readonly working: boolean;
};

const lastText = (ls: Said): number => {
  let i = ls.length - 1;
  while (i >= 0 && ls[i]!.kind !== "text") i--;
  return i;
};

/** Whether there is anything to read — what decides that the button is drawn
 *  at all, so it is scanned from the end and stops at the first line said.
 *  A card face asks this on every change of its lines, which is why it does not
 *  build the message to find out whether there is one. */
export function hasSaid(s: Pick<Sayer, "lines" | "history">): boolean {
  return lastText(s.lines) >= 0 || lastText(s.history ?? []) >= 0;
}

/** The last thing the card said.
 *
 *  **At rest, it is exactly the notice's text** — `Conversation.lastWords`, the
 *  closing message fixed when the turn ended, which is what a notice about
 *  that rest showed. A glance at a card that has a notice up and the notice
 *  itself must not disagree about what the card said.
 *
 *  **Otherwise it is read off the lines**: the last run of prose, back to the
 *  tool call or prompt before it. That is the case while a turn runs (and
 *  `lastWords` is the *previous* turn's), the case of a question parked
 *  mid-turn — the prose just before the `ask_user` call, which is what the
 *  question is about — and the case of a card restored off disk, which has
 *  its scrollback (`history`) and no closing message, since `lastWords` is
 *  only ever set by a `result` this process heard.
 *
 *  `lastWords` only counts while the lines still hold prose: a cleared card has
 *  no lines and keeps the field, and a glance at it would otherwise show a
 *  conversation that `/clear` had ended. */
export function lastMessage(s: Sayer): string {
  if (!hasSaid(s)) return "";
  const closed = s.working ? "" : (s.lastWords ?? "").trim();
  if (closed) return closed;
  const ls = lastText(s.lines) >= 0 ? s.lines : (s.history ?? []);
  const end = lastText(ls);
  let start = end;
  while (start > 0 && ls[start - 1]!.kind === "text") start--;
  return ls
    .slice(start, end + 1)
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export type Box = { left: number; top: number; width: number; height: number };

/** Room kept between the glance and the window's edge, and between it and the
 *  thing it was opened from. */
export const GLANCE_GAP = 8;

/** Where a glance of `size` stands beside `anchor`, in a window `view` big.
 *
 *  Below the anchor where it fits, above where that fits instead, and otherwise
 *  on whichever side has more room — then clamped into the window, because a
 *  reading half off-screen is a reading you cannot finish. Below first, since a
 *  card's glance then reads downward from the card like its transcript does;
 *  the dock sits at the foot of the window, so its glance falls through to
 *  above without either surface having to say where it is.
 *
 *  Left-aligned with the anchor, so it reads as coming *from* it. An anchor
 *  that is nowhere on screen — the focused card panned out of view — gets the
 *  middle of the window rather than a glance clamped against an edge, pointing
 *  at nothing. */
export function placeGlance(
  anchor: Box | null,
  size: { width: number; height: number },
  view: { width: number; height: number },
  gap = GLANCE_GAP,
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const visible =
    anchor !== null &&
    anchor.left < view.width &&
    anchor.top < view.height &&
    anchor.left + anchor.width > 0 &&
    anchor.top + anchor.height > 0;
  if (!visible) {
    return {
      left: clamp((view.width - size.width) / 2, gap, view.width - size.width - gap),
      top: clamp((view.height - size.height) / 2, gap, view.height - size.height - gap),
    };
  }
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= view.height - gap;
  const fitsAbove = above >= gap;
  const roomBelow = view.height - below;
  const roomAbove = anchor.top - gap;
  const top = fitsBelow ? below : fitsAbove ? above : roomBelow >= roomAbove ? below : above;
  return {
    left: clamp(anchor.left, gap, view.width - size.width - gap),
    top: clamp(top, gap, view.height - size.height - gap),
  };
}
