//! The editor behind the finder's panel — a real nvim, attached as a UI.
//!
//! Volery does not draw an editor. It runs the one already on this machine and
//! draws what that one says the screen looks like: `nvim --embed` speaks
//! msgpack-RPC over stdin and stdout, sends `redraw` batches describing a grid
//! of cells, and takes keys back. Everything in the user's `init.lua` is
//! therefore simply *there* — treesitter colouring, LSPs, telescope, cmp, the
//! lot — because it is their nvim and not an imitation of one.
//!
//! **It is pipes, and that is the whole reason this is possible here.** The
//! obvious route to nvim is a terminal emulator, and `.claude/rules/shell.md`
//! records why there is not one: ConPTY does not work on this machine, every
//! `openpty` child dies at 0xC0000142 before it runs, and both the floating
//! shell and the dev servers came off a PTY because of it. nvim's UI protocol
//! needs no terminal at all — it is three pipes, the same primitive
//! `shell.rs` and `servers.rs` already use. Probed 2026-08-25 with
//! `tools/probe-nvim.ts` against nvim 0.11.6 and this machine's own config:
//! attach acknowledged in 517ms, settled in about five seconds, 434 distinct
//! highlight attributes defined, 10.6 kB on the wire for the whole session.
//!
//! **Rust folds nothing.** A redraw batch is converted to JSON and emitted as
//! it arrived; the grid is built in `nvim.ts`, which is pure and tested. That
//! is the same division the event pipeline already makes for `claude` itself —
//! the front end folds the structured stream into its own design — and it is
//! why there is no grid model in this file.
//!
//! The one exception is the **prologue**, and it exists for a case that has
//! nothing to do with taste: the attribute table is sent once, when nvim starts,
//! and a front end that attaches later has missed it. In dev that is every Vite
//! edit. So the definitions are kept here and replayed to whoever attaches next,
//! ahead of a `redraw!` that repaints the cells. Without it a rebuilt front end
//! draws a correct grid in no colours at all.

use std::collections::BTreeMap;
use std::io::{BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use rmpv::Value;
use serde::Serialize;
use serde_json::{json, Value as Json};
use tauri::{AppHandle, Emitter, State};

use crate::servers::jobs;

/* ── what a session remembers for whoever attaches next ───────────────────── */

/// The redraw events that are only ever sent once, kept so a front end that
/// arrives after them can be told what it missed.
///
/// Attributes are a map rather than a list because nvim redefines an id when a
/// colourscheme changes, and a list would grow without bound across a long
/// session while replaying the stale definition first. The map is keyed on the
/// attribute id, so a redefinition replaces rather than accumulates.
#[derive(Default)]
struct Prologue {
    colors: Option<Json>,
    attrs: BTreeMap<i64, Json>,
    modes: Option<Json>,
}

impl Prologue {
    /// Fold one redraw event into what will be replayed. Everything else is
    /// about *cells*, and `redraw!` regenerates cells.
    fn keep(&mut self, name: &str, args: &[Json]) {
        match name {
            "default_colors_set" => self.colors = args.last().cloned(),
            "mode_info_set" => self.modes = args.last().cloned(),
            "hl_attr_define" => {
                for a in args {
                    let Some(id) = a.get(0).and_then(Json::as_i64) else {
                        continue;
                    };
                    self.attrs.insert(id, a.clone());
                }
            }
            _ => {}
        }
    }

    /// The prologue as redraw events, in the order a UI needs them: the default
    /// colours before the attributes that fall back to them.
    fn replay(&self) -> Vec<Json> {
        let mut out = Vec::new();
        if let Some(c) = &self.colors {
            out.push(json!(["default_colors_set", c]));
        }
        if !self.attrs.is_empty() {
            let mut ev = vec![json!("hl_attr_define")];
            ev.extend(self.attrs.values().cloned());
            out.push(Json::Array(ev));
        }
        if let Some(m) = &self.modes {
            out.push(json!(["mode_info_set", m]));
        }
        out
    }
}

/* ── runtime state ────────────────────────────────────────────────────────── */

struct Nvim {
    child: Child,
    /// Held for the life of the session: every request is written here, and
    /// closing it is how nvim learns the UI has gone.
    stdin: Option<ChildStdin>,
    /// Shared with the reader thread, which is the only thing that writes it.
    prologue: Arc<Mutex<Prologue>>,
    /// nvim spawns language servers, and a language server spawns compilers.
    /// Dropping this takes the tree, exactly as it does for a dev server — see
    /// the note in CLAUDE.md about the spawn that did not have one.
    _job: Option<jobs::Job>,
}

#[derive(Default)]
pub struct Nvims(Mutex<std::collections::HashMap<String, Nvim>>);

#[derive(Clone, Serialize)]
struct Redraw {
    id: String,
    events: Vec<Json>,
}

#[derive(Clone, Serialize)]
struct Gone {
    id: String,
}

/// What `open_editor` answers with. `started` is the difference between having
/// spawned an nvim and having found one — the same distinction `open_shell`
/// reports, and for the same reason: only the caller can be wrong about it.
#[derive(Clone, Serialize)]
pub struct EditorInfo {
    started: bool,
}

/* ── msgpack, in the two directions ───────────────────────────────────────── */

/// A decoded msgpack value as JSON, for the front end.
///
/// nvim hands out Buffer/Window/Tabpage handles as msgpack **ext** types, which
/// no JSON has a shape for. None of them appears in a redraw batch, so they are
/// reduced to their integer payload rather than given a representation nothing
/// would read.
fn to_json(v: &Value) -> Json {
    match v {
        Value::Nil => Json::Null,
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => i
            .as_i64()
            .map(Json::from)
            .or_else(|| i.as_u64().map(Json::from))
            .unwrap_or(Json::Null),
        Value::F32(f) => json!(*f),
        Value::F64(f) => json!(*f),
        Value::String(s) => match s.as_str() {
            Some(t) => Json::String(t.to_string()),
            /* nvim is UTF-8 throughout, so this is unreachable in practice —
               but a lossy string is a better answer than dropping the event
               that carried it. */
            None => Json::String(String::from_utf8_lossy(s.as_bytes()).into_owned()),
        },
        Value::Binary(b) => Json::String(String::from_utf8_lossy(b).into_owned()),
        Value::Array(a) => Json::Array(a.iter().map(to_json).collect()),
        Value::Map(m) => {
            let mut o = serde_json::Map::new();
            for (k, val) in m {
                let key = match k {
                    Value::String(s) => s.as_str().unwrap_or_default().to_string(),
                    other => other.to_string(),
                };
                o.insert(key, to_json(val));
            }
            Json::Object(o)
        }
        Value::Ext(_, data) => Json::Array(data.iter().map(|b| json!(*b)).collect()),
    }
}

/// Write one RPC request. The response is never waited for: everything this
/// app asks nvim to do is a command whose *effect* arrives as a redraw, so a
/// reply carries nothing a caller could use and waiting for one would put a
/// round trip inside every keystroke.
fn request(w: &mut ChildStdin, method: &str, params: Vec<Value>) -> std::io::Result<()> {
    let msg = Value::Array(vec![
        Value::from(0),
        /* One id for everything. Nothing correlates a response to a request
           here, so a counter would be a number nobody reads. */
        Value::from(1),
        Value::from(method),
        Value::Array(params),
    ]);
    rmpv::encode::write_value(w, &msg).map_err(std::io::Error::other)?;
    w.flush()
}

/* ── starting one ─────────────────────────────────────────────────────────── */

#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

/// The Lua that opens a file, run with the path as an *argument* rather than
/// interpolated into a command string.
///
/// That is the whole reason this is Lua and not `:edit <path>`: a Windows path
/// is full of backslashes and may hold spaces, `%`, `#` and `[`, every one of
/// which means something to Vim's command line. Passing it as a value means
/// nothing has to be escaped correctly.
///
/// Three things beyond the open, each of which is a case that would otherwise
/// read as a bug:
///
/// - **An already-open buffer is switched to, not re-edited.** `:edit` on a
///   modified buffer fails with E37, so the file you were halfway through
///   changing would refuse to open from the panel that was already showing it.
/// - **The line is clamped**, because the finder's line comes from a grep hit
///   against what was on disk and an agent may have shortened the file since.
/// - **`checktime`**, because on this wall the other thing editing these files
///   is an agent. Without it nvim would sit on a buffer it read ten minutes ago
///   and quietly write it back over the agent's work.
const OPEN_LUA: &str = r#"
local path, line = ...
local target = vim.fn.fnamemodify(path, ':p')
local buf = vim.fn.bufnr(target)
if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then
  vim.api.nvim_set_current_buf(buf)
else
  vim.cmd.edit(vim.fn.fnameescape(target))
end
if line and line > 0 then
  local last = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_win_set_cursor(0, { math.min(line, last), 0 })
  vim.cmd('normal! zz')
end
vim.cmd('checktime')
"#;

/// Open the editor for `cwd`, or hand back the one already running under `id`.
///
/// **Attaching to one that is already running is the normal case**, exactly as
/// it is for the shell: the panel is toggled shut far more often than the editor
/// is closed, and in dev every front-end edit rebuilds the object that was
/// holding the session. A reattach replays the prologue and asks for a full
/// repaint, which is what puts the grid back on a front end that has never seen
/// this nvim before.
#[tauri::command]
pub fn open_editor(
    app: AppHandle,
    nvims: State<'_, Nvims>,
    id: String,
    cwd: String,
    cols: u32,
    rows: u32,
) -> Result<EditorInfo, String> {
    let cols = cols.clamp(20, 500) as i64;
    let rows = rows.clamp(5, 200) as i64;

    {
        let mut map = nvims.0.lock().unwrap();
        if let Some(nv) = map.get_mut(&id) {
            let events = nv.prologue.lock().unwrap().replay();
            if !events.is_empty() {
                let _ = app.emit(
                    "nvim:redraw",
                    Redraw {
                        id: id.clone(),
                        events,
                    },
                );
            }
            if let Some(w) = nv.stdin.as_mut() {
                /* The size first: the panel that has just attached is not
                   necessarily the shape of the one that left. */
                let _ = request(w, "nvim_ui_try_resize", vec![cols.into(), rows.into()]);
                let _ = request(w, "nvim_command", vec![Value::from("redraw!")]);
            }
            return Ok(EditorInfo { started: false });
        }
    }

    let mut cmd = Command::new("nvim");
    /* `--embed` alone, deliberately without `--headless`: it makes nvim wait
       for a UI before it finishes starting, so `init.lua` is sourced knowing
       the real window size. With `--headless` the config runs against a
       default 80x24 and anything that lays out on `vim.o.columns` — a
       dashboard, a statusline — is built for a window that never existed. */
    cmd.arg("--embed")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    /* No terminal here for Git Credential Manager to ask a question in, so a
       plugin that shells out to git must fail rather than hang forever behind
       a prompt nobody can see. The same pair every other spawn in this app
       sets. */
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    quiet(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("nvim could not be started — {e}. Is it on PATH?"))?;

    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let prologue = Arc::new(Mutex::new(Prologue::default()));
    let stdout = child.stdout.take();
    let mut stdin = child.stdin.take();

    if let Some(out) = stdout {
        let app = app.clone();
        let id = id.clone();
        let prologue = prologue.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(out);
            /* msgpack is self-delimiting, so `read_value` consumes exactly one
               message and leaves the rest in the buffer — there is no framing
               to get wrong here, which is the whole reason this is `rmpv` and
               not a hand-rolled reader. */
            while let Ok(msg) = rmpv::decode::read_value(&mut reader) {
                let Value::Array(parts) = &msg else { continue };
                /* 2 is a notification, and `redraw` is the only one a plain
                   linegrid UI ever receives. A response (1) carries nothing we
                   asked to be told, and a request (0) is not sent to a UI that
                   has enabled no `ext_` options. */
                if parts.first().and_then(Value::as_u64) != Some(2) {
                    continue;
                }
                if parts.get(1).and_then(Value::as_str) != Some("redraw") {
                    continue;
                }
                let Some(Value::Array(batch)) = parts.get(2) else {
                    continue;
                };

                let mut events = Vec::with_capacity(batch.len());
                for ev in batch {
                    let Json::Array(parts) = to_json(ev) else {
                        continue;
                    };
                    if let Some(name) = parts.first().and_then(Json::as_str) {
                        prologue.lock().unwrap().keep(name, &parts[1..]);
                    }
                    events.push(Json::Array(parts));
                }
                if events.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "nvim:redraw",
                    Redraw {
                        id: id.clone(),
                        events,
                    },
                );
            }
            /* stdout ending is nvim ending, and the panel has to say so rather
               than go on taking keys nothing will read. */
            let _ = app.emit("nvim:exit", Gone { id });
        });
    }

    /* Attach before anything else: with `--embed` and no `--headless`, nvim is
       waiting for exactly this and has not sourced a line of config yet.
       `ext_linegrid` is the modern cell protocol; nothing else is enabled on
       purpose, so nvim composites its own floats, popup menu and command line
       into the one grid — which is what makes telescope, cmp and lazy work
       here without this app learning any of their names. */
    if let Some(w) = stdin.as_mut() {
        let opts = Value::Map(vec![
            (Value::from("ext_linegrid"), Value::from(true)),
            (Value::from("rgb"), Value::from(true)),
        ]);
        request(w, "nvim_ui_attach", vec![cols.into(), rows.into(), opts])
            .map_err(|e| format!("nvim would not take a UI — {e}"))?;
    }

    nvims.0.lock().unwrap().insert(
        id,
        Nvim {
            child,
            stdin,
            prologue,
            _job: job,
        },
    );

    Ok(EditorInfo { started: true })
}

/* ── driving it ───────────────────────────────────────────────────────────── */

/// Run `method` against a live session, or say there is not one.
fn with_stdin<F>(nvims: &State<'_, Nvims>, id: &str, f: F) -> Result<(), String>
where
    F: FnOnce(&mut ChildStdin) -> std::io::Result<()>,
{
    let mut map = nvims.0.lock().unwrap();
    let nv = map.get_mut(id).ok_or("no editor is open")?;
    let w = nv.stdin.as_mut().ok_or("the editor is not taking input")?;
    f(w).map_err(|e| format!("nvim stopped listening: {e}"))
}

/// Open a file at a line. `line` is 1-based, as every line number a person sees
/// on this wall is.
#[tauri::command]
pub fn editor_open(
    nvims: State<'_, Nvims>,
    id: String,
    path: String,
    line: Option<u32>,
) -> Result<(), String> {
    with_stdin(&nvims, &id, |w| {
        request(
            w,
            "nvim_exec_lua",
            vec![
                Value::from(OPEN_LUA),
                Value::Array(vec![
                    Value::from(path),
                    line.map(|l| Value::from(l as i64)).unwrap_or(Value::Nil),
                ]),
            ],
        )
    })
}

/// Feed keys, already in nvim's own notation (`a`, `<Esc>`, `<C-w>`).
///
/// `nvim_input` rather than `nvim_feedkeys`: it is the one that behaves as
/// though the keys were typed, which includes being interruptible and
/// respecting a pending operator — `feedkeys` would make `d` followed by `w` a
/// race rather than a motion.
#[tauri::command]
pub fn editor_input(nvims: State<'_, Nvims>, id: String, keys: String) -> Result<(), String> {
    with_stdin(&nvims, &id, |w| {
        request(w, "nvim_input", vec![Value::from(keys)])
    })
}

/// Paste, as one insertion rather than as a key each.
///
/// `nvim_paste` rather than `nvim_input`, and the difference is the whole
/// reason this command exists: input runs every character through mappings and
/// autopairs, so a function pasted into insert mode arrives re-indented into a
/// staircase with half its brackets doubled. This is what `:help paste` is for.
///
/// Phase `-1` says the whole paste is in this one call, which is true of
/// anything that came off a clipboard.
#[tauri::command]
pub fn editor_paste(nvims: State<'_, Nvims>, id: String, text: String) -> Result<(), String> {
    with_stdin(&nvims, &id, |w| {
        request(
            w,
            "nvim_paste",
            vec![
                Value::from(text),
                /* Not a bracketed-paste stream — there is no terminal here to
                   have bracketed anything. */
                Value::from(false),
                Value::from(-1),
            ],
        )
    })
}

/// A mouse gesture, in grid coordinates.
///
/// Worth having rather than skipped: this editor lives in a panel you arrived
/// at with the pointer, and a window you cannot click into reads as a picture
/// of an editor rather than an editor.
#[tauri::command]
pub fn editor_mouse(
    nvims: State<'_, Nvims>,
    id: String,
    button: String,
    action: String,
    modifier: String,
    row: i64,
    col: i64,
) -> Result<(), String> {
    with_stdin(&nvims, &id, |w| {
        request(
            w,
            "nvim_input_mouse",
            vec![
                Value::from(button),
                Value::from(action),
                Value::from(modifier),
                /* Grid 1 — the only grid there is without `ext_multigrid`. */
                Value::from(1),
                Value::from(row),
                Value::from(col),
            ],
        )
    })
}

/// Tell nvim the panel changed shape.
#[tauri::command]
pub fn editor_resize(
    nvims: State<'_, Nvims>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let cols = cols.clamp(20, 500) as i64;
    let rows = rows.clamp(5, 200) as i64;
    with_stdin(&nvims, &id, |w| {
        request(w, "nvim_ui_try_resize", vec![cols.into(), rows.into()])
    })
}

/// End the session, and everything it started with it.
///
/// Nothing is saved on the way out, deliberately. Writing a buffer the user did
/// not ask to have written is the one failure here that cannot be undone, and
/// what a killed nvim leaves behind is a swap file — which is precisely the
/// mechanism nvim has for this, and which the next session offers to recover
/// from in its own words.
#[tauri::command]
pub fn close_editor(nvims: State<'_, Nvims>, id: String) -> Result<(), String> {
    if let Some(mut nv) = nvims.0.lock().unwrap().remove(&id) {
        /* Closing stdin is how a UI detaches, and an nvim with no UI left and
           nothing modified exits on its own — the graceful path, tried before
           it is killed for taking too long about it. */
        drop(nv.stdin.take());
        let _ = nv.child.kill();
        let _ = nv.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn editor_alive(nvims: State<'_, Nvims>, id: String) -> bool {
    nvims.0.lock().unwrap().contains_key(&id)
}

impl Nvims {
    /// Every editor dies with the app, along with whatever it started — the
    /// same promise the shell, the dev servers and the project runs make.
    pub fn shutdown(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, mut nv) in map.drain() {
            drop(nv.stdin.take());
            let _ = nv.child.kill();
            let _ = nv.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(name: &str, args: Vec<Json>) -> (String, Vec<Json>) {
        (name.to_string(), args)
    }

    #[test]
    fn a_redefined_attribute_replaces_rather_than_accumulates() {
        let mut p = Prologue::default();
        let (n, a) = ev("hl_attr_define", vec![json!([1, { "foreground": 111 }, {}, []])]);
        p.keep(&n, &a);
        let (n, a) = ev("hl_attr_define", vec![json!([1, { "foreground": 222 }, {}, []])]);
        p.keep(&n, &a);
        assert_eq!(p.attrs.len(), 1, "a colourscheme change grew the table");
        assert_eq!(p.attrs[&1][1]["foreground"], json!(222));
    }

    #[test]
    fn one_event_may_define_several_attributes() {
        let mut p = Prologue::default();
        let (n, a) = ev(
            "hl_attr_define",
            vec![json!([1, {}, {}, []]), json!([2, {}, {}, []])],
        );
        p.keep(&n, &a);
        assert_eq!(p.attrs.len(), 2);
    }

    #[test]
    fn the_replay_puts_the_default_colours_before_the_attributes_that_use_them() {
        let mut p = Prologue::default();
        let (n, a) = ev("hl_attr_define", vec![json!([1, {}, {}, []])]);
        p.keep(&n, &a);
        let (n, a) = ev("default_colors_set", vec![json!([0xc9d1d9, 0x14171a, 0, 0, 0])]);
        p.keep(&n, &a);

        let out = p.replay();
        assert_eq!(out[0][0], json!("default_colors_set"));
        assert_eq!(out[1][0], json!("hl_attr_define"));
        /* One event carrying every definition, not one event each. */
        assert_eq!(out[1].as_array().unwrap().len(), 2);
    }

    #[test]
    fn nothing_learned_yet_replays_nothing() {
        assert!(Prologue::default().replay().is_empty());
    }

    #[test]
    fn events_about_cells_are_not_kept() {
        let mut p = Prologue::default();
        let (n, a) = ev("grid_line", vec![json!([1, 0, 0, [["x", 0, 1]]])]);
        p.keep(&n, &a);
        /* `redraw!` regenerates every cell, so keeping them would be a second
           copy of the screen for no reason. */
        assert!(p.replay().is_empty());
    }

    #[test]
    fn an_ext_handle_becomes_its_bytes_rather_than_dropping_the_event() {
        let v = Value::Array(vec![Value::from("buf"), Value::Ext(0, vec![1])]);
        assert_eq!(to_json(&v), json!(["buf", [1]]));
    }

    #[test]
    fn a_msgpack_map_survives_as_an_object() {
        let v = Value::Map(vec![(Value::from("foreground"), Value::from(16777215))]);
        assert_eq!(to_json(&v), json!({ "foreground": 16777215 }));
    }

    #[test]
    fn the_open_lua_takes_its_path_as_an_argument() {
        /* The whole point of it being Lua: a Windows path is full of
           backslashes and may hold `%`, `#` and `[`, every one of which means
           something on Vim's command line. Nothing here interpolates one. */
        assert!(OPEN_LUA.contains("local path, line = ..."));
        assert!(!OPEN_LUA.contains("{path}"));
        /* And the three cases that would otherwise read as bugs. */
        assert!(OPEN_LUA.contains("nvim_set_current_buf"), "E37 on a modified buffer");
        assert!(OPEN_LUA.contains("math.min"), "a grep line past the end of the file");
        assert!(OPEN_LUA.contains("checktime"), "an agent edited it underneath");
    }
}
