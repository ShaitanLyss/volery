<!--
  The plate drawn under a message that came with files (`send_files`,
  `parcel.rs`): what was sent, where it landed, what was left out and why.

  It is the manifest block the agent was handed, read back (`relay.ts::parcelOf`),
  so a person sees exactly what the agent was told it has — one drawing for the
  wall's fold and chat view's letter, received or sent.

  Achromatic, because colour on this wall is status. A secret-shaped file sent
  because it was named is flagged loudly all the same — inverted ink and a line
  of its own at the top — since that flag is the whole of what stands in for a
  confirmation (Lyss, 2026-11-06: no click, flag it loudly).
-->
<script lang="ts">
  import type { Parcel } from "./relay";
  import { tipOf } from "./tipped.svelte";

  let { parcel, dir = "in" }: { parcel: Parcel; dir?: "in" | "out" } = $props();

  const secrets = $derived(parcel.sent.filter((s) => s.secret));
  const leftCount = $derived(parcel.left.length + parcel.leftMore);
  let copied = $state(false);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(parcel.landed);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* A clipboard refused is a button that did nothing; the path is still
         on the plate to select by hand. */
    }
  }
</script>

<div class="parcel" class:out={dir === "out"} data-parcel>
  <div class="head">
    <span class="glyph" aria-hidden="true"></span>
    <span class="count">{parcel.files}{parcel.size ? ` · ${parcel.size}` : ""}</span>
    <span class="verb">{dir === "out" ? "sent with it" : "came with it"}</span>
  </div>
  {#if secrets.length}
    <div class="secret-line" role="note">
      {secrets.length === 1 ? "1 secret-shaped file" : `${secrets.length} secret-shaped files`} — sent because
      {secrets.length === 1 ? "it was" : "they were"} named. Never printed.
    </div>
  {/if}
  <ul class="sent">
    {#each parcel.sent as s, i (i)}
      <li>
        <span class="name" class:dir={s.dir}>{s.name}</span>
        {#if s.secret}<span class="flag">secret-shaped</span>{/if}
        {#if s.detail}<span class="detail">{s.detail}</span>{/if}
      </li>
    {/each}
    {#if parcel.sentMore}<li class="detail">and {parcel.sentMore} more</li>{/if}
  </ul>
  {#if parcel.landed}
    <div class="landed">
      <span class="lbl">in</span>
      <span class="path" {@attach tipOf(() => (parcel.landed))}>{parcel.landed}</span>
      {#if dir === "in"}
        <button type="button" class="copy" onclick={copyPath} {@attach tipOf("copy where the files are")}>
          {copied ? "copied" : "copy path"}
        </button>
      {/if}
    </div>
  {:else if parcel.to}
    <div class="landed">
      <span class="lbl">to</span>
      <span class="path" {@attach tipOf(() => (parcel.to ?? ""))}>{parcel.to}</span>
    </div>
  {/if}
  {#if leftCount}
    <details class="left">
      <summary>{leftCount === 1 ? "1 thing left out" : `${leftCount} things left out`}</summary>
      <ul>
        {#each parcel.left as l, i (i)}
          <li><span class="name">{l.path}</span> <span class="detail">{l.why}</span></li>
        {/each}
        {#if parcel.leftMore}<li class="detail">and {parcel.leftMore} more</li>{/if}
      </ul>
    </details>
  {/if}
</div>

<style>
  .parcel {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: var(--cv-r-s, 8px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 70%, transparent);
    font-family: var(--cv-ui, var(--util));
    font-size: 12.5px;
    color: var(--paper);
  }
  .parcel.out {
    border-style: dashed;
    background: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  /* A folded sheet: two rectangles, offset — drawn in CSS so no glyph falls
     through to a colour emoji face. */
  .glyph {
    position: relative;
    width: 11px;
    height: 9px;
    border: 1.5px solid var(--paper-mute);
    border-radius: 1.5px;
    align-self: center;
  }
  .glyph::before {
    content: "";
    position: absolute;
    left: 2px;
    top: -4px;
    width: 5px;
    height: 3px;
    border: 1.5px solid var(--paper-mute);
    border-bottom: none;
    border-radius: 1.5px 1.5px 0 0;
  }
  .count {
    color: var(--paper);
  }
  .verb {
    color: var(--paper-mute);
  }
  .secret-line {
    margin: 2px 0 8px;
    padding: 5px 8px;
    border-radius: 4px;
    background: var(--paper);
    color: var(--ink);
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .detail {
    color: var(--paper-mute);
  }
  .flag {
    padding: 0 6px;
    border-radius: 3px;
    background: var(--paper);
    color: var(--ink);
    font-size: 11px;
    font-weight: 600;
  }
  .landed {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 8px;
    min-width: 0;
  }
  .lbl {
    color: var(--paper-mute);
  }
  .path {
    flex: 1;
    min-width: 0;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 11.5px;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  .copy {
    background: none;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 4px;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    padding: 0 6px;
    cursor: pointer;
  }
  .copy:hover,
  .copy:focus-visible {
    color: var(--paper);
  }
  .left {
    margin-top: 8px;
    color: var(--paper-mute);
  }
  .left summary {
    cursor: pointer;
  }
  .left ul {
    margin-top: 4px;
  }
</style>
