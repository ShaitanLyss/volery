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
  import Said from "./Said.svelte";
  import { replies } from "./replies.svelte";
  import { clock } from "./conversation.svelte";
  import { stood } from "./presence";
  import { nameBesideProject } from "./naming";
  import { isCloseKey, noticeWords, type Notice } from "./notice";

  let {
    notice,
    project,
    title,
    elsewhere = false,
    onack,
    onclosecard,
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
    /** Close the card this is about — the card's own close, so a card that is
     *  working asks first and the notice stays up behind that question. */
    onclosecard?: () => void;
    /** Send the reply. Answering whether it landed, where the caller knows —
     *  a reply that did not is kept rather than dropped (`replies.svelte.ts`). */
    onfollow: (text: string) => void | boolean | Promise<boolean | void>;
    onselect?: () => void;
    /** Typing into a notice that is holding a turn open — see `stirNotice`. */
    onstir?: () => void;
  } = $props();

  /* The reply lives in `replies`, keyed by the notice, and this field is only
     where it is being typed: it unmounts whenever the dock draws something
     else, and it used to take what you had written with it. So the field is
     bound straight to the store, with no copy of its own — a notice you come
     back to, in the dock or in the away pile, or after a reload, has your
     half-written reply still in it.

     **No copy, because the same notice can be drawn twice at once**: the away
     pile stands over the dock and both draw the notices queued while you were
     out. Two fields each holding their own copy would let the one you had not
     typed into write its stale text back over the one you had.

     A different notice is a different reply: what you were typing to one card
     must not be sent to the next one the queue brings up. Keyed on the id, a
     string, and not on the prop: every re-read of the queue hands this a new
     object for the same notice, and depending on that wiped a half-typed reply
     whenever anything anywhere on the wall raised or took one. */
  const key = $derived(`notice:${notice.id}`);
  const reply = $derived(replies.text(key));
  const name = $derived(nameBesideProject(title));
  /* What a kept reply says it was for. A far notice's `conversationId` is
     its shadow's id (`afar.ts::noticeHere`), which is what the ring takes. */
  const about = $derived({
    item: key,
    about: `the notice from ${project}${name ? ` · ${name}` : ""}`,
    card: notice.conversationId,
  });

  /** How long a follow-up may be on its way before the reply is shown back
   *  as not sent. A send to a dormant card spawns it first, which is seconds;
   *  a minute and a half is a send that is not coming back. If it lands after
   *  all, the reply goes then — this only stops a hung promise hiding it for
   *  good. */
  const PATIENCE_MS = 90_000;

  /* A follow-up is kept until it is known to have landed: `followUpNotice`
     takes the notice down before it sends, and a send that then finds the
     notice already gone, or another wall refuses, leaves the words for the
     dock to hand back. */
  function follow(text: string) {
    if (!text.trim()) return;
    const k = key;
    replies.closing(k);
    replies.sending(k);
    const failed = () => {
      replies.note(k, "your reply did not go through");
      replies.settled(k, false);
    };
    const r = onfollow(text);
    if (!(r instanceof Promise)) {
      if (r === false) failed();
      else replies.settled(k, true);
      return;
    }
    const late = setTimeout(failed, PATIENCE_MS);
    r.then(
      (ok) => {
        clearTimeout(late);
        if (ok === false) failed();
        else replies.settled(k, true);
      },
      () => {
        clearTimeout(late);
        failed();
      },
    );
  }

  /* Taking it down without a word is a word: what was typed goes with it. */
  function ack() {
    replies.closing(key);
    replies.forget(key);
    onack();
  }

  /* Closing the card is a gesture of yours that takes this notice away too —
     said before it goes so the dock does not read it as swapped from under you.
     The reply is not forgotten: it stays kept as "not sent" if the card goes. */
  function closeCard() {
    replies.closing(key);
    onclosecard?.();
  }

  const words = $derived(noticeWords(notice));
  const tone = $derived(
    notice.askId ? "blocking" : notice.kind === "question" ? "question" : notice.kind,
  );

  function send() {
    if (reply.trim()) follow(reply);
    else ack();
  }
</script>

<div class="notice {tone}" data-notice={notice.id}>
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

  <!-- The closing message, as the transcript would render it, in the reader
       every surface that shows a card's last message shares (`Said.svelte`). -->
  <Said text={notice.text} />

  <div class="row">
    <input
      bind:value={() => reply, (v) => replies.put(key, v, about)}
      placeholder={words.placeholder}
      onkeydown={(e) => {
        if (onclosecard && isCloseKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          closeCard();
          return;
        }
        onstir?.();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
      title="enter sends it; enter on an empty reply acknowledges"
    />
    <button class="btn" onclick={() => follow(reply)} disabled={!reply.trim()}
      >{words.send}</button
    >
    <button
      class="btn ack"
      onclick={ack}
      title="Take it down without a word (enter on an empty reply)">acknowledge</button
    >
    {#if onclosecard}
      <button
        class="btn ack"
        onclick={closeCard}
        title="Close the card this is about — asks first if it is working (ctrl+shift+W in the reply box)"
        >close</button
      >
    {/if}
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
