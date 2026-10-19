/* What is in front of you: everything waiting on you, of every kind, and which
 * one of it is held.
 *
 * This was the dock's (`Dock.svelte`), and came out for chat view
 * (`docs/chat-mode.md` §7.4) because the queue is not the dock's. The dock is
 * one drawing of it — the held item, in its panel along the bottom of the wall
 * — and chat view is two more: a conversation's own question at the foot of
 * its thread, and everybody else's as rows in *needs you* and as toasts. Three
 * drawings of one queue have to agree on what is waiting, so the queue is built
 * once, here, by the one rule `queue.ts` holds.
 *
 * Nothing about the rules changed in the move. `queue.ts` still owns them —
 * `settleHold`, `shownItem`, `nextItem`, `steady` — and is what
 * `test/queue.test.ts` and `test/finding.test.ts` read; this is the live half
 * that used to sit in the dock's script, and the hold is still settled in an
 * `$effect.pre` so it is right before anything draws it. Constructed once in
 * `App.svelte`, beside `Field`, since a hold the dock owned would be dropped
 * every time chat view unmounts the dock.
 */

import { untrack } from "svelte";
import type { PendingAsk } from "./conversation.svelte";
import type { Notice as NoticeRow } from "./notice";
import type { CardHandle, Cards } from "./cards.svelte";
import { nextItem, settleHold, shownItem, steady, type Hold, type Waiting } from "./queue";
import { replies } from "./replies.svelte";
import { nameBesideProject } from "./naming";

/** One thing waiting on you, with what its panel needs to draw it.
 *
 *  Only the question at the *front* of a card's queue is an item: a card's
 *  questions are answered in the order it asked them, and `answerAsk` answers
 *  the front one. The rest are counted in `waitingOnYou` and come forward one
 *  by one, as the hold moves on to them (`settleHold`'s same-card rule). */
export type Item =
  | (Waiting & { kind: "ask"; of: CardHandle; ask: PendingAsk })
  | (Waiting & { kind: "notice"; of: CardHandle; notice: NoticeRow });

export class Front {
  #cards: Cards;
  #ring: () => string | null;
  #select: (card: CardHandle) => void;

  /** What is held: the item, and the card it was about. */
  hold = $state.raw<Hold | null>(null);

  /** Said when the held item went from under you while you were typing into
   *  it, and the reason the next Enter is held once — see `guardSwap`. */
  swapped = $state<string | null>(null);

  /** The panel the held item is drawn in, bound by whichever drawing holds
   *  it, so a swap can tell whether the caret was in it. */
  heldEl = $state<HTMLElement | undefined>(undefined);

  /* Plain, not `$state`: the derived's and the effect's own memories, read and
     written only by them. */
  #lastItems = new Map<string, Item>();
  #ringed: string | null = null;
  #seen = new Map<string, Item>();

  constructor(cards: Cards, ring: () => string | null, select: (card: CardHandle) => void) {
    this.#cards = cards;
    this.#ring = ring;
    this.#select = select;

    /* `$effect.pre` rather than `$effect` so the hold is settled before
       anything reads the deriveds that depend on it: doing it after would have
       the panel drawn once with the stale hold on the frame you click a card. */
    $effect.pre(() => {
      const now = this.items;
      const at = this.#ring();
      untrack(() => {
        /* The ring moving is you choosing a card — unless the card it was on
           is gone. Closing the card in the ring moves the ring on by itself
           (`closeConv` in `App.svelte`), and that is the wall tidying up after
           you, not you choosing whichever card it landed on. */
        const moved = at !== this.#ringed && (this.#ringed === null || cards.stands(this.#ringed));
        this.#ringed = at;
        const before = this.hold;
        this.hold = settleHold(now, at, this.hold, moved);
        if (moved || this.hold?.key !== before?.key) this.swapped = null;
        /* The held item went without you: guard what you were typing. */
        if (!moved && before && this.hold && this.hold.key !== before.key && !replies.byYou(before.key)) {
          const gone = this.#seen.get(before.key);
          if (gone) this.guardSwap(gone);
        }
        this.#seen = new Map(now.map((t) => [t.key, t]));
      });
    });
  }

  /* Two kinds, not four: a question and a notice, each carrying its card's
     handle, so one panel answers either wherever the card runs. Keyed as the
     panels key their replies (`replies.ts`), so "this item is still waiting"
     and "this reply's item is still waiting" are one question. And every item
     that has not changed is handed back as the very object it was (`steady`):
     this is rebuilt on any traffic anywhere, and a panel handed a new object
     for the same question wakes everything reading it. */
  readonly items: Item[] = $derived.by((): Item[] => {
    const out: Item[] = [];
    /* Nothing here asks where a card runs: `since` is when it began waiting,
       on this wall's clock for a card anywhere (`queueOrder`). */
    for (const of of this.#cards.asking) {
      const ask = of.ask;
      if (ask) out.push({ kind: "ask", key: `ask:${ask.askId}`, card: of.id, tier: 0, since: ask.since, of, ask });
    }
    for (const { card: of, notice } of this.#cards.noticing) {
      out.push({ kind: "notice", key: `notice:${notice.id}`, card: of.id, tier: 1, since: notice.raisedAt, of, notice });
    }
    const kept = steady(this.#lastItems, out);
    this.#lastItems = new Map(kept.map((t) => [t.key, t]));
    return kept;
  });

  /** What is drawn. Asked of the same rule as the hold rather than read off it,
   *  so it is right on the very frame an item goes, before the effect has
   *  re-settled anything. */
  readonly shown: Item | null = $derived.by(() => shownItem(this.items, this.#ring(), this.hold));

  /** The whole queue, as "more" counts it — questions rather than the cards
   *  holding them, since one card can be parked on several at once. */
  readonly waitingOnYou: number = $derived.by(() => this.#cards.waitingOnYou);

  /** What "more waiting on you" would step to — null when everything else is
   *  queued behind the card's own question, which only answering reaches. */
  readonly next: Item | null = $derived.by(() => nextItem(this.items, this.shown?.key ?? null));

  /** Every item about one card — chat view draws a conversation's own question
   *  in its thread, and its notices beside it. */
  of(card: string): Item[] {
    return this.items.filter((t) => t.card === card);
  }

  /** Who an item is from, as a line says it. */
  whoOf(t: Item): string {
    const name = nameBesideProject(t.of.face.title);
    return `${t.of.where}${name ? ` · ${name}` : ""}`;
  }

  /* ── the held item going while you type into it ────────────────────────
   *
   * Nothing arriving moves the hold, but the held item can still *go*: a rest
   * notice taken down because its card started a turn, another wall answering
   * it or going quiet. The hold moves on to the next — and when that is the
   * same kind, the same panel is reused, the caret stays where it was, and the
   * rest of your sentence and its Enter would land on a different question.
   * Blurring the field is no answer: a key typed with nothing focused goes to
   * the prompt (`onGlobalKey`), and its Enter would then send the tail of the
   * sentence to the card in the ring.
   *
   * So the field keeps the caret, the note says what happened, and the first
   * Enter after the swap is held — once. Your words for the one that went are
   * still kept under it (`replies`), and handed back by the dock. */
  guardSwap(gone: Item) {
    const el = document.activeElement;
    if (!this.heldEl || !(el instanceof HTMLElement) || !this.heldEl.contains(el)) return;
    const kind = gone.kind === "ask" ? "question" : "notice";
    this.swapped = `the ${kind} from ${this.whoOf(gone)} went while you were in it — this is another one, so enter is held once`;
  }

  guardEnter = (e: KeyboardEvent) => {
    if (!this.swapped || e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    this.swapped = null;
  };

  /** Step to the next item, and put its card in the ring so the transcript
   *  beside it is the one it is about. Setting the hold first is what makes the
   *  ring landing there agree with it rather than re-decide. */
  more() {
    const next = this.next;
    if (!next) return;
    this.hold = { key: next.key, card: next.card };
    this.swapped = null;
    const to = this.#cards.find(next.card);
    if (to) this.#select(to);
  }
}
