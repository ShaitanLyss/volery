/* A dev server's own words, hung on the wall.
 *
 * The other instruments in the catalogue read something nobody else is
 * watching — a clock, a process table, an allowance. This one reads a thing the
 * app already holds: `servers.rs` pipes every group's stdout and stderr up as
 * `server:log`, and `GroupRuntime.log` is where the wall keeps it. So there is
 * no sampler here and nothing to attach to, which is the whole reason a
 * `Servers` holder was not invented for it: the lines arrive as events and this
 * is a second reading of state that is already live. See `.claude/rules/servers.md`
 * for why they arrive through pipes rather than a pseudo-terminal, and
 * `ansi.ts` for how the colour survives that.
 *
 * The first of three log widgets, and the one the other two were cut out of:
 * what any log needs — how many lines fit, which subject it is about, what a
 * filter that emptied the pane owes you — is in `logface.ts`, and what is left
 * here is everything that is true of a *dev server group* and of nothing else.
 * A group has ports and per-server health and a button that starts it; a build
 * has a verdict, an editor log has verbosities. Three subjects, three widgets,
 * one substrate.
 *
 * Pure — no runes, no DOM — so which group a widget is about, what a filter
 * hides, and what to say about a server that is not saying anything are all
 * testable directly. `ServerLog.svelte` draws it. */

import { foldTail, type Row } from "./logface";

/** What one server in a group is doing.
 *
 * The same four states `servers.rs` emits, mirrored structurally rather than
 * imported: `ServerHealth` lives in `skein.svelte.ts`, which is a rune file,
 * and this one is on the other side of the purity boundary. */
export type Health = "idle" | "starting" | "up" | "exited";

/** One line a server printed, as the wall holds it. `stderr` is real — one
 *  reader per pipe, which is what made it true (it was hardcoded `false` for
 *  every line ever emitted under the merged PTY reader). */
export type LogLine = { label: string; line: string; stderr: boolean };

/** A group printing faster than anything can read (`servers.rs`'s `FLOOD`):
 *  lines a second, how long the wall will let it go on, and whether the wall
 *  has already stopped it for this. */
export type Flood = { rate: number; stopsIn: number | null; stopped: boolean };

/** A batch of `server:log` folded into a log of at most `cap` lines.
 *
 *  `skipped` is lines that went by too fast for the wall to be handed at all
 *  (`crate::sluice`), and they get one line saying so rather than nothing: a
 *  log that silently began in the middle reads as the whole log. A fresh array
 *  every time — `GroupRuntime.log` is `$state.raw`, which invalidates on
 *  identity, and one copy per batch is the whole point of batching. */
export function foldLog(
  log: readonly LogLine[],
  lines: readonly LogLine[],
  skipped: number,
  cap: number,
): LogLine[] {
  const gap: LogLine | null =
    skipped > 0
      ? { label: "volery", line: `… ${skipped.toLocaleString("en")} lines went by too fast to draw`, stderr: false }
      : null;
  return foldTail(log, gap, lines, cap);
}

/** A group, as much of one as a log needs to draw itself.
 *
 * Flat and structural rather than `GroupRuntime`, for the reason `Health` is:
 * the adapting happens once, in `App.svelte`, beside the `chipsFor` that
 * already flattens the same groups for a territory's chips. */
export type Reading = {
  id: string;
  label: string;
  /** Whose server this is, in words. A widget belongs to no project — see the
   *  head of `widgets.ts` — so a log has to say which one it is a log of, or
   *  two walls' worth of `dev` are the same three letters. */
  project: string;
  running: boolean;
  overall: Health;
  servers: { label: string; port: number | null }[];
  health: Record<string, Health>;
  log: LogLine[];
  /** Absent or null unless the group is flooding, or was stopped for it. */
  flood?: Flood | null;
};

/** Whether this group counts as the one to follow — the `live` a subject knob
 *  set to "whichever is running" resolves through. Asked of `running` rather
 *  than of `overall`, so a group whose server crashed a second ago is still
 *  the one you are watching rather than being skipped for a quiet one. */
export const isLive = (g: Reading) => g.running;

/** The dot, in the shared vocabulary the three log faces share. `starting` is
 *  pending rather than live: it has not bound its port yet, and a celadon dot
 *  on a server that is about to fail to start is a reading that was too keen. */
export function pulseOf(h: Health): "idle" | "live" | "pending" | "dead" {
  return h === "up" ? "live" : h === "starting" ? "pending" : h === "exited" ? "dead" : "idle";
}

/** What the `showing` knob narrows to, as a predicate or null for everything.
 *
 * The first thing in the app to read `LogLine.stderr`, which only became true
 * when the pseudo-terminal came off and each pipe got its own reader — under one
 * merged reader the field was hardcoded `false` for every line ever emitted.
 * See `.claude/rules/servers.md`. */
export function keeping(showing: string): ((l: LogLine) => boolean) | null {
  return showing === "stderr" ? (l) => l.stderr : null;
}

/** In the words the empty-pane sentence needs. */
export const NARROWING: Record<string, string> = { stderr: "on stderr" };

/** A server's lines as the shared tail draws them: the label in the gutter, and
 *  a tone that says which pipe it came down and nothing more. Which pipe is the
 *  only judgement available here — a line on stderr is not necessarily bad
 *  news, so it marks the gutter and never the text (see `LogTail`'s `tint`). */
export function rowsOf(lines: LogLine[]): Row[] {
  return lines.map((l) => ({
    mark: l.label,
    tone: l.stderr ? ("fail" as const) : ("plain" as const),
    text: l.line,
  }));
}

/** The last thing each server in the group said.
 *
 * The other reading: a group of two is two lines rather than a scroll, which is
 * what a log dropped to the size of a card can still say — "ready in 342ms",
 * "compiled with 1 error". Walked backwards and stopped as soon as every server
 * has answered, so a group whose last line is recent costs a few comparisons
 * rather than the length of the log.
 *
 * Every server in the group gets a row whether or not it has spoken, because
 * the silent one is the interesting one. */
export function latest(
  servers: { label: string }[],
  log: LogLine[],
  showing: string,
): { label: string; line: string | null; stderr: boolean }[] {
  const want = new Set(servers.map((s) => s.label));
  const found = new Map<string, LogLine>();
  const keep = keeping(showing);
  for (let i = log.length - 1; i >= 0 && found.size < want.size; i--) {
    const l = log[i];
    if (!want.has(l.label) || found.has(l.label)) continue;
    if (keep && !keep(l)) continue;
    found.set(l.label, l);
  }
  return servers.map((s) => {
    const l = found.get(s.label);
    return { label: s.label, line: l?.line ?? null, stderr: !!l?.stderr };
  });
}

/** Whether this group is down, and what to call the gesture that starts it.
 *
 * **A crashed group is down**, and that is the half this would have got wrong:
 * `running` is a flag the wall sets when it asks for a start and clears when it
 * asks for a stop, so a server that exited on its own — a port already bound, a
 * config that will not parse, a compiler that gave up — comes back `running:
 * true, overall: "exited"`. A start button that appeared only for a group
 * nobody had started would be missing from exactly the case you are looking at
 * the log to understand.
 *
 * `word` is what stands in for the log while there is none worth drawing, and
 * is null once the thing is up: then the reading is the lines, and a widget
 * narrating "it is running" over the top of its own output is a label on a
 * window. */
export function standing(g: Reading): {
  down: boolean;
  word: string | null;
  verb: "start" | "start again" | "restart";
} {
  if (!g.running) {
    if (g.flood?.stopped) {
      return {
        down: true,
        word: "stopped by the wall — it was flooding its log",
        verb: "start again",
      };
    }
    return { down: true, word: "not started", verb: "start" };
  }
  /* Ahead of everything else a running group can be: a flood is the one state
     where the scroll itself is useless — the same failure a thousand times a
     second — so the face says what is happening instead of drawing it. The log
     is still whole in the servers panel and in `server_log`. */
  if (g.flood) {
    const rate = `~${g.flood.rate.toLocaleString("en")} lines a second`;
    const when = g.flood.stopsIn === null ? "" : `; the wall stops it in ${g.flood.stopsIn}s`;
    return { down: true, word: `flooding its log — ${rate}${when}`, verb: "restart" };
  }
  if (g.overall === "exited") {
    const out = g.servers.filter((s) => g.health[s.label] === "exited").length;
    return {
      down: true,
      /* Which of them went is on the chips already; what the body owes is
         whether the group as a whole has stopped saying anything. */
      word: out < g.servers.length ? "one of them exited" : "exited",
      verb: "start again",
    };
  }
  /* Starting, up, or asked for and not yet heard from — one answer, because all
     three are a group nobody needs to press anything about. What the pane says
     while a starting group has printed nothing is the pane's own business: it
     knows whether the filter emptied it, and this does not. */
  return { down: false, word: null, verb: "start again" };
}

/** The two absences, in this subject's words. Neither is a fault: one is a wall
 *  with nothing to point a log at yet, the other is a group deleted out from
 *  under a widget that named it — and the second must say so rather than
 *  quietly showing somebody else's output. */
export function absence(because: "none" | "gone"): string {
  return because === "gone"
    ? "the group this was set to is not on the wall any more — right-click to pick another"
    : "no dev server groups yet — the servers panel is where a project gets one";
}

/** How a group names itself on the wall: the project, then the group.
 *
 * One function so the header and the menu cannot disagree about it — the menu
 * is the only place you can pin a widget to a particular group, and it would be
 * a poor menu that offered five entries all reading `dev`. */
export function nameOf(g: { project: string; label: string }): string {
  return g.project ? `${g.project} · ${g.label}` : g.label;
}

/** What the `groups` source resolves to for the right-click, in the order the
 *  wall holds them. Pure so the ordering is testable; the caller supplies the
 *  groups because they live in a rune. */
export function groupOptions(groups: Reading[]): { value: string; label: string }[] {
  return groups.map((g) => ({ value: g.id, label: nameOf(g) }));
}
