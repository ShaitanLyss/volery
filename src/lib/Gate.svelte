<script lang="ts">
  /* The small thing between you and the wall when you come back.
   *
   * `gate.ts` has the puzzles and the marking; this draws them and holds the
   * one rule that is not about any of them: **the way through is always
   * there.** The bypass is on screen from the first frame, small and quiet —
   * asked for in those words, and right for a reason beyond preference. A gate
   * that actually held the door would be a gate you resent on the morning you
   * are late, and one morning of that is the end of the feature. It works
   * because you want it to.
   *
   * So everything here is arranged around *wanting* it: one puzzle, no score,
   * no streak, no timer counting you down. Getting it right says so and lets
   * you through; getting it wrong costs nothing and offers another. The whole
   * surface is three minutes of waking up, and the switch that turns it off for
   * good is on it, because a thing you cannot refuse is a thing you stop
   * enjoying. */

  import { onMount } from "svelte";

  import {
    checkSum,
    makePuzzle,
    makeSum,
    markGuess,
    MOTUS_ROWS,
    motusState,
    motusWord,
    pickToy,
    TOYS,
    type Figure,
    type ToyId,
  } from "./gate";
  import type { Presence } from "./presence.svelte";

  let {
    presence,
    onthrough,
  }: {
    presence: Presence;
    /** Through the gate — by solving it, by skipping it, or by Escape. The
     *  caller is what actually ends away mode; this only says you are here. */
    onthrough: () => void;
  } = $props();

  let id = $state<ToyId>(pickToy(null, Math.random()));
  const spec = $derived(TOYS.find((t) => t.id === id) ?? TOYS[0]);

  /** Solved. Held for a beat before going through, so the thing you got right
   *  is something you saw being right — a gate that vanished on the correct
   *  keystroke would take the one moment it exists for with it. */
  let won = $state(false);

  function through() {
    if (won) return;
    won = true;
    setTimeout(onthrough, 700);
  }

  function another() {
    id = pickToy(id, Math.random());
    reset();
  }

  /* ── motus ────────────────────────────────────────────────────────────── */

  let word = $state(motusWord(Math.random()));
  let rows = $state<string[]>([]);
  let typed = $state("");
  const motus = $derived(motusState(rows, word));

  function motusKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      if (typed.length !== 6) return;
      rows = [...rows, typed.toUpperCase()];
      typed = "";
      if (motusState(rows, word) === "won") through();
      return;
    }
    if (e.key === "Backspace") {
      typed = typed.slice(0, -1);
      return;
    }
    if (/^[a-zA-Z]$/.test(e.key) && typed.length < 6) {
      typed = (typed + e.key).toUpperCase();
    }
  }

  /* ── calculus ─────────────────────────────────────────────────────────── */

  let sum = $state(makeSum(Math.random()));
  let written = $state("");
  let wrong = $state(false);

  function trySum() {
    if (!written.trim()) return;
    if (checkSum(sum, written)) through();
    else wrong = true;
  }

  /* ── the casse-tête ───────────────────────────────────────────────────── */

  let puzzle = $state(makePuzzle(Math.random()));

  function answer(same: boolean) {
    if (same === puzzle.same) through();
    else wrong = true;
  }

  /** A figure as a flat drawing: unit cubes in isometric projection, painted
   *  back to front.
   *
   *  Isometric rather than perspective, because the question is about *shape*
   *  and a perspective view gives the nearer arm of the figure away by size
   *  alone — which turns a rotation task into a looking task. The three faces
   *  are three shades of one tone for the same reason the wall's chrome is
   *  achromatic: the shape has to be legible, and colour here would be
   *  decoration on top of information. */
  function iso(f: Figure): { path: string; shade: number; key: string }[] {
    const S = 15;
    const out: { path: string; shade: number; key: string; depth: number }[] = [];
    for (const [x, y, z] of f.cells) {
      const px = (x - z) * S * 0.866;
      const py = (x + z) * S * 0.5 - y * S;
      const faces: [number[][], number][] = [
        /* top, then the two sides — drawn in this order so a cube reads as a
           cube even where its neighbours hide two of the three. */
        [
          [
            [0, -S],
            [S * 0.866, -S * 0.5],
            [0, 0],
            [-S * 0.866, -S * 0.5],
          ],
          1,
        ],
        [
          [
            [-S * 0.866, -S * 0.5],
            [0, 0],
            [0, S],
            [-S * 0.866, S * 0.5],
          ],
          0.68,
        ],
        [
          [
            [0, 0],
            [S * 0.866, -S * 0.5],
            [S * 0.866, S * 0.5],
            [0, S],
          ],
          0.44,
        ],
      ];
      for (const [pts, shade] of faces) {
        out.push({
          key: `${x},${y},${z},${shade}`,
          shade,
          depth: x + z - y,
          path: `M ${pts.map(([a, b]) => `${(px + a).toFixed(2)} ${(py + b).toFixed(2)}`).join(" L ")} Z`,
        });
      }
    }
    return out.sort((p, q) => p.depth - q.depth);
  }

  function box(f: Figure): string {
    const pts = iso(f).flatMap((p) =>
      p.path
        .slice(2, -2)
        .split(/[ML]\s*/)
        .filter(Boolean)
        .map((s) => s.trim().split(/\s+/).map(Number)),
    );
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 10;
    const x0 = Math.min(...xs) - pad;
    const y0 = Math.min(...ys) - pad;
    return `${x0} ${y0} ${Math.max(...xs) - x0 + pad} ${Math.max(...ys) - y0 + pad}`;
  }

  /* ── shared ───────────────────────────────────────────────────────────── */

  function reset() {
    won = false;
    wrong = false;
    rows = [];
    typed = "";
    written = "";
    word = motusWord(Math.random());
    sum = makeSum(Math.random());
    puzzle = makePuzzle(Math.random());
  }

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onthrough();
      return;
    }
    if (won) return;
    if (id === "motus") {
      e.preventDefault();
      motusKey(e);
    }
  }

  let field = $state<HTMLInputElement | undefined>();
  onMount(() => field?.focus());

  $effect(() => {
    void id;
    field?.focus();
  });
</script>

<svelte:window on:keydown={key} />

<div class="gate" class:won>
  <div class="card">
    <header>
      <span class="what">{spec.label}</span>
      <span class="about">{spec.about}</span>
    </header>

    {#if id === "motus"}
      <!-- Motus rather than Wordle: the first letter is given, which is the
           difference between the two games and the thing that makes a
           six-letter word reasonable before coffee. -->
      <div class="grid">
        {#each Array(MOTUS_ROWS) as _, r}
          {@const done = rows[r]}
          {@const marks = done ? markGuess(done, word) : null}
          <div class="row">
            {#each Array(6) as __, c}
              {@const ch = done
                ? done[c]
                : r === rows.length
                  ? (typed[c] ?? (c === 0 ? word[0] : ""))
                  : ""}
              <span
                class="cell"
                class:here={marks?.[c] === "here"}
                class:there={marks?.[c] === "there"}
                class:given={!done && r === rows.length && c === 0 && !typed[c]}
                >{ch ?? ""}</span
              >
            {/each}
          </div>
        {/each}
      </div>
      {#if motus === "lost"}
        <p class="said">it was <b>{word}</b></p>
      {:else if !won}
        <p class="said">type six letters, enter to try</p>
      {/if}
    {:else if id === "calculus"}
      <p class="sum">
        <span class="verb">{sum.kind === "derive" ? "d/dx" : "∫"}</span>
        <span class="of">{sum.of}</span>
        {#if sum.kind === "integrate"}<span class="dx">dx</span>{/if}
      </p>
      <input
        bind:this={field}
        class="answer"
        class:wrong
        bind:value={written}
        spellcheck="false"
        autocomplete="off"
        placeholder="write it however you like"
        onkeydown={(e) => {
          if (e.key === "Enter") trySum();
          else wrong = false;
        }}
      />
      <p class="said">
        {#if wrong}
          not that — try again, or take another
        {:else if sum.note}
          {sum.note}
        {:else}
          <code>2x</code>, <code>x^2</code>, <code>sin(x)</code>, <code>exp(x)</code>,
          <code>ln(x)</code>, <code>sqrt(x)</code>
        {/if}
      </p>
    {:else}
      <div class="figures">
        {#each [puzzle.a, puzzle.b] as f, i (i)}
          <svg viewBox={box(f)} role="img" aria-label="block figure">
            {#each iso(f) as face (face.key)}
              <path
                d={face.path}
                fill="color-mix(in srgb, var(--paper) {Math.round(face.shade * 72)}%, transparent)"
                stroke="var(--well)"
                stroke-width="1"
              />
            {/each}
          </svg>
        {/each}
      </div>
      <div class="choices">
        <button onclick={() => answer(true)}>the same shape</button>
        <button onclick={() => answer(false)}>its mirror</button>
      </div>
      {#if wrong}<p class="said">no — take another</p>{/if}
    {/if}

    {#if won}
      <p class="said good">bonjour</p>
    {/if}

    <footer>
      <!-- Always here, always small. The whole design rests on this being
           available and unembarrassing to press. -->
      <button class="skip" onclick={onthrough}>skip</button>
      <button class="skip" onclick={another}>another</button>
      <span class="grow"></span>
      <button
        class="skip off"
        title="Stop putting a puzzle in the way when you come back. The away screen's own settings turn it back on."
        onclick={() => {
          presence.setToys(false);
          onthrough();
        }}>not any more</button
      >
    </footer>
  </div>
</div>

<style>
  /* Over everything, including the away screen it replaces — the same
     arrangement `Rest.svelte` uses, and `span.ts` is why the offsets are here
     rather than `inset: 0`. */
  .gate {
    position: fixed;
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: var(--span-y, 0px) var(--span-r, 0px) var(--span-b, 0px) var(--span-x, 0px);
    z-index: 9600;
    display: grid;
    place-items: center;
    background: var(--well);
    animation: rise 420ms cubic-bezier(0.22, 0.68, 0.24, 1) both;
    transition: opacity 500ms ease;
  }
  .gate.won {
    opacity: 0;
    pointer-events: none;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    align-items: center;
    min-width: min(30rem, 86cqw);
  }

  header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }
  .what {
    font-family: var(--display);
    font-size: 1.4rem;
    color: var(--paper);
  }
  .about,
  .said {
    font-family: var(--util);
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    color: var(--paper-mute);
    margin: 0;
    text-align: center;
  }
  .said.good {
    color: var(--st-ok, var(--paper));
  }
  .said code {
    font-size: 0.62rem;
    opacity: 0.85;
  }

  /* motus */
  .grid {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .row {
    display: flex;
    gap: 0.25rem;
  }
  .cell {
    width: 2.1rem;
    height: 2.1rem;
    display: grid;
    place-items: center;
    font-family: var(--display);
    font-size: 1.05rem;
    color: var(--paper);
    border: 1px solid color-mix(in srgb, var(--paper) 18%, transparent);
    border-radius: 3px;
  }
  .cell.given {
    color: var(--paper-mute);
  }
  /* The game's own marking, and the one place this file leans on colour. It is
     information rather than decoration — which square is where — and it is read
     on a screen that covers the wall entirely, so no status colour is beside
     it. Same bargain `away.ts::hueAllowed` states. */
  .cell.here {
    background: color-mix(in srgb, #b0574a 62%, var(--well));
    border-color: transparent;
  }
  .cell.there {
    border-color: #c9a227;
    color: #e4c75a;
  }

  /* calculus */
  .sum {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    font-family: var(--display);
    font-size: 1.5rem;
    color: var(--paper);
  }
  .verb {
    color: var(--paper-mute);
    font-size: 1.1rem;
  }
  .dx {
    color: var(--paper-mute);
    font-size: 1rem;
  }
  .answer {
    width: min(26rem, 80cqw);
    font-family: var(--display);
    font-size: 1rem;
    color: var(--paper);
    background: color-mix(in srgb, var(--paper) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--paper) 22%, transparent);
    border-radius: 3px;
    padding: 0.45rem 0.6rem;
    text-align: center;
  }
  .answer:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--paper) 50%, transparent);
  }
  .answer.wrong {
    border-color: var(--st-fail);
  }

  /* the casse-tête */
  .figures {
    display: flex;
    gap: 2rem;
    align-items: center;
  }
  svg {
    width: min(13rem, 36cqw);
    height: 11rem;
  }
  .choices {
    display: flex;
    gap: 0.5rem;
  }
  .choices button {
    font-family: var(--util);
    font-size: 0.66rem;
    letter-spacing: 0.1em;
    color: var(--paper-dim);
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--paper) 22%, transparent);
    border-radius: 3px;
    cursor: pointer;
    padding: 0.4rem 0.9rem;
  }
  .choices button:hover {
    color: var(--paper);
    border-color: color-mix(in srgb, var(--paper) 45%, transparent);
  }

  footer {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    margin-top: 0.4rem;
  }
  .grow {
    flex: 1 1 auto;
  }
  .skip {
    font-family: var(--util);
    font-size: 0.56rem;
    letter-spacing: 0.12em;
    color: var(--paper-faint);
    background: none;
    border: 0;
    cursor: pointer;
    padding: 0.2rem 0.3rem;
  }
  .skip:hover {
    color: var(--paper-dim);
  }
</style>
