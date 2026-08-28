<!-- A short arc of choices, fanned up out of the button that opened it.

     Pressing a chip usually *is* the verb. This one is a question with three
     answers, and the three are not equal in consequence — a major bump is a
     different kind of act from a patch — so they have to be seen and aimed at
     rather than picked off a list. Hence an arc: the three land in three
     distinct directions out of one point, so after the first use the gesture is
     "up-left" rather than "read the second item".

     **Deliberately not a menu.** `menu.ts` owns the right-click, and this is a
     different gesture with a different promise: a menu is a list of everything
     a target offers and answering with nothing is a real answer there, where
     this is one question that always has exactly these answers. It is also
     *positional* — a menu is a column that appears wherever the cursor is, and
     the whole value here is that each choice always comes out in the same
     direction from the same button.

     Where each choice lands, and what that costs against the card above it,
     is `arc.ts` — pure, so the clearances are asserted in `test/bump.test.ts`
     rather than eyeballed once.

     Nothing is drawn at `field` density, because the acts row is not. -->

<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { arcSpots, ARC_STAGGER } from "./arc";

  let {
    choices,
    onpick,
    ondismiss,
  }: {
    /** In the order they read left to right along the arc. */
    choices: { id: string; label: string; title: string }[];
    onpick: (id: string) => void;
    ondismiss: () => void;
  } = $props();

  /* Where each one lands, and why those numbers — `arc.ts`, which is pure so
     the clearances can be asserted rather than eyeballed. */
  const spots = $derived(arcSpots(choices.length));

  /** Out of the button and back into it.
   *
   *  A transition rather than a CSS animation, so the same function runs
   *  backwards when the arc is dismissed: a choice that slid out of the button
   *  should retract into it, not blink. The `-50%` pair is the centring, carried
   *  inside the transform because the transform is what this writes — anything
   *  centring the item in CSS would be overwritten on the first frame. */
  function fan(_node: Element, { dx, dy, i }: { dx: number; dy: number; i: number }) {
    return {
      delay: i * ARC_STAGGER,
      duration: 240,
      easing: cubicOut,
      css: (t: number) =>
        `transform: translate(calc(-50% + ${(dx * t).toFixed(2)}px), calc(-50% + ${(dy * t).toFixed(2)}px))` +
        ` scale(${(0.6 + 0.4 * t).toFixed(3)}); opacity: ${t.toFixed(3)}`,
    };
  }

  /* Escape closes it, and so does a press anywhere else on the wall.
   *
   * Both in the capture phase, and both at the window: the arc stands over the
   * cards, and a press meant to dismiss it may land on a card, a widget, the
   * glass — which is a *sibling* of the wall's surface — or nothing at all.
   *
   * The opener is excluded by `[data-fan]`, which `Canvas.svelte` marks the
   * wrapper holding both the chip and this. Without it, pressing the chip a
   * second time would dismiss here on `pointerdown` and then re-open on the
   * `click` that follows, so the arc would flicker instead of closing. */
  $effect(() => {
    const away = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.("[data-fan]")) ondismiss();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      /* Swallowed: Escape on this wall stops a card's turn, and closing a
         choice you opened by accident must not also interrupt an agent. */
      e.preventDefault();
      e.stopPropagation();
      ondismiss();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  });
</script>

<div class="arc">
  {#each choices as c, i (c.id)}
    {@const at = spots[i]}
    <!-- **The resting position is here, not in the transition**, and that is the
         whole of what was wrong with this. A Svelte `css` transition applies its
         styles only while it is running; the moment the fan finished, Svelte took
         the inline transform off and all three items snapped back to the `left:
         0; top: 0` of a zero-sized `.arc` — stacked exactly on top of each other
         on the button's centre, so what you saw was the last one in DOM order.
         `patch` is last, which is why the report was "only showing patch, missing
         major and minor" (sink c9f8e6bd). Nothing was missing; two of them were
         underneath the third.

         The transition's own `css` ends at this same value with a no-op
         `scale(1)`, so the animation hands over to the static style without a
         jump — and the `-50%` pair stays inside the transform for the reason
         `fan` already gives: it is what the transform writes, so centring it in
         CSS would be overwritten on the first frame and then restored on the
         last, which is the same bug one layer along. -->
    <button
      class="pick"
      title={c.title}
      style:transform="translate(calc(-50% + {at.dx.toFixed(2)}px), calc(-50% + {at.dy.toFixed(
        2,
      )}px))"
      transition:fan={{ dx: at.dx, dy: at.dy, i }}
      onclick={() => onpick(c.id)}
    >
      {c.label}
    </button>
  {/each}
</div>

<style>
  /* Zero-sized, sitting on the button's centre: every item is positioned from
     here and carried out by its own transform, which is what makes "slides out
     of the button" true rather than approximated. `pointer-events: none` so the
     span itself never eats a press aimed at the chip underneath. */
  .arc {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  /* The same reading as a chip — this row's vocabulary — but its own rule
     rather than a shared class, since `.chip` is scoped to Canvas.svelte and a
     component is the only CSS scope this codebase has. Filled rather than
     outlined, because an item in mid-air over a card has to be opaque: the
     backdrop draws behind everything and nothing standing on the wall may be
     transparent. */
  .pick {
    position: absolute;
    /* The centre of the button this fanned out of. Everything past this is the
       per-item `transform` written inline — see the note on the element, and
       do not move that offset in here. */
    left: 0;
    top: 0;
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 46px;
    font-family: var(--mono);
    font-size: 0.62rem;
    line-height: 1;
    letter-spacing: 0.01em;
    padding: 0.22rem 0.5rem;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--well);
    color: var(--paper-dim);
    white-space: nowrap;
    cursor: pointer;
    /* A drop shadow is the one thing here that is decoration rather than
       status, and it is doing the same job the opacity rule does: it says this
       is floating above the wall rather than standing on it. */
    box-shadow: 0 2px 6px color-mix(in srgb, var(--ink) 45%, transparent);
  }
  .pick:hover {
    color: var(--paper);
    border-color: var(--paper-faint);
    background: var(--surface);
  }
  /* No colour on hover. Colour is status on this wall, and none of these three
     is a state — which one you are about to press is said by where it is. */
</style>
