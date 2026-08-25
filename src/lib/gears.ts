/**
 * What gear a card is in.
 *
 * Until now the wall had exactly one: every project card spawns with
 * `--dangerously-skip-permissions` and has the machine in its hands from its
 * first turn, which is why a broadcast is the most destructive gesture in the
 * app. This is the second gear — a card that can read, search and think but
 * cannot write, and whose turn ends in a plan rather than in a diff.
 *
 * Everything here is pure and tested. What it knows about the CLI is deliberately
 * narrow: the wire values of the two modes, the shape of the `system/init` that
 * announces one, and how to recognise the document a planning turn leaves
 * behind. Anything about *drawing* a gear belongs to the component.
 *
 * # Probed, because none of it was obvious (claude 2.1.241, `tools/probe-plan.ts`)
 *
 * - **`set_permission_mode` beats `--dangerously-skip-permissions`.** A card
 *   spawned with bypass and then asked for `plan` came back with 29 tools
 *   instead of 59 and did not write the file it was asked to write. That is what
 *   makes this a *gear* rather than a kind of card: no respawn, no lost process,
 *   no second conversation.
 * - **Two events carry the mode, they arrive at different times, and one of
 *   them can be stale.** This was got wrong first time round, and the shape of
 *   the mistake is worth keeping. A `control_response` acknowledges the change
 *   within ~60ms and carries the new mode: that is the process confirming, and
 *   it is what the card should be drawn as. A `system/init` also carries
 *   `permissionMode` — but it is emitted **per turn**, reporting the mode that
 *   turn is running *under*, and a turn that was already in flight reports the
 *   old one. Measured: mode set to `plan` at 15.13s and acknowledged, then an
 *   init at 17.76s saying `bypassPermissions`, because it belonged to a turn
 *   asked for at 0.06s. Folding that init blind flips the card back.
 *
 *   So both are folded and the acknowledgement wins until an init agrees with
 *   it — see `Conversation.#pendingGear`. Nothing polls either way, which is
 *   still the shape CLAUDE.md asks for, and a card put into plan mode by
 *   something that is not Volery is still drawn correctly, because once the two
 *   agree an init folds normally again.
 * - **`ExitPlanMode` does not exist any more.** The older model — a tool call
 *   that parks waiting for approval — is gone; 2.1.241's plan mode *writes a
 *   document* to `~/.claude/plans/` and names it in the result. So approval is
 *   not a parked call to resume (`ask.rs`'s shape), it is a file to read and
 *   then a gear change. That is why nothing here touches the asking machinery.
 */

/** The gears Volery offers, in the order they are drawn. */
export const GEARS = ["planning", "making"] as const;
export type Gear = (typeof GEARS)[number];

/** Volery's default, and what every card before this was. */
export const DEFAULT_GEAR: Gear = "making";

/**
 * The wire value each gear is, on `--permission-mode` and on the
 * `set_permission_mode` control request — which take the same vocabulary.
 *
 * `bypassPermissions` is the same thing `--dangerously-skip-permissions` asks
 * for, and spawning still uses the flag: it is what every rule in this
 * repository names, and two spellings of one state is how a mode ends up set in
 * one place and read in another.
 */
const WIRE: Record<Gear, string> = {
  planning: "plan",
  making: "bypassPermissions",
};

export function wireOf(gear: Gear): string {
  return WIRE[gear];
}

/**
 * Is this one of the wall's gears?
 *
 * The palette offers the two values, but a command's name can be typed by hand
 * and the palette is a help rather than a gate — so `/gear planing` reaches the
 * runner as free text. Guarded rather than cast, for `isEffort`'s reason: the
 * failure of a cast here is a card put into a gear neither of us meant.
 */
export function isGear(v: unknown): v is Gear {
  return typeof v === "string" && (GEARS as readonly string[]).includes(v);
}

/**
 * The CLI's own vocabulary is wider than the wall's — 2.1.241 offers
 * `acceptEdits`, `auto`, `manual` and `dontAsk` besides these two — and a card
 * can be put into any of them by something that is not Volery.
 *
 * **Anything that is not planning reads as making**, rather than as a third
 * thing or as unknown. The distinction the wall draws is "can this card change
 * the repository", and every other mode answers yes; inventing a reading for
 * each would be five gears in a UI that has two gestures. The cost is that a
 * card in `acceptEdits` is drawn as though it were in bypass, which is honest
 * about the only question being asked of it.
 */
export function gearOfWire(mode: unknown): Gear {
  return mode === "plan" ? "planning" : "making";
}

/**
 * The gear a `system/init` announces, or `null` for an init that says nothing
 * about it — an older CLI, or a build that drops the field.
 *
 * **What a turn is running under, not what the card is set to.** An init emitted
 * for a turn that was already in flight when the mode changed reports the *old*
 * mode; see the module note for the measurement. `Conversation` holds the rule
 * that resolves the two.
 *
 * `null` rather than a default, because "this init did not mention the mode" and
 * "this init says the card is in bypass" are different facts, and folding the
 * second where the first is true would flip a planning card back to making on
 * its next event.
 */
export function gearOfInit(ev: unknown): Gear | null {
  const mode = (ev as { permissionMode?: unknown } | null)?.permissionMode;
  return typeof mode === "string" ? gearOfWire(mode) : null;
}

/**
 * The gear a `control_response` acknowledges, or `null` for a response that is
 * about something else.
 *
 * This is the immediate one and the authoritative one: the process saying it has
 * taken the change, ~60ms after it was asked. Measured shape:
 *
 * ```json
 * {"type":"control_response","response":{"subtype":"success","request_id":"…",
 *  "response":{"mode":"plan"}}}
 * ```
 *
 * **No request id is correlated, deliberately.** The stream is per-card, so any
 * mode acknowledgement on it is about this card; matching ids would mean
 * `Skein` remembering what it sent, and the one thing that would buy — telling
 * *our* change from one made by something else on the same card — is a
 * distinction with no consequence, since both are true of the card either way.
 *
 * Only a success is read. A failed control request has not changed anything, and
 * drawing a gear off it would be the wall showing a state that was refused.
 */
export function gearOfModeAck(ev: unknown): Gear | null {
  const e = ev as { type?: unknown; response?: Record<string, unknown> } | null;
  if (e?.type !== "control_response") return null;
  const outer = e.response;
  if (!outer || outer.subtype !== "success") return null;
  const mode = (outer.response as { mode?: unknown } | undefined)?.mode;
  return typeof mode === "string" ? gearOfWire(mode) : null;
}

/** What the gear is called, and what it means, in the wall's voice. */
export function readingOf(gear: Gear): { name: string; note: string } {
  return gear === "planning"
    ? { name: "planning", note: "reads and thinks — cannot change anything" }
    : { name: "making", note: "has the machine" };
}

/* ── the document a planning turn leaves behind ───────────────────────────── */

/**
 * Is this the path of a plan document?
 *
 * Matched **structurally, off the `Write` tool call in the stream**, rather than
 * by reading the result prose that also names it. The prose is a sentence a
 * model composed and could be phrased any number of ways; the tool call is the
 * CLI writing a file to a directory of its own, and it is already in the event
 * pipeline. Same argument as everywhere else in this app: fold the event that
 * exists.
 *
 * `.claude/plans/` anywhere in the path, since the directory is under the user's
 * home and this has no business knowing where that is.
 */
export function isPlanDocument(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return norm.includes("/.claude/plans/") && norm.endsWith(".md");
}

/**
 * A plan's file name, read as a title.
 *
 * The CLI names these from a summary of the ask plus two random words —
 * `create-a-file-scratch-plan-probe-txt-imperative-gem.md` — so the tail is
 * noise and the head is the only part worth drawing. There is no way to tell
 * exactly where the noise starts, so nothing tries: the whole slug is
 * de-hyphenated and clipped, which reads as a title that trails off rather than
 * as a title with a wrong word in it.
 */
export function planTitle(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const slug = file.replace(/\.md$/i, "").replace(/-/g, " ").trim();
  if (!slug) return "a plan";
  return slug.length > 52 ? `${slug.slice(0, 51).trimEnd()}…` : slug;
}

/**
 * Where the file viewer has to be rooted to open a plan, and the name to open.
 *
 * The viewer refuses an absolute path and anything climbing out of its root —
 * `find.rs`'s `safe_join`, which is a guard worth keeping exactly as it is. A
 * plan document lives under the user's home rather than under any project, so
 * the way in is not to widen the guard but to root the viewer at the plans
 * directory and name the file within it. Nothing about the sandbox changes; the
 * viewer is simply pointed somewhere else, the same way it is pointed at each
 * project.
 *
 * Derived from the path itself rather than from a home directory this module
 * has no business knowing. Separators are normalised to forward slashes, which
 * `safe_join` accepts on Windows.
 */
export function planRoot(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut > 0 ? norm.slice(0, cut) : "";
}

/** The plan's file name, which is what the viewer opens within `planRoot`. */
export function planFile(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/* ── resolving the two events that carry the mode ─────────────────────────── */

/**
 * What a card believes about its gear: the reading, and a change the wire has
 * acknowledged that no `system/init` has yet agreed with.
 */
export type GearState = {
  gear: Gear;
  /** `null` once an init has agreed, or once the process has gone. */
  pending: Gear | null;
};

/** The state a fresh card starts in. */
export function freshGear(gear: Gear = DEFAULT_GEAR): GearState {
  return { gear, pending: null };
}

/**
 * The wire acknowledged a change. This is the authoritative one — the process
 * saying it has taken the mode, ~60ms after being asked — so it is taken
 * immediately and remembered as outstanding until an init agrees.
 */
export function afterAck(s: GearState, gear: Gear): GearState {
  return { gear, pending: gear };
}

/**
 * An init reported the mode its turn is running under.
 *
 * **Ignored while it disagrees with an outstanding acknowledgement**, because
 * that is the stale case: a turn already in flight when the mode changed reports
 * the mode it started under. The init that agrees clears the outstanding change,
 * after which inits fold normally again — which is what keeps a card put into
 * planning by something that is not Volery drawn correctly.
 */
export function afterInit(s: GearState, gear: Gear): GearState {
  if (s.pending !== null) {
    return gear === s.pending ? { gear, pending: null } : s;
  }
  return { gear, pending: null };
}

/**
 * The process went. Whatever it had not got round to reflecting, it never will
 * — and an outstanding change left set would make this card deaf to every init
 * for the rest of its life. The reading itself stands: it is what the card is
 * set to, and `spawn` reads the same thing off the row when it comes back.
 */
export function afterExit(s: GearState): GearState {
  return { gear: s.gear, pending: null };
}
