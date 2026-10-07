<script lang="ts">
  /* What was asked while you were out.
   *
   * The other half of away mode. `ask_user` stops parking when you go away and
   * queues instead (`presence.rs`), so the questions that would each have
   * expired alone at a quarter to eight are all still here in the morning. This
   * is where you answer them.
   *
   * Three judgements worth knowing:
   *
   * **Grouped by card, not listed by time.** The unit of attention here is a
   * card: three questions from one agent about one piece of work are one
   * context to load, and interleaving them with another card's is the same
   * mistake `asking.ts` describes an agent making when it fuses two decisions
   * into one question. `pileOf` does the grouping and is tested.
   *
   * **It reuses the ask panel rather than drawing its own.** A deferred
   * question is the same payload a live one is — same stepper, same previews,
   * same gallery, same free-text field — and a second implementation of all of
   * that would be a second place for a design to arrive unrenderable. What
   * differs is one prop: `parked` is false, so the head counts how long it has
   * waited instead of counting down to a deadline that does not exist.
   *
   * **Answering sends a turn, and that wakes the card.** There is nothing
   * parked to resume: the tool call returned hours ago. So the answer goes in
   * as a prompt (`answerEnvelope`), `Skein.send` rouses a dormant card to take
   * it, and the agent picks up the thing it had held back. That is deliberate
   * and it is the one expensive gesture in this panel — a process and an API
   * turn per card — which is why the pile says how many cards it is about to
   * wake before you start. */

  import Ask from "./Ask.svelte";
  import Notice from "./Notice.svelte";
  import type { Conversation } from "./conversation.svelte";
  import { clock } from "./conversation.svelte";
  import { nameBesideProject } from "./naming";
  import FileScope from "./FileScope.svelte";
  import type { Presence } from "./presence.svelte";
  import { actVerb, answerEnvelope, lasted, stood, type Act, type Deferred } from "./presence";
  import type { Skein } from "./skein.svelte";
  import { isComplete } from "./asking";

  let {
    presence,
    skein,
    onclose,
    onselect,
  }: {
    presence: Presence;
    skein: Skein;
    onclose: () => void;
    /** Put the asking card in the ring, so its transcript is behind the panel
     *  while you decide. The one gesture here that is about context rather than
     *  about answering. */
    onselect?: (conv: Conversation) => void;
  } = $props();

  /** The card whose questions are in hand. Null until the pile resolves, then
   *  the oldest — which is the order it accumulated in. */
  let on = $state<string | null>(null);

  const pile = $derived(presence.pile);
  const here = $derived(pile.find((g) => g.conversationId === on) ?? pile[0]);

  /* Follows the pile rather than being set by it: answering a card's last
     question takes that group out of `pile`, and a held id would then point at
     nothing with another group right there. */
  $effect(() => {
    if (pile.length && !pile.some((g) => g.conversationId === on)) {
      on = pile[0]?.conversationId ?? null;
    }
  });

  /* And shut once nothing is left, whichever way the last of it went — a
     question answered, a notice acknowledged here or in the dock, a card that
     stirred and took its notice down. */
  $effect(() => {
    if (presence.waiting === 0) onclose();
  });

  function convOf(id: string): Conversation | undefined {
    return skein.convs.find((c) => c.id === id);
  }

  /** Who asked, said the way the rest of the wall says it. A card that has been
   *  deleted since is named by its handle, which is the only thing left — the
   *  same degradation `relayFrom` makes for a closed sender. */
  function whoOf(id: string): { project: string; title: string } {
    const c = convOf(id);
    return c
      ? { project: c.project, title: c.title }
      : { project: "", title: `a card that has gone (${id.slice(0, 8)})` };
  }

  /** How long the whole pile has been standing, counted from the oldest
   *  question rather than from when away mode started — they are usually the
   *  same evening, and when they are not it is the question that waited. */
  const oldest = $derived(pile[0]?.since ?? clock.t);

  let sending = $state<string | null>(null);
  let fault = $state<string | null>(null);

  /** Hand one answered sheet to the card that asked for it.
   *
   *  Claimed before it is sent — `later::serve_due`'s ordering and its
   *  reasoning. An interruption between the two loses an answer, where the
   *  other way round hands a card the same decision twice, and a card prompted
   *  twice with the same decision is the worse failure. */
  async function deliver(d: Deferred) {
    if (sending) return;
    fault = null;
    const conv = convOf(d.conversationId);
    if (!conv) {
      /* Nothing to hand it to. Taking it off the pile is the only honest move
         left — the question stood for a card that is no longer on the wall. */
      await presence.claim(d.id);
      return;
    }
    sending = d.id;
    try {
      if (!(await presence.claim(d.id))) return;
      await skein.send(conv, answerEnvelope(d.questions, d.answers, clock.t - d.askedAt));
    } catch (err) {
      fault = String(err);
    } finally {
      sending = null;
    }
    if (!presence.waiting) onclose();
  }

  /** What came of an act, once decided. Keyed by the act's id and kept after
   *  the row goes, because the sentence is the whole point: an approval here is
   *  "ask again now and do it if the answer is still yes", so *what actually
   *  happened* is news — and quite often it is "nothing, the wall has moved
   *  on". A panel that removed the row and said nothing would leave you
   *  believing a card was closed that is still open. */
  let became = $state<Record<string, string>>({});
  let deciding = $state<string | null>(null);

  async function decide(a: Act, yes: boolean) {
    if (deciding) return;
    deciding = a.id;
    const said = await presence.decide(a.id, yes ? "yes, do it" : "no, leave it");
    became = { ...became, [a.id]: said };
    deciding = null;
  }

  /** Leave one unanswered and gone. The agent was told nothing is decided, so
   *  dropping a question is the user saying it is not worth one — which is a
   *  real answer and is why it is offered rather than only achievable by
   *  closing the panel and letting it sit for ever. */
  async function drop(d: Deferred) {
    await presence.claim(d.id);
    if (!presence.waiting) onclose();
  }

  /** How many cards this pile will wake. Said before you start, because that
   *  is the cost of the gesture and it is the one thing here that is not free. */
  const dormant = $derived(
    pile.filter((g) => convOf(g.conversationId)?.dormant ?? false).length,
  );
</script>

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag inside the panel does not dismiss it. The same shell
     every other panel here uses. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="vigil"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="questions asked while you were away"
    tabindex="-1"
  >
    <header>
      <h2>while you were away</h2>
      <span class="count">
        {presence.waiting} waiting from {pile.length}
        {pile.length === 1 ? "card" : "cards"} · {lasted(clock.t - oldest)}
      </span>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    {#if dormant > 0}
      <!-- The cost, said once and up front. Answering wakes a card, which is a
           process and an API turn apiece — cheap for one, worth knowing for
           nine. -->
      <p class="note">
        {dormant}
        {dormant === 1 ? "of these cards is" : "of these cards are"} asleep; answering wakes
        {dormant === 1 ? "it" : "them"}.
      </p>
    {/if}

    {#if fault}
      <p class="note fault">{fault}</p>
    {/if}

    <div class="body">
      <!-- The rail is the pile: who asked, how much, how long ago. It is a map
           rather than a tab bar, the same thing `Ask`'s spine is one level
           down — so a pile of nine is readable before any of it is answered. -->
      <nav class="rail">
        {#each pile as group (group.conversationId)}
          {@const who = whoOf(group.conversationId)}
          {@const n =
            group.asks.reduce((t, a) => t + a.questions.length, 0) +
            group.acts.length +
            group.notices.length}
          <button
            class="who"
            class:on={group.conversationId === here?.conversationId}
            onclick={() => (on = group.conversationId)}
          >
            <span class="name">{nameBesideProject(who.title) || who.project || "a card"}</span>
            <span class="where">{who.project}</span>
            <span class="when">{n} · {stood(clock.t - group.since)}</span>
          </button>
        {/each}
      </nav>

      <div class="asks">
        {#if here}
          {#each here.notices as n (n.id)}
            {@const who = whoOf(n.conversationId)}
            <!-- What the card did while you were out: it finished, ended on a
                 question, gave up, or told you something. The same panel the
                 dock draws, so a follow-up here is the same gesture as there. -->
            <div class="one">
              <FileScope
                root={(() => {
                  const c = convOf(n.conversationId);
                  return (c?.kind === "project" ? c.cwd : null) ?? null;
                })()}
              >
                <Notice
                  notice={n}
                  project={who.project}
                  title={who.title}
                  elsewhere={true}
                  onack={() => void skein.acknowledgeNotice(n)}
                  onfollow={(text) => void skein.followUpNotice(n, text)}
                  onstir={() => skein.stirNotice(n)}
                  onselect={() => {
                    const c = convOf(n.conversationId);
                    if (c) onselect?.(c);
                  }}
                />
              </FileScope>
            </div>
          {/each}
          {#each here.acts as a (a.id)}
            <!-- Drawn above the questions, and differently. An act is not a
                 question with buttons: approving it means Volery asks itself
                 the same question again *now* and acts only if the answer is
                 still yes, so the row says that rather than implying a
                 decision taken while you were out is simply carried out. -->
            <div class="act" class:sending={deciding === a.id}>
              <div class="actbar">
                <span class="verb">{actVerb(a.tool)}</span>
                <span class="when">{stood(clock.t - a.askedAt)}</span>
              </div>
              {#each a.questions as q (q.question)}
                <p class="asked">{q.question}</p>
              {/each}
              {#if became[a.id]}
                <p class="became">{became[a.id]}</p>
              {:else}
                <div class="foot">
                  <button class="go" onclick={() => void decide(a, true)}>do it</button>
                  <button class="drop" onclick={() => void decide(a, false)}>leave it</button>
                  <span class="grow"></span>
                  <span class="caveat">
                    checked again before anything happens — if the reason has gone, it
                    won't
                  </span>
                </div>
              {/if}
            </div>
          {/each}
          {#each here.asks as d (d.id)}
            {@const who = whoOf(d.conversationId)}
            <div class="one" class:sending={sending === d.id}>
              <!-- Each row is a different card's question, so the directory a
                   path in it counts from is that card's and not the pile's.
                   `scopeFiles` is per component; this list needs one per row.
                   See `FileScope.svelte`. -->
              <FileScope
                root={(() => {
                  const c = convOf(d.conversationId);
                  return (c?.kind === "project" ? c.cwd : null) ?? null;
                })()}
              >
              <Ask
                ask={{ askId: d.id, questions: d.questions, answers: d.answers, ours: false, since: d.askedAt }}
                project={who.project}
                title={who.title}
                scripts={convOf(d.conversationId)?.kind !== "chat"}
                parked={false}
                elsewhere={true}
                onanswer={() => void deliver(d)}
                onselect={() => {
                  const c = convOf(d.conversationId);
                  if (c) onselect?.(c);
                }}
              />
              </FileScope>
              <div class="foot">
                {#if isComplete(d.answers)}
                  <span class="ready">answered — send it to wake the card</span>
                {/if}
                <span class="grow"></span>
                <button class="drop" onclick={() => void drop(d)}
                  title="Take this question off the pile without answering it. The agent was told nothing was decided.">
                  not worth answering
                </button>
              </div>
            </div>
          {/each}
          {#if !here.asks.length && !here.acts.length && !here.notices.length}
            <p class="note">this card is settled.</p>
          {/if}
        {:else}
          <p class="note">nothing is waiting.</p>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    /* Spread over every screen the studio root is the containing block for
       anything fixed, so a bare `inset: 0` would cover all three and centre
       this between them. Sized to the window and padded back to the home
       screen — all four are zero when nothing is spread. See `span.ts`. */
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: var(--span-y, 0px) var(--span-r, 0px) var(--span-b, 0px) var(--span-x, 0px);
    z-index: 40;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .vigil {
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 0.9rem 1rem 1rem;
    width: min(56rem, 92cqw);
    max-height: 86cqh;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  h2 {
    font-family: var(--display);
    font-size: 1rem;
    font-weight: 400;
    margin: 0;
  }
  .count {
    font-family: var(--util);
    font-size: 0.64rem;
    letter-spacing: 0.08em;
    color: var(--faint);
    flex: 1 1 auto;
  }
  .x {
    border: 0;
    background: none;
    color: var(--faint);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--ink-on-surface, var(--ink));
  }

  .note {
    margin: 0;
    font-size: 0.74rem;
    color: var(--faint);
  }
  .note.fault {
    color: var(--st-fail);
  }

  .body {
    display: grid;
    grid-template-columns: 13rem 1fr;
    gap: 0.9rem;
    min-height: 0;
    flex: 1 1 auto;
  }

  .rail {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow-y: auto;
    min-height: 0;
    border-right: 1px solid var(--edge);
    padding-right: 0.6rem;
  }
  .who {
    display: grid;
    gap: 0.1rem;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 3px;
    background: none;
    color: inherit;
    cursor: pointer;
    padding: 0.35rem 0.4rem;
  }
  .who:hover {
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }
  .who.on {
    border-color: var(--edge);
    background: color-mix(in srgb, var(--ink) 9%, transparent);
  }
  .name {
    font-size: 0.78rem;
  }
  .where,
  .when {
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    color: var(--faint);
  }

  .asks {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    overflow-y: auto;
    min-height: 0;
  }
  .one {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .act {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border: 1px solid color-mix(in srgb, var(--edge) 80%, var(--ink));
    border-radius: 4px;
    background: color-mix(in srgb, var(--ink) 5%, transparent);
    padding: 0.55rem 0.65rem;
  }
  .act.sending {
    opacity: 0.55;
    pointer-events: none;
  }
  .actbar {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.12em;
  }
  .verb {
    color: var(--ink-on-surface, var(--ink));
  }
  .asked {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .became {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--faint);
  }
  .caveat {
    font-family: var(--util);
    font-size: 0.56rem;
    letter-spacing: 0.08em;
    color: var(--faint);
    text-align: right;
  }
  .go {
    border: 1px solid color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    border-radius: 3px;
    background: color-mix(in srgb, var(--st-ask) 10%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0.15rem 0.5rem;
  }
  .go:hover {
    border-color: var(--st-ask);
  }

  .one.sending {
    opacity: 0.55;
    pointer-events: none;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    color: var(--faint);
  }
  .grow {
    flex: 1 1 auto;
  }
  .ready {
    color: var(--st-ask);
  }
  .drop {
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: none;
    color: var(--faint);
    font: inherit;
    cursor: pointer;
    padding: 0.15rem 0.4rem;
  }
  .drop:hover {
    color: var(--ink-on-surface, var(--ink));
  }
</style>
