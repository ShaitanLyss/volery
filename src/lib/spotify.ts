/**
 * What is playing, folded from librespot's own event stream.
 *
 * Pure by the boundary in CLAUDE.md — no runes, no invokes, direct Bun tests.
 * `spotify.rs` owns the session and narrows librespot's `PlayerEvent` into the
 * `SpotifyEvent` union below; everything that turns those into something
 * readable lives here.
 *
 * The one idea worth holding on to is in `positionAt`. See its comment.
 */

/* ── what a player can be doing ────────────────────────────────────────────*/

/**
 * Deliberately not librespot's states. `Preloading`, `TimeToPreloadNextTrack`
 * and `EndOfTrack` are notes the player passes to itself — drawing them would
 * be reporting our own plumbing back at somebody.
 */
export type SpotifyPhase =
  | "off" /* no session; nothing has been signed in, or it was signed out */
  | "linking" /* the browser leg: waiting on a person */
  | "opening" /* signed in; the receiver is coming up */
  | "idle" /* signed in, receiver up, nothing playing */
  | "loading" /* a track is on its way */
  | "playing"
  | "paused"
  | "fault" /* said what went wrong in `fault` */

export type SpotifyKind = "track" | "episode" | "local"

export type SpotifyTrack = {
  id: string
  name: string
  /** In Spotify's own order — first is the one a single line should show. */
  artists: string[]
  album: string
  durationMs: number
  /** Already picked at a usable size by `spotify.rs`; null when there is none. */
  art: string | null
  explicit: boolean
  kind: SpotifyKind
}

export type SpotifyRepeat = "off" | "context" | "track"

export type SpotifyState = {
  phase: SpotifyPhase
  track: SpotifyTrack | null
  /**
   * Where the playhead was when `since` was stamped — NOT where it is now.
   * Ask `positionAt`.
   */
  positionMs: number
  /**
   * `Date.now()` at the moment `positionMs` was true, or null when the
   * playhead is not moving. The null is what makes a paused reading stable.
   */
  since: number | null
  /** 0..1. librespot speaks u16; the conversion is `volumeFromWire`. */
  volume: number
  shuffle: boolean
  repeat: SpotifyRepeat
  /** What this receiver calls itself on the network. */
  device: string
  /** Set only in phase "fault", and it is prose meant to be read. */
  fault: string | null
}

/* ── the wire ──────────────────────────────────────────────────────────────*/

/**
 * Internally tagged on `kind`, matching serde's `#[serde(tag = "kind")]` in
 * `spotify.rs`. Narrower than `PlayerEvent` on purpose — see `SpotifyPhase`.
 */
export type SpotifyEvent =
  | { kind: "session"; device: string }
  | { kind: "closed"; fault?: string | null }
  | { kind: "linking" }
  | { kind: "opening" }
  | { kind: "track"; track: SpotifyTrack }
  | { kind: "loading"; positionMs: number }
  | { kind: "playing"; positionMs: number }
  | { kind: "paused"; positionMs: number }
  | { kind: "stopped" }
  | { kind: "seeked"; positionMs: number }
  | { kind: "position"; positionMs: number }
  | { kind: "volume"; volume: number }
  | { kind: "shuffle"; shuffle: boolean }
  | { kind: "repeat"; repeat: SpotifyRepeat }
  | { kind: "unavailable" }

export function emptyState(): SpotifyState {
  return {
    phase: "off",
    track: null,
    positionMs: 0,
    since: null,
    volume: 1,
    shuffle: false,
    repeat: "off",
    device: "volery",
    fault: null,
  }
}

/* ── the fold ──────────────────────────────────────────────────────────────*/

/**
 * One event onto one state, returning a fresh object every time.
 *
 * Fresh rather than mutated because the caller is a rune: `$state` invalidates
 * readers by comparing the new value with the old, and a mutated-in-place
 * object is the same object — the trap CLAUDE.md records against the editor's
 * grid, which painted once and then never again.
 *
 * `at` is passed rather than read from the clock so this stays pure and so a
 * test can say what "now" is.
 */
export function applyEvent(
  state: SpotifyState,
  ev: SpotifyEvent,
  at: number,
): SpotifyState {
  switch (ev.kind) {
    case "session":
      return { ...state, phase: "idle", device: ev.device, fault: null }

    case "linking":
      return { ...state, phase: "linking", fault: null }

    case "opening":
      /* The leg after the browser. Kept apart from `linking` because the two
         were one phase and the face therefore went on saying "waiting for the
         browser…" through a session start that took four minutes to fail —
         which is the bug this state exists to make undrawable. */
      return { ...state, phase: "opening", fault: null }

    case "closed":
      /* Everything about what was playing goes with the session: a track left
         on screen under a dead player is a control that does nothing. */
      return {
        ...emptyState(),
        volume: state.volume,
        device: state.device,
        phase: ev.fault ? "fault" : "off",
        fault: ev.fault ?? null,
      }

    case "track":
      /* A new track arrives before its first `playing`, so the playhead is
         pinned at zero and left still until one does. */
      return { ...state, track: ev.track, positionMs: 0, since: null }

    case "loading":
      return {
        ...state,
        phase: "loading",
        positionMs: clampPosition(state, ev.positionMs),
        since: null,
      }

    case "playing":
      return {
        ...state,
        phase: "playing",
        positionMs: clampPosition(state, ev.positionMs),
        since: at,
        fault: null,
      }

    case "paused":
      return {
        ...state,
        phase: "paused",
        positionMs: clampPosition(state, ev.positionMs),
        since: null,
      }

    case "seeked":
    case "position":
      /* A correction, not a transition: it says where the playhead is without
         saying whether it is moving, so `since` is restamped only if it was
         already running. Restamping unconditionally would silently start a
         paused track advancing. */
      return {
        ...state,
        positionMs: clampPosition(state, ev.positionMs),
        since: state.since === null ? null : at,
      }

    case "stopped":
      return { ...state, phase: "idle", track: null, positionMs: 0, since: null }

    case "unavailable":
      return {
        ...state,
        phase: "fault",
        since: null,
        fault: "spotify would not play that track",
      }

    case "volume":
      return { ...state, volume: volumeFromWire(ev.volume) }

    case "shuffle":
      return { ...state, shuffle: ev.shuffle }

    case "repeat":
      return { ...state, repeat: ev.repeat }

    default:
      /* An event from a newer build. Same bargain `normalizeWidget` strikes:
         degrade to something drawable rather than guess. */
      return state
  }
}

function clampPosition(state: SpotifyState, ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0
  const end = state.track?.durationMs ?? 0
  return end > 0 ? Math.min(ms, end) : ms
}

/* ── where the playhead actually is ────────────────────────────────────────*/

/**
 * The playhead, interpolated against the wall clock.
 *
 * **This is why nothing here polls.** librespot will send a position on a timer
 * if `PlayerConfig::position_update_interval` is set, and taking it would have
 * been the obvious thing — but it is a second clock ticking beside the one the
 * wall already has, for a number that is a straight line between two events we
 * are told about anyway. So the interval is left `None` and the transitions
 * (`playing`, `paused`, `seeked`) are folded instead, exactly the shape
 * CLAUDE.md asks for: when the thing you care about emits nothing, find an
 * event that already exists near it and fold that.
 *
 * The residue is that a track which ends with no event would run past its own
 * duration, so the clamp is the honest half rather than a tidiness.
 */
export function positionAt(state: SpotifyState, now: number): number {
  const base = Math.max(0, state.positionMs)
  const end = state.track?.durationMs ?? 0
  const live = state.since === null ? base : base + Math.max(0, now - state.since)
  return end > 0 ? Math.min(live, end) : live
}

/** 0..1 along the track, and 0 when there is nothing to be along. */
export function progressAt(state: SpotifyState, now: number): number {
  const end = state.track?.durationMs ?? 0
  if (end <= 0) return 0
  return Math.min(1, Math.max(0, positionAt(state, now) / end))
}

/* ── readings ──────────────────────────────────────────────────────────────*/

/**
 * `3:42`, and `1:02:03` once there is an hour of it — podcasts are the reason
 * the hour arm exists. Floors rather than rounds, so a reading never shows a
 * second the track has not reached.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const total = Math.floor(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/**
 * Artists on one line. Spotify hands back a list and the first is the one that
 * matters, so a long tail is cut rather than allowed to push the title out.
 */
export function joinArtists(artists: string[], limit = 3): string {
  const named = artists.filter((a) => a.trim().length > 0)
  if (named.length === 0) return ""
  if (named.length <= limit) return named.join(", ")
  return `${named.slice(0, limit).join(", ")} +${named.length - limit}`
}

/**
 * The one line under the controls, in the house voice: lowercase, quiet,
 * sentence-shaped. Says what is true rather than what was asked for.
 */
export function describe(state: SpotifyState): string {
  switch (state.phase) {
    case "off":
      return "not signed in"
    case "linking":
      return "waiting for the browser…"
    case "opening":
      return "signed in — bringing the receiver up…"
    case "idle":
      return `${state.device} — ready, nothing playing`
    case "loading":
      return "loading…"
    case "fault":
      return state.fault ?? "something went wrong"
    case "playing":
    case "paused":
      return state.track ? joinArtists(state.track.artists) : ""
    default:
      return ""
  }
}

/** Whether the transport controls can do anything at all. */
export function canControl(state: SpotifyState): boolean {
  return (
    state.phase === "playing" ||
    state.phase === "paused" ||
    state.phase === "loading"
  )
}

/* ── volume ────────────────────────────────────────────────────────────────*/

/**
 * librespot's mixer is a `u16`, the UI is 0..1, and the conversion is here
 * rather than at either end so both agree about the rounding.
 */
export function volumeFromWire(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v / 65535))
}

export function volumeToWire(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.round(Math.min(1, Math.max(0, v)) * 65535)
}

/* ── searching ─────────────────────────────────────────────────────────────*/

/** One row of a search result. Mirrors `Hit` in `selector.rs`. */
export type SpotifyHit = {
  kind: string
  uri: string
  title: string
  /** Artists, or a playlist's owner. Empty for a kind that has no such thing. */
  by: string
  /** An album's year, a track's length, a playlist's size. Empty when there is none. */
  extra: string
}

/**
 * The line a result draws under its title.
 *
 * Both fields are optional at the source — a playlist has no artist, a track
 * Spotify knows little about has no extra — so this is the one place that
 * decides what a missing half looks like, rather than each of them leaving a
 * stray separator behind.
 */
export function sayHit(hit: SpotifyHit): string {
  const parts = [hit.by, hit.extra].map((p) => p.trim()).filter((p) => p.length > 0)
  return parts.join(" · ")
}

/**
 * Whether a search is worth sending.
 *
 * Trimmed and non-empty, and that is the whole rule — Spotify's own search
 * language is rich enough (`artist:coltrane year:1965`) that guessing at what
 * is "too short" here would refuse queries that work. The empty case matters
 * because Enter on an empty box is the commonest keystroke in any search field
 * and it must not cost a round trip.
 */
export function worthSearching(query: string): boolean {
  return query.trim().length > 0
}

/**
 * What the results area says when it is not showing results.
 *
 * `null` means draw nothing at all, which is the state before anybody has
 * searched — an empty box with "no results" under it is an accusation.
 */
export function sayResults(
  state: "idle" | "searching" | "done" | "failed",
  count: number,
  fault: string | null,
): string | null {
  switch (state) {
    case "idle":
      return null
    case "searching":
      return "searching…"
    case "failed":
      return fault ?? "the search did not work"
    case "done":
      return count === 0 ? "nothing found" : null
  }
}

/* ── the widget's knobs ────────────────────────────────────────────────────*/

/** What the face shows. `full` wants room; `bar` is a strip you can sit on a shelf. */
export type SpotifyLayout = "full" | "compact" | "bar"

export type SpotifyConfig = {
  layout: SpotifyLayout
  art: boolean
  progress: boolean
}

/** Exported so a test can assert this and the catalogue's menu are the same
 *  set — in both directions. A reading the face can draw but the menu does not
 *  offer is unreachable; one the menu offers but the face cannot draw silently
 *  becomes "full". See the seam block in `test/spotify.test.ts`. */
export const LAYOUTS: SpotifyLayout[] = ["full", "compact", "bar"]

/**
 * Runs on every read, like every other opaque `config_json`. A renamed knob or
 * a config from a newer build degrades to something drawable rather than
 * putting `undefined` inside a frame loop.
 */
export function normalizeConfig(raw: unknown): SpotifyConfig {
  const o = (raw ?? {}) as Record<string, unknown>
  /* Read out of `variant`, stored as `layout`, and the asymmetry is deliberate
     — do not "tidy" either side to match the other.
     `variant` is the catalogue's word: `widgets.ts`'s `VARIANT` key is the one
     knob the right-click offers directly, and `widgets.test.ts` asserts every
     widget's first param is called it. `layout` is ours, and is what the face
     actually reads. Reading `o.layout` here — which this did at first — is the
     exact failure the catalogue refuses everywhere else: the knob appears in
     the menu, persists to `config_json`, and silently does nothing. */
  const layout = LAYOUTS.includes(o.variant as SpotifyLayout)
    ? (o.variant as SpotifyLayout)
    : "full"
  return {
    layout,
    art: typeof o.art === "boolean" ? o.art : true,
    progress: typeof o.progress === "boolean" ? o.progress : true,
  }
}
