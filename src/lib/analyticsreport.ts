/* A report (§13): one self-contained HTML file, opened by double-clicking it,
 * with no network and no Volery.
 *
 * **The renderer is vanilla and shares the pure analytics modules with the
 * app.** The model is built in the front end — the query layer, the view spec
 * and the anonymiser are all here — and the file embeds it as one JSON object,
 * so a rendered report cannot drift from what the app drew: the numbers *are*
 * the app's numbers, carried.
 *
 * Three promises the file has to keep:
 *
 * - **No network.** No external font, script, image or stylesheet. Everything
 *   is inline, so opening it on a plane works and closing the tab changes
 *   nothing.
 * - **All or nothing.** A report too large to carry is refused rather than
 *   truncated: a chart drawn from half a series is a chart that lies (§13.1).
 * - **Anonymised before it is written**, not in the renderer, so opening the
 *   console cannot undo it (§13.3).
 *
 * Pure and directly tested; the file bytes are written by a narrow Rust
 * command, the same shape `portage.rs` uses and for the same reason.
 */

import { bucketLabel, niceAxis, runsOfTimes, tickLabel, type Kpis, type RoomSeries } from "./analyticsroom";
import type { Bucket, Unit, ViewSpec } from "./analytics";

export const REPORT_VERSION = 1;

/** The file's own ceiling. A report is meant to be mailed, and a model past
 *  this is a report with too many panels — said, never truncated. */
export const REPORT_MAX_BYTES = 4 * 1024 * 1024;

export type ReportCover = {
  title: string;
  since: number;
  until: number;
  span: string;
  generatedAt: number;
  hosts: string[];
  accounts: string[];
  volery: string;
  claude: string | null;
  anonymized: boolean;
};

export type ReportSeries = {
  label: string;
  color: string;
  /** Bucket start and value, in the measure's unit. A bucket with no rows is
   *  absent rather than zero, which is what makes a gap a gap. */
  points: { at: number; value: number }[];
};

export type ReportPanel = {
  form: "area" | "table";
  title: string;
  measure: string;
  unit: Unit;
  bucket: Bucket;
  series: ReportSeries[];
};

export type ReportMethods = { title: string; said: string };

export type ReportModel = {
  version: number;
  cover: ReportCover;
  kpis: { label: string; value: string; note: string }[];
  panels: ReportPanel[];
  methods: ReportMethods[];
  /** The view this was asked for, already anonymised — a filter value in here
   *  is as readable as a label on a chart (§13.3). */
  spec: ViewSpec | null;
};

export type ReportInput = {
  window: { since: number; until: number };
  series: readonly RoomSeries[];
  kpis: Kpis;
  span: string;
  measure: string;
  unit: Unit;
  bucket: Bucket;
  split: string | null;
  filter: Record<string, string[]>;
  title: string;
  now: number;
  version: string;
  claude: string | null;
  hosts: readonly string[];
  accounts: readonly string[];
  spec: ViewSpec | null;
};

function seriesOf(one: RoomSeries): ReportSeries {
  return {
    label: one.label,
    color: one.color,
    points: one.points.map((p) => ({ at: p.at, value: p.value })),
  };
}

/** The model, from what the surface already holds.
 *
 * **One panel, and it is the one on screen.** The spec's form decides how it is
 * drawn (an area chart, or the table that stands in for it); the other tabs'
 * tables are not exportable yet and the methodology says so rather than leaving
 * a reader to wonder why a tools table is missing from a report that talks
 * about spend.
 */
export function reportModel(input: ReportInput): ReportModel {
  const leading = input.kpis.leading;
  const kpis = [
    {
      label: "spend",
      value: input.kpis.spend === null ? "not priced" : money(input.kpis.spend),
      note: input.kpis.unpriced > 0 ? `${input.kpis.unpriced} rows unpriced` : "modeled",
    },
    {
      label: "tokens",
      value: input.kpis.tokens === null ? "none recorded" : count(input.kpis.tokens),
      note: "in, out and cache",
    },
    { label: "requests", value: count(input.kpis.requests), note: "in this window" },
    {
      label: "cache read",
      value: input.kpis.cacheShare === null ? "" : `${Math.floor(input.kpis.cacheShare)}%`,
      note: "of all tokens",
    },
    { label: "cards", value: count(input.kpis.cards), note: "active in this window" },
    {
      label: "leading project",
      value: leading?.project || "",
      note: leading?.share !== null && leading?.share !== undefined ? `${Math.floor(leading.share)}% of tokens` : "no project yet",
    },
  ];
  return {
    version: REPORT_VERSION,
    cover: {
      title: input.title,
      since: input.window.since,
      until: input.window.until,
      span: input.span,
      generatedAt: input.now,
      hosts: [...input.hosts],
      accounts: [...input.accounts],
      volery: input.version,
      claude: input.claude,
      anonymized: false,
    },
    kpis,
    panels: [
      {
        form: "area",
        /* The shell's title already names the split; repeating it here is the
           "by account, by account" a first draft shipped. */
        title: input.title,
        measure: input.measure,
        unit: input.unit,
        bucket: input.bucket,
        series: input.series.map(seriesOf),
      },
    ],
    methods: methodsFor(input),
    spec: input.spec,
  };
}

function methodsFor(input: ReportInput): ReportMethods[] {
  const out: ReportMethods[] = [
    {
      title: "measured",
      said:
        "Tokens, requests, tool calls and their timings are read off the transcripts Claude Code writes on each machine. " +
        "Cache reads and writes are counted apart because they are priced apart.",
    },
    {
      title: "modeled",
      said:
        "Dollars are modeled from those tokens through the published price table in force at each request's own date. " +
        "They are not a bill: a provider billed outside that table is counted as unpriced rather than priced at zero.",
    },
    {
      title: "attributed",
      said:
        "Where this report names a share of an allowance window, the window's own delta between samples was divided among the " +
        "requests that overlapped it in proportion to their modeled cost. The total is exact; the split is an estimate.",
    },
    {
      title: "what is not here",
      said:
        "The prompt trace and its bodies are a separate page and are not in this file. The tools, servers and work tables " +
        "are not exportable yet. A machine outside the flyway contributes to no figure here.",
    },
  ];
  const said = filterSaid(input.filter);
  if (said) out.push({ title: "filtered", said });
  return out;
}

/** The filter sentence, from either the real filter or the anonymised one.
 *
 *  **One builder**, because the anonymiser has to rebuild this sentence from
 *  values it has renamed, and a second spelling of it is a second place to
 *  forget the rename. Exported for the test that holds the promise. */
export function filterSaid(filter: Record<string, string[]> | null | undefined): string | null {
  const chips = Object.entries(filter ?? {})
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}: ${v.join(", ")}`)
    .join("; ");
  return chips ? `This window was filtered to ${chips}.` : null;
}

/* ── anonymizing (§13.3) ─────────────────────────────────────────────────── */

export type ReportAnon = {
  /** Rename account labels, hostnames, project names, cards, tools and
   *  branches. Off by default in the panel, on in the report a person checks
   *  before mailing. */
  on: boolean;
};

/* One list per *Dimension* in `analytics.ts`, and no invented keys: a key that
   is not a dimension is a mapping nothing can ever reach, and `agent`/`target`
   were exactly that while the real `subagent` fell through unnamed. */
const ACCOUNT_KEYS = ["account", "provider"];
const HOST_KEYS = ["host"];
const PROJECT_KEYS = ["project"];
const CARD_KEYS = ["card"];
const TOOL_KEYS = ["tool", "server", "skill"];
const BRANCH_KEYS = ["branch"];
const SESSION_KEYS = ["session"];

function relabel(labels: readonly string[], prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const label of [...new Set(labels)].sort()) {
    if (!label) continue;
    const letter = String.fromCharCode(65 + (i % 26));
    out.set(label, `${prefix} ${letter}${i >= 26 ? Math.floor(i / 26) : ""}`);
    i++;
  }
  return out;
}

/** The model with every name in it replaced before it is embedded.
 *
 * **The filter values are anonymised too**, because a `filter: { account:
 * ["lyss"] }` in the embedded JSON is as readable as a label on a chart — the
 * first cut of this anonymised the model and left the spec alone (§13.3).
 */
export function anonymizeReport(model: ReportModel, split: string | null): ReportModel {
  /* **One letter space per dimension, built from everywhere the dimension is
     named**, not from the cover alone. A filter can name an account the cover
     excludes, and a split's series labels are the same values; two letter
     assignments for one identity would make a report disagree with its own
     filter sentence. */
  const rawSpec = model.spec;
  const seriesLabels = split ? model.panels.flatMap((p) => p.series.map((s) => s.label)) : [];
  const bare = (v: string): string => (v.startsWith("!") ? v.slice(1) : v);
  const valuesFor = (key: string): string[] => {
    const filters = rawSpec?.filter as Record<string, string[]> | undefined;
    const fromSpec = (filters?.[key] ?? []).map(bare);
    return [...fromSpec, ...(split === key ? seriesLabels.map(bare) : [])].filter(Boolean);
  };
  const leading = model.kpis.find((k) => k.label === "leading project")?.value ?? "";
  const realLeading = leading && leading !== "" ? leading : "";
  const accounts = relabel([...model.cover.accounts, ...valuesFor("account"), ...valuesFor("provider")], "account");
  const hosts = relabel([...model.cover.hosts, ...valuesFor("host")], "machine");
  const projects = relabel([realLeading, ...valuesFor("project")], "project");
  const sessions = relabel(valuesFor("session"), "session");
  const subagents = relabel(valuesFor("subagent"), "subagent");
  const branch = "<branch>";
  const map = (key: string, value: string): string => {
    /* **An exclusion keeps its `!`.** Looking up `!lyss` missed the map and the
       fallback turned a filter that excluded an account into one that selected
       an account called `account`. */
    const bang = value.startsWith("!") ? "!" : "";
    const v = bang ? value.slice(1) : value;
    const out = ((): string => {
      if (ACCOUNT_KEYS.includes(key)) return accounts.get(v) ?? (v ? "account" : v);
      if (HOST_KEYS.includes(key)) return hosts.get(v) ?? (v ? "machine" : v);
      if (PROJECT_KEYS.includes(key)) return projects.get(v) ?? (v ? "project" : v);
      if (SESSION_KEYS.includes(key)) return sessions.get(v) ?? (v ? "session" : v);
      if (key === "subagent") return subagents.get(v) ?? (v ? "subagent" : v);
      if (CARD_KEYS.includes(key)) return v ? "card" : v;
      if (TOOL_KEYS.includes(key)) return v ? key : v;
      if (BRANCH_KEYS.includes(key)) return v ? branch : v;
      return value;
    })();
    return bang ? `!${out}` : out;
  };
  /* **The series labels are the split's values, and the split is known here.**
     Guessing the dimension from the label would relabel an account called
     "volery" as a project. The fold's own label (`other`) is not an identity
     and is left alone. */
  const panel = (p: ReportPanel): ReportPanel => ({
    ...p,
    series: p.series.map((one) => ({
      ...one,
      /* The fold's label is not an identity — it is the word for "everything
         else" — and the chart's own vocabulary is not the split's. */
      label: one.label && split && one.label !== "other" && one.label !== "others"
        ? map(split, one.label)
        : one.label,
    })),
  });
  const spec = model.spec ? anonymizeSpec(model.spec, map) : null;
  /* **The methodology is rebuilt, not copied.** `methodsFor` writes the real
     filter's values into a sentence, and an anonymised report that carries it
     unchanged names every account, session and project it just hid: the panel's
     default path leaked through the one paragraph nobody thought of as data.
     One builder, so the two spellings cannot drift. */
  const methods = ((): ReportMethods[] => {
    const rest = model.methods.filter((m) => m.title !== "filtered");
    const said = spec ? filterSaid(spec.filter) : null;
    return said ? [...rest, { title: "filtered", said }] : rest;
  })();
  return {
    ...model,
    cover: {
      ...model.cover,
      /* Sorted, because the letters are handed out in that order: a cover that
         read "machine B, machine A" would make a reader wonder what A is. */
      hosts: [...model.cover.hosts].sort().map((h) => hosts.get(h) ?? "machine"),
      accounts: [...model.cover.accounts].sort().map((a) => accounts.get(a) ?? "account"),
      anonymized: true,
    },
    kpis: model.kpis.map((k) =>
      k.label === "leading project"
        ? { ...k, value: realLeading ? (projects.get(realLeading) ?? "project") : k.value }
        : k,
    ),
    panels: model.panels.map(panel),
    methods,
    spec,
  };
}

function anonymizeSpec(spec: ViewSpec, map: (key: string, value: string) => string): ViewSpec {
  const filter: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(spec.filter ?? {})) {
    filter[key] = (values as string[]).map((v) => map(key, v));
  }
  return { ...spec, name: "a saved view", filter };
}

/* ── the file (§13.1, §13.4) ─────────────────────────────────────────────── */

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function count(n: number): string {
  if (!(n > 0)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

function money(usd: number): string {
  if (!(usd > 0)) return "$0";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 999.5) return `$${Math.round(usd)}`;
  if (usd < 9950) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd < 999_500) return `$${Math.round(usd / 1000)}k`;
  return `$${(usd / 1e6).toFixed(1)}M`;
}

function dateSaid(at: number): string {
  const d = new Date(at);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function timeSaid(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const W = 720;
const PAD = { l: 46, r: 12, t: 12, b: 26 };
const H = 260;

function instantsOf(panel: ReportPanel): number[] {
  const seen = new Set<number>();
  for (const s of panel.series) for (const p of s.points) seen.add(p.at);
  return [...seen].sort((a, b) => a - b);
}

function valueSaid(unit: Unit, value: number): string {
  return unit === "usd" ? money(value) : count(value);
}

function bucketSaid(bucket: Bucket): string {
  switch (bucket) {
    case "1m":
      return "minute";
    case "5m":
      return "5 minutes";
    case "15m":
      return "15 minutes";
    case "1h":
      return "hour";
    case "1d":
      return "day";
    case "1w":
      return "week";
  }
}

function unitSaid(unit: Unit): string {
  switch (unit) {
    case "usd":
      return "dollars";
    case "tokens":
      return "tokens";
    case "points":
      return "allowance points";
    case "count":
      return "count";
    case "percent":
      return "percent";
    case "ratio":
      return "ratio";
    case "bytes":
      return "bytes";
    case "bytes/s":
      return "bytes/s";
    case "ms":
      return "milliseconds";
  }
}

/** What a series is called in a table head, a legend or a tooltip. A surface
 *  with no split has one unnamed series, and an empty heading is a defect on
 *  the default path rather than a taste question. */
function seriesName(panel: ReportPanel, s: ReportSeries): string {
  return s.label || "value";
}

/** One panel drawn as an area chart, or as its table.
 *
 *  **Stacked, as both app presentations draw it.** The bands are cumulative and
 *  the axis is the stacked total, because the report's promise is the panel on
 *  screen carried into a file (§13.1); an unstacked redraw would show the same
 *  numbers at different heights and call it the same picture. */
function panelSvg(panel: ReportPanel, since: number, until: number): string {
  const times = instantsOf(panel);
  const valueAt = panel.series.map((s) => new Map(s.points.map((p) => [p.at, p.value])));
  const cum: Map<number, number>[] = [];
  let below = new Map<number, number>();
  for (let si = 0; si < panel.series.length; si++) {
    const here = new Map<number, number>();
    for (const t of times) here.set(t, (below.get(t) ?? 0) + (valueAt[si].get(t) ?? 0));
    cum.push(here);
    below = here;
  }
  /* A loop rather than `Math.max(...values)`: a fine window's bucket count is
     not something to hand a spread, and a stack overflow in an exporter is a
     blank report. */
  let highest = 0;
  for (const t of times) {
    const v = cum.length > 0 ? (cum[cum.length - 1].get(t) ?? 0) : 0;
    if (v > highest) highest = v;
  }
  const axis = niceAxis(highest);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (at: number): number => PAD.l + (until > since ? ((at - since) / (until - since)) * plotW : 0);
  const y = (v: number): number => PAD.t + (1 - (axis.top > 0 ? v / axis.top : 0)) * plotH;
  const paths: string[] = [];
  for (const run of runsOfTimes(times, panel.bucket)) {
    if (run.length === 0) continue;
    const xs = run.map(x);
    for (let si = 0; si < panel.series.length; si++) {
      const one = panel.series[si];
      const tops = run.map((t) => y(cum[si].get(t) ?? 0));
      const bottoms = run.map((t) => (si === 0 ? y(0) : y(cum[si - 1].get(t) ?? 0)));
      /* **A one-bucket run is a dot.** Its area is zero wide and its line is one
         segment, so the first draft drew nothing for a series the legend and the
         table both listed; the app draws exactly this dot (§13.1). */
      if (run.length === 1) {
        paths.push(
          `<circle cx="${xs[0].toFixed(1)}" cy="${tops[0].toFixed(1)}" r="3" fill="${esc(one.color)}" stroke="#fffdf8" stroke-width="1.5"/>`,
        );
        continue;
      }
      let top = `M${xs[0].toFixed(1)},${tops[0].toFixed(1)}`;
      for (let i = 1; i < run.length; i++) top += ` L${xs[i].toFixed(1)},${tops[i].toFixed(1)}`;
      let area = top;
      for (let i = run.length - 1; i >= 0; i--) area += ` L${xs[i].toFixed(1)},${bottoms[i].toFixed(1)}`;
      area += " Z";
      paths.push(`<path d="${area}" fill="${esc(one.color)}" fill-opacity="0.18" stroke="none"/>`);
      paths.push(`<path d="${top}" fill="none" stroke="${esc(one.color)}" stroke-width="1.6" stroke-linejoin="round"/>`);
    }
  }
  const ticks = axis.ticks
    .map(
      (v) =>
        `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>` +
        `<text x="${PAD.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" class="tick">${esc(valueSaid(panel.unit, v))}</text>`,
    )
    .join("");
  /* Six labels at most, evenly spaced through the axis, so a narrow report does
     not stack them into a smear. */
  const step = Math.max(1, Math.ceil(times.length / 6));
  const xTicks = times
    .filter((_, i) => i % step === 0)
    .map((at) => `<text x="${x(at).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="tick">${esc(tickLabel(at, panel.bucket))}</text>`)
    .join("");
  /* One hit band per plotted instant, with every series' value in its tooltip:
     a reader hovering a bucket wants the bucket, not the nearest line. */
  const unit = plotW / Math.max(1, times.length);
  /* A map per series, built once: a `find` per instant per series is quadratic
     in the length of the window, which on a fine span is tens of thousands of
     points. */
  const byInstant = new Map<number, (number | null)[]>();
  for (const [i, s] of panel.series.entries()) {
    for (const p of s.points) {
      const row = byInstant.get(p.at) ?? panel.series.map(() => null);
      row[i] = p.value;
      byInstant.set(p.at, row);
    }
  }
  const bands = times
    .map((t) => {
      const x0 = x(t) - unit / 2;
      const row = byInstant.get(t) ?? [];
      const said = panel.series
        .map((s, i) =>
          row[i] === null || row[i] === undefined
            ? null
            : `${seriesName(panel, s)} ${valueSaid(panel.unit, row[i] as number)}`,
        )
        .filter(Boolean)
        .join(" · ");
      return `<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${unit.toFixed(1)}" height="${plotH}" fill="transparent"><title>${esc(bucketLabel(t, panel.bucket))} · ${esc(said)}</title></rect>`;
    })
    .join("");
  /* No split draws one unnamed series; a legend that is a bare dot is worse
     than no legend, because it tells a reader there is an identity to match. */
  const named = panel.series.filter((s) => s.label);
  const legend =
    named.length > 0
      ? `<ul class="legend">${named
          .map((s) => `<li><span class="dot" style="background:${esc(s.color)}"></span>${esc(s.label)}</li>`)
          .join("")}</ul>`
      : "";
  return `<figure class="panel">
    <figcaption><h2>${esc(panel.title)}</h2><span class="unit">${esc(unitSaid(panel.unit))} per ${esc(bucketSaid(panel.bucket))}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(panel.title)}">${ticks}${xTicks}${paths.join("")}${bands}</svg>
    ${legend}
  </figure>`;
}

function panelTable(panel: ReportPanel): string {
  const times = instantsOf(panel);
  const head = `<tr><th>when</th>${panel.series.map((s) => `<th>${esc(seriesName(panel, s))}</th>`).join("")}</tr>`;
  /* The same map the chart builds, so a fine window's table is linear too. */
  const byInstant = new Map<number, (number | null)[]>();
  for (const [i, s] of panel.series.entries()) {
    for (const p of s.points) {
      const row = byInstant.get(p.at) ?? panel.series.map(() => null);
      row[i] = p.value;
      byInstant.set(p.at, row);
    }
  }
  const rows = times.map((t) => {
    const row = byInstant.get(t) ?? [];
    const cells = panel.series.map((_, i) =>
      row[i] === null || row[i] === undefined ? `<td class="num">—</td>` : `<td class="num">${esc(valueSaid(panel.unit, row[i] as number))}</td>`,
    );
    return `<tr><th>${esc(bucketLabel(t, panel.bucket))}</th>${cells.join("")}</tr>`;
  });
  return `<details class="table"><summary>the numbers behind it</summary><table>${head}${rows.join("")}</table></details>`;
}

/** The whole file.
 *
 * The JSON is embedded *after* anonymisation and is escaped so a name
 * containing `</script>` cannot end the element early — the same reasoning
 * `clip::keep` applies in the other direction: a report is read by somebody
 * else's browser, and the escaping has to be right the first time.
 */
export function renderReport(model: ReportModel): string {
  const since = model.cover.since;
  const until = model.cover.until;
  const panels = model.panels
    .map((p) => `${p.form === "table" ? "" : panelSvg(p, since, until)}${panelTable(p)}`)
    .join("");
  const kpis = model.kpis
    .map((k) => `<div class="kpi"><span class="k-label">${esc(k.label)}</span><span class="k-value">${esc(k.value)}</span><span class="k-note">${esc(k.note)}</span></div>`)
    .join("");
  const methods = model.methods
    .map((m) => `<dt>${esc(m.title)}</dt><dd>${esc(m.said)}</dd>`)
    .join("");
  const embedded = JSON.stringify(model).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.cover.title)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 56px; background: #f6f4ef; color: #2a2723;
  font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
.lede { margin: 0 0 20px; color: #6b655c; }
.cover { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 24px;
  border-top: 1px solid #d8d2c6; border-bottom: 1px solid #d8d2c6; padding: 12px 0; margin: 0 0 24px; }
.cover div span { display: block; font-size: 11px; text-transform: lowercase; color: #8a8377; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 1px;
  background: #ddd7ca; border: 1px solid #ddd7ca; margin: 0 0 26px; }
.kpi { background: #fffdf8; padding: 10px 12px; display: flex; flex-direction: column; gap: 1px; }
.k-label { font-size: 10.5px; text-transform: lowercase; color: #8a8377; }
.k-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.k-note { font-size: 10.5px; color: #6b655c; }
figure.panel { margin: 0 0 26px; }
figcaption { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }
figcaption h2 { font-size: 14px; margin: 0; }
.unit { font-size: 11px; color: #8a8377; }
svg { width: 100%; height: auto; display: block; background: #fffdf8; border: 1px solid #e6e1d6; border-radius: 6px; }
.grid { stroke: #e6e1d6; stroke-width: 1; }
.tick { fill: #8a8377; font-size: 9.5px; font-family: "Cascadia Mono", Consolas, monospace; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; padding: 0; font-size: 11.5px; }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
details.table { margin-top: 8px; font-size: 12px; }
details.table summary { cursor: pointer; color: #6b655c; }
table { border-collapse: collapse; width: 100%; margin-top: 6px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #ece7dc; }
td.num { text-align: right; }
dl.methods { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0;
  border-top: 1px solid #d8d2c6; padding-top: 14px; font-size: 12.5px; }
dl.methods dt { font-weight: 600; }
dl.methods dd { margin: 0; color: #4b463f; }
.foot { margin-top: 22px; font-size: 11px; color: #8a8377; }
@media print {
  body { padding: 0; background: #fff; color: #000; }
  details.table { display: none; }
  figure.panel { break-inside: avoid; }
  .foot { display: none; }
}
</style>
</head>
<body>
<main>
<h1>${esc(model.cover.title)}</h1>
<p class="lede">${esc(dateSaid(model.cover.since))} to ${esc(dateSaid(model.cover.until))} · ${esc(model.cover.span)}${model.cover.anonymized ? " · anonymized" : ""}</p>
<section class="cover">
  <div><span>generated</span>${esc(dateSaid(model.cover.generatedAt))} ${esc(timeSaid(model.cover.generatedAt))}</div>
  <div><span>accounts</span>${esc(model.cover.accounts.join(", ") || "none recorded")}</div>
  <div><span>machines</span>${esc(model.cover.hosts.join(", ") || "this machine")}</div>
  <div><span>volery</span>${esc(model.cover.volery)}</div>
  <div><span>claude code</span>${esc(model.cover.claude ?? "not recorded")}</div>
</section>
<section class="kpis">${kpis}</section>
${panels}
<dl class="methods">${methods}</dl>
<p class="foot">generated by volery · this file needs no network and no volery to read.</p>
</main>
<script type="application/json" id="volery-report">${embedded}</script>
</body>
</html>`;
}

/** The whole export, or a refusal. **All or nothing**: a model past the
 *  ceiling is named as too large rather than cut down, because a chart drawn
 *  from half a series is a chart that lies. */
export function reportFile(model: ReportModel): string {
  /* Measured on the model before anything is rendered: the embedded JSON is the
     bulk of the file, and rendering a model too large to carry to find that out
     is work spent on a file that is thrown away. */
  const modelBytes = new TextEncoder().encode(JSON.stringify(model)).length;
  if (modelBytes > REPORT_MAX_BYTES) {
    throw new Error(
      `this report is ${(modelBytes / 1024 / 1024).toFixed(1)} MB and a report is at most ` +
        `${REPORT_MAX_BYTES / 1024 / 1024} MB — narrow the span or the split`,
    );
  }
  const html = renderReport(model);
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > REPORT_MAX_BYTES) {
    throw new Error(
      `this report is ${(bytes / 1024 / 1024).toFixed(1)} MB and a report is at most ` +
        `${REPORT_MAX_BYTES / 1024 / 1024} MB — narrow the span or the split`,
    );
  }
  return html;
}

/** A file name that says what it is and sorts by day. */
export function reportName(title: string, at: number): string {
  const d = new Date(at);
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "volery";
  return `${slug}-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.html`;
}
