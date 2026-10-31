<script lang="ts">
  /* Immersive: one screen filling the window, in either view.
   *
   * A root overlay, the `Lightbox`/`Spyglass` arrangement, because it has to
   * work over the wall and over chat view alike and neither room's tree is the
   * other's. It owns no session: it borrows the one already open — a tile on
   * the wall, the chat sheet's, a grid cell's — and hands that session's worker
   * two canvases of its own (`casts.present`), so going immersive is a surface
   * swap and a want with `focused: true`, never a second socket. The host
   * answers with the full rendition at the monitor's refresh, capped at 120.
   *
   * **Everything goes to the machine.** Keys, the wheel, the right button,
   * Escape: this is the one place on the wall where the wall keeps nothing for
   * itself but the way out, and the way out is a key held rather than a key
   * pressed (`cast.ts::EscapeHold`, Lyss's pick on 2026-10-31) — so a tap still
   * closes the far machine's dialog. Alt+Tab is the OS's and leaves the window,
   * which lifts everything held on the far side (`releaseAll` on blur): a key
   * whose up never arrives is a key held down for ever.
   *
   * The pointer is the OS's own wearing the remote cursor's shape
   * (`casts.showing[…].cursor`, a PNG built in the worker), so it moves at the
   * hardware's rate rather than a frame behind your hand. */

  import { untrack } from "svelte";
  import { casts, useEscapeHold } from "./cast.svelte";
  import { fitIn, monitorLabel, parseScreen, statsLine, HOLD_MS } from "./cast";
  import { keyInput, pointerInput, releaseAll, wheelAccumulator } from "./castinput";

  let { sid }: { sid: string } = $props();

  /* Read once: whether this session drives is its tile's decision
     (`cast.ts::drivableAt`), and immersive only borrows the session. A
     watched screen goes immersive as a bigger picture — nothing is sent, and
     Escape simply leaves, since there is no machine for a tap to reach. */
  const drives = untrack(() => casts.drivable[sid] === true);

  const showing = $derived(casts.showing[sid] ?? null);
  const key = $derived(casts.up[sid] ?? "");
  const monitor = $derived(casts.monitorOf(key));
  const label = $derived(
    `${casts.machineOf(key)}${monitor ? ` · ${monitorLabel(monitor, parseScreen(key).host ? [monitor] : casts.monitors)}` : ""}`,
  );

  let stage = $state<HTMLDivElement | null>(null);
  /* The hint, for the first moments only: said once, then the picture is the
     whole window. */
  let hinting = $state(true);

  function surface(el: HTMLDivElement) {
    const video = document.createElement("canvas");
    const overlay = document.createElement("canvas");
    video.className = "video";
    overlay.className = "cursor";
    el.append(video, overlay);
    /* Untracked as a whole — the tile's attachment says why. */
    const { id, off } = untrack(() => {
      const id = sid;
      const off = casts.present(id, video, overlay);
      if (drives) casts.drive(id, true);
      return { id, off };
    });
    const ro = new ResizeObserver(() => casts.focusSize(id, el.clientWidth, el.clientHeight));
    ro.observe(el);
    el.focus();
    const t = setTimeout(() => (hinting = false), 2400);
    return () => {
      clearTimeout(t);
      ro.disconnect();
      untrack(() => {
        if (drives) {
          casts.input(id, releaseAll());
          casts.drive(id, false);
        }
        off();
      });
      video.remove();
      overlay.remove();
    };
  }

  const wheel = wheelAccumulator();
  const escape = useEscapeHold(
    () => sid,
    () => casts.unfocus(),
  );

  function fitNow() {
    if (!stage) return null;
    const cfg = showing?.config;
    const src = monitor ? { w: monitor.w, h: monitor.h } : cfg ? { w: cfg.w, h: cfg.h } : null;
    if (!src) return null;
    const r = stage.getBoundingClientRect();
    const f = fitIn(src, { w: r.width, h: r.height });
    return { x: r.left + f.x, y: r.top + f.y, w: f.w, h: f.h };
  }

  function onPointer(act: "down" | "up" | "move") {
    return (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      if (act === "down") {
        /* Guarded for the tile's reason: a capture that throws must not
           take the press with it. */
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* the press still goes */
        }
      }
      if (act === "up" && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      const fit = fitNow();
      if (fit && drives) casts.input(sid, pointerInput(e, fit, act));
    };
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (drives) casts.input(sid, wheel(e));
  }

  function onKey(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" || e.key === "Escape") {
      if (!drives) {
        if (e.type === "keydown") casts.unfocus();
        return;
      }
      if (e.type === "keydown") escape.down();
      else escape.up();
      return;
    }
    if (drives) casts.input(sid, keyInput(e));
  }

  function onBlur() {
    escape.cancel();
    if (drives) casts.input(sid, releaseAll());
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="immersive"
  bind:this={stage}
  data-live
  data-immersive={sid}
  role="application"
  tabindex="0"
  aria-label={`${label} — immersive; hold escape to come back`}
  style:cursor={showing?.cursor ?? "default"}
  style:--hold-ms="{HOLD_MS}ms"
  {@attach surface}
  onpointerdown={onPointer("down")}
  onpointerup={onPointer("up")}
  onpointermove={onPointer("move")}
  onwheel={onWheel}
  onkeydown={onKey}
  onkeyup={onKey}
  onblur={onBlur}
  oncontextmenu={(e) => {
    e.preventDefault();
    e.stopPropagation();
  }}
>
  {#if hinting || escape.holding || showing?.holding || showing?.state !== "live"}
    <div class="pill" class:holding={escape.holding || showing?.holding}>
      <!-- The host's hook has the keyboard for a far screen held immersive, so
           the ring may be the host's report (`showing.holding`) rather than
           ours; leaving on `done` is the holder's. -->
      {#if escape.holding || showing?.holding}
        <span class="ring" aria-hidden="true"></span>
        <span>keep holding esc to leave</span>
      {:else if showing && showing.state !== "live"}
        <span>{label} · {showing.state}{showing.why ? ` — ${showing.why}` : ""} · {drives ? "hold esc" : "esc"} to leave</span>
      {:else}
        <span>{label}{statsLine(showing?.stats ?? null, showing?.path ?? null) ? ` · ${statsLine(showing?.stats ?? null, showing?.path ?? null)}` : ""}{drives ? " · hold esc to come back" : " · watching · esc to come back"}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .immersive {
    /* The home screen while the studio is spread, as the lightbox is: a
       screen is drawn on one monitor, and stretching it over three would be a
       picture nobody can point at. */
    position: fixed;
    inset: 0;
    z-index: 80;
    background: #000;
    outline: none;
  }

  .immersive :global(canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .immersive :global(canvas.video) {
    object-fit: contain;
  }

  .pill {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.6em;
    padding: 0.35em 0.9em;
    font-family: var(--util);
    font-size: 12px;
    color: var(--paper-dim);
    background: color-mix(in srgb, var(--ink) 92%, transparent);
    border: 1px solid var(--edge);
    border-radius: 999px;
    pointer-events: none;
    white-space: nowrap;
  }

  /* The hold filling, so leaving is never a surprise. */
  .ring {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: conic-gradient(var(--paper) var(--hold-at, 0%), var(--paper-faint) 0);
    -webkit-mask: radial-gradient(circle, transparent 4px, #000 5px);
    mask: radial-gradient(circle, transparent 4px, #000 5px);
    animation: immersive-hold var(--hold-ms, 500ms) linear forwards;
  }
  @property --hold-at {
    syntax: "<percentage>";
    inherits: false;
    initial-value: 0%;
  }
  @keyframes immersive-hold {
    to {
      --hold-at: 100%;
    }
  }
</style>
