<script lang="ts">
  /* Another conversation wants you: a toast at the sheet's top right
     (`docs/chat-mode.md` §5.3, question.html).

     Over the one queue (`front.svelte.ts`), so a toast and the sidebar's *needs
     you* cannot disagree about what is waiting. Three rules, each the spec's:

     - **Nothing takes the keyboard.** A toast arriving moves no focus; its key
       is Alt+↓, and *answer* goes to the question and puts the keyboard on its
       first option because you pressed it.
     - **Only while the window is in front**, and only for what *arrives* while
       chat view is up: switching to chat view does not replay everything
       already waiting as a fanfare — the sidebar is where that is. Behind
       another window the attention ladder (flash, peek, chime) does its part.
     - **A question stays until it is answered or put off; a finished
       conversation's toast leaves after eight seconds**, paused while the
       pointer is on it — it is still in *finished*. At most two stand; the
       rest fold into "and N more" on the second. */
  import { fly, fade } from "svelte/transition";
  import { untrack } from "svelte";
  import type { Front, Item } from "./front.svelte";
  import { cardName } from "./naming";

  let {
    front,
    selected,
    focused = true,
    onanswer,
  }: {
    front: Front;
    /** The conversation in front of you — its own items are in its thread. */
    selected: string | null;
    /** The window is in front. */
    focused?: boolean;
    /** Go to the item's conversation and its question. */
    onanswer: (card: string) => void;
  } = $props();

  /** How long a finished conversation's toast stands. */
  const LINGER_MS = 8000;

  type Toast = { key: string; item: Item; at: number };
  let toasts = $state<Toast[]>([]);
  /** Every key seen since chat view opened — arrivals are what is not in it. */
  const seen = new Set<string>(untrack(() => front.items.map((t) => t.key)));
  let hovered = $state<string | null>(null);

  const lingers = (t: Item) => t.kind === "notice" && (t.notice.kind === "done" || t.notice.kind === "question");

  /* Arrivals become toasts; an item gone takes its toast with it. */
  $effect(() => {
    const items = front.items;
    const live = new Set(items.map((t) => t.key));
    untrack(() => {
      const next = toasts.filter((t) => live.has(t.key));
      for (const it of items) {
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        if (!focused || it.card === selected) continue;
        next.push({ key: it.key, item: it, at: Date.now() });
      }
      if (next.length !== toasts.length || next.some((t, i) => t !== toasts[i])) toasts = next;
    });
  });

  /* The conversation you go to takes its toasts with it: they are in the
     thread now. */
  $effect(() => {
    const s = selected;
    untrack(() => {
      if (toasts.some((t) => t.item.card === s)) toasts = toasts.filter((t) => t.item.card !== s);
    });
  });

  /* A finished conversation's toast leaves on its own — one timer per toast,
     only while one stands, and held while the pointer is on it. */
  $effect(() => {
    const timers = toasts
      .filter((t) => lingers(t.item) && t.key !== hovered)
      .map((t) =>
        setTimeout(
          () => (toasts = toasts.filter((x) => x.key !== t.key)),
          Math.max(0, t.at + LINGER_MS - Date.now()),
        ),
      );
    return () => timers.forEach(clearTimeout);
  });

  const shown = $derived(toasts.slice(0, 2));
  const more = $derived(Math.max(0, toasts.length - 2));

  function later(key: string) {
    toasts = toasts.filter((t) => t.key !== key);
  }

  function who(t: Item): string {
    return cardName(t.of.face.title, "").text || t.of.where;
  }
  function line(t: Item): string {
    if (t.kind === "ask") return t.ask.questions[0]?.question ?? "";
    return (t.notice.text.split("\n").find((l) => l.trim()) ?? "").replace(/[*_`#]/g, "").trim();
  }
  function heading(t: Item): string {
    if (t.kind === "ask") return `${who(t)} is asking`;
    if (t.notice.kind === "error") return `${who(t)} stopped`;
    if (t.notice.kind === "question") return `${who(t)} ended on a question`;
    if (t.notice.kind === "card") return `${who(t)} wants you`;
    return `${who(t)} finished`;
  }
  function tone(t: Item): "ask" | "fail" | "done" {
    if (t.kind === "notice" && t.notice.kind === "error") return "fail";
    if (t.kind === "notice" && t.notice.kind === "done") return "done";
    return "ask";
  }

  /** Movement only where the wall may move (`motion.md`). */
  function travel(base: number): number {
    const still =
      document.documentElement.dataset.motion === "still" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    return still ? 0 : base;
  }
</script>

<div class="toasts" aria-live="polite">
  {#each shown as t, i (t.key)}
    {@const it = t.item}
    <div
      class="toast {tone(it)}"
      role="status"
      onpointerenter={() => (hovered = t.key)}
      onpointerleave={() => (hovered = null)}
      in:fly={{ y: -10, duration: travel(360) }}
      out:fade={{ duration: travel(160) }}
    >
      <i class="st {tone(it)}" aria-hidden="true"></i>
      <span class="t">{heading(it)}</span>
      {#if line(it)}<span class="q">{line(it)}</span>{/if}
      <span class="act">
        <button type="button" class="btn" onclick={() => onanswer(it.card)} title="open it (alt+↓ goes to the next that needs you)"
          >{it.kind === "ask" ? "answer" : "open"}</button
        >
        <button type="button" class="btn ghost" onclick={() => later(t.key)} title="it stays in the sidebar">later</button>
        <span class="grow"></span>
        {#if i === 1 && more}<span class="more">and {more} more</span>{:else}<span class="key">alt ↓</span>{/if}
      </span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: absolute;
    top: 14px;
    right: 18px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 330px;
    pointer-events: none;
    font-family: var(--cv-ui, var(--util));
  }
  .toast {
    pointer-events: auto;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid color-mix(in oklab, var(--st-ask) 30%, var(--edge));
    /* Its status as light from one edge, the same as a needs-you row (§8.2),
       on an opaque ground: it stands over the thread. */
    background:
      linear-gradient(110deg, color-mix(in oklab, var(--st-ask) calc(14% * var(--ch-bloom, 1)), transparent), transparent 55%),
      var(--raised);
    box-shadow: 0 18px 40px -16px color-mix(in srgb, var(--shade) 95%, transparent);
    display: grid;
    grid-template-columns: 14px 1fr;
    column-gap: 10px;
  }
  .toast.fail {
    border-color: color-mix(in oklab, var(--st-fail) 30%, var(--edge));
    background:
      linear-gradient(110deg, color-mix(in oklab, var(--st-fail) calc(14% * var(--ch-bloom, 1)), transparent), transparent 55%),
      var(--raised);
  }
  .toast.done {
    border-color: var(--edge);
    background: var(--raised);
  }
  .st {
    width: 14px;
    height: 14px;
    display: grid;
    place-items: center;
  }
  .st::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-ask);
  }
  .st.fail::before {
    background: var(--st-fail);
  }
  .st.done::before {
    background: transparent;
    box-shadow: 0 0 0 1.5px var(--paper-mute) inset;
  }
  .t {
    font-size: 13px;
    color: var(--paper);
  }
  .q {
    grid-column: 2;
    font-family: var(--body);
    font-size: 13.5px;
    color: var(--paper-dim);
    margin: 3px 0 8px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .act {
    grid-column: 2;
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .grow {
    flex: 1;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 11px;
    border-radius: 8px;
    font: inherit;
    font-size: 12.5px;
    color: var(--paper);
    cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
  }
  .btn.ghost {
    background: transparent;
    color: var(--paper-dim);
    border-color: transparent;
  }
</style>
