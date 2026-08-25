import { mount } from "svelte";
import "./lib/tokens.css";
/* Imported for its side effect, and imported *here* on purpose: constructing
   `ink` writes the stored theme onto the root element, and this is the last
   point that happens before `mount` draws anything. Later — in App.svelte's
   own setup, say — and the app paints the base theme and re-themes itself a
   frame afterwards, which is a flash on every launch. After tokens.css, since
   the properties it sets are overrides of what that file declares. */
import "./lib/theme.svelte";
import App from "./App.svelte";
import { fitNerdSymbols } from "./lib/nerd";
import Peek from "./lib/Peek.svelte";

/* Both windows load the same bundle; the query string picks the root. The peek
   is a second Tauri window rather than an OS notification, so it can be drawn
   in the studio's own language instead of Windows'. */
const isPeek = new URLSearchParams(location.search).has("peek");
if (isPeek) document.documentElement.classList.add("peek-window");

/* After tokens.css and the theme, since what it measures is the `--mono` those
   two settle on, and before `mount` so the first thing drawn already has it. */
fitNerdSymbols();

/* Chromium's own menu never appears in Skein — an undecorated window whose
   header is its title bar has no business offering "Reload" and "Save image
   as…". Suppressed here rather than in App.svelte so it covers both roots and
   anything outside the studio's own tree. Where a right-click has something to
   say, App.svelte has already opened its own menu by the time this runs; where
   it has nothing, the correct answer is no menu, so this is the whole
   behaviour. Note this also removes the dev inspector's right-click — F12 and
   the devtools shortcut still work. */
window.addEventListener("contextmenu", (e) => e.preventDefault());

export default mount(isPeek ? Peek : App, {
  target: document.getElementById("app")!,
});
