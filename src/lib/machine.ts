/* What Volery asks of the machine it runs on, worded.
 *
 * `machine.rs` reports facts — the power source, whether the wake request is
 * held, what the lid does, whether the `Run` entry exists, and the three things
 * that decide whether Windows signs her back in after a restart. Everything a
 * person reads about them is decided here, because two of those readings are
 * the whole deliverable: a machine that will not sleep with no visible reason
 * is a haunting, and a reopen whose precondition is a Windows checkbox she has
 * never heard of is a feature that silently does not work.
 *
 * So every line says what is true *now*, including the part that defeats it —
 * a closed lid, a policy, a managed machine — rather than the name of a knob.
 * See `.claude/rules/machine.md`.
 */

export type Power = "mains" | "battery" | "unknown";
export type Lid = "absent" | "nothing" | "sleep" | "hibernate" | "shutdown" | "unknown";

export type Arso = {
  /** An administrator has turned automatic sign-in off. */
  policyOff: boolean;
  /** Her own switch in sign-in options; null when never touched. */
  user: boolean | null;
  /** Joined to a domain or Entra ID. */
  managed: boolean;
};

export type MachineStatus = {
  supported: boolean;
  awake: boolean;
  power: Power;
  holding: boolean;
  lid: Lid;
  reopen: boolean;
  ownsEntry: boolean;
  armed: boolean;
  startupBlocked: boolean;
  arso: Arso;
};

/** What is drawn before Rust has answered, or off Windows. */
export const UNSUPPORTED: MachineStatus = {
  supported: false,
  awake: false,
  power: "unknown",
  holding: false,
  lid: "unknown",
  reopen: false,
  ownsEntry: false,
  armed: false,
  startupBlocked: false,
  arso: { policyOff: false, user: null, managed: false },
};

const POWERS: readonly Power[] = ["mains", "battery", "unknown"];
const LIDS: readonly Lid[] = ["absent", "nothing", "sleep", "hibernate", "shutdown", "unknown"];

/** Whatever came over the wire, as something drawable. */
export function normalize(raw: unknown): MachineStatus {
  if (!raw || typeof raw !== "object") return UNSUPPORTED;
  const r = raw as Record<string, unknown>;
  const a = (r.arso && typeof r.arso === "object" ? r.arso : {}) as Record<string, unknown>;
  const bool = (v: unknown) => v === true;
  return {
    supported: bool(r.supported),
    awake: bool(r.awake),
    power: POWERS.includes(r.power as Power) ? (r.power as Power) : "unknown",
    holding: bool(r.holding),
    lid: LIDS.includes(r.lid as Lid) ? (r.lid as Lid) : "unknown",
    reopen: bool(r.reopen),
    ownsEntry: bool(r.ownsEntry),
    armed: bool(r.armed),
    startupBlocked: bool(r.startupBlocked),
    arso: {
      policyOff: bool(a.policyOff),
      user: typeof a.user === "boolean" ? a.user : null,
      managed: bool(a.managed),
    },
  };
}

/** How far an open wall comes back on its own after Windows restarts.
 *
 *  `any` — any restart or shutdown she did not sign out of. `updates` — only a
 *  Windows Update restart. `signin` — none: the wall waits for her to sign in.
 *  A power cut or a crash is `signin` on every machine and is not modelled,
 *  because nothing here can change it.
 *
 *  Microsoft's table, as of the ARSO page dated 2025-05: an unmanaged machine
 *  is signed back in after updates, `shutdown -g` and user-initiated restarts;
 *  a managed one after updates only. A switch never touched is at Windows'
 *  default, which is on. */
export type Comeback = "any" | "updates" | "signin";

export function comeback(a: Arso): Comeback {
  if (a.policyOff || a.user === false) return "signin";
  return a.managed ? "updates" : "any";
}

const LID_DOES: Record<Lid, string | null> = {
  absent: null,
  nothing: null,
  sleep: "closing the lid still puts it to sleep",
  hibernate: "closing the lid still hibernates it",
  shutdown: "closing the lid still shuts it down",
  unknown: "a closed lid may still put it to sleep",
};

/* Two lengths of each line. The short one is a menu row — the ground menu is
   `nowrap` and one long row widened the whole menu to ~590px — and the long
   one is what a chord says, in the hint's place, where there is room for the
   sentence. Both carry the part that defeats the setting; the short one just
   says it in fewer words. */

/** The wake toggle's sentence, as the chord says it. */
export function awakeSaid(s: MachineStatus): string {
  if (!s.supported) return "keeping this machine awake is windows only";
  if (!s.awake) return "letting this machine sleep as usual";
  if (s.power === "battery") return "keep awake on mains — on battery now, so it may sleep";
  if (s.power === "unknown") return "keep awake on mains — power source unknown, so it may sleep";
  if (!s.holding) return "keep awake on mains — windows refused the request, see the app log";
  const lid = LID_DOES[s.lid];
  return lid
    ? `keeping this machine awake on mains — but ${lid}`
    : "keeping this machine awake — it is on mains power";
}

/** The wake toggle's menu row. */
export function awakeLine(s: MachineStatus): string {
  const name = "keep awake on mains";
  if (!s.supported) return `${name} — windows only`;
  if (!s.awake) return name;
  if (s.power === "battery") return `${name} — on battery now`;
  if (s.power === "unknown") return `${name} — power unknown`;
  if (!s.holding) return `${name} — refused by windows`;
  if (s.lid === "sleep" || s.lid === "hibernate" || s.lid === "shutdown")
    return `${name} — but not with the lid shut`;
  if (s.lid === "unknown") return `${name} — awake, lid unknown`;
  return `${name} — awake now`;
}

/** How the reopen setting reads, at either length. */
function reopen(s: MachineStatus, long: boolean): string {
  const name = "reopen after a restart";
  if (!s.supported) return `${name} — windows only`;
  if (!s.reopen) return long ? "not reopening after a restart" : name;
  if (!s.ownsEntry)
    return long ? `${name} — the installed app's to do, not this build` : `${name} — installed app only`;
  if (s.startupBlocked)
    return long
      ? `${name} — switched off in task manager's startup tab`
      : `${name} — off in task manager`;
  const a = s.arso;
  if (a.policyOff)
    return long
      ? `${name} — only once you sign in: your administrator has turned off windows' automatic sign-in`
      : `${name} — sign-in only (policy)`;
  if (a.user === false)
    return long
      ? `${name} — only once you sign in: turn on "use my sign-in info" in sign-in options`
      : `${name} — sign-in only`;
  /* Never touched is Windows' default, which is on — but the default is not
     written anywhere this can read, so the sentence says what it is resting on
     rather than asserting it. */
  const resting = a.user === null ? ` — if "use my sign-in info" is on in sign-in options` : "";
  if (a.managed)
    return long
      ? `${name} — after update restarts only: windows signs a work machine back in for nothing else${resting}`
      : `${name} — update restarts only`;
  return long
    ? `${name} — after any restart, behind the lock screen${resting}`
    : `${name} — any restart`;
}

/** The reopen toggle's menu row. */
export function reopenLine(s: MachineStatus): string {
  return reopen(s, false);
}

/** The reopen toggle's sentence, as the chord says it. */
export function reopenSaid(s: MachineStatus): string {
  return reopen(s, true);
}
