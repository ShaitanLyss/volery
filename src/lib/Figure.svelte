<script lang="ts">
  /* A `show` call, drawn as what it showed: a picture where the agent showed
     it, with its caption under it — or, for a file that is not a picture, a
     plate that opens it. The one tool call the transcript does not fold away
     with the machinery (`transcript.ts`'s `shown` block).

     What the call came to is `showing.ts::shownOf`, asked of the call and its
     result and nothing else, so a card read back off disk draws the same
     figure: the result names the copy `show.rs` kept and the size it is, and
     the copy is what is drawn — the picture as it was shown, not the file as it
     is now — in a box that is its size from the first frame. */
  import type { Line } from "./conversation.svelte";
  import InlinePicture from "./InlinePicture.svelte";
  import { fullPath, splitPath } from "./finding";
  import { pictureMarkdown } from "./markdown";
  import { useOpener, usePictureRoot } from "./paths.svelte";
  import { nameOf, shownOf } from "./showing";

  let { line }: { line: Line } = $props();

  /* Which directory a relative path in the call counts from — off the scope the
     transcript set rather than a prop, so no surface can draw a figure against
     the wrong one by forgetting to pass it. `null` is a card whose pictures are
     not on this machine (a card on another wall), and then nothing is read. */
  const pictureRoot = usePictureRoot();
  const root = $derived(pictureRoot());
  const opener = useOpener();
  const shown = $derived(line.call ? shownOf(line.call) : null);
  const full = $derived(shown && root && shown.path ? fullPath(root, shown.path) : (shown?.path ?? ""));
  const name = $derived(shown ? nameOf(shown.path) || "a file" : "a file");
  const alt = $derived(shown?.caption || name);
  /* What a selection across the figure copies as — the caption as the alt and
     the agent's own path as the source, which is the stable thing to paste: the
     kept copy's name means nothing outside this machine's studio. */
  const md = $derived(shown ? pictureMarkdown(alt, shown.path) : "");
  const fileMd = $derived(
    shown ? `[${name.replace(/[[\]]/g, "")}](${/[\s()<>]/.test(shown.path) ? `<${shown.path}>` : shown.path})` : "",
  );
  /* The tool's refusal is addressed to the agent, and its first sentence is the
     part that is also news to you — what was wrong. The advice after it is for
     the agent, and stays in the tooltip. */
  const why = $derived(
    shown?.state === "refused" ? (/^.*?[.!?](?=\s|$)/s.exec(shown.why)?.[0] ?? shown.why) : "",
  );

  function open(e: MouseEvent) {
    const go = opener();
    if (!go || !full) return;
    go(full, e.ctrlKey || e.metaKey ? "reveal" : "open");
  }
</script>

{#if shown}
  {#if shown.state === "picture" && !root}
    <!-- A card on another wall: its kept copy is on that machine. Said, in the
         box the picture would have had, rather than drawn from a file of the
         same name here — which would be a different picture. -->
    <div class="figure refused" data-md={md} role="note">
      <span class="name">{name}</span> was shown on the wall this card runs on, and its copy is kept
      there{#if shown.caption} — {shown.caption}{/if}
    </div>
  {:else if shown.state === "picture"}
    <!-- `figure` and `figcaption`, so the caption is the picture's name to a
         screen reader and not a paragraph that happens to follow it. -->
    <figure class="figure" data-md={md}>
      <InlinePicture
        source={{ kind: "kept", id: shown.kept, path: full }}
        {alt}
        {md}
        size={shown.size}
        caption={shown.caption}
      />
      {#if shown.caption}<figcaption>{shown.caption}</figcaption>{/if}
    </figure>
  {:else if shown.state === "file"}
    {@const where = splitPath(full || shown.path)}
    <figure class="figure" data-md={fileMd}>
      <button
        type="button"
        class="plate"
        disabled={!opener() || !root}
        title={opener() && root ? `open ${name} · ctrl-click to show it in Explorer` : name}
        onclick={open}
        ><span class="name">{name}</span>{#if where.dir}<span class="dir">{where.dir}</span>{/if}</button
      >
      {#if shown.caption}<figcaption>{shown.caption}</figcaption>{/if}
    </figure>
  {:else if shown.state === "pending"}
    <div class="figure note pending" data-md={md}>showing {name}…</div>
  {:else}
    <!-- Nothing was shown, and the gap says so in a box that names the file
         and the reason — never an empty space that reads as the panel having
         lost a picture. -->
    <div class="figure refused" data-md={`${name} was not shown — ${why}`} title={shown.why} role="note">
      <span class="name">{name}</span> was not shown — {why}
    </div>
  {/if}
{/if}

<style>
  /* Its own room in the column, like a line: the picture is the turn saying
     something, so it takes the line's measure rather than a fold's. */
  .figure {
    max-width: 78ch;
    margin: 0.2em 0;
    font-size: calc(0.86rem * var(--read, 1));
  }
  figcaption {
    margin-top: -0.2em;
    font-family: var(--util);
    font-size: 0.82em;
    line-height: 1.45;
    color: var(--paper-dim);
    overflow-wrap: anywhere;
  }
  /* A file that is not a picture: its name, plainly, and the folder it is in,
     quietly — the same split the finder draws a path with. A plate rather than
     a link, because it stands for the file rather than mentioning it. */
  .plate {
    display: flex;
    flex-direction: column;
    gap: 0.1em;
    max-width: 100%;
    padding: 0.45em 0.7em;
    font: inherit;
    text-align: left;
    color: var(--paper);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    cursor: pointer;
  }
  .plate:hover:not(:disabled),
  .plate:focus-visible {
    border-color: var(--paper-faint);
  }
  .plate:disabled {
    cursor: default;
  }
  .name {
    font-family: var(--mono);
    font-size: 0.92em;
    color: var(--paper-dim);
    overflow-wrap: anywhere;
  }
  .plate .name {
    color: var(--paper);
  }
  .dir {
    font-family: var(--util);
    font-size: 0.78em;
    color: var(--paper-mute);
    overflow-wrap: anywhere;
  }
  .note {
    font-family: var(--util);
    font-size: calc(0.74rem * var(--read, 1));
    color: var(--paper-mute);
    overflow-wrap: anywhere;
  }
  /* Not landed yet — the panel's one spelling of "not settled", the dashed
     rule a pending prompt and an unclosed fence already wear. */
  .pending {
    padding-left: 0.5em;
    border-left: 1px dashed var(--edge);
  }
  /* Not shown, in the register a picture that could not be drawn uses: a quiet
     box with a dashed edge, naming the file and the reason. */
  .refused {
    padding: 0.5em 0.8em;
    font-family: var(--util);
    font-size: calc(0.74rem * var(--read, 1));
    line-height: 1.45;
    color: var(--paper-mute);
    background: var(--ink);
    border: 1px dashed var(--edge);
    border-radius: 3px;
    overflow-wrap: anywhere;
  }
</style>
