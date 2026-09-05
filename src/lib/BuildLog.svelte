<script lang="ts">
  /* A build's output, on the wall, while it runs and after it has finished.
   *
   * The chip on a territory's edge already says how a build went, in one word
   * and one colour. What it cannot say is *why*, and the log that would has
   * been a panel and two clicks away — which is two clicks you do not spend
   * while a compile is running, so the wall's answer to "is it stuck?" has been
   * a percentage with no words behind it. This is the words.
   *
   * Two readings, and the small one is the point. `lines` is the tail as
   * printed. `progress` is the bar, the last note and the elapsed — which is
   * what a build log shrunk to the size of a card can still say, where four
   * monospace lines of `cl.exe` invocations say nothing at all. Same bargain the
   * server log's `latest` strikes, one subject over.
   *
   * The frame, the button and the sentence-instead-of-a-reading are `LogFace`'s;
   * the lines are `LogTail`'s. See `buildlog.ts` for why the subject is a
   * project rather than a run, and why a *failed* build is not a down state. */

  import {
    absence,
    isLive,
    keeping,
    lastRun,
    NARROWING,
    problems,
    pulseOf,
    rowsOf,
    standing,
    type Build,
  } from "./buildlog";
  import { clock } from "./conversation.svelte";
  import { emptyBecause, FOLLOW, linesFor, subjectOf, tail } from "./logface";
  import LogFace from "./LogFace.svelte";
  import LogTail from "./LogTail.svelte";
  import { span } from "./timing";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    builds,
    onrun,
  }: {
    widget: Widget;
    /** Every project on the wall and whatever it last ran, flattened in
     *  `App.svelte` off `Actions`. Plain data rather than the `Run`s
     *  themselves — those are rune classes, and nothing between here and there
     *  has any business holding one. */
    builds: Build[];
    /** Press an action in a project. Routed out rather than invoked here: the
     *  face knows what it is looking at and `Actions` knows what running one
     *  means — including the cancel-on-second-press, the fault bar and the
     *  poll kick, none of which a widget should reimplement. */
    onrun: (root: string, action: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const showing = $derived(textOf(widget, "showing", "all"));
  /* `lastRun` is the fourth argument and the whole of sink f2cce1c8: without it
     a follower drops the build it was watching the instant the build finishes,
     and lands on whichever project sorts first. */
  const subject = $derived(
    subjectOf(textOf(widget, "project", FOLLOW), builds, isLive, lastRun),
  );
  const build = $derived(subject.it);
  const because = $derived("because" in subject ? subject.because : null);
  const rows = $derived(linesFor(widget.h));

  const stand = $derived(build ? standing(build) : null);
  const cut = $derived(
    build ? tail(build.log, keeping(showing), rows) : { lines: [], hidden: 0 },
  );
  const counts = $derived(build ? problems(build.log) : { errors: 0, warnings: 0 });

  /* The wall's own second, which is the only clock a widget may keep — see the
     note on `clock` in `conversation.svelte.ts`. A finished run counts to where
     it stopped rather than going on climbing. */
  const secs = $derived(
    !build?.startedAt
      ? null
      : Math.max(0, ((build.endedAt ?? clock.t) - build.startedAt) / 1000),
  );

  const note = $derived(
    !build
      ? absence(because ?? "none")
      : variant === "progress" || cut.lines.length
        ? null
        : (emptyBecause(cut.hidden, NARROWING[showing] ?? "left") ?? "nothing yet"),
  );

  /* What a finished run is, in one word. `ok` says nothing where the dot has
     already said it in celadon-adjacent grey — a build that worked is the
     uninteresting case and does not need a label as well. */
  const verdict = $derived(
    build?.state === "failed"
      ? "failed"
      : build?.state === "cancelled"
        ? "stopped"
        : null,
  );
</script>

<LogFace
  pulse={pulseOf(build?.state ?? "idle")}
  name={build?.action ?? build?.project ?? "no build"}
  sub={build && build.action ? build.project : ""}
  title={build ? `${build.project} · ${build.action ?? "nothing run yet"}` : undefined}
  down={build && stand
    ? {
        word: stand.word,
        verb: stand.verb,
        press: () => build.again && onrun(build.id, build.again.id),
      }
    : null}
  {note}
>
  {#snippet chips()}
    {#if secs !== null}
      <span class="stat">{span(secs)}</span>
    {/if}
    {#if verdict}
      <span class="stat bad">{verdict}</span>
    {/if}
    <!-- Counted over the whole log rather than the drawn tail, which is what
         makes it worth having: "4 errors" on a pane showing one of them is the
         number that tells you to make the widget bigger. -->
    {#if counts.errors}
      <span class="stat bad">{counts.errors} err</span>
    {/if}
    {#if counts.warnings}
      <span class="stat warn">{counts.warnings} warn</span>
    {/if}
  {/snippet}

  {#if variant === "progress"}
    <div class="gauge">
      <!-- A bar only where something genuinely counted to a total: UBT's
           `@progress`, ninja's `[12/345]`, the cook's own counter. For cargo and
           vite there is no total, and a bar that guessed one would be a widget
           inventing a number. The note is the reading in that case, and it is
           usually enough — "compiling serde" is the difference between a build
           working and a build stuck. -->
      {#if build?.pct !== null && build?.pct !== undefined}
        <div class="bar"><span class="fill" style:width="{build.pct}%"></span></div>
        <span class="pct">{Math.round(build.pct)}%</span>
      {/if}
      <p class="said">{build?.note ?? (build?.state === "running" ? "starting…" : "nothing to report")}</p>
    </div>
  {:else}
    <!-- `tint` on, where the server log leaves it off. The signal here is the
         program saying the word "error" with a colon after it, about itself —
         reading that back is not an opinion, and a line that arrived with its
         own colour keeps it. See `rowsOf` in `buildlog.ts`. -->
    <LogTail rows={rowsOf(cut.lines)} tint />
  {/if}
</LogFace>

<style>
  .stat {
    flex: 0 0 auto;
    color: var(--paper-mute);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    font-size: 0.6rem;
  }
  .stat.bad {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--st-fail);
  }
  .stat.warn {
    border-color: color-mix(in srgb, var(--st-soft) 50%, var(--edge));
    color: color-mix(in srgb, var(--st-soft) 80%, var(--paper-mute));
  }

  .gauge {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.2rem 0.3rem 0;
    overflow: hidden;
  }
  .bar {
    width: 100%;
    height: 4px;
    border-radius: 999px;
    background: var(--surface);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--st-work);
    /* Eased, because a `@progress` marker arrives in jumps of several percent
       and a bar that teleported would read as a glitch rather than as
       progress. */
    transition: width 0.3s ease;
  }
  .pct {
    font-size: 0.72rem;
    color: var(--paper-dim);
    font-variant-numeric: tabular-nums;
  }
  /* The last thing it said, which on a face this small is the whole reading. Two
     lines rather than one: a compiler's note is often a path, and cutting
     `Compile PlatformMovementComponent.cpp` at the width of a card leaves the
     word `Compile`. */
  .said {
    margin: 0;
    max-width: 100%;
    font-family: var(--mono);
    font-size: 0.62rem;
    line-height: 1.35;
    color: var(--paper-mute);
    text-align: center;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
</style>
