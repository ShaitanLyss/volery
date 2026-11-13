/* The machine series over the room's span (§6, §11).
 *
 * `machine_facts` answers the rows a wall recorded; this is the four lines
 * between that command and the block, so the fold stays testable without Tauri.
 * Read when the room opens and when the span changes, never on a clock: the
 * writer is one row a minute and the live panel above already says what this
 * machine is doing right now.
 */

import { invoke } from "@tauri-apps/api/core";
import type { MachineNow } from "./machinefacts";

/** What one read answers: the rows, the grain they were folded to, and why they
 *  could not be read where they could not. `rows: null` is a failed read and
 *  `[]` is a span this wall recorded nothing in, which the block words apart. */
export type MachineRead = {
  rows: MachineNow[] | null;
  /** The bucket width the rows are at, in ms. A minute is the record itself;
   *  anything wider is an average, and the face says so. */
  grain: number;
  fault: string;
};

/** A fixture reader for the browser preview, which has no store:
 *  `analytics.html` sets one and the same block is drawn from made-up rows.
 *  The same seam `waterfall.standIn` is. */
let standing: ((from: number, to: number) => MachineNow[]) | null = null;

export function standMachine(make: ((from: number, to: number) => MachineNow[]) | null) {
  standing = make;
}

/** The grain a span is read at: the record itself up to about 720 points,
 *  coarser beyond, because a year of minute rows is half a million of them and
 *  a sparkline has nowhere to put them. The **caller is told** the grain it got,
 *  so a coarse reading can say it is one. */
export function grainFor(from: number, to: number): number {
  const width = Math.max(0, to - from);
  return Math.max(60_000, Math.ceil(width / 720 / 60_000) * 60_000);
}

export async function readMachine(from: number, to: number): Promise<MachineRead> {
  const grain = grainFor(from, to);
  if (standing) return { rows: standing(from, to), grain: 60_000, fault: "" };
  try {
    const rows = await invoke<MachineNow[]>("machine_facts", { from, to, bucket: grain });
    return { rows: Array.isArray(rows) ? rows : [], grain, fault: "" };
  } catch (err) {
    return { rows: null, grain, fault: String(err) };
  }
}
