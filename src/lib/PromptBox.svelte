<script lang="ts">
  /* The one input every agent-bound text is typed into.
   *
   * Pictures used to be the dock's: pasted or dropped into the prompt they went
   * into the sentence as chips, and everywhere else that sends words to an agent
   * — a question's answer, a notice's reply — silently lacked them (sink
   * fd7ef025). That is CLAUDE.md's "a capability every surface should have is
   * not a prop" in its plainest form, so attaching is no longer something a
   * surface wires: it is what this box does, and every agent-bound input is one
   * of these. `test/attaching.test.ts` holds that, and fails on a bare
   * `<textarea>` or `<input>` in an agent-bound component.
   *
   * ## What it owns
   *
   * - **Paste**: a picture goes into the sentence as a chip, a file copied in
   *   Explorer as its path, anything else with no path as bytes written at the
   *   send (`Attachments.takePaste`). A text paste is left to the field.
   * - **Drop**: it registers itself (`registerBox`), so `App.svelte`'s one drop
   *   handler finds it under the point. A folder dropped *into* a box is
   *   attached as its path; on the wall it still opens a card.
   * - **The tokens and the chips**: the tint layer behind a transparent
   *   textarea, switched on only while something is attached (`attach.md`).
   * - **The strip**: a thumbnail per picture, a tile per file, above the field.
   *   Clicking a picture or a tile's ✕ takes it out by taking its token out of
   *   the sentence; clicking a file's name opens it.
   * - **Pruning on every keystroke**, so the strip and the sentence can never
   *   disagree about what is attached.
   *
   * What it does not own is what Enter means, where the turn goes, and how the
   * box looks around the field — those are the surface's. Turning the draft
   * into a turn is `Attachments.turnFor` (plain logic, `attach.ts` underneath),
   * so a presentation other than this one can reuse all of it.
   *
   * ## The API, all of it
   *
   *     <PromptBox
   *       bind:text                  the sentence, tokens and all
   *       shots={attachments}        this draft's `Attachments`
   *       bind:el                    the textarea, for focus
   *       name="prompt"              optional: a box a surface can stand for
   *                                  (`data-attach-to`), the dock's field
   *       accepts={() => bool}       optional: whether a drop means anything now
   *       oncaret={(c) => …}         optional: told where the caret went after an
   *                                  insert the box made itself
   *       tint={snippet}             optional: a tint layer of the surface's own
   *                                  instead of the chips (the dock's `!` line)
   *       inkClass="shell"           optional: a class for that layer's box
   *       after={snippet}            optional: drawn in the field row, after the
   *                                  textarea (a send button, a key hint)
   *       …anything a textarea takes (onkeydown, placeholder, disabled, rows…)
   *     />
   *
   * Styled by custom properties so a surface sets the look without reaching in:
   * `--pb-bg`, `--pb-border`, `--pb-pad`, `--pb-size`, `--pb-max`, `--pb-font`. Defaults are
   * the dock's. */
  import { tick, untrack, type Snippet } from "svelte";
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { dropToken, insertAt, runsOf, sizeNote } from "./attach";
  import { dropping, registerBox, type Attachments, type Landing } from "./attach.svelte";
  import { useOpener } from "./paths.svelte";

  let {
    text = $bindable(""),
    shots,
    el = $bindable(),
    name,
    accepts,
    oncaret,
    tint,
    inkClass = "",
    after,
    ...rest
  }: {
    text: string;
    shots: Attachments;
    el?: HTMLTextAreaElement;
    name?: string;
    accepts?: () => boolean;
    oncaret?: (caret: number) => void;
    tint?: Snippet;
    inkClass?: string;
    after?: Snippet;
  } & Omit<HTMLTextareaAttributes, "value"> = $props();

  const opener = useOpener();
  let boxEl = $state<HTMLElement>();

  /* Typing has to prune, not only the writes that replace a whole line: the
     text is two-way bound, so an ordinary keystroke never reaches anything else,
     and deleting a token would otherwise leave its picture in the strip and
     counted against the cap while the send left it out. `untrack` because
     `prune` reads and writes the list; it assigns only when something went. */
  $effect(() => {
    const t = text;
    untrack(() => shots.prune(t));
  });

  /** Is the field drawing its own text, so the chips can be drawn in it? Only
   *  while something is attached: transparent glyphs cost an IME its visible
   *  composition, which is worth paying only on a draft with a chip to show. */
  const marked = $derived(!tint && shots.any);

  /** Put something into the sentence where the caret is (or on the end), with
   *  the spacing a person would have typed, and leave the caret after it. */
  function place(puts: string[], where: Landing = "caret") {
    if (!puts.length) return;
    /* All at once, each after the last: the textarea's own selection moves only
       after the next render, so reading it between two inserts would put the
       second token in front of the first. */
    let at = { text, caret: where === "end" || !el ? (null as number | null) : el.selectionStart };
    for (const put of puts) at = insertAt(at.text, at.caret, put);
    const caret = at.caret!;
    text = at.text;
    oncaret?.(caret);
    void tick().then(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
      edited();
    });
  }

  /** Say an edit the box made itself the way a keystroke would, so a surface
   *  that keeps its words on `input` (a question's answer, a notice's reply,
   *  the dock waking its card) hears a pasted token as it hears a typed one. */
  function edited() {
    el?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function onpaste(e: ClipboardEvent) {
    const taking = shots.takePaste(e);
    if (!taking) return;
    /* Ours now: the window's own paste handler pins a picture to the wall,
       which is the one thing a paste into a prompt must not do. */
    e.stopPropagation();
    void taking.then(({ said, tokens }) => place(said ? [said, ...tokens] : tokens));
  }

  /** Take an attachment out, by taking its token out of the sentence — the
   *  only thing an attachment is (`attach.ts::dropToken`). */
  function detach(n: string) {
    text = dropToken(text, n);
    void tick().then(edited);
  }

  function register(root: HTMLElement) {
    return registerBox(
      root,
      {
        accepts,
        take: async (paths, where, links = [], refused = []) => {
          const tokens = paths.length ? await shots.fromPaths(paths) : [];
          place([...tokens, ...links], where);
          if (refused.length) shots.refused = refused.join(" · ");
        },
      },
      name,
    );
  }
</script>

<div class="box" data-attach class:dropping={dropping.over !== null && dropping.over === boxEl} bind:this={boxEl} {@attach register}>
  <!-- Above the field, so the pictures sit between whatever heads the surface
       and the sentence that refers to them, and the field never moves as you
       type. Drawn only when there is something in it. -->
  {#if shots.any}
    <div class="shots">
      {#each shots.list as a (a.id)}
        {#if a.kind === "picture"}
          <button
            class="shot"
            type="button"
            title="{a.name} — {sizeNote(a)}. Click to take it out of the prompt."
            onclick={() => detach(a.name)}
          >
            <img src={a.thumb} alt="" />
            <span class="what">
              <span class="who">{a.name}</span>
              <span class="how">{sizeNote(a)}</span>
            </span>
            <span class="off" aria-hidden="true">✕</span>
          </button>
        {:else}
          {@const open = a.kind === "file" ? opener() : null}
          <span class="shot tile" title="{a.name} — {sizeNote(a)}">
            <span class="glyph" class:dir={a.kind === "file" && a.dir} aria-hidden="true"></span>
            {#if a.kind === "file" && open}
              <button class="what open" type="button" title="Open {a.path}" onclick={() => open(a.path, "open")}>
                <span class="who">{a.name}</span>
                <span class="how">{sizeNote(a)}</span>
              </button>
            {:else}
              <span class="what">
                <span class="who">{a.name}</span>
                <span class="how">{sizeNote(a)}</span>
              </span>
            {/if}
            <button class="off" type="button" title="Take it out of the prompt" onclick={() => detach(a.name)}
              >✕</button
            >
          </span>
        {/if}
      {/each}
    </div>
  {/if}
  <!-- A refusal is said once and where the gesture was made: dropping eighty
       files on a box is a thing that happens by accident, and the answer
       belongs beside the thing you dropped them on. -->
  {#if shots.refused}
    <p class="refused">{shots.refused}</p>
  {/if}
  <div class="field">
    <div class="ink {inkClass}" class:marked>
      {#if tint}
        {@render tint()}
      {:else if marked}
        <!-- The runs concatenate back to exactly what went in, or every glyph
             after a dropped character sits over the wrong place. -->
        <div class="tint" aria-hidden="true">{#each runsOf(text, shots.list) as r, i (i)}{#if r.chip}<span
                class="chip">{r.text}</span
              >{:else}{r.text}{/if}{/each}</div>
      {/if}
      <textarea bind:this={el} bind:value={text} {onpaste} {...rest}></textarea>
    </div>
    {@render after?.()}
  </div>
</div>

<style>
  .box {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* A drag is overhead and would land here. An outline rather than a fill:
     washing the box over hides the very draft the file is about to be written
     into. Achromatic — colour on this wall is status, and a drop is none. */
  .box.dropping .field {
    outline: 1px dashed var(--paper-faint);
    outline-offset: 2px;
  }
  .field {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    background: var(--pb-bg, var(--well));
    border: var(--pb-border, 1px solid var(--edge));
    border-radius: 3px;
    padding: var(--pb-pad, 0.5rem 0.65rem);
  }
  .ink {
    position: relative;
    flex: 1 1 auto;
    display: flex;
    min-width: 0;
  }
  /* `:global` for the one class a surface's own tint snippet draws into: the
     layer is the surface's markup inside this box, so it cannot be scoped from
     either side alone. */
  .ink :global(.tint) {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: hidden;
  }
  textarea {
    flex: 1 1 auto;
    min-width: 0;
    background: none;
    border: 0;
    resize: none;
    color: var(--paper);
    font-family: var(--pb-font, var(--body));
    font-size: var(--pb-size, 0.9rem);
    line-height: 1.45;
    max-height: var(--pb-max, 7rem);
    field-sizing: content;
    padding: 0;
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--paper-faint);
  }
  textarea:disabled {
    opacity: 0.6;
  }
  /* The same trick as the `!` line: the text is drawn once underneath and the
     textarea is only where it is typed. Both halves take the same metrics or the
     chips drift off the characters they sit on. */
  .ink.marked textarea,
  .ink.marked .tint {
    font-family: var(--pb-font, var(--body));
    font-size: var(--pb-size, 0.9rem);
    line-height: 1.45;
  }
  .ink.marked textarea {
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.marked textarea::selection {
    background: var(--edge);
  }
  .ink.marked .tint {
    color: var(--paper);
  }
  /* A chip is the same glyphs with a background behind them — anything that
     changed the token's width would move the text out from under the caret.
     Achromatic, because colour on this wall means status. */
  .chip {
    background: var(--edge);
    color: var(--paper);
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.4rem;
  }
  .shot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.3rem 0.2rem 0.2rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    text-align: left;
    font: inherit;
    color: var(--paper-mute);
  }
  button.shot {
    cursor: pointer;
  }
  button.shot:hover,
  .tile:hover {
    border-color: var(--paper-faint);
    color: var(--paper);
  }
  .shot img {
    /* A fixed box with the picture covering it, so a wide screenshot and a tall
       one make the same shape. Opaque behind, or an alpha corner shows the
       ambience through a thumbnail. */
    width: 2rem;
    height: 2rem;
    object-fit: cover;
    border-radius: 2px;
    background: var(--surface);
  }
  /* A file has no picture to show, so the tile says what it is by shape: a
     page with a turned corner, or a folder's tab. Drawn in CSS — a glyph from a
     font falls through to an emoji face and comes out in colour. */
  .glyph {
    position: relative;
    width: 1.1rem;
    height: 1.4rem;
    margin: 0.3rem 0.35rem;
    border: 1px solid var(--paper-faint);
    border-radius: 1px 5px 1px 1px;
  }
  .glyph.dir {
    width: 1.5rem;
    height: 1.05rem;
    border-radius: 1px 2px 1px 1px;
  }
  .glyph.dir::before {
    content: "";
    position: absolute;
    left: -1px;
    top: -0.3rem;
    width: 0.6rem;
    height: 0.25rem;
    border: 1px solid var(--paper-faint);
    border-bottom: 0;
    border-radius: 2px 2px 0 0;
  }
  .what {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
    min-width: 0;
  }
  .what.open {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .what.open:hover .who {
    text-decoration: underline;
  }
  .who {
    font-size: 0.72rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 14rem;
  }
  .how {
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .off {
    font-size: 0.7rem;
    color: var(--paper-faint);
    padding-left: 0.1rem;
    background: none;
    border: 0;
    font-family: inherit;
  }
  button.off {
    cursor: pointer;
  }
  .shot:hover .off {
    color: var(--paper);
  }
  .refused {
    margin: 0 0 0.35rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-mute);
  }
</style>
