<!-- Boost coming on: the title card. A dark band opens across the wall, a line
     of light runs through it, and "boost — the last battle" stands in it for
     two seconds, in the look's own light. Played once per switch (keyed on
     `boostView.ignitions`), and gone from the document when it ends, which is
     `motion.md`'s rule for anything that celebrates: it ends, and it leaves the
     DOM. The field's own flash and shockwave play under it, in the air canvas. -->
<script lang="ts">
  import { boost } from "./boost.svelte";
  import { boostView } from "./boostview.svelte";

  /** The ignition being shown, or 0. */
  let shown = $state(0);

  $effect(() => {
    const n = boostView.ignitions;
    if (n === 0) return;
    shown = n;
    const t = setTimeout(() => {
      if (shown === n) shown = 0;
    }, 2300);
    return () => clearTimeout(t);
  });
</script>

{#if shown && boost.on}
  {#key shown}
    <div class="ignite" aria-hidden="true">
      <div class="band"><div class="streak"></div></div>
      <div class="word">boost</div>
      <div class="sub">the last battle</div>
    </div>
  {/key}
{/if}

<style>
  .ignite {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    pointer-events: none;
    overflow: hidden;
  }
  .band {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 210px;
    margin-top: -105px;
    overflow: hidden;
    background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.72) 20%, rgba(0, 0, 0, 0.72) 80%, transparent);
    transform: scaleY(0);
    animation: band 2.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }
  .band::before,
  .band::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    top: 20%;
    background: linear-gradient(90deg, transparent, var(--boost-b), #fff, var(--boost-b), transparent);
  }
  .band::after {
    top: auto;
    bottom: 20%;
  }
  .streak {
    position: absolute;
    top: 50%;
    left: 0;
    width: 45%;
    height: 2px;
    margin-top: -1px;
    background: linear-gradient(90deg, transparent, var(--boost-b), #fff, var(--boost-b), transparent);
    box-shadow:
      0 0 18px var(--boost-a),
      0 0 40px var(--boost-a);
    transform: translateX(-110%);
    animation: streak 1.1s cubic-bezier(0.5, 0, 0.2, 1) 0.15s forwards;
  }
  .word {
    position: relative;
    margin-top: -26px;
    font-family: var(--display);
    font-size: 70px;
    letter-spacing: 0.55em;
    padding-left: 0.55em;
    color: #fff;
    text-shadow:
      0 0 14px var(--boost-a),
      0 0 40px var(--boost-a),
      0 0 90px var(--boost-c);
    animation: word 2.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  }
  .sub {
    position: absolute;
    top: calc(50% + 28px);
    font-family: var(--body);
    font-style: italic;
    font-size: 15px;
    letter-spacing: 0.3em;
    color: var(--boost-b);
    animation: sub 2.1s ease-out forwards;
  }
  @keyframes band {
    0% { transform: scaleY(0); opacity: 1; }
    18% { transform: scaleY(1); }
    75% { opacity: 1; }
    100% { transform: scaleY(1); opacity: 0; }
  }
  @keyframes streak {
    to { transform: translateX(260%); }
  }
  @keyframes word {
    0% { opacity: 0; letter-spacing: 1.4em; filter: blur(8px); }
    25% { opacity: 1; letter-spacing: 0.55em; filter: blur(0); }
    75% { opacity: 1; }
    100% { opacity: 0; letter-spacing: 0.7em; }
  }
  @keyframes sub {
    0%, 20% { opacity: 0; }
    35%, 75% { opacity: 1; }
    100% { opacity: 0; }
  }
  /* A one-shot, so it answers to the system's reduced motion and not to the
     wall's setting (`motion.md`): the card still says it, held and faded,
     without the travel. */
  @media (prefers-reduced-motion: reduce) {
    .band { transform: scaleY(1); animation: fade 2.1s ease-out forwards; }
    .streak { display: none; }
    .word { letter-spacing: 0.55em; filter: none; animation: fade 2.1s ease-out forwards; }
    .sub { animation: fade 2.1s ease-out forwards; }
    @keyframes fade {
      0% { opacity: 0; }
      15%, 75% { opacity: 1; }
      100% { opacity: 0; }
    }
  }
</style>
