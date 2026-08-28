/* The conversation as it exists on disk, folded into the same lines the live
 * stream produces.
 *
 * Why this file has to exist at all: `--resume` does not replay anything. Probed
 * against claude 2.1.228 by resuming a two-turn session with
 * `--output-format stream-json` — the wire carried `system/init`, the new
 * prompt, and the new answer, and nothing else. The history was in the model's
 * context (it answered from it) but never on stdout. The TUI shows scrollback
 * because it reads `~/.claude/projects/<slug>/<session>.jsonl` and renders it
 * locally, so Skein reads the same file.
 *
 * The transcript vocabulary is *not* the wire vocabulary, which is the whole
 * difficulty. Counted across the 97 transcripts on this machine (~84 MB):
 *
 *   assistant 13355 · user 7624 · ai-title 1936 · last-prompt 1918 · mode 1866
 *   attachment 1552 · permission-mode 1230 · file-history-snapshot 748
 *   system/turn_duration 707 · queue-operation 595 · file-history-delta 583
 *   system/away_summary 178 · system/local_command 71 · agent-name 58
 *   frame-link 7 · custom-title 7 · system/compact_boundary 5
 *
 * Only `user`, `assistant` and `compact_boundary` say anything a reader wants;
 * the rest is editor bookkeeping the TUI does not draw either.
 *
 * Pure on purpose — no runes, no invoke — so it is testable against real
 * transcripts. The `Line` import is type-only and erased at build, so nothing
 * from a `.svelte.ts` module is pulled in at runtime. */

import { answerNote } from "./asking";
import { isRelayPrompt, relayCap } from "./relay";
import {
  SKEIN_ASK_TOOL,
  compactNote,
  compactStat,
  describeTool,
  RETRY_NOTE,
  isApiErrorMessage,
  isImageNote,
  isRetryNudge,
  isStopNote,
  localCommand,
  parseTaskNotification,
  picturesOf,
  jobNote,
  skillBody,
  textOf,
} from "./classify";
import { capInput, landed, type ToolCall } from "./toolcall";
import type { Line } from "./conversation.svelte";

/** Enough scrollback to be worth having without folding a 4 MB transcript into
 *  the DOM. The live fold keeps 300; history keeps a little more because it is
 *  the part you scroll back through rather than watch. */
export const HISTORY_MAX_LINES = 400;

export type History = {
  lines: Line[];
  /** Lines folded and then dropped off the front to respect the cap. */
  dropped: number;
  /** The reader handed us a tail rather than the whole file. */
  partial: boolean;
};

/** Drop the tail of `history` that the live stream has already shown.
 *
 * Reading now happens as the wall loads rather than on a click, which opens a
 * narrow race: wake a card while its file is still being read, and the turn you
 * just started can reach the transcript before the read does — so the same
 * prompt arrives twice, once off disk and once off the wire. The wire is the
 * authority for anything it carried, so history is cut at the first line the
 * live fold also has.
 *
 * The anchor skips `meta`, which is the register for lines *about* the
 * conversation rather than in it — `cleared`, `stopped`, a job reporting in.
 * Those are Skein's or the CLI's own words rather than anything the file
 * records, so anchoring on one finds nothing and the whole file is kept,
 * prompt and all, directly above the live copy of it. That race is not
 * hypothetical now that rousing sends while `#fillHistory` is still working
 * along the wall — and rousing's own prompt is an ordinary `you` line on both
 * sides, which is what lets this cut it. */
export function trimOverlap(history: Line[], live: Line[]): Line[] {
  const first = live.find((l) => l.kind !== "meta");
  if (!first) return history;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === first.kind && history[i].text === first.text) {
      return history.slice(0, i);
    }
  }
  return history;
}

/** Fold a transcript's NDJSON into transcript lines.
 *
 * Mirrors `Conversation.ingest` deliberately: the same line kinds, the same
 * `describeTool` prose, thinking dropped, tool results dropped. History that
 * renders differently from live text would put a visible seam in the middle of
 * one column of speech the moment a card wakes.
 *
 * One tool result is the exception, and it is the exception for exactly that
 * reason: the reply to a parked `ask_user` is the one thing a *person* said
 * into the conversation that arrives on the wire as a tool result. Dropped with
 * the rest, a restored card showed the agent asking and then acting, with the
 * decision between them nowhere on the page. */
export function foldTranscript(
  text: string,
  opts: { max?: number; partial?: boolean } = {},
): History {
  const max = opts.max ?? HISTORY_MAX_LINES;
  const lines: Line[] = [];
  const push = (kind: Line["kind"], t: string, note?: string, call?: ToolCall) => {
    if (!t.trim()) return;
    const line: Line = { kind, text: t };
    if (note) line.note = note;
    if (call) line.call = call;
    lines.push(line);
  };
  /* The call each `tool_use` id belongs to, so the `tool_result` records that
     follow can be handed back to it — the same routing the live fold does with
     `#land`, and it has to be done the same way or an opened call reads
     differently either side of a restart.
     Kept by id rather than searched for backwards the way the live path does,
     because history is folded in one pass over a whole file with no cap applied
     until the end: there is no sliced-away front for the map to go on holding,
     and the file is long enough that a backward walk per result is quadratic. */
  const calls = new Map<string, ToolCall>();
  /* What the last `compact_boundary` said the fold cost, waiting for the
     summary record it captions. The two are separate records, boundary first —
     the summary's `parentUuid` points back at it — and the cap wants both. */
  let compacted: string | null = null;
  /* Which tool_use ids were Skein's own question. Kept rather than matched on
     the result's shape, because a tool result carries no tool *name* — only the
     id of the call it answers. */
  const asked = new Set<string>();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(raw);
    } catch {
      /* A transcript is appended to while we read it, so the last line is
         routinely half-written. Not worth surfacing. */
      continue;
    }

    /* A subagent's own turns. The live card collapses these into seats and
       leaves one line behind when the arc closes, so replaying them here would
       show a card's history as mostly other agents talking. */
    if (rec.isSidechain === true) continue;

    /* `isMeta` is context Claude Code injected, not anything anybody said:
       local-command caveats, "Continue from where you left off.", image
       dimension notes, `<system-reminder>` blocks, a skill's own body. Measured
       across all 492 transcripts on this machine 2026-08-28 — 409 records, and
       every distinct shape among them was injected. The TUI does not draw them
       either.

       Live there is no such flag, which is why the four predicates in the
       `user` arm below exist: each is a member of this same family, recognised
       by its words because the field that would settle it is on one side of a
       restart only. Anything added to this family owes a predicate there *and*
       a line here, or the panel reads one way live and another way restored —
       `isImageNote` was that bug (sink 28cb1c5d).

       The exception is a skill's body, which is injected the same way and is
       the only injected thing worth reading: it is the instructions the rest of
       the card is following. Live it carries `isSynthetic` instead and the
       stream has no `isMeta` at all, so the two paths cannot share a field —
       they share `skillBody`, which asks the text, and so the same fold is
       drawn either side of a restart. */
    if (rec.isMeta === true) {
      if (rec.type !== "user") continue;
      const injected = textOf(rec.message?.content);
      /* The second injected thing worth reading, and for a different reason than
         a skill: this one *explains* what is already on the page. A malformed
         tool call is drawn above it as the agent's own prose, and without a line
         saying so the XML is unaccounted for. Live it is pushed from the `user`
         arm below, by the same predicate — see `isRetryNudge`. */
      if (isRetryNudge(injected)) {
        push("meta", RETRY_NOTE);
        continue;
      }
      const skill = skillBody(injected);
      if (!skill) continue;
      push("skill", injected, skill.name || undefined);
      continue;
    }

    switch (rec.type) {
      case "user": {
        /* Compaction rewrites the conversation as a summary addressed to the
           agent. Showing it whole drops a wall of text — 16k–25k characters in
           the ones on this machine — into the middle of the column; showing
           nothing loses the discontinuity silently. It used to be clipped to
           240 characters, which lost the discontinuity rather more politely:
           what a card used to know is worth being able to read, and a clip is
           not readable. So it is the whole thing, folded away behind the two
           numbers the boundary above it reported, and the fold is the same one
           the live stream draws — `summary` is one line kind and
           `blocksOf` folds it wherever it appears. */
        if (rec.isCompactSummary === true) {
          push("summary", textOf(rec.message?.content), compacted ?? undefined);
          compacted = null;
          break;
        }
        /* Your answer to a parked question, which is a tool result and so is
           invisible to `textOf` — deliberately, since every other tool result
           on this record type is machinery. `answerNote` is what the live path
           draws through too, so the two agree line for line. */
        if (Array.isArray(rec.message?.content)) {
          for (const block of rec.message.content) {
            if (block?.type !== "tool_result") continue;
            /* Back to the call that asked, so a restored card's folds open on
               the same two halves a live one's do. Before the ask, which is a
               *reading* of one particular result rather than the result. */
            const call = calls.get(block.tool_use_id);
            if (call) {
              /* Pictures too, by the same predicate the live fold uses — a
                 screenshot arrives as an `image` block beside no text, so read
                 for prose alone this was a call that came back empty. The two
                 folds share `picturesOf` for the reason they share `textOf`:
                 the shape is identical on the wire and on disk, and a panel that
                 showed the image only until you restarted is the divergence this
                 file exists to prevent. */
              call.result = landed(
                textOf(block.content),
                block.is_error === true,
                picturesOf(block.content),
              );
            }
            if (!asked.has(block.tool_use_id)) continue;
            const note = answerNote(textOf(block.content));
            if (note) push(note.kind, note.text);
          }
        }
        /* Two shapes, both real: the TUI writes a bare string (877 records
           here) and the SDK — which is how Skein speaks — writes a text block
           (67). `textOf` already takes both, and returns "" for the tool-result
           records that make up the bulk of the `user` type. */
        const said = textOf(rec.message?.content);
        /* Except when the CLI wrote it: a stopped turn leaves a `user` record
           carrying its own note, with no `isMeta` to sort it out by. It reads
           the same here as it does live, or the same stop would be a note on
           the wall and a sentence you appear to have typed after a restart. */
        if (isStopNote(said)) {
          push("meta", "stopped");
          break;
        }
        /* And when a background job reported in. Same shape as the stop note —
           a bare string on a `user` record with no `isMeta` to sort it out by —
           and read as speech it puts a block of `<task-notification>` XML in
           the transcript as something you appear to have typed. It has to read
           the same here as it does live, or a restart changes what a card said. */
        const job = parseTaskNotification(said);
        if (job) {
          push("meta", jobNote(job.summary));
          break;
        }
        /* An image-resize note. Every one of the 19 on this machine carries
           `isMeta`, so the block above has already dropped it and this is
           belt-and-braces — but it is the cheap kind: the live fold recognises
           this by its text because the stream has no `isMeta` to read, and one
           predicate answering on both sides is exactly what stops the two folds
           drifting. A transcript written by some other client, or a future one
           that stops setting the flag, reads the same here as it does live. */
        if (isImageNote(said)) break;
        /* And the retry nudge, for a transcript whose records carry no `isMeta`
           — one predicate answering on both sides, as above. */
        if (isRetryNudge(said)) {
          push("meta", RETRY_NOTE);
          break;
        }
        /* And when it was a local command. `/compact` alone writes two of
           these with nothing to mark them, so the transcript carried a block of
           `<command-name>` XML as something you had typed — and since
           `<command-message>` holds the bare name, a compacted card read as
           though somebody had said "compact" into it. Third of the three
           shapes this arm has to know on sight; see `localCommand`. */
        const ran = localCommand(said);
        if (ran) {
          push(ran.kind, ran.text);
          break;
        }
        /* And when another card on this wall said it. Last of the shapes this
           arm knows, and the only one where getting it wrong puts *another
           agent's* instructions in your mouth — see `relay.ts`. Both folds go
           through the same two functions, which is the seam this file exists to
           avoid. */
        if (isRelayPrompt(said)) {
          push("relay", said, relayCap(said));
          break;
        }
        push("you", said);
        break;
      }

      case "assistant": {
        /* An API refusal, which the CLI wraps as an assistant message and is
           not the agent speaking. Live this is dropped, because the `result`
           behind it carries the same sentence as the turn's error line and
           drawing both put two identical lines under one refusal.

           **Here it is drawn instead, and the asymmetry is the point.** A
           session file holds no `result` records at all — this fold has never
           had one to read — so dropping it the way the live fold does would
           take the refusal out of a restored transcript altogether. What has to
           agree across a restart is the *reading*, not the record: both sides
           say the CLI refused the turn, neither says the agent announced it.
           So the sentence keeps its `error` register, which is the kind live
           pushes it under from `result`.

           445 of these on this machine — 170 at 429, 68 at 529 — so before this
           every card that had ever hit a limit came back with "You've hit your
           session limit · resets 2:40pm" in its own voice. Sink 999cadb7. */
        if (isApiErrorMessage(rec)) {
          push("error", textOf(rec.message?.content));
          break;
        }
        for (const block of rec.message?.content ?? []) {
          if (block?.type === "text") push("text", block.text ?? "");
          else if (block?.type === "tool_use") {
            if (block.name === SKEIN_ASK_TOOL && block.id) asked.add(block.id);
            const call: ToolCall = {
              ...(block.id ? { id: block.id } : {}),
              name: block.name,
              input: capInput(block.input),
            };
            push("tool", describeTool(block.name, block.input), undefined, call);
            /* Registered only if the line was actually pushed — `push` drops an
               empty one, and a call registered against a line nobody can see is
               a result with nowhere to land. `describeTool` never returns an
               empty string, so this is a guard rather than a case. */
            if (block.id && lines[lines.length - 1]?.call === call) {
              calls.set(block.id, call);
            }
          }
          /* thinking blocks are dropped, as they are live */
        }
        break;
      }

      case "system": {
        if (rec.subtype !== "compact_boundary") break;
        /* Held rather than pushed. The numbers are the summary's caption, and
           the summary is the very next record — a note saying the context was
           compacted sitting directly above a fold saying the same thing is one
           sentence printed twice. If no summary follows, it is pushed on its
           own below, which is exactly the old behaviour for exactly the case
           that still needs it. */
        const stat = compactStat(rec);
        if (stat) compacted = compactNote(stat);
        break;
      }

      default:
        break;
    }
  }

  /* A boundary whose summary never arrived — the file ends on the fold, or the
     producer wrote one without the other. The discontinuity is real either way
     and has to be said; at the foot of the column is also where it happened. */
  if (compacted) push("meta", compacted);

  const dropped = Math.max(0, lines.length - max);
  return {
    lines: dropped ? lines.slice(-max) : lines,
    dropped,
    partial: opts.partial ?? false,
  };
}
