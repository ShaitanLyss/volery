<script lang="ts">
  /* A page you and the agent are both driving.
   *
   * The only widget on this wall you work *in* rather than read, and the only
   * one that takes the pointer away from the canvas. It draws a page in the
   * Chrome `browser.rs` owns — the same browser `@playwright/mcp
   * --cdp-endpoint` is attached to — so a click here lands in the session the
   * agent has, with its cookies and its login. Proved end to end 2026-09-03: a
   * click dispatched from a second, independent CDP client landed in a page
   * Playwright was driving, and the page's own counter went from 0 to 1.
   *
   * Two readings. `page` is the picture and the pointer. `log` is the same
   * page's console and network over `logface.ts`'s substrate, which is the
   * reading you want when the picture looks right and the app is still wrong —
   * a fifth log over the four the rule file already describes, and the first
   * whose lines are pushed by a socket rather than read off a pipe or a file.
   *
   * Paints no background of its own. `WidgetNode` is the only thing that fills,
   * which is what makes the `bare` frame possible at all — a face painting
   * `var(--ink)` would show the wall through the frame and then cover it
   * straight back up. */

  import { onDestroy } from "svelte";
  import LogFace from "./LogFace.svelte";
  import LogTail from "./LogTail.svelte";
  import { emptyBecause, linesFor, tail, type Row } from "./logface";
  import {
    buttonOf,
    caption,
    fitFrame,
    keyMessages,
    modifiersOf,
    normalizeConfig,
    toPage,
    type FrameMeta,
  } from "./browser";
  import type { Pane, Target } from "./pane.svelte";
  import type { Widget } from "./widgets";

  let { widget, pane }: { widget: Widget; pane: Pane } = $props();

  const cfg = $derived(normalizeConfig(widget.config));

  /* Derived rather than captured once, for the reason `AppLog` and
     `Spotify.svelte` both give: `widget` is a prop, and reading `.id` at setup
     would pin this face to whichever widget it happened to draw first. */
  const id = $derived(`browser-${widget.id}`);

  /** Which page this widget is about.
   *
   * The knob wins when it names one that exists; otherwise the first page
   * there is. Falling back rather than drawing nothing is the same call the
   * three logs' `FOLLOW` makes — a wall where the named page has been closed
   * still has one honest answer, and the header says which page it settled on
   * either way. */
  const subject = $derived<Target | null>(
    pane.targets.find((t) => t.id === cfg.target) ?? pane.targets[0] ?? null,
  );

  const seeing = $derived(cfg.variant === "page");

  /* Attaching is an effect rather than something the buttons do, because the
     subject moves on its own: a page the agent navigates away from closes its
     target and `refresh` replaces the list under us. `attach` is idempotent in
     both arguments for that reason — it is called on every knob turn. */
  $effect(() => {
    const t = subject;
    if (!t) return;
    pane.attach(id, t, seeing);
  });

  onDestroy(() => pane.detach(id));

  const frame = $derived(subject ? (pane.frames[subject.id] ?? null) : null);
  const meta = $derived<FrameMeta | null>(subject ? (pane.metas[subject.id] ?? null) : null);

  /* ── the picture ─────────────────────────────────────────────────────── */

  let box = $state({ w: 0, h: 0 });
  let shown = $state({ w: 0, h: 0 });

  /** Where the picture sits inside the widget, and what it was scaled by.
   *
   * `shown` is the *image's* natural size, which is a third number apart from
   * both the widget's box and the page's CSS viewport — conflating any two of
   * the three is the bug where clicks land near the right place at one window
   * size and nowhere near it at another. See `toPage`. */
  const fit = $derived(fitFrame(shown, box));

  function pointIn(e: PointerEvent | WheelEvent): { x: number; y: number } | null {
    if (!meta) return null;
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return toPage({ x: e.clientX - r.left, y: e.clientY - r.top }, fit, meta);
  }

  function onDown(e: PointerEvent) {
    if (!cfg.interactive || !subject) return;
    const pt = pointIn(e);
    if (!pt) return;
    /* Focus so keys come here. The page is driven over CDP and needs no real
       focus of its own, but *this element* has to be the document's focus or
       the wall's keyboard ladder eats the keystrokes. */
    (e.currentTarget as HTMLElement).focus();
    pane.mouse(subject.id, "mousePressed", {
      ...pt,
      button: buttonOf(e.button),
      buttons: e.buttons,
      clickCount: 1,
      modifiers: modifiersOf(e),
    });
  }

  function onUp(e: PointerEvent) {
    if (!cfg.interactive || !subject) return;
    const pt = pointIn(e);
    if (!pt) return;
    pane.mouse(subject.id, "mouseReleased", {
      ...pt,
      button: buttonOf(e.button),
      buttons: e.buttons,
      clickCount: 1,
      modifiers: modifiersOf(e),
    });
  }

  function onMove(e: PointerEvent) {
    if (!cfg.interactive || !subject) return;
    const pt = pointIn(e);
    if (!pt) return;
    pane.mouse(subject.id, "mouseMoved", {
      ...pt,
      button: e.buttons ? buttonOf(e.button) : "none",
      buttons: e.buttons,
      modifiers: modifiersOf(e),
    });
  }

  /** The wheel, which has to be taken off the wall to work.
   *
   * `Canvas` puts a non-passive `wheel` listener on the surface and
   * `preventDefault`s every one of them to zoom the wall — which is why
   * `widgets.md` says nothing standing on the wall can be scrolled. A page is
   * the one thing here that genuinely must be, so the event is stopped before
   * it reaches that ancestor. The listener there is on the bubble phase, so
   * `stopPropagation` from a descendant is enough; `preventDefault` is still
   * ours to call, since the wall's would otherwise never run.
   */
  function onWheel(e: WheelEvent) {
    if (!cfg.interactive || !subject) return;
    const pt = pointIn(e);
    if (!pt) return;
    e.preventDefault();
    e.stopPropagation();
    pane.mouse(subject.id, "mouseWheel", {
      ...pt,
      deltaX: -e.deltaX,
      deltaY: -e.deltaY,
      modifiers: modifiersOf(e),
    });
  }

  function onKey(e: KeyboardEvent) {
    if (!cfg.interactive || !subject) return;
    /* Everything except the one gesture that must stay the wall's. Escape is
       how you stop a turn, and a page that swallowed it would make the widget a
       trap — you could not get out of it without the mouse. */
    if (e.key === "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    pane.keys(subject.id, keyMessages(e, e.type === "keydown" ? "down" : "up"));
  }

  /* ── the log reading ─────────────────────────────────────────────────── */

  const keeping = $derived((r: Row) => {
    if (cfg.showing === "console") return r.mark !== "net" && !isNet(r);
    if (cfg.showing === "problems") return r.tone !== "plain";
    return true;
  });

  /** Whether a row came off the network rather than the console. The gutter
   *  mark is the resource type Chrome reported (`document`, `xhr`, `script`),
   *  and the console's marks are its own levels — so the test is which
   *  vocabulary the mark belongs to rather than a second field nobody would
   *  keep in step. */
  const CONSOLE_MARKS = new Set([
    "console",
    "log",
    "error",
    "warning",
    "warn",
    "info",
    "debug",
    "assert",
    "trace",
    "table",
    "dir",
    "go",
  ]);
  function isNet(r: Row): boolean {
    return !CONSOLE_MARKS.has(r.mark ?? "");
  }

  const all = $derived(subject ? (pane.rows[subject.id] ?? []) : []);
  const cut = $derived(tail(all, cfg.showing === "all" ? null : keeping, linesFor(widget.h)));

  /** What the filter is called, in the words the knob used — `emptyBecause`
   *  assembles the sentence and this is the only half that is ours. */
  const narrowing = $derived(
    cfg.showing === "console" ? "in the console" : "failing or warning",
  );

  /* ── what the header says ────────────────────────────────────────────── */

  const pulse = $derived<"idle" | "live" | "pending" | "rest" | "dead">(
    pane.starting ? "pending" : !pane.status.running ? "idle" : subject ? "live" : "rest",
  );

  const down = $derived(
    pane.status.running
      ? null
      : {
          word: pane.starting ? "starting the browser…" : "the browser is not running",
          verb: pane.starting ? null : "start",
          press: () => void pane.start(),
        },
  );

  /* A page-less browser is not a fault and not an empty filter — it is a
     browser with nothing open, and the honest thing is to say so and offer the
     one gesture that helps. */
  const note = $derived(
    pane.fault
      ? pane.fault
      : !pane.status.running
        ? null
        : !subject
          ? "no page open — the agent has not opened one, and neither have you"
          : cfg.variant === "log"
            ? (emptyBecause(cut.hidden, narrowing) ??
              (cut.lines.length === 0 ? "nothing said yet" : null))
            : frame
              ? null
              : "waiting for the first frame — nothing on the page has changed yet",
  );
</script>

<LogFace
  {pulse}
  name={caption(subject)}
  sub={pane.status.running ? `chrome :${pane.status.port}` : ""}
  title={subject?.url}
  {down}
  {note}
>
  {#snippet chips()}
    {#if pane.status.running && subject}
      <button
        class="act"
        title="reload the page"
        onclick={() => pane.reload(subject!.id)}
      >
        reload
      </button>
      {#if cfg.variant === "page" && !cfg.interactive}
        <!-- Said out loud, because a page that silently ignores clicks is
             indistinguishable from a page that has hung. -->
        <span class="ro">read only</span>
      {/if}
    {/if}
  {/snippet}

  {#if cfg.variant === "log"}
    <LogTail rows={cut.lines} tint={true} />
  {:else if frame && meta}
    <!-- `data-live` takes the press off the wall, the way `data-text` does for
         a log's lines: without it `Canvas.groundDown` captures the pointer and
         the click never reaches the page. Unlike `data-text` this is not about
         selecting — so it deliberately does not pair with `user-select: text`,
         and `styles.test.ts` keys only on the text marker.

         `role="application"` is the honest role — this is a surface whose keys
         belong to something else, which is exactly what that role means — but
         svelte-check reads ARIA's *widget* roles as the interactive ones and
         `application` is a window role, so it warns about a div it has already
         been told is not a div. Ignored with the role stated rather than
         silenced by promoting this to a <button>, which would take Enter and
         Space for itself and is the one thing a page being typed into must not
         do. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="stage"
      data-live
      role="application"
      tabindex="0"
      aria-label="the page, click and type to drive it"
      bind:clientWidth={box.w}
      bind:clientHeight={box.h}
      onpointerdown={onDown}
      onpointerup={onUp}
      onpointermove={onMove}
      onwheel={onWheel}
      onkeydown={onKey}
      onkeyup={onKey}
    >
      <img
        src={frame}
        alt=""
        draggable="false"
        style="left:{fit.x}px; top:{fit.y}px; width:{fit.w}px; height:{fit.h}px"
        onload={(e) => {
          const el = e.currentTarget as HTMLImageElement;
          shown = { w: el.naturalWidth, h: el.naturalHeight };
        }}
      />
    </div>
  {/if}
</LogFace>

<style>
  .stage {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    /* The picture is the reading; nothing of the wall shows through it. */
    background: var(--paper-deep, #000);
    cursor: default;
  }

  .stage:focus-visible {
    /* Focus is meaningful here in a way it is nowhere else on the wall: it is
       what decides whether your keys go to the page or to the wall's own
       ladder, so it is drawn rather than suppressed. */
    outline: 1px solid var(--st-work);
    outline-offset: -1px;
  }

  .stage img {
    position: absolute;
    /* A frame arrives already the right shape; letting the browser smooth it
       further only softens text that was rendered crisp. */
    image-rendering: auto;
    user-select: none;
    -webkit-user-drag: none;
  }

  .act {
    font: inherit;
    color: var(--paper-dim);
    background: var(--ink-soft);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0 0.35em;
    cursor: pointer;
  }

  .act:hover {
    color: var(--paper);
  }

  .ro {
    color: var(--paper-faint);
  }
</style>
