/* The worth block on its own, in a browser (§22).
 *
 * `bun run dev`, then open /worth.html. No Tauri and no store: the readings are
 * built from synthetic hours, so this is how the heatmap and the lines are
 * looked at on a machine with no MSVC. Dev only: Vite's build input is
 * `index.html`, so nothing here reaches an installer.
 */
import { mount } from "svelte";
import "./lib/tokens.css";
import WorthPreview from "./lib/WorthPreview.svelte";

mount(WorthPreview, { target: document.getElementById("app")! });
