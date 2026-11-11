<script lang="ts">
  /* What cards can do to each other, drawn as five verbs rather than listed
   * as five bullets.
   *
   * Each one is a real mechanism with a cost, and the cost is the interesting
   * part: a message spends a turn on the other card, a read spends none, a
   * spawn spends a process. Choosing a verb in this demo is what makes that
   * difference visible, which a paragraph cannot do.
   */
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";

  type Act = "message" | "read" | "spawn" | "board" | "sink";

  let act = $state<Act>("message");
  let spawned = $state(false);

  const VERBS: { id: Act; label: string; said: string }[] = [
    { id: "message", label: "send a message", said: "costs the other card a turn" },
    { id: "read", label: "read its transcript", said: "costs nothing" },
    { id: "spawn", label: "open a worker", said: "costs a process" },
    { id: "board", label: "post a notice", said: "seen by every card" },
    { id: "sink", label: "drop a finding", said: "outlives the card" },
  ];

  const COPY: Record<Act, string> = {
    message:
      "A message arrives in the other card's hands as a turn of its own. The sender does not wait for it. Guards stop two cards answering each other forever, and a card that is dormant gets the message when it wakes.",
    read:
      "`recall` reads the other card's transcript off disk, so a coordinator can ask what a worker already found without waking it or spending one of its turns. This is the cheap way to catch up on a card you did not watch.",
    spawn:
      "A card opens a card. The child gets its own process, its own session and its own account, and the wall draws a line between them. A card names a territory, never a folder, and the spawn bounds are what stop one card filling the machine.",
    board:
      "A billboard notice is a standing claim about work in progress. Every card on the wall can read it, and the file globs on it are how the right card is told about it when it touches those files.",
    sink:
      "A finding goes in one pile and outlives the card that made it. Two findings with the same title merge into one item with two voices, which is what stops the seventh duplicate being written.",
  };

  const prose = $derived(parseMarkdown(COPY[act]));

  function choose(id: Act) {
    act = id;
    if (id === "spawn") spawned = true;
  }
</script>

<div class="relay">
  <div class="stage">
    <svg class="wires" viewBox="0 0 720 300" aria-hidden="true">
      <defs>
        <linearGradient id="relayflow" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--paper-mute)" stop-opacity="0.15" />
          <stop offset="1" stop-color="var(--paper-mute)" stop-opacity="0.45" />
        </linearGradient>
      </defs>
      <path d="M258 128 C 330 128, 350 96, 424 96" fill="none" stroke="url(#relayflow)" stroke-width="1.2" />
      <path d="M258 152 C 330 152, 350 206, 424 206" fill="none" stroke="url(#relayflow)" stroke-width="1.2" stroke-dasharray="3 4" />
      {#if spawned}
        <path d="M140 168 C 140 196, 140 208, 140 230" fill="none" stroke="url(#relayflow)" stroke-width="1.2" />
      {/if}

      {#if act === "message"}
        <circle class="mote out" r="3.4" fill="var(--st-work)">
          <animateMotion dur="760ms" fill="freeze" path="M258 128 C 330 128, 350 96, 424 96" />
        </circle>
      {:else if act === "read"}
        <circle class="mote back" r="3.4" fill="var(--st-work)">
          <animateMotion dur="760ms" fill="freeze" path="M424 206 C 350 206, 330 152, 258 152" />
        </circle>
      {/if}
    </svg>

    <div class="card parent">
      <span class="proj">portfolio</span>
      <span class="name">Land the billing split</span>
      <span class="foot"><i></i>working</span>
    </div>

    <div class="card worker" class:lit={act === "message"}>
      <span class="proj">portfolio</span>
      <span class="name">Worker: write the backfill</span>
      <span class="foot"><i data-st="rest"></i>{act === "message" ? "a message arrived" : "at rest"}</span>
    </div>

    <div class="card reader" class:lit={act === "read"}>
      <span class="proj">paperwork</span>
      <span class="name">Worker: reconcile invoices</span>
      <span class="foot"><i data-st="work"></i>{act === "read" ? "read, not woken" : "working"}</span>
    </div>

    {#if spawned}
      <div class="card child" class:lit={act === "spawn"}>
        <span class="proj">portfolio</span>
        <span class="name">Worker: the audit backfill</span>
        <span class="foot"><i data-st="work"></i>just opened</span>
      </div>
    {/if}

    {#if act === "board"}
      <div class="notice">
        <span class="pinmark" aria-hidden="true"></span>
        <b>billing split is landing</b>
        <span>src/billing/**, migrations/2026-11-*</span>
      </div>
    {/if}

    {#if act === "sink"}
      <div class="tray">
        <span class="trayword">the sink</span>
        <span class="trayrow">the retry path double-writes on a claim</span>
        <span class="trayrow second">the dead-letter path has no test</span>
      </div>
    {/if}
  </div>

  <div class="verbs" role="group" aria-label="what a card can do">
    {#each VERBS as v (v.id)}
      <button type="button" class="verb" class:on={act === v.id} onclick={() => choose(v.id)}>
        <span class="vlab">{v.label}</span>
        <span class="vsaid">{v.said}</span>
      </button>
    {/each}
  </div>

  <div class="md saying"><Markdown blocks={prose} nav={false} /></div>
</div>

<style>
  .relay {
    display: grid;
    gap: 13px;
  }
  .stage {
    position: relative;
    height: 300px;
    border-radius: 13px;
    border: 1px solid color-mix(in oklab, var(--edge) 80%, transparent);
    overflow: hidden;
    background:
      radial-gradient(1px 1px at 10px 10px, color-mix(in oklab, var(--paper) 7%, transparent) 99%, transparent) 0 0 / 24px 24px,
      var(--ink);
  }
  .wires {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .mote {
    filter: drop-shadow(0 0 5px currentColor);
  }
  .card {
    position: absolute;
    width: 190px;
    display: grid;
    gap: 3px;
    padding: 8px 10px;
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--edge);
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      box-shadow var(--dur-quick, 160ms) var(--ease-out, ease-out),
      transform var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .card.lit {
    border-color: color-mix(in oklab, var(--st-ask) 55%, var(--edge));
    box-shadow: 0 0 22px -6px color-mix(in oklab, var(--st-ask) 60%, transparent);
  }
  .parent {
    left: 32px;
    top: 104px;
  }
  .worker {
    left: 424px;
    top: 64px;
  }
  .reader {
    left: 424px;
    top: 174px;
    border-style: dashed;
  }
  .child {
    left: 96px;
    top: 230px;
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .proj {
    font-size: 8.5px;
    letter-spacing: 0.02em;
    color: var(--paper-faint);
  }
  .name {
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--paper-dim);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 8.5px;
    color: var(--paper-mute);
  }
  .foot i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
  }
  .foot i[data-st="rest"] {
    background: var(--st-rest);
  }
  .notice {
    position: absolute;
    right: 20px;
    top: 16px;
    width: 218px;
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: var(--surface);
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  .pinmark {
    position: absolute;
    left: -4px;
    top: 8px;
    width: 3px;
    height: 16px;
    border-radius: 2px;
    background: var(--st-ask);
  }
  .notice b {
    font-size: 10.5px;
    font-weight: 500;
    color: var(--paper-dim);
  }
  .notice span {
    font-size: 9px;
    color: var(--paper-faint);
  }
  .tray {
    position: absolute;
    left: 300px;
    top: 236px;
    width: 300px;
    display: grid;
    gap: 3px;
    padding: 8px 10px 9px;
    border-radius: 8px;
    border: 1px solid color-mix(in oklab, var(--edge) 75%, transparent);
    background: var(--well);
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  .trayword {
    font-size: 8.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .trayrow {
    font-size: 10px;
    color: var(--paper-dim);
  }
  .trayrow.second {
    color: var(--paper-mute);
    border-top: 1px solid color-mix(in oklab, var(--edge) 55%, transparent);
    padding-top: 3px;
  }
  .verbs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .verb {
    display: grid;
    gap: 1px;
    padding: 7px 10px;
    text-align: left;
    font: inherit;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 72%, transparent);
    background: transparent;
    cursor: pointer;
    transition:
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .verb:hover {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 20%);
  }
  .verb.on {
    border-color: color-mix(in oklab, var(--st-ask) 50%, var(--edge));
    background: color-mix(in oklab, var(--st-ask) 7%, transparent);
  }
  .vlab {
    font-size: 11.5px;
    color: var(--paper-dim);
  }
  .verb.on .vlab {
    color: var(--paper);
  }
  .vsaid {
    font-size: 9.5px;
    color: var(--paper-faint);
  }
  .md {
    font-family: var(--body);
    font-size: 13px;
    line-height: 1.62;
    color: var(--paper-dim);
    --tx-size: 0.86rem;
    --tx-leading: 1.6;
    --tx-prose: var(--paper-dim);
  }
  @media (prefers-reduced-motion: reduce) {
    .child,
    .notice,
    .tray {
      animation: none;
    }
  }
</style>
