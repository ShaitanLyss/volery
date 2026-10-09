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
import { normalize, UNSUPPORTED, type MachineStatus } from "./machine";

export class Machine {
  status = $state<MachineStatus>(UNSUPPORTED);
  #listeners = new Listeners();

  constructor() {
    this.#listeners.keep(
      listen("machine:changed", (e) => {
        this.status = normalize(e.payload);
      }),
    );
    void this.refresh();
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
  async toggle(knob: "awake" | "reopen"): Promise<MachineStatus> {
    const on = knob === "awake" ? !this.status.awake : !this.status.reopen;
    this.status = normalize(await invoke("machine_set", { knob, on }));
    return this.status;
  }

  detach() {
    this.#listeners.detach();
  }
}
