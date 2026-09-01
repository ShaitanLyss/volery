<script lang="ts">
  /* Blocks of markdown, drawn as themselves.
     Recursive — a quote and a list item hold blocks of their own.

     Parsing lives in ./markdown.ts (pure, tested); this file only turns nodes
     into elements. There is no `{@html}` on this path and there must not be:
     the text is whatever an agent wrote, and a transcript is not a document
     anybody chose to trust. */
  import Self from "./Markdown.svelte";
  import Inlines from "./Inlines.svelte";
  import { runIn, type Block } from "./markdown";

  let {
    blocks,
    caret = false,
    nav = true,
    onlink,
  }: {
    blocks: Block[];
    /** Draw the streaming caret at the very end of the last thing written.
     *  It travels down the tree rather than sitting after the whole run,
     *  or a half-written list would blink a line below itself. */
    caret?: boolean;
    /** Whether a paragraph here may be a place the rail lists.
     *
     *  Only the answer's own paragraphs may. Inside a list item the line is
     *  already a mark, and a `lead` under it would print the same words a
     *  second time one line down while robbing the item of its label — the
     *  same double-counting `startText` exists to prevent. Inside a quote the
     *  words are somebody else's structure, not this answer's. */
    nav?: boolean;
    onlink?: (href: string) => void;
  } = $props();

  /* Copying is the one thing anybody does to a fence, and a column that is
     still growing under a live turn is a bad place to sweep a selection across.
     The button is also where the answer goes: there is no fault bar down here,
     and a word beside the thing it happened to beats one at the top of the
     window. Keyed by block index — recursion gives each level its own state, so
     a fence inside a list item can't be confused with one beside it. */
  let said = $state<Record<number, string>>({});
  const timers: Record<number, number> = {};

  async function copy(at: number, text: string) {
    let word = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      word = "no clipboard";
    }
    said[at] = word;
    clearTimeout(timers[at]);
    timers[at] = window.setTimeout(() => delete said[at], 1400);
  }
</script>

{#each blocks as b, i (i)}
  {@const tip = caret && i === blocks.length - 1}
  {#if b.t === "p"}
    <!-- A paragraph that opens in bold is a section with its heading run in —
         which is how an agent writes headings most of the time. The label goes
         on the element because the rail reads the panel's DOM and the bold is
         only part of the paragraph's text; see `runIn` and outline.ts. -->
    {@const lead = nav ? runIn(b.kids) : null}
    <p data-nav={lead ? "lead" : null} data-lead={lead}><Inlines
        kids={b.kids}
        {onlink}
      />{#if tip}<span class="caret"></span>{/if}</p>
  {:else if b.t === "h"}
    <!-- One shape for every level, sized by depth. An agent's `###` is a label
         over a paragraph, not a document outline, so none of them shout.
         `data-nav` is how the transcript's rail finds them — see outline.ts. -->
    <div class="h" data-nav="h" data-level={b.level}>
      <Inlines kids={b.kids} {onlink} />{#if tip}<span class="caret"></span
        >{/if}
    </div>
  {:else if b.t === "code"}
    <!-- No syntax highlighting, deliberately: colour on this wall is status,
         and a keyword is not a status. The mono face and the well do the work.

         The button lives in the wrapper rather than in the `pre`: out of flow it
         contributes nothing to the block's min-content width (nothing in the
         panel may decide the panel's width), and being outside the scroller it
         stays in the corner when a wide fence is scrolled sideways. The perch
         is what lets it also ride the top of the *visible* part — see below. -->
    <div class="fence">
      <pre class="code" class:open={b.open}>{#if b.lang}<span class="lang"
            >{b.lang}</span
          >{/if}<code>{b.text}{#if tip}<span class="caret"></span
          >{/if}</code></pre>
      <div class="perch">
        <button
          class="copy"
          class:held={said[i] !== undefined}
          onclick={() => copy(i, b.text)}>{said[i] ?? "copy"}</button
        >
      </div>
    </div>
  {:else if b.t === "quote"}
    <blockquote><Self blocks={b.kids} caret={tip} nav={false} {onlink} /></blockquote>
  {:else if b.t === "hr"}
    <hr />
  {:else if b.t === "list"}
    {#if b.ordered}
      <ol class:tight={b.tight} start={b.start}>
        {#each b.items as item, j (j)}
          <li data-nav="li">
            <Self
              blocks={item}
              caret={tip && j === b.items.length - 1}
              nav={false}
              {onlink}
            />
          </li>
        {/each}
      </ol>
    {:else}
      <!-- `data-nav` on the item, not the list: what the rail lists is the start
           of each item — see outline.ts. -->
      <ul class:tight={b.tight}>
        {#each b.items as item, j (j)}
          <li data-nav="li">
            <Self
              blocks={item}
              caret={tip && j === b.items.length - 1}
              nav={false}
              {onlink}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if b.t === "table"}
    <!-- Its own scroller: a wide table must not widen the panel, which would
         push the transcript's own column out of shape. -->
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {#each b.head as cell, c (c)}
              <th style:text-align={b.align[c] ?? "left"}>
                <Inlines kids={cell} {onlink} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each b.rows as row, r (r)}
            <tr>
              {#each row as cell, c (c)}
                <td style:text-align={b.align[c] ?? "left"}>
                  <Inlines kids={cell} {onlink} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}

<style>
  /* Blocks space themselves rather than being spaced by the column, so a line
     that is a single paragraph looks exactly as it did before markdown existed
     here. */
  :global(.md) > :first-child {
    margin-top: 0;
  }
  :global(.md) > :last-child {
    margin-bottom: 0;
  }

  p {
    margin: 0.55em 0;
    /* The parser keeps an agent's own line breaks; this is what shows them. */
    white-space: pre-wrap;
    /* The rag, themed. At this measure — around 53 characters at the default
       panel width — a one-word last line is constant, and `pretty` is the one
       wrap improvement with no aesthetic cost: Chromium reflows only the last
       few lines, so it is cheap. `hyphens` is separate because it is the knob
       people feel immediately and in both directions, so no theme should be
       able to turn one on by asking for the other. Both default to the keyword
       the panel always drew with, and an unsupported value costs this one
       declaration rather than the rule — a custom property is substituted as a
       token stream and resolved by the property using it. `index.html` carries
       `lang="en"`, without which hyphenation silently does nothing. */
    text-wrap: var(--tx-wrap, wrap);
    hyphens: var(--tx-hyphens, manual);
  }

  .h {
    margin: 1em 0 0.4em;
    font-family: var(--display);
    color: var(--paper);
    line-height: 1.3;
    /* Its own knob, not `--tx-wrap`: `balance` is right for a heading at any
       measure and wrong for a paragraph, where it is capped at a few lines and
       reflows the whole block. A two-line heading in this column breaks 90/10
       without it. */
    text-wrap: var(--tx-head-wrap, wrap);
  }
  .h[data-level="1"] {
    font-size: 1.22em;
  }
  .h[data-level="2"] {
    font-size: 1.12em;
  }
  .h[data-level="3"] {
    font-size: 1.04em;
  }
  .h[data-level="4"],
  .h[data-level="5"],
  .h[data-level="6"] {
    font-size: 1em;
    font-family: var(--util);
    color: var(--paper-dim);
    letter-spacing: 0.02em;
  }

  /* The spacing moved out here with the wrapper, so a fence that opens or closes
     a message still sits flush against the column's edge (`.md > :first-child`). */
  .fence {
    position: relative;
    margin: 0.6em 0;
  }

  /* The paddings and indents here are multiples of `--read` (set on the panel
     — see Transcript.svelte) for the same reason the line's gap is: type that
     grew inside spacing that did not would close up. Everything that is a
     *size* is already `em` off the line and needs no help. Defaulted to 1, so
     this renders identically anywhere the panel is not. */
  .code {
    margin: 0;
    padding: calc(0.5rem * var(--read, 1)) calc(0.6rem * var(--read, 1));
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 4px;
    overflow-x: auto;
    font-family: var(--mono);
    /* A fence was 0.78em of a 13.8px line — 10.7px, smaller than the tool
       lines above it and the smallest thing in the panel bar the seam, for the
       densest and most literal thing in an answer. 0.78 is the standard
       mono-beside-serif correction and it assumes the serif is at a
       comfortable size; at 13.8px there is not a fifth of it to give away.
       Themed rather than simply raised, because it is a correction somebody
       may reasonably want back. */
    font-size: var(--tx-code, 0.78em);
    line-height: 1.5;
    color: var(--paper-dim);
    white-space: pre;
    tab-size: 2;
  }
  /* A fence with no closer yet is still being written. A dashed edge says so
     without adding one more moving thing to a card that is already moving. */
  .code.open {
    border-style: dashed;
  }
  .lang {
    float: right;
    font-family: var(--util);
    font-size: 0.82em;
    color: var(--paper-note, var(--paper-faint));
    user-select: none;
    transition: opacity 90ms linear;
  }
  /* One corner, one job at a time: it says what this is while you are reading it
     and offers to copy it when you reach for it. Which is also why the two are
     allowed to share the spot — the label is inside the scroller and slides away
     with the text, the button is pinned. */
  .fence:hover .lang {
    opacity: 0;
  }

  /* An agent writes fences taller than the panel all the time, and a button
     pinned to the top of one is a button you have to scroll the code away from
     to reach — you go looking for it in the corner it is not in. So it rides
     the top of whatever part of the fence you can actually see.

     The perch is what makes that a rule rather than a scroll listener: it holds
     the fence's own height, and a sticky child is clamped by its containing
     block, so the button travels down the fence and no further and leaves with
     it. Being absolute it keeps both properties the button had for being
     absolute — it contributes nothing to the block's min-content width (nothing
     in the panel may decide the panel's width), and it is outside `.code`'s
     scroller, so a wide fence scrolled sideways leaves it in the corner. The
     nearest scrollport is `.lines`, which is what `top` is measured against;
     nothing between the two scrolls, and the `overflow-x` on `.code` is on a
     sibling rather than an ancestor.

     Inert, or a tall fence would wear a tall rectangle you could not select the
     code through. The button takes that back below, where it already had to. */
  .perch {
    position: absolute;
    top: 4px;
    right: 5px;
    bottom: 4px;
    pointer-events: none;
  }

  /* Quiet, achromatic and out of the way until wanted — the wall's colour is
     status, and a button is not a status. Unselectable, or dragging a selection
     down the transcript would carry the word "copy" into what you copied. */
  .copy {
    position: sticky;
    top: 4px;
    display: block;
    padding: 0.1rem 0.4rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-note, var(--paper-faint));
    cursor: pointer;
    user-select: none;
    opacity: 0;
    pointer-events: none;
    transition: opacity 90ms linear;
  }
  .fence:hover .copy,
  .copy:focus-visible,
  /* Whatever it has to report stays legible after the pointer has left. */
  .copy.held {
    opacity: 1;
    pointer-events: auto;
  }
  .copy:hover {
    color: var(--paper-dim);
    border-color: var(--paper-faint);
  }
  .copy.held {
    color: var(--paper-dim);
  }
  @media (prefers-reduced-motion: reduce) {
    .lang,
    .copy {
      transition: none;
    }
  }

  blockquote {
    margin: 0.6em 0;
    padding-left: calc(0.7rem * var(--read, 1));
    border-left: 2px solid var(--edge);
    color: var(--paper-mute);
  }

  hr {
    margin: 0.9em 0;
    border: 0;
    border-top: 1px solid var(--edge);
  }

  ul,
  ol {
    margin: 0.55em 0;
    padding-left: calc(1.35rem * var(--read, 1));
  }
  /* A tight list is one thought per line: it sits as close to its neighbours
     as the lines of a paragraph do. */
  ul.tight,
  ol.tight {
    margin: 0.45em 0;
  }
  li {
    margin: 0.15em 0;
    /* Same rag as a paragraph: a list item in this column is prose at a
       narrower measure, so it wants the treatment more rather than less. A
       nested paragraph is covered by `p` above. */
    text-wrap: var(--tx-wrap, wrap);
    hyphens: var(--tx-hyphens, manual);
  }
  :global(.md li > p) {
    margin: 0.2em 0;
  }
  /* An em dash rather than a disc: the wall's furniture is rules and dashes,
     and a bulleted list should read like the rest of it. */
  ul {
    list-style: none;
  }
  ul > li::before {
    content: "—";
    color: var(--paper-faint);
    /* Hung back into the list's own indent, so these two must scale together
       or the dash walks out of the margin as the text grows. */
    margin-left: calc(-1.1rem * var(--read, 1));
    margin-right: calc(0.35rem * var(--read, 1));
  }
  li::marker {
    color: var(--paper-faint);
  }

  .table-scroll {
    margin: 0.6em 0;
    overflow-x: auto;
    max-width: 100%;
  }
  table {
    border-collapse: collapse;
    font-size: 0.95em;
  }
  th,
  td {
    border: 1px solid var(--edge);
    padding: calc(0.25rem * var(--read, 1)) calc(0.5rem * var(--read, 1));
    vertical-align: top;
  }
  th {
    font-family: var(--util);
    font-size: 0.9em;
    font-weight: 600;
    color: var(--paper-dim);
    background: var(--surface);
    white-space: nowrap;
  }

  /* The turn is still being written. One caret, wherever the text has got to. */
  .caret {
    display: inline-block;
    width: 1px;
    height: 0.95em;
    background: var(--st-work);
    margin-left: 1px;
    vertical-align: text-bottom;
    animation: blink 1.1s steps(1) infinite;
  }
  @keyframes blink {
    0%,
    49% {
      opacity: 1;
    }
    50%,
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
  /* The caret is left *visible* rather than hidden: it says a turn is still
     being written, which is true whether or not it is allowed to blink. */
  :global(html[data-motion="still"]) .caret {
    animation: none;
  }
</style>
