<script lang="ts">
  /* The one place in the app where an agent is genuinely stopped.
   *
   * A call can carry several decisions (see ./asking.ts for why), and they are
   * asked one at a time rather than laid out at once. Two reasons, and the
   * second is the load-bearing one:
   *
   *  - This panel lives in the dock, above the draft field, and grows upward
   *    into the wall. Three questions with four options each, all on screen, is
   *    a dock that has eaten the studio.
   *  - A decision read on its own is answered on its own. Shown together they
   *    get read together, which is the very habit that made the agent fuse them
   *    into a cross-product in the first place.
   *
   * The parking cannot be stepped through with them: one `tools/call` is one
   * HTTP request and gets one reply. So nothing is sent until the last question
   * is answered, and `composeAnswer` puts the sheet back together. */

  import type { Conversation } from "./conversation.svelte";
  import { clock } from "./conversation.svelte";
  import { nameBesideProject } from "./naming";
  import Markdown from "./Markdown.svelte";
  import Gallery from "./Gallery.svelte";
  import { parseMarkdown } from "./markdown";
  import {
    NO_PREFERENCE,
    answerWindow,
    answeredCount,
    isComplete,
    panelsOf,
    stepAt,
  } from "./asking";

  let {
    conv,
    elsewhere = false,
    onanswer,
    onselect,
    onlink,
  }: {
    conv: Conversation;
    /** Whether the card being asked is not the card in the ring — see the
     *  button in the head. */
    elsewhere?: boolean;
    onanswer: () => void;
    /** Put the asking card in the ring. Only reachable while `elsewhere`. */
    onselect?: () => void;
    /** A link in a question goes out the way one in the transcript does — this
     *  window is undecorated, with no address bar and no way back, so an
     *  `<a href>` would be a one-way trip out of the app. */
    onlink?: (href: string) => void;
  } = $props();

  let free = $state("");

  /* The separator goes with the name: a card nothing has named yet would
     otherwise read "skein · " with the dot left hanging. */
  const name = $derived(nameBesideProject(conv.title));

  const ask = $derived(conv.pendingAsk!);
  const questions = $derived(ask.questions);
  const many = $derived(questions.length > 1);

  /* Which question is on. Derived from the sheet rather than held, so going
     back to revise an earlier answer and then giving it cannot strand the
     cursor on something already answered (`stepAt`). Nudged by `at`, which is
     how "back" works without a second source of truth: it only ever *shows* an
     answered question, and the moment one is given the derived step wins. */
  let at = $state<number | null>(null);
  const step = $derived(
    Math.min(Math.max(at ?? stepAt(ask.answers), 0), questions.length - 1),
  );
  const current = $derived(questions[step]);
  const done = $derived(isComplete(ask.answers));

  /* The dock draws whichever card is blocked, so this component survives the
     card changing under it — `{#if skein.blocked.length}` stays true and only
     `conv` is swapped. A `back` left over from the last card's sheet would then
     point into a different set of questions, and `answers` is on the ask rather
     than in here for the same reason: switching away and back must not throw
     away what has already been answered. */
  $effect(() => {
    ask.askId;
    at = null;
  });

  /* The draft belongs to the question it was typed at, not to the panel — and
     revisiting an answered question shows what was said, so it can be
     corrected rather than retyped. */
  $effect(() => {
    const chosen = ask.answers[step];
    const preset = current?.options.some((o) => o.label === chosen);
    free = chosen && !preset ? chosen : "";
  });

  /* The agent gives up waiting and proceeds on its own judgement, so the
     countdown is real information, not decoration. It is the whole call's clock:
     several questions do not buy several deadlines — they buy one longer one.
     `answerWindow` is the same arithmetic `ask.rs` parks on, mirrored rather
     than sent, and the note there is why. */
  const window = $derived(answerWindow(questions));
  const left = $derived(
    Math.max(0, window - Math.floor((clock.t - ask.since) / 1000)),
  );
  const mins = $derived(Math.floor(left / 60));
  const secs = $derived(String(left % 60).padStart(2, "0"));

  /** The sheet, answered, with nothing sent yet.
   *
   *  The reason this state exists is the whole point of asking several
   *  questions at once: reading the third is often what changes your mind about
   *  the first. Sending on the last answer put that revision one gesture out of
   *  reach — you could go back freely right up until the moment it stopped
   *  being possible. So a call with several questions ends here instead, and
   *  the send is its own deliberate act.
   *
   *  `at` is what takes you out of it: editing an answer shows that question
   *  again, and giving it lands back here. */
  const reviewing = $derived(many && done && at === null);

  /** Record an answer and move on.
   *
   *  A single question sends on the click, exactly as it always did — there is
   *  nothing to step to and nothing to review, and making one decision cost two
   *  gestures would be a worse panel than the one this replaced. */
  function give(text: string) {
    const t = text.trim();
    if (!t) return;
    ask.answers[step] = t;
    free = "";
    at = null;
    if (!many && isComplete(ask.answers)) onanswer();
  }

  /** Leave one to the agent's judgement.
   *
   *  Offered rather than assumed. "You decide" is a real answer to a question
   *  about, say, whether a timer chimes — but it has to be *said*, or a panel
   *  that quietly sent blanks would look like one that lost them. */
  function skip() {
    give(NO_PREFERENCE);
  }

  /** Any question, at any time, answered or not.
   *
   *  There is no order to enforce. `composeAnswer` pairs each answer with its
   *  own question by index and always emits them in the order they were asked,
   *  so what the agent reads is the same whichever order you filled the sheet
   *  in — and the questions themselves are independent far more often than not,
   *  which is the entire reason they are asked in one call rather than three.
   *  An earlier cut of this walled off anything past the first unanswered
   *  question, on the belief that an out-of-order sheet composed a reply the
   *  agent would read against the wrong decisions. It does not; the belief was
   *  simply wrong, and the rule cost you the ability to look ahead at what you
   *  were being asked before deciding where to start. */
  function goTo(i: number) {
    if (i >= 0 && i < questions.length) at = i;
  }

  function move(delta: number) {
    goTo(step + delta);
  }

  /* Designs this question offers to show rather than describe. Almost always
     empty — an ask is a sentence and some buttons, and this is for the one that
     is a choice between layouts. */
  const panels = $derived(current ? panelsOf(current) : []);
  let showing = $state(false);

  /* The gallery is opened against one question, so it closes when the question
     under it changes — stepping on with a comparison of the previous decision
     still covering the wall would be showing you the wrong three things, and
     the close button would then look like it had failed. */
  $effect(() => {
    step;
    ask.askId;
    showing = false;
  });

  /** Choosing a design *is* answering, so it goes through `give` and takes the
   *  single-question send with it. Reading the designs is how the decision gets
   *  made; making you close the gallery and find the matching button in the
   *  dock afterwards would be asking you to answer it twice. */
  function chose(label: string) {
    showing = false;
    give(label);
  }
</script>

<div class="ask">
  <div class="head">
    <span class="mark">Waiting on you</span>
    <span class="who">{conv.project}{name ? ` · ${name}` : ""}</span>
    {#if elsewhere}
      <!-- The dock draws whichever card is blocked, and that need not be the
           card in the ring: so the question here and the transcript filling the
           panel beside it can be about two different conversations, with the
           name above the only thing saying so. This is the way to put them back
           together, next to the name it is about.

           Nothing takes it down — it goes because it stops being true. Landing
           on the card makes `askShown` return the focused one, `elsewhere` is
           then false, and the offer has answered itself. -->
      <button
        class="goto"
        onclick={() => onselect?.()}
        title="Select the card that asked, and open its transcript">select it</button
      >
    {/if}
    <span class="grow"></span>
    {#if many}
      <span class="of">{reviewing ? "all answered" : `${step + 1} of ${questions.length}`}</span>
    {/if}
    <span class="clockleft" class:urgent={left < 120}>{mins}:{secs}</span>
  </div>

  {#if many}
    <!-- The spine. It is a map, not a tab bar: it says how many decisions
         there are, which one you are on, and which are settled — the things a
         one-at-a-time panel would otherwise hide. -->
    <div class="spine">
      {#each questions as q, i}
        <button
          class="rung"
          class:on={i === step && !reviewing}
          class:settled={ask.answers[i] !== null}
          onclick={() => goTo(i)}
          title={ask.answers[i] ?? q.question}
        >
          <span class="tick"></span>
          <span class="name">{q.header}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if reviewing}
    <!-- Every pair on one screen, which is the only place they ever appear
         together. Answering happens one at a time so each decision is read on
         its own; checking it over is the opposite job, and wants them side by
         side. Each row is the way back into its question. -->
    <div class="review">
      {#each questions as q, i}
        <button class="pair" onclick={() => goTo(i)} title="Change this answer">
          <span class="pq">{q.header}</span>
          <span class="pa" class:none={ask.answers[i] === NO_PREFERENCE}
            >{ask.answers[i]}</span
          >
        </button>
      {/each}
    </div>

    <div class="free">
      <span class="foot grow">reads them together — nothing has been sent yet</span>
      <button class="send go" onclick={() => onanswer()}>send</button>
    </div>
  {:else}
    <!-- Keyed, so switching question replaces the block rather than mutating it:
         without it a long question followed by a short one leaves the panel
         animating its own height while you read. -->
    {#key step}
      <!-- `nav={false}`: the rails collect `data-nav` marks, and a question in
           the dock is not a place in the transcript to travel to. -->
      <div class="q">
        <Markdown blocks={parseMarkdown(current.question)} nav={false} {onlink} />
      </div>
    {/key}

    {#if panels.length}
      <!-- The CLI can only describe a layout; this one can be looked at. The
           gallery is its own surface rather than something that unfolds here —
           the dock grows upward into the wall and three mockups in it is the
           studio gone. See ./Gallery.svelte. -->
      <button class="look" onclick={() => (showing = true)}>
        {panels.length > 1
          ? `look at the ${panels.length} designs`
          : "look at the design"}
      </button>
    {/if}

    {#if current.options.length}
      <div class="options">
        {#each current.options as o}
          <button
            class="opt"
            class:chosen={ask.answers[step] === o.label}
            onclick={() => give(o.label)}
          >
            <span class="lbl">{o.label}</span>
            {#if o.detail}<span class="det">{o.detail}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <div class="free">
      <!-- Both directions, and forward does not require an answer: looking at
           what else is being asked is often how you decide where to start. -->
      {#if many}
        <button
          class="nav"
          onclick={() => move(-1)}
          disabled={step === 0}
          title="The question before this one">←</button
        >
        <button
          class="nav"
          onclick={() => move(1)}
          disabled={step === questions.length - 1}
          title="The question after this one">→</button
        >
      {/if}
      <input
        bind:value={free}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            give(free);
          }
        }}
        placeholder={current.options.length
          ? "…or say something else"
          : "Your answer"}
      />
      {#if many}
        <button
          class="nav skip"
          onclick={skip}
          title="Leave this one to the agent">skip</button
        >
      {/if}
      <button class="send" onclick={() => give(free)} disabled={!free.trim()}
        >↵</button
      >
    </div>

    {#if many}
      <div class="foot">
        {#if done}
          revising answer {step + 1} — giving it goes back to the review
        {:else}
          {answeredCount(ask.answers)} of {questions.length} answered — take them in
          any order, and change any of them before it is sent
        {/if}
      </div>
    {/if}
  {/if}

  {#if ask.dropped}
    <!-- Said out loud, because the agent asked and will act on the answer it
         did not get. Silence here reads as "all of it was asked". -->
    <div class="foot over">
      {ask.dropped} further question{ask.dropped === 1 ? "" : "s"} in this call {ask.dropped
        === 1
        ? "was"
        : "were"} not shown — the agent will use its own judgement there
    </div>
  {/if}
</div>

{#if showing && panels.length}
  <!-- A sibling of the panel rather than a child: it is `position: fixed` and
       covers the whole window, and nothing about it belongs inside a box that
       scrolls. `scripts` is decided by what kind of card asked and never by the
       payload — the same rule `spawn_conversation` follows when it reads
       `kind_of` rather than taking a capability as an argument. -->
  <Gallery
    {panels}
    header={current.header}
    scripts={conv.kind !== "chat"}
    onchoose={chose}
    onclose={() => (showing = false)}
  />
{/if}

<style>
  .ask {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    border-radius: 4px;
    background: color-mix(in srgb, var(--st-ask) 7%, var(--well));
    padding: 0.6rem 0.7rem;
    /* The one place in the app that genuinely blocks an agent, so it is also
       the one place that gets to glow. */
    box-shadow: 0 8px 30px -16px rgba(233, 161, 59, 0.7);
    /* Nothing in the dock may grow without limit. The panel sits above the
       draft field and grows upward into the wall, so an agent that writes at
       length would otherwise push the field it is to be answered in off the
       bottom of the window. Stepping through the questions is most of what
       keeps this from being reached; this is the floor under it. */
    max-height: min(52vh, 30rem);
    overflow-y: auto;
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
  /* Ask-coloured rather than achromatic: this is part of what the panel is
     saying, not chrome sitting on it. */
  .goto {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.64rem;
    background: none;
    border: 0;
    padding: 0;
    color: var(--st-ask);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .of {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .clockleft {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .clockleft.urgent {
    color: var(--st-ask);
  }

  .spine {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.5rem;
  }
  .rung {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: none;
    border: 0;
    padding: 0;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    cursor: pointer;
  }
  .rung.on .name {
    color: var(--paper);
  }
  .rung.settled .name {
    color: var(--paper-mute);
  }
  /* Drawn, not typed: a `✓` falls through to Segoe UI Emoji here and comes out
     blue, and colour on this wall is status. */
  .tick {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    border: 1px solid var(--rule);
    flex: 0 0 auto;
  }
  .rung.on .tick {
    border-color: var(--st-ask);
  }
  .rung.settled .tick {
    background: var(--st-ask);
    border-color: var(--st-ask);
  }
  .rung.settled.on .tick {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--st-ask) 25%, transparent);
  }

  .q {
    font-size: 0.95rem;
    line-height: 1.5;
    color: var(--paper);
    max-width: 76ch;
  }
  /* The agent writes markdown and this used to print it — backticks, hashes and
     all — while the transcript six inches away rendered the same prose properly.
     `Markdown.svelte` is renderable outside the panel (`--read` defaults to 1),
     so this costs an import. */
  .q :global(p) {
    margin: 0;
  }
  .q :global(p + p),
  .q :global(ul),
  .q :global(ol) {
    margin-top: 0.4em;
  }

  /* Its own row above the options, not one of them: it decides nothing and
     sending it as an answer is the one thing it must not look like. */
  .look {
    align-self: flex-start;
    background: none;
    border: 1px dashed color-mix(in srgb, var(--st-ask) 45%, var(--edge));
    border-radius: 3px;
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.72rem;
    padding: 0.22rem 0.6rem;
    cursor: pointer;
  }
  .look:hover {
    color: var(--paper);
    border-color: var(--st-ask);
    background: var(--raised);
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .opt {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.12rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    max-width: 34ch;
  }
  .opt:hover {
    border-color: color-mix(in srgb, var(--st-ask) 60%, var(--edge));
    background: var(--raised);
  }
  /* What you said last time you were here. Revisiting an answered question has
     to show its answer, or "back" is a way to lose one. */
  .opt.chosen {
    border-color: color-mix(in srgb, var(--st-ask) 70%, var(--edge));
    background: var(--raised);
  }
  .opt .lbl {
    font-family: var(--util);
    font-size: 0.78rem;
    color: var(--paper);
  }
  .opt .det {
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--paper-mute);
  }

  .free {
    display: flex;
    gap: 0.4rem;
  }
  .free input {
    flex: 1 1 auto;
    /* Without this a long placeholder or a long draft sets the flex item's
       min-content width and widens the dock — the same trap `.detail` fell
       into against a code fence. */
    min-width: 0;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.86rem;
    padding: 0.38rem 0.55rem;
  }
  .free input:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .free input::placeholder {
    color: var(--paper-faint);
  }
  .nav {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0 0.5rem;
    cursor: pointer;
  }
  .nav:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .nav:disabled {
    color: var(--edge);
    cursor: default;
  }
  .send {
    font-family: var(--mono);
    font-size: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0 0.6rem;
    cursor: pointer;
  }
  .send:disabled {
    color: var(--paper-faint);
    cursor: default;
  }

  .review {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .pair {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    text-align: left;
    width: 100%;
    background: none;
    border: 0;
    border-left: 2px solid var(--edge);
    border-radius: 0;
    padding: 0.16rem 0 0.16rem 0.5rem;
    cursor: pointer;
  }
  .pair:hover {
    border-left-color: var(--st-ask);
    background: var(--raised);
  }
  .pq {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    min-width: 8ch;
  }
  .pa {
    font-family: var(--util);
    font-size: 0.76rem;
    color: var(--paper);
    /* An answer typed rather than clicked can be a sentence. It wraps rather
       than truncating: this is the last look before it is sent, so the one
       thing the row must not do is hide what it is about to say. */
    overflow-wrap: anywhere;
  }
  /* Left to the agent is not an answer you gave, and must not read as one. */
  .pa.none {
    color: var(--paper-faint);
    font-style: italic;
  }
  .send.go {
    font-family: var(--util);
    font-size: 0.72rem;
    border-color: color-mix(in srgb, var(--st-ask) 55%, var(--edge));
  }
  .send.go:hover {
    background: var(--raised);
    border-color: var(--st-ask);
  }

  .foot {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
  .foot.grow {
    flex: 1 1 auto;
    align-self: center;
  }
  .foot.over {
    color: color-mix(in srgb, var(--st-ask) 55%, var(--paper-faint));
  }
</style>
