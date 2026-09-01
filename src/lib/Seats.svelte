<script lang="ts">
  import type { Seat } from "./conversation.svelte";
  import { crowds } from "./crowds.svelte";
  import { figuresFor, tallyOf } from "./crowd";

  let { seats, scale }: { seats: Seat[]; scale: number } = $props();

  /* How far a workflow has got, read off its own journal by `crowds` — the one
     knowable thing about a running workflow, and it is two numbers: how many
     agents are out and how many are back. The arithmetic is in `crowd.ts` and
     tested there; this asks it. Nothing infers a phase from a count. */
  const figures = (seat: Seat) => figuresFor(!!seat.crew, crowds.seen[seat.id]);
  const tally = (seat: Seat) => (seat.crew ? tallyOf(crowds.seen[seat.id]) : null);

  /* An arc: the middle seats ride higher than the outer ones, so a row of four
     reads as a gathering rather than a toolbar. */
  function lift(i: number, n: number): number {
    if (n < 3) return 0;
    const mid = (n - 1) / 2;
    return Math.round(22 * (1 - Math.abs(i - mid) / mid));
  }

  /** Bubbles are only legible above the wall density, and become noise below
   *  it — at a distance a seat is just a figure. */
  const showBubbles = $derived(scale >= 0.72);
</script>

<div class="satellites" class:bare={!showBubbles}>
  {#each seats as seat, i (seat.id)}
    {@const drawn = figures(seat)}
    <div
      class="persona"
      class:crowd={!!seat.crew}
      data-seat={seat.id}
      data-state={seat.state}
      style:--lift="{lift(i, seats.length)}px"
    >
      {#if showBubbles}
        <div class="bubble" style:animation-delay="{-i * 1.3}s">
          {#if seat.state === "done"}
            <span class="verdict">✓ {seat.verdict ?? "returned"}</span>
          {:else if seat.thought}
            {seat.thought}
          {:else if seat.crew}
            <span class="faint">a workflow, launching…</span>
          {:else}
            <span class="faint">arriving…</span>
          {/if}

          <!-- The phases, and never which one is current: a workflow's agents
               run on a stream this window does not see, so the list is what it
               said it would do and a lit step would be a claim nothing here can
               make. Kept once the crowd is done, since what it set out to do is
               still the best account of what the verdict is about. -->
          {#if seat.crew?.phases.length}
            <div class="phases">
              {#each seat.crew.phases as phase, p (phase + p)}
                {#if p > 0}<span class="then">→</span>{/if}<span class="phase"
                  >{phase}</span
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- One figure for a subagent, and for a workflow one per agent its own
           journal says is out — because a workflow is a dozen agents and drawing
           it as one would say the wrong number in the one channel the wall has
           for saying it. Overlapped rather than spread, so a crowd reads as one
           presence and does not compete with the seats beside it for the row.
           An agent that has returned is drawn at rest. -->
      <div class="figures">
        {#each drawn as home, f (f)}
          <svg
            class="figure"
            class:crowded={f < drawn.length - 1}
            class:home
            style:--depth={f}
            viewBox="0 0 24 30"
            aria-hidden="true"
          >
            <circle cx="12" cy="7.6" r="5.1" />
            <path d="M2.6 30 C2.6 20.4 7 16.4 12 16.4 C17 16.4 21.4 20.4 21.4 30 Z" />
          </svg>
        {/each}
      </div>
      {#if showBubbles}
        {@const said = tally(seat)}
        {#if said}<div class="tally">{said}</div>{/if}
      {/if}

      {#if showBubbles}
        <div class="pname">{seat.persona}</div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .satellites {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 14px);
    transform: translateX(-50%);
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    pointer-events: none;
  }
  .satellites.bare {
    gap: 0.3rem;
  }

  .persona {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.34rem;
    width: 150px;
    margin-bottom: var(--lift, 0px);
    /* Seats are told apart by position and name, never by hue: colour is the
       status channel and giving each persona its own would quietly wreck it. */
    color: var(--tone, var(--paper-dim));
  }
  .satellites.bare .persona {
    width: auto;
  }

  /* A hairline strand binding each seat down to the card that convened it. */
  .persona::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: calc(-14px - var(--lift, 0px));
    width: 1px;
    height: calc(var(--lift, 0px) + 14px);
    background: linear-gradient(to bottom, var(--edge), transparent);
  }

  .figures {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .figure {
    width: 21px;
    height: 27px;
    fill: currentColor;
    opacity: 0.9;
  }
  /* Everybody but the front figure. Smaller and fainter, and overlapping the
     one in front of them — the whole of the depth, with no perspective and no
     second colour. `--depth` is the index, so a crowd of nine tucks tighter
     than a crowd of three without either being a separate rule. */
  .crowd .figure.crowded {
    width: 15px;
    height: 19px;
    opacity: 0.34;
    margin-right: -7px;
  }
  /* An agent that has come back. Not a colour — celadon here would read as the
     card working, which is the tier's word and not a seat's — so it is drawn at
     rest the way a finished seat is: full ink, no breathing. */
  .crowd .figure.home {
    opacity: 0.62;
  }
  .pname {
    font-family: var(--util);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Thought bubble: trailing circles, not a speech tail. */
  .bubble {
    position: relative;
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 11px;
    padding: 0.48rem 0.6rem;
    font-family: var(--body);
    font-size: 0.7rem;
    line-height: 1.42;
    color: var(--paper-dim);
    margin-bottom: 0.5rem;
    max-height: 6.2em;
    overflow: hidden;
    animation: drift 5.5s ease-in-out infinite;
  }
  .bubble::before,
  .bubble::after {
    content: "";
    position: absolute;
    left: 50%;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--edge);
  }
  .bubble::before {
    width: 7px;
    height: 7px;
    bottom: -10px;
    margin-left: -9px;
  }
  .bubble::after {
    width: 4px;
    height: 4px;
    bottom: -18px;
    margin-left: -1px;
  }
  .faint {
    color: var(--paper-faint);
  }

  /* The phase track. Set in the utility face rather than the body, because it is
     a list of labels and not a sentence — the same reading `.pname` takes. */
  .phases {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.22em;
    margin-top: 0.42em;
    padding-top: 0.36em;
    border-top: 1px solid var(--edge);
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--paper-faint);
  }
  .then {
    opacity: 0.5;
  }

  /* The count, under the figures rather than in the bubble: the bubble is what
     the workflow *said* and this is what it has *done*, and running the two
     together would make the second read as more of the first. */
  .tally {
    font-family: var(--util);
    font-size: 0.56rem;
    letter-spacing: 0.1em;
    text-transform: lowercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .verdict {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
  }

  @keyframes drift {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-4px);
    }
  }

  .persona[data-state="spawning"] {
    --tone: var(--paper-faint);
  }
  .persona[data-state="spawning"] .bubble,
  .persona[data-state="spawning"] .figure {
    opacity: 0.4;
  }

  .persona[data-state="thinking"] {
    --tone: var(--st-work);
  }
  .persona[data-state="thinking"] .figure {
    animation: breathe-fig 3.6s ease-in-out infinite;
  }
  @keyframes breathe-fig {
    0%,
    100% {
      opacity: 0.62;
    }
    50% {
      opacity: 1;
    }
  }

  .persona[data-state="done"] {
    --tone: var(--st-rest);
  }
  .persona[data-state="done"] .bubble {
    background: var(--well);
    animation: none;
  }
  .persona[data-state="done"] .bubble::before,
  .persona[data-state="done"] .bubble::after {
    background: var(--well);
  }

  @media (prefers-reduced-motion: reduce) {
    .bubble,
    .figure {
      animation: none !important;
    }
  }
  /* Same set, asked for rather than inherited from the OS — see `motion.ts`. */
  :global(html[data-motion="still"]) .bubble,
  :global(html[data-motion="still"]) .figure {
    animation: none;
  }
</style>
