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
  import { providerOf } from "./providers";
  import { turnOf } from "./attach";
  import { chipSaid, modelSaid, presetRows, switchLines } from "./starting";
  import { tipOf } from "./tipped.svelte";
  import { standings } from "./standings.svelte";
  import { profileFor, standingLine } from "./benchmarks";
  import { onMount } from "svelte";

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
  /* What the card runs, off its gist — so a card on another wall states its
     model here too, and is switched by the same `/model` line, which its wall
     carries out as if typed there (`card.say`). It used to read `card.conv`,
     and a card elsewhere drew no chip at all. */
  const runs = $derived(card ? { model: card.gist.model, effort: card.gist.effort } : null);
  /** Which provider an open card is on; null for a Claude card. A card's
   *  provider is fixed at birth, so its menu offers only its own models —
   *  picking the other family would send `/model` a name that endpoint cannot
   *  serve, and is the one way this chip could move a card off its provider. */
  const live = $derived(card ? providerOf(card.gist.account) : null);
  /** A card opened on another wall cannot be put on a provider: its key is
   *  here, not there. Same rule as `openThere`. */
  const remote = $derived(!card && starter.machine !== null);

  /** The family a model is, for matching a preset to what a card runs. */
  const family = (m: string | null | undefined) => modelSaid(m).split(" ")[0] ?? "";

  const chip = $derived(
    runs ? chipSaid(runs.model, runs.effort) : chipSaid(starter.resolved?.model, starter.resolved?.effort),
  );
  /** Below 600px the chip is one word. "deepseek" alone cannot tell flash from
   *  pro, so a provider gets two short ones. */
  const short = $derived(
    chip.startsWith("deepseek ")
      ? chip.replace("deepseek ", "ds ").split(" ·")[0]
      : chip.split(" ")[0],
  );

  /* What the menu is choosing between, measured. The store is the panel's; a
     menu that arrives first asks for the profile that fits this card, and one
     that arrives second uses what is already there — and says which profile
     that is on every row, so the two can never be mistaken for each other. */
  const fitting = $derived(profileFor(card && !card.reach.chat ? "project" : "chat"));
  onMount(() => {
    if (!standings.view) void standings.load(fitting.id);
  });

  const rows = $derived<PickRow[]>(
    presetRows()
      .filter((r) => !runs || r.id !== "")
      /* No provider rows where the card cannot use them: a remote opening, or
         an open card already on the other side of the choice. */
      .filter((r) => !remote || !presetById(r.id)?.provider)
      .filter((r) => !runs || (presetById(r.id)?.provider ?? null) === (live?.id ?? null))
      .map((r, i) => {
        const p = presetById(r.id);
        /* Provider rows compare the *model*, not the family: `modelSaid` gives
           both DeepSeek models "deepseek", so family+effort would tick pro on a
           flash card told to think harder. */
        const on = runs
          ? p && p.provider
            ? p.model === runs.model
            : !live && !!p && family(p.model) === family(runs.model) && (p.effort ?? null) === (runs.effort ?? null)
          : r.id === (starter.preset === null ? (starter.resolved?.id ?? "") : starter.preset);
        const model = p ? standings.entryForAlias(p.model) : null;
        return {
          id: r.id,
          label: r.label,
          aside: r.chip,
          /* The measurement, where the choice is made. A model the sources did
             not read says so rather than carrying a blank, and the profile is
             named because a score without one is a claim about every kind of
             work. */
          note: p ? standingLine(model, standings.profile) : undefined,
          on,
          sep: r.sep || (r.id === "" && i > 0),
        };
      }),
  );

  /** Alt+M opens it from anywhere in chat view. The window's own listener,
     because one of these is mounted at a time — the empty sheet's or the
     message box's — and whichever is up is the one meant. */
  function onWindowKey(e: KeyboardEvent) {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "m" && e.key !== "M")) return;
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
    /* The rows are filtered, so this is belt to the filter's braces: a pick
       that would move the card to the other provider ends nothing and spends
       nothing. */
    if ((p.provider ?? null) !== (live?.id ?? null)) return;
    for (const line of switchLines(p)) await card.say(line, turnOf(line, []));
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<span class="wrap">
  <button
    type="button"
    class="model"
    aria-haspopup="menu"
    aria-expanded={open}
    {@attach tipOf(() => (card ? "the model and how hard it thinks — sends /model and /effort (alt+M)" : "what this conversation opens as (alt+M)"))}
    onclick={() => (open = !open)}
  >
    <span class="full">{chip}</span><span class="short">{short}</span><Icon
      name="chev-d"
      small
    />
  </button>
  {#if open}
    <PickMenu {rows} {up} label="model and effort" onpick={(id) => void pick(id)} onclose={() => (open = false)} />
  {/if}
</span>

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
