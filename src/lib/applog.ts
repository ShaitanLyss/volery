/* The app's own log, read.
 *
 * The fourth log over `logface.ts`'s substrate, and the simplest member of the
 * family — see `.claude/rules/widgets.md` on the three that came before. Where a
 * server log picks a group and a build log picks a project, this has **no
 * subject to pick**: there is one process and it says one stream of things. So
 * there is no `subjectOf`, no options list and no absence to explain, and the
 * whole of the knob surface is how much of it to show.
 *
 * Pure by the boundary in CLAUDE.md, tested directly. `applog.rs` owns the ring
 * and the level filter; what is here is what a line means once it has arrived.
 *
 * ### Why there is a fourth log at all
 *
 * Until 2026-08-28 this app installed no `log` sink, so every `info!`, `warn!`
 * and `error!` in every dependency was formatted and dropped. It cost a day:
 * librespot spent four minutes explaining, on a twenty-one-second cadence,
 * exactly why Spotify would not connect, and recovering those lines took a
 * throwaway cargo crate and four browser sign-ins. `applog.rs` has the whole
 * account. This is the face on it.
 */

import { emptyBecause, type Row, type Tone } from "./logface"

/* ── what a line is ────────────────────────────────────────────────────────*/

/** The five `log` levels, lowercased. Mirrors `Line::level` in `applog.rs`. */
export type Level = "error" | "warn" | "info" | "debug" | "trace"

/** One line as `applog.rs` sends it. Mirrors `Line`. */
export type LogLine = {
  /** Milliseconds since the epoch, stamped in Rust when the line was *said* —
   *  an event can queue, so the front end must not time it on arrival. */
  at: number
  level: Level
  /** The emitting module path, `librespot_core::session` and so on. */
  target: string
  text: string
}

/** The levels in order, loudest first — the order the narrowing menu offers and
 *  the order `atLeast` compares in. Exported so a test can assert the menu and
 *  this are the same set, which is the seam `spotify.ts::LAYOUTS` guards too. */
export const LEVELS: Level[] = ["error", "warn", "info", "debug", "trace"]

/* ── reading a line ────────────────────────────────────────────────────────*/

/**
 * How loud a line is, as the gutter draws it.
 *
 * Three tones rather than five levels, because `logface`'s `Tone` is shared with
 * three other faces and a log's gutter is two characters wide. `debug` and
 * `trace` are plain: they are not calm, they are *ordinary*, and a wall that
 * tinted them would be a wall permanently the colour of its own plumbing.
 */
export function toneOf(level: Level): Tone {
  if (level === "error") return "fail"
  if (level === "warn") return "warn"
  return "plain"
}

/**
 * The short word in the gutter: the last segment of the module path.
 *
 * `librespot_core::session` reads as `session`, which is the part that says
 * *where* without spending the width. The crate is recoverable from the line
 * itself nine times in ten, and when it is not, the full target is on the row's
 * `title` — the same bargain the server log strikes with its label.
 */
export function markOf(target: string): string {
  const tail = target.split("::").pop() ?? target
  return tail.length > 0 ? tail : target
}

/**
 * Is `level` at least as loud as `floor`?
 *
 * Compared by position in `LEVELS` rather than by a numeric map, so there is one
 * declaration of the ordering and the menu cannot drift from the comparison.
 */
export function atLeast(level: Level, floor: Level): boolean {
  const a = LEVELS.indexOf(level)
  const b = LEVELS.indexOf(floor)
  /* An unknown level is kept rather than dropped. A newer build's vocabulary
     arriving at an older face should be visible, not silently filtered — the
     same bargain `applyEvent`'s default arm strikes. */
  if (a < 0 || b < 0) return true
  return a <= b
}

/* ── the narrowing ─────────────────────────────────────────────────────────*/

/**
 * The predicate `logface.tail` takes, or null for "keep everything".
 *
 * Null rather than `() => true` because `tail` uses the null to skip the filter
 * entirely, and on two thousand lines that is the difference between a copy and
 * nothing at all.
 */
export function keeping(showing: string): ((l: LogLine) => boolean) | null {
  if (showing === "all") return null
  if (showing === "problems") return (l) => l.level === "error" || l.level === "warn"
  if (LEVELS.includes(showing as Level)) {
    const floor = showing as Level
    return (l) => atLeast(l.level, floor)
  }
  /* An unrecognised knob shows everything rather than nothing. A config from a
     newer build must not present as an empty log, which reads as breakage. */
  return null
}

/** What each narrowing is called when it has emptied the pane. Matches
 *  `emptyBecause`'s sentence: "nothing ___ — 12 lines filtered out". */
export const NARROWING: Record<string, string> = {
  problems: "to complain about",
  error: "at error",
  warn: "at warn or worse",
  info: "at info or worse",
  debug: "at debug or worse",
}

/** The pane's own explanation of why it is empty, or null when it is not. */
export function absence(hidden: number, showing: string): string | null {
  return emptyBecause(hidden, NARROWING[showing] ?? "to show")
}

/* ── drawing ───────────────────────────────────────────────────────────────*/

/** Lines into rows, which is the only shape `LogTail` knows. */
export function rowsOf(lines: readonly LogLine[]): Row[] {
  return lines.map((l) => ({
    mark: markOf(l.target),
    tone: toneOf(l.level),
    text: l.text,
  }))
}

/**
 * The line under the name: how much has been said, and how much of it is bad.
 *
 * Errors lead when there are any, because that is the reason somebody opened
 * this. With none, the count alone is the honest reading — and "quiet" rather
 * than "0 lines" for the genuinely-nothing case, since a log that has said
 * nothing is a calm state and not a measurement.
 */
export function standing(lines: readonly LogLine[]): string {
  if (lines.length === 0) return "quiet"
  const bad = lines.filter((l) => l.level === "error").length
  const warn = lines.filter((l) => l.level === "warn").length
  const said = `${lines.length} ${lines.length === 1 ? "line" : "lines"}`
  if (bad > 0) return `${bad} error${bad === 1 ? "" : "s"} · ${said}`
  if (warn > 0) return `${warn} warning${warn === 1 ? "" : "s"} · ${said}`
  return said
}

/**
 * The dot, in `logface`'s five-state vocabulary.
 *
 * `dead` for an error, `pending` for a warning, `live` for anything else that
 * has spoken, `idle` for a log with nothing in it. Note this reads the *whole*
 * kept log rather than the last line: a single error four hundred lines back is
 * still the most important thing this widget knows, and a dot that went green
 * again because the next line was routine would be hiding it.
 */
export function pulseOf(
  lines: readonly LogLine[],
): "idle" | "live" | "pending" | "rest" | "dead" {
  if (lines.length === 0) return "idle"
  if (lines.some((l) => l.level === "error")) return "dead"
  if (lines.some((l) => l.level === "warn")) return "pending"
  return "live"
}

/* ── the widget's knobs ────────────────────────────────────────────────────*/

export type AppLogConfig = {
  /** Which lines to keep. A `Level` name is a floor; `problems` is errors and
   *  warnings; `all` is everything the sink let through. */
  showing: string
  /** Whether the gutter shows which module said it. Off for a narrow widget,
   *  where the mark costs more width than it earns. */
  marks: boolean
}

/** The narrowings the catalogue offers, and the set `keeping` understands.
 *  Exported so a test can assert the two agree in both directions — a knob the
 *  menu offers that the filter ignores is a control that does nothing. */
export const SHOWINGS: string[] = ["all", "problems", "error", "warn", "info", "debug"]

/** Runs on every read, like every other opaque `config_json`. */
export function normalizeConfig(raw: unknown): AppLogConfig {
  const o = (raw ?? {}) as Record<string, unknown>
  /* Read out of `variant`, stored as `showing` — the same asymmetry
     `spotify.ts::normalizeConfig` documents at length, and for the same reason:
     `VARIANT` is the one knob the right-click offers directly. */
  const showing = SHOWINGS.includes(o.variant as string) ? (o.variant as string) : "all"
  return {
    showing,
    marks: typeof o.marks === "boolean" ? o.marks : true,
  }
}
