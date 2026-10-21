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

  import { getAllContexts, mount, unmount, untrack } from "svelte";
  import type { PendingAsk } from "./conversation.svelte";
  import { clock } from "./conversation.svelte";
  import { nameBesideProject } from "./naming";
  import { stood } from "./presence";
  import Markdown from "./Markdown.svelte";
  import Gallery from "./Gallery.svelte";
  import { parseMarkdown } from "./markdown";
  import { replies } from "./replies.svelte";
  import { refs } from "./refs.svelte";
  import { useFiles } from "./paths.svelte";
  import { glance } from "./glancing.svelte";
  import { replyKey } from "./replies";
  import PromptBox from "./PromptBox.svelte";
  import { attachmentsOf } from "./attach.svelte";
  import {
    NO_PREFERENCE,
    SKIPPED,
    answeredCount,
    isComplete,
    isUnsaid,
    askKey,
    lookLabel,
    panelsOf,
    stepAt,
    typedYes,
    typedYesWarning,
  } from "./asking";

  /* It takes the *ask* rather than the card that is asking, and the second
     surface is why. A question that piled up while the user was away is the
     same thing with no card blocked behind it — nothing is parked, and the
     conversation it came from may have gone dormant
     hours ago. Threading a `Conversation` through would have meant inventing
     one for the pile, so the four facts this panel actually read off the card
     are props instead: who asked, whether scripts may run in a preview, and
     the sheet itself. `Vigil.svelte` is the other caller. */
  let {
    ask,
    project,
    title,
    scripts = true,
    parked = true,
    elsewhere = false,
    onanswer,
    ondefer,
    onheld,
    onselect,
    card = "",
  }: {
    ask: PendingAsk;
    project: string;
    title: string;
    /** Whether a preview may run its `js`. Decided by what kind of card asked
     *  and never by the payload — the rule `spawn_conversation` follows when it
     *  reads `kind_of` rather than taking a capability as an argument. */
    scripts?: boolean;
    /** Whether an agent is actually stopped on this. False for a question out
     *  of the pile: the call returned hours ago, so nothing is held open and
     *  there is no call to keep a half-answered sheet against. */
    parked?: boolean;
    /** Whether the card being asked is not the card in the ring — see the
     *  button in the head. */
    elsewhere?: boolean;
    onanswer: () => void;
    /** Put the question off: it goes to the pile and the card is told nothing
     *  was decided (sink `7805fa20`). Absent where there is nowhere to put it
     *  — a question already out of the pile. */
    ondefer?: () => void | Promise<void>;
    /** An answer was recorded on a sheet not yet sent, so Rust should keep it
     *  in case the call closes first — the wall going away, or a machine nobody
     *  is touching (`Skein.holdAsk`, sink `fdc6954b`). Only the dock wires it:
     *  a question out of the pile is parked on nothing, so there is no call to
     *  close under it. */
    onheld?: () => void;
    /** Put the asking card in the ring. Only reachable while `elsewhere`. */
    onselect?: () => void;
    /** The card asked on — a conversation here, or a shadow of one elsewhere.
     *  Kept with what you type, so a reply whose question has gone can be put
     *  back into that card's prompt (`replies.ts`). */
    card?: string;
  } = $props();

  /* The directory this question's prose counts from, if any — what a commit
     hash named in an option is looked up in. Off the ambient scope, never a
     prop, so a surface that forgets to say does not get another card's. */
  const fileScope = useFiles();
  const filesRoot = $derived(fileScope()?.root ?? null);

  let free = $state("");

  /* What the asking card last said — usually the very thing the question is
     about — read in a glance over the wall, so it can be read without leaving
     the question for the transcript (`Glance.svelte`). Anchored on the whole
     panel, so it stands clear of the field you are answering in rather than
     growing the dock. Absent when there is nothing to read, or nowhere to
     open it: never a dead button. */
  let root = $state<HTMLElement | null>(null);
  const readable = $derived(glance.can(card));
  function read(keyed: boolean) {
    if (readable) glance.open(card, root, keyed);
  }

  /* A typed yes on one of Volery's own confirmations, which only the button
     answers. Set by `give`, cleared the moment the field changes or the
     question does — it is a note about the last thing typed, not a state. */
  let warned = $state<string | null>(null);

  /* A defer in flight. A second press (or alt+D again) finds the question
     already gone and would draw "no longer waiting" as a fault, for something
     that worked. */
  let deferring = $state(false);
  async function defer() {
    if (!ondefer || deferring) return;
    /* Yours, so the dock does not read the question leaving as something
       taken from under you — and what was typed but not given stays, said to
       be from a question you put off: the pile gives it a new id, so it is
       not waiting there. */
    replies.closing(item);
    replies.note(item, "you deferred it before this was given");
    deferring = true;
    try {
      await ondefer();
    } finally {
      deferring = false;
    }
  }

  /* The separator goes with the name: a card nothing has named yet would
     otherwise read "skein · " with the dot left hanging. */
  const name = $derived(nameBesideProject(title));

  /* The ask, as a string. Every effect below that is about *which* question
     this is keys on this rather than on `ask.askId`: a derived string only
     wakes its readers when it changes, where `ask` is a prop the dock may hand
     over again on traffic that has nothing to do with this question. Read
     directly, that reset the step and the gallery on an arrival
     anywhere on the wall. `test/queue.test.ts` holds the line. */
  const id = $derived(ask.askId);
  const item = $derived(`ask:${id}`);
  /* What a kept reply says it was for. */
  const about = $derived({
    item,
    about: `the question from ${project}${name ? ` · ${name}` : ""}`,
    card,
    ...(parked ? {} : { pile: true }),
  });

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

  /* The dock draws one question at a time, so this component survives the ask
     changing under it — when you step to another with "more", or answer one
     and the next comes forward — and only `ask` is swapped. A `back` left over
     from the last card's sheet would then
     point into a different set of questions, and `answers` is on the ask rather
     than in here for the same reason: switching away and back must not throw
     away what has already been answered. */
  $effect(() => {
    void id;
    at = null;
    warned = null;
  });

  /** Which option the keyboard has selected, or null. The options are a
   *  single-select listbox (§10.2 of `docs/chat-mode.md`): the number keys and
   *  ↑ ↓ move this, Enter gives it. A click gives at once, as it always did. */
  let selected = $state<number | null>(null);
  $effect(() => {
    void id;
    void step;
    selected = null;
  });

  /** Put the keyboard on the first option — what chat view does when you go to
   *  a question on purpose (its toast's *answer*, Alt+↓). Never on arrival:
   *  focus is not taken by anything arriving (§10.2). */
  export function focusFirst() {
    const first = root?.querySelector<HTMLElement>(".opt, .free textarea, .send.go");
    first?.focus();
    if (current?.options.length) selected = 0;
  }

  /** The panel's own keys, outside its answer field (`asking.ts::askKey`). */
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
    /* Enter on a focused button is the button's own click — giving the option
       it is, which is the same thing the selection would give. */
    if (e.key === "Enter" && t?.tagName === "BUTTON" && selected === null) return;
    const k = askKey(
      { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey },
      { options: reviewing ? 0 : (current?.options.length ?? 0), selected, many, reviewing },
    );
    if (!k) return;
    e.preventDefault();
    /* Stopped: a number typed here is an answer, not the start of a message
       in the box below, and an arrow is this panel's, not the reading's. */
    e.stopPropagation();
    if (k.act === "select") {
      selected = k.at;
      root?.querySelectorAll<HTMLElement>(".opt")[k.at]?.focus();
    } else if (k.act === "give") give(current.options[k.at].label);
    else if (k.act === "step") move(k.by);
    else if (k.act === "send") send();
  }

  /* The draft belongs to the question it was typed at, not to the panel — and
     revisiting an answered question shows what was said, so it can be
     corrected rather than retyped.

     Keyed on the *value* answered at this step (a derived, which only wakes
     its readers when the value differs) and never on the sheet's arrays as
     such. A question pulled from another wall is redrawn whole when its
     designs and files land (`Elsewhere.#look`), which replaces `questions` and
     `answers` with equal content; read directly, that re-ran this and cleared
     whatever was half-typed — ask.md's "losing what I was typing", arriving by
     a road only a remote question has. Found in review. */
  const chosen = $derived(ask.answers[step]);
  /* And what is typed but not yet given is kept outside the panel altogether,
     in `replies`, under the ask and the step. The dock draws whichever item is
     in front of you and this field goes when it does — so a reply held only
     here went with any re-render, reload or bug that unmounted it. Read back
     whenever the question under the field changes; written on every
     keystroke; let go when it is given. */
  const draftKey = $derived(replyKey(item, step));
  $effect(() => {
    const said = chosen;
    const k = draftKey;
    const preset = untrack(() => current?.options.some((o) => o.label === said));
    free = untrack(() => replies.text(k)) || (said && !preset ? said : "");
  });

  /** The sheet goes: every step's unsent text goes with it. */
  function send() {
    replies.closing(item);
    replies.forget(item);
    onanswer();
  }

  /* How long it has stood, where a countdown used to be. A question has no
     deadline (2026-10-16): the countdown said whether to hurry, and the answer
     to that is now always no — *"they're uselessly stressful"*. What is worth
     knowing instead is when it was asked, which is also what makes a pile of
     them readable in any order. Minute-grained on purpose, so it is a fact to
     glance at rather than a number to watch. */
  const waited = $derived(stood(clock.t - ask.since));

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
    /* Nothing is recorded and nothing is sent: the question stays up and the
       field keeps what was typed, so the warning is about something still
       there to be corrected. See `typedYes`. */
    if (ask.ours && typedYes(t, current.options.map((o) => o.label))) {
      warned = typedYesWarning(t, current.options[0]?.label);
      return;
    }
    warned = null;
    replies.put(draftKey, "", about);
    ask.answers[step] = t;
    free = "";
    at = null;
    if (!many && isComplete(ask.answers)) send();
    else if (parked) onheld?.();
  }

  /** Not this one, not now.
   *
   *  Offered rather than assumed. A panel that quietly sent blanks would look
   *  like one that lost them, so a question you pass over still sends
   *  something — but what it sends is a *withholding*, and the agent is told in
   *  so many words that it is not permission. See `SKIPPED`: this button sent
   *  `NO_PREFERENCE` until sink `662b2900`, and an agent that read a skip as
   *  delegation pushed to two repositories on the strength of it. */
  function skip() {
    give(SKIPPED);
  }

  /** Hand this one over on purpose.
   *
   *  The other half of that split, and the reason it is a button rather than a
   *  shade of `skip`. "You decide" is a real and useful answer to a question
   *  about, say, whether a timer chimes — it just has to be something you
   *  *said*, since it is the one answer that authorises the agent to act
   *  without you. */
  function decide() {
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

  /* What this question offers to show rather than describe: designs composed
     here, files that already exist, or both. Almost always empty — an ask is a
     sentence and some buttons, and this is for the one that is a choice between
     layouts, or about a screenshot. */
  const panels = $derived(current ? panelsOf(current) : []);
  let showing = $state(false);

  /* The gallery is opened against one question, so it closes when the question
     under it changes — stepping on with a comparison of the previous decision
     still covering the wall would be showing you the wrong three things, and
     the close button would then look like it had failed. */
  $effect(() => {
    step;
    void id;
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

  /* The gallery covers the window, so it is mounted into the studio root
     rather than drawn here — `looking.svelte.ts`'s arrangement for the
     lightbox, and for the same reason. A question is drawn inside boxes that
     own a `position: fixed` child: chat view draws it in the thread, whose
     arrival animates `transform` (a filling transform animation makes an
     element the containing block for every fixed descendant) and whose
     scroller is masked (a mask clips whatever is painted inside it, fixed or
     not). So in chat view the gallery was a column-wide box scrolling with the
     thread, its top under the title bar (Lyss, 2026-10-20). Mounted at the
     root nothing above it can do that, and the contexts this question was
     drawn under — the file scope, the link opener — go with it.

     `scripts` is decided by what kind of card asked and never by the payload —
     the same rule `spawn_conversation` follows when it reads `kind_of` rather
     than taking a capability as an argument. */
  const contexts = getAllContexts();
  const galleryUp = $derived(showing && panels.length > 0);
  $effect(() => {
    if (!galleryUp) return;
    const target = document.querySelector(".studio") ?? document.body;
    const app = untrack(() =>
      mount(Gallery, {
        target,
        context: contexts,
        props: {
          get panels() {
            return panels;
          },
          get header() {
            return current.header;
          },
          get options() {
            return current.options;
          },
          get scripts() {
            return scripts;
          },
          onchoose: chose,
          onclose: () => (showing = false),
        },
      }),
    );
    return () => void unmount(app);
  });
</script>

<!-- A group with keys of its own: the listbox's, and Alt+D/Alt+R from
     anywhere in it, including the field. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="ask"
  bind:this={root}
  data-ask={ask.askId}
  role="group"
  aria-label={current?.question ?? "a question"}
  tabindex="-1"
  onkeydown={(e) => {
    onKey(e);
    /* The keyboard path for `defer`, from anywhere in the panel including the
       field: alt+D, which nothing else on the wall binds. */
    if (ondefer && e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      void defer();
    }
    /* And alt+R for the glance, from the field too, beside it. */
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "r" && readable) {
      e.preventDefault();
      read(true);
    }
  }}
>
  <div class="head">
    <span class="mark">{parked ? "Waiting on you" : "Asked while you were away"}</span>
    <span class="who">{project}{name ? ` · ${name}` : ""}</span>
    {#if elsewhere}
      <!-- The dock draws whichever card is blocked, and that need not be the
           card in the ring: so the question here and the transcript filling the
           panel beside it can be about two different conversations, with the
           name above the only thing saying so. This is the way to put them back
           together, next to the name it is about.

           Nothing takes it down — it goes because it stops being true. Landing
           on the card puts it in the ring with this question still held
           (`queue.ts::settleHold`), `elsewhere` is then false, and the offer
           has answered itself. -->
      <button
        class="goto"
        onclick={() => onselect?.()}
        title="Select the card that asked, and open its transcript">select it</button
      >
    {/if}
    {#if readable}
      <button
        class="glimpse"
        data-glance
        onclick={() => read(false)}
        title="Read what it last said, without leaving the question (alt+R, or space then d r)"
        >what it said</button
      >
    {/if}
    <span class="grow"></span>
    {#if many}
      <span class="of">{reviewing ? "all answered" : `${step + 1} of ${questions.length}`}</span>
    {/if}
    <span
      class="asked"
      title={parked
        ? "When this was asked. It waits until you answer or defer it — there is no deadline"
        : "This was asked while you were away"}>{waited}</span
    >
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
          <!-- Greyed for either stand-in, since neither is a thing the user
               said — and the review sheet's job is to show at a glance which
               decisions actually got made. -->
          <span class="pa" class:none={isUnsaid(ask.answers[i])}
            >{ask.answers[i] === SKIPPED ? "skipped" : ask.answers[i]}</span
          >
        </button>
      {/each}
    </div>

    <div class="free">
      <span class="foot grow">reads them together — nothing has been sent yet</span>
      <button class="send go" onclick={send}>send</button>
    </div>
  {:else}
    <!-- Keyed, so switching question replaces the block rather than mutating it:
         without it a long question followed by a short one leaves the panel
         animating its own height while you read. -->
    {#key step}
      <!-- `nav={false}`: the rails collect `data-nav` marks, and a question in
           the dock is not a place in the transcript to travel to. -->
      <div class="q">
        <Markdown blocks={parseMarkdown(current.question)} nav={false} />
      </div>
    {/key}

    {#if panels.length}
      <!-- The CLI can only describe a layout or a screenshot; this one can show
           either. The gallery is its own surface rather than something that
           unfolds here — the dock grows upward into the wall and three mockups
           in it is the studio gone. The options go with them, because a
           question whose panels choose nothing still has to be answerable from
           in front of the thing it is about. See ./Gallery.svelte. -->
      <button class="look" onclick={() => (showing = true)}>
        {lookLabel(panels)}
      </button>
    {/if}

    {#if current.options.length}
      <div class="options" role="listbox" aria-label="options — 1 to {Math.min(9, current.options.length)}, enter gives">
        {#each current.options as o, i}
          <button
            class="opt"
            role="option"
            aria-selected={selected === i}
            class:chosen={ask.answers[step] === o.label}
            class:lit={selected === i}
            onclick={() => give(o.label)}
            title={i < 9 ? `${i + 1} selects it, enter gives it` : undefined}
          >
            <span class="lbl">{#if i < 9}<span class="num" aria-hidden="true">{i + 1}</span>{/if}{refs.say(o.label, filesRoot)}</span>
            {#if o.detail}<span class="det">{refs.say(o.detail, filesRoot)}</span>{/if}
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
      <!-- A `PromptBox`, as every input that speaks to an agent is: a picture
           pasted or a file dropped here goes into the answer as it would into
           a prompt (sink fd7ef025). Its attachments are kept by the same key
           as its words, and named across the whole sheet, since the sheet
           goes back as one reply. -->
      <PromptBox
        bind:text={free}
        shots={attachmentsOf(draftKey, item)}
        rows={1}
        oninput={() => {
          warned = null;
          replies.put(draftKey, free, about);
        }}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            give(free);
          }
        }}
        placeholder={current.options.length
          ? "…or say something else"
          : "Your answer"}
      />
      {#if many}
        <!-- Two gestures where there was one, because they were two answers
             wearing one sentence. See `SKIPPED` and `NO_PREFERENCE`. -->
        <button
          class="nav skip"
          onclick={skip}
          title="Pass over this one — the agent is told it is not an answer and not permission"
          >skip</button
        >
        <button
          class="nav yours"
          onclick={decide}
          title="Hand this decision to the agent — a real answer, said on purpose"
          >you decide</button
        >
      {/if}
      {#if ondefer}
        <button
          class="nav"
          onclick={() => void defer()}
          disabled={deferring}
          title="Answer this later — it goes to the pile of queued questions and the agent is told nothing was decided (alt+D · read the pile with space then p)"
          >defer</button
        >
      {/if}
      <button class="send" onclick={() => give(free)} disabled={!free.trim()}
        >↵</button
      >
    </div>

    {#if warned}
      <div class="warn" role="status">{warned}</div>
    {/if}

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

</div>


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
    box-shadow: 0 8px 30px -16px color-mix(in srgb, var(--st-ask) 70%, transparent);
    /* Nothing in the dock may grow without limit. The panel sits above the
       draft field and grows upward into the wall, so an agent that writes at
       length would otherwise push the field it is to be answered in off the
       bottom of the window. Stepping through the questions is most of what
       keeps this from being reached; this is the floor under it. */
    /* `--ask-ceiling`: the dock leaves it at this, and chat view's thread sets
       it to `none`, since a cap of half the window is wrong inside a column
       that scrolls (`docs/chat-mode.md` §7.4). A property, not a prop. */
    max-height: var(--ask-ceiling, min(52cqh, 30rem));
    overflow-y: auto;
  }
  .ask:focus {
    outline: none;
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
  /* Achromatic, unlike `.goto`: it is chrome offering a reading, not part of
     what the question is saying. */
  .glimpse {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.64rem;
    background: none;
    border: 0;
    padding: 0;
    color: var(--paper-mute);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 3px;
  }
  .glimpse:hover,
  .glimpse:focus-visible {
    color: var(--paper);
  }
  .of {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .asked {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
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
  /* A narrow window stacks the options (§6.8): one a row, the whole width,
     rather than a ragged wrap. */
  @media (max-width: 599px) {
    .options {
      flex-direction: column;
    }
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
  /* Selected from the keyboard: brighter rather than coloured, as the find's
     current match is — the amber is the panel's, not one option's. */
  .opt.lit {
    border-color: var(--paper-mute);
    background: var(--raised);
  }
  .opt .num {
    display: inline-block;
    min-width: 1.1em;
    margin-right: 0.35rem;
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
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
  /* The answer box is a `PromptBox`; this sets how it looks here, through the
     properties it reads, rather than reaching into it. */
  .free > :global(.box) {
    flex: 1 1 auto;
    /* Without this a long placeholder or a long draft sets the flex item's
       min-content width and widens the dock — the same trap `.detail` fell
       into against a code fence. */
    min-width: 0;
    --pb-bg: var(--ink);
    --pb-pad: 0.38rem 0.55rem;
    --pb-size: 0.86rem;
    --pb-max: 6rem;
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
  /* The two stand-ins read as one pair, set apart from the arrows beside them:
     an arrow moves you, these two answer. `you decide` is the longer label on
     purpose — it is the one that authorises the agent to act without you, and
     a two-character button for that would be a gesture made by accident. */
  .nav.skip,
  .nav.yours {
    white-space: nowrap;
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

  .warn {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--st-ask);
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
</style>
