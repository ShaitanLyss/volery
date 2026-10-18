/* A project's page in chat view (`docs/chat-mode.md` §6.7): its conversations,
 * filterable by state. Pure, over `chatview.ts`'s grouping, so the page and the
 * sidebar can never disagree about what *needs you* means.
 */

import type { Group, Placed } from "./chatview";

export type Filter = "all" | "needs" | "working" | "finished";

/** The filters in the order they are drawn, with what each is called. */
export const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "needs", label: "needs you" },
  { key: "working", label: "working" },
  { key: "finished", label: "finished" },
];

/** Which filter a placed row answers to: *needs you* and *working* are the
 *  sidebar's groups; everything else in the project — finished, today's,
 *  last month's, set aside — has finished, which is what the page asks. */
export function filterOf(p: Placed): Exclude<Filter, "all"> {
  return p.group === "needs" ? "needs" : p.group === "working" ? "working" : "finished";
}

/** One project's conversations out of the sidebar's groups, live first and
 *  then by recency — the order the groups already put them in — each once,
 *  and only this wall's (a card on another wall belongs to that wall's
 *  project of the same name, not this folder). */
export function rowsOf(gs: readonly Group[], project: string): Placed[] {
  const seen = new Set<string>();
  const out: Placed[] = [];
  for (const g of gs)
    for (const p of g.rows) {
      if (p.row.project !== project || p.row.host || seen.has(p.row.id)) continue;
      seen.add(p.row.id);
      out.push(p);
    }
  return out;
}

/** How many rows each filter holds, for the counts on the filter chips. */
export function countsOf(rows: readonly Placed[]): Record<Filter, number> {
  const n: Record<Filter, number> = { all: rows.length, needs: 0, working: 0, finished: 0 };
  for (const p of rows) n[filterOf(p)]++;
  return n;
}

export function filtered(rows: readonly Placed[], f: Filter): Placed[] {
  return f === "all" ? [...rows] : rows.filter((p) => filterOf(p) === f);
}

/** The line under a conversation on the page: what it is asking, if it is;
 *  otherwise the first line of what it last said (§6.7). */
export function lineOf(p: Placed): string {
  if (p.group === "needs" && p.sub) return p.sub;
  const first = p.row.lastWords.split("\n").find((l) => l.trim()) ?? "";
  return first.trim() || p.sub || "";
}
