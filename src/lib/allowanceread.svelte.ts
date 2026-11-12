/* The live strip's one read (§3.3, §11.1).
 *
 * Allowance samples are noted by the front end as they arrive — the poll, a
 * card's `rate_limit_event`, a peer's reading — and read back here as points for
 * the strip. The room asks for the last eight days whatever span it is showing:
 * the strip's residual is "this week" and the binding window is the current
 * instance, so a year of samples would be a table read for a number nothing on
 * the face is asking.
 *
 * Its own file for the reason every subsystem here has one: the pure fold stays
 * testable because it never imports Tauri.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  asAllowanceCosts,
  asAllowanceSamples,
  type AllowanceCost,
  type AllowanceSample,
} from "./allowancesamples";

export type AllowanceReader = (from: number, to: number) => Promise<AllowanceSample[]>;
export type CostReader = (from: number, to: number) => Promise<AllowanceCost[]>;

export async function readAllowanceSamples(from: number, to: number): Promise<AllowanceSample[]> {
  return asAllowanceSamples(await invoke<unknown>("allowance_samples", { from, to }));
}

/** The fine-tier cost buckets a week's delta is split against (§5.1). */
export async function readAllowanceCosts(from: number, to: number): Promise<AllowanceCost[]> {
  return asAllowanceCosts(await invoke<unknown>("allowance_costs", { from, to }));
}
