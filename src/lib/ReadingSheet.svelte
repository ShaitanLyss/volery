<script lang="ts">
  /* A reading in a sheet: what `space b p` and the palette's *pipelines* open.

     Lyss, 2026-11-03: *"I press spacebar, type 'pipe', the first item in the
     action menu is pipeline so I press enter and boom I see my pipelines in a
     modal."* The face is the widget's own (`WidgetFace.svelte`) — the wall and
     this sheet are two holders of one drawing, so a knob the pipelines gain on
     the wall is in the sheet the same day. What is the sheet's is the frame:
     the heading, the widget's own knobs as a row of choices (`sheets.ts`), and
     *hang it on the wall* for a reading you want to keep in view.

     Over either view, from App, as the accounts panel is. Escape is App's to
     answer, wherever the focus is (`App.sheetKey`): it closes what the sheet
     opened over itself first, then the sheet, and never reaches the window's
     Escape that would stop a turn. Focus goes back where it was (App keeps
     that, since it opened it).
     Sized in `cqw`/`cqh`, never `vw`/`vh`, which mean every screen while the
     window is spread. */
  import { onMount, untrack, type ComponentProps } from "svelte";
  import WidgetFace from "./WidgetFace.svelte";
  import { specFor, type WidgetConfig, type WidgetKind } from "./widgets";
  import { SHEET_STORE, readSheets, sheetKnobs, sheetWidget } from "./sheets";
  import { CHORDS } from "./leader";
  import { glyphOf } from "./search";
  import Icon from "./Icon.svelte";
  import { tipOf } from "./tipped.svelte";

  type Faces = Omit<ComponentProps<typeof WidgetFace>, "widget" | "onupdate" | "onreading">;

  let {
    kind,
    faces,
    onclose,
    onhang,
  }: {
    kind: WidgetKind;
    /** Everything a face reads, as the wall hands it to `WidgetNode`. */
    faces: Faces;
    onclose: () => void;
    /** Hang this reading on the wall, with the knobs it has here. */
    onhang?: (config: WidgetConfig) => void;
  } = $props();

  const spec = $derived(specFor(kind));
  const chord = $derived(CHORDS.find((c) => c.verb.kind === "reading" && c.verb.widget === kind));
  /* The face's own body, measured below; not read otherwise. */

  let kept = $state<WidgetConfig>(untrack(() => readSheets(localStorage.getItem(SHEET_STORE))[kind] ?? {}));
  let box = $state({ w: 760, h: 480 });
  let root: HTMLDivElement | undefined = $state();

  const widget = $derived(sheetWidget(kind, kept, box));
  const knobs = $derived(widget ? sheetKnobs(kind, widget.config) : []);

  function keep(config: WidgetConfig) {
    kept = config;
    try {
      const all = readSheets(localStorage.getItem(SHEET_STORE));
      localStorage.setItem(SHEET_STORE, JSON.stringify({ ...all, [kind]: config }));
    } catch {
      /* A full or refused store loses the knob at the next opening and
         nothing else. */
    }
  }

  function set(key: string, value: string | boolean) {
    if (!widget) return;
    keep({ ...widget.config, [key]: value });
  }

  /* The face's rows are fitted to the height it is given, as on the wall,
     so the box is measured rather than guessed. */
  function measured(el: HTMLElement) {
    const ro = new ResizeObserver(() => (box = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }

  onMount(() => root?.focus());

  /* A key pressed in the sheet is the sheet's: a letter does not start a
     draft in the composer behind the scrim, Delete does not take the wall's
     selection down, Tab walks the sheet rather than the cards. Only a chord
     with a modifier goes on (ctrl+shift+M, alt+I), and Escape, which App
     answers — it knows what this sheet has opened over itself (a run, the
     tokens) and closes that first. Found in review. */
  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.stopPropagation();
  }
</script>

<div class="scrim" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="sheet"
    role="dialog"
    aria-label={spec?.label ?? kind}
    tabindex="-1"
    bind:this={root}
    onkeydown={onkey}
    data-reading={kind}
  >
    <header>
      <span class="thumb" aria-hidden="true"><Icon name={glyphOf({ kind: "chord", keys: chord?.keys ?? "", label: "", note: "", verb: { kind: "reading", widget: kind } })} /></span>
      <div class="what">
        <h2>{spec?.label ?? kind}</h2>
        {#if spec}<p>{spec.note}</p>{/if}
      </div>
      <span class="grow"></span>
      {#each knobs as p (p.key)}
        {#if p.kind === "choice" && widget}
          <div class="knob" role="radiogroup" aria-label={p.label}>
            {#each p.options as o (o.value)}
              <button
                type="button"
                role="radio"
                aria-checked={widget.config[p.key] === o.value}
                class:on={widget.config[p.key] === o.value}
                {@attach tipOf(() => (`${p.label}: ${o.label}`))}
                onclick={() => set(p.key, o.value)}>{o.label}</button
              >
            {/each}
          </div>
        {:else if p.kind === "toggle" && widget}
          <button
            type="button"
            class="toggle"
            class:on={widget.config[p.key] === true}
            aria-pressed={widget.config[p.key] === true}
            onclick={() => set(p.key, widget.config[p.key] !== true)}>{p.label}</button
          >
        {/if}
      {/each}
      {#if onhang && widget}
        <button type="button" class="act" {@attach tipOf("hang this reading on the wall, as it is here")} onclick={() => onhang(widget.config)}
          ><Icon name="pin" small />on the wall</button
        >
      {/if}
      <button type="button" class="act close" {@attach tipOf("close (esc)")} aria-label="close" onclick={onclose}
        ><Icon name="x" small /></button
      >
    </header>
    <div class="body" {@attach measured}>
      {#if widget}
        <WidgetFace {widget} {...faces} onupdate={(patch) => patch.config && keep(patch.config)} />
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    /* Against the studio root, which is the home screen while the window is
       spread — so a centred sheet lands there, as the accounts panel does. */
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    justify-content: center;
    align-items: center;
    background: color-mix(in srgb, var(--shade) 42%, transparent);
    animation: fade var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  .sheet {
    width: min(980px, 88cqw);
    height: min(680px, 80cqh);
    display: flex;
    flex-direction: column;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: var(--raised);
    box-shadow: 0 30px 70px -24px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
    color: var(--paper);
    overflow: hidden;
    outline: none;
    animation: rise var(--dur-scene, 360ms) var(--ease-out, ease-out) both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation-name: fade;
    }
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 14px 12px 16px;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 8%, transparent);
  }
  .what h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
  }
  .what p {
    margin: 1px 0 0;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .grow {
    flex: 1;
  }
  .knob {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .knob button,
  .toggle,
  .act {
    border: 0;
    background: transparent;
    color: var(--paper-dim);
    font: 12px var(--cv-ui, var(--util));
    padding: 4px 9px;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .knob button.on,
  .toggle.on {
    background: color-mix(in oklab, var(--paper) 11%, transparent);
    color: var(--paper);
  }
  .act:hover,
  .knob button:hover,
  .toggle:hover {
    color: var(--paper);
  }
  .act {
    border: 1px solid var(--cv-hair, var(--edge));
  }
  .close {
    padding: 4px 6px;
  }
  .body {
    flex: 1;
    min-height: 0;
    /* What the faces size their type against, as `.widget` is on the wall. */
    container-type: size;
    position: relative;
    overflow: hidden;
  }
</style>
