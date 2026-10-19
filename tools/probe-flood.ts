/* Reproduce the night a dev server froze the wall, and show what the sluice does
 * to it — with the real pump and the real sluice, and a real flooding child.
 *
 *     bun tools/probe-flood.ts            # both arms, 12s of flood each
 *     bun tools/probe-flood.ts 20         # longer
 *
 * ### What it is, and what it is not
 *
 * On 2026-10-19 a nova dev server printed 741,000 lines in five minutes, peaking
 * at 32,000 in one second, and the wall stopped answering for ten minutes. The
 * mechanism was one `app.emit` per line onto the main thread's queue, which is
 * unbounded and is also the thread that delivers every card's events and
 * answers every command (`src-tauri/src/sluice.rs` has the whole account).
 *
 * This lifts `pump_lines` out of `servers.rs` and the whole of `sluice.rs`, and
 * builds them with `rustc` into one probe. The probe spawns a child that prints
 * a Next.js "Module not found" block as fast as it can, reads it with the real
 * pump, and emits into a **stand-in main thread**: one thread draining a queue,
 * spending a fixed cost per emit and per item, which is the shape of Tauri's
 * event loop (`send_user_message` → `proxy.send_event`, then an evaluation in
 * the webview). Beside the flood, a "card" posts a small event every 100ms and
 * the probe records how long each waits to be handled — the reading that went to
 * ten minutes that night.
 *
 * Two arms over the same child: `per-line`, which is the code as it was, and
 * `sluice`, which is the code as it is. What it cannot do is run the Tauri event
 * loop itself — that needs a built app, and so a lab wall on a machine with
 * MSVC. The per-emit cost is a parameter, not a measurement; the result does not
 * hinge on its value, because the per-line arm's backlog grows with *any*
 * non-zero cost once the child outprints it, and the sluice's emit count does
 * not depend on the cost at all.
 *
 * No API turn, nothing on the wall touched. Costs one core for the flood's
 * length per arm.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt, rustEnv } from "./lift-scan.ts";

const SECS = Number(process.argv[2] ?? 12);

const servers = readFileSync("src-tauri/src/servers.rs", "utf8").split(/\r?\n/);
function find(what: string): string {
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < servers.length; i++) if (re.test(servers[i])) return blockAt(servers, i, "servers.rs");
  throw new Error(`could not find "${what}" in servers.rs — has it been renamed?`);
}
const sluice = readFileSync("src-tauri/src/sluice.rs", "utf8").replace(/\r\n/g, "\n");

const MAIN = String.raw`
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What the stand-in main thread is asked to do.
enum Job {
    /// One emit carrying \`n\` items, and how many it said it skipped —
    /// counted, never serialised, so they cost the main thread nothing.
    Emit(usize, usize),
    /// The card's small event, stamped when it was posted.
    Ping(Instant),
    Done,
}

/// The stand-in main thread's cost: per emit, and per item inside one.
const PER_EMIT: Duration = Duration::from_micros(150);
const PER_ITEM: Duration = Duration::from_micros(2);

fn spin(d: Duration) {
    let t = Instant::now();
    while t.elapsed() < d {}
}

fn main() {
    let arm = std::env::args().nth(1).unwrap();
    let secs: u64 = std::env::args().nth(2).unwrap().parse().unwrap();
    let (tx, rx) = mpsc::channel::<Job>();
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    use std::sync::{Arc, Mutex};
    /* Emits waiting in the queue, and every ping's wait so far — shared, so the
       report can be read without draining a backlog that takes minutes. */
    let backlog = Arc::new(AtomicU64::new(0));
    let waits = Arc::new(Mutex::new(Vec::<Duration>::new()));
    let tally = Arc::new((AtomicU64::new(0), AtomicU64::new(0)));

    /* The main thread: handles jobs in order, records each ping's wait. */
    {
        let backlog = backlog.clone();
        let waits = waits.clone();
        let tally = tally.clone();
        std::thread::spawn(move || {
            for job in rx {
                match job {
                    Job::Emit(n, skipped) => {
                        tally.0.fetch_add(1, Relaxed);
                        tally.1.fetch_add((n + skipped) as u64, Relaxed);
                        spin(PER_EMIT + PER_ITEM * n as u32);
                        backlog.fetch_sub(1, Relaxed);
                    }
                    Job::Ping(at) => waits.lock().unwrap().push(at.elapsed()),
                    Job::Done => break,
                }
            }
        });
    }

    /* The card, posting beside the flood. */
    let ptx = tx.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pstop = stop.clone();
    let pinger = std::thread::spawn(move || {
        while !pstop.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = ptx.send(Job::Ping(Instant::now()));
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    /* The flood: a Next.js module-not-found block, as fast as node can write. */
    let script = format!(
        "const b='\\u001b[31mx ./node_modules/postcss/lib/input.js:3:18\\u001b[0m\\nModule not found: Can\\'t resolve \\'nanoid/non-secure\\'\\n'+'    ./node_modules/postcss/lib/postcss.js\\n'.repeat(28);const end=Date.now()+{}*1000;function go(){{while(Date.now()<end){{if(!process.stdout.write(b))return process.stdout.once('drain',go)}}}}go();",
        secs
    );
    let mut child = Command::new("node")
        .args(["-e", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("node on PATH");
    let mut out = child.stdout.take().unwrap();

    let started = Instant::now();
    let mut flood_at: Option<Duration> = None;
    let mut lines = 0u64;
    if arm == "per-line" {
        pump_lines(&mut out, |_line| {
            lines += 1;
            backlog.fetch_add(1, Relaxed);
            let _ = tx.send(Job::Emit(1, 0));
        });
    } else {
        let etx = tx.clone();
        let eb = backlog.clone();
        let (htx, hrx) = mpsc::channel::<Heat>();
        let s = Sluice::open(
            Spec { name: "server:log", cap: Some(400), period: Duration::from_millis(100),
                   flood: Some(Flood { rate: 1_000, after: Duration::from_secs(5) }) },
            move |batch: Vec<String>, skipped| { eb.fetch_add(1, Relaxed); let _ = etx.send(Job::Emit(batch.len(), skipped)); },
            move |h, _| { let _ = htx.send(h); },
        );
        pump_lines(&mut out, |line| {
            lines += 1;
            s.push(line);
        });
        drop(s);
        for h in hrx.try_iter() {
            if h.flooding && flood_at.is_none() {
                flood_at = Some(h.hot_for);
            }
        }
    }
    let _ = child.wait();
    let flood_ended = started.elapsed();
    /* Up to ten seconds for the main thread to catch up, pinging all the while
       — then read it as it stands rather than wait out a backlog of minutes. */
    let deadline = Instant::now() + Duration::from_secs(10);
    while backlog.load(Relaxed) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let left = backlog.load(Relaxed);
    let caught = (left == 0).then(|| started.elapsed());
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = pinger.join();
    let _ = tx.send(Job::Done);
    let (emits, items) = (tally.0.load(Relaxed), tally.1.load(Relaxed));

    let mut w = waits.lock().unwrap().clone();
    if w.is_empty() { w.push(started.elapsed()); }
    w.sort();
    let p = |q: f64| w[((w.len() as f64 - 1.0) * q) as usize];
    println!("arm            {arm}");
    println!("lines printed  {lines} in {:.1}s ({:.0}/s)", flood_ended.as_secs_f64(), lines as f64 / flood_ended.as_secs_f64());
    println!("emits          {emits} ({:.0}/s), covering {items} lines", emits as f64 / flood_ended.as_secs_f64());
    println!("card waits     p50 {:?}  p99 {:?}  max {:?}  ({} pings)", p(0.5), p(0.99), w[w.len() - 1], w.len());
    match caught {
        Some(at) => println!("main caught up {:.1}s after the flood ended", (at - flood_ended).as_secs_f64()),
        None => println!(
            "main NOT caught up 10s after the flood ended: {left} emits still queued, ~{:.0}s more to drain; every ping since is waiting behind them",
            (left as f64) * PER_EMIT.as_secs_f64()
        ),
    }
    if let Some(at) = flood_at { println!("flood marked   after {:.0}s hot", at.as_secs_f64()); }
    std::process::exit(0);
}
`;

const lift = [
  "//! GENERATED by tools/probe-flood.ts — do not edit, do not keep.",
  "#![allow(dead_code)]",
  "mod sluice {",
  sluice,
  "}",
  "use sluice::*;",
  find("const MAX_LINE"),
  find("fn pump_lines"),
  MAIN,
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "probe-flood-"));
const file = join(dir, "flood.rs");
const exe = join(dir, "flood.exe");
writeFileSync(file, lift);
try {
  const build = spawnSync("rustc", ["--edition", "2021", "-O", file, "-o", exe], {
    encoding: "utf8",
    env: rustEnv(),
  });
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe probe is at ${file} — kept so you can read it.`);
    process.exit(1);
  }
  for (const arm of ["per-line", "sluice"]) {
    const run = spawnSync(exe, [arm, String(SECS)], { encoding: "utf8", timeout: 600_000 });
    console.log(run.stdout);
    if (run.status !== 0) console.error(run.stderr);
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the exe may still be held; it is in the temp dir either way */
  }
}
