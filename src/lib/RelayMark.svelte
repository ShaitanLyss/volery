<script lang="ts">
  /* The mark a relay wears, wherever one is drawn: a flock landing on a
     message received, a flock taking off on one sent (`marks.ts`). One name
     per direction rather than per surface, so a letter in chat view, a fold on
     the wall and a send in a run of calls cannot come to disagree about what a
     message arriving looks like.

     Filled in the current colour, so the surface decides how loud it is.
     Hidden from assistive technology: it always stands beside words that say
     who sent what.

     `live` is a message that arrived while you were looking, and it moves once:
     the received flock settles down and in from the top left, the sent one lifts
     up and away to the top right — into the place it then keeps. Transform and
     opacity only, one-shot, never looping, so it is not something the wall's
     motion setting reaches (`motion.md`, *And so `still` does not reach it*);
     reduced motion has it simply appear. A letter drawn from history is never
     live, or every flock in a thread would hop at once each time one is
     opened. */
  import { RELAY_MARKS, type Dir } from "./marks";

  let { dir, live = false, small = false }: { dir: Dir; live?: boolean; small?: boolean } = $props();
</script>

<svg class="mk {dir}" class:live class:small viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d={RELAY_MARKS[dir]} />
</svg>

<style>
  .mk {
    width: 28px;
    height: 28px;
    flex: none;
    fill: currentColor;
    stroke: none;
  }
  .mk.small {
    width: 18px;
    height: 18px;
  }
  .mk.live.in {
    animation: settle 620ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  .mk.live.out {
    animation: lift 620ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
  }
  @keyframes settle {
    from {
      opacity: 0;
      transform: translate(-5px, -5px);
    }
  }
  @keyframes lift {
    from {
      opacity: 0;
      transform: translate(-5px, 5px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mk.live.in,
    .mk.live.out {
      animation: none;
    }
  }
</style>
