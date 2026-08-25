// What does `nvim --embed` actually do over plain pipes on this machine?
//
// The whole question behind editing files in Volery. `.claude/rules/shell.md`
// records that ConPTY does not work here — every `openpty` child dies at
// 0xC0000142 before it runs — so the terminal-emulator route to nvim is dead
// before it starts. nvim's own UI protocol needs no terminal at all: `--embed`
// speaks msgpack-RPC over stdin/stdout, which is the same three pipes the
// floating shell and the dev servers already use.
//
//   bun tools/probe-nvim.ts            # bare nvim, -u NONE
//   bun tools/probe-nvim.ts --config   # with this machine's init.lua
//   bun tools/probe-nvim.ts --drive    # every RPC the app makes, in order
//
// Reports: whether it attaches, how long the user config costs, which redraw
// events arrive, and what the grid holds after opening a real file.
//
// `--drive` is the second half and answers a different question. This machine
// has no MSVC toolchain, so neither `cargo test` nor `bun run tauri dev` runs
// here (`.claude/rules/build.md`) — which means the app itself cannot be put in
// front of a real nvim on it. So the probe makes the same six calls `nvim.rs`
// makes, with the *same* Lua read out of that file rather than a copy of it,
// and prints what nvim did about them. It cannot prove the app is wired up; it
// can prove none of the RPC is misspelled, mis-arited, or wrong about escaping.

import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/* ── just enough msgpack ──────────────────────────────────────────────────── */

function enc(v: any, out: number[] = []): number[] {
  if (v === null) out.push(0xc0);
  else if (v === true) out.push(0xc3);
  else if (v === false) out.push(0xc2);
  else if (typeof v === "number") {
    /* Negatives first, and they are not academic: `nvim_paste` takes a phase of
       `-1` for "the whole paste is in this call", and without this branch it
       encodes as a uint32 and nvim answers `Invalid 'phase': 4294967295`. */
    if (v < 0) {
      if (v >= -32) out.push(v & 0xff);
      else out.push(0xd2, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    } else if (v < 128) out.push(v);
    else if (v < 65536) out.push(0xcd, v >> 8, v & 0xff);
    else out.push(0xce, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  } else if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    /* All three widths, and str8 is not enough: `0xd9` carries a *one-byte*
       length, so anything past 255 bytes wraps and the frame is silently
       corrupt — the stream then desyncs and nvim never answers again, with no
       error anywhere to say why. Cost an hour; the Lua `nvim.rs` sends is about
       500 bytes and was the first thing long enough to hit it. */
    if (b.length < 32) out.push(0xa0 | b.length);
    else if (b.length < 256) out.push(0xd9, b.length);
    else if (b.length < 65536) out.push(0xda, b.length >> 8, b.length & 0xff);
    else out.push(0xdb, (b.length >>> 24) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 8) & 0xff, b.length & 0xff);
    for (const x of b) out.push(x);
  } else if (Array.isArray(v)) {
    if (v.length < 16) out.push(0x90 | v.length);
    else out.push(0xdc, v.length >> 8, v.length & 0xff);
    for (const x of v) enc(x, out);
  } else {
    const k = Object.keys(v);
    out.push(0x80 | k.length);
    for (const key of k) { enc(key, out); enc(v[key], out); }
  }
  return out;
}

class Dec {
  constructor(public b: Buffer, public i = 0) {}
  need(n: number) { if (this.i + n > this.b.length) throw new RangeError("short"); }
  read(): any {
    this.need(1);
    const t = this.b[this.i++];
    if (t < 0x80) return t;
    if (t >= 0xe0) return t - 256;
    if ((t & 0xf0) === 0x80) return this.map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return this.arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return this.str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { this.need(1); const n = this.b[this.i++]; this.need(n); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
      // nvim hands out Buffer/Window/Tabpage handles as msgpack *ext* types, so
      // a client that does not know about ext chokes the moment one appears.
      case 0xc7: { this.need(2); const n = this.b[this.i++]; return this.ext(n); }
      case 0xc8: { this.need(3); const n = this.b.readUInt16BE(this.i); this.i += 2; return this.ext(n); }
      case 0xc9: { this.need(5); const n = this.b.readUInt32BE(this.i); this.i += 4; return this.ext(n); }
      case 0xcc: this.need(1); return this.b[this.i++];
      case 0xcd: { this.need(2); const v = this.b.readUInt16BE(this.i); this.i += 2; return v; }
      case 0xce: { this.need(4); const v = this.b.readUInt32BE(this.i); this.i += 4; return v; }
      case 0xcf: { this.need(8); const v = Number(this.b.readBigUInt64BE(this.i)); this.i += 8; return v; }
      case 0xd0: this.need(1); return this.b.readInt8(this.i++);
      case 0xd1: { this.need(2); const v = this.b.readInt16BE(this.i); this.i += 2; return v; }
      case 0xd2: { this.need(4); const v = this.b.readInt32BE(this.i); this.i += 4; return v; }
      case 0xd3: { this.need(8); const v = Number(this.b.readBigInt64BE(this.i)); this.i += 8; return v; }
      case 0xd4: return this.ext(1);
      case 0xd5: return this.ext(2);
      case 0xd6: return this.ext(4);
      case 0xd7: return this.ext(8);
      case 0xd8: return this.ext(16);
      case 0xd9: { this.need(1); return this.str(this.b[this.i++]); }
      case 0xda: { this.need(2); const n = this.b.readUInt16BE(this.i); this.i += 2; return this.str(n); }
      case 0xdc: { this.need(2); const n = this.b.readUInt16BE(this.i); this.i += 2; return this.arr(n); }
      case 0xdd: { this.need(4); const n = this.b.readUInt32BE(this.i); this.i += 4; return this.arr(n); }
      case 0xde: { this.need(2); const n = this.b.readUInt16BE(this.i); this.i += 2; return this.map(n); }
      case 0xdf: { this.need(4); const n = this.b.readUInt32BE(this.i); this.i += 4; return this.map(n); }
      default: throw new Error(`msgpack byte 0x${t.toString(16)}`);
    }
  }
  ext(n: number) { this.need(n + 1); const type = this.b[this.i++]; const data = this.b.subarray(this.i, this.i + n); this.i += n; return { ext: type, data }; }
  str(n: number) { this.need(n); const s = this.b.toString("utf8", this.i, this.i + n); this.i += n; return s; }
  arr(n: number) { const a = []; for (let k = 0; k < n; k++) a.push(this.read()); return a; }
  map(n: number) { const o: any = {}; for (let k = 0; k < n; k++) { const key = this.read(); o[key] = this.read(); } return o; }
}

/* ── the probe ────────────────────────────────────────────────────────────── */

const drive = process.argv.includes("--drive");
const withConfig = process.argv.includes("--config") || drive;
/* `--drive` types into a buffer, and a probe that is killed holding a modified
   one leaves a swap file — after which the *next* run opens behind nvim's
   "ATTENTION / swap file found" prompt, which waits for a key that no probe
   sends, and every call after it simply never answers. That is nvim behaving
   correctly and a probe behaving badly; it cost an hour of reading the wrong
   thing. So this one keeps no swap of its own, and writes to a scratch file
   rather than to anything in the repository. */
const argv = withConfig
  ? ["--embed", "--headless", ...(drive ? ["--cmd", "set noswapfile"] : [])]
  : ["--embed", "--headless", "-u", "NONE"];

const t0 = Date.now();
const nvim = spawn("nvim", argv, { stdio: ["pipe", "pipe", "pipe"] });

let buf = Buffer.alloc(0);
const events = new Map<string, number>();
let attached = 0;
let bytes = 0;
const grid: string[][] = [];
const attrs = new Set<number>();
let stderr = "";

nvim.stderr.on("data", (d) => (stderr += d.toString()));
nvim.on("error", (e) => { console.log("spawn failed:", e.message); process.exit(1); });

nvim.stdout.on("data", (d: Buffer) => {
  bytes += d.length;
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length === 0) return;
    const dec = new Dec(buf);
    let msg;
    try { msg = dec.read(); } catch (e) {
      if (e instanceof RangeError) return;      // partial frame, wait for more
      console.log("decode error:", (e as Error).message);
      buf = Buffer.alloc(0);
      return;
    }
    buf = buf.subarray(dec.i);
    if (msg[0] === 1) {
      if (!attached) attached = Date.now() - t0;
      if (msg[2]) console.log("rpc error:", JSON.stringify(msg[2]));
      const settle = answers.get(msg[1]);
      if (settle) {
        answers.delete(msg[1]);
        settle(msg[2] ? { error: msg[2] } : msg[3]);
      }
    } else if (msg[0] === 2 && msg[1] === "redraw") {
      for (const batch of msg[2]) {
        const kind = batch[0];
        events.set(kind, (events.get(kind) ?? 0) + batch.length - 1);
        if (kind === "hl_attr_define") for (let k = 1; k < batch.length; k++) attrs.add(batch[k][0]);
        if (kind === "grid_line") {
          for (let k = 1; k < batch.length; k++) {
            const [, row, col, cells] = batch[k];
            const line = (grid[row] ??= []);
            let c = col;
            for (const cell of cells) {
              const [txt, , rep] = cell;
              for (let r = 0; r < (rep ?? 1); r++) line[c++] = txt;
            }
          }
        }
        if (kind === "grid_clear") grid.length = 0;
      }
    }
  }
});

let nextId = 1;
const answers = new Map<number, (v: any) => void>();

const send = (method: string, params: any[]) =>
  nvim.stdin.write(Buffer.from(enc([0, nextId++, method, params])));

/** Send and wait for the answer. Only `--drive` uses this: the app never waits
 *  for a response, because everything it asks nvim to do is a command whose
 *  effect arrives as a redraw. A probe wants the answer itself. */
const ask = (method: string, params: any[]): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId;
    answers.set(id, resolve);
    send(method, params);
    setTimeout(() => { if (answers.delete(id)) resolve("(no answer)"); }, 4000);
  });

send("nvim_ui_attach", [100, 20, { ext_linegrid: true, rgb: true }]);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await wait(withConfig ? 5000 : 800);
const settled = Date.now() - t0;
console.log(`${withConfig ? "with user config" : "-u NONE"}: attach ack after ${attached}ms, ${bytes} bytes in ${settled}ms`);

if (drive) {
  /* The app's own Lua, read out of the Rust rather than copied — a probe that
     carried its own copy would go on passing after the real one broke. */
  const rust = readFileSync("src-tauri/src/nvim.rs", "utf8");
  const lua = rust.split('const OPEN_LUA: &str = r#"')[1]?.split('"#;')[0];
  if (!lua) throw new Error("OPEN_LUA is no longer where this probe looks for it");

  /* Real content, in a real file, that is nobody else's. `finding.ts` was the
     first version of this and was a mistake: the probe types into what it
     opens. */
  const target = (tmpdir() + "/volery-probe-nvim.ts").replace(/\\/g, "/");
  writeFileSync(
    target,
    Array.from({ length: 200 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n"),
  );
  const say = (label: string, got: unknown, want?: unknown) =>
    console.log(
      `  ${want === undefined ? " " : JSON.stringify(got) === JSON.stringify(want) ? "\u2713" : "\u2717"} ${label}: ${JSON.stringify(got)}`,
    );

  console.log("\n--- the calls nvim.rs makes, against a real nvim ---");

  /* editor_open, past the end of the file on purpose: the clamp is the thing
     under test, since the finder's line comes from a grep against what was on
     disk and an agent may have shortened the file since. */
  await ask("nvim_exec_lua", [lua, [target, 99_999]]);
  const lines = await ask("nvim_buf_line_count", [0]);
  const at = await ask("nvim_win_get_cursor", [0]);
  const name = await ask("nvim_buf_get_name", [0]);
  say("opened the file it was given", String(name).endsWith("volery-probe-nvim.ts"), true);
  say("a line past the end was clamped to the last", [at?.[0], lines], [200, 200]);

  /* editor_open again, at a real line, on a *modified* buffer — the E37 path.
     `:edit` refuses there; the Lua switches to the buffer instead. */
  await ask("nvim_input", ["ix<Esc>"]);
  await wait(300);
  say("buffer is modified", await ask("nvim_get_option_value", ["modified", {}]), true);
  await ask("nvim_exec_lua", [lua, [target, 42]]);
  await wait(300);
  say("re-opened anyway, at the line asked for", (await ask("nvim_win_get_cursor", [0]))?.[0], 42);

  /* editor_input, in nvim's own notation. */
  await ask("nvim_input", ["<Esc>u"]);
  await wait(300);
  say("undo left it unmodified", await ask("nvim_get_option_value", ["modified", {}]), false);

  /* editor_paste — the reason it is not input. Indented lines through
     `nvim_input` in insert mode come back re-indented into a staircase by
     whatever `autoindent` and any autopair plugin decide; through `paste` they
     arrive as they were. */
  await ask("nvim_input", ["GA<CR>"]);
  await wait(200);
  await ask("nvim_paste", ["  if (a) {\n    b();\n  }", false, -1]);
  await wait(400);
  const pasted = await ask("nvim_buf_get_lines", [0, -4, -1, false]);
  say("paste kept its own indentation", pasted, ["  if (a) {", "    b();", "  }"]);

  /* editor_mouse. A click at row 3 puts the cursor there, which is the whole
     of what the panel needs it for. */
  await ask("nvim_input", ["<Esc>gg"]);
  await wait(200);
  await ask("nvim_input_mouse", ["left", "press", "", 1, 3, 5]);
  await ask("nvim_input_mouse", ["left", "release", "", 1, 3, 5]);
  await wait(300);
  say("a click moved the cursor", await ask("nvim_win_get_cursor", [0]));

  /* editor_resize. */
  await ask("nvim_ui_try_resize", [60, 15]);
  await wait(500);
  const cols = await ask("nvim_get_option_value", ["columns", {}]);
  const rows = await ask("nvim_get_option_value", ["lines", {}]);
  say("resize took", [cols, rows], [60, 15]);

  /* Leave nothing behind. `noswapfile` above is the half that matters — a
     swap file outlives the process and breaks the *next* run — and this is the
     scratch file itself. */
  await ask("nvim_command", ["set nomodified"]);
  say("nothing left modified", await ask("nvim_get_option_value", ["modified", {}]), false);
  rmSync(target, { force: true });
} else {
  // Open a real file, so treesitter and any LSP have something to do.
  send("nvim_command", ["edit " + process.cwd().replace(/\\/g, "/") + "/src/lib/finding.ts"]);
  await wait(withConfig ? 4000 : 800);
  send("nvim_input", ["50G"]);
  await wait(600);
}

console.log("\nredraw events:");
for (const [k, n] of [...events].sort((a, b) => b[1] - a[1])) console.log("  " + String(n).padStart(6) + "  " + k);
console.log("\n" + attrs.size + " distinct highlight attrs defined");

console.log("\ngrid rows 0-6 as painted:");
for (let r = 0; r < 7; r++) console.log("  |" + (grid[r] ?? []).join("").replace(/\s+$/, "") + "|");
console.log("last row (statusline/cmdline):");
console.log("  |" + (grid[19] ?? []).join("").replace(/\s+$/, "") + "|");

if (stderr.trim()) console.log("\nstderr:\n" + stderr.trim().split("\n").slice(0, 8).map((l) => "  " + l).join("\n"));

nvim.kill();
