<script lang="ts">
  /* One menu beside send for the model and how hard it thinks (`docs/chat-mode.md`
     §4.3, the mockup's `sonnet 5.5 · medium`): the wall's five presets and
     *as claude code is set up*, one scale rather than two levers.

     For a new conversation it is the preset the card opens with — the starter
     keeps the choice and `Skein.openChat`/`open` carry it to the row. For an
     open one it sends `/model` and then `/effort`, as typing them does today
     (`starting.ts::switchLines`): a running process's model is changed by
     asking it, never by respawning. *As claude code is set up* is not offered
     there — a conversation cannot be told to forget a model it was given. */
  import Icon from "./Icon.svelte";
  import PickMenu, { type PickRow } from "./PickMenu.svelte";
  import type { CardHandle } from "./cards.svelte";
  import type { Starter } from "./starting.svelte";
  import { presetById } from "./presets";
  import { turnOf } from "./attach";
  import { chipSaid, modelSaid, presetRows, switchLines } from "./starting";

  let {
    card,
    starter,
    up = false,
  }: {
    /** The conversation in front of you, or null on the empty sheet. */
    card: CardHandle | null;
    starter: Starter;
    up?: boolean;
  } = $props();

  let open = $state(false);
  const conv = $derived(card?.conv ?? null);

  /** The family a model is, for matching a preset to what a card runs. */
  const family = (m: string | null | undefined) => modelSaid(m).split(" ")[0] ?? "";

  const chip = $derived(
    conv ? chipSaid(conv.model ?? null, conv.effort ?? null) : chipSaid(starter.resolved?.model, starter.resolved?.effort),
  );

  const rows = $derived<PickRow[]>(
    presetRows()
      .filter((r) => !conv || r.id !== "")
      .map((r, i) => {
        const p = presetById(r.id);
        const on = conv
          ? !!p && family(p.model) === family(conv.model) && (p.effort ?? null) === (conv.effort ?? null)
          : r.id === (starter.preset === null ? (starter.resolved?.id ?? "") : starter.preset);
        return { id: r.id, label: r.label, aside: r.chip, on, sep: r.id === "" && i > 0 };
      }),
  );

  /** Alt+M opens it from anywhere in chat view. The window's own listener,
     because one of these is mounted at a time — the empty sheet's or the
     message box's — and whichever is up is the one meant. */
  function onWindowKey(e: KeyboardEvent) {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "m" && e.key !== "M")) return;
    if (card && !conv) return;
    e.preventDefault();
    open = !open;
  }

  async function pick(id: string) {
    open = false;
    if (!card) {
      starter.choosePreset(id);
      return;
    }
    const p = presetById(id);
    if (!p) return;
    for (const line of switchLines(p)) await card.say(line, turnOf(line, []));
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if !card || conv}
  <span class="wrap">
    <button
      type="button"
      class="model"
      aria-haspopup="menu"
      aria-expanded={open}
      title={card ? "the model and how hard it thinks — sends /model and /effort (alt+M)" : "what this conversation opens as (alt+M)"}
      onclick={() => (open = !open)}
    >
      <span class="full">{chip}</span><span class="short">{chip.split(" ")[0]}</span><Icon
        name="chev-d"
        small
      />
    </button>
    {#if open}
      <PickMenu {rows} {up} label="model and effort" onpick={(id) => void pick(id)} onclose={() => (open = false)} />
    {/if}
  </span>
{/if}

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }
  /* Below 600px the chip says only the model's family (§6.8). */
  .short {
    display: none;
  }
  @media (max-width: 599px) {
    .full {
      display: none;
    }
    .short {
      display: inline;
    }
  }
  .wrap :global(.menu) {
    left: auto;
    right: 0;
  }
  .model {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--paper-dim);
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--dur-tap, 90ms) var(--ease-out, ease-out);
  }
  .model:hover,
  .model[aria-expanded="true"] {
    background: color-mix(in oklab, var(--paper) 6%, transparent);
    color: var(--paper);
  }
</style>
