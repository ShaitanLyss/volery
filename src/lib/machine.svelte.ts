/* The machine's two settings, as the wall reads them.
 *
 * Folded rather than polled: Rust emits `machine:changed` when the power source
 * changes, which is the one fact here that moves on its own. What the lid does
 * and whether Windows will sign her back in are settings she changes in
 * Windows, outside this window — so they are asked again when she comes back
 * to it (`refresh` on focus, from App.svelte), which is the moment the answer is
 * worth having, and never on a clock. See `machine.ts` for the wording and
 * `machine.rs` for the facts.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Listeners } from "./listeners";
import { normalize, RECORD_KEY, UNSUPPORTED, type MachineStatus } from "./machine";

/** The stored choice about the machine series, on unless turned off. A
 *  `localStorage` that refuses (a browser preview, a locked profile) reads as
 *  on, which is the default everywhere else. */
function readRecording(): boolean {
  try {
    return localStorage.getItem(RECORD_KEY) !== "0";
  } catch {
    return true;
  }
}

export class Machine {
  status = $state<MachineStatus>(UNSUPPORTED);
  /** Whether this wall records its own machine series (§6 of the analytics
   *  design). Handed to Rust at construction, so a launch is recording — or
   *  not — from the first tick rather than from the first panel opened. */
  recording = $state<boolean>(readRecording());
  #listeners = new Listeners();

  constructor() {
    this.#listeners.keep(
      listen("machine:changed", (e) => {
        this.status = normalize(e.payload);
      }),
    );
    void this.refresh();
    this.#noteRecording();
  }

  #noteRecording() {
    void invoke("machine_record", { on: this.recording }).catch(() => {
      /* No wall behind this page, or a build without the command: the power
         half already says which, and a failed note costs the history rather
         than the wall. */
    });
  }

  /** Turn the recording on or off, and say what is now true. */
  setRecording(on: boolean): boolean {
    this.recording = on;
    try {
      localStorage.setItem(RECORD_KEY, on ? "1" : "0");
    } catch {
      /* A profile that will not store it keeps the choice for this run. */
    }
    this.#noteRecording();
    return this.recording;
  }

  async refresh() {
    try {
      this.status = normalize(await invoke("machine_status"));
    } catch {
      /* Off Windows, or a build without the command: the status already says
         `supported: false`, which is what every line words. */
    }
  }

  /** Flip one knob and hand back what is now true, for the chord to say. */
  async toggle(knob: "awake" | "reopen" | "idle"): Promise<MachineStatus> {
    const on = !this.status[knob];
    this.status = normalize(await invoke("machine_set", { knob, on }));
    return this.status;
  }

  detach() {
    this.#listeners.detach();
  }
}
