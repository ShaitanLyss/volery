/* The analytics room on its own, in a browser.
 *
 * `bun run dev`, then open /analytics.html. No Tauri, no store and no agent: the
 * room's reader is a fixture, so the same component that reads the real command
 * draws made-up facts here. `?empty=1` is a store that has never recorded
 * anything and `?quiet=1` is a working wall with nothing in the window, which
 * are the two states the room exists to tell apart.
 *
 * Dev only: Vite's build input is `index.html`, so nothing here reaches an
 * installer. `test/analyticsroom.test.ts` asserts that nothing else imports the
 * fixture.
 */
import { mount } from "svelte";
import "./lib/tokens.css";
import Analytics from "./lib/Analytics.svelte";
import { fixtureWindow, type FixtureMode } from "./lib/analyticsfixture";
import { windowRequest, type AnalyticsWindow } from "./lib/analyticsroom";

const asked = new URLSearchParams(location.search);
const mode: FixtureMode = asked.has("empty") ? "empty" : asked.has("quiet") ? "quiet" : "normal";

/* `?page=1` opens the document presentation, `?room=1` the instrument; without
   either, the remembered choice for the wall — and `v` swaps them here exactly
   as it does in the app, which is how the swap is looked at without a wall. */
const as = asked.has("page") ? "page" : asked.has("room") ? "room" : undefined;

mount(Analytics, {
  target: document.getElementById("app")!,
  props: {
    as,
    mode: "wall",
    onclose: () => location.reload(),
    read: async (span: string, now: number): Promise<AnalyticsWindow> =>
      fixtureWindow(windowRequest(span, now), mode),
  },
});
