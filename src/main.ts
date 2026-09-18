import { mount } from "svelte";
import "./lib/tokens.css";
/* Imported for its side effect, and imported *here* on purpose: constructing
   `ink` writes the stored theme onto the root element, and this is the last
   point that happens before `mount` draws anything. Later — in App.svelte's
   own setup, say — and the app paints the base theme and re-themes itself a
   frame afterwards, which is a flash on every launch. After tokens.css, since
   the properties it sets are overrides of what that file declares. */
import "./lib/theme.svelte";
/* The second ring, for the same reason and at the same point. This one
   matters more than the first: `ink` only re-sets the transcript, so a late
   apply is a flicker in the panel, where a skin owns the ground — applying it
   after `mount` is a full window of near-black before a light wall on every
   single launch. */
import "./lib/palette.svelte";
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

/* And no drag ever starts *inside* the webview, which is not a preference — it
   is the one gesture that takes the whole window's input away.

   Selecting a word in the transcript arms it: the next press on that selection
   plus a pixel of travel is an HTML5 text drag, and on Windows that drag has
   nowhere to go. Tauri's drop support (`dragDropEnabled`, on by default and the
   whole of how a folder becomes a card and an image lands on the wall) is
   implemented in wry by walking the WebView2 child windows, calling
   `RevokeDragDrop` on each and registering an `IDropTarget` of its own
   (wry 0.55.1, `src/webview2/drag_drop.rs`). That target understands exactly
   one clipboard format, `CF_HDROP` — a list of file paths. Anything else and
   `DragEnter` returns `S_OK` having set neither `enter_is_valid` nor
   `*pdwEffect`, and `Drop` never writes `*pdwEffect` at all.

   So a text drag is a drag whose source is Chromium and whose target was taken
   out from under it: `DoDragDrop` is a modal loop that owns the mouse and the
   keyboard for as long as it runs, and it is handed back a result nobody on
   either end agrees about. What that looks like from the room is the bug as
   reported — the wall still paints, cards still tick, the backdrop still
   drifts, and not one click or keypress reaches anything.

   Refusing `dragstart` costs this app nothing, which is the reason it is the
   fix rather than turning `dragDropEnabled` off. **Volery contains no HTML5
   drag-and-drop.** Every drag it answers is pointer events — the wall, the
   panel grip, widgets, images, and Kanban's columns, which chose pointer events
   on their own argument (see `.claude/rules/asana.md`). And every drop it
   accepts is an OS file drag delivered by `onDragDropEvent`, which fires no DOM
   drag event on any element whatsoever — App.svelte's `dropTargetAt` exists
   precisely because nothing under the cursor is ever told it is being hovered.
   The two `draggable="false"` attributes in `Browser.svelte` and
   `ImageNode.svelte` were this same bug met twice and answered locally; this is
   that answer stated once, for every element there is.

   Read off wry's source rather than probed against the running app: this
   machine has no MSVC toolchain, so nothing here can build or drive the window
   (`.claude/rules/build.md`).

   Capture phase, so it lands before anything that might want to stop
   propagation. It reaches this document only — an `ask` mockup renders in an
   iframe with a document of its own, so agent-authored markup that sets
   `draggable` is still able to arm this. Nothing has yet. */
window.addEventListener("dragstart", (e) => e.preventDefault(), true);

export default mount(isPeek ? Peek : App, {
  target: document.getElementById("app")!,
});
