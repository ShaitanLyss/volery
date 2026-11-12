/* The filter rail (§11.3): which dimensions you can narrow by, what values they
 * hold, and how a choice is written down.
 *
 * The design's promise is that **every dimension is filterable and every filter
 * is a list, so "lyss and tx-team, but not alice" is sayable**. The query layer
 * has honoured that since the first phase (`analytics.ts::filterRows`); what was
 * missing was any way to write one down, which is this file and its component.
 *
 * Four decisions worth keeping:
 *
 *  - **The values come from the window already read, not from a second query.**
 *    A window of facts carries every dimension on every row, so the list beside
 *    a dimension is exactly what this span holds. A dimension with nothing in
 *    it is not offered, which is also how a fine-only dimension (a session)
 *    disappears over a year without a separate rule.
 *  - **An empty pick removes the dimension.** An empty list already means
 *    *none of them*, which is a different question from *all of them*, and the
 *    UI must not be able to ask the first by accident (§9.1).
 *  - **Exclusion is a `!` inside the list**, not a second field. A filter rides
 *    in a saved view, a widget's config and a report, and all three are opaque
 *    JSON columns: a prefix costs no migration, and a build that misread it
 *    would draw no rows, which is visible.
 *  - **The wording is here, not in the component**, because a chip, a saved
 *    view's name and a report's legend all describe the same filter and three
 *    spellings would drift.
 *
 * Pure and tested in `test/filterrail.test.ts`.
 */

import { NOT, dimsOf, type Dimension, type Filter, type UsageRow } from "./analytics";

/** One dimension the rail can offer, and what it is called on the wall. */
export type RailDimension = { dim: Dimension; label: string };

/** The six that fit on one row, in the order a question is usually asked: which
 *  machine, whose subscription, which model, from which provider, in which
 *  project, from which kind of session. */
export const RAIL: readonly RailDimension[] = [
  { dim: "host", label: "machine" },
  { dim: "account", label: "account" },
  { dim: "model", label: "model" },
  { dim: "provider", label: "provider" },
  { dim: "project", label: "project" },
  { dim: "source", label: "source" },
];

/** The four behind *more*: real dimensions, less often asked. `session` and
 *  `subagent` are fine-tier only, and they simply have no values on an hourly
 *  window, so `valuesOf` is what hides them rather than a rule of their own. */
export const MORE: readonly RailDimension[] = [
  { dim: "cli", label: "cli" },
  { dim: "effort", label: "effort" },
  { dim: "session", label: "session" },
  { dim: "subagent", label: "agent" },
];

export const ALL: readonly RailDimension[] = [...RAIL, ...MORE];

export function labelOf(dim: Dimension): string {
  return ALL.find((d) => d.dim === dim)?.label ?? dim;
}

/** Every value this window holds for one dimension, newest reading first is not
 *  meaningful here, so it is alphabetical by display value: a list you scan
 *  does not reshuffle between two reads of the same facts. */
export function valuesOf(rows: readonly UsageRow[], dim: Dimension): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = dimsOf(row)[dim];
    if (typeof value === "string" && value.trim()) seen.add(value);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A value as it is written in a filter, and as it is shown. The prefix is the
 *  whole storage format, so these two are the only places it is spelled. */
export function stored(value: string, exclude = false): string {
  return exclude ? `${NOT}${value}` : value;
}

export function bare(value: string): string {
  return value.startsWith(NOT) ? value.slice(1) : value;
}

export function excluded(value: string): boolean {
  return value.startsWith(NOT);
}

/** Toggle one value, keeping inclusion and exclusion from both being true of
 *  one value: choosing *not x* removes a plain *x* and the other way round. */
export function toggled(
  values: readonly string[] | undefined,
  value: string,
  exclude = false,
): string[] {
  const next = (values ?? []).filter((v) => bare(v) !== value);
  next.push(stored(value, exclude));
  return order(next);
}

export function dropped(values: readonly string[] | undefined, value: string): string[] {
  return (values ?? []).filter((v) => bare(v) !== value);
}

/** Inclusions first, then exclusions, each alphabetical. Stable order matters
 *  for two reasons: a chip that reorders itself under the pointer is one you
 *  toggle twice, and two equal filters must compare equal in `viewMatches`. */
export function order(values: readonly string[]): string[] {
  const yes = values.filter((v) => !excluded(v)).sort();
  const no = values.filter((v) => excluded(v)).sort();
  return [...yes, ...no];
}

/** The filter with one dimension set, or removed when nothing is left. Never
 *  returns an empty list for a dimension. */
export function withDimension(
  filter: Filter,
  dim: Dimension,
  values: readonly string[],
): Filter {
  const next: Filter = { ...filter };
  if (!values.length) delete next[dim];
  else next[dim] = order(values);
  return next;
}

/** The active dimensions, in the rail's own order, so the chips do not shuffle
 *  as a filter is edited. A dimension the rail does not name (a spec from a
 *  newer build, or `card`) is kept and shown last rather than dropped: a filter
 *  a surface cannot render is still one it must honour. */
export function activeOf(filter: Filter): { dim: Dimension; label: string; values: string[] }[] {
  const named = ALL.filter((d) => (filter[d.dim] ?? []).length > 0).map((d) => ({
    dim: d.dim,
    label: d.label,
    values: filter[d.dim] as string[],
  }));
  const extra = Object.keys(filter)
    .filter((k) => !ALL.some((d) => d.dim === k) && (filter[k as Dimension] ?? []).length > 0)
    .sort()
    .map((k) => ({ dim: k as Dimension, label: k, values: filter[k as Dimension] as string[] }));
  return [...named, ...extra];
}

/** How many dimensions carry a choice, for the button's count. */
export function countOf(filter: Filter): number {
  return Object.values(filter).filter((v) => (v ?? []).length > 0).length;
}

/** One dimension's choice, in words: `not deepseek`, `volery`, or
 *  `volery, not nova`. Past three, the rest is counted rather than listed,
 *  because a chip is a chip and not a paragraph. */
export function said(values: readonly string[]): string {
  const parts = order(values).map((v) => (excluded(v) ? `not ${bare(v)}` : bare(v)));
  if (parts.length <= 3) return parts.join(", ");
  return `${parts.slice(0, 2).join(", ")} and ${parts.length - 2} more`;
}

/** The whole chip's text: `provider · not deepseek`. */
export function chipSaid(dim: Dimension, values: readonly string[]): string {
  return `${labelOf(dim)} · ${said(values)}`;
}

/** A filter as a sentence, for a saved view's name and a report's legend:
 *  `provider is not deepseek, project is volery`. Absent is *no filters*. */
export function filterSaid(filter: Filter): string {
  const active = activeOf(filter);
  if (!active.length) return "no filters";
  return active
    .map(({ label, values }) => `${label} is ${said(values)}`)
    .join(", ");
}
