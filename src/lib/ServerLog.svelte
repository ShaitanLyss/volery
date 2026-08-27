<script lang="ts">
  /* A dev server's output, on the wall it is being written for.
   *
   * The panel already shows every group's log, folded away behind a `log`
   * button per group. What a widget adds is that you did not have to ask: the
   * thing you are waiting for — the recompile, the port binding, the stack
   * trace — is on the wall beside the card whose agent caused it.
   *
   * The frame, the start button and the sentence-instead-of-a-reading are
   * `LogFace`'s; the lines are `LogTail`'s. What is here is the two things only
   * a dev server group has: the per-server pills in the header, and the
   * last-thing-each-said reading, which is what a log dropped to the size of a
   * card can still say when a tail of four monospace lines cannot.
   *
   * It reads a crash as down — `running` is a flag the wall sets when it asks
   * for a start, so a server that exited on its own is `running: true` with an
   * `exited` health. See `standing` in `serverlog.ts`.
   *
   * The colour in the lines is the server's own — `ansi.ts` renders the sixteen
   * it is sent, which the pipes keep by asking rather than by being a terminal
   * (see `.claude/rules/servers.md`). That is the one place decorative-looking
   * colour on this wall is not ours to reserve: it is what the program said. */

  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import { emptyBecause, FOLLOW, linesFor, subjectOf, tail } from "./logface";
  import LogFace from "./LogFace.svelte";
  import LogTail from "./LogTail.svelte";
  import {
    absence,
    isLive,
    keeping,
    latest,
    nameOf,
    NARROWING,
    pulseOf,
    rowsOf,
    standing,
    type Reading,
  } from "./serverlog";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    groups,
    onstart,
  }: {
    widget: Widget;
    /** Every dev server group on the wall, flattened in `App.svelte` beside the
     *  `chipsFor` that already does this for a territory's chips. Plain data
     *  rather than the `GroupRuntime`s themselves, so nothing between here and
     *  there has to hold a rune class. */
    groups: Reading[];
    /** Bring one up. Routed out rather than invoked here, the way every other
     *  gesture a widget offers is — the face knows what it is looking at and
     *  `Skein` knows what starting means. */
    onstart: (groupId: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const showing = $derived(textOf(widget, "showing", "all"));
  const subject = $derived(subjectOf(textOf(widget, "group", FOLLOW), groups, isLive));
  const group = $derived(subject.it);
  /* Read off as its own value rather than narrowed at the markup: `group` is a
     separate `$derived`, so testing it tells the compiler nothing about which
     arm of `subjectOf`'s union `subject` is. */
  const because = $derived("because" in subject ? subject.because : null);
  const rows = $derived(linesFor(widget.h));

  /* Named `stand` rather than `state`, which in a file full of runes reads as
     something it is not. */
  const stand = $derived(group ? standing(group) : null);
  const cut = $derived(
    group ? tail(group.log, keeping(showing), rows) : { lines: [], hidden: 0 },
  );
  const lasts = $derived(group ? latest(group.servers, group.log, showing) : []);

  /* One sentence instead of a reading, in order of what it is most useful to be
     told: no subject at all, then a filter that dropped everything, then a group
     that has genuinely not said anything yet. The `latest` reading needs none of
     it — every server gets a row there, and a silent one says so in place. */
  const note = $derived(
    !group
      ? absence(because ?? "none")
      : variant === "latest" || cut.lines.length
        ? null
        : (emptyBecause(cut.hidden, NARROWING[showing] ?? "left") ?? "nothing yet"),
  );
</script>

<LogFace
  pulse={group ? pulseOf(group.overall) : "idle"}
  name={group?.label ?? "no server"}
  sub={group?.project ?? ""}
  title={group ? nameOf(group) : undefined}
  down={group && stand?.down
    ? { word: stand.word ?? "down", verb: stand.verb, press: () => onstart(group.id) }
    : null}
  {note}
>
  {#snippet chips()}
    {#if group}
      {#each group.servers as s (s.label)}
        <span class="svc" data-h={group.health[s.label] ?? "idle"}>
          {s.label}{#if s.port}<em>:{s.port}</em>{/if}
        </span>
      {/each}
    {/if}
  {/snippet}

  {#if variant === "latest"}
    <!-- One line each rather than a scroll: what a log dropped to the size of a
         card can still say. The silent server gets a row too — it is the
         interesting one.

         `data-text` for the same reason `LogTail`'s `pre` carries it: this is
         the other shape the same lines take, and a widget where the tail could
         be copied and the last-line reading could not would be one boundary the
         eye cannot see. -->
    <ul class="lasts" data-text>
      {#each lasts as l (l.label)}
        <li>
          <span class="src">{l.label}</span>
          {#if l.line === null}
            <span class="none">nothing yet</span>
          {:else}
            <span class="said" class:err={l.stderr}>
              {#each parseAnsi(l.line) as s}<span
                  style:color={s.color === null ? null : ANSI_PALETTE[s.color]}
                  style:font-weight={s.bold ? "600" : null}
                  style:opacity={s.dim ? 0.6 : null}>{s.text}</span
                >{/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <LogTail rows={rowsOf(cut.lines)} />
  {/if}
</LogFace>

<style>
  /* The same reading the panel's chips carry, so a server that is up looks the
     same in both places. Colour is status here and nowhere else on this face. */
  .svc {
    flex: 0 0 auto;
    color: var(--paper-mute);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    font-size: 0.6rem;
  }
  .svc em {
    font-style: normal;
    color: var(--paper-faint);
  }
  .svc[data-h="up"] {
    border-color: color-mix(in srgb, var(--st-work) 50%, var(--edge));
    color: var(--paper-dim);
  }
  .svc[data-h="exited"] {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--st-fail);
  }

  .lasts {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.2rem 0.2rem 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    overflow: hidden;
    /* The half of `data-text` that lives in CSS — see `LogTail`'s `.log`, where
       the whole of the reasoning is. */
    user-select: text;
    cursor: text;
  }
  .lasts li {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.68rem;
  }
  .lasts .src {
    flex: 0 0 auto;
    font-size: 0.6rem;
    color: var(--paper-faint);
  }
  .said {
    flex: 1;
    min-width: 0;
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .said.err {
    color: color-mix(in srgb, var(--st-fail) 40%, var(--paper-dim));
  }

  /* The same absence said inline, on a row that is already a flex line. */
  .none {
    color: var(--paper-faint);
  }
</style>
