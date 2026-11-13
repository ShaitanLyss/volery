/* The accounts panel on its own, in a browser.
 *
 * `bun run dev`, then open /accounts.html. No Tauri, no store and no credential:
 * the registry and its readings are `waterfall.standIn` — the same one the
 * control surface spends an allowance with — and the share a cap is measured on
 * is the real reader fed real-shaped fixtures.
 *
 * It exists because the panel draws two numbers that have to agree: your own
 * share of a window, and the ceiling beside it. That arithmetic is
 * `accounts.ts::shareFor`, called by the panel and by the door, and a copy of it
 * living in the component is exactly the divergence nobody would notice until a
 * cap stopped working on a shared account.
 *
 * Three things on that page are faults the browser causes rather than the
 * panel: claude code is not found, the registry is not read, and the rate
 * cannot be folded, because all three are `invoke`s with nothing behind them.
 * They are left drawn, because silencing them would be teaching the panel that
 * it may run without a wall — which is the one thing it may not.
 *
 * Dev only: Vite's build input is `index.html`, so nothing here reaches an
 * installer.
 */
import { mount } from "svelte";
import "./lib/tokens.css";
import Accounts from "./lib/Accounts.svelte";
import Tooltip from "./lib/Tooltip.svelte";
import { waterfall } from "./lib/waterfall.svelte";
import { ownShare } from "./lib/ownshare.svelte";
import type { AllowanceCost, AllowanceSample } from "./lib/allowancesamples";

const NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/* Two subscriptions and a shared one. `lyss` is capped at 50 and this wall's
   own work has moved 20 of the 70 the account is at, so the row reads
   "20% of 70%" against "stop at 50 %" and is *not* blocked: somebody else's
   usage is half of that window. `tx-team` has no ceiling, which is where the
   share has nothing to be a share of and the row draws the account's figure. */
waterfall.standIn([
  {
    label: "lyss",
    caps: { session: 50 },
    /* A brake plan, so the pacing control and its "by 1.15×" field can be
       looked at with no store behind them. */
    plan: { on: true, mode: "brake", threshold: 1.15 },
    windows: [
      { kind: "session", group: "session", used: 70, severity: "normal", resetsAt: NOW + HOUR, scope: null, active: true },
      { kind: "weekly_all", group: "weekly", used: 12, severity: "normal", resetsAt: NOW + 72 * HOUR, scope: null, active: false },
    ],
  },
  {
    /* A ceiling of zero, which is a wall across the account rather than "no
       ceiling": the state that sent Lyss looking for a reason nothing would
       use an account that had just come back. */
    label: "personal",
    caps: { session: 0 },
    windows: [
      { kind: "session", group: "session", used: 40, severity: "normal", resetsAt: NOW + HOUR, scope: null, active: true },
      { kind: "weekly_all", group: "weekly", used: 8, severity: "normal", resetsAt: NOW + 72 * HOUR, scope: null, active: false },
    ],
  },
  {
    label: "tx-team",
    windows: [
      { kind: "session", group: "session", used: 20, severity: "normal", resetsAt: NOW + 2 * HOUR, scope: null, active: true },
      { kind: "weekly_all", group: "weekly", used: 4, severity: "normal", resetsAt: NOW + 96 * HOUR, scope: null, active: false },
    ],
  },
]);

const samples: AllowanceSample[] = [10, 20, 30].map((used, i) => ({
  at: NOW + i * 10 * MIN,
  host: "studio",
  account: "lyss",
  kind: "session",
  scope: "",
  used,
  resetsAt: NOW + HOUR,
  severity: "normal",
  plan: "max",
  source: "poll",
}));

const costs: AllowanceCost[] = [0, 10, 20].map((step) => ({
  at: NOW + step * MIN,
  host: "studio",
  session: "fixture-1",
  account: "lyss",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  provenance: "transcript",
  card: "fixture-card",
  inTok: 1_000,
  outTok: 0,
  cacheRead: 0,
  write5m: 0,
  write1h: 0,
  requests: 1,
}));

ownShare.settle(samples, costs);

mount(Accounts, {
  target: document.getElementById("app")!,
  props: { onclose: () => {} },
});

/* And the tip host, which `App.svelte` mounts once at the root: without it the
   panel's hovers would attach and draw nothing, and the preview would be the
   one place a tooltip could not be looked at. */
mount(Tooltip, { target: document.body });
