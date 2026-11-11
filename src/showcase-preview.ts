/* The tour on its own, in a browser.
 *
 * `bun run dev`, then open /showcase.html. No Tauri, no store and no agent, so
 * it runs anywhere a webview does. `?at=security` opens a chapter directly,
 * which is how each one is checked without clicking through the others.
 *
 * Dev only: Vite's build input is `index.html`, so nothing here reaches an
 * installer.
 */
import { mount } from "svelte";
import "./lib/tokens.css";
import Showcase from "./lib/Showcase.svelte";
import { CHAPTERS, type ChapterId } from "./lib/showcase";

const asked = new URLSearchParams(location.search).get("at");
const start = (CHAPTERS.find((c) => c.id === asked)?.id ?? "why") as ChapterId;

mount(Showcase, {
  target: document.getElementById("app")!,
  props: { start, onclose: () => location.reload() },
});
