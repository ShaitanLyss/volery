/* A widget that is a view of one card, and goes when the card does.
 *
 * Everything else hung on the wall is furniture: it belongs to no project, and
 * it stays up until you take it down. A card's last message pinned to the wall
 * is the first thing that is *about* something standing there — so it carries
 * the card it reads (`TETHER` in its config) and it has a lifecycle the others
 * do not: it is taken down, with no undo record, by the same gesture that takes
 * its card off the wall. You destroyed nothing by closing a card's view of
 * itself; the card was the thing, and it is gone.
 *
 * Pure, tested in `test/tether.test.ts`. The catalogue entry is `widgets.ts`'s
 * `said`; the removal is `Widgets.untether` and `Widgets.keepHost`; the face is
 * `Saying.svelte`. See `.claude/rules/widgets.md`, "A card's last message, kept
 * on the wall". */

import { isShadowKey } from "./shadow";

/** The config key a tethered widget's card id rides in — a conversation id for
 *  a card here, a `shadowKey` for one on another wall. In the config rather
 *  than a column for `config_json`'s reason: Rust never hears about a kind of
 *  widget, and the removal is the front end's, on the path that removes the
 *  card (see the head of this file). */
export const TETHER = "card";

/** What a tethered widget reads from: a card here, or a card on another wall.
 *  Shaped like a widget rather than importing one, so this file stays below
 *  the catalogue. */
type Held = { id: string; config: Record<string, unknown> };

/** The card this widget is a view of, or null for one that is not tethered —
 *  or tethered to nothing, which `normalizeWidget` refuses to draw. */
export function tetherOf(w: Pick<Held, "config">): string | null {
  const v = w.config[TETHER];
  return typeof v === "string" && v ? v : null;
}

/** The wall a tethered card runs on, when it is not this one — what a pin says
 *  while that wall has not been heard from and there is no card to draw yet.
 *  A card id is a uuid and never holds a colon, so the host is everything
 *  between the prefix and the last one, colons in a host name included. */
export function tetherHost(card: string): string | null {
  if (!isShadowKey(card)) return null;
  const rest = card.slice("elsewhere:".length);
  const cut = rest.lastIndexOf(":");
  return cut > 0 ? rest.slice(0, cut) : null;
}

/** The widgets that are a view of this card. What closing it takes down. */
export function tetheredTo<W extends Held>(ws: readonly W[], card: string): W[] {
  return ws.filter((w) => tetherOf(w) === card);
}

/** At launch: the widgets tethered to a card **here** that is not among the
 *  cards the wall just read.
 *
 *  The close path is where a pin goes, and this is the backstop behind it —
 *  the shape `mark_interrupted` is behind `set_mid_turn`. A pin is removed in
 *  the same synchronous run as its card, but its *row* is deleted by an
 *  `invoke` after that, and a crash in between leaves a row pointing at a card
 *  `load_studio` no longer answers. Asked only after a load that succeeded, so
 *  a store that could not be read is never read as every card having closed.
 *
 *  A card on another wall is never answered here: whether it still stands is
 *  its wall's to say, and that wall has not been heard yet at launch — see
 *  `goneFrom`. */
export function strays<W extends Held>(ws: readonly W[], alive: ReadonlySet<string>): W[] {
  return ws.filter((w) => {
    const card = tetherOf(w);
    return card !== null && strayed(card, alive);
  });
}

/** `strays`' question about one card. */
export function strayed(card: string, alive: ReadonlySet<string>): boolean {
  return !isShadowKey(card) && !alive.has(card);
}

/** The widgets tethered to one wall's cards that its latest snapshot no longer
 *  carries.
 *
 *  The same rule, in the same place, as a shadow's glass spot
 *  (`shadow.ts::keepHost`): asked only when that wall has just been heard, and
 *  only of its own cards. **A quiet wall is not a closed one** — a laptop with
 *  its lid shut says nothing about what it holds, and a pin that vanished when
 *  the link dropped would be the wall forgetting something you made because a
 *  network blinked. Its card is drawn as not heard from; the pin says the same
 *  and stays. Only a wall that has spoken and left the card out has closed it. */
export function goneFrom<W extends Held>(
  ws: readonly W[],
  host: string,
  alive: ReadonlySet<string>,
): W[] {
  return ws.filter((w) => {
    const card = tetherOf(w);
    return card !== null && wentFrom(card, host, alive);
  });
}

/** `goneFrom`'s question about one card. */
export function wentFrom(card: string, host: string, alive: ReadonlySet<string>): boolean {
  return card.startsWith(`elsewhere:${host}:`) && !alive.has(card);
}

/** Whether a record on the undo stack is a pin of a card that has gone.
 *
 *  Asked of every record, not only of the pins that were up when the card
 *  went: one taken down by hand an hour earlier still has its take-down on the
 *  stack, and undoing that would hang a view of nothing back up — which
 *  `Widgets.put` refuses, so the press would be spent on nothing (`undo.md`
 *  says why that is worse than a shorter history). Shaped like an `Edit`
 *  rather than importing one, so this file stays below the stack. */
export function pinOfGone(
  e: { at: string; was: unknown; now: unknown },
  gone: (card: string) => boolean,
): boolean {
  if (e.at !== "widget") return false;
  return [e.was, e.now].some((r) => {
    const config = r && typeof r === "object" ? (r as { config?: unknown }).config : null;
    if (!config || typeof config !== "object") return false;
    const card = tetherOf({ config: config as Record<string, unknown> });
    return card !== null && gone(card);
  });
}

/** Where the last paragraph of a message starts — how it ended, which is the
 *  reading for a pin dropped to the size of a card: the question it asked, the
 *  sentence saying it is done, rather than the first four lines of a report.
 *
 *  A paragraph is what a blank line closes, **except inside a fence**, where a
 *  blank line is code — splitting there would hand back the bottom half of a
 *  code block with no fence around it, which reads as prose. Trailing blank
 *  lines are not a paragraph. A message with no blank line in it is its own
 *  last paragraph. */
export function closingOf(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fence: { mark: string; size: number } | null = null;
  /* The first line of the paragraph being read, and of the last one seen. */
  let start = -1;
  let last = { from: 0, to: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opens && opens[1]![0] === fence.mark && opens[1]!.length >= fence.size) fence = null;
    } else if (opens) {
      fence = { mark: opens[1]![0]!, size: opens[1]!.length };
    }
    const blank = !fence && line.trim() === "" && !opens;
    if (blank) {
      if (start >= 0) last = { from: start, to: i };
      start = -1;
    } else if (start < 0) start = i;
  }
  if (start >= 0) last = { from: start, to: lines.length };
  return lines.slice(last.from, last.to).join("\n").trim();
}
