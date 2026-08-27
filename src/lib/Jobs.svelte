<script lang="ts">
  /* What a card has running in the background, and its output as it arrives.
   *
   * Sink 80e0a4ad, in the user's words: "I can't find a way to check the logs of
   * subprocesses of a card — for example a dev server, a long-running task. I
   * would like to be able to display the log directly in the transcript."
   *
   * ### Why a drawer at the foot of the panel and not a line in the column
   *
   * The obvious place is the tool call that started it — the `Bash` line is
   * already in the transcript, already openable, and already knows its own
   * arguments. It is the wrong place for two reasons that only show up once the
   * thing is running. A dev server is started **once, hours ago**, so its call
   * is a long way up a scrollback you would have to go and find; and the panel
   * follows its own tail, so a pane growing in the middle of the column either
   * fights the follow or scrolls away from under you. What you want from a
   * running process is the same thing you want from a card: *where is it now*,
   * reachable without hunting.
   *
   * So it sits below the column and above the footer, which is the one strip of
   * the panel that does not move. It is absent entirely when the card holds no
   * background work, which is most cards most of the time — nothing is added to
   * a panel that has nothing to say.
   *
   * ### The poll, which is the fourth in the app and owes an argument
   *
   * `CLAUDE.md` is explicit: three places in Volery go and look rather than fold
   * an event, all three because the thing being watched emits nothing, and
   * "anything proposing to be the fourth owes one of these shapes and the same
   * argument". A file being appended to by another process is exactly that case
   * — no event exists anywhere for it — so here is the argument.
   *
   * **It is not a fourth clock.** The prescription in that section is to find an
   * event that already exists near the thing and fold *that*; the wall's
   * one-second tick is one, it is the only wake-up on an idle machine already,
   * and a log read once a second is precisely the cadence a person reading one
   * wants. So this adds no timer, no lifecycle and nothing to release — it reads
   * `clock.t` and is therefore bounded by something that already exists.
   *
   * **And what is left over is bounded three ways**, each of which can switch it
   * off entirely: only while a job is *expanded*, so it takes somebody's
   * deliberate act to start at all; only while `watching`, which is window
   * focus, so a wall left up overnight reads nothing; and never after the job
   * settles, since `conv.jobs` drops it and the drawer goes with it. The
   * strongest bound of the four polls in this app, and the only one that
   * requires an eye on it to exist.
   *
   * Each read is incremental — from where the last one stopped — so a 40 MB
   * dev-server log costs one read on opening and a few hundred bytes a second
   * afterwards. `joblog.rs` owns the seek, `jobs.ts` owns the fold, and both are
   * tested; this file is the drawing and the effect. */

  import { untrack as untracked } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import { clock, type Conversation, type Job } from "./conversation.svelte";
  import { stickToTail } from "./follow";
  import {
    NOTHING_HELD,
    READ_BYTES,
    UNREAD,
    absence,
    drawerCap,
    fold,
    jobCap,
    missing,
    rowsOf,
    size,
    type Chunk,
    type Held,
  } from "./jobs";

  let {
    conv,
    watching = true,
  }: {
    conv: Conversation;
    /** Whether this panel can actually be being read — window focus, passed
     *  down from the panel for the reason the panel takes it rather than
     *  subscribing: `attention.svelte.ts` already owns it and a second
     *  subscription is a second thing to release. It is the bound that stops an
     *  unattended wall reading a file all night. */
    watching?: boolean;
  } = $props();

  /** Which job is expanded, by tool id. One at a time: two logs in a strip this
   *  size would give each three lines, and the transcript is what the panel is
   *  for. Null is closed, which is how it starts — a drawer that opened itself
   *  would take the column's room on every card that ever ran a build. */
  let showing = $state<string | null>(null);

  /** What each expanded job is holding, by tool id. Kept across a close and
   *  re-open of the same job so that folding it away and back does not re-read a
   *  40 MB file — but dropped when the *card* changes, below. */
  let held = $state<Record<string, Held>>({});
  let fault = $state<string | null>(null);

  /** Paths for the kinds whose receipt named none.
   *
   *  Only `Bash` names a file; a `Monitor`, an `Agent` and a `Workflow` carry
   *  none and theirs is derived at the far end from the session and the task id
   *  — and then *existence-checked*, which is the part that cannot be done here.
   *  `store::pending_jobs` already does both, so it is asked rather than the
   *  derivation being written a second time in TypeScript.
   *
   *  **Not named `derived`**, which is what it was called for ten minutes: a
   *  local of that name shadows the rune, so every `$derived` in the file was
   *  parsed as `$` applied to this variable and read as a store subscription.
   *  The error names stores and says nothing about runes. */
  let paths = $state<Record<string, string>>({});

  /** A read is in flight. Not `$state` — nothing draws it, and making it
   *  reactive would put the effect back in its own dependency graph. */
  let reading = false;

  /* A different card is a different drawer. Everything held is about the card
     that was here a moment ago, and a pane that kept its lines across the change
     would be showing one card's output under another's name. */
  $effect(() => {
    conv.id;
    showing = null;
    held = {};
    paths = {};
    fault = null;
  });

  const jobs = $derived(conv.jobs);

  /** Where this job's output is, or null if there is nowhere to look. */
  function pathOf(j: Job): string | null {
    return j.outputPath ?? paths[j.toolId] ?? null;
  }

  /* Ask once per change in what the card is holding, and only while the drawer
     is open on something — a card that never opens this never makes the call. */
  $effect(() => {
    if (!showing) return;
    const want = jobs.filter((j) => !j.outputPath).map((j) => j.toolId);
    if (!want.length) return;
    if (want.every((id) => id in paths)) return;
    void invoke<{ toolId: string; outputPath: string | null }[]>("pending_jobs", {
      conversationId: conv.id,
    })
      .then((rows) => {
        const next = { ...paths };
        /* An id with no path still gets an entry — as the empty string, which
           `pathOf` reads as nothing. Without it the ask repeats every tick for a
           job whose file genuinely is not there. */
        for (const id of want) next[id] = "";
        for (const r of rows) if (r.outputPath) next[r.toolId] = r.outputPath;
        paths = next;
      })
      .catch(() => {});
  });

  /* The read itself. `clock.t` is the dependency and the whole of the schedule;
     everything else here is a gate on it. */
  $effect(() => {
    clock.t;
    if (!watching || !showing) return;
    const job = untracked(() => jobs.find((j) => j.toolId === showing));
    if (!job) return;
    const path = untracked(() => pathOf(job));
    if (!path) return;
    if (reading) return;

    const id = job.toolId;
    const from = untracked(() => held[id]?.next ?? UNREAD);
    reading = true;
    void invoke<Chunk & { size: number }>("job_output", { path, from, cap: READ_BYTES })
      .then((got) => {
        fault = null;
        /* Nothing appended is the answer nearly every tick, and it must cost
           nothing — a fold of an empty chunk would still allocate a new `Held`
           and invalidate every reader of it once a second. */
        if (!got.text && (held[id]?.next ?? UNREAD) === got.next) return;
        held = { ...held, [id]: fold(held[id] ?? NOTHING_HELD, got) };
      })
      .catch((e) => {
        fault = String(e);
      })
      .finally(() => {
        reading = false;
      });
  });

  function toggle(id: string) {
    showing = showing === id ? null : id;
  }

  const shown = $derived(showing ? jobs.find((j) => j.toolId === showing) : undefined);
  const shownHeld = $derived(showing ? held[showing] : undefined);
  const rows = $derived(shownHeld ? rowsOf(shownHeld) : []);
  const gap = $derived(shownHeld ? missing(shownHeld) : null);

  /** Why the pane is empty, when it is. Four different things to say — see
   *  `absence`, where the distinction is argued. */
  const why = $derived.by(() => {
    if (!shown) return null;
    if (rows.length) return null;
    if (fault) return absence("unreadable");
    if (!pathOf(shown)) return absence("nofile");
    if (!shownHeld) return absence("waiting");
    return absence("empty");
  });
</script>

{#if jobs.length}
  <!-- Below the column and above the footer: the one strip of the panel that
       does not move while you read. -->
  <section
    class="jobs"
    class:open={!!showing}
    aria-label="background work"
    title={drawerCap(jobs)}
  >
    <ul class="list">
      {#each jobs as j (j.toolId)}
        <li>
          <button
            type="button"
            class="cap"
            aria-expanded={showing === j.toolId ? "true" : "false"}
            onclick={() => toggle(j.toolId)}
            title={showing === j.toolId ? "fold its output away" : "what it is printing"}
          >
            <span class="mark" aria-hidden="true">{showing === j.toolId ? "▾" : "▸"}</span>
            <span class="what">{jobCap(j, clock.t)}</span>
          </button>
        </li>
      {/each}
    </ul>

    {#if shown}
      <!-- Follows its own tail like every other scroller in this app that gains
           content at the end, and by the same attachment rather than a fourth
           hand-rolled version of the judgement. Near the bottom means stuck to
           it; scrolled back means nothing moves. -->
      <div class="tail" {@attach stickToTail}>
        {#if why}
          <p class="quiet">{why}</p>
        {:else}
          {#if gap}<p class="gap">{gap}</p>{/if}
          {#each rows as r, i (i)}
            <div class="log" class:warn={r.tone === "warn"} class:fail={r.tone === "fail"}
              >{#each parseAnsi(r.text) as sp}<span
                  style:color={sp.color === null ? null : ANSI_PALETTE[sp.color]}
                  style:font-weight={sp.bold ? "600" : null}
                  style:opacity={sp.dim ? 0.6 : null}>{sp.text}</span
                >{/each}</div>
          {/each}
        {/if}
      </div>
      <!-- Said out loud rather than left to be inferred: how big the thing being
           tailed has got, and that what is on screen is the end of it. A cap
           nobody states reads as having shown everything. -->
      <p class="foot">
        {rows.length} line{rows.length === 1 ? "" : "s"} shown{shownHeld
          ? ` · ${size(shownHeld.next < 0 ? 0 : shownHeld.next)} in`
          : ""}
        {#if fault}<span class="fault"> · {fault}</span>{/if}
      </p>
    {/if}
  </section>
{/if}

<style>
  .jobs {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--edge);
    padding-top: 0.35rem;
    /* Opaque like everything else on this wall, and the same well the panel is
       drawn on — this is part of the panel rather than a thing standing over it. */
    background: var(--well);
  }
  /* Only when something is expanded does it take real room, and even then a
     bounded share: the transcript is what the panel is for. */
  .jobs.open {
    max-height: 40%;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    flex: 0 0 auto;
  }

  .cap {
    display: flex;
    align-items: baseline;
    gap: 0.5ch;
    width: 100%;
    border: none;
    background: none;
    padding: 0.12rem 0.1rem;
    color: var(--paper-faint);
    font: inherit;
    font-size: 0.68rem;
    text-align: left;
    cursor: pointer;
  }
  .cap:hover,
  .cap:focus-visible {
    color: var(--paper);
  }
  .mark {
    flex: 0 0 auto;
    font-size: 0.6rem;
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tail {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0.2rem 0 0.2rem 1.4ch;
  }

  .log {
    font-family: var(--mono);
    font-size: 0.66rem;
    line-height: 1.35;
    color: var(--paper-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Status colour, which on this wall is the only colour there is. Amber for a
     warning and rust for a failure, the same two the cards use. */
  .log.warn {
    color: var(--amber, var(--paper));
  }
  .log.fail {
    color: var(--rust, var(--paper));
  }

  .quiet,
  .gap,
  .foot {
    margin: 0;
    padding: 0.15rem 0.1rem;
    font-size: 0.64rem;
    color: var(--paper-mute);
  }
  .gap {
    color: var(--paper-faint);
  }
  .foot {
    flex: 0 0 auto;
    color: var(--paper-faint);
  }
  .fault {
    color: var(--rust, var(--paper));
  }
</style>
