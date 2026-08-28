<script lang="ts">
  /* One tool call, openable.
   *
   * Closed it is what it always was — a line of monospace prose saying what the
   * agent is doing — with two things added to the right of it: a stamp naming
   * the tool, and how much came back. Open it is the whole call: every argument
   * the model wrote, an edit drawn as a diff, and the result.
   *
   * The reasoning about *what* to show and in what order is in `toolcall.ts`,
   * which is pure and tested. This file is the typography: which arguments sit
   * beside their label and which want a line of their own, where the hairlines
   * go, and what a call still in flight looks like.
   *
   * The house rules it is written against, both from CLAUDE.md:
   *  - **Colour is status.** So the only colour in here is the celadon pip on a
   *    call that has not landed and the rust on one that failed. A diff is set
   *    in ink and weight instead of the red and green every other tool uses —
   *    a diff's two sides are not a status, and this wall does not spend colour
   *    on anything that is not.
   *  - **Nothing navigable inside a fold.** No `data-nav` here; the rails list
   *    places in the conversation, and a hundred opened calls are not places. */
  import {
    RESULT_LINES,
    callView,
    clampLines,
    clipNote,
    diffTally,
    resultSize,
    splitPath,
    startLine,
    toolBadge,
    type Arg,
    type ToolCall,
  } from "./toolcall";
  /* The finder's two pure path functions. Imported from there rather than
     reimplemented here because both are the front end's half of a bargain with
     `find.rs`: `insideRoot` mirrors its `safe_join`, and `placesIn` produces the
     `(path, line)` pair its viewer reads. See `.claude/rules/finding.md`. */
  import { insideRoot, placesIn } from "./finding";

  let {
    call,
    text,
    open = false,
    root,
    ontoggle,
    onfile,
  }: {
    call: ToolCall;
    /** `describeTool`'s prose — the line this always was. Passed in rather than
     *  recomputed, so what a closed call says and what the *card* says it is
     *  doing cannot drift: both are the string the line was pushed with. */
    text: string;
    open?: boolean;
    /** The card's working directory, so a path can be reduced to one the viewer
     *  can actually open. Absent — a chat card has no project — and every path
     *  here stays inert text, which is the honest answer rather than a link
     *  that fails when pressed. */
    root?: string;
    ontoggle?: () => void;
    /** Open a file in the finder's viewer. Routed out rather than reached for,
     *  the same way `onlink` is: this component knows about typography, and
     *  which panel is on screen is not its business. The path is already
     *  project-relative when it arrives. */
    onfile?: (path: string, line: number | null) => void;
  } = $props();

  /** How much of a result gets scanned for places to look at.
   *
   *  A `Grep` result is a list of places and every one of them is worth a link,
   *  which is the whole point — but "the remaining 4,000 lines" turns each of
   *  them into a `<button>`, and past a few hundred that is a lot of DOM for
   *  output nobody is clicking. Past this the text is drawn plain, which is what
   *  it did before any of this existed. The default fold is `RESULT_LINES` (24),
   *  so this only ever bites once you have asked for the whole thing. */
  const LINK_LINES = 300;

  /* Derived rather than computed once: a live call's result lands after the
     line does, so the view has to follow it. Only ever built for calls that
     are on screen — the diff is an LCS table and is not worth running for a
     column of three hundred lines nobody has opened. */
  const view = $derived(open ? callView(call.name, call.input) : null);
  const tally = $derived(view ? diffTally(view.hunks) : null);
  /* The stamp is wanted closed too, where `view` is null — so it is asked for
     directly rather than read off the view. */
  const badge = $derived(toolBadge(call.name));

  /** How many rows of a diff stand before you ask for the rest. A generous
   *  screenful: an edit is usually the thing you opened the call *for*, so the
   *  clamp is a backstop against a thousand-line replacement rather than a
   *  policy about how much of an edit you want to see. */
  const DIFF_ROWS = 120;

  let allDiff = $state(false);
  let allOut = $state(false);

  const shown = $derived(
    call.result
      ? clampLines(call.result.text, allOut ? Infinity : RESULT_LINES)
      : null,
  );

  /** Set beside its label, or on a line of its own?
   *
   *  A path and a number are values you read across; a command, a block of
   *  content and a sentence are things you read down, and squeezing one into
   *  the right-hand column of a two-column grid in a panel a third of the
   *  window wide makes a ribbon of it. */
  const inline = (a: Arg) => a.form === "path" || a.form === "scalar";

  /** Where in the file this call was looking, if it said. A `Read` with an
   *  offset knows; an `Edit` does not, and does not guess. */
  const startAt = $derived(view ? startLine(view.args) : null);

  /** A path reduced to something the viewer can open, or null for one that is
   *  not inside this card's tree — another repository, `%TEMP%`, the engine
   *  directory. Those stay text. */
  function openable(value: string): string | null {
    if (!onfile || !root) return null;
    return insideRoot(value, root);
  }

  /** The result, cut into plain runs and places you can go to.
   *
   *  Built here rather than in `finding.ts` because the *cutting* is generic and
   *  already lives there as `pieces` — what is local is which places survived
   *  `openable`, since a `Grep` across a monorepo names files this card cannot
   *  open and those have to stay text rather than become dead links. */
  const outParts = $derived.by(() => {
    const text = shown?.head ?? "";
    if (!text || !onfile || !root) return null;
    if (text.split("\n").length > LINK_LINES) return null;
    /* Resolved to a plain `{ path, line }` here rather than carried as the
       `Place` it came from: the template then needs no narrowing and no
       non-null assertion, and a `rel` that survived the filter is a string by
       construction rather than by assertion. */
    type Part = { text: string; go: { path: string; line: number } | null };
    const parts: Part[] = [];
    let at = 0;
    for (const pl of placesIn(text)) {
      const rel = openable(pl.path);
      if (rel === null) continue;
      if (pl.from > at) parts.push({ text: text.slice(at, pl.from), go: null });
      parts.push({ text: text.slice(pl.from, pl.to), go: { path: rel, line: pl.line } });
      at = pl.to;
    }
    if (!parts.length) return null;
    if (at < text.length) parts.push({ text: text.slice(at), go: null });
    return parts;
  });
</script>

<div class="call" class:shown={open} class:live={!call.result}>
  <button
    type="button"
    class="head"
    aria-expanded={open ? "true" : "false"}
    onclick={ontoggle}
    title={open ? "fold the call away" : "what it was called with, and what came back"}
  >
    <span class="mark" aria-hidden="true">{open ? "▾" : "▸"}</span>
    <span class="tag">{badge}</span>
    <span class="what">{text}</span>
    <!-- The right-hand end is the ledger: how much came back, or that nothing
         has yet. A call still in flight is the most interesting one on the page
         and is the one thing here drawn in colour — celadon, which is what
         working means everywhere else on this wall. -->
    {#if tally}
      <span class="tally">{tally}</span>
    {/if}
    {#if !call.result}
      <span class="pip" aria-label="no result yet"></span>
    {:else if call.result.failed}
      <span class="size failed">error</span>
    {:else if !open}
      <!-- Only while closed. Open, the result's own rubric carries the same
           figure two lines further down, and the two of them one above the
           other is one number printed twice. -->
      <span class="size">{resultSize(call.result)}</span>
    {/if}
  </button>

  {#if open && view}
    <div class="body">
      <!-- What it was called with. Every argument, including the ones this
           panel has no opinion about — the reason to open a call is that
           something in it is not what you assumed, and a fold that decides
           which of them you meant to check is a fold to be distrusted. -->
      {#if view.args.length}
        <dl class="args">
          {#each view.args as a (a.key)}
            <div class="arg" class:inline={inline(a)}>
              <dt>{a.label}</dt>
              <dd>
                {#if a.form === "path"}
                  <!-- The directory recedes and the name does not: which file
                       is the question, and the eleven segments above it are
                       the answer to a question nobody asked.

                       And it opens. The place you most often want to *look* at a
                       file on this wall is while reading what an agent just did
                       to it, and this was inert text. A path outside the card's
                       tree stays inert — see `openable`. -->
                  {@const p = splitPath(a.value)}
                  {@const rel = openable(a.value)}
                  {#if rel}
                    <button
                      type="button"
                      class="path go"
                      onclick={() => onfile?.(rel, startAt)}
                      title="Look at {rel}{startAt ? ` from line ${startAt}` : ""}"
                      ><span class="dir">{p.dir}</span>{p.base}</button
                    >
                  {:else}
                    <span class="path"><span class="dir">{p.dir}</span>{p.base}</span>
                  {/if}
                {:else if a.form === "scalar"}
                  <span class="scalar">{a.value}</span>
                {:else if a.form === "list"}
                  <ul class="list">
                    {#each a.items ?? [] as it, i (i)}
                      <li>{it}</li>
                    {/each}
                  </ul>
                {:else if a.form === "text"}
                  <p class="prose">{a.value}</p>
                {:else}
                  <pre class="block" class:shell={a.form === "shell"}>{a.value}</pre>
                {/if}
                {#if a.clipped}
                  <p class="clip">{clipNote(a.clipped)}</p>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      {:else if !view.hunks}
        <p class="none">called with nothing</p>
      {/if}

      <!-- An edit, as what it changed. Comparing two adjacent walls of
           near-identical code by eye is precisely the thing a diff was invented
           to stop anybody having to do. -->
      {#each view.hunks ?? [] as h, hi (hi)}
        {#if h.label}
          <div class="rubric">{h.label}</div>
        {/if}
        {@const rows = allDiff ? h.rows : h.rows.slice(0, DIFF_ROWS)}
        <div class="diff">
          {#each rows as r, i (i)}
            <div
              class="row"
              class:in={r.sign === "+"}
              class:out={r.sign === "-"}
            ><span class="gut" aria-hidden="true">{r.sign}</span>{r.text}</div>
          {/each}
        </div>
        {#if h.rows.length > rows.length}
          <button type="button" class="more" onclick={() => (allDiff = true)}>
            the remaining {h.rows.length - rows.length} lines of the edit
          </button>
        {/if}
      {/each}

      <!-- And what came back. -->
      <div class="back" class:failed={call.result?.failed}>
        <div class="rubric">
          <span>{call.result?.failed ? "it answered with an error" : "result"}</span>
          {#if call.result}
            <span class="size">{resultSize(call.result)}</span>
          {/if}
        </div>
        {#if !call.result}
          <p class="none pending"><span class="pip"></span>nothing back yet</p>
        {:else}
          <!-- Pictures first, because they are the result. A screenshot comes
               back as an `image` block beside no text at all, so this fold used
               to say "it answered with nothing" about a call whose whole answer
               was the image the agent was looking at (sink 28cb1c5d).

               `data:` URLs, already validated by `picturesOf` — the media type
               is matched against a short `image/<subtype>` and the payload
               against the base64 alphabet, because both land inside `src=` and
               come out of a tool result. No `srcset`, no lazy loading and no
               network: whatever is here arrived on the wire with the round.

               Drawn only when the fold is open, which is the whole memory
               argument. The panel holds up to 300 lines and a screenshot is
               ~135KB of base64 apiece; decoding one is the browser's business
               and it only does it for a fold somebody clicked. -->
          {#if call.result.pictures}
            <div class="shots">
              {#each call.result.pictures as pic, i (i)}
                <img class="shot" src={pic.url} alt="what the call answered with" />
              {/each}
            </div>
            {#if call.result.unshown}
              <p class="clip">
                and {call.result.unshown} more image{call.result.unshown === 1 ? "" : "s"} not
                shown
              </p>
            {/if}
          {/if}
        {/if}
        {#if call.result && !call.result.text && !call.result.pictures}
          <p class="none">it answered with nothing</p>
        {:else if call.result?.text}
          <!-- A `Grep` result is a list of places, and every one of them is
               somewhere you might want to look — so `path:line:` becomes a link
               and a wall of matches becomes something you can walk. Plain text
               whenever there is nothing to link or there is too much of it. -->
          {#if outParts}
            <pre class="out">{#each outParts as part, i (i)}{#if part.go}{@const go =
                    part.go}<button
                    type="button"
                    class="go"
                    onclick={() => onfile?.(go.path, go.line)}
                    title="Look at {go.path} at line {go.line}"
                    >{part.text}</button
                  >{:else}{part.text}{/if}{/each}</pre>
          {:else}
            <pre class="out">{shown?.head}</pre>
          {/if}
          {#if shown?.hidden}
            <button type="button" class="more" onclick={() => (allOut = true)}>
              the remaining {shown.hidden} lines
            </button>
          {/if}
          {#if call.result.clipped}
            <p class="clip">{clipNote(call.result.clipped)}</p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .call {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  /* ── closed ────────────────────────────────────────────────────────────
     The same monospace, size and paper `.line.tool` had, because a call that
     has become clickable must not thereby become heavier on the page: a round
     is mostly machinery and the machinery is meant to recede. Everything the
     fold adds sits at the two ends — the stamp at the left, the ledger at the
     right — and the prose in the middle is untouched. */
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--mono);
    font-size: calc(0.7rem * var(--read, 1));
    line-height: 1.55;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .head:hover {
    color: var(--paper-dim);
  }
  .call.shown .head {
    color: var(--paper-dim);
  }
  .mark {
    flex: 0 0 auto;
    color: var(--paper-faint);
  }
  /* The tool's own name, which is the exact thing you would search the session
     file for. A hairline chip rather than more prose: it is a label on the
     call, not part of the sentence, and at this size the border is what says so
     without spending a shade of ink on it. */
  .tag {
    flex: 0 0 auto;
    font-size: 0.86em;
    letter-spacing: 0.02em;
    padding: 0 0.3em;
    border: 1px solid var(--edge);
    border-radius: 2px;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .call.shown .tag {
    color: var(--paper-mute);
    border-color: var(--rule);
  }
  /* One line, closed or open: the detail is below, not out to the right. */
  .what {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The ledger end. Right-aligned figures against a ragged left column is the
     oldest trick there is for making a run of them scannable — you read down
     the numbers without reading the lines. */
  .tally,
  .size {
    flex: 0 0 auto;
    font-size: 0.86em;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .size.failed {
    color: var(--st-fail);
  }
  /* Not landed. The one colour in this component, and it is the colour working
     already is on the card this line is in. */
  .pip {
    flex: 0 0 auto;
    align-self: center;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    opacity: 0.75;
    animation: breathe 2.4s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 0.28;
    }
    50% {
      opacity: 0.85;
    }
  }
  /* Everything that moves is a courtesy, not a requirement. */
  @media (prefers-reduced-motion: reduce) {
    .pip {
      animation: none;
      opacity: 0.7;
    }
  }

  /* ── open ──────────────────────────────────────────────────────────────
     Set in against a hairline, the same way a folded run's contents are and the
     same way your own half of the conversation is: what binds the parts of a
     call together is the margin, not a box. A call still in flight gets the
     dashed version of that rule — the panel's existing spelling of "not settled
     yet", achromatic, the same one a pending prompt wears. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    border-left: 1px solid var(--edge);
    padding-left: 0.6rem;
    margin-left: 0.3rem;
    padding-bottom: 0.15rem;
  }
  .call.live .body {
    border-left-style: dashed;
  }

  /* The arguments, as a ledger: labels right-aligned in a column of their own,
     values left-aligned against them. Two columns only for the values that fit
     on a line — a command or a block of content spans both and takes its label
     as a rubric above it, because a paragraph squeezed into the right-hand
     column of a panel a third of the window wide is a ribbon. */
  .args {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.2rem 0.6rem;
    margin: 0;
  }
  .arg {
    display: contents;
  }
  .arg:not(.inline) dt,
  .arg:not(.inline) dd {
    grid-column: 1 / -1;
  }
  .arg:not(.inline) dt {
    margin-top: 0.15rem;
  }
  dt {
    font-family: var(--util);
    font-size: calc(0.62rem * var(--read, 1));
    letter-spacing: 0.05em;
    line-height: 1.7;
    color: var(--paper-faint);
    text-align: right;
    white-space: nowrap;
  }
  .arg:not(.inline) dt {
    text-align: left;
  }
  dd {
    margin: 0;
    min-width: 0;
    font-family: var(--mono);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.55;
    color: var(--paper-mute);
    overflow-wrap: anywhere;
  }

  /* A path reads from the right. The directory is context you already have —
     you know which project this card is in — and the name is the answer. */
  .path {
    color: var(--paper-dim);
  }
  /* A place you can go to. Drawn as text and not as a link: this is a wall of
     machinery, and a blue underline through every path in a Grep result would
     read as decoration where `tokens.css` reserves colour for status. What it
     gets instead is a dotted underline that only firms up under the pointer —
     enough to say it is reachable when you look for it, quiet enough to read
     past when you are not.

     `button` resets, because a `<button>` inside a `<pre>` otherwise arrives
     with the browser's font, its own line-height and a border, and one of those
     in the middle of a monospace column shifts every line around it. */
  .go {
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    text-align: left;
    cursor: pointer;
    text-decoration: underline dotted;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 0.18em;
  }
  .go:hover,
  .go:focus-visible {
    color: var(--paper);
    text-decoration-color: var(--paper-mute);
  }
  .dir {
    color: var(--paper-faint);
  }
  .scalar {
    color: var(--paper-dim);
  }
  .list {
    margin: 0;
    padding-left: 1em;
    list-style: none;
  }
  .list li::before {
    content: "· ";
    color: var(--paper-faint);
    margin-left: -1em;
  }
  /* A sentence somebody wrote to be read — a description, a prompt — so it is
     set in the reading face and wrapped, not in the machinery's monospace. */
  .prose {
    margin: 0;
    font-family: var(--util);
    font-size: calc(0.7rem * var(--read, 1));
    line-height: 1.5;
    color: var(--paper-dim);
    white-space: pre-wrap;
  }
  /* Content, source, structure. `pre-wrap` for the reason `.line.out` chose it:
     the panel is a third of the window wide and a path in an argument is longer
     than that. */
  .block {
    margin: 0;
    font-family: var(--mono);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--paper-dim);
    border-left: 1px solid var(--edge);
    padding-left: 0.5rem;
  }
  /* A command wears the prompt it was typed at, drawn rather than written, so
     nothing copied out of here carries a character the shell never saw. */
  .block.shell {
    color: var(--paper);
    border-left-color: var(--rule);
  }
  .block.shell::before {
    content: "› ";
    color: var(--paper-faint);
  }

  /* ── the diff ──────────────────────────────────────────────────────────
     Achromatic on purpose. Red and green is what every other tool does and this
     wall spends colour on status only — so the two sides are told apart by ink,
     by weight and by the gutter mark, which is how a printed diff has always
     done it. A removed line recedes to the shade of a note; an added one is
     brought up to full paper and given a hairline of its own. Wrapped lines
     hang under the gutter rather than under the mark, so a long line stays
     legible as one line. */
  .diff {
    display: flex;
    flex-direction: column;
    font-family: var(--mono);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.5;
    border-left: 1px solid var(--edge);
    padding: 0.15rem 0;
  }
  .row {
    padding-left: 1.6em;
    text-indent: -1.6em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--paper-faint);
  }
  .gut {
    display: inline-block;
    width: 1.6em;
    text-indent: 0;
    color: var(--paper-faint);
    user-select: none;
  }
  .row.out {
    color: var(--paper-mute);
    background: color-mix(in srgb, var(--well) 55%, transparent);
  }
  .row.in {
    color: var(--paper);
    background: color-mix(in srgb, var(--paper) 5%, transparent);
  }
  .row.in .gut,
  .row.out .gut {
    color: var(--paper-dim);
  }

  /* ── the result ────────────────────────────────────────────────────────
     Inset, so what came *back* is plainly a different thing from what went in.
     The rubric carries the size at the far end — the same ledger the closed
     head does, so the number is in the same place whether the call is open or
     shut. */
  .rubric {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    font-family: var(--util);
    font-size: calc(0.62rem * var(--read, 1));
    letter-spacing: 0.05em;
    color: var(--paper-faint);
    border-bottom: 1px dotted var(--edge);
    padding-bottom: 0.12rem;
  }
  .back {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  /* Rust on the rubric rather than through the text: which call failed is the
     question, and the answer wants to be at the top of the screenful of output
     you are about to read. The same call `Console.svelte` makes. */
  .back.failed .rubric {
    color: var(--st-fail);
    border-bottom-color: color-mix(in srgb, var(--st-fail) 40%, transparent);
  }
  /* The same hairline the argument blocks and the diff wear, so the result is
     plainly one more part of the call rather than loose text under it — and so
     that where it *ends* is as clear as where it begins, which for twenty-four
     lines of a file it otherwise is not. */
  .out {
    margin: 0;
    font-family: var(--mono);
    font-size: calc(0.68rem * var(--read, 1));
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--paper-mute);
    border-left: 1px solid var(--edge);
    padding-left: 0.5rem;
  }
  .back.failed .out {
    border-left-color: color-mix(in srgb, var(--st-fail) 35%, transparent);
  }

  /* Nothing to show, said rather than left blank: a fold that opens onto empty
     space reads as a bug in the panel, not as an empty result. */
  .none {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--util);
    font-size: calc(0.68rem * var(--read, 1));
    color: var(--paper-faint);
    font-style: italic;
  }
  /* What had to be cut, and where the whole of it still is. A fold that
     truncates quietly is a fold that has to be distrusted for everything else
     it shows. */
  .clip {
    margin: 0.15rem 0 0;
    font-family: var(--util);
    font-size: calc(0.62rem * var(--read, 1));
    color: var(--paper-faint);
  }
  /* What the call came back with, when what it came back with is a picture.
     Nothing decorative: no border, no shadow, no rounded corner — a screenshot
     already has its own frame, and dressing it would be the panel competing with
     the thing it is showing.

     `max-width: 100%` and `height: auto` and nothing else, so a 3200px capture
     sits inside a panel a third of a window wide without the column ever
     scrolling sideways. The `edge` rule underneath is the one concession, and it
     is there because a screenshot of a pale UI on pale paper has no boundary at
     all otherwise. */
  .shots {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.1rem 0 0.3rem;
  }
  .shot {
    display: block;
    max-width: 100%;
    height: auto;
    /* A backing while it decodes, so a large one does not flash the paper colour
       through at whatever height it happens to reserve. `--edge` rather than a
       new token: it is the one achromatic value in the palette meant for exactly
       this, a boundary that is neither ink nor paper. */
    background: var(--edge);
    outline: 1px solid var(--edge);
    outline-offset: -1px;
  }
  /* Asking for the rest. Set as a note rather than as a control, because it is
     one more line of the same reading — not a new gesture. */
  .more {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 0.1rem 0;
    font-family: var(--util);
    font-size: calc(0.64rem * var(--read, 1));
    color: var(--paper-faint);
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }
  .more:hover {
    color: var(--paper-dim);
  }
  .more::before {
    content: "▾ ";
  }
</style>
