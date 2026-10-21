<script lang="ts">
  /* A peek at what a chip names, beside it, while the pointer rests there.
   *
   * The chip already says what the thing is called; this says enough more to
   * decide whether to open it — its kind and state, the first lines of what it
   * says, who left it and when — without leaving the sentence you were reading.
   * Lyss, 2026-10-21: *"unless hover allows me to read it, and clicking
   * redirects me to the page, that works too"*. A click still opens the sheet
   * (`RefSheet.svelte`); this is the step before it.
   *
   * Reads the same stores the sheet and the pages read, never a copy. Takes no
   * pointer and no focus — it is a caption that happens to be large, and a peek
   * that could be hovered would be a second thing to leave before the first one
   * closes. Placed below the chip, or above it where the window's foot is
   * nearer than the peek is tall, and inside the window's sides; measured
   * before it is shown, for `ContextMenu`'s reason. */
  import { clock } from "./conversation.svelte";
  import { ago } from "./gates";
  import { refText, type Ref } from "./refs";
  import { stateOf } from "./sink";
  import type { Sink } from "./sink.svelte";
  import type { Board } from "./board.svelte";
  import { whois } from "./whois.svelte";

  let {
    reference,
    at,
    sink,
    board,
    look = "wall",
  }: {
    reference: Ref;
    /** The chip's box, in viewport coordinates. */
    at: { left: number; top: number; bottom: number };
    sink: Sink;
    board: Board;
    look?: "wall" | "chat";
  } = $props();

  $effect(() => {
    if (reference.kind === "sink") {
      sink.attach("refpeek");
      return () => sink.detach("refpeek");
    }
    if (reference.kind === "notice") {
      board.attach("refpeek");
      return () => board.detach("refpeek");
    }
  });

  const item = $derived(
    reference.kind === "sink" ? [...sink.items, ...sink.settled].find((i) => i.id.startsWith(reference.key)) : undefined,
  );
  const notice = $derived(
    reference.kind === "notice" ? board.notices.find((n) => n.id.startsWith(reference.key)) : undefined,
  );

  /** The opening of what it says, as plain lines: a peek is not the place to
   *  render markdown, and the sheet is one click away. */
  function opening(text: string): string {
    const lines = text
      .split("\n")
      .map((l) => l.replace(/^#+\s*|^[-*]\s+|\*\*|`/g, "").trim())
      .filter(Boolean);
    const out = lines.slice(0, 4).join(" ");
    return out.length > 280 ? `${out.slice(0, 279)}…` : out;
  }

  const kind = $derived(
    reference.kind === "sink" ? `sink · ${item?.kind ?? "item"}` : reference.kind === "notice" ? "billboard" : "commit",
  );
  const standing = $derived(
    reference.kind === "sink" && item
      ? stateOf(item)
      : reference.kind === "notice" && notice?.stale
        ? "stale"
        : "",
  );
  const body = $derived(
    reference.kind === "sink" ? opening(item?.body ?? "") : reference.kind === "notice" ? opening(notice?.body ?? "") : "",
  );
  const foot = $derived.by(() => {
    if (reference.kind === "sink" && item) return `${item.from ? whois.name(item.from) : "you"} · ${ago(clock.t - item.droppedAt)}`;
    if (reference.kind === "notice" && notice) {
      const by = notice.from ? whois.name(notice.from, notice.title) : "you";
      return `${by}${notice.host ? ` on ${notice.host}` : ""} · ${ago(clock.t - notice.postedAt)}`;
    }
    if (reference.kind === "commit") {
      const when = reference.at > 0 ? ago(clock.t - reference.at * 1000) : "";
      return [reference.author, when].filter(Boolean).join(" · ");
    }
    return "";
  });

  let el = $state<HTMLDivElement | null>(null);
  let size = $state({ w: 0, h: 0 });
  $effect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    size = { w: r.width, h: r.height };
  });
  const PAD = 8;
  const left = $derived(Math.max(PAD, Math.min(at.left, window.innerWidth - size.w - PAD)));
  const top = $derived(
    at.bottom + 6 + size.h + PAD > window.innerHeight ? Math.max(PAD, at.top - 6 - size.h) : at.bottom + 6,
  );
</script>

<div
  class="peek"
  class:chat={look === "chat"}
  class:placed={size.w > 0}
  bind:this={el}
  role="tooltip"
  style:left="calc({left}px - var(--span-x, 0px))"
  style:top="calc({top}px - var(--span-y, 0px))"
>
  <div class="kind">{kind}{#if standing}<span class="state"> · {standing}</span>{/if}</div>
  <div class="title">{refText(reference)}</div>
  {#if body}<p class="body">{body}</p>{/if}
  {#if foot}<div class="foot">{foot}</div>{/if}
  <div class="hint">click to open</div>
</div>

<style>
  .peek {
    position: fixed;
    z-index: 70;
    width: max-content;
    max-width: 22rem;
    padding: 0.55rem 0.7rem 0.5rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--surface);
    box-shadow: 0 18px 44px -22px color-mix(in srgb, var(--shade) 90%, transparent);
    pointer-events: none;
    font-family: var(--util);
    visibility: hidden;
  }
  .peek.placed {
    visibility: visible;
  }
  .peek.chat {
    max-width: 340px;
    padding: 10px 12px 9px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: color-mix(in oklab, var(--raised) 97%, transparent);
    box-shadow: 0 24px 50px -20px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
  }
  .kind {
    font-size: 0.6rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .peek.chat .kind {
    font-size: 10.5px;
    color: var(--cv-note, var(--paper-mute));
  }
  .title {
    margin-top: 0.2rem;
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.35;
    color: var(--paper);
  }
  .peek.chat .title {
    font-size: 13.5px;
    font-weight: 500;
  }
  .body {
    margin: 0.35rem 0 0;
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--paper-dim);
  }
  .peek.chat .body {
    font: 12.5px/1.5 var(--body);
    color: var(--cv-prose, var(--paper-dim));
  }
  .foot,
  .hint {
    margin-top: 0.4rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
  }
  .hint {
    margin-top: 0.15rem;
    color: var(--paper-faint);
  }
</style>
