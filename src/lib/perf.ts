/* Reading a process sample as something worth looking at.
 *
 * `perf.rs` answers in facts: one row per process, with the role it plays here
 * where we know it. This is where those become the handful of lines a widget
 * has room for — which is almost entirely a folding problem, because the truth
 * about a dev server is spread across five node processes and the truth about a
 * build is spread across forty cl.exe.
 *
 * Pure, and tested directly. Nothing here talks to Tauri; `perf.svelte.ts` owns
 * the sampling and `Perf.svelte` draws the result. */

export type Proc = {
  pid: number;
  ppid: number | null;
  name: string;
  /** Percent of one core — a four-thread build reads ~400. */
  cpu: number;
  mem: number;
  role: string;
  reference: string | null;
  /** Is this the process the role was recognised on, rather than a descendant? */
  own: boolean;
  /** Its parent is gone. Nothing is waiting on it and nothing will reap it. */
  orphan: boolean;
  /** Seconds since it started. */
  age: number;
};

export type Sample = {
  at: number;
  /** Which scope this reading was taken at — one sample serves every widget. */
  scope: string;
  cores: number;
  cpu: number;
  /** Each logical core, 0–100, in the platform's own order. Optional on this
   *  side alone: the field is always sent, but a front end running against an
   *  older build would otherwise read `undefined` into a graph. `cores.ts` owns
   *  what is done with it. */
  per_core?: number[];
  mem_used: number;
  mem_total: number;
  counted: number;
  other_cpu: number;
  other_mem: number;
  procs: Proc[];
};

export type Row = {
  key: string;
  label: string;
  /** What kind of thing this is, in one lowercase word — never the label. */
  role: string;
  reference: string | null;
  cpu: number;
  mem: number;
  /** How many processes were folded into this line. */
  count: number;
};

/** How a role's `reference` becomes something a person can read. The widget
 *  supplies it, because the card titles and server labels live up there. */
export type Naming = (role: string, reference: string | null) => string | null;

const ROLE_WORD: Record<string, string> = {
  studio: "skein",
  conversation: "conversation",
  server: "server",
  action: "action",
  other: "process",
};

/** One line per *thing*, not per process.
 *
 * The grouping is the whole point. A conversation is one `claude.exe` and
 * whatever it spawned; a dev server is one `pnpm` and the node tree under it;
 * a build is UBT and its compilers. Listing those flat is a list of strangers
 * that never adds up to an answer, which is the thing Task Manager is bad at
 * and the only reason for a meter to live in here at all.
 *
 * Everything the sampler could not place — the whole machine, in the wider
 * scope — folds by executable name instead, which is the same fold one level
 * out: twelve `msedgewebview2.exe` are one browser, however many windows it
 * has. */
export function fold(
  sample: Sample,
  name: Naming = () => null,
  scope = "machine",
): Row[] {
  const by = new Map<string, Row>();

  for (const p of sample.procs) {
    const other = p.role === "other";
    /* A studio-scoped widget reads the same sample and simply ignores what it
       did not ask about — one enumeration of the process table serves both. */
    if (other && scope === "skein") continue;
    const key = other ? `name:${p.name}` : `${p.role}:${p.reference ?? ""}`;
    const row = by.get(key);
    if (row) {
      row.cpu += p.cpu;
      row.mem += p.mem;
      row.count += 1;
      continue;
    }
    by.set(key, {
      key,
      label: other
        ? p.name
        : (name(p.role, p.reference) ?? ROLE_WORD[p.role] ?? p.role),
      role: p.role,
      reference: p.reference,
      cpu: p.cpu,
      mem: p.mem,
      count: 1,
    });
  }

  return [...by.values()].sort(byCost);
}

function byCost(a: Row, b: Row): number {
  /* CPU before memory: the question a wall of agents raises is what is
     *running*, not what is resident. */
  return b.cpu - a.cpu || b.mem - a.mem || a.label.localeCompare(b.label);
}

/** What the sampler itself left out, if this widget is looking at the same
 *  scope the sample was taken at.
 *
 *  It usually left out nothing: the cap is generous and the fold is what makes
 *  a list short. But a studio-scoped widget reading a machine-scoped sample
 *  must not inherit its leftovers, which are strangers — that would put a
 *  hundred unrelated processes into a line about this studio. */
export function leftover(sample: Sample, scope: string): Extra {
  if (sample.scope !== scope) return { cpu: 0, mem: 0, count: 0 };
  return {
    cpu: sample.other_cpu,
    mem: sample.other_mem,
    count: Math.max(0, sample.counted - sample.procs.length),
  };
}

export type Extra = { cpu: number; mem: number; count: number };

/** The rows a widget of this height can show, with everything below the cut
 *  gathered into one honest line.
 *
 *  The tail row carries the sampler's own leftovers as well, so a capped list
 *  still adds up to what it prints beside it: a meter whose lines sum to less
 *  than its own total is a meter nobody trusts twice. */
export function top(
  rows: Row[],
  limit: number,
  extra: Extra = { cpu: 0, mem: 0, count: 0 },
): { shown: Row[]; rest: Row | null } {
  const cut = Math.max(1, Math.floor(limit));
  const dropped = rows.slice(cut);
  const restCpu = dropped.reduce((n, r) => n + r.cpu, 0) + extra.cpu;
  const restMem = dropped.reduce((n, r) => n + r.mem, 0) + extra.mem;
  const restCount = dropped.reduce((n, r) => n + r.count, 0) + extra.count;

  return {
    shown: rows.slice(0, cut),
    rest:
      restCount > 0
        ? {
            key: "rest",
            label: `${restCount} more`,
            role: "rest",
            reference: null,
            cpu: restCpu,
            mem: restMem,
            count: restCount,
          }
        : null,
  };
}

/** A row's share of the whole machine, 0–1 — which is what a bar can be drawn
 *  against, unlike a percentage of one core that goes past 100. */
export function share(cpu: number, cores: number): number {
  return Math.min(1, Math.max(0, cpu / 100 / Math.max(1, cores)));
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Bytes, at the precision you would say out loud. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  /* A decimal only where it carries: 1.4 GB is a fact, and "862.8 MB" and
     "53.0 MB" are both a digit of noise on a number that changes every sample.
     Bytes and kilobytes never get one — nothing on a wall is read to a tenth
     of a kilobyte. */
  const s = v.toFixed(u <= 1 || v >= 100 ? 0 : 1).replace(/\.0$/, "");
  return `${s} ${UNITS[u]}`;
}

/** A CPU reading, in percent of the machine.
 *
 *  The same function for a row and for the total above it — printing 0.2% on
 *  one line and 0% on the line that sums it is a meter arguing with itself. */
export function pct(cpu: number, cores: number): string {
  const v = cpu / Math.max(1, cores);
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
}

/** The processes behind one folded row.
 *
 *  `fold` answers "what is this costing" in one line; this answers the question
 *  that line provokes — *what are those four things* — and it is the whole
 *  reason a count was never enough on its own. The key is the row's, so the two
 *  cannot drift: a row you can see is a row you can open.
 *
 *  **Orphans sort first, ahead of cost**, which is the one place this disagrees
 *  with `fold`'s ordering and does so deliberately. The rows are ranked by what
 *  is eating the machine, because that is what a meter is for. A list you opened
 *  is a list you opened to find the thing that should not be there, and the
 *  thing that should not be there is reliably cheap — every leaked process
 *  measured on this machine sat at 0%. Ranking by cost would file them last. */
export function members(sample: Sample, key: string): Proc[] {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const rest = key.slice(at + 1);
  return sample.procs
    .filter((p) =>
      kind === "name"
        ? p.role === "other" && p.name === rest
        : p.role === kind && (p.reference ?? "") === rest,
    )
    .sort(
      (a, b) =>
        Number(b.orphan) - Number(a.orphan) ||
        b.cpu - a.cpu ||
        b.mem - a.mem ||
        a.pid - b.pid,
    );
}

/** How many processes in this sample answer to nothing.
 *
 *  Drawn as a line on the list rather than a badge on the wall. The reaper
 *  takes these on its own within the minute, so a number here that is anything
 *  but briefly non-zero is the sweep failing to run — which is the one thing
 *  about it worth being able to see, since a reaper that silently stopped and
 *  one with nothing to do look identical. */
export function orphans(sample: Sample): Proc[] {
  return sample.procs.filter((p) => p.orphan && p.role !== "other");
}

/** An age, in the shortest form that is still true.
 *
 *  Coarse on purpose past the first minute: this is read to tell a process that
 *  started with the card from one that has been sitting there since yesterday,
 *  and no decision anybody makes here turns on a matter of seconds. */
export function since(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
