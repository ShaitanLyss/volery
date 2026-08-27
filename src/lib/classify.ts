/* Pure classification. No runes, no I/O — so it can be tested against real
 * `claude` output without a browser or a Svelte compiler in the way.
 *
 * This file is also where nearly all Claude-specific knowledge lives (tool
 * names, model ids, event vocabulary). If a second agent backend ever matters,
 * this is the file that gets an interface.
 *
 * The one import is `said`, which is a span in words — "12 hours", "4 minutes".
 * `wake_me` carries a number of seconds and the activity line is prose, so the
 * choice is this import or a second copy of the same arithmetic. */
import { said } from "./timing";

/** How a turn ended. Immutable once decided — this is a fact about the turn. */
export type Ending =
  | "ok" // finished clean, nothing pending
  | "question" // last line was a question left in prose
  | "asked" // a structured ask via tool (see ASK_TOOLS)
  | "stopped" // you stopped it mid-turn (see `wasStopped`)
  | "error"; // crashed, errored, rate-limited

/** What the card looks like right now. Urgency, not history. */
export type Tier =
  | "work" // celadon — streaming, alive
  | "ask" // amber   — full bloom, wants you now
  | "soft" // amber ½ — warming, has been waiting
  | "rest" // muted   — finished clean, recently
  | "fail"; // rust    — broken

/* ── Urgency ──────────────────────────────────────────────────────────────
 *
 * `AskUserQuestion` and `ExitPlanMode` do NOT exist in headless mode — probed
 * against claude 2.1.227: they are absent from the session tool list, and
 * `--tools` silently drops them when named explicitly. So the "asked" ending is
 * currently unreachable, and amber would be a colour nothing could ever use.
 *
 * Instead, amber means *this has been waiting too long*. Urgency is one hue
 * moving in intensity, and what it measures is neglect — which is the actual
 * failure mode: an agent that finished four minutes ago and went quiet.
 *
 * A question left hanging escalates faster than a clean finish, because
 * somebody is explicitly waiting on an answer. */
export const QUESTION_BLOOM_S = 120; // an unanswered question: loud after 2m
export const CLEAN_WARM_S = 300; // a clean finish: warms after 5m
export const CLEAN_BLOOM_S = 900; // ...and is loud after 15m

/** @param aside this card has been set aside — see `Conversation.aside`.
 *
 *  Urgency here *is* the clock: what warms a card is nothing but how long you
 *  have left it. So a card you put by deliberately would warm to amber for
 *  doing exactly what you asked of it, and then take its turn in the waiting
 *  cycle — which is the one place on this wall where being ignored is the
 *  point. Setting a card aside says stop counting; this is where the counting
 *  stops, so that everything reading the tier — the cycle, the dock's count,
 *  the peek, the card's own colour — stops together.
 *
 *  It is checked *after* the two endings that are events rather than neglect.
 *  A crash and a structured ask are things that happened, not time passing, and
 *  a card that broke in the middle of the turn you walked away from still has
 *  to be able to say so. In practice a card set aside is a card with no process
 *  doing anything, so those arms are about the one you set aside mid-turn. */
export function urgencyFor(
  ending: Ending,
  idleSeconds: number,
  aside = false,
): Tier {
  if (ending === "error") return "fail";
  if (ending === "asked") return "ask";
  if (aside) return "rest";
  if (ending === "question") {
    return idleSeconds >= QUESTION_BLOOM_S ? "ask" : "soft";
  }
  /* `stopped` falls through here with `ok`, deliberately. Nothing went wrong —
     you ended the turn yourself — so it is not rust and not a question anybody
     is waiting on. But a card you stopped is exactly as easy to walk away
     from as one that finished, so it warms on the same clock. */
  if (idleSeconds >= CLEAN_BLOOM_S) return "ask";
  if (idleSeconds >= CLEAN_WARM_S) return "soft";
  return "rest";
}

/** Tools that would constitute a real, structured ask. Retained deliberately:
 *  the detection costs nothing and starts working the day they become
 *  available in headless mode. */
export const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Skein's own question, as the CLI names an MCP tool: `mcp__<server>__<tool>`,
 *  and the server key is `skein` in the `--mcp-config` `supervisor.rs` passes.
 *
 *  Deliberately **not** in `ASK_TOOLS`. That set decides the `asked` ending,
 *  which is for a turn that stopped on a question — and this one does the
 *  opposite: it parks mid-turn and resumes in place the moment you reply, so a
 *  card whose question you answered would settle amber and stay there. What the
 *  name is for is naming the call in the transcript, and finding the reply the
 *  CLI recorded against it. */
export const SKEIN_ASK_TOOL = "mcp__skein__ask_user";

/** The other two tools Skein hosts: the roster, and a message to another card.
 *
 *  Deliberately not in `ASK_TOOLS` either, and for a plainer reason than
 *  `SKEIN_ASK_TOOL` is not — neither of these stops anything. `send` returns a
 *  receipt in milliseconds and the turn carries straight on; the card that is
 *  about to spend a turn is the one at the other end. See
 *  `.claude/rules/relay.md`. */
export const SKEIN_LIST_TOOL = "mcp__skein__list";
export const SKEIN_SEND_TOOL = "mcp__skein__send";

/** And the billboard's three. Same argument again: none of them stops a turn.
 *  See `.claude/rules/relay.md`. */
export const SKEIN_BOARD_TOOL = "mcp__skein__board";
export const SKEIN_POST_TOOL = "mcp__skein__post";
export const SKEIN_UNPOST_TOOL = "mcp__skein__unpost";

/** The rest of what Skein hosts, and the reason the whole vocabulary is written
 *  out here rather than only the interesting half.
 *
 *  Six of these were named and thirteen were not, and an unnamed one does not
 *  degrade — it falls to `default` and prints `mcp__skein__recall` on the card,
 *  in a panel whose entire register is lowercase prose. Which is what it did:
 *  an agent reading another card's words, or putting an image on the wall, drew
 *  the raw wire name at the exact moment you would want to know what it had
 *  done. Naming six of nineteen is worse than naming none, because the six make
 *  the other thirteen read as a fault rather than as a convention.
 *
 *  So: every tool the Rust side registers has a case below, and a new one owes
 *  a line here. `src-tauri/src/*.rs` is the list — each server declares its
 *  names as `pub const *_TOOL`. */
export const SKEIN_RECALL_TOOL = "mcp__skein__recall";
export const SKEIN_TOUCHED_TOOL = "mcp__skein__touched";
export const SKEIN_PIN_TOOL = "mcp__skein__pin";
export const SKEIN_PINNED_TOOL = "mcp__skein__pinned";
export const SKEIN_REPIN_TOOL = "mcp__skein__repin";
export const SKEIN_DROP_TOOL = "mcp__skein__drop";
export const SKEIN_SINK_TOOL = "mcp__skein__sink";
export const SKEIN_TAKE_TOOL = "mcp__skein__take";
export const SKEIN_DONE_TOOL = "mcp__skein__done";
export const SKEIN_SPAWN_TOOL = "mcp__skein__spawn";
export const SKEIN_CLOSE_TOOL = "mcp__skein__close";
export const SKEIN_WAKE_TOOL = "mcp__skein__wake_me";
export const SKEIN_ALLOWANCE_TOOL = "mcp__skein__allowance";

/** And the dev servers, which a card can now read and drive.
 *
 *  The first tools on this server that change what is *running on the machine*
 *  rather than what is written down about it, and the phrasings below are the
 *  only place the wall says which of the three a card reached for. That matters
 *  more here than for the billboard: "read the dev server log" and "restarted
 *  the dev servers" are a glance apart in the transcript and are not remotely
 *  the same event, and the second is one you would want to have seen without
 *  opening the call.
 *
 *  Same rule as the block above — every tool the Rust side registers owes a line
 *  here, or it falls to `default` and prints `mcp__skein__server_log` on a card
 *  whose entire register is lowercase prose. `src-tauri/src/servers.rs` declares
 *  these three as `pub const *_TOOL`. */
export const SKEIN_SERVERS_TOOL = "mcp__skein__servers";
export const SKEIN_SERVER_LOG_TOOL = "mcp__skein__server_log";
export const SKEIN_SERVER_TOOL = "mcp__skein__server";

/** And the forge, which a card can now read — and write one thing to.
 *
 *  The two readings are ordinary. `pull_request` is the first tool on this
 *  server whose effect is **outside this machine**: it opens or edits a pull
 *  request on somebody's Azure DevOps organisation, under the user's own name.
 *  That is why it asks first (`smith::pull_request` parks a real `ask_user`
 *  question, the way `close` does), and it is why the line below says *wants
 *  to*: at the moment the call lands nothing has happened yet, and a card
 *  reading "opened a pull request" while a question about it was still up would
 *  be the transcript claiming an outcome it has not got.
 *
 *  Deliberately not in `ASK_TOOLS`, for exactly the reason `SKEIN_ASK_TOOL` is
 *  not: it parks and resumes in place, so a turn whose question was answered
 *  would otherwise settle `asked` and stay amber.
 *
 *  Same rule as the two blocks above — every tool the Rust side registers owes a
 *  line here. `src-tauri/src/smith.rs` declares these three as
 *  `pub const *_TOOL`, and `.claude/rules/azdo.md` has the reasoning. */
export const SKEIN_PIPELINES_TOOL = "mcp__skein__pipelines";
export const SKEIN_REVIEWS_TOOL = "mcp__skein__reviews";
export const SKEIN_PULL_REQUEST_TOOL = "mcp__skein__pull_request";

/** And the music, which a card may *choose* and deliberately cannot drive.
 *
 *  `records` is a catalogue search and changes nothing anybody can hear.
 *  `put_on` is the one tool in the app that alters what the user is listening
 *  to, and it is bounded rather than trusted: it refuses outright while
 *  something is playing, because taking a track off is the user's to do. There
 *  is no pause, stop, skip or volume tool on this server at all — that absence
 *  is the user's own scoping and not an omission, so nothing here should grow a
 *  line for one.
 *
 *  The tense below matters for the same reason it does for `pull_request`:
 *  `put_on` is refused whenever the wall is already playing, so the card says
 *  what was *chosen* rather than claiming it played. The tool's own answer is
 *  where the outcome is.
 *
 *  Same rule as the blocks above — every tool the Rust side registers owes a
 *  line here. `src-tauri/src/selector.rs` declares these two as
 *  `pub const *_TOOL`, and `.claude/rules/spotify.md` has the reasoning. */
export const SKEIN_RECORDS_TOOL = "mcp__skein__records";
export const SKEIN_PUT_ON_TOOL = "mcp__skein__put_on";

export function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The prose in a message's content.
 *
 * `content` is either a bare string or a list of blocks, on both the user and
 * the assistant side, and tool results nest the same shape again. Anything that
 * is not a text block — tool_use, tool_result, thinking — is not prose and is
 * dropped. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** A pull request number out of a tool call's arguments, or null.
 *
 *  Its own reader rather than `arg`, which takes strings only — `pull` is an
 *  integer in the schema, so `arg` answered null for every call that had one and
 *  the line silently fell back to "read the pull requests" on a call that had
 *  named one. **And a string is accepted too**, because arguments arrive as
 *  `input_json_delta` fragments a model composed: a `"41"` is what it meant, and
 *  the transcript refusing to say so over a pair of quotes is the wrong place to
 *  be strict.
 *
 *  Non-positive is null. A `0` is not a pull request and neither is a `-1`, and
 *  drawing `!0` on a card is worse than saying nothing. */
function pullNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** Turn a tool call into the one line of prose that goes under the title.
 *
 * `input` is empty at `content_block_start` — arguments stream in afterwards as
 * `input_json_delta` — so every case degrades to a bare verb. The activity line
 * reads "reading a file" the instant the call begins and sharpens to "reading
 * package.json" when the full block lands.
 *
 * The tool list is per-session and includes whatever MCP servers and plugins
 * the user has loaded, so unknown names fall through to the bare tool name
 * rather than being dropped. */
export function describeTool(name: string, input: any): string {
  const arg = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v : null;

  const path = arg(input?.file_path);
  switch (name) {
    case "Read":
      return path ? `reading ${basename(path)}` : "reading a file";
    case "Edit":
      return path ? `editing ${basename(path)}` : "editing a file";
    case "Write":
      return path ? `writing ${basename(path)}` : "writing a file";
    case "NotebookEdit": {
      const nb = arg(input?.notebook_path);
      return nb ? `editing ${basename(nb)}` : "editing a notebook";
    }
    case "Bash":
    case "PowerShell": {
      const c = arg(input?.command);
      return c ? clip(c, 46) : "running a command";
    }
    case "Glob": {
      const p = arg(input?.pattern);
      return p ? `finding ${clip(p, 28)}` : "finding files";
    }
    case "Grep": {
      const p = arg(input?.pattern);
      return p ? `searching for ${clip(p, 26)}` : "searching";
    }
    /* `Agent` is the live name for the subagent tool; `Task` is what the same
       tool was called in older builds. Nothing on this machine has ever emitted
       `Task` — 0 uses against 192 `Agent` calls across all 496 transcripts,
       read 2026-08-14 — and keying on `Task` alone is what left the whole seat
       machinery in `conversation.svelte.ts` dead code from the day it shipped.
       Both are matched, because the old name costs one line. */
    case "Agent":
    case "Task": {
      const d = arg(input?.description);
      return d ? `delegating: ${clip(d, 30)}` : "delegating";
    }
    /* A workflow is delegation one level up: a script that fans a dozen
       subagents out over phases and returns a receipt immediately. Named
       because `default` drew the bare word `Workflow` on the card — and
       because the name is the model's own, written into the script's `meta`.
       See `workflowName`. */
    case "Workflow": {
      const w = workflowName(input);
      return w ? `workflow: ${clip(w, 30)}` : "running a workflow";
    }
    case "Skill": {
      const s = arg(input?.skill);
      return s ? `running /${clip(s, 26)}` : "running a skill";
    }
    case "WebFetch": {
      const u = arg(input?.url);
      return u ? `fetching ${clip(u, 34)}` : "fetching a page";
    }
    case "WebSearch":
      return "searching the web";
    /* The plan. `TodoWrite` is the old single-call shape and is used *nowhere*
       here — 0 across all 496 transcripts — while the live vocabulary is one
       call per change: 150 `TaskCreate` and 209 `TaskUpdate`, read 2026-08-14.
       So the one name this file knew was the one name that never arrives, and
       every plan update fell through to `default` and printed the bare string
       `TaskUpdate` on the card. */
    case "TodoWrite":
      return "planning";
    case "TaskCreate": {
      /* `activeForm` is the gerund the model writes for exactly this line —
         "Proving TLS and the auth ladder". Nothing else has to be composed. */
      const a = arg(input?.activeForm) ?? arg(input?.subject);
      return a ? clip(a, 40) : "planning";
    }
    case "TaskUpdate":
      /* Carries an id and a status and no words at all, so the words have to
         come from the folded plan — see `Conversation.#planLine`. */
      return "planning";
    case "TaskList":
    case "TaskGet":
      return "checking the plan";
    case "TaskOutput":
    case "BashOutput":
      return "checking on a job";
    case "TaskStop":
    case "KillShell":
      return "stopping a job";
    case "Monitor": {
      const d = arg(input?.description);
      return d ? `watching ${clip(d, 32)}` : "watching for something";
    }
    case "SendMessage":
      return "messaging an agent";
    case "AskUserQuestion":
      return "asked you a question";
    /* Skein's own, which fell through to `default` and drew the raw
       `mcp__skein__ask_user` on the card and in the transcript — directly above
       the answer the panel now keeps under it. */
    case SKEIN_ASK_TOOL: {
      const n = Array.isArray(input?.questions) ? input.questions.length : 0;
      return n > 1 ? `asked you ${n} things` : "asked you a question";
    }
    /* Skein's own, the same argument as `SKEIN_ASK_TOOL` above: these fell
       through to `default` and drew the raw `mcp__skein__send` on the card. */
    case SKEIN_LIST_TOOL: {
      const scope = arg(input?.scope);
      return scope === "skein" ? "looked over the whole wall" : "looked for other cards";
    }
    case SKEIN_SEND_TOOL: {
      const to = input?.to;
      if (typeof to === "string") {
        const word = to.trim().toLowerCase();
        if (word === "skein") return "told the whole wall";
        if (word === "project") return "told the project";
        return `messaged ${clip(to, 24)}`;
      }
      if (Array.isArray(to)) {
        return to.length === 1
          ? `messaged ${clip(String(to[0]), 24)}`
          : `messaged ${to.length} cards`;
      }
      return "messaged another card";
    }
    case SKEIN_BOARD_TOOL:
      return "read the billboard";
    case SKEIN_POST_TOOL: {
      const subject = arg(input?.subject);
      return subject ? `posted: ${clip(subject, 30)}` : "posted a notice";
    }
    case SKEIN_UNPOST_TOOL: {
      if (input?.all === true) return "cleared its notices";
      const subject = arg(input?.subject);
      return subject ? `took down: ${clip(subject, 30)}` : "took a notice down";
    }
    /* Reading rather than costing: `recall` is what an agent does *instead* of
       messaging a card to ask what it did, so the line says whose words. */
    case SKEIN_RECALL_TOOL: {
      const card = arg(input?.card);
      return card ? `read ${clip(card, 22)}'s words` : "read another card's words";
    }
    case SKEIN_TOUCHED_TOOL: {
      const paths = input?.paths;
      const one =
        typeof paths === "string"
          ? paths
          : Array.isArray(paths) && paths.length === 1
            ? String(paths[0])
            : null;
      if (one) return `checked who else is in ${basename(one)}`;
      return Array.isArray(paths) && paths.length > 1
        ? `checked who else is in ${paths.length} files`
        : "checked who else has been here";
    }
    case SKEIN_PIN_TOOL: {
      const img = arg(input?.path);
      return img ? `pinned ${basename(img)}` : "pinned an image";
    }
    case SKEIN_PINNED_TOOL:
      return "checked what it has pinned";
    case SKEIN_REPIN_TOOL: {
      if (input?.remove === true) return "took an image down";
      const img = arg(input?.path);
      if (img) return `repinned ${basename(img)}`;
      const place = arg(input?.place);
      return place ? `moved an image ${clip(place, 20)}` : "changed a pinned image";
    }
    case SKEIN_DROP_TOOL: {
      const title = arg(input?.title);
      return title ? `dropped: ${clip(title, 30)}` : "dropped something in the sink";
    }
    case SKEIN_SINK_TOOL:
      return input?.settled === true ? "read what the sink has settled" : "read the sink";
    case SKEIN_TAKE_TOOL: {
      const item = arg(input?.item);
      if (input?.release === true) return item ? `put back ${clip(item, 24)}` : "put an item back";
      return item ? `took on ${clip(item, 24)}` : "took an item on";
    }
    case SKEIN_DONE_TOOL: {
      const item = arg(input?.item);
      return item ? `settled ${clip(item, 26)}` : "settled an item";
    }
    /* The two that change what is on the wall. Worth the most specific line of
       any of these: a card appearing beside yours is the one thing here you
       would want an account of without opening the call. */
    case SKEIN_SPAWN_TOOL: {
      const title = arg(input?.title);
      if (title) return `opened a card: ${clip(title, 24)}`;
      const project = arg(input?.project);
      return project ? `opened a card in ${clip(project, 22)}` : "opened a card";
    }
    case SKEIN_CLOSE_TOOL: {
      const card = arg(input?.card);
      return card ? `closed ${clip(card, 26)}` : "closed a card";
    }
    case SKEIN_WAKE_TOOL: {
      const secs = input?.seconds;
      return typeof secs === "number" && Number.isFinite(secs) && secs > 0
        ? `back in ${said(secs)}`
        : "asked to be woken later";
    }
    case SKEIN_ALLOWANCE_TOOL:
      return "checked the allowance";
    /* The dev servers. `servers` and `server_log` read something the wall is
       already holding and cost nobody anything; `server` runs processes on this
       machine, so it gets the specific line — the same asymmetry `spawn` and
       `close` get above, and for the same reason. "restarted dev" is a thing you
       would want to have seen from the card without opening the call. */
    case SKEIN_SERVERS_TOOL:
      return "looked over the dev servers";
    case SKEIN_SERVER_LOG_TOOL: {
      const g = arg(input?.group);
      const m = arg(input?.match);
      if (g && m) return `searched ${clip(g, 16)}'s log for ${clip(m, 16)}`;
      if (m) return `searched a server log for ${clip(m, 20)}`;
      return g ? `read ${clip(g, 24)}'s log` : "read a dev server log";
    }
    case SKEIN_SERVER_TOOL: {
      const g = arg(input?.group);
      const said = arg(input?.action);
      /* The verb is the agent's own word rather than what the call turned out
         to do — a `start` aimed at a running group releases the old tree first,
         and the line saying so belongs in the tool's answer where the reasoning
         is, not on a card where it would read as the wall disagreeing with the
         agent about what was asked for. */
      const verb =
        said === "stop" ? "stopped" : said === "start" ? "started" : "restarted";
      return g ? `${verb} ${clip(g, 24)}` : `${verb} a dev server group`;
    }
    /* The forge. `pipelines` and `reviews` are readings and say so plainly; the
       third is the only tool on this server that reaches outside the machine,
       and the wording is the point — see the note above
       `SKEIN_PULL_REQUEST_TOOL`. */
    case SKEIN_PIPELINES_TOOL: {
      const r = arg(input?.run);
      const b = arg(input?.branch);
      if (r) return "looked into one pipeline run";
      if (b) return `checked what ${clip(b, 24)} built`;
      return input?.failed === true
        ? "looked for a broken pipeline"
        : "looked over the pipelines";
    }
    case SKEIN_REVIEWS_TOOL: {
      const n = pullNumber(input?.pull);
      if (n) return `read pull request !${n}`;
      return input?.mine === true
        ? "looked over its own pull requests"
        : "looked over the pull requests";
    }
    case SKEIN_PULL_REQUEST_TOOL: {
      /* `wants to`, not `did`. The call parks on a question and nothing has
         happened when this line is drawn — the tool's own answer is where the
         outcome is, and it says whether the user agreed. */
      const n = pullNumber(input?.pull);
      if (arg(input?.action) === "update") {
        return n ? `wants to edit pull request !${n}` : "wants to edit a pull request";
      }
      const t = arg(input?.title);
      return t ? `wants to open a pull request: ${clip(t, 40)}` : "wants to open a pull request";
    }
    /* The music. A search is a reading; putting something on is the only act,
       and it is refused while the user is listening — hence `chose`. */
    case SKEIN_RECORDS_TOOL: {
      const q = arg(input?.query);
      return q ? `looked up ${clip(q, 28)} on spotify` : "searched spotify";
    }
    case SKEIN_PUT_ON_TOOL: {
      /* The kind is the whole of what a uri carries — there is no title in one
         — so the line names the shape and not the record. */
      const kind = /^spotify:([a-z]+):/.exec(arg(input?.uri) ?? "")?.[1];
      if (!kind) return "chose something to put on";
      return `chose ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} to put on`;
    }
    case "ExitPlanMode":
      return "wants the plan approved";
    default:
      return name;
  }
}

/* ── Work that outlives a turn ────────────────────────────────────────────
 *
 * Every other state on this wall is a fold over one turn: it opens on the first
 * event and closes on the `result`. Background work breaks that, and it is the
 * one thing on the wire that the fold had no concept of at all.
 *
 * A `Bash` carrying `run_in_background`, an `Agent` (which backgrounds by
 * default in this build) and a `Monitor` all return *immediately* — the tool
 * result is a receipt naming a job id, not an answer — and the turn then
 * settles clean. So the card went `rest` and started warming on the neglect
 * clock while `pytest -n 6` fanned out to twelve processes underneath it.
 * Observed 2026-08-14 with two such trees live under `skein.exe`.
 *
 * Completion arrives much later as a `<task-notification>` on a `user` message,
 * which is the CLI talking about the conversation rather than anything anybody
 * typed — the same register as the stop note, and the same hazard: read as
 * speech it becomes a wall of XML the transcript attributes to you.
 *
 * Counts below are from this machine's 496 transcripts, read 2026-08-14. */

/** What kind of thing was put in the background. Not cosmetic: an agent's
 *  receipt names no job id (see `startedJob`), so the four cannot share one
 *  parser — and a workflow is a dozen agents where an agent is one, which the
 *  card and the resume prompt both say out loud. */
export type JobKind = "command" | "agent" | "watch" | "workflow";

/** Would this call put something in the background?
 *
 *  Answered from the *call*, so a job is on the card the moment the tool_use
 *  block lands rather than a round trip later. It is provisional by nature —
 *  `Agent` can be told to run inline, and only its receipt says which it did —
 *  so the caller registers a job here and `startedJob` confirms or drops it. */
export function backgroundKind(name: string, input: any): JobKind | null {
  if (name === "Bash" || name === "PowerShell") {
    return input?.run_in_background === true ? "command" : null;
  }
  /* Both names, for the reason `describeTool` matches both. */
  if (name === "Agent" || name === "Task") {
    /* Default true in this build — the tool description says subagents run in
       the background unless `run_in_background: false` is passed. */
    return input?.run_in_background === false ? null : "agent";
  }
  if (name === "Monitor") return "watch";
  /* Not provisional, unlike the others: the tool has no inline arm at all — it
     returns a task id and a promise of a notification, always. It was the one
     background tool nothing here knew about, so a card ran a fifteen-agent
     review with `at rest` on it and started warming on the neglect clock. */
  if (name === "Workflow") return "workflow";
  return null;
}

/** How much of a finished job's own account of itself the transcript keeps.
 *
 *  Generous next to the 44 an `activity` line gets, which has a card to fit
 *  inside; this only has to stay a sentence. */
export const JOB_NOTE_CAP = 160;

/** What a finished job says in the transcript.
 *
 *  A notification's `summary` is the CLI's own words and is usually a sentence,
 *  so it went in whole. But for a backgrounded `Bash` with no `description` the
 *  summary is *the command*, and a heredoc command is a hundred lines — while a
 *  `meta` line is `pre-wrap` and, unlike a compaction or a skill, has no fold.
 *  So those hundred lines stood in the column with nothing to collapse them,
 *  directly under the folded call they belonged to, reading exactly like the
 *  transcript had sprung a leak. Reported three times before it was found,
 *  because every search for the text went to the session file and a wire
 *  `system/task_notification` is never written there.
 *
 *  **And a fourth report was nearly dismissed on the session file agreeing.**
 *  Chasing sink 1601a7a1 back to the two calls the user had pasted, both read
 *  as foreground on disk — `input` was `{ command }` and nothing else, no
 *  `run_in_background` — so "no background job, therefore not this bug" looked
 *  like a finding. It is a false negative, and `tools/probe-leak.ts` is what
 *  falsified it: probed 2026-08-27 against claude 2.1.241, a shell call the
 *  model wrote with `command` alone still raised `system/task_started` and
 *  `system/task_notification` on the wire, and still recorded no
 *  `run_in_background` on disk. **Whether a call backgrounded is decided
 *  somewhere the transcript record does not describe** — so the absence of that
 *  flag says nothing, and the two fields that carry the whole command are
 *  `task_started.description` and `task_notification.summary`, neither of which
 *  reaches the file either. Anything reasoning about a job from a session file
 *  is reasoning from the half of the story that was written down.
 *
 *  `clip` rather than a fold, and the flattening is the point rather than a side
 *  effect: what a job did is one line of news. Adding `meta` to `blocksOf`'s
 *  `LONG` kinds would have put `stopped` and `cleared` behind a triangle too,
 *  and a fold whose cap is the whole of its content is a triangle beside
 *  nothing.
 *
 *  Both folds call this — `Conversation.#settleJob` and `history.ts` — for the
 *  reason every other shared caption exists: the live column and the one read
 *  back off disk must not be able to describe the same job differently. */
export function jobNote(summary: string): string {
  return clip(summary, JOB_NOTE_CAP);
}

/** What to call a job on the card. The `description` field is written to be
 *  read by a person, so it is preferred over the command wherever it exists. */
export function jobLabel(name: string, input: any): string {
  const d = input?.description;
  if (typeof d === "string" && d.trim()) return clip(d, 40);
  const c = input?.command;
  if (typeof c === "string" && c.trim()) return clip(c, 40);
  const p = input?.prompt;
  if (typeof p === "string" && p.trim()) return clip(p, 40);
  /* A workflow's own words for itself, which live inside the script rather than
     beside it: `description` is documented as ignored by the runtime, and two
     of the seven calls measured here omitted it. Without this the largest job a
     card can start was the one labelled "a job". */
  if (name === "Workflow") {
    const meta = workflowMeta(input?.script);
    const said = meta?.description || workflowName(input);
    return said ? clip(said, 40) : "a workflow";
  }
  return name === "Agent" || name === "Task" ? "a subagent" : "a job";
}

/* ── what a workflow says it is ────────────────────────────────────────────
 *
 * The `Workflow` tool is handed a script, and the script is required to open
 * with a literal `meta` block naming the run and listing its phases:
 *
 *   export const meta = {
 *     name: 'caravan-test-audit',
 *     description: 'Audit all 97 test files …',
 *     phases: [{ title: 'Audit', detail: '…' }, { title: 'Verify', … }],
 *   }
 *
 * That block is the only account of a workflow anything outside the runtime
 * ever gets: the tool result is a receipt, and the dozen agents underneath it
 * run on a stream Skein never sees. It is also *already* the model's own words
 * about its own work, which is what makes drawing it honest rather than a
 * guess — the wall draws nothing the agent did not say, and it said this.
 *
 * Read by regex rather than parsed, deliberately. The block is specified as a
 * pure literal — no variables, no interpolation, no calls — the three fields
 * wanted are scalars and a list of scalars, and the alternative is a JavaScript
 * parser inside a file whose whole job is reading a stream. What a malformed
 * block costs is a card that says `running a workflow`, which is what it said
 * before any of this.
 *
 * Measured against the seven real calls on this machine, 2026-08-21: five
 * carried `script`, two carried `scriptPath` and no script at all — the
 * re-invoke-after-editing path, and the reason a name falls back to the file's
 * own. */

export type WorkflowMeta = {
  name: string;
  description: string;
  /** The phase titles, in order. Empty when the block declares none: `phases`
   *  is optional, and a workflow that is one fan-out has no use for it. */
  phases: string[];
};

/** A quoted scalar, in any of the three quotes a script may use. The escape arm
 *  is what stops an apostrophe ending the string early — a `detail` reading
 *  `each dimension\'s findings` is the shape that arrives. */
function quoted(key: string): RegExp {
  return new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
}

/** What the script says about itself, or null if it does not say.
 *
 *  Bounded to the `meta` block by counting braces rather than trusted to be the
 *  first `name:` in the file: a phase entry carries a `title`, but everything
 *  below the block is prose a model wrote for other agents to read, and one
 *  prompt saying `name: "…"` would otherwise rename the run. */
export function workflowMeta(script: unknown): WorkflowMeta | null {
  if (typeof script !== "string") return null;
  const at = script.search(/\bexport\s+const\s+meta\s*=\s*\{/);
  if (at < 0) return null;
  const block = balanced(script, script.indexOf("{", at), "{", "}");
  if (!block) return null;

  const name = quoted("name").exec(block);
  const said = quoted("description").exec(block);

  /* The titles, from inside the `phases` array alone. `title` appears nowhere
     else in a meta block today, but bounding it costs one line and a field
     added beside it later would otherwise arrive as a phantom phase. */
  const phases: string[] = [];
  const list = /\bphases\s*:\s*\[/.exec(block);
  if (list) {
    const inner = balanced(block, block.indexOf("[", list.index), "[", "]");
    if (inner) {
      for (const m of inner.matchAll(new RegExp(quoted("title").source, "g"))) {
        const t = unescaped(m[2]);
        if (t) phases.push(t);
      }
    }
  }

  const named = name ? unescaped(name[2]) : "";
  const desc = said ? unescaped(said[2]) : "";
  if (!named && !desc && !phases.length) return null;
  return { name: named, description: desc, phases };
}

/** What to call this workflow in one short label.
 *
 *  `meta.name` first, since it is what the runtime files the run under and what
 *  `/workflows` lists it as. Then `name`, which is a *saved* workflow invoked by
 *  name and has no script to read. Then the script file's own name, which is the
 *  resume path — `Workflow({scriptPath})` re-runs an edited script and carries
 *  nothing else to go on. */
export function workflowName(input: any): string | null {
  const meta = workflowMeta(input?.script);
  if (meta?.name) return meta.name;
  const named = input?.name;
  if (typeof named === "string" && named.trim()) return named.trim();
  const path = input?.scriptPath;
  if (typeof path === "string" && path.trim()) {
    const base = path.trim().split(/[\\/]/).pop() ?? "";
    /* The runtime stamps a persisted script with the run id it was first
       launched under — `caravan-pass3-wf_9157cd8c-f79.js` — and fifteen
       characters of hex is noise on a card. */
    const stem = base.replace(/\.[a-z]+$/i, "").replace(/-wf_[a-z0-9-]+$/i, "");
    if (stem) return stem;
  }
  return null;
}

/** From an opening bracket to the one that closes it, neither included.
 *
 *  Quote-aware, because a `detail` inside the block may hold a bracket of its
 *  own — a `${...}`, or a JSON shape quoted in prose — and counting those ends
 *  the block early or never ends it. */
function balanced(s: string, open: number, lhs: string, rhs: string): string | null {
  if (open < 0 || s[open] !== lhs) return null;
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === lhs) depth += 1;
    else if (c === rhs) {
      depth -= 1;
      if (depth === 0) return s.slice(open + 1, i);
    }
  }
  return null;
}

/** The two escapes that actually turn up in a meta block: an escaped quote, and
 *  a `\u` for a character whose author would rather not paste it. */
function unescaped(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(['"`\\])/g, "$1")
    .trim();
}

/** Did this tool result actually start something, what is its id, and where is
 *  its output going?
 *
 *  Three receipts, verbatim from the transcripts:
 *
 *    Command running in background with ID: btuqox9zy. Output is being …
 *    Monitor started (task bc4v3btv8, timeout 1800000ms). You will be …
 *    Async agent launched successfully. (This tool result is internal …
 *
 *  `started` is the answer that matters — a `false` means the call ran inline
 *  after all and the provisional job must be dropped, which is the only way to
 *  tell an `Agent` that backgrounded from one that did not.
 *
 *  **`outputPath` is the whole reason a job can be persisted.** Only the Bash
 *  receipt names one, and it names it in full:
 *
 *    …written to: C:\…\Temp\claude\<slug>\<session>\tasks\btuqox9zy.output.
 *    You will be notified when it completes.
 *
 *  so the match has to stop at `.output` rather than run to the end of the
 *  sentence. The other two carry no path, and theirs is derived at the far end
 *  from the same three parts — see `store::pending_jobs`. A job whose
 *  notification arrives needs none of this: that block quotes its own
 *  `<output-file>`. This exists for the job whose notification never comes.
 *
 *  **The agent's `agentId` is extracted now, having deliberately not been.**
 *  Its receipt instructs that it never be repeated *to the user*, and that is
 *  still honoured — nothing here reaches a user-facing reply. What changed is
 *  that it turned out to be needed: it is the same id the completion
 *  notification carries as `<task-id>`, in the same 17-hex shape, so it is what
 *  names the subagent's transcript on disk. Without it a roused card can say a
 *  subagent was lost but not where to read what it had done. */
export function startedJob(resultText: string): {
  started: boolean;
  taskId: string | null;
  outputPath: string | null;
  /** Where a workflow's own journal is, and empty for everything else.
   *
   *  Taken from the receipt's `Transcript dir:` rather than derived: the CLI
   *  gives it absolute, and re-deriving it would mean re-performing the lossy
   *  directory slug (see the note in `CLAUDE.md`) to land in the same place the
   *  receipt has already named. Live-only, and deliberately not persisted with
   *  the job — progress is a reading about a run this process is watching, and a
   *  row that outlives the process is for saying what was *lost*. */
  journalDir: string | null;
} {
  const bg = /\brunning in background with ID:\s*([A-Za-z0-9_-]+)/i.exec(resultText);
  if (bg) {
    /* Non-greedy to `.output`: the sentence carries on afterwards, and a greedy
       match swallows "You will be notified when it completes." into the path. */
    const to = /\bOutput is being written to:\s*(\S.*?\.output)/i.exec(resultText);
    return { started: true, taskId: bg[1], outputPath: to ? to[1] : null, journalDir: null };
  }
  const mon = /\bMonitor started\s*\(task\s+([A-Za-z0-9_-]+)/i.exec(resultText);
  if (mon) return { started: true, taskId: mon[1], outputPath: null, journalDir: null };
  /* A workflow, verbatim:
       Workflow launched in background. Task ID: wxx8uibpu
       Summary: Audit all 97 Caravan test files for assertions that cannot fail
       Transcript dir: …\subagents\workflows\wf_4dfe23e8-0e6
     Its id is the same nine characters a `Bash` job's is and it is quoted back
     as `<task-id>` by the notification, so nothing downstream needs telling
     which kind it was. No output path is named — but the notification's own
     `<output-file>` proves the CLI files it under `tasks\<id>.output` like the
     rest, so `store::task_output_path` derives it with nothing added. */
  const wf = /\bWorkflow launched in background\.?\s*Task ID:\s*([A-Za-z0-9_-]+)/i.exec(
    resultText,
  );
  if (wf) {
    /* `Transcript dir: …\subagents\workflows\wf_4dfe23e8-0e6` — the run's own
       directory, and `journal.jsonl` inside it is the only thing that says how
       far a workflow has got. Stopped at the end of the line, since the receipt
       carries on with three more labelled paths after it. */
    const dir = /^\s*Transcript dir:\s*(\S.*?)\s*$/im.exec(resultText);
    return {
      started: true,
      taskId: wf[1],
      outputPath: null,
      journalDir: dir ? dir[1] : null,
    };
  }
  if (/\bAsync agent launched successfully\b/i.test(resultText)) {
    const id = /\bagentId:\s*([A-Za-z0-9]+)/i.exec(resultText);
    return { started: true, taskId: id ? id[1] : null, outputPath: null, journalDir: null };
  }
  return { started: false, taskId: null, outputPath: null, journalDir: null };
}

/** How a background job ended. */
export type JobEnd = "done" | "failed" | "killed";

export type TaskNote = {
  taskId: string | null;
  /** The call that started it — the only id shared by the tool_use, the
   *  receipt and this notification, and therefore what jobs are keyed on. */
  toolId: string | null;
  end: JobEnd;
  /** The CLI's own sentence, which is already the line worth drawing:
   *  `Background command "Wait for LCD test results" completed (exit code 0)`. */
  summary: string;
};

/** Is this `user` message the CLI reporting a background job, rather than
 *  anything anybody said?
 *
 *  It arrives as a bare string on a `user` record with no `isMeta` to sort it
 *  out by — exactly the shape `isStopNote` exists for, and the same failure if
 *  it is missed: both folds pushed the raw XML as a `you` line and then opened
 *  a turn on it. */
export function isTaskNotification(text: string): boolean {
  return /^<task-notification>[\s\S]*<\/task-notification>$/.test(text.trim());
}

export function parseTaskNotification(text: string): TaskNote | null {
  if (!isTaskNotification(text)) return null;
  const field = (tag: string): string | null => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    return m ? m[1].trim() || null : null;
  };
  return taskNoteOf(field("status"), field("summary"), field("task-id"), field("tool-use-id"));
}

/** The one reading of a job's fate, shared by the two places it arrives.
 *
 *  `completed` and `killed` are the two statuses seen on this machine. The exit
 *  code rides in the summary rather than in a field of its own, and a command
 *  that completed non-zero is a job that failed — a background test run that
 *  came back red must not read as done. */
export function taskNoteOf(
  rawStatus: string | null,
  rawSummary: string | null,
  taskId: string | null,
  toolId: string | null,
): TaskNote {
  const status = (rawStatus ?? "").trim().toLowerCase();
  const summary = (rawSummary ?? "").trim();
  const code = /\(exit code (\d+)\)/.exec(summary);
  let end: JobEnd;
  if (status === "completed") end = code && code[1] !== "0" ? "failed" : "done";
  else if (/^(killed|stopped|cancelled|canceled)$/.test(status)) end = "killed";
  else if (status === "") end = "done";
  else end = "failed";
  return {
    taskId,
    toolId,
    end,
    summary: summary || `a background job ${status || "finished"}`,
  };
}

/** The same news, on the wire, where it is not a message at all.
 *
 *  `parseTaskNotification` above reads a `<task-notification>` block off a
 *  `user` record, and that block is real — but it is a **transcript** record.
 *  Live, the CLI reports the same thing as a `system` event with structured
 *  fields, and nothing here read it. Probed 2026-08-25 with
 *  `tools/probe-nudge.ts`, which ran a real background job and watched the
 *  wire:
 *
 *    34.89s  system/task_notification  {task_id, tool_use_id, status,
 *                                       output_file, summary}
 *    34.91s  system/init                      ← the woken turn, 20ms later
 *
 *  So the whole job fold ran from `history.ts` after a restart and never once
 *  live: `#dropJob` was never called, so a card kept its background-work ring
 *  after the work was done; `#closeSeat` never fired, so a backgrounded
 *  subagent's seat and a workflow's crowd never closed; the `job` row was never
 *  deleted, so the next launch reported finished work as lost; and `unwoken` was
 *  never set, which is the whole of why no job nudge had ever been sent in 222
 *  transcripts. **A probe over transcripts cannot see this**, and two of them
 *  did not — the difference is only visible on the stream.
 *
 *  Three siblings arrive on the same arm and are deliberately still unread:
 *  `task_started` (`{task_id, tool_use_id, description, is_backgrounded,
 *  task_type}`), `task_updated` (`{task_id, patch: {status, end_time}}`) and
 *  `background_tasks_changed` (`{tasks: [...]}`). Each carries, already parsed,
 *  something `startedJob` currently scrapes out of receipt prose — including the
 *  `is_backgrounded` flag the `Agent` starting-or-running promotion exists to
 *  infer. They are worth folding and they are not this bug: the start path works
 *  live, because a tool_result does arrive as a `user` event. Folding
 *  `task_updated` beside this one would settle the same job twice. */
export function systemTaskNote(ev: any): TaskNote | null {
  if (ev?.type !== "system" || ev?.subtype !== "task_notification") return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const taskId = str(ev.task_id);
  const toolId = str(ev.tool_use_id);
  /* Both ids absent is not a job — it is an event shape this build does not
     know, and settling on it would drop whichever job happened to be first. */
  if (!taskId && !toolId) return null;
  return taskNoteOf(str(ev.status), str(ev.summary), taskId, toolId);
}

/* ── Being told, and not stirring ─────────────────────────────────────────
 *
 * A `<task-notification>` almost always wakes the agent, and the card needed no
 * help with it. Measured over the 64 transcripts on this machine that carry one
 * (`tools/probe-wake.ts`, 2026-08-19), counting *batches* rather than records:
 *
 *   skein-spawned   53 batches   woken 48 (91%)   prompt first 2   silent 3
 *   terminal       124 batches   woken 120 (97%)  prompt first 1   silent 3
 *
 * Median wake delay ten seconds. Two things about that measurement are worth
 * keeping, because the first version of this probe got both wrong and reported
 * a ~50% failure rate that does not exist. Notifications arrive in BATCHES —
 * three jobs landing together write three `user` records in the same second —
 * so "did an assistant record immediately follow this one" is NO for every
 * notification but the last of its batch, by construction. And the transcript
 * interleaves bookkeeping (`ai-title`, `mode`, `last-prompt`) between anything
 * and anything, which breaks the same test again.
 *
 * What is left is small and specific. Every silent case on the Skein side is
 * the same message, and it is not a job completing:
 *
 *   "3 background shell command task(s) from the previous session"
 *   "10 background shell command task(s) from the previous session"
 *
 * That is the CLI reconciling tasks it finds orphaned at startup — a process
 * died holding them, and `--resume` restores the conversation but not the task
 * table, so the new process can only report them as stopped with no exit code.
 * That notification wakes nobody, 3 times out of 3, and it is the one Skein
 * generates constantly: a desktop app gets closed, where a terminal session
 * runs for days. The work behind it has usually finished and written its output
 * — 11 of 15 in the case this was found from — so what is lost is not the work
 * but the news of it, and the card sits reading `at rest` on top of a finished
 * job until somebody thinks to ask.
 *
 * Hence the state below. It is deliberately not about the ordinary path, which
 * works. */

/** How long after a job reports in before the card says nobody picked it up.
 *
 *  Just past the measured median wake delay of ten seconds. A card taking the
 *  ordinary path — which is nearly all of them — must never be accused, and the
 *  reading has to arrive while it still concerns the job you are waiting on
 *  rather than being archaeology. Raising this much past the median buys
 *  nothing: the distribution has a long tail (87s), and a card that is going to
 *  answer at all has already answered. */
export const WAKE_GRACE_S = 12;

/** How many times Skein will supply the nudge before leaving it to you.
 *
 *  Small on purpose, and for the reason `HEAL_BUDGET` is small: every nudge is
 *  a real turn against a real allowance. Two is enough to cover a notification
 *  that landed in a gap, and few enough that a card in some loop Skein has not
 *  understood costs a bounded amount before it stops and says so. */
export const NUDGE_BUDGET = 2;

/** What Skein says to a card that was told and did not stir.
 *
 *  Deliberately almost empty, and what it supplies is a *turn* rather than
 *  information. The notification is already in the conversation — the agent has
 *  it, and in the case this exists for it names tasks a dead process was
 *  holding, which Skein knows nothing else about. So anything more specific
 *  would be Skein paraphrasing work it never saw, over a report the agent can
 *  already read. */
export const NUDGE_TEXT = "a background job you started has reported in.";

/** What is waiting in the CLI's queue, unread. Two things reach the same
 *  state — *told, and not stirring* — from opposite ends, and they are worded
 *  apart everywhere because they mean different things about the wall. A `job`
 *  is the CLI's own notification, which the agent has and has not acted on. A
 *  `prompt` is something **you** typed that the process has never echoed back,
 *  which is a card that looks answered and is not. */
export type NudgeKind = "job" | "prompt";

/** What Skein says to a card holding a prompt it never took up.
 *
 *  Nearly empty for the reason `NUDGE_TEXT` is, and for one more: what flushes
 *  the queue is *any* message, and the thing behind it in that queue is your
 *  own words. So this says only where to look — anything else would be Skein
 *  paraphrasing a prompt the agent is about to read for itself. Hedged, because
 *  the queue may have drained between the check and the send, and an agent told
 *  flatly that a message exists would go looking for one that does not. */
export const NUDGE_PROMPT_TEXT =
  "if a message of mine is queued behind this one, answer that instead.";

/** The card's own account of having been told and not stirred. */
export function unwokenNote(count: number): string {
  return count === 1
    ? "a job reported in and nothing picked it up"
    : `${count} jobs reported in and nothing picked them up`;
}

/** Said before Skein nudges, because a card must never send on its own in
 *  silence — the same rule `healNote` exists for. */
export function nudgeNote(attempt: number, kind: NudgeKind = "job"): string {
  const what = kind === "prompt" ? "nothing answered that" : "nothing picked that up";
  return `${what} — asking the card to look (${attempt} of ${NUDGE_BUDGET})`;
}

/** Said when the budget is spent, and only then: a card that was picked up on
 *  the first nudge has not given up on anything. */
export function nudgeGaveUpNote(kind: NudgeKind = "job"): string {
  return kind === "prompt"
    ? "still nothing after asking twice — send it again, or stop the card and try"
    : "still nothing after asking twice — send it something to pick the job up";
}

/** What a card says while it is holding a prompt no account would take.
 *
 *  The fallback wording, for the case where nothing named a particular blocker.
 *  Where one did, `sayBlocked` is more specific and is used instead — this is
 *  the sentence, not the only sentence. */
export const HOLD_LINE = "holding — every account is at its limit";

/** What the face says about a card at rest owing you a turn. Appended to
 *  whatever the card was already saying, the way `stalled` appends to it.
 *
 *  *Sent* rather than *delivered*, on purpose. Skein knows the prompt was
 *  written to the child's stdin and it knows the wire never echoed it back
 *  (`--replay-user-messages`); what it cannot know is whether the CLI is
 *  holding it in a queue or lost it. Both are "you are owed a turn nobody is
 *  taking", which is the whole of what this has to say. */
export const UNACKNOWLEDGED_LINE = "sent, not picked up";

/** The number the CLI gave a freshly created plan item.
 *
 *  `TaskCreate` answers `Task #1 created successfully: <subject>`, and that
 *  number is what every later `TaskUpdate` names. Without it the plan cannot be
 *  kept in step, since the update carries an id and a status and nothing else. */
export function taskNumberOf(resultText: string): string | null {
  const m = /\bTask #(\d+) created successfully\b/i.exec(resultText);
  return m ? m[1] : null;
}

/** A model id tells us how much room the conversation actually has.
 *
 * Only the id from `system/init` carries the window tier — see `sameModel`. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return 200_000;
  return /\[1m\]|-1m\b/.test(model) ? 1_000_000 : 200_000;
}

/** The window a session must have had, given what it actually occupied.
 *
 * For a conversation read off disk there is no `system/init` to ask: a
 * transcript records only the bare per-message id, so the tier is not in the
 * file at all. But occupancy is, and it rules things out — a request that
 * carried 443k tokens cannot have been made against a 200k window. Inference
 * only ever widens, which is the safe direction: the alternative is a card
 * imported at 443k drawing a full ring and reading as about to run out.
 *
 * The moment such a card wakes, `system/init` states the tier and
 * `#adoptModel` replaces this guess with the fact. */
export function windowForObserved(
  model: string | undefined,
  tokens: number,
): number {
  const known = contextWindowFor(model);
  return tokens > known ? 1_000_000 : known;
}

/** A model id with its window tier stripped.
 *
 * The wire reports two different ids for one session. `system/init` gives the
 * *configured* model, tier and all — `claude-opus-5[1m]`. Every `assistant`
 * message then reports the bare API name the request actually went to —
 * `claude-opus-5` — because `[1m]` is Claude Code's own notation for the beta
 * window, not part of the model's name. Probed against 2.1.227. */
export function baseModel(model: string | undefined): string {
  if (!model) return "";
  return model.replace(/\[[^\]]*\]\s*$/, "").replace(/-1m$/, "");
}

/** Are these two ids the same model, differing only in window tier?
 *
 * This is what stops a 1M session from being reported as a 200k one: the
 * per-message id is not a *narrower* model, it is the *same* model with the
 * tier suffix dropped, and it must never be allowed to shrink the ring. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  const x = baseModel(a);
  return x !== "" && x === baseModel(b);
}

/** Did this turn end on a question?
 *
 * Looks at the last non-empty line so a closing question survives being
 * followed by a bulleted list, and tolerates trailing quotes and brackets. */
export function endsOnQuestion(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  return /\?["'`)\]*_]*\s*$/.test(last);
}

/** The note Claude Code writes into the conversation when a turn is stopped.
 *
 * It is the CLI talking *about* the conversation, not words anybody said in
 * it — so both folds have to know it on sight, or a stop appears in the
 * transcript as a prompt you typed. It arrives twice over: as a `user` message
 * on the wire, moments after the interrupt, and as a `user` record in the
 * session file, which is what a restored card reads.
 *
 * Two wordings on this machine's transcripts — `[Request interrupted by user]`
 * when the answer was being written, and `[Request interrupted by user for tool
 * use]` when a tool call was in flight. Matched by shape rather than by the two
 * exact strings, since the tail is plainly a reason and reasons get added. */
export function isStopNote(text: string): boolean {
  return /^\[request interrupted by user\b[^\]]*\]$/i.test(text.trim());
}

/* ── compaction ──────────────────────────────────────────────────────────
 *
 * Folding a full context is the one thing on this wire that takes *minutes*
 * and reports almost nothing while it does. Read out of the 2.1.232 binary and
 * checked against the compactions in this machine's transcripts, the whole
 * account of one is four events:
 *
 *   system/status           status:"compacting"                     it began
 *   system/compact_boundary compact_metadata{pre_tokens,post_tokens,…}  numbers
 *   user                    isSynthetic:true, the summary       what survived
 *   system/status           status:null, compact_result:"success"   it is over
 *
 * and then a fresh `system/init` and a `result`. There is no progress on it:
 * the status enum in the binary is `compacting | requesting | null`, the CLI's
 * own TUI draws nothing but "Compacting conversation…" for the duration, and a
 * real manual compaction in `C--atelier-caravan` reported `durationMs: 187669`
 * — three minutes of one word. So the only honest account of the *wait* is how
 * long it has been, and the account of the *result* is the two token counts and
 * the ring falling; both are drawn rather than the word alone. */

/** What a compaction cost and what it saved. */
export type CompactStat = {
  /** Tokens in context before, and after. `post` is 0 when unreported. */
  pre: number;
  post: number;
  /** How long the fold took, ms. 0 when unreported. */
  ms: number;
  /** `manual` for `/compact`, `auto` when the window filled. */
  trigger: string;
};

/** Read a compaction boundary, from either of the two forms it comes in.
 *
 * The same event is spelled twice over — `compact_metadata` with snake_case
 * fields on the wire (`qEf` in the binary), `compactMetadata` with camelCase in
 * the session file — the same split `system/init` and an `assistant` message
 * make of a model id. Both are taken here so that the live fold and the
 * transcript fold can share one reading and cannot drift. */
export function compactStat(ev: any): CompactStat | null {
  const m = ev?.compact_metadata ?? ev?.compactMetadata;
  if (!m || typeof m !== "object") return null;
  const num = (a: unknown, b: unknown) =>
    typeof a === "number" ? a : typeof b === "number" ? b : 0;
  return {
    pre: num(m.pre_tokens, m.preTokens),
    post: num(m.post_tokens, m.postTokens),
    ms: num(m.duration_ms, m.durationMs),
    trigger: typeof m.trigger === "string" ? m.trigger : "",
  };
}

const kTokens = (n: number): string => (n > 0 ? `${Math.round(n / 1000)}k` : "?");

/** What the compaction is labelled with — the cap on the folded summary, and
 *  the note left behind when there is no summary to fold it into.
 *
 *  The two counts are the whole point: they say the fold worked and how much
 *  room it bought, which is what you went to `/compact` for. The duration is
 *  carried when the boundary reports one, because a three-minute wait you have
 *  just sat through deserves to be named rather than silently forgotten. */
export function compactNote(stat: CompactStat): string {
  const took =
    stat.ms >= 1000 ? ` · ${spanOf(Math.round(stat.ms / 1000))}` : "";
  return `context compacted · ${kTokens(stat.pre)} → ${kTokens(stat.post)}${took}`;
}

/** A duration in the wall's own shorthand — `47s`, `3m 8s`, `1h 4m`.
 *
 *  Coarse above the minute on purpose: this is a thing that happened, read
 *  once, not a timer being watched. */
export function spanOf(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  if (t < 60) return `${t}s`;
  if (t < 3600) {
    const s = t % 60;
    return s ? `${Math.floor(t / 60)}m ${s}s` : `${Math.floor(t / 60)}m`;
  }
  const m = Math.floor((t % 3600) / 60);
  return m ? `${Math.floor(t / 3600)}h ${m}m` : `${Math.floor(t / 3600)}h`;
}

/** The one fixed sentence a compaction summary opens with.
 *
 * It has to be recognised live, and matching on a flag is not available there:
 * the wire's `user` message carries only `isSynthetic`, which is equally true
 * of every other note Claude Code injects, while the `isCompactSummary` that
 * would answer exactly is written to the session file and dropped on the way to
 * stdout (`qEf`'s `user` case names `isSynthetic` and nothing else). The
 * preamble is one string in the binary, is the same for a manual `/compact` and
 * an automatic fold, and reads identically on the wire and on disk — so both
 * folds can ask the same question of the same words.
 *
 * The stakes if it is not asked: the summaries on this machine run 16k–25k
 * characters, and pushed as a `you` line that is a wall of text you appear to
 * have typed — the same failure `isStopNote` and `parseTaskNotification` exist
 * to prevent, at a hundred times the size. */
export function isCompactSummary(text: string): boolean {
  return /^this session is being continued from a previous conversation/i.test(
    text.trim(),
  );
}

/** A skill's whole text, injected into the conversation as though it were said.
 *
 * Invoking a skill does not hand the agent a *result* — it hands it the skill,
 * by putting the file's entire contents into the conversation as a `user`
 * message. Probed 2026-08-18 against claude 2.1.232 with `tools/probe-skill.ts`,
 * spawning with Skein's exact argv; the three records a `Skill` call writes are
 *
 * ```text
 *   tool_result   "Launching skill: design-review"
 *   isSynthetic   "Base directory for this skill: …\design-review\n\n# Collaborative…"
 * ```
 *
 * and the same call on disk writes the body as `isMeta: true` instead. So the
 * two halves of the panel had opposite bugs: `history.ts` drops every `isMeta`
 * record and never drew it at all, while live it fell through to `you` — the
 * whole of a skill as words you appear to have typed. The one on this machine's
 * transcripts that started this runs to 698,364 characters.
 *
 * The same failure as `isStopNote`, `parseTaskNotification` and
 * `isCompactSummary`, and the same fix — except that this one must be readable
 * afterwards, since a skill is the instructions the rest of the card is
 * following. So it folds rather than being dropped, the way the compaction
 * summary does, and the name is the cap: `Base directory` is a path and its last
 * segment is the skill's own directory, which is what the skill is called.
 *
 * Matched on the first line rather than on `isSynthetic` because that field is
 * the wire's alone — nothing on disk carries it — and the panel has to read the
 * same after a restart as it did live. Anchored to the start for the usual
 * reason: a skill *quoted* in an answer is prose, and prose does not fold.
 *
 * `name` is empty when the path is not one — the fold still happens, since what
 * makes it necessary is the size rather than the name. */
export function skillBody(text: string): { name: string } | null {
  const m = /^Base directory for this skill:[ \t]*([^\r\n]*)/.exec(
    text.trimStart(),
  );
  if (!m) return null;
  /* Trailing separators trimmed off first, or a path written with one hands
     back the empty segment after it as the name. */
  const dir = m[1].trim().replace(/[\\/]+$/, "");
  return { name: dir ? basename(dir) : "" };
}

/** A local command as the session file records it, folded into what to draw.
 *
 * Running `/compact` writes *four* `user` records, and only one of them is
 * marked. Taken from a real manual compaction (`tools/probe-compact.ts`, claude
 * 2.1.232):
 *
 * ```text
 *   isMeta:true   <local-command-caveat>Caveat: The messages below were…
 *   (unmarked)    <command-name>/compact</command-name>
 *                 <command-message>compact</command-message>
 *                 <command-args></command-args>
 *   (unmarked)    <local-command-stdout>Compacted </local-command-stdout>
 * ```
 *
 * The caveat carries `isMeta` and is dropped with the rest of the injected
 * context. The other two carry nothing at all, so they were pushed as `you`
 * lines — a block of XML you appear to have typed, and the reason a compacted
 * card read as though somebody had said the word "compact" into it. 61
 * `<command-name>` blocks and 21 `<local-command-stdout>` blocks across this
 * machine's transcripts, every one of them drawn that way.
 *
 * The same failure as `isStopNote` and `parseTaskNotification`, and the same
 * fix: these are the CLI talking *about* the conversation, so they are `meta`.
 * They are not dropped, because running a command is a real thing that happened
 * and the transcript is the record of it — the name is what you did, and the
 * stdout is what it said back.
 *
 * Live this arrives in one case, and this comment used to say it never did.
 * The wire replays only what was written to stdin, so a compaction with nothing
 * queued behind it leaves these records in the session file and nothing else —
 * which is all the probe could see, because it never typed *during* the fold.
 * Queue a prompt behind the `/compact` and they are flushed across the boundary
 * into the new context, where `--replay-user-messages` re-emits them ahead of
 * the queued prompt. From a real one (caravan, claude 2.1.232, 2026-08-19):
 * `/compact` at 00:47:39, a prompt enqueued 00:49:27 and held 47s, the summary
 * at 00:50:13.769, the stdout on the wire at 00:50:14.545. So it is read on both
 * paths — `history.ts` has folded it since it was written, and the live arm in
 * `conversation.svelte.ts` had not, which is why a compacted card read as
 * though you had typed the tag until it was restarted.
 *
 * `null` means *this is not a local command*; an empty `text` means it is one
 * with nothing worth drawing. Conflating the two is a trap rather than a
 * nicety: a command that printed nothing would fall through to being pushed as
 * speech, which is the whole bug, restricted to the quietest commands. */
export function localCommand(text: string): { kind: Line; text: string } | null {
  const t = text.trim();
  const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(t);
  if (stdout) {
    /* A command that printed nothing is a command whose own name, pushed just
       above, has already said everything there is. */
    return { kind: "meta", text: stdout[1].trim() };
  }
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (!name) return null;
  /* The name and its arguments, which is how you would say what you ran.
     `command-message` is the same name without its slash and is dropped —
     drawing it is what put a bare "compact" in the transcript. */
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
  const named = name[1].trim();
  return { kind: "meta", text: named ? (args ? `${named} ${args}` : named) : "" };
}

/* Named apart from `Line` in conversation.svelte.ts, which imports *from* here
   — the dependency only goes one way, so the kind is spelled out rather than
   imported back. */
type Line = "meta";

/** Did somebody stop this turn, or did it break?
 *
 * Nothing else in the `result` event separates the two: a stopped turn arrives
 * wearing every mark of a failed one — `is_error: true`, `subtype:
 * "error_during_execution"`, an `errors` array — and taking those at face value
 * paints a card rust for a thing you did on purpose.
 *
 * `terminal_reason` is the field that says so. Probed against claude 2.1.229
 * (`tools/probe-interrupt.ts`): interrupting mid-answer gives
 * `aborted_streaming`, against `completed` for a clean turn. `aborted_tools` is
 * the other member of that family in the binary — an interrupt landing while a
 * tool call is in flight, which is also what the second wording of the stop
 * note describes. Prefix-matched so a third `aborted_*` reads as stopped rather
 * than as a crash. */
export function wasStopped(result: any): boolean {
  const reason = result?.terminal_reason;
  return typeof reason === "string" && reason.startsWith("aborted");
}

/** The CLI's own answer to a turn no model ever saw.
 *
 * `/compact`, `/model` and `/effort` are answered by the binary itself: the
 * whole reply is one line in `result.result` ("Set model to Sonnet 5 for this
 * session only"), and the only `assistant` message is a `<synthetic>` one with
 * empty content. So a card that ran one showed the prompt, nothing after it,
 * and settled at rest — the gesture appeared to do nothing at all.
 *
 * `num_turns` is what separates this from an ordinary turn, and it is exact
 * rather than a heuristic: it counts the round trips to a model, so zero means
 * nothing was asked of one. Probed 2026-08-14 against claude 2.1.232
 * (`tools/probe-commands.ts`) — every local command answered with `num_turns:
 * 0`, `duration_api_ms: 0` and an all-zero `usage`, where the rate-limited turn
 * beside them still reported 1.
 *
 * Deliberately not consulted for an *errored* turn: `endingFor` already reads
 * `result.result` as the detail there, and drawing it twice would put the same
 * sentence in the transcript as both a note and a fault. */
export function localAnswer(result: any): string | null {
  if (result?.num_turns !== 0) return null;
  const said = result?.result;
  return typeof said === "string" && said.trim() ? said.trim() : null;
}

/** Which awaited prompt a locally-answered turn was answering — the one whose
 *  echo is never coming.
 *
 *  `--replay-user-messages` echoes back what we wrote to stdin, and that echo
 *  is the whole of how `#claimEcho` closes the books on a line. **A prompt the
 *  CLI answers itself is never replayed.** Probed 2026-08-25 with
 *  `tools/probe-echo.ts` against Skein's exact argv:
 *
 *    → "say only: ok"    ← USER REPLAY "say only: ok"   result num_turns=1
 *    → "/model sonnet"     (no user event at all)       result num_turns=0
 *    → "say only: done"  ← USER REPLAY "say only: done" result num_turns=1
 *
 *  So the line stayed `awaited` for the life of the process, `awaiting` never
 *  returned to zero, and three things followed and did not stop: the card read
 *  `sent, not picked up` for ever, every subsequent `result` scheduled a prompt
 *  nudge until the budget was gone, and — because `promptNudgeAttempts` is only
 *  refunded when `awaiting` hits zero — a *real* stall later in that session got
 *  no nudge at all, the allowance having been spent on the false one. `/compact`
 *  is the ordinary way in, which is to say every long card eventually.
 *
 *  `num_turns` is what identifies the turn and it is exact rather than a
 *  heuristic — see `localAnswer`. What it does *not* carry is which prompt it
 *  answered, and that is the reason this is a search and not an index. Guessing
 *  wrong is the double-draw bug `#settleEchoes` was rewritten to avoid: claim
 *  the real prompt queued behind a `/compact` and it is marked delivered when it
 *  is still in the queue, and its own echo then finds nothing to claim and draws
 *  your words on the wall a second time.
 *
 *  Hence the leading slash, which is a deliberate narrowing rather than a
 *  guess at the catalogue. Skein cannot know which commands this build answers
 *  locally — a custom `/commit` is a real prompt and reaches a model — but it
 *  does not have to: *every* locally-answered command is a slash command, and
 *  no ordinary prompt starts with one. So the test is sound in the direction
 *  that matters. What it trades away is a locally-answered turn caused by
 *  something that is not slash-shaped, which would go on leaking exactly as
 *  before; nothing on this machine has ever produced one.
 *
 *  Oldest first, for the reason `#echoOf` is: delivery is sequential, so with
 *  two commands outstanding the answer belongs to the earlier. */
export function localCommandAwaiting(awaited: string[]): string | null {
  return awaited.find((t) => t.trim().startsWith("/")) ?? null;
}

/** Decide how a turn ended, from the `result` event and the turn's text. */
export function endingFor(
  result: any,
  turnText: string,
  sawAskTool: boolean,
): { ending: Ending; detail: string | null } {
  /* Ahead of the error test, and that is the whole point of it. */
  if (wasStopped(result)) return { ending: "stopped", detail: null };
  if (
    result?.is_error ||
    result?.api_error_status ||
    (result?.subtype && result.subtype !== "success")
  ) {
    /* The message before the status, which is the opposite of how this read
       for most of the app's life and is worth saying why. `api_error_status`
       is usually the bare number — so `lastError`, the transcript's error line
       and the card's activity all said `400` and nothing else, while the
       sentence that explained it ("the request body is not valid JSON:
       unexpected end of data…") sat one line above in the transcript because
       the *CLI* had printed it. Skein's own account of a failure was the least
       informative thing on the card. The status is still the fallback, since a
       `rate_limit_error` with nothing said is better than "unknown error". */
    const said =
      typeof result?.result === "string" && result.result.trim()
        ? result.result.trim()
        : null;
    return {
      ending: "error",
      detail: said ?? result?.api_error_status ?? result?.subtype ?? "unknown error",
    };
  }
  if (sawAskTool) return { ending: "asked", detail: null };
  if (endsOnQuestion(turnText)) return { ending: "question", detail: null };
  return { ending: "ok", detail: null };
}

/* ── turns worth trying again ───────────────────────────────────────────────
 *
 * Four failures, and they are the only four a card may answer by itself. Every
 * other one has to be assumed to have done something, and a project card spawns
 * with `--dangerously-skip-permissions` — "send the last thing again" is the
 * most dangerous reflex this app could be given, and it is affordable only where
 * the thing being repeated demonstrably had no effect.
 *
 * Three of them share the property that licenses it outright: the request did
 * not get a turn out of a model, so re-sending repeats nothing.
 *
 * Note what that argument does *not* say. A turn is many requests, and the ones
 * before the failing one may well have written files. Re-sending is still right:
 * the retry resumes the same session, so the agent reads back everything it
 * already did rather than starting the work over blind. What must not happen is
 * a repeat of a request that *itself* had an effect.
 *
 * **`dropped` is the fourth and it does not clear that bar the same way**, and
 * pretending otherwise would be the way this list gets a fifth member it should
 * not have. A connection lost mid-response *did* get a turn out of a model — the
 * partial answer is right there in the transcript, and there is a window in
 * which a completed `tool_use` was among the blocks that arrived and was run.
 * It is admitted on the second half of the argument rather than the first, and
 * the reason is a property of the CLI rather than of the network: **it commits
 * the partial before it reports the failure.** The blocks that arrived get a
 * `stop_reason` forced onto them and are written to the session; a tool that ran
 * has its `tool_result` written there too. So the re-send does not repeat the
 * request — it resumes a session that already holds whatever that request
 * achieved, and the agent reads it back. The failure this list must keep out is
 * the one whose effect landed *outside* the session and was never recorded; a
 * dropped stream is not that, and it is worth being able to say which of the two
 * a new kind is before adding it.
 *
 * The honest residue: the re-sent text is your prompt again, so a card that had
 * already written half an answer is being asked for the whole of it a second
 * time. That is waste rather than danger, and the alternative — Volery composing
 * a "carry on" of its own — puts words in your mouth to save tokens. Measured
 * against every occurrence on this machine it is close to free anyway: four of
 * the six had produced nothing but an empty thinking block when the wire went.
 */

export type HealKind =
  /** The body arrived truncated — 400, "not valid JSON". Transport. */
  | "malformed"
  /** 529, the API is overloaded. Somebody else's weather. */
  | "overloaded"
  /** 429, this account's allowance. Not weather and not transport — the one
   *  failure another *account* fixes, which is why it is a heal at all. See
   *  `.claude/rules/accounts.md`. */
  | "limited"
  /** The stream died under the turn — the link went, not the service. No
   *  status at all; see `wasConnectionDropped`. */
  | "dropped";

/** The error text of a turn that actually failed, lowercased, or "".
 *
 *  The gate matters more than it looks. `result.result` on a *successful* turn
 *  is the agent's own final message — so without this, a card that answered a
 *  question about a 529 by quoting one would have been read as having hit one,
 *  and Skein would have re-sent your prompt on the strength of the agent
 *  talking about the weather. In this repository that is not a hypothetical.
 *
 *  Both callers happen to be behind `ending === "error"` already, so this is
 *  belt to that braces rather than a bug being fixed. It is here because the
 *  next caller will not know to stand there, and because a predicate that is
 *  only safe in one place is a trap with a good view.
 *
 *  Numbers are read as well as strings: `api_error_status` arrives as one about
 *  as often as not, and a status silently ignored for having the wrong type is
 *  the same class of quiet miss as a misspelled Tauri arg name. */
function faultText(result: any): string {
  const failed =
    result?.is_error ||
    result?.api_error_status ||
    (result?.subtype && result.subtype !== "success");
  if (!failed) return "";
  return [result?.api_error_status, result?.result, result?.error]
    .map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : ""))
    .join(" ")
    .toLowerCase();
}

/** The request never left intact: 400, with the body cut short.
 *
 * The API answers "The request body is not valid JSON: unexpected end of data:
 * line 1 column 429454 (char 429453)" — the conversation was serialised and
 * arrived truncated.
 *
 * Both halves are required, and that is the whole care in this predicate. A
 * bare 400 is the API refusing the *content* of a request — a parameter out of
 * range, a model that does not exist — and those are deterministic: retrying
 * one is a loop that ends when the allowance does. It is the invalid-JSON
 * wording that says the body was mangled in transit rather than wrong on its
 * face.
 *
 * Observed 2026-08-18, in this repo's own session: two consecutive failures at
 * column 429453 and 429489 — near-identical bodies, so near-identical
 * conversations — then a third attempt with the same conversation that went
 * through. A truncation that repeats at the same size and then stops is
 * transport, not a poisoned record; if it were the latter no number of retries
 * would help and the repair would have to be a fresh session, which costs the
 * card its context. */
export function wasMalformedRequest(result: any): boolean {
  const said = faultText(result);
  if (!said.includes("400")) return false;
  return said.includes("not valid json") || said.includes("unexpected end of data");
}

/** The service is over capacity: 529.
 *
 * Unlike the 400 above, one signal is enough — "overloaded" is not a word the
 * API uses for anything else, and 529 is not a status with a second meaning.
 * The care that predicate spends on avoiding a false positive is spent here by
 * `faultText` instead, since the likelier confusion is an *answer* about an
 * overload rather than another kind of failure.
 *
 * Deliberately not extended to 429. A rate limit is not weather — it is the
 * account's own allowance, it is reported by the horizon
 * (`.claude/rules/usage.md`), and it clears at a time that is *known* rather
 * than guessed at. Retrying into one is asking the same question of a door
 * whose opening hour is written on it. */
export function wasOverloaded(result: any): boolean {
  const said = faultText(result);
  return said.includes("529") || said.includes("overloaded");
}

/** Which of the two this was, or null for a failure a card must not touch. */
/** The account ran out: 429.
 *
 * **Probed 2026-08-21, and the wording it was written from was wrong.** This
 * predicate used to say it had never met a real refusal, and asked for the
 * wording when somebody hit one. Somebody did — 38 refusals across eight
 * sessions on this machine between 2026-08-11 and 2026-08-21 — and none of them
 * matched, so the reactive half of the account waterfall had never once fired.
 * The card failed, said nothing about an account, and sat there refusing every
 * prompt in under a second until it was nudged by hand. That is the sink item
 * this fixes, and it is worth stating plainly: *a predicate written from a
 * documented shape rather than an observed one is a feature that has never run.*
 *
 * What actually arrives is not the API's `rate_limit_error` at all — the CLI
 * catches the 429 and **composes its own sentence**, which is then the whole of
 * `result.result`:
 *
 * ```text
 * You've hit your session limit · resets 9:10pm (Australia/Sydney)
 * You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)
 * ```
 *
 * From claude 2.1.235's own bundle, which builds it and names every window it
 * can name:
 *
 * ```js
 * function DYe(e, t, r, n) {            // e is the window, t the reset clause
 *   let o = n?.progressSavedSuffix ? " · progress saved" : "";
 *   return `You've hit your ${e}${t}${o}`
 * }
 * APt = { five_hour: "session limit", seven_day: "weekly limit",
 *         seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet limit",
 *         seven_day_overage_included: "Fable 5 limit",
 *         overage: "usage credit limit" }
 * ```
 *
 * — plus `"individual usage limit"`, `"individual spend limit"` and
 * `"monthly spend limit"` from the same table's neighbours. So the wording is
 * matched at `hit your`, ahead of the window name: the *name* is a list that
 * grows with every new plan tier, and a predicate enumerating it would go quiet
 * again the next time one is added, in exactly the silent way this one did.
 * The CLI's own detector is the same shape — a `You've hit your` prefix and no
 * window names in it.
 *
 * Two signals still, which is the whole care here: an agent that ran something
 * against another rate-limited service and reported the status must not move
 * the card onto the subscription being held in reserve. The status gate is
 * `api_error_status`, which the same bundle shows is set from the message's own
 * `apiErrorStatus` on both `result` builders and was `429` on all 38 —
 * so the observed refusal passes it, and a sentence an agent merely quoted
 * cannot pass it without a 429 of its own.
 *
 * Deliberately does **not** match `"You've used"` or `"You're close to"`, which
 * are that same bundle's *warning* strings for an allowance getting low. A card
 * that swapped account on a warning would leave the reserve for nothing.
 *
 * And deliberately not `"quota"`, which is Bedrock's and Vertex's word: an
 * account on either has no OAuth windows and no second account to fall to, so
 * swapping would be a card thrashing between spawns. */
export function wasRateLimited(result: any): boolean {
  const said = faultText(result);
  if (!said.includes("429") && !said.includes("rate_limit")) return false;
  return (
    said.includes("rate_limit") ||
    /* The CLI's own composed refusal, which is what actually arrives. */
    said.includes("hit your") ||
    said.includes("reached your") ||
    said.includes("out of usage credits") ||
    /* And the raw API wordings this was written from, kept because a refusal
       that comes through unmediated is still a refusal. */
    said.includes("usage limit") ||
    said.includes("rate limit") ||
    said.includes("limit reached") ||
    said.includes("limit exceeded")
  );
}

/** The link under the turn gave out: no status, and the CLI's own sentence.
 *
 * **Read out of claude 2.1.241's bundle and confirmed against all 292 session
 * transcripts on this machine**, because this one cannot be spotted by status —
 * there is no status. When a response stream dies part-way the CLI does not
 * fail the request and does not retry it. It *finalizes what it has*: forces a
 * `stop_reason` onto the blocks already yielded, then appends a synthesized
 * assistant message — `model: "<synthetic>"`, `isApiErrorMessage: true`,
 * `error: "server_error"` — whose whole content is one of six sentences off a
 * single ternary:
 *
 * ```text
 * API Error: Connection lost mid-response. The response above may be incomplete.
 * API Error: The response stopped arriving. The response above may be incomplete.
 * API Error: Your computer went to sleep mid-response. The response above …
 * API Error: Connection lost before a response was produced. Try again.
 * API Error: The response stalled before a response was produced. Try again.
 * API Error: Your computer went to sleep before a response was produced. …
 * ```
 *
 * That message is then the last one of the turn, so the `result` reads
 * `subtype: "success"`, `api_error_status: null`, **`is_error: true`**, and
 * `result` is the sentence. `endingFor` therefore already says `error` and the
 * card already goes rust — what was missing was any predicate that matched it,
 * since every existing one asks for a number.
 *
 * Observed six times in three weeks, plus twice as `Unable to connect to API
 * (ENOTFOUND)`, which is the same failure one layer earlier and is included.
 * **Deliberately not `Server error mid-response`**, the seventh sentence off
 * that same ternary: that one is the service answering badly rather than the
 * link going, and its ladder is the overloaded one. Nothing on this machine has
 * ever produced it, and a predicate written for a shape nobody has met is the
 * mistake `wasRateLimited` spent four months making.
 *
 * Two signals, for the reason `wasMalformedRequest` uses two. The cause phrase
 * alone would match a tool's own output — an agent that ran a `curl` which said
 * `connection lost`, in a turn that then failed some other way, would be read as
 * having dropped the wire. `API Error:` is the CLI's marker on a message it
 * synthesized itself, and a tool's stderr does not wear it. `faultText` is still
 * the gate that keeps an agent *talking* about a dropped connection out. */
export function wasConnectionDropped(result: any): boolean {
  const said = faultText(result);
  if (!said.includes("api error")) return false;
  return (
    said.includes("connection lost") ||
    said.includes("went to sleep") ||
    said.includes("stopped arriving") ||
    said.includes("response stalled") ||
    said.includes("unable to connect to api")
  );
}

/** Which of the four this was, or null for a failure a card must not touch.
 *
 *  Rate limiting is tested **first**. A 429 that also happened to carry the
 *  word "overloaded" would otherwise be waited out on the overload ladder — up
 *  to five minutes, four times over — when there is another account sitting
 *  idle that would have answered at once. Of the three, this is the only one
 *  whose fix is not waiting. */
export function healKindOf(result: any): HealKind | null {
  if (wasRateLimited(result)) return "limited";
  if (wasMalformedRequest(result)) return "malformed";
  if (wasOverloaded(result)) return "overloaded";
  /* Last, and it cannot take a tie from the three above it: none of the six
     sentences it matches carries a status, and none of the three above it
     matches without one. */
  if (wasConnectionDropped(result)) return "dropped";
  return null;
}

/** How many times a card will try each kind again before it gives up.
 *
 *  Two for a truncation, because the failure it was written from took two
 *  before it cleared and a bound that cannot survive its own motivating case is
 *  decoration.
 *
 *  Four for an overload, because it is a different sort of waiting. A
 *  truncation either recurs immediately or is gone; an overload is a queue
 *  somewhere else draining, and the useful question is whether the card is
 *  still willing to ask in five minutes. It is not more than four because every
 *  attempt is a whole conversation back over the wire and the wall can have
 *  twenty cards on it. */
export const HEAL_BUDGET: Record<HealKind, number> = {
  malformed: 2,
  overloaded: 4,
  /* Not what actually bounds this one — the accounts do. Each attempt moves the
     card to the next account in the waterfall, so a wall with three of them
     runs out of accounts before it runs out of budget, and when it does the
     card is *held* rather than failed (`skein.svelte.ts`), which is the honest
     end of the ladder. This is a backstop against a 429 no swap resolves: an
     org-level limit answers the same on every account, and unbounded the card
     would re-send its whole conversation once per account forever. */
  limited: 4,
  /* Three, and it is the measurement rather than a feel. Every drop on this
     machine was over in seconds — another card was answering normally 3.9s,
     5.1s and 14.2s after the three that could be timed — so three attempts
     spanning about eighty-five seconds cover the observed outage several times
     over. Not more, because a card whose link is still down after a minute and
     a half is not having a blip, and every attempt is a whole conversation back
     up the connection that just failed. */
  dropped: 3,
};

/** How long to wait before attempt `n`, and `jitter` is a 0–1 the caller rolls.
 *
 *  The two ladders are different because the two failures are.
 *
 *  A truncation is this card's own bad luck, so the wait is for *you*: a card
 *  that fails and re-sends inside the same tick reads as a card that did
 *  nothing at all, and the note saying it is trying again would be gone before
 *  it could be read. A second is long enough to see.
 *
 *  An overload starts at fifteen seconds because by the time one reaches a
 *  `result` the CLI has already spent its own internal retries on it — the
 *  binary backs off and re-asks before it will report an error at all. So a
 *  card retrying a second later is not being eager, it is asking a question
 *  that has just been asked several times and answered the same way. The ladder
 *  runs 15s → 45s → 2m → 5m for that reason: the thing being waited on is a
 *  queue somewhere else draining, and it drains on its own schedule.
 *
 *  The jitter is only on the overloaded arm, and it is there because an
 *  overload is the one failure that arrives *at every card at once*. Twenty
 *  cards on a wall all failing on the same weather, all waiting exactly fifteen
 *  seconds, all re-sending a whole conversation in the same tick, is a
 *  thundering herd aimed at a service that has just said it is over capacity.
 *  Spreading them over a quarter of the window costs nothing and is the same
 *  instinct as `ROUSE_GAP_MS` in the rousing queue. A truncation needs none of
 *  this: it is one card's transport, and two cards hitting it together is a
 *  coincidence rather than a cause. */
export function healDelayMs(kind: HealKind, attempt: number, jitter: number = 0): number {
  /* A rate limit does not wait, because waiting is what the other accounts are
     for: the next attempt goes to a different subscription, and a second spent
     sitting here is a second of an allowance that was never the problem. The
     one second is for the reader rather than the API — the argument the
     `malformed` arm makes — so the note saying the card is moving is on screen
     long enough to be read. Where no account is left this never fires at all;
     that path is a hold, not a heal. */
  if (kind === "limited") return 1_000;
  if (kind === "malformed") return attempt <= 1 ? 1_000 : 4_000;
  /* Both of the remaining kinds are jittered, and for the same reason applied
     to two different shared things. `dropped` starts at five seconds because
     that is where the measurement puts it and because — unlike the 529 — the
     CLI has spent *no* backoff of its own: it finalizes the partial and gives
     up on the first drop, which is how three cards on this wall produced the
     error 48ms apart. Nothing has been waited yet when Volery gets it, so
     nothing is owed to a queue; what is owed is a moment for the link to come
     back, and a second or two is not it. */
  const ladder =
    kind === "dropped" ? [5_000, 20_000, 60_000] : [15_000, 45_000, 120_000, 300_000];
  const base = ladder[Math.min(Math.max(attempt, 1), ladder.length) - 1]!;
  const spread = Math.min(Math.max(jitter, 0), 1);
  return Math.round(base * (1 + 0.25 * spread));
}

/** Roughly how long, for a line somebody reads rather than a field somebody
 *  parses. Seconds under a minute, whole minutes above it — a card that says
 *  "in 2m" and goes at 2m07s has told the truth as it was asked for. */
export function saySoon(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** What the transcript says when a card is about to try again.
 *
 *  Said out loud, and counted, because the alternative is a card that quietly
 *  re-sends your prompt. Skein spawns with `--dangerously-skip-permissions`;
 *  the one thing an app like that owes you is that nothing it does on its own
 *  is invisible afterwards. The count is in the line so a transcript read back
 *  cold says how much of the bill was retries, and the wait is in it because a
 *  card that has gone quiet for five minutes should not need the reader to
 *  guess whether it is thinking or waiting. */
export function healNote(kind: HealKind, attempt: number, waitMs: number): string {
  const tail = `trying again in ${saySoon(waitMs)} (${attempt} of ${HEAL_BUDGET[kind]})`;
  if (kind === "limited") return `this account is out of allowance — ${tail}`;
  if (kind === "dropped") return `the connection dropped — ${tail}`;
  return kind === "malformed"
    ? `the request was cut short on the way out — ${tail}`
    : `the api is overloaded — ${tail}`;
}

/** And what it says when they are spent. The card goes rust either way — this
 *  is so the rust has an account behind it rather than one bare status.
 *
 *  The truncated arm used to end "the conversation may be too large to send",
 *  and it was a guess wearing the clothes of a finding. Probed 2026-08-19 on
 *  the session that failed three times: 700 KB, nowhere near a limit, and the
 *  actual cause was 1,222 NUL characters a `grep -a` over `claude.exe` had put
 *  in one tool result. A reader who believed the line would have gone looking
 *  to trim a conversation that was the wrong size for exactly nothing. So it
 *  now says what happened and stops — `repair.ts` is what says *why*, on the
 *  occasions Skein has actually looked and knows. **A line that names a cause
 *  must have checked one**; the wall's whole claim to be an instrument rests on
 *  not narrating past what it measured. */
export function healGaveUpNote(kind: HealKind): string {
  if (kind === "limited") {
    /* Named as the thing it probably is. A 429 that survives being asked on
       every account is not this account's five-hour window — it is a limit
       above the account, and pointing somebody at a reset that is not the one
       stopping them is worse than saying nothing. */
    return `still rate limited after ${HEAL_BUDGET.limited} tries across the accounts — leaving it, this may be a limit above the account`;
  }
  /* Names the network rather than the API, which is the whole finding: this
     failure arrives with no status on it and every other line on the card would
     otherwise have you looking at a service that was never the problem. */
  if (kind === "dropped") {
    return `the connection dropped ${HEAL_BUDGET.dropped} more times — leaving it, send again once the network is back`;
  }
  return kind === "malformed"
    ? `cut short ${HEAL_BUDGET.malformed} more times — leaving it, send again to try once more`
    : `still overloaded after ${HEAL_BUDGET.overloaded} tries — leaving it, send again when it clears`;
}
