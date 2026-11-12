import { describe, expect, test } from "bun:test";
import {
  REPORT_VERSION,
  anonymizeReport,
  renderReport,
  reportFile,
  reportModel,
  reportName,
  type ReportInput,
  type ReportModel,
} from "../src/lib/analyticsreport";
import type { Kpis, RoomSeries } from "../src/lib/analyticsroom";

const NOW = new Date(2026, 10, 12, 15, 0).getTime();
const DAY = 86_400_000;

function series(over: Partial<RoomSeries> = {}): RoomSeries {
  return {
    key: "lyss",
    label: "lyss",
    slot: 0,
    color: "#3987e5",
    points: [
      { at: NOW - 2 * DAY, value: 1.5 },
      { at: NOW - DAY, value: 2.5 },
      { at: NOW, value: 3.25 },
    ],
    total: 7.25,
    unpriced: 0,
    ...over,
  };
}

const KPIS: Kpis = {
  spend: 7.25,
  unpriced: 3,
  tokens: 1_234_567,
  requests: 42,
  cacheShare: 89,
  cards: 5,
  leading: { project: "volery", tokens: 900_000, share: 73 },
};

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    window: { since: NOW - 7 * DAY, until: NOW },
    series: [series(), series({ key: "tx-team", label: "tx-team", slot: 1, color: "#d55181" })],
    kpis: KPIS,
    span: "7d",
    measure: "usd_modeled",
    unit: "usd",
    bucket: "1d",
    split: "account",
    filter: { account: ["lyss"], project: ["volery"] },
    title: "the last 7 days · modeled spend by account",
    now: NOW,
    version: "0.122.0",
    claude: "2.1.319",
    hosts: ["studio", "lab"],
    accounts: ["lyss", "tx-team"],
    spec: {
      v: 1,
      name: "the last 7 days · modeled spend by account",
      span: "7d",
      bucket: "auto",
      filter: { account: ["lyss"] },
      panels: [{ form: "area", measure: "usd_modeled", split: "account", filter: {}, stack: false, annotate: [] }],
    },
    ...over,
  };
}

describe("the report model", () => {
  test("it carries the window, the cover's lists and the panel's series", () => {
    const m = reportModel(input());
    expect(m.version).toBe(REPORT_VERSION);
    expect(m.cover.title).toContain("modeled spend");
    expect(m.cover.hosts).toEqual(["studio", "lab"]);
    expect(m.cover.accounts).toEqual(["lyss", "tx-team"]);
    expect(m.cover.claude).toBe("2.1.319");
    expect(m.cover.anonymized).toBe(false);
    expect(m.panels.length).toBe(1);
    expect(m.panels[0].series.map((s) => s.label)).toEqual(["lyss", "tx-team"]);
  });

  test("a number that could not be measured is said, not shown as zero", () => {
    const m = reportModel(
      input({ kpis: { ...KPIS, spend: null, cacheShare: null, leading: null } }),
    );
    expect(m.kpis.find((k) => k.label === "spend")!.value).toBe("not priced");
    expect(m.kpis.find((k) => k.label === "cache read")!.value).toBe("—");
    expect(m.kpis.find((k) => k.label === "leading project")!.value).toBe("—");
  });

  test("the methodology says what is not in the file rather than leaving a reader to wonder", () => {
    const m = reportModel(input());
    const said = m.methods.map((x) => x.said).join(" ");
    expect(said).toContain("not a bill");
    expect(said).toContain("not exportable yet");
    expect(said).toContain("filtered to account: lyss");
  });
});

describe("anonymizing", () => {
  test("accounts, hosts, projects and the spec's filters are all relabelled", () => {
    const m = anonymizeReport(reportModel(input()), "account");
    expect(m.cover.anonymized).toBe(true);
    expect(m.cover.accounts).toEqual(["account A", "account B"]);
    expect(m.cover.hosts).toEqual(["machine A", "machine B"]);
    /* The leading project is lettered with the same map the project split uses,
       so a KPI and a series label cannot name one project two ways. */
    expect(m.kpis.find((k) => k.label === "leading project")!.value).toBe("project A");
    expect(m.panels[0].series.map((s) => s.label)).toEqual(["account A", "account B"]);
    /* The spec's own filter value is as readable as a label on a chart. */
    expect(m.spec!.filter.account).toEqual(["account A"]);
    expect(m.spec!.name).toBe("a saved view");
  });

  test("the fold's own label is not an identity and keeps its name", () => {
    const m = anonymizeReport(
      reportModel(input({ series: [series({ key: "other", label: "other", slot: null })] })),
      "account",
    );
    expect(m.panels[0].series[0].label).toBe("other");
  });

  test("a label that is not the split's value is not renamed by a dimension it is not", () => {
    const m = anonymizeReport(reportModel(input({ split: "model" })), "model");
    expect(m.panels[0].series[0].label).toBe("lyss");
  });

  test("session, subagent and an exclusion are anonymised in the embedded spec", () => {
    const m = anonymizeReport(
      reportModel(
        input({
          split: "session",
          series: [series({ key: "sess-1", label: "sess-1", slot: 0 })],
          spec: {
            v: 1,
            name: "x",
            span: "7d",
            bucket: "auto",
            filter: {
              account: ["!lyss"],
              session: ["sess-1"],
              subagent: ["agent-9"],
            },
            panels: [],
          },
        }),
      ),
      "session",
    );
    expect(m.spec!.filter).toEqual({
      account: ["!account A"],
      session: ["session A"],
      subagent: ["subagent A"],
    });
    expect(m.panels[0].series[0].label).toBe("session A");
    expect(renderReport(m)).not.toContain("sess-1");
    expect(renderReport(m)).not.toContain("agent-9");
  });

  test("the methodology carries no raw filter value once the report is anonymised", () => {
    /* The shipped blocker: the file's lede said "anonymized" while its own
       methods paragraph named the account, session and project. */
    const m = anonymizeReport(
      reportModel(
        input({
          filter: {
            account: ["lyss"],
            session: ["sess-secret-123"],
            project: ["!secret-project"],
          },
          spec: {
            v: 1,
            name: "x",
            span: "7d",
            bucket: "auto",
            filter: {
              account: ["lyss"],
              session: ["sess-secret-123"],
              project: ["!secret-project"],
            },
            panels: [],
          },
        }),
      ),
      "account",
    );
    const html = renderReport(m);
    for (const raw of ["lyss", "sess-secret-123", "secret-project"]) {
      expect(html).not.toContain(raw);
    }
    expect(html).toContain("filtered to account: account A");
    expect(html).toContain("session: session A");
    expect(html).toContain("project: !project A");
  });

  test("an empty window keeps its dash instead of inventing a project", () => {
    const m = anonymizeReport(
      reportModel(input({ kpis: { ...KPIS, leading: null } })),
      "account",
    );
    expect(m.kpis.find((k) => k.label === "leading project")!.value).toBe("—");
  });
});

describe("the file", () => {
  test("it is self-contained: no external script, stylesheet, font or image", () => {
    const html = renderReport(reportModel(input()));
    expect(html).toContain("<!doctype html>");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain("@media print");
  });

  test("a name with markup in it is escaped, in the document and in the embedded JSON", () => {
    const html = renderReport(
      reportModel(input({ title: 'a <script>alert("x")</script> title' })),
    );
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<\\/script");
  });

  test("the model is embedded once, and the table is the numbers behind the chart", () => {
    const html = renderReport(reportModel(input()));
    expect(html.match(/id="volery-report"/g)?.length).toBe(1);
    expect(html).toContain("the numbers behind it");
    expect(html).toContain("$1.50");
  });

  test("a file too large to carry is refused rather than cut down", () => {
    const huge = reportModel(
      input({
        series: [
          series({
            points: Array.from({ length: 140_000 }, (_, i) => ({ at: NOW - i * 1000, value: i })),
          }),
        ],
      }),
    );
    expect(() => reportFile(huge)).toThrow(/at most 4 MB/);
  });

  test("a file name says what it is and sorts by day", () => {
    expect(reportName("the last 7 days · modeled spend", NOW)).toBe(
      "the-last-7-days-modeled-spend-2026-11-12.html",
    );
    expect(reportName("", NOW)).toMatch(/^volery-\d{4}-\d{2}-\d{2}\.html$/);
  });

  test("a one-bucket series is a dot, as both app presentations draw it", () => {
    const html = renderReport(
      reportModel(
        input({
          series: [series({ points: [{ at: NOW, value: 5 }], total: 5 })],
        }),
      ),
    );
    expect(html).toMatch(/<circle cx="[\d.]+" cy="[\d.]+" r="3"/);
    /* And no zero-width area or one-segment line, which drew nothing. */
    expect(html).not.toMatch(/<path d="M[\d.]+,[\d.]+ Z"/);
  });

  test("a report with no split has no empty legend and no empty column heading", () => {
    const html = renderReport(
      reportModel(input({ split: null, series: [series({ label: "" })] })),
    );
    expect(html).not.toContain('<ul class="legend">');
    expect(html).not.toContain("<th></th>");
    expect(html).toContain("<th>value</th>");
    /* The tooltip names the unnamed series rather than opening on a blank. */
    expect(html).toContain("· value $1.50");
  });

  test("two series stack, as the app draws them, so the axis is the total", () => {
    const same = { points: [{ at: NOW, value: 5 }], total: 5 };
    const html = renderReport(
      reportModel(
        input({
          series: [
            series(same),
            series({ ...same, key: "tx-team", label: "tx-team", slot: 1, color: "#d55181" }),
          ],
        }),
      ),
    );
    /* A one-bucket run is a dot per series; the second sits above the first
       because its band starts where the first ends. */
    const ys = [...html.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(ys[0]).toBeGreaterThan(ys[1]);
  });

  test("an empty series draws a file rather than throwing", () => {
    const html = renderReport(
      reportModel(input({ series: [series({ points: [], total: 0 })] })),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("the numbers behind it");
  });
});

describe("what the model must never carry", () => {
  test("a model's fields are the ones listed and nothing is read off a live class", () => {
    const m: ReportModel = reportModel(input());
    expect(Object.keys(m).sort()).toEqual(
      ["cover", "kpis", "methods", "panels", "spec", "version"].sort(),
    );
  });
});
