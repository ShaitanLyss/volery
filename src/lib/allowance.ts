/* What chat view says about the allowance (`docs/chat-mode.md` §5.7): the
 * sidebar's foot, the quiet line when it runs low, and the banner when every
 * account is spent and what you send is held.
 *
 * Pure, over `limits.ts`'s reading and `holding.ts`'s hold. The reading itself
 * is the waterfall's per managed account, and the ledger's for the machine's own
 * credential; which one a conversation spends is the caller's to say.
 */

import { binding, pct, tierOf, type Window } from "./limits";

/** The window's clock in the foot's words: *this session*, *this week*. */
export function windowNoun(w: Window): string {
  if (w.group === "session") return "this session";
  if (w.group === "weekly") return w.scope ? `this week of ${w.scope.toLowerCase()}` : "this week";
  return w.kind.replace(/_/g, " ");
}

/** A reset as a time on the clock — *15:40*, or *tue 09:00* past today —
 *  because "it comes back at 15:40" is what a person plans around and "in 2h
 *  13m" has to be added up (§5.7). */
export function clockOf(ms: number, now: number): string {
  const at = new Date(ms);
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return hm;
  const day = at.toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase();
  return `${day} ${hm}`;
}

/** The sidebar's foot: who this conversation spends, and the window that binds
 *  it (*max · 47% of this session*). `label` is the managed account it is on,
 *  null for the machine's own credential; `plan` what that account is a
 *  subscription to, where known. */
export function footOf(
  label: string | null,
  windows: readonly Window[] | null,
  plan: string | null,
): { name: string; line: string } {
  const name = label ?? "claude code";
  const w = windows ? binding([...windows]) : null;
  if (!w) return { name, line: label ? "this conversation's account" : "as this computer is signed in" };
  const used = `${pct(w.used)} of ${windowNoun(w)}`;
  return { name, line: plan ? `${plan.toLowerCase()} · ${used}` : used };
}

/** The quiet line above the message box while the allowance this conversation
 *  spends is running low — `limits.ts`'s `warm` or `urgent`, and not yet spent,
 *  which is the banner's (§5.7). Achromatic, like the wall's. */
export function lowOf(windows: readonly Window[] | null, now: number): string | null {
  const w = windows ? binding([...windows]) : null;
  if (!w || w.used >= 100) return null;
  if (tierOf(w) === "calm") return null;
  const back = w.resetsAt ? ` · it comes back at ${clockOf(w.resetsAt, now)}` : "";
  return `${windowNoun(w)}'s allowance is ${pct(w.used)} used${back}`;
}

/** The banner, when the waterfall is holding what you send because no account
 *  will take it (`holding.ts`). Two sentences and a promise, which is §5.7's
 *  wording: the reset as a clock, that sending still works, and that nothing is
 *  lost. Null when nothing is held for the allowance — a queue held behind a
 *  turn is not run out. `windows`, where known, names which allowance: the
 *  spent window's own clock, and *the allowance* when none reads spent. */
export function outOf(
  held: { waiting: "allowance" | "turn"; until: number | null } | null,
  now: number,
  windows: readonly Window[] | null = null,
): { head: string; body: string } | null {
  if (!held || held.waiting !== "allowance") return null;
  if (held.until === null)
    return {
      head: "no account can take this right now.",
      body: "Anything you send waits and goes by itself once one can — nothing is lost.",
    };
  const w = windows ? binding([...windows]) : null;
  const whose = w && w.used >= 100 ? `${windowNoun(w)}'s allowance` : "the allowance";
  return {
    head: `${whose} is used up.`,
    body: `It comes back at ${clockOf(held.until, now)}. Anything you send waits and goes by itself — nothing is lost.`,
  };
}
