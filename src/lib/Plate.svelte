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
  const owner = $derived(t ? timelines.ownerOf(t.ownerId) : null);
</script>

{#if t}
  <Frise
    {t}
    tier={owner?.tier ?? "rest"}
    handle={owner?.handle ?? t.ownerId.slice(0, 8)}
    canJump={!!owner}
    compact={variantOf(widget) !== "wide"}
    onjump={(rev) => timelines.jumpTo(t.ownerId, t.id, rev)}
    onarchive={() => void timelines.archive(t.id)}
    onpick={owner ? () => timelines.pick(t.ownerId) : undefined}
    {onreading}
    onhover={(on) => timelines.hover(t.id, on)}
  />
{/if}
