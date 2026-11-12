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
const widgetMode = asked.get("widget");
if (widgetMode) {
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
  mount(Analytics, {
    target: document.getElementById("app")!,
    props: {
      as,
      asTab: tab,
      /* `?card=1` opens the inspector on a made-up card (§11.10); `?quiet=1`
         with it makes that card older than the facts, which is the state the
         page has to qualify rather than draw a lifetime share over. */
      asCard: asked.has("card") ? "preview-card" : undefined,
      life: fixtureLife(mode),
      mode: "wall",
      prompts: fixturePromptReader(mode, vault),
      work: fixtureWorkReader(mode),
      behaviour: fixtureBehaviourReader(mode),
      onclose: () => location.reload(),
      read: async (span: string, now: number): Promise<AnalyticsWindow> =>
        fixtureWindow(windowRequest(span, now), mode),
      ...fixtureWatches(),
    },
  });
}
