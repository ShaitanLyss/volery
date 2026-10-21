<script lang="ts">
  /* A card's plan, on the wall or the glass: the frise, housed as a widget.
   *
   * Everything about how a plan is drawn is `Frise.svelte`, which the archive
   * draws with too; this is only the lookup a widget needs to be one — which
   * plan it is (`plates.ts::PLAN`), the owner as the wall knows it, and where
   * each of the plate's gestures goes. The frame is `WidgetNode`'s, like every
   * widget's. Not named for the registry (`timelines.svelte.ts`), which on this
   * filesystem would be the same file as a `Timelines.svelte`. */
  import Frise from "./Frise.svelte";
  import { planOf } from "./plates";
  import { variantOf, type Widget } from "./widgets";
  import type { Timelines } from "./timelines.svelte";
  import { isAfarTimeline } from "./gist";

  let {
    widget,
    timelines,
    onreading,
  }: {
    widget: Widget;
    timelines: Timelines;
    /** A hover card is open, so the plate must ride over everything. */
    onreading?: (open: boolean) => void;
  } = $props();

  /* Null only for a frame or two: a plate exists because its plan is on the
     glass (`Widgets.house`), and comes down when it is not (`Widgets.evict`). */
  const t = $derived(timelines.byId(planOf(widget)));
  /* Wherever the owner runs: a plan drawn by a card on another wall wears that
     card's status like any (`Timelines.readingOf`). */
  const owner = $derived(t ? timelines.readingOf(t.ownerId) : null);
  /* A step's write is found in the transcript this wall holds, which for a
     card elsewhere is only its tail — so the jump is a card here's. */
  const jumps = $derived(!!owner && !!t && !isAfarTimeline(t.id));
</script>

{#if t}
  <Frise
    {t}
    tier={owner?.tier ?? "rest"}
    canJump={jumps}
    compact={variantOf(widget) !== "wide"}
    onjump={(rev) => timelines.jumpTo(t.ownerId, t.id, rev)}
    onarchive={() => void timelines.archive(t.id)}
    onpick={owner ? () => timelines.pick(t.ownerId) : undefined}
    {onreading}
    onhover={(on) => timelines.hover(t.id, on)}
  />
{/if}
