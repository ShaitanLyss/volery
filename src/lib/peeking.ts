/* What the peek is allowed to say, and when: the two decisions under
 * `attention.svelte.ts`, pure so they can be asserted. See
 * `.claude/rules/away.md`, "The peek says only what you have not seen".
 *
 * Two complaints from Lyss, 2026-10-16, both in her words:
 *
 *   "they show up when I go to another window, which is nonsensical because I
 *    was already on the wall so I know what was going on"
 *
 *   "when my account runs out of allowance, I'm swarmed with one notification
 *    per card … at most I should get one notification saying an account ran
 *    out of allowance"
 *
 * The first is `look` / `unseen`, the second is `coalesce`. */

import type { HealKind } from "./classify";

export type PeekKind = "blocked" | "notice" | "overdue" | "failed" | "rang";

/** Why an item is on the ladder, where that cause is shared by other items and
 *  they are therefore one piece of news. Only an allowance so far: it is the one
 *  failure that arrives at every card on an account at once, and says the same
 *  thing about each of them. */
export type PeekCause = { kind: "limited"; account: string | null };

export type PeekItem = {
  id: string;
  project: string;
  /** Empty for a card nothing has named yet — the peek prints the project
   *  beside it, which is the more useful of the two facts anyway. Resolved
   *  before it crosses to the peek window, since the item is the whole of what
   *  crosses. */
  title: string;
  /** `rang` is the one that is not a conversation. A countdown that has run out
   *  is waiting to be noticed, which is the entire job of this ladder — see
   *  `attention.svelte.ts` for why there is no second notification path. */
  kind: PeekKind;
  /** What makes this item news, when that is not the card — a notice's own
   *  id, since a card's second notice is news its first one already rang for. */
  key?: string;
  detail: string;
  waitedSeconds: number;
  /** When the state this item reports became visible on the wall, in epoch ms,
   *  where that is known. It can be earlier than the item: a card that came to
   *  rest is on the wall at once and on this ladder only `GRACE_S` later, and a
   *  rest notice is raised `SETTLE_MS` after the rest it is about. Absent where
   *  only the ladder's own hearing of it is known (another wall's question). */
  since?: number;
  cause?: PeekCause;
  /** Set on a folded allowance row when one of the rows it swallowed was a
   *  notice: the bell keeps it on its books as a notice, so an account running
   *  out rings once — not once per card, and not never. */
  rings?: boolean;
};

/** The identity of what is waiting, so a card ageing by a second does not
 *  count as something new to announce. */
export function peekKey(i: Pick<PeekItem, "kind" | "key" | "id">): string {
  return `${i.kind}:${i.key ?? i.id}`;
}

/** The cause a card's failure carries onto the ladder, or none. */
export function causeOf(fault: HealKind | null, account: string | null): PeekCause | undefined {
  return fault === "limited" ? { kind: "limited", account } : undefined;
}

/* ── an account running out is one piece of news ────────────────────────── */

/** Every item an allowance ran out under, folded to one per account.
 *
 *  An account running out stops every card on it inside a few seconds, and each
 *  of them used to stand on the ladder as its own failure — a peek reading
 *  "6 things want you", all six saying the same sentence. The news is that the
 *  account ran out; which cards it caught is a count.
 *
 *  **Folded even when only one card was caught**, and that is not tidiness: the
 *  key of the folded row is the account's, so the second card arriving a moment
 *  later joins a row that has already been announced. Left as a card row until
 *  there were two, the second card would change the key and the peek would
 *  announce the same account twice.
 *
 *  Only `limited`. Two cards that broke for different reasons are two pieces of
 *  news, and an overload is weather rather than one account's state — it is
 *  told per card as it always was. */
export function coalesce(items: PeekItem[]): PeekItem[] {
  const groups = new Map<string, PeekItem[]>();
  const out: PeekItem[] = [];
  for (const i of items) {
    if (i.cause?.kind !== "limited" || (i.kind !== "failed" && i.kind !== "notice")) {
      out.push(i);
      continue;
    }
    const k = i.cause.account ?? "";
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  }
  for (const [account, members] of groups) {
    /* The card that has waited longest is the one the row lands you on: it is
       the first the account stopped, so its transcript has the refusal that
       started it. */
    const first = members.reduce((a, b) => (b.waitedSeconds > a.waitedSeconds ? b : a));
    const sinces = members.map((m) => m.since).filter((s): s is number => typeof s === "number");
    const n = members.length;
    const rings = members.some((m) => m.kind === "notice" || m.rings);
    out.push({
      id: first.id,
      project: "account",
      title: account,
      kind: "failed",
      key: `limited:${account}`,
      detail: `ran out of allowance — ${n === 1 ? "one card" : `${n} cards`} stopped on it`,
      waitedSeconds: first.waitedSeconds,
      since: sinces.length ? Math.min(...sinces) : undefined,
      cause: { kind: "limited", account: account || null },
      ...(rings ? { rings } : {}),
    });
  }
  return out;
}

/* ── what you have already seen ─────────────────────────────────────────── */

/** What the ladder knows about where you have been looking.
 *
 *  `leftAt` is when the window stopped being in front, or null while it is.
 *  `heard` is when each key now on the ladder was first on it — **without a
 *  break**: a key that leaves is forgotten, so a card that asks a second
 *  question after its first was answered is heard afresh. */
export type Sight = {
  leftAt: number | null;
  heard: ReadonlyMap<string, number>;
};

export const LOOKING: Sight = { leftAt: null, heard: new Map() };

/** Fold one pass of the ladder into the sight. Called on every pass, focused or
 *  not, because forgetting a key that left is what makes its return news.
 *
 *  `blurredAt` is when the window actually lost focus, where that was heard: a
 *  pass runs a moment after the blur, and stamping the leaving at the pass
 *  would make anything that arrived in between read as already there. */
export function look(
  prev: Sight,
  items: PeekItem[],
  focused: boolean,
  now: number,
  blurredAt: number | null = null,
): Sight {
  const heard = new Map<string, number>();
  for (const i of items) {
    const k = peekKey(i);
    if (!heard.has(k)) heard.set(k, prev.heard.get(k) ?? now);
  }
  return { leftAt: focused ? null : (prev.leftAt ?? Math.min(blurredAt ?? now, now)), heard };
}

/** What on the ladder you have **not** seen: everything the peek may show.
 *
 *  Seen means it was there while the window was in front — the item itself, or
 *  the state it reports (`since`), at or before the moment you left — and it
 *  has stood without a break since. You were on the wall; the wall was saying
 *  it. Going to another window is not news about any of it.
 *
 *  Nothing is unseen while the window is in front, which is the peek's old rule
 *  (it is for a window you cannot see) restated rather than changed. */
export function unseen(items: PeekItem[], sight: Sight): PeekItem[] {
  const left = sight.leftAt;
  if (left === null) return [];
  return items.filter((i) => {
    const heard = sight.heard.get(peekKey(i)) ?? Infinity;
    return Math.min(heard, i.since ?? Infinity) > left;
  });
}

/** Which of what the peek shows has not been announced yet — the only thing a
 *  window, a taskbar flash or a chime is spent on. `announced` is pruned to
 *  what is still showing first, so a key that left and came back is news. */
export function toAnnounce(
  shown: PeekItem[],
  announced: ReadonlySet<string>,
): { news: PeekItem[]; announced: Set<string> } {
  const keys = new Set(shown.map(peekKey));
  const kept = new Set([...announced].filter((k) => keys.has(k)));
  const news = shown.filter((i) => !kept.has(peekKey(i)));
  for (const i of news) kept.add(peekKey(i));
  return { news, announced: kept };
}
