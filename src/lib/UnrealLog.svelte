<script lang="ts">
  /* The editor's own log, beside the card whose agent is changing the code in
   * it.
   *
   * The thing this answers that nothing else on the wall could: an automation
   * test that failed inside a running editor, a blueprint that is spewing, an
   * asset that will not load. All of it goes to `Saved/Logs`, none of it goes
   * anywhere Skein was looking, and reading it has meant a second window over
   * the top of the wall.
   *
   * Two readings. `lines` is the tail, taken apart so the forty columns of
   * `[2026.08.21-14.32.10:123][456]LogTemp: Warning:` become a short category in
   * the gutter and the message in the space that leaves. `tally` is the count
   * and the last thing wrong — the reading for a widget the size of a card, and
   * the one that answers "did that test run cleanly" from across the room.
   *
   * See `unreallog.ts` for the parse, and for why the tail is gated on the
   * editor being open rather than running whenever the widget exists. */

  import { emptyBecause, FOLLOW, linesFor, subjectOf, tail } from "./logface";
  import LogFace from "./LogFace.svelte";
  import LogTail from "./LogTail.svelte";
  import {
    absence,
    isLive,
    keeping,
    lastProblem,
    lastSeen,
    NARROWING,
    pulseOf,
    rowsOf,
    shortCategory,
    standing,
    tally,
    timeOf,
    type Editor,
  } from "./unreallog";
  import { onOf, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    editors,
    onopen,
  }: {
    widget: Widget;
    /** Every Unreal project on the wall, its editor's state, and whatever has
     *  been tailed out of its log. Flattened in `App.svelte` off `Actions`,
     *  which owns both the poll that knows whether an editor is up and the tail
     *  that produced the lines. */
    editors: Editor[];
    /** Open this project's editor. Routed out to the `editor` action rather
     *  than invoked here, which is the whole reason the button is worth having:
     *  `launch-editor` starts it with `-ModelContextProtocolStartServer` and the
     *  port from the committed `.mcp.json`, so the editor this opens is one the
     *  cards on this wall can talk to. A shortcut on the taskbar is not. */
    onopen: (root: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const showing = $derived(textOf(widget, "showing", "all"));
  const stamps = $derived(onOf(widget, "stamps", false));
  /* `lastSeen` keeps a closed editor's kept lines in front of you rather than
     wandering to whichever project sorts first — the same fallback the build log
     needed, one subject over. */
  const subject = $derived(
    subjectOf(textOf(widget, "project", FOLLOW), editors, isLive, lastSeen),
  );
  const editor = $derived(subject.it);
  const because = $derived("because" in subject ? subject.because : null);
  const rows = $derived(linesFor(widget.h));

  const stand = $derived(editor ? standing(editor) : null);
  const cut = $derived(
    editor ? tail(editor.log, keeping(showing), rows) : { lines: [], hidden: 0 },
  );
  const counts = $derived(editor ? tally(editor.log) : { errors: 0, warnings: 0 });
  const worst = $derived(editor ? lastProblem(editor.log) : null);

  const note = $derived(
    !editor
      ? absence(because ?? "none")
      : variant === "tally" || cut.lines.length
        ? null
        : (emptyBecause(cut.hidden, NARROWING[showing] ?? "left") ??
          /* An open editor that has said nothing yet is ordinary — the tail
             starts at the end of the file, so the first line arrives when the
             editor next has something to say, which on an idle editor can be a
             while. Saying so beats a pane that looks stuck. */
          (editor.open ? "nothing since the tail started" : "nothing tailed")),
  );
</script>

<LogFace
  pulse={editor ? pulseOf(editor) : "idle"}
  name={editor?.name ?? "no editor"}
  sub={editor && editor.name !== editor.project ? editor.project : ""}
  title={editor ? `${editor.project} · Saved/Logs/${editor.name}.log` : undefined}
  down={editor && stand
    ? { word: stand.word, verb: stand.verb, press: () => onopen(editor.id) }
    : null}
  {note}
>
  {#snippet chips()}
    {#if counts.errors}
      <span class="count bad">{counts.errors} err</span>
    {/if}
    {#if counts.warnings}
      <span class="count warn">{counts.warnings} warn</span>
    {/if}
    {#if editor?.mcpPort}
      <span class="count">mcp :{editor.mcpPort}</span>
    {/if}
  {/snippet}

  {#if variant === "tally"}
    <div class="sum">
      <!-- A clean session is a *reading*, not an empty pane. It is also the
           answer you were hoping for, so it gets said in words rather than left
           to the absence of two numbers. -->
      {#if !counts.errors && !counts.warnings}
        <span class="clean">nothing wrong yet</span>
      {:else}
        <span class="numbers">
          <b class:bad={counts.errors > 0}>{counts.errors}</b><span class="of"
            >{counts.errors === 1 ? "error" : "errors"}</span
          >
          <b class:warn={counts.warnings > 0}>{counts.warnings}</b><span class="of"
            >{counts.warnings === 1 ? "warning" : "warnings"}</span
          >
        </span>
      {/if}
      {#if worst}
        <p class="worst" data-tone={worst.verbosity === "warning" ? "warn" : "fail"}>
          {#if shortCategory(worst.category)}<span class="cat"
              >{shortCategory(worst.category)}</span
            >{/if}{worst.text}
        </p>
        {#if stamps && timeOf(worst.stamp)}
          <span class="at">{timeOf(worst.stamp)}</span>
        {/if}
      {/if}
    </div>
  {:else}
    <LogTail rows={rowsOf(cut.lines, stamps)} tint />
  {/if}
</LogFace>

<style>
  .count {
    flex: 0 0 auto;
    color: var(--paper-mute);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    font-size: 0.6rem;
  }
  .count.bad {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--st-fail);
  }
  .count.warn {
    border-color: color-mix(in srgb, var(--st-soft) 50%, var(--edge));
    color: color-mix(in srgb, var(--st-soft) 80%, var(--paper-mute));
  }

  .sum {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.2rem 0.3rem 0;
    overflow: hidden;
  }
  .clean {
    font-size: 0.72rem;
    color: var(--paper-mute);
  }
  .numbers {
    display: flex;
    align-items: baseline;
    gap: 0.4ch;
    font-size: 0.7rem;
    color: var(--paper-faint);
  }
  /* The numbers at reading size and the words beside them small: what you are
     taking in from across the room is "two" and "nought", and the labels are
     only there so the first time you look you know which is which. */
  .numbers b {
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--paper-dim);
    font-variant-numeric: tabular-nums;
  }
  .numbers b.bad {
    color: var(--st-fail);
  }
  .numbers b.warn {
    color: var(--st-soft);
  }
  .of {
    margin-right: 0.8ch;
  }
  .worst {
    margin: 0;
    max-width: 100%;
    font-family: var(--mono);
    font-size: 0.6rem;
    line-height: 1.35;
    text-align: center;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    color: var(--paper-mute);
  }
  .worst[data-tone="warn"] {
    color: color-mix(in srgb, var(--st-soft) 55%, var(--paper-mute));
  }
  .worst[data-tone="fail"] {
    color: color-mix(in srgb, var(--st-fail) 45%, var(--paper-mute));
  }
  .cat {
    color: var(--paper-faint);
    margin-right: 0.6ch;
  }
  .at {
    font-family: var(--mono);
    font-size: 0.58rem;
    color: var(--paper-faint);
  }
</style>
