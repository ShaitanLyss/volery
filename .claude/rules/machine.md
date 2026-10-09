---
paths:
  - "src-tauri/src/machine.rs"
  - "src/lib/machine.ts"
  - "src/lib/machine.svelte.ts"
  - "tools/check-machine.ps1"
---

# The machine under the wall: awake on mains, and back after a restart

Built 2026-10-09, because a wall that is not running is not a peer. The roster shows nothing,
a remote spawn is refused and the sink stops converging. That day `AU-LT-288` went down while
Lyss drove it from her other machine, and she could not tell whether it had slept or
restarted. Two settings, both on by default, both on the ground's right-click menu and on
`space m w` / `space m r`.

## The ceiling, stated first because she plans around it

`AU-LT-288` is a company laptop with **no admin rights**. That rules out a service, a
scheduled task that runs without a session, and auto-logon, all of which need either a
privilege or a password in the registry. What is left:

- **While she is signed in the wall is reachable.** Locked counts as signed in, because the
  lock screen keeps the session. The wake lock is what keeps it that way.
- **An update restart brings it back only if Windows signs her back in by itself** (ARSO, below).
- **A power cut, a hard crash or a session she signed out of always waits for her to sign
  in.** Nothing that can be built on that machine changes this.

**The headless roost (`docs/FLYWAY-REMAINING.md`) does not close this hole.** Headless means
*no window*, not *no session*. A windowless Volery still needs someone signed in unless it
runs as a service, and a service needs admin. It is worth building for its own reasons. Do
not read it as the answer to this.

## Awake

A **power request** (`PowerCreateRequest` + `PowerSetRequest(PowerRequestSystemRequired)`),
not `SetThreadExecutionState`. Both ask the kernel for the same thing. The difference is that
`ES_CONTINUOUS` is a flag on one *thread*: it stops applying silently when that thread exits,
and no thread in a Tauri app is plainly the one that lives as long as the process. A request
is a handle the process owns. It also carries a reason string, and `powercfg /requests`
prints that beside our name, which matters for someone wondering why the machine will not
sleep.

The request is **system-required only, never display**, so the screen may still sleep.

**It is held on mains only, and the power source is folded, not sampled.**
`PowerSettingRegisterNotification(GUID_ACDC_POWER_SOURCE, DEVICE_NOTIFY_CALLBACK)` calls back
on every change, plus once when it registers. That is the same event `WM_POWERBROADCAST`
carries. It arrives as a callback because a request has no window to post to, and that
satisfies CLAUDE.md's no-fourth-poller rule. Payload 2 (a UPS or other short-term source)
counts as battery, and so does an unknown source: guessing wrong that way costs one sleep,
and guessing wrong the other way costs a flat battery in a bag.

**A closed lid beats it, and the toggle says so.** Every power request is dropped when the
user starts a sleep: lid, power button, or Start → Sleep. On a laptop that is the commonest
way to fall asleep. What the lid does *on mains* is a standard-user power setting, so
`machine.rs` reads it (`PowerReadACValueIndex`, button subgroup, `LIDACTION`), and
`awakeLine` puts it in the menu's own words: "keeping this machine awake on mains — but
closing the lid still puts it to sleep". Writing that only here would have made the toggle a
false claim.

**Modern Standby honours the request on AC.** On DC a system-required request is cut five
minutes after the sleep timeout, which does not matter here because we release it on DC
anyway. Source: Microsoft's `PowerSetRequest` page. The home machine is S0-only, and the
laptop very likely is too.

**`powercfg /requests` needs admin** (probed 2026-10-09: "Cette commande nécessite des
privilèges d'administrateur"). The honest check therefore needs an elevated prompt, which
`AU-LT-288` does not have. Without one, what you can see is the status line and the app log,
which records `machine: holding the wake request (Mains)` / `released` on every change.

## Reopen after a restart

**The `Run` entry is the flag.** `HKCU\…\CurrentVersion\Run` gets the value `Volery` (or
`Volery (<identifier>)` for a lab) containing `"<exe>" --autostart`. It is written when a wall
opens and removed when someone closes the studio window. A crash, a forced restart and
Windows going down under the app all leave it in place, and all three mean *it was open*.
Nothing has to detect which case it was: the behaviour follows from the order of the writes.
It is one fact kept in one place, and it shows in Task Manager's Startup tab, where she can
see it and switch it off. Windows honours that switch without our help, and `startup_blocked`
reads it back so the line can say so.

**It is removed only in the main window's `CloseRequested`, never in the `Exit` handler, and
that placement decides whether the feature works at all.** tao answers `WM_ENDSESSION`
(Windows shutting down or restarting under the app) with `loop_destroyed()` followed by
`process::exit` (tao 0.35.3, `platform_impl/windows/event_loop.rs`), and Tauri turns
`loop_destroyed()` into `RunEvent::Exit`. So the exit handler also runs on a Windows restart.
Clearing the entry there would erase it in exactly the case it exists for. The brief that
started this suggested "clear it on `ExitRequested`", which would have shipped a feature that
did nothing.

**`--autostart` is the one argument the studio accepts.** `hooks::intercept` exits 2 on any
argv it does not recognise. That guard exists because a typo once opened ~18 walls, so it
allows exactly `[--autostart]` and nothing longer. When an autostarted launch finds the wall
already held (`claim_wall`), it exits silently and logs why, instead of putting a box on her
screen at login.

**A debug build does not touch the entry** (`owns_entry`) unless `VOLERY_AUTOSTART=1`. A debug
exe's front end is a vite server that will not be running at sign-in, and the debug build
shares `dev.skein.studio` with the installed app. Writing the entry there would overwrite the
installed wall's entry with one that opens blank.

**The settings live in the registry, not the store**: `HKCU\Software\Volery\<identifier>`,
values `KeepAwakeOnMains` and `ReopenAfterRestart`, absent meaning on. Both describe this
Windows session and mean nothing on another machine. Keeping them out of the store also avoids
taking a schema rung in a week when three were already queued.

### Why not `RegisterApplicationRestart`

It only reopens apps at sign-in when "save my restartable apps and restart them" is on
(`HKCU\…\Winlogon\RestartApps`). That setting is off on the home machine, and nothing here
controls it. It would also relaunch the app after a crash through WER, which is a separate
feature nobody asked for. Running the two mechanisms together would mean two launches at
sign-in, which the silent `claim_wall` exit would absorb but which buys nothing.

### ARSO: whether `Run` is ever reached with nobody there

`Run` fires at sign-in. After a restart, the only sign-in that happens without a person is
Winlogon automatic restart sign-on, which signs the last interactive user back in and
**locks** the session. The source is Microsoft's ARSO page, dated 2025-05:

| | Windows Update | `shutdown -g` | user-initiated restart / shutdown |
|---|---|---|---|
| unmanaged | yes | yes | yes |
| managed (AD or Entra joined) | yes | yes | **no** |

- On a managed machine it additionally needs TPM 2.0, Secure Boot and BitLocker, unless IT
  overrides that. This is Microsoft's rule and nobody here can change it, and `reopenLine`
  says why the reach is narrower so she does not take it for a fault.
- It never covers a power cut or a hard crash, because the credentials are set up during an
  orderly restart. It also never covers a session she signed out of.
- `DisableAutomaticRestartSignOn = 1` under `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\
  Policies\System` means an administrator has turned it off.
- Her own switch is "use my sign-in info to automatically finish setting up after an update"
  in sign-in options, stored at `HKLM\…\Winlogon\UserARSO\<SID>\OptOut` (0 on, 1 off). **A
  switch that has never been touched has no value at all.** Its default is not recorded
  anywhere this code can read, so the line says what it is resting on ("if 'use my sign-in
  info' is on") instead of claiming the switch is on.
- "Managed" means `CloudDomainJoin\JoinInfo` has a subkey (Entra) or the computer has a DNS
  domain (AD). Workplace *registration*, meaning a work account added to a personal machine,
  writes neither, and the home machine is in that state.

`tools/check-machine.ps1` reads all of this, plus the lid action and the standby states, on
whatever machine it is run on. It is read-only and needs no admin. It was written to be run
on `AU-LT-288` the next time that machine is up.

## Not built, on purpose

- **AutoAdminLogon**: a clear-text password in the registry, almost certainly blocked by
  policy on a company machine, and a real exposure on one that is not.
- **A service or a run-without-session task**: needs admin.
