<script lang="ts">
  import { narrow, newestFirst } from "./adopt";
  import { basename, windowForObserved } from "./classify";
  import { clock } from "./conversation.svelte";
  import type { Session } from "./skein.svelte";

  let {
    sessions,
    loading = false,
    onpick,
    onclose,
  }: {
    sessions: Session[];
    loading?: boolean;
    /** Why it did not work, or `null` if it did. A boolean would be enough to
     *  keep the row honest and not enough to tell anybody what happened — and
     *  the wall's own fault bar is *behind* this scrim, so a failure surfaced
     *  there is a failure nobody can read until they close the panel. */
    onpick: (s: Session) => Promise<string | null>;
    onclose: () => void;
  } = $props();

  let filter = $state("");
  /** Ids that reached the wall in this sitting, so a row cannot be adopted
   *  twice while the list is still up — the wall updates behind the panel, not
   *  inside it.
   *
   *  Written **after** the adopt returns, and that is the whole of a bug worth
   *  remembering: it used to be written before, so an adopt that threw left the
   *  row permanently grey and reading "on the wall", with the reason swallowed
   *  into a fault bar under the scrim and no way to try again short of closing
   *  the panel. A record of what happened may not be written before the thing
   *  has happened — the same shape as `set_mid_turn` in `store.rs`, one realm
   *  over. */
  let taken = $state<string[]>([]);
  /** Ids being adopted right now. One row can take a second — `ensure_project`
   *  and `import_conversation` are two round trips — and without this a second
   *  click starts a second adopt of the same session. */
  let working = $state<string[]>([]);
  /** Why each row that failed failed, keyed by its id.
   *
   *  A map rather than a list of ids and a single `why`, because those two
   *  drift apart the moment there is a second click: the reason was cleared on
   *  every attempt, so adopting A unsuccessfully and then B successfully left A
   *  red, marked "did not take", with its explanation gone from the screen and
   *  no way back to it but making it fail again. A mark and its reason are one
   *  fact, so they are kept as one. */
  let missed = $state<Record<string, string>>({});

  /* Both of these are `adopt.ts`, which is pure and tested. The ordering is
     what the panel answers with before you have typed anything; the filter is
     what it answers with after. Neither is a rendering question, and the
     searching in particular had a right answer it was getting wrong — see the
     note at the top of that file. */
  const recent = $derived(newestFirst(sessions));
  const shown = $derived(narrow(recent, filter));

  /** How long ago, in the coarsest unit that still says something.
   *
   *  Elapsed while elapsed is what you would use to find it — "20m ago" is how
   *  you recognise the thing you stepped away from — and a date once it is not.
   *  Past a fortnight the count stops being a way of remembering anything: "9w
   *  ago" is arithmetic you have to do backwards, where "3 jun" is a day you
   *  either recall or do not. Lowercase, like the rest of the prose here. */
  function ago(iso: string | null): string {
    if (!iso) return "—";
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return "—";
    const secs = Math.max(0, (clock.t - at) / 1000);
    if (secs < 90) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days}d ago`;
    const d = new Date(at);
    const month = d.toLocaleString("en-GB", { month: "short" }).toLowerCase();
    /* The year only when it is not this one — it is noise on the ones you are
       most likely to be looking for, and the whole answer on the rest. */
    return d.getFullYear() === new Date(clock.t).getFullYear()
      ? `${d.getDate()} ${month}`
      : `${d.getDate()} ${month} ${String(d.getFullYear()).slice(2)}`;
  }

  const pct = (s: Session) =>
    Math.round((100 * s.ctx_tokens) / windowForObserved(s.model ?? undefined, s.ctx_tokens));

  async function pick(s: Session) {
    if (taken.includes(s.id) || working.includes(s.id)) return;
    working = [...working, s.id];
    /* This row's own last failure only — a row you are trying again is a row
       whose reason is no longer the news. Every other row's stands. */
    const { [s.id]: _retrying, ...rest } = missed;
    missed = rest;
    let fault: string | null;
    try {
      fault = await onpick(s);
    } catch (err) {
      /* `adopt` is not supposed to throw — but a panel that latches a row on a
         promise it did not catch is the bug above wearing another face. */
      fault = String(err);
    }
    working = working.filter((id) => id !== s.id);
    if (fault === null) taken = [...taken, s.id];
    else missed = { ...missed, [s.id]: fault };
  }

  /** What the last column says about a row, which is the only place the panel
   *  admits that adopting is something that can fail. */
  function mark(s: Session): string {
    if (taken.includes(s.id)) return "on the wall";
    if (working.includes(s.id)) return "adopting\u2026";
    if (s.id in missed) return "did not take";
    return "";
  }

  /** Every row that failed, in the order they are listed, for the lines under
   *  the list. Named, because "that one" stops being an answer as soon as two
   *  of them have failed. */
  const faults = $derived(
    recent.filter((s) => s.id in missed).map((s) => ({ s, why: missed[s.id] })),
  );
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag that started inside the panel does not dismiss it. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div class="panel" onmousedown={(e) => e.stopPropagation()} role="presentation">
    <div class="head">
      <span class="mark">Adopt a conversation</span>
      <span class="grow"></span>
      <button class="x" onclick={onclose} title="Close">✕</button>
    </div>

    <p class="note">
      Sessions Claude Code has recorded that no card points at, most recently
      spoken to first. Adopting one leaves the transcript where it is — the card
      resumes that same session, and a terminal can still pick it up afterwards.
    </p>

    <input
      class="filter"
      bind:value={filter}
      placeholder="narrow the list by anything said in it, or by folder or branch"
    />

    <div class="rows">
      {#if loading}
        <p class="empty">reading what claude has recorded…</p>
      {:else if !shown.length}
        <p class="empty">
          {sessions.length
            ? "nothing matches that."
            : "nothing to adopt — every recorded session is already on the wall."}
        </p>
      {/if}

      {#each shown as s (s.id)}
        <button
          class="row"
          class:missed={s.id in missed}
          title={missed[s.id] ?? undefined}
          disabled={taken.includes(s.id) || working.includes(s.id)}
          onclick={() => pick(s)}
          data-session={s.id}
        >
          <span class="title">{s.title ?? "untitled"}</span>
          <span class="where">
            {basename(s.cwd) || s.cwd}{#if s.branch}<span class="branch"
                >· {s.branch}</span
              >{/if}
          </span>
          <span class="when">{ago(s.last_at)}</span>
          <span class="ctx">{pct(s)}%</span>
          <span class="taken">{mark(s)}</span>
        </button>
      {/each}
    </div>

    <!-- The wall's own fault bar sits under this scrim, so a failure that only
         reached `skein.fault` was a failure nobody could read. One line per row
         that failed, and named. -->
    {#each faults as f (f.s.id)}
      <p class="miss">{f.s.title ?? "untitled"} — {f.why}</p>
    {/each}

    <footer>
      <span>{shown.length} of {sessions.length}</span>
      <span class="grow"></span>
      {#if taken.length}<span>{taken.length} adopted</span>{/if}
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: min(74ch, 92vw);
    max-height: 76vh;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.6rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .grow {
    flex: 1 1 auto;
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-faint);
    max-width: 66ch;
  }

  .filter {
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.82rem;
    padding: 0.34rem 0.5rem;
  }
  .filter:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .filter::placeholder {
    color: var(--paper-faint);
  }

  /* `flex: 1 1 0` and not the `0 1 auto` this resolved to for its whole life,
     which is why the panel opened empty on any wall with real history in it.
     With an `auto` basis this box's flex-basis *is* its content height — about
     20,000px at 450 rows — and shrink is distributed in proportion to
     `shrink x basis`, so it absorbed essentially the whole overflow and
     collapsed to nothing while the header, the note, the filter and the footer
     kept their tiny bases. The panel drew as a search box with a void under it,
     and typing a query appeared to fix it because a shorter list fits.

     A zero basis moves the box from fighting for what is left to being what is
     left: the column has free space to give, this takes it, and the content
     overflows into the scroll it already declared. Short lists are unaffected —
     a flex item with `flex-grow: 1` contributes its content height to an
     auto-height container's intrinsic size, so three sessions still draw a
     three-row panel rather than stretching one to 76vh. */
  .rows {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-height: 0;
  }

  /* One line per session, on a grid so the columns line up down the list
     rather than drifting with the length of each title. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18ch 10ch 4ch 9ch;
    align-items: baseline;
    gap: 0.6rem;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--edge);
    padding: 0.42rem 0.3rem;
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.74rem;
    color: var(--paper-mute);
  }
  .row:hover:not(:disabled) {
    background: var(--raised);
  }
  .row:disabled {
    cursor: default;
    opacity: 0.5;
  }
  /* Still a button, and still clickable: a row that failed is a row to try
     again. Marked rather than greyed, since grey here means "already done". */
  .row.missed .taken {
    color: var(--st-fail);
  }
  .row .title {
    color: var(--paper);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .where,
  .row .when,
  .row .ctx,
  .row .taken {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper-faint);
  }
  .row .branch {
    margin-left: 0.35rem;
  }
  .row .ctx {
    font-family: var(--mono);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .miss {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.4;
    color: var(--st-fail);
  }

  .empty {
    margin: 0;
    padding: 1.2rem 0.3rem;
    font-family: var(--util);
    font-size: 0.74rem;
    color: var(--paper-faint);
  }

  footer {
    display: flex;
    gap: 0.4rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.4rem;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
