<script lang="ts">
  import { waterfall } from "./waterfall.svelte";
  import type { Conversation } from "./conversation.svelte";
  import { cardName } from "./naming";

  import type { Lod } from "./studio.svelte";

  let {
    conv,
    focused = false,
    selected = false,
    pinned = false,
    lod = "wall",
    inbox = 0,
    draft = "",
    onfocus,
    onclose,
  }: {
    conv: Conversation;
    focused?: boolean;
    selected?: boolean;
    pinned?: boolean;
    lod?: Lod;
    /** Messages another card sent here while this one was dormant, waiting to
     *  be handed over when it wakes. See `.claude/rules/relay.md`. */
    inbox?: number;
    /** What is typed in the dock, if this card is one the dock is aimed at.
     *  Empty for every other card, and for a draft the palette has claimed. */
    draft?: string;
    onfocus: (e: MouseEvent) => void;
    onclose: () => void;
  } = $props();

  /** What this card is called, or what it is about to be called.
   *
   *  A card with no name used to print the sentinel — "untitled", the spelling
   *  the store defaults the column to. It is the one moment a card is asking to
   *  be given something to do, and it said less about itself than any other
   *  state on the wall. So a card you are typing at wears the prompt as you
   *  write it, cut exactly as sending it will cut it (`naming.ts` does both, or
   *  the card would rename itself the instant you pressed Enter), and one you
   *  are not says the plainest true thing there is to say about it.
   *
   *  Provisional either way, and drawn quieter for it: the wall stays legible
   *  at a glance as cards that have earned a name and cards that have not. */
  const name = $derived(cardName(conv.title, draft));

  /** As much of a line as one clipped line of a card can possibly draw.
   *
   *  `.say` clips to a single line with `-webkit-line-clamp`, which is around
   *  forty characters at this size — but the browser still has to hold and lay
   *  out whatever it was handed in order to find where to cut it. So a whole
   *  answer went into one text node and was thrown away, for every card at
   *  `open` density: hundreds of KB by the end of a long turn, rewritten on
   *  every `text_delta`.
   *
   *  This is the rule `Line.cap` already states from the other side of the
   *  panel — capped where it is written, since a cap that only bites at render
   *  time is not a memory bound. Here the writing is a card face redrawn per
   *  token, so the cap belongs at the read.
   *
   *  Taken off the *front*, which is both what the clamp draws and what makes
   *  this quiet: past the cap a growing answer slices to the same string every
   *  time, so the derived stops changing and the text node stops being written
   *  for the rest of the turn. A tail would be a fresh string on every delta —
   *  a ticker on every open card, which is the cost we came to remove. */
  const SAY_CAP = 200;
  const say = (text: string) => text.slice(0, SAY_CAP);

  /** At the open density a card shows what it has been saying, not just what
   *  it is doing — the latest line, which is enough to know whether to open the
   *  transcript. Deliberately one line: a card has to fit the slot it is placed
   *  in (see CARD_BOX in layout.ts), and reading at length is what the
   *  transcript panel is for. */
  const recent = $derived(
    conv.lines
      .filter((l) => l.kind === "text")
      .slice(-1)
      .map((l) => say(l.text)),
  );

  /** The turn's own words, while it is writing them. */
  const saying = $derived(say(conv.streaming));

  const CIRC = 2 * Math.PI * 11;

  /* The ring warms independently of status as it approaches full, so a card can
     be calmly at rest and still visibly close to the edge. */
  const ringColor = $derived(
    conv.dormant
      ? "var(--paper-faint)"
      : conv.ctx >= 0.85
        ? "var(--st-fail)"
        : conv.ctx >= 0.65
          ? "var(--st-ask)"
          : "var(--st-work)",
  );

  const label = $derived.by(() => {
    const s = conv.idleSeconds;
    /* No age beside it, and that is the point of the state rather than an
       omission: the suffix below counts how long you have left this card alone,
       which is exactly the reading `aside` says to stop taking. A card put by
       for a fortnight is not four hundred hours overdue. `working` still wins,
       since a card set aside mid-turn is genuinely still working. */
    if (conv.aside && !conv.working) return "set aside";
    /* `doing` rather than `activity`: it is the same word everywhere except
       during a compaction, which is the one wait long enough and quiet enough
       that the word alone reads as a card that has stopped. It counts itself,
       and the suffix below never collides with it — that one is how long you
       have left the card alone, and a compacting card is working. */
    if (conv.working || s < 2) return conv.doing;
    if (s < 60) return `${conv.doing} · ${s}s`;
    if (s < 3600) return `${conv.doing} · ${Math.floor(s / 60)}m`;
    return `${conv.doing} · ${Math.floor(s / 3600)}h`;
  });

  /* The close control is a sibling rather than a child: a button inside a
     button is invalid, and the card itself needs to be a real button so it is
     keyboard-reachable without hand-rolling the semantics. */

  /** Which subscription this card is spending, drawn beside the project name
   *  because it is the same kind of qualifier — that line already answers
   *  "where is this card from", and this is the other half of it.
   *
   *  Only where there is more than one account to be on. With none — or with
   *  one — every card carries the same word, and a word that never varies is
   *  one nobody reads after the first day, taking room on a line whose other
   *  two facts do change. `several` in `accounts.ts` holds the rule.
   *
   *  A bypassing card says so **for as long as it is**, rather than once when
   *  you asked for it. Skein spawns with `--dangerously-skip-permissions`, and
   *  the one thing an app like that owes you is that nothing it does on its own
   *  is invisible — a card quietly spending the reserve you set aside is
   *  exactly that, and the transcript note scrolls away. No colour: colour on
   *  this wall is status, and which account a card is on is not a status. */
  const acct = $derived(waterfall.several ? conv.accountLabel : null);
</script>

<div class="slot" class:focused class:selected data-lod={lod}>
  <button
    class="card"
    data-st={conv.tier}
    data-dormant={conv.dormant ? "" : undefined}
    data-aside={conv.aside ? "" : undefined}
    onclick={onfocus}
  >
    <span class="top">
    <span class="id">
      <span class="proj">
        <span class="pname">{conv.project}</span>
        {#if acct}
          <span
            class="acct"
            class:loose={conv.bypassCaps}
            title={conv.bypassCaps
              ? `spending the ${acct} account, ignoring the caps you set`
              : `spending the ${acct} account`}>{acct}{conv.bypassCaps ? " uncapped" : ""}</span
          >
        {/if}
      </span>
      <span class="title" class:provisional={name.provisional}>{name.text}</span>
    </span>
    <svg class="ring" viewBox="0 0 26 26" aria-hidden="true">
      <circle class="track" cx="13" cy="13" r="11" />
      <circle
        class="fill"
        cx="13"
        cy="13"
        r="11"
        style:stroke={ringColor}
        style:stroke-dasharray={CIRC}
        style:stroke-dashoffset={CIRC * (1 - conv.ctx)}
      />
    </svg>
    </span>

    <span class="act"><span class="dot"></span>{label}</span>

    {#if lod === "open"}
      <span class="said">
        {#if saying}
          <span class="say">{saying}</span>
        {:else if recent.length}
          {#each recent as r}<span class="say">{r}</span>{/each}
        {:else}
          <span class="say faint">nothing said yet</span>
        {/if}
      </span>
    {/if}
  </button>

  <!-- A fold in progress, across the wall: a line along the card's bottom edge.
       A sibling of `.card` and absolutely positioned, like `.pin` and `.aside`
       — the card sits on a fixed pitch and `CARD_BOX` records what each density
       draws at, so anything that took layout height here would push every row
       into the one below it. Skipped at `field`, which is the density that keeps
       the ring and drops everything else — the ring already says the card is
       working, and a second reading of the same turn is what the two densities
       above are for. Predicted rather than measured — see `compaction.ts`. -->
  {#if conv.compactFrac !== null && lod !== "field"}
    <span class="guess" aria-hidden="true">
      <span class="fill" style:width="{conv.compactFrac * 100}%"></span>
    </span>
  {/if}

  {#if pinned}
    <span class="pin" title="Pinned — this position is yours now"></span>
  {/if}

  <!-- The one thing that says so at `field`, where the card is its ring and the
       label is not drawn at all. It has to be visible there: at that
       density a card set aside and a card genuinely resting are both muted, and
       the difference between "quiet" and "put by" is the whole point. Opposite
       corner from `.pin`, and outside the box like it, so the two cannot meet
       and neither collides with the close control. -->
  {#if conv.aside}
    <span class="aside" title="Set aside — kept out of what's waiting"></span>
  {/if}

  <!-- Background work, which is the one state that outlives the turn that made
       it. It needs a mark of its own rather than the tier alone: celadon says
       "this card is busy" and the card is busy for two quite different reasons,
       one of which nothing will interrupt and the other of which you can talk
       to. Achromatic and at the foot, clear of `.pin` and `.aside`; drawn at
       every density, since at `field` the activity line is gone and this is a
       card that must not read as merely quiet. -->
  {#if conv.busy}
    <span
      class="jobs"
      title={conv.jobs.map((j) => j.label).join("\n")}
      >{conv.jobs.length > 1 ? conv.jobs.length : ""}</span
    >
  {/if}

  <!-- Post: what this card has been told and has not been given yet, because it
       was asleep when it was told. Top right, the one free corner — `.pin` has
       the top left, `.aside` and `.jobs` the foot.

       Celadon, and it is the same celadon the strand was drawn in: a message is
       work moving, and the mark is that work still in transit. It is the one
       thing on a *dormant* card that carries colour, which is exactly the
       reading wanted — the card is grey and at rest, and there is something
       here for it. Drawn at every density for `.jobs`'s reason: at `field`
       there is no activity line, and a card holding post must not read as
       merely quiet. -->
  {#if inbox > 0}
    <span
      class="post"
      title="{inbox} message{inbox > 1 ? 's' : ''} waiting — delivered when this card wakes"
      >{inbox > 1 ? inbox : ""}</span
    >
  {/if}

  <button class="shut" onclick={onclose} aria-label="Close conversation">
    <svg viewBox="0 0 10 10" aria-hidden="true"
      ><path d="M2 2l6 6M8 2L2 8" /></svg
    >
  </button>
</div>

<style>
  .slot {
    position: relative;
    flex: 0 0 auto;
  }

  .card {
    width: 208px;
    text-align: left;
    font: inherit;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.62rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.42rem;
    cursor: pointer;
    transition:
      box-shadow 0.5s ease,
      border-color 0.5s ease,
      background 0.5s ease;
  }
  .card:hover {
    border-color: var(--rule);
  }

  /* Selection is achromatic on purpose — colour is the status channel, and a
     blue "selected" ring would be the one thing on the wall that means nothing.
     Focus is a thin ring; gathered-for-broadcast is a solid one. */
  .slot.focused::after,
  .slot.selected::after {
    content: "";
    position: absolute;
    inset: -5px;
    border: 1px solid var(--paper-faint);
    border-radius: 7px;
    pointer-events: none;
  }
  .slot.selected::after {
    border-color: var(--paper-dim);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--paper-dim) 30%, transparent);
  }

  .top {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
  }
  .id {
    flex: 1 1 auto;
    min-width: 0;
    display: block;
  }
  .proj,
  .title {
    display: block;
  }
  /* Quieter than the project it sits beside and separated by space rather than
     by a glyph, so the line reads as one phrase at a glance and as two facts
     when you look. `loose` is the bypass, and it is weight rather than hue —
     colour on this wall is status. */
  /* The account keeps its width and the project name gives way, which is the
     opposite of the obvious arrangement and is the point. `.proj` truncates
     with an ellipsis, so with both in one truncating box a project called
     `asset_extraction` would eat the whole line and the account — the thing
     this label exists to show — would never be drawn at all. So the row is a
     flex, the name shrinks, and the account is `flex: none`. */
  .acct {
    flex: none;
    color: var(--paper-faint);
    opacity: 0.75;
    font-weight: 500;
    letter-spacing: 0.1em;
  }
  .pname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .loose {
    opacity: 1;
    font-weight: 700;
    color: var(--paper-mute);
  }

  .proj {
    /* Overrides the `display: block` it shares with `.title` above — see the
       note on `.acct` for why this row has to be a flex. */
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
  }
  .title {
    font-family: var(--display);
    font-size: 0.95rem;
    line-height: 1.22;
    color: var(--paper);
    letter-spacing: -0.004em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A name the card does not have yet: the draft you are typing at it, or the
     bare fact that it is new. The mark is the slope, not the colour — colour on
     this wall is status, and "you have not named this" is not a status. Which
     matters below, where a dormant card mutes every title it has: an unnamed
     card is always dormant, so italic is the only thing telling the two apart
     there, and it is enough. Sitka and Georgia both carry a true italic. */
  .title.provisional {
    font-style: italic;
    color: var(--paper-dim);
  }

  .ring {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.5;
  }
  .ring .track {
    stroke: var(--edge);
  }
  .ring .fill {
    stroke-linecap: round;
    transition:
      stroke-dashoffset 0.6s ease,
      stroke 0.6s ease;
  }

  .act {
    font-family: var(--util);
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--paper-dim);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 1.2em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st, var(--st-rest));
  }

  .shut {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    border-radius: 3px;
    cursor: pointer;
    color: var(--paper-faint);
    opacity: 0;
    transition:
      opacity 0.15s ease,
      color 0.15s ease,
      background 0.15s ease;
  }
  .shut svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .slot:hover .shut,
  .shut:focus-visible {
    opacity: 1;
  }

  /* Waiting post. Shaped like `.jobs` and coloured unlike it, which is the
     whole distinction: both are "something is pending", and only this one is
     something that came from outside the card. The halo is `--ink` for the
     reason every mark here has one — the backdrop draws behind everything, so
     anything standing on the wall is opaque. A count only past one, since a
     bare `1` beside a single message is a numeral that never varies. */
  .post {
    position: absolute;
    right: -4px;
    top: -4px;
    min-width: 9px;
    height: 9px;
    padding: 0 1px;
    border-radius: 5px;
    border: 1.5px solid var(--st-work);
    background: var(--ink);
    box-shadow: 0 0 0 2px var(--ink);
    color: var(--st-work);
    font-size: 7px;
    line-height: 6px;
    text-align: center;
    font-family: var(--util);
    pointer-events: none;
  }

  /* A pinned card carries a small mark — it earned its position. */
  .pin {
    position: absolute;
    top: -3px;
    left: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--paper-faint);
    box-shadow: 0 0 0 2.5px var(--ink);
    pointer-events: none;
  }

  /* Set aside: a bar laid flat, opposite the pin. Achromatic, because colour on
     this wall is status and "put by" is the absence of one — the card underneath
     keeps whatever tier it closed on, it simply stops warming. The `--ink` halo
     is `.pin`'s, and for the same second reason: the backdrop is drawn behind
     everything, so anything standing on the wall has to be opaque. */
  .aside {
    position: absolute;
    bottom: -2px;
    left: -4px;
    width: 11px;
    height: 3px;
    border-radius: 1.5px;
    background: var(--paper-faint);
    box-shadow: 0 0 0 2.5px var(--ink);
    pointer-events: none;
  }

  /* Background work: a ring, hollow, at the foot on the right — the opposite
     corner from `.aside` so a card that is both does not stack two marks on one
     spot. Hollow rather than filled because it is work *elsewhere*: the card is
     holding a place for something, not doing it. Achromatic for `.aside`'s
     reason — the tier already carries the status, and a second hue for "busy in
     another way" would be colour meaning two things. Opaque halo, or the
     backdrop drifts through it. It carries a count only past one, since a bare
     `1` beside a single job is a numeral that never varies. */
  .jobs {
    position: absolute;
    right: -4px;
    bottom: -4px;
    min-width: 9px;
    height: 9px;
    padding: 0 1px;
    border-radius: 5px;
    border: 1.5px solid var(--paper-faint);
    background: var(--ink);
    box-shadow: 0 0 0 2px var(--ink);
    color: var(--paper-faint);
    font-size: 7px;
    line-height: 6px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  /* ── semantic zoom ─────────────────────────────────────────

     Neither density touches the width, and `field` used to. It shrank the card
     to 58px so what was left — the ring — sat in a box its own size, which
     seemed the honest thing to draw and is the wrong reading: zooming out is
     meant to be the same wall from further off, and instead every column pulled
     in towards its left edge and every card changed shape under the cursor at
     the moment you were trying to keep your place among them. The pitch is fixed
     at every zoom (SLOT_W in layout.ts), so the width a narrow card handed back
     was never spent on anything either. Density is height and content only now,
     in both directions — see CARD_BOX. */
  .slot[data-lod="field"] .card {
    padding: 0.4rem;
    gap: 0;
  }
  .slot[data-lod="field"] .id,
  .slot[data-lod="field"] .act {
    display: none;
  }
  /* The ring is centred in the card, and this is the one thing at `field` that
     is *not* simply the wall with the text taken out of it. Holding the ring at
     the right edge, where it stands at every other density, was tried first and
     on the obvious argument: it is continuous across the threshold, so nothing
     moves at all as you zoom past it. But it leaves the ring hanging off the end
     of a box with nothing in the other three quarters of it — at `field` the
     ring is not a figure beside the text any more, it is the whole card, and the
     whole card's mark belongs in the middle of it. `.id` is gone, so without
     this the flex would put it at the left edge instead. */
  .slot[data-lod="field"] .top {
    justify-content: center;
  }

  /* Open does NOT widen the card, on purpose. Cards are placed on a fixed
     248-unit pitch, so a 288-wide card overlapped its right-hand neighbour by
     exactly the 40 units where the ring is drawn — zooming in to read hid the
     one number you were zooming in to read. What open adds is a line of speech,
     downwards, within the slot. */

  .said {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.42rem;
    margin-top: 0.1rem;
    /* One line of .say (0.76rem × 1.4 ≈ 17px) and no more: the card has to stay
       inside SLOT_H, or rows overlap the way columns used to. */
    max-height: 1.2rem;
    overflow: hidden;
  }
  /* Clipping is what this does, not what bounds it — `SAY_CAP` above cuts the
     string before it ever reaches here, because laying out a hundred KB in
     order to draw forty characters of it is still laying out a hundred KB. */
  .say {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.76rem;
    line-height: 1.4;
    color: var(--paper-mute);
  }
  .say.faint {
    color: var(--paper-faint);
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .shut:hover {
    background: color-mix(in srgb, var(--st-fail) 30%, transparent);
    color: var(--paper);
  }

  /* ── status: light and motion, never a badge ─────────────── */
  .card[data-st="work"] {
    --st: var(--st-work);
    animation: breathe 4.2s ease-in-out infinite;
  }
  .card[data-st="ask"] {
    --st: var(--st-ask);
    border-color: color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    animation: bloom 2.4s ease-in-out infinite;
  }
  .card[data-st="soft"] {
    --st: var(--st-soft);
    border-color: color-mix(in srgb, var(--st-soft) 32%, var(--edge));
  }
  .card[data-st="rest"] {
    --st: var(--st-rest);
    background: color-mix(in srgb, var(--surface) 76%, var(--ink));
  }
  .card[data-st="fail"] {
    --st: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 48%, var(--edge));
  }

  /* Dormant is a fill, not a fifth colour: the card keeps whatever tier it
     closed on and is drawn hollow, because the light is what's missing.
     "Hollow" is the *ground's* colour and not `transparent`, which it was until
     the wall had ambience drawn on it: a brush flourish or a drifting leaf
     passing behind a dormant card came straight through the middle of it, and a
     conversation is not something the weather gets to cross. Filling it with the
     wall reads identically — the wall is what you would have seen — and it is
     the only thing standing between the backdrop and the card, since the card is
     what has to occlude it. Same reasoning as `.pin`'s `--ink` halo. */
  .card[data-dormant] {
    background: var(--ink);
    border-style: dashed;
    animation: none;
    box-shadow: none;
  }
  .card[data-dormant] .title {
    color: var(--paper-mute);
  }
  /* The fold's bar, along the bottom inside edge of the card. Inset by the
     card's own border so it reads as part of the card rather than under it, and
     `pointer-events: none` because the card is a button and this is a readout
     laid over it. Takes no layout height at all — see the note by the markup.

     Celadon at low opacity: it is the working status, which is the one thing
     colour is for here, but it is also a *guess*, and a guess should not be as
     loud as the ring beside it that is measured. The transition is what makes a
     once-a-second clock read as movement rather than as a stall. */
  .guess {
    position: absolute;
    left: 1px;
    right: 1px;
    bottom: 1px;
    height: 2px;
    border-bottom-left-radius: 3px;
    border-bottom-right-radius: 3px;
    overflow: hidden;
    pointer-events: none;
  }
  .guess .fill {
    display: block;
    height: 100%;
    background: var(--st-work);
    opacity: 0.5;
    transition: width 1s linear;
  }

  .card[data-dormant] .act {
    color: var(--paper-faint);
  }
  .card[data-dormant] .dot {
    background: var(--paper-faint);
  }

  /* Set aside takes the light out of the name, which is exactly what dormant
     does — most cards put by are dormant too, and two rules that agree is what
     keeps the pair from reading as three states. Nothing here touches the
     border or the animation: the card is still whatever tier it is, and a card
     set aside mid-turn should go on breathing while it works. */
  .card[data-aside] .title {
    color: var(--paper-mute);
  }

  @keyframes breathe {
    0%,
    100% {
      box-shadow: 0 6px 26px -18px rgba(127, 184, 164, 0.5);
    }
    50% {
      box-shadow: 0 6px 34px -14px rgba(127, 184, 164, 0.85);
    }
  }
  @keyframes bloom {
    0%,
    100% {
      box-shadow:
        0 0 0 0 rgba(233, 161, 59, 0.3),
        0 8px 30px -14px rgba(233, 161, 59, 0.6);
    }
    50% {
      box-shadow:
        0 0 0 5px rgba(233, 161, 59, 0),
        0 8px 38px -10px rgba(233, 161, 59, 0.95);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .card {
      animation: none !important;
    }
  }
</style>
