<script lang="ts">
  /* What is left of the allowance, and what the work has cost.
   *
   * Two readings of two different things, and the knob picks which. The default
   * is the **allowance** — how much of the five-hour window and of the week is
   * gone, and when each comes back — because that is the question anybody
   * actually has at four in the afternoon, and it is what `/usage` answers in
   * the CLI. `cost` and `tokens` are the other reading: what this way of working
   * costs, off the transcripts.
   *
   * **The percentages here are real, and that is new.** This face used to carry
   * a standing note that no percentage of an allowance could be drawn anywhere,
   * because nothing on the machine knew the account's limit — every fraction was
   * drawn against the wall's own recent history instead, the block against the
   * busiest block of the week. That was true of *transcripts* and false of the
   * account: `/api/oauth/usage` names both the utilization and the reset, and
   * `limits.rs` asks it. So the honest-fallback apparatus is still here and is
   * still what `cost` and `tokens` draw — an account with no OAuth sign-in has
   * nothing else — but it is no longer the best answer available.
   *
   * The arithmetic and the words are `limits.ts` and `usage.ts`, both pure and
   * tested; the reading is one shared `Ledger`. Nothing here decides anything. */

  import { sayCeiling, speaksWith, type Account } from "./accounts";
  import { clock } from "./conversation.svelte";
  import type { Ledger } from "./ledger.svelte";
  import { waterfall } from "./waterfall.svelte";
  import type { Window } from "./limits";
  import {
    binding,
    ordered,
    pct,
    planSaid,
    resetIn,
    tierOf,
    until,
    said as windowSaid,
    why as windowWhy,
  } from "./limits";
  import {
    amount,
    leaders,
    left,
    say,
    share,
    shortModel,
    WEEK_MS,
    type Measure,
    type Reading,
    readings,
  } from "./usage";
  import { textOf, variantOf, type Widget } from "./widgets";

  let { widget, ledger }: { widget: Widget; ledger: Ledger } = $props();

  /* The one-second tick the wall already runs on, taken directly rather than
     passed down — the same rune `Clock.svelte` reads, and the reason neither of
     them adds a second wake-up per second to an otherwise idle machine. The
     reading only changes once a minute (`left`), so a tick that changes nothing
     costs a recompute and no DOM. */
  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));

  /** What this face is a reading *of*. Wider than `Measure`, because the
   *  allowance is not a third way of counting tokens — it is a different fact,
   *  off a different source, with a denominator the other two do not have. */
  type Knob = "allowance" | Measure;
  const knob = $derived(textOf(widget, "measure", "allowance") as Knob);
  const allowance = $derived(knob === "allowance");
  /* The cost path still wants a `Measure`, and `cost` is the sane thing to fall
     back to when the knob is on a value it does not understand. */
  const measure = $derived<Measure>(knob === "tokens" ? "tokens" : "cost");

  /** Which subscription this face is a reading of: a label, or `all`.
   *
   *  Only meaningful on the allowance — a transcript does not record which
   *  account paid for a turn, so cost and tokens cannot be scoped to one. The
   *  knob is hidden on those two by its `only` guard rather than ignored, which
   *  is `widgets.ts`'s standing rule about knobs that would do nothing. */
  const account = $derived(textOf(widget, "account", "all"));

  /** Accounts that could answer: signed in and switched on. With none, this
   *  widget is exactly what it was before accounts existed — one reading of
   *  whoever Claude Code is signed in as, off `Ledger`. */
  const usable = $derived(waterfall.usable);
  const managing = $derived(usable.length > 0);

  /** Whether there is a choice of account to be made. Gates the knob, the wide
   *  face and whether the heading names an account — with one account all three
   *  are noise: a menu with one answer, a list with one row, and a name that
   *  never varies. The *reading* is not gated on it, because a single
   *  registered account is still the account being spent and may not be the one
   *  Claude Code is signed in as. So the face gets more accurate and no busier.
   *  `several` in `accounts.ts` holds the rule. */
  const several = $derived(waterfall.several);

  /** One account's reading. `fault` and `windows` are kept apart all the way
   *  here for the reason `read_allowances` keeps them apart in Rust: an account
   *  that is full and an account that could not be asked are answered
   *  differently, and a face that drew 0% for the second would be lying about
   *  the first.
   *
   *  They are not exclusive, and the case where both are set is the interesting
   *  one: windows that arrived earlier, and a reason the ask since then failed.
   *  That is what the footer's `stale` mark is for, and it is exactly the shape
   *  `globalFace` has always had — `ledger.limits` beside `ledger.limitsFault` —
   *  now that an account face can hold a reading through a fault too
   *  (`accounts.ts::keptThrough`). */
  type Face = {
    label: string;
    windows: Window[];
    fault: string | null;
    source: string;
    /** The registry's row for this reading, where there is one — carried so the
     *  wide face can apply the caps you set. Null for the signed-in session,
     *  which is not an account in the order and has no caps of yours. */
    account: Account | null;
  };

  /** The knob's value for the globally signed-in session — the account this
   *  machine is signed in as, which is not one of the accounts in the order.
   *  Kept as a constant because three places have to agree about it: the face,
   *  what `Ledger` is asked for, and whether a knob naming a departed account
   *  is reported missing. */
  const SIGNED_IN = "signed-in";

  /** The signed-in session's reading, off `Ledger` — the whole of the widget on
   *  a wall with no accounts, and one choice on the knob when there are. */
  const globalFace = $derived.by<Face>(() => ({
    label: "",
    windows: ordered(ledger.limits?.windows ?? []),
    fault: ledger.limits ? null : ledger.limitsFault,
    source: ledger.limits?.source ?? "",
    account: null,
  }));

  const faces = $derived.by<Face[]>(() => {
    if (!managing) return [globalFace];
    /* Asked for by name, on a wall that does manage accounts. Only honoured
       where the knob was actually drawn: with one account it is not, and a
       stored value from when there were two must not quietly redirect the face
       — the same care the `wanted` branch below takes. */
    if (several && account === SIGNED_IN) return [globalFace];
    /* With no choice to make, the knob is not drawn and whatever it happens to
       say is not an instruction — there is one account and it is the reading.
       Reading the knob anyway is how a widget set to "work" before a second
       account was removed would end up drawing nothing. */
    const wanted = !several
      ? usable
      : account === "all"
        ? usable
        : usable.filter((a) => a.label === account);
    return wanted.map((a) => {
      const got = waterfall.allowances[a.label];
      return {
        label: a.label,
        windows: got?.ok ? ordered(got.windows) : [],
        /* A held reading reports the reason the *last ask* failed, which puts
           the `stale` mark on the footer without taking a single window off the
           face — the number on it is still the best one there is. */
        fault: !got ? "not read yet" : got.ok ? (got.stale ?? null) : got.fault,
        source: `the '${a.label}' account`,
        account: a,
      };
    });
  });

  /** True when the knob names an account that is no longer in the order. Said
   *  rather than silently falling back to another one — a face quietly
   *  redirected to a different subscription is the one way this can mislead,
   *  and `normalizeParam` deliberately keeps the value so it can be reported. */
  /** Which account the next turn would actually go to, so the wide face says
   *  what is being spent rather than only how full each one is. Straight off
   *  the same chooser the wall uses, so the two cannot disagree. */
  const nextUp = $derived.by(() => {
    if (!managing) return null;
    const c = waterfall.next();
    return c.kind === "use" ? c.label : null;
  });

  const missing = $derived(several && account !== "all" && faces.length === 0);

  /** The multi-account reading: one line per account rather than one per
   *  window. A wall spending three subscriptions in an order wants to know
   *  which one is being spent and how close the next is, and eight or nine
   *  window rows would bury that. So each account speaks with one window, and
   *  `accounts.ts::speaksWith` is which: the five hours, unless the week has run
   *  out — see there for why the fullest window was the wrong one to send. A
   *  week that has run out is rust whatever `tierOf` makes of it, because a
   *  ceiling *you* set is a ceiling at 60% and only that side knows your caps. */
  const every = $derived(
    faces.map((f) => {
      const spoke = f.account
        ? speaksWith(f.account, f.windows)
        : { window: binding(f.windows), ceiling: null };
      const worst = spoke.window;
      return {
        face: f,
        worst,
        tier: worst ? (spoke.ceiling ? "urgent" : tierOf(worst)) : undefined,
        /* Only where a ceiling was reached, and then always: the number alone
           cannot explain a rust 60%, which is what a cap of yours looks like.
           And that the reading is a held one, which on this face has nowhere
           else to be said — one line per account has no room for a mark, and a
           column of percentages must not quietly include an old one. A fault
           with a window to speak with is a held reading by construction: with
           nothing read there is no `worst` and this note is never reached. */
        note: [spoke.ceiling ? sayCeiling(spoke.ceiling) : null, f.fault ? "stale" : null]
          .filter(Boolean)
          .join(", "),
      };
    }),
  );

  /* Asking is what makes the reader run at all — with no usage widget up,
     nothing walks a week of transcripts and nothing leaves the machine. The
     measure goes in with the ask, so a wall showing the allowance does not pay
     for a week of transcripts it is not drawing; `Ledger.#retime` starts and
     stops only the half that changed, so turning the knob does not disturb the
     other one. Two effects rather than one, for the reason `Perf.svelte` gives:
     a tracking effect's cleanup fires on every change, and a single one would
     detach on every re-read. */
  $effect(() => {
    /* Three cases, not two. The cost reading always wants the transcript pass.
       The allowance wants `Ledger` while the wall manages no accounts — or
       while the knob is pointed at the signed-in session, which is the one
       reading `waterfall` does not have, since it polls the accounts in the
       order and the signed-in session is not one of them. Otherwise the
       per-account readings come off `waterfall`, which the wall itself already
       polls, and asking `Ledger` as well would spend a second request a minute
       on an account nothing is drawing. */
    if (!allowance) ledger.attach(widget.id, "spend");
    else if (!managing || (several && account === SIGNED_IN)) {
      ledger.attach(widget.id, "allowance");
    } else ledger.detach(widget.id);
  });
  $effect(() => () => ledger.detach(widget.id));

  /* ── the allowance ───────────────────────────────────────────────────── */

  /* The chosen account's windows, which for an unmanaged wall is the signed-in
     account's and so is exactly what this was before. */
  const windows = $derived(faces.length === 1 ? faces[0]!.windows : []);
  /** Whether the face is drawing one account's windows or every account's
   *  binding window. `all` on a wall with one account is still the every-
   *  account face: it is what was asked for, and it stays right when a second
   *  is added. */
  const wide = $derived(several && account === "all");
  /** The chosen reading's own fault, whichever source it came from. */
  const allowanceFault = $derived(
    managing ? (faces.length === 1 ? faces[0]!.fault : null) : ledger.limitsFault,
  );
  /** Whether anything has actually answered for the chosen reading. */
  const gotAllowance = $derived(
    managing ? faces.some((f) => f.windows.length > 0) : !!ledger.limits,
  );
  /** The one about to stop you, which is what the header counts down. */
  const soonest = $derived(
    /* On the wide face this is the first account to come back rather than one
       account's fullest window — the same "first door to open" the hold in
       `skein.svelte.ts` counts down to, and the useful answer when every
       account is full. On a single account it is what it always was. */
    wide
      ? every
          .map((e) => e.worst)
          .filter((w): w is Window => w !== null && resetIn(w, now) !== null)
          .sort((a, b) => resetIn(a, now)! - resetIn(b, now)!)[0] ?? null
      : binding(windows),
  );
  const heading = $derived(
    !allowance
      ? measure === "cost"
        ? "at list rates"
        : "tokens processed"
      : wide
        ? "every account"
        : several
          ? /* The label is the only name an account has — a token does not
               announce whose it is, so nothing here can say more than what you
               called it. Only where there is another account it could have
               been; naming the only one there is says nothing. */
            account
          : planSaid(ledger.limits?.plan ?? null),
  );

  const both = $derived(readings(ledger.slices, now, measure));
  const rows = $derived<Reading[]>([both.block, both.week]);

  /* Where the week's money went. Only ever the top one — a widget this size has
     room for a name, not a table, and the name is the useful half. */
  const top = $derived(
    leaders(ledger.slices, now - WEEK_MS, now + 1, measure)[0] ?? null,
  );
  const quiet = $derived(both.week.totals.tokens === 0);
  const unpriced = $derived(both.week.totals.unpriced);

  function head(r: Reading): string {
    return say(amount(r.totals, measure), measure);
  }

  /** What a row is measured against, said in full — the tooltip carries the
   *  sentence the face has no room for. */
  function why(r: Reading): string {
    const own = `${r.said} — ${head(r)}`;
    if (!r.against) return own;
    return `${own}, against the ${r.against.said} (${say(r.against.amount, measure)})`;
  }
</script>

<div class="usage" data-variant={variant}>
  <header>
    <span class="what">{heading}</span>
    {#if allowance}
      <!-- The account's own reset, for whichever window runs out first. Unlike
           the block below this is a fact off the wire rather than an inference,
           and it is the half of the question the percentage does not answer. -->
      {#if soonest && resetIn(soonest, now) !== null}
        <span class="rolls" title="{windowSaid(soonest)} comes back then">
          {until(resetIn(soonest, now)!)}
        </span>
      {/if}
    {:else if both.block.resetsIn !== null}
      <!-- The inferred block, and only the block: without the account's answer
           the weekly window resets on a schedule nothing here can see. -->
      <span class="rolls" title="the five-hour window rolls over then">
        {left(both.block.resetsIn)}
      </span>
    {:else}
      <span class="rolls rested" title="nothing said for five hours">rested</span>
    {/if}
  </header>

  {#if allowance}
    {#if missing}
      <!-- The knob names an account that has left the order. Said rather than
           quietly redrawn as another one — see `normalizeParam`, which keeps
           the value precisely so this can be reported. -->
      <p class="quiet">{account} is not in the order any more</p>
    {:else if wide}
      <!-- Every account, one line each, speaking with the window that will
           actually stop it. Eight window rows across three subscriptions would
           bury the thing being asked: which one is being spent, and how much is
           behind it. -->
      {#if variant === "rings"}
        <div class="dials">
          {#each every as { face, worst, tier, note } (face.label)}
            <div
              class="dial"
              title={worst
                ? `${face.label} — ${windowWhy(worst, now)}${note ? `, ${note}` : ""}`
                : `${face.label} — ${face.fault ?? "nothing read yet"}`}
            >
              <div class="arc" data-tier={tier} style:--v={share(worst?.used ?? 0, 100)}></div>
              <span class="val" data-tier={tier}>
                {worst ? pct(worst.used) : "—"}
              </span>
              <span class="cap">{face.label}</span>
            </div>
          {/each}
        </div>
      {:else}
        <ul class="rows" class:bars={variant === "bars"}>
          {#each every as { face, worst, tier, note } (face.label)}
            <li
              title={worst
                ? `${face.label} — ${windowWhy(worst, now)}${note ? `, ${note}` : ""}`
                : `${face.label} — ${face.fault ?? "nothing read yet"}`}
            >
              <span class="row">
                <span class="label">{face.label}</span>
                {#if worst && resetIn(worst, now) !== null}
                  <span class="when">{until(resetIn(worst, now)!)}</span>
                {/if}
                <span class="n" data-tier={tier}>
                  {worst ? pct(worst.used) : "—"}
                </span>
              </span>
              {#if variant === "bars"}
                <span class="bar" data-tier={tier} style:--v={share(worst?.used ?? 0, 100)}></span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if !gotAllowance && allowanceFault}
      <p class="fault">{allowanceFault}</p>
    {:else if !gotAllowance}
      <p class="quiet">asking the account…</p>
    {:else if windows.length === 0}
      <p class="quiet">no windows on this account</p>
    {:else if variant === "rings"}
      <div class="dials">
        {#each windows as w (w.kind + (w.scope ?? ""))}
          <div class="dial" title={windowWhy(w, now)}>
            <div class="arc" data-tier={tierOf(w)} style:--v={share(w.used, 100)}></div>
            <span class="val" data-tier={tierOf(w)}>{pct(w.used)}</span>
            <span class="cap">{windowSaid(w)}</span>
          </div>
        {/each}
      </div>
    {:else}
      <ul class="rows" class:bars={variant === "bars"}>
        {#each windows as w (w.kind + (w.scope ?? ""))}
          <li title={windowWhy(w, now)}>
            <span class="row">
              <span class="label">{windowSaid(w)}</span>
              {#if resetIn(w, now) !== null}
                <span class="when">{until(resetIn(w, now)!)}</span>
              {/if}
              <span class="n" data-tier={tierOf(w)}>{pct(w.used)}</span>
            </span>
            {#if variant === "bars"}
              <!-- A fraction of a real limit, which is the whole difference
                   between this reading and the one below it. -->
              <span class="bar" data-tier={tierOf(w)} style:--v={share(w.used, 100)}></span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if ledger.fault}
    <p class="fault">{ledger.fault}</p>
  {:else if !ledger.ready}
    <p class="quiet">reading the transcripts…</p>
  {:else if variant === "rings"}
    <div class="dials">
      {#each rows as r (r.key)}
        <div class="dial" title={why(r)}>
          <div class="arc" style:--v={r.frac}></div>
          <span class="val">{head(r)}</span>
          <span class="cap">{r.key === "block" ? "5 hours" : "7 days"}</span>
        </div>
      {/each}
    </div>
  {:else}
    <ul class="rows" class:bars={variant === "bars"}>
      {#each rows as r (r.key)}
        <li title={why(r)}>
          <span class="row">
            <span class="label">{r.said}</span>
            <span class="n">{head(r)}</span>
          </span>
          {#if variant === "bars"}
            <span class="bar" style:--v={r.frac}></span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <footer>
    {#if allowance}
      {#if wide}
        <!-- Which subscription is actually taking work, which is the question
             the multi-account face is up to answer and the one thing a column
             of percentages does not say on its own. -->
        <span class="note" title="the next turn would go here">
          {nextUp ?? `${every.length} account${every.length === 1 ? "" : "s"}`}
        </span>
      {:else if !managing && ledger.limits?.overage?.enabled}
        <!-- Without this, every window pinned full while work carries on
             reads as a broken instrument rather than as a bill. -->
        <span class="note" title="spending past the plan's allowance">
          on extra usage
        </span>
      {:else if gotAllowance}
        <span class="note" title="read from {faces[0]?.source ?? 'the account'}">
          {windows.length} window{windows.length === 1 ? "" : "s"}
        </span>
      {/if}
      {#if gotAllowance && allowanceFault}
        <!-- A reading is up and the last ask failed, so what is on the face is
             the truth as of some minutes ago. Said rather than silently
             redrawn: a stale percentage that looks live is the one way this
             widget can mislead. -->
        <span class="note odd" title={allowanceFault}>stale</span>
      {/if}
    {:else if quiet && ledger.ready}
      <span class="note">nothing spent this week</span>
    {:else if top}
      <span class="note" title="most of the week's {measure === 'cost' ? 'spend' : 'tokens'}">
        mostly <b>{shortModel(top.model)}</b>
      </span>
    {/if}
    {#if unpriced > 0}
      <!-- Said out loud rather than folded in: a model this build has no rate
           for contributes nothing to the cost, and a total quietly missing a
           model is worse than a total that admits it. -->
      <span class="note odd" title="a model with no rate in this build">unpriced</span>
    {/if}
  </footer>
</div>

<style>
  .usage {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.32rem;
    /* Deliberately paints no background of its own. The wrapper is opaque
       already — see the ambience note — so this is the same fill either way,
       and leaving it to the wrapper means the `frame` knob's `bare` reaches
       this face rather than being covered over by it. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rolls {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }
  .rolls.rested {
    font-family: inherit;
    color: var(--paper-faint);
  }

  .rows {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.3rem;
    margin: 0;
    padding: 0.24rem 0 0;
    list-style: none;
  }
  .rows li {
    position: relative;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.1rem 0.2rem;
    color: var(--paper-dim);
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.78rem;
    color: var(--paper);
  }

  /* When a window comes back. Between the label and the figure rather than
     after it, so the column of percentages stays flush right and readable as a
     column — the reset is the sentence, the percentage is the reading. */
  .when {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
    color: var(--paper-faint);
    white-space: nowrap;
  }

  /* Colour is status on this wall and nowhere else, and an allowance running
     out is status in the strictest sense — the same amber and rust a card
     wears, meaning the same thing. Calm takes no colour at all, which is what
     keeps the other two worth noticing. */
  .n[data-tier="warm"],
  .val[data-tier="warm"] {
    color: var(--st-ask);
  }
  .n[data-tier="urgent"],
  .val[data-tier="urgent"] {
    color: var(--st-fail);
  }

  /* Under the row rather than inside it, so the numbers never move as it grows
     — the same arrangement the process meter's bar has. */
  .bar {
    position: absolute;
    left: 0.2rem;
    right: 0.2rem;
    bottom: -0.1rem;
    height: 1px;
    background: var(--edge);
  }
  .bar::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--v) * 100%);
    background: var(--paper-faint);
  }
  .bar[data-tier="warm"]::after {
    background: var(--st-ask);
  }
  .bar[data-tier="urgent"]::after {
    background: var(--st-fail);
  }

  .dials {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: space-evenly;
    gap: 0.5rem;
    padding: 0.3rem 0;
  }
  .dial {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }
  /* Drawn in CSS rather than as an SVG, like the process meter's dials: one
     shape, no glyph, nothing to fall through to a font. */
  .arc {
    width: min(15cqw, 32cqh);
    height: min(15cqw, 32cqh);
    border-radius: 50%;
    background: conic-gradient(
      var(--arc, var(--paper-dim)) calc(var(--v) * 360deg),
      var(--surface) 0
    );
    mask: radial-gradient(circle, transparent 58%, black 59%);
  }
  .arc[data-tier="warm"] {
    --arc: var(--st-ask);
  }
  .arc[data-tier="urgent"] {
    --arc: var(--st-fail);
  }
  .val {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
    color: var(--paper);
  }
  .cap {
    font-size: 0.58rem;
    color: var(--paper-mute);
    letter-spacing: 0.06em;
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.2rem 0.2rem 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .note {
    font-size: 0.62rem;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note b {
    font-weight: 500;
    color: var(--paper-dim);
  }
  /* Achromatic on purpose: colour on this wall is status, and a model nobody
     has a price for is a gap in the reading rather than a fault. */
  .note.odd {
    margin-left: auto;
    color: var(--paper-faint);
    letter-spacing: 0.04em;
  }

  .quiet,
  .fault {
    flex: 1;
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    text-align: center;
  }
  .fault {
    color: var(--st-fail);
    text-align: left;
  }
</style>
