/* The machine's own readings, said and folded (§6).
 *
 * One shape, two sources: the history a wall records once a minute
 * (`machine_fact`) and the live half of a beat from another wall (§8.3). Both
 * reach the face as the same fields, so a reading of this machine and a reading
 * of the one beside it are drawn by one function and cannot disagree about what
 * a figure means.
 *
 * **`null` is "could not read", and it is never drawn as 0.** A GPU this build
 * cannot ask about and a GPU at rest are different facts; the sampling module
 * returns `None`, the wire carries `null`, and every sentence here skips the
 * part rather than printing a zero. That is the rule `perf.rs` and `limits.rs`
 * both keep, and a machine series is where it matters most: a run of zeros
 * looks like an idle machine, which is exactly what somebody diagnosing a slow
 * afternoon is trying to rule out.
 */

/** One machine reading, as `machinefacts.rs::Sample` and the live beat's
 *  `Now` both carry it. */
export type MachineNow = {
  at?: number;
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  gpu: number | null;
  gpuMem?: number | null;
  diskRead?: number | null;
  diskWrite?: number | null;
  diskFree?: number | null;
  netRx: number | null;
  netTx: number | null;
  procs?: number | null;
  cards?: number | null;
  cardsWorking?: number | null;
  worktrees: number | null;
};

/** A percentage, floored to a whole number: a machine reading that moved
 *  between 12.4 and 12.6 would redraw for nothing, and the floor is the same
 *  rule the allowance faces keep. */
export function pct(v: number): string {
  return `${Math.floor(Math.max(0, Math.min(100, v)))}%`;
}

/** Bytes as a person reads a memory figure: binary units, one decimal under
 *  10 GB so 8.2 is distinguishable from 8.9. */
export function gib(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 100) return `${Math.round(g)}GB`;
  return `${g.toFixed(g >= 10 ? 0 : 1)}GB`;
}

/** A rate in bytes a second, in the unit that makes it readable. */
export function rate(bytes: number): string {
  if (!(bytes > 0)) return "0";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let at = 0;
  while (v >= 1024 && at < units.length - 1) {
    v /= 1024;
    at += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)}${units[at]}/s`;
}

/** The capacity half alone, for a row that already carries a rate: the live
 *  panel's line is one machine beside its spend, and a network figure there
 *  would be a second rate in the same clause. */
export function capacitySaid(m: MachineNow): string {
  const parts: string[] = [];
  if (m.cpu !== null) parts.push(`cpu ${pct(m.cpu)}`);
  if (m.memUsed !== null && m.memTotal !== null) parts.push(`mem ${gib(m.memUsed)} of ${gib(m.memTotal)}`);
  if (m.gpu !== null) parts.push(`gpu ${pct(m.gpu)}`);
  return parts.join(" · ");
}

/** One machine, in a line: only what could be read, oldest fact first. */
export function machineSaid(m: MachineNow): string {
  const parts: string[] = [];
  if (m.cpu !== null) parts.push(`cpu ${pct(m.cpu)}`);
  if (m.memUsed !== null && m.memTotal !== null) parts.push(`mem ${gib(m.memUsed)} of ${gib(m.memTotal)}`);
  if (m.gpu !== null) parts.push(`gpu ${pct(m.gpu)}`);
  if (m.netRx !== null && m.netTx !== null) parts.push(`net ${rate(m.netRx)} in, ${rate(m.netTx)} out`);
  if (m.worktrees !== null) parts.push(m.worktrees === 1 ? "1 worktree" : `${m.worktrees} worktrees`);
  return parts.join(" · ");
}

/** The figures a capacity line needs: the latest reading and the peak over the
 *  span. `null` where the window holds no reading of that measure at all —
 *  which is not the same as a window full of zeros, and a face must say so. */
export type Folded = {
  last: number | null;
  peak: number | null;
  low: number | null;
  /** The readings, oldest first, for a sparkline. */
  points: number[];
};

export function fold(readings: readonly MachineNow[], pick: (m: MachineNow) => number | null): Folded {
  const points: number[] = [];
  let last: number | null = null;
  let peak: number | null = null;
  let low: number | null = null;
  for (const m of readings) {
    const v = pick(m);
    if (v === null || !Number.isFinite(v)) continue;
    points.push(v);
    last = v;
    peak = peak === null || v > peak ? v : peak;
    low = low === null || v < low ? v : low;
  }
  return { last, peak, low, points };
}

/** Whether any reading in the window carried this measure at all. A face that
 *  draws "not read" over an empty history and over a history of unreadable
 *  counters is drawing one sentence for two different facts, and this is what
 *  lets it keep them apart. */
export function measured(readings: readonly MachineNow[], pick: (m: MachineNow) => number | null): boolean {
  return readings.some((m) => {
    const v = pick(m);
    return v !== null && Number.isFinite(v);
  });
}

/** What a capacity figure is called on a face, lowercase and quiet. */
export const MACHINE_ROWS: readonly {
  key: string;
  label: string;
  pick: (m: MachineNow) => number | null;
  said: (v: number) => string;
  /** The second figure is the **low** over the span rather than the peak. For
   *  free space that is the interesting one: a disk that touched 2 GB free is
   *  the finding, and its peak is the same number as now on a quiet machine. */
  least?: boolean;
}[] = [
  { key: "cpu", label: "cpu", pick: (m) => m.cpu, said: pct },
  {
    key: "mem",
    label: "memory",
    pick: (m) => (m.memUsed !== null && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null),
    said: pct,
  },
  { key: "gpu", label: "gpu", pick: (m) => m.gpu, said: pct },
  {
    key: "disk",
    label: "disk free",
    pick: (m) => m.diskFree ?? null,
    said: gib,
    least: true,
  },
  {
    key: "net",
    label: "network in",
    pick: (m) => m.netRx,
    said: rate,
  },
];
