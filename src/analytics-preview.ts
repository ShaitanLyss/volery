/* The analytics room on its own, in a browser.
 *
 * `bun run dev`, then open /analytics.html. No Tauri, no store and no agent: the
 * room's reader is a fixture, so the same component that reads the real command
 * draws made-up facts here. `?empty=1` is a store that has never recorded
 * anything and `?quiet=1` is a working wall with nothing in the window, which
 * are the two states the room exists to tell apart. `?card=1` opens the
 * inspector on a made-up card, and `?card=1&quiet=1` on one older than the
 * facts, which is the card page's honesty case.
 *
 * Dev only: Vite's build input is `index.html`, so nothing here reaches an
 * installer. `test/analyticsroom.test.ts` asserts that nothing else imports the
 * fixture.
 */
import { mount } from "svelte";
import "./lib/tokens.css";
import Analytics from "./lib/Analytics.svelte";
import AnalyticsFace from "./lib/AnalyticsFace.svelte";
import { Analytics as AnalyticsReader } from "./lib/analyticsholder.svelte";
import {
  FIXTURE_FLEET,
  fixtureAllowanceCosts,
  fixtureAllowanceSamples,
  fixtureFundings,
  fixtureBehaviourReader,
  fixtureLife,
  fixturePromptReader,
  fixtureWatches,
  fixtureWindow,
  fixtureWorkReader,
  type FixtureMode,
  type VaultMode,
} from "./lib/analyticsfixture";
import { windowRequest, type AnalyticsWindow } from "./lib/analyticsroom";
import { live } from "./lib/live.svelte";
import { seedLive } from "./lib/analyticsfixture";
import { waterfall } from "./lib/waterfall.svelte";
import { standMachine } from "./lib/machineread.svelte";
import type { MachineNow } from "./lib/machinefacts";

const asked = new URLSearchParams(location.search);
const mode: FixtureMode = asked.has("empty") ? "empty" : asked.has("quiet") ? "quiet" : "normal";

/* `?page=1` opens the document presentation, `?room=1` the instrument; without
   either, the remembered choice for the wall — and `v` swaps them here exactly
   as it does in the app, which is how the swap is looked at without a wall. */
const as = asked.has("page") ? "page" : asked.has("room") ? "room" : undefined;

/* `?tab=prompts` opens the trace, `?tab=spend` the money. `?vault=none`,
   `?vault=locked` (the default) and `?vault=unlocked` choose the vault state
   the fixture starts in, which is what makes a locked body and an open one two
   page loads rather than two edits. */
const tab =
  asked.get("tab") === "prompts"
    ? "prompts"
    : asked.get("tab") === "work"
      ? "work"
      : asked.get("tab") === "behaviour"
        ? "behaviour"
        : asked.get("tab") === "spend"
          ? "spend"
          : undefined;
const vault: VaultMode =
  asked.get("vault") === "none" ? "none" : asked.get("vault") === "unlocked" ? "unlocked" : "locked";

/* `?widget=stat|chart|board` draws the wall widget on its own, at `?w=` by
   `?h=` pixels, `?split=project` for the divided reading. It is the third
   surface of one spec (§12), and the only way to look at it with no wall behind
   it — the app's own path needs a widget hung up, a store and a minute of facts. */
/* `?report=1` renders a report file from the fixture and shows it in a frame,
   which is the only way to look at §13's output with no wall to export from.
   `?anon=1` anonymises it; the panel's own switch is exercised in the app. */
if (asked.has("report")) {
  const { renderReport, anonymizeReport, reportModel } = await import("./lib/analyticsreport");
  const { pageModel } = await import("./lib/analyticpage");
  const { windowRequest } = await import("./lib/analyticsroom");
  const now = Date.now();
  const win = fixtureWindow(windowRequest("7d", now), mode);
  const page = pageModel({
    window: win,
    filter: {},
    measure: "usd_modeled",
    split: "account",
    bucket: "1d",
    span: "7d",
    book: new Map(),
  });
  let report = reportModel({
    window: { since: win.since, until: win.until },
    series: page.series,
    kpis: page.kpis,
    span: "7d",
    measure: "usd_modeled",
    unit: "usd",
    bucket: "1d",
    split: "account",
    filter: {},
    title: "the last 7 days · modeled spend by account",
    now,
    version: "preview",
    claude: [...new Set(win.rows.map((r) => r.cli).filter(Boolean))].sort().pop() ?? null,
    hosts: [...new Set(win.rows.map((r) => r.host))],
    accounts: [...new Set(win.rows.map((r) => r.account))],
    spec: null,
  });
  if (asked.has("anon")) report = anonymizeReport(report, "account");
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:100%;height:100vh;border:0;display:block";
  frame.srcdoc = renderReport(report);
  document.body.style.margin = "0";
  document.getElementById("app")!.append(frame);
}

const widgetMode = asked.get("widget");
if (asked.has("report")) {
  /* Mounted above; the room must not draw underneath it. */
} else if (widgetMode) {
  const box = document.createElement("div");
  box.style.cssText = `width:${asked.get("w") ?? "340"}px;height:${asked.get("h") ?? "240"}px;container-type:size;background:var(--ink);border:1px solid var(--edge);border-radius:8px;overflow:hidden`;
  document.getElementById("app")!.append(box);
  const holder = new AnalyticsReader(
    async (span: string, now: number): Promise<AnalyticsWindow> =>
      fixtureWindow(windowRequest(span, now), mode),
    async (span: string, now: number): Promise<AnalyticsWindow> => {
      const req = windowRequest(span, now);
      const width = Math.max(0, req.until - req.since);
      return fixtureWindow({ since: req.since - width, until: req.since, fine: req.fine }, mode);
    },
  );
  mount(AnalyticsFace, {
    target: box,
    props: {
      widget: {
        id: "preview",
        kind: "analytics",
        x: 0,
        y: 0,
        w: Number(asked.get("w") ?? 340),
        h: Number(asked.get("h") ?? 240),
        z: 0,
        glassX: null,
        glassY: null,
        config: {
          variant: widgetMode,
          spec: JSON.stringify({
            name: "weekly spend",
            span: "7d",
            panels: [{ measure: "usd_modeled", split: asked.get("split"), form: "area" }],
          }),
        },
      },
      analytics: holder,
      onupdate: () => {},
      onopen: () => {},
    },
  });
} else {
  seedLive(live, Date.now());
  /* A plan on one account, so the room's week-against-the-plan block can be
     looked at with no store behind it. `lyss` carries a throttle plan and a
     week in the fixture samples; `tx-team` has none, which is the wall where
     the block draws nothing for that account. */
  waterfall.standIn([
    { label: "lyss", plan: { on: true, mode: "throttle", threshold: 1.15 }, windows: [] },
    { label: "tx-team", windows: [] },
  ]);
  /* And the machine series, made up: a working day's shape over whatever span
     the surface asks for, so the block and its sparklines can be looked at with
     no store behind them. A GPU that peaks for a stretch is the case worth
     drawing — a flat line reads as a broken reading. */
  standMachine((from, to) => {
    const rows: MachineNow[] = [];
    const step = Math.max(60_000, Math.ceil((to - from) / 720));
    for (let at = from; at < to; at += step) {
      const hour = new Date(at).getHours() + new Date(at).getMinutes() / 60;
      const day = Math.sin(((hour - 6) / 24) * Math.PI * 2);
      const busy = Math.max(0, day);
      rows.push({
        at,
        cpu: 8 + busy * 62,
        memUsed: (9 + busy * 7) * 1024 ** 3,
        memTotal: 32 * 1024 ** 3,
        gpu: busy > 0.6 ? 30 + busy * 60 : 2,
        diskFree: (420 - (at - from) / 86_400_000 / 2) * 1024 ** 3,
        netRx: 40_000 + busy * 900_000,
        netTx: 12_000 + busy * 220_000,
        worktrees: 1,
      });
    }
    return rows;
  });
  mount(Analytics, {
    target: document.getElementById("app")!,
    props: {
      as,
      asTab: tab,
      /* `?card=1` opens the inspector on a made-up card (§11.10); `?quiet=1`
         with it makes that card older than the facts, which is the state the
         page has to qualify rather than draw a lifetime share over. */
      asCard: asked.has("card") ? "preview-card" : undefined,
      /* `?export=1` opens the report panel; writing it needs a wall, so the
         panel's own write is the one thing the preview cannot finish. */
      asExport: asked.has("export"),
      life: fixtureLife(mode),
      samples: async (from, to) => fixtureAllowanceSamples(from, to),
      costs: async (from, to) => fixtureAllowanceCosts(from, to),
      /* `?funding=0` is a breakdown that could not be read, which is the state
         the block has to word rather than draw an empty day over. */
      fundings: () => (asked.get("funding") === "0" ? null : fixtureFundings()),
      fleet: FIXTURE_FLEET,
      mode: "wall",
      prompts: fixturePromptReader(mode, vault),
      work: fixtureWorkReader(mode),
      behaviour: fixtureBehaviourReader(mode),
      /* The live panel is fed by the event stream, which a preview has none of,
         so it is seeded with five minutes of made-up traffic. It is the one
         reading on this page that cannot come from a fixture reader. */
      onclose: () => location.reload(),
      read: async (span: string, now: number): Promise<AnalyticsWindow> =>
        fixtureWindow(windowRequest(span, now), mode),
      ...fixtureWatches(),
    },
  });
}
