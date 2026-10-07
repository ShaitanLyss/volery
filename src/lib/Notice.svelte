<script lang="ts">
  /* One notice: a card that finished, ended on a question, gave up on an error,
     or sent one itself. Drawn in the dock's queue behind the asks, and in the
     away pile, from the same component — `Ask.svelte`'s arrangement, for its
     reason: a second implementation is a second place for a design to drift.

     Quiet on purpose. A parked ask glows because an agent is stopped on it;
     a finished card is not, so this is tinted by the status the card itself
     wears — rest grey for finished, half-amber for a question, rust for an
     error — and has no glow. A card's own notice holding its turn open is the
     one that is genuinely blocking, and it borrows the ask's amber. */
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { clock } from "./conversation.svelte";
  import { stood } from "./presence";
  import { nameBesideProject } from "./naming";
  import { noticeWords, type Notice } from "./notice";

  let {
    notice,
    project,
    title,
    elsewhere = false,
    onack,
    onfollow,
    onselect,
    onstir,
  }: {
    notice: Notice;
    project: string;
    title: string;
    /** The card it is about is not the card in the ring — say which one. */
    elsewhere?: boolean;
    onack: () => void;
    onfollow: (text: string) => void;
    onselect?: () => void;
    /** Typing into a notice that is holding a turn open — see `stirNotice`. */
    onstir?: () => void;
  } = $props();

  let reply = $state("");
  /* A different notice is a different reply: what you were typing to one card
     must not be sent to the next one the queue brings up. Keyed on the id, a
     string, and not on the prop: every re-read of the queue hands this a new
     object for the same notice, and depending on that wiped a half-typed reply
     whenever anything anywhere on the wall raised or took one. */
  const id = $derived(notice.id);
  $effect.pre(() => {
    void id;
    reply = "";
  });

  const words = $derived(noticeWords(notice));
  const name = $derived(nameBesideProject(title));
  const tone = $derived(
    notice.askId ? "blocking" : notice.kind === "question" ? "question" : notice.kind,
  );

  function send() {
    if (reply.trim()) onfollow(reply);
    else onack();
  }
</script>

<div class="notice {tone}">
  <div class="head">
    <span class="mark">{words.mark}</span>
    <span class="who">{project}{name ? ` · ${name}` : ""}</span>
    {#if elsewhere && onselect}
      <button
        class="goto"
        onclick={() => onselect?.()}
        title="Select the card this is about, and open its transcript">select it</button
      >
    {/if}
    <span class="grow"></span>
    <span class="ago">{stood(clock.t - notice.raisedAt)}</span>
  </div>

  <!-- The closing message, as the transcript would render it. Its own scroller
       with a ceiling, so a long summary scrolls here rather than pushing the
       draft field off the bottom of the window. -->
  <div class="said">
    <Markdown blocks={parseMarkdown(notice.text)} nav={false} />
  </div>

  <div class="row">
    <input
      bind:value={reply}
      placeholder={words.placeholder}
      onkeydown={(e) => {
        onstir?.();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
      title="enter sends it; enter on an empty reply acknowledges"
    />
    <button class="btn" onclick={() => onfollow(reply)} disabled={!reply.trim()}
      >{words.send}</button
    >
    <button
      class="btn ack"
      onclick={() => onack()}
      title="Take it down without a word (enter on an empty reply)">acknowledge</button
    >
  </div>
</div>

<style>
  .notice {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--st-rest) 80%, var(--edge));
    border-radius: 4px;
    background: color-mix(in srgb, var(--paper) 3%, var(--well));
    padding: 0.6rem 0.7rem;
    /* Nothing in the dock may grow without limit — `Ask.svelte`'s bound, for
       its reason: the panel sits above the draft field and grows upward, so in
       a short window it would push the field it is answered in off the bottom.
       The text box is what gives way, not the reply row. */
    max-height: min(52cqh, 30rem);
    min-height: 0;
  }
  .notice.question {
    border-color: color-mix(in srgb, var(--st-soft) 60%, var(--edge));
    background: color-mix(in srgb, var(--st-soft) 6%, var(--well));
  }
  .notice.error {
    border-color: color-mix(in srgb, var(--st-fail) 55%, var(--edge));
    background: color-mix(in srgb, var(--st-fail) 5%, var(--well));
  }
  .notice.blocking {
    border-color: color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    background: color-mix(in srgb, var(--st-ask) 7%, var(--well));
  }

  .head,
  .row {
    flex: 0 0 auto;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.66rem;
  }
  .mark {
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .question .mark {
    color: var(--st-soft);
  }
  .error .mark {
    color: var(--st-fail);
  }
  .blocking .mark {
    color: var(--st-ask);
  }
  .who {
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40ch;
  }
  .grow {
    flex: 1 1 auto;
  }
  .goto {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.64rem;
    background: none;
    border: 0;
    padding: 0;
    color: var(--paper-mute);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .ago {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .said {
    max-height: 16rem;
    flex: 0 1 auto;
    min-height: 3.2rem;
    overflow-y: auto;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--well);
    padding: 0.45rem 0.6rem;
    font-size: 0.86rem;
    line-height: 1.55;
    color: var(--paper-dim);
  }
  .said :global(p) {
    margin: 0;
  }
  .said :global(p + p),
  .said :global(ul),
  .said :global(ol) {
    margin-top: 0.4em;
  }

  .row {
    display: flex;
    gap: 0.4rem;
  }
  .row input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.86rem;
    padding: 0.38rem 0.55rem;
  }
  .row input:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .row input::placeholder {
    color: var(--paper-faint);
  }
  .btn {
    font-family: var(--util);
    font-size: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
  .btn.ack {
    color: var(--paper-mute);
    background: none;
  }
  .btn.ack:hover,
  .btn:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
</style>
