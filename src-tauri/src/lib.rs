mod actions;
/* The app's own log. Installed first thing in `setup`, because anything said
   before it lands nowhere — see the module's own note. */
mod applog;
mod arrange;
mod attach;
mod asana;
mod aside;
mod ask;
mod accounts;
mod bang;
mod browser;
/// Where the `claude` binary is. Public so `examples/slash-probe.rs` can find
/// the same one the app spawns rather than assuming it is on PATH.
pub mod claude;
mod clean;
mod clip;
mod board;
mod chronicle;
/// Public so `examples/azdo-probe.rs` can drive the real reading rather than a
/// copy of it — the convention `tools/probe-context.ts` sets for questions of
/// the form "what does this service actually do".
pub mod azdo;
mod control;
mod creds;
mod docket;
/// The rows a forge answers in, and the two providers that fill them. `forge`
/// is vocabulary-neutral on purpose — see its header for the line between a
/// projection that is honest and one that is a lie.
pub mod flyway;
pub mod forge;
mod github;
/// Public so `examples/find-probe.rs` can drive the real search rather than a
/// copy of it — the same arrangement `azdo` has, and the convention
/// `tools/probe-context.ts` sets for questions of the form "what does this
/// actually do".
pub mod find;
mod guidance;
pub mod hooks;
mod joblog;
mod later;
mod nvim;
mod limits;
mod open;
mod perf;
mod pin;
mod portage;
mod notice;
mod presence;
mod project;
mod reap;
mod quit;
mod relay;
/// Deleting a path from a card, behind the user's own click. See
/// `.claude/rules/remove.md` — and note the deny it complements is the *user's*
/// own, in `~/.claude/settings.json`, rather than anything Volery owns.
mod remove;
mod repair;
mod selector;
mod servers;
mod sessions;
mod signin;
mod shell;
mod sketch;
mod sink;
pub mod sinksync;
/// Everything under the dock's slash that is *not* Volery's own: the CLI's
/// built-ins, a project's `.claude/commands/`, and every skill. Asked of a
/// `claude` over the control route rather than worked out here — see the
/// module's own header for the two designs that tried the other way.
///
/// Public so `examples/slash-probe.rs` can drive the real request rather than a
/// copy of it, the same arrangement `find` and `azdo` have.
pub mod slash;
mod smith;
mod spawn;
mod spotify;
mod status;
/* The rung under voice's grammar: a small model, spawned per escalated
   utterance. Beside `aside` in kind — a one-shot `claude` this app waits on —
   and deliberately not inside `voice`, which is the recogniser and nothing
   else. */
mod steward;
pub mod store;
mod supervisor;
mod timeline;
/* The IPv4-first loopback CONNECT tunnel librespot dials through. Beside
   `spotify` rather than inside it because it is a listener with a lifetime of
   its own; see its own header for the measurement that made it necessary. */
mod tunnel;
mod update;
mod usage;
mod vault;
/* `pub` so `examples/voice-probe.rs` can reach it — the microphone is the one
   thing in this app that cannot be tested without a person, so the probe is how
   somebody checks theirs. */
pub mod voice;
mod window;
mod workflow;
mod worktree;

use actions::Runs;
use ask::Asks;
use bang::Bangs;
use azdo::Azdo;
use github::Github;
use control::Control;
use perf::Meter;
use pin::Pins;
use nvim::Nvims;
use relay::Relays;
use servers::Servers;
use shell::Shells;
use quit::Quit;
use store::Store;
use supervisor::Supervisor;
use limits::Limits;
use usage::Usage;
use tauri::{Emitter, Manager};

/// Run blocking work on the blocking pool, and wait for it there.
///
/// A `#[tauri::command]` **without** `async` is compiled by `tauri-macros` into
/// its `body_blocking` arm, which calls the function *inline on the thread that
/// dispatched the IPC* — on Windows, the main thread. That same thread is the
/// only one that drains the event-loop queue, and `app.emit` from any other
/// thread merely queues onto it (`tauri-runtime-wry`'s `send_user_message`:
/// off-main it is `proxy.send_event`, nothing more). So a command that blocks
/// there is not just a slow command — it stops every card on the wall from being
/// painted for exactly as long as it blocks, and then the whole backlog lands at
/// once. A 20s `ureq` read timeout in `azdo_runs` was a 20s freeze of the entire
/// app, once per 20s poll, with every conversation resuming together afterwards.
/// That is the bug this function exists to prevent, and the reason the commands
/// below are `async`.
///
/// `#[tauri::command(async)]` on its own is *not* the fix, which is the part
/// worth writing down. The macro's sync-threadpool arm wraps the body in
/// `respond_async_serialized`, and that is `async_runtime::spawn` —
/// `tokio::spawn` onto the multi-threaded runtime's **worker** pool, sized to
/// the core count. Blocking a worker starves the very runtime that delivers
/// every command's response, so a handful of slow calls reproduces the same
/// freeze one layer down, on a machine with few enough cores. `spawn_blocking`
/// is the pool built for work that parks a thread, and it grows on demand.
///
/// The `Err` here is a `JoinError` — the closure panicked — and never the work's
/// own failure, which travels in `R` as it always did.
/// Base64, written out rather than pulled in.
///
/// Eleven lines against a dependency in the tree of an app that is careful about
/// its tree, which is the same bargain `azdo.rs` struck when it wrote this — and
/// `base64` is already in `Cargo.lock` twice as a transitive of librespot, so
/// adding it directly would pin a third version of eleven lines.
///
/// Here rather than in either caller because there are two now, in modules with
/// nothing to do with each other: `azdo::Cred` builds a `Basic` header, and
/// `find::read_media` puts a project's image on a `data:` URL for the viewer. A
/// general utility living in a service file is fine until the second caller and
/// misleading afterwards.
///
/// Standard alphabet with padding — no URL-safe variant, because neither caller
/// wants one and an encoder that guesses which is being asked for is worse than
/// two functions. `base64_pads_the_way_everything_else_does` is the guard, and
/// the padding is the half worth having a test for: a `Basic` header short by an
/// `=` is a 401 that looks like a wrong password.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const SET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(SET[((n >> (18 - i * 6)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod base64_tests {
    use super::base64;

    /// Came here with the function it tests. The padding is the part that
    /// matters: a `Basic` header short by an `=` is a 401 that reads as a wrong
    /// password, and a `data:` URL short by one is an image that does not decode.
    #[test]
    fn base64_pads_the_way_everything_else_does() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}

#[cfg(test)]
mod launch_tests {
    use serde_json::Value;

    /// A window Tauri makes from the config is made before the setup hook runs,
    /// and making it pumps messages — so its page can call commands against a
    /// wall with no store. That was the empty wall under a red bar and the
    /// launch that aborted unseen; see `open_windows`. The lab merges its own
    /// file over this one, so a `windows` key there would bring the bug back
    /// in exactly the place it gets tested, and is held to the same rule.
    #[test]
    fn no_window_is_made_before_setup() {
        for (name, text) in [
            ("tauri.conf.json", include_str!("../tauri.conf.json")),
            ("tauri.lab.conf.json", include_str!("../tauri.lab.conf.json")),
        ] {
            let config: Value = serde_json::from_str(text).expect(name);
            let Some(windows) = config["app"]["windows"].as_array() else {
                assert_ne!(name, "tauri.conf.json", "the studio declares its windows");
                continue;
            };
            assert!(
                windows.iter().any(|w| w["label"] == "main"),
                "{name} has no main window for `settle` to show"
            );
            for w in windows {
                assert_eq!(
                    w["create"],
                    Value::Bool(false),
                    "{name}: window {} would be built before setup has managed the \
                     store — `open_windows` builds it, after everything a command reads",
                    w["label"]
                );
            }
        }
    }

    /// The other half: once the windows exist, a command can run, so nothing it
    /// reads may be set up after them. Read off the source because the property
    /// is an order of statements in one function, and the only failure worth
    /// catching is somebody appending a line to the end of `open_wall` — the
    /// natural place to put the next thing a launch does.
    #[test]
    fn the_windows_are_the_last_thing_a_launch_makes() {
        /* Line endings are whatever the checkout made them. */
        let source = include_str!("lib.rs").replace("\r\n", "\n");
        /* With the newline, so the needle in this test is not what it finds. */
        let start = source.find("\nfn open_wall(").expect("open_wall exists");
        let body = &source[start..];
        let body = &body[..body.find("\n}\n").expect("open_wall ends")];
        let after = &body[body.find("open_windows(app)?;").expect("open_wall opens the windows")..];

        /* Comments out, then whatever code is left. */
        let mut code = String::new();
        let mut rest = after;
        while let Some(open) = rest.find("/*") {
            code.push_str(&rest[..open]);
            rest = &rest[open + rest[open..].find("*/").expect("comment closes") + 2..];
        }
        code.push_str(rest);
        let statements: Vec<&str> = code.split_whitespace().collect();
        assert_eq!(
            statements,
            ["open_windows(app)?;", "window::settle(app.handle(),", "frame);", "Ok(())"],
            "open_wall does something after making the windows; anything a command \
             reads belongs above `open_windows`"
        );
    }
}

pub(crate) async fn off_main<F, R>(work: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("background work did not finish: {e}"))
}

/// Say something the user can actually read, from inside `setup`, on the way to
/// failing.
///
/// A native message box rather than `tauri_plugin_dialog`, which is what the
/// rest of the app uses: the plugin's `blocking_show` wants an event loop to
/// pump, and everything that calls this is a failure inside `setup` — which
/// runs *on* the loop's thread, so the loop cannot turn until it returns, and a
/// dialog that never paints is the silence it was added to break. `MessageBoxW`
/// is synchronous and needs nothing but a thread.
///
/// **It is also a message loop of its own**, and that is why no webview may
/// exist while one is up. The box pumps every message for this thread until it
/// is dismissed, and a webview's requests arrive as messages — so a box over a
/// live webview runs that page's commands, right then, against whatever `setup`
/// had got round to. See `open_windows`.
///
/// The console line goes out either way, so `bun run tauri dev` shows it too.
fn complain(message: &str) {
    eprintln!("volery: {message}");
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let text = HSTRING::from(message);
        let title = HSTRING::from("Volery");
        // SAFETY: two null-terminated wide strings that outlive the call, and a
        // null owner window — there is no window yet, which is the point.
        unsafe {
            MessageBoxW(
                None,
                &text,
                &title,
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
}

/// One wall on one database, or refuse to start.
///
/// Two Volery processes over one `%APPDATA%` folder is not a tidiness problem.
/// They race the WAL; both try to bind `ask::start`'s port, so the loser's cards
/// get a hook pointed at a port nobody answers; both write `set_mid_turn`
/// against the same turns; and — the expensive one — each **rouses every dormant
/// card it finds**, which is a `claude` process and possibly an API turn apiece.
/// Paid for on 2026-10-02, when a mistyped hook flag opened ~18 of them against
/// the live wall at once and took it down. `hooks::intercept` refuses that typo
/// now; this is the guard that does not depend on having anticipated it.
///
/// **A named mutex rather than a lockfile**, because the kernel releases it when
/// the process dies *however* it dies. A PID file survives a crash and locks you
/// out of your own wall — a worse failure than the one it prevents, and one
/// whose recovery is editing a file by hand, which this codebase has already
/// paid for once (see `store::migrate`).
///
/// **Keyed on the identifier, not the binary**, so `bun run lab`
/// (`dev.skein.lab`) is a wall of its own and still runs alongside. The cost is
/// that a debug build and the installed app *do* collide, since both are
/// `dev.skein.studio` — deliberate, and the same hazard `store::may_migrate`
/// already refuses the schema half of. `VOLERY_SECOND=1` is the way out when two
/// are genuinely wanted.
///
/// `Local\` rather than `Global\`: the scope is one login session, so two users
/// on one machine get a wall each, and it needs no privilege to create.
#[cfg(windows)]
fn claim_wall(identifier: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    if std::env::var("VOLERY_SECOND").as_deref() == Ok("1") {
        return Ok(());
    }

    let name = HSTRING::from(format!("Local\\{identifier}"));
    /* `false` for the initial owner: what locks here is the kernel object's
       *existence*, not its ownership — ownership would have to be released, and
       there is no moment in this process's life where that would be right.

       SAFETY: a null security descriptor and a null-terminated wide name that
       outlives the call. The handle is deliberately never closed; its lifetime
       is the process's, and the OS reclaiming it is exactly the release we
       want. */
    let _handle = unsafe { CreateMutexW(None, false, &name) }
        .map_err(|e| format!("could not create the wall lock: {e}"))?;
    /* Immediately after the call and before anything else that could touch the
       thread's last-error: on success `CreateMutexW` leaves it alone, and this
       is the only thing that distinguishes "made it" from "joined it". */
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(format!(
            "Volery is already running on this wall.\n\n\
             Only one studio may hold {identifier} at a time: two race the \
             database, fight over the ask server's port, and each rouses every \
             dormant card — a claude process and an API turn apiece.\n\n\
             Close the running wall first. `bun run lab` is a wall of your own, \
             and VOLERY_SECOND=1 forces a second one if you really mean it."
        ));
    }
    Ok(())
}

/// Windows is the only platform with a wall to protect, so this guard is not
/// implemented elsewhere — and says so rather than returning an error, which
/// here would mean refusing to start at all. The convention that a non-Windows
/// arm errors rather than no-ops is about *capabilities*, where a silent no-op
/// is a false promise; a guard that does not fire on a platform the app does not
/// ship on is merely unguarded.
#[cfg(not(windows))]
fn claim_wall(_identifier: &str) -> Result<(), String> {
    Ok(())
}

/// True while a launch that fails would fail silently: from the top of `run`
/// until `setup` has either finished or already said why it could not.
///
/// It exists so that exactly one thing speaks for a failed launch. `setup`'s
/// own errors are worded where they happen and complained about there; a panic
/// is worded by the panic hook; and an `Err` out of `setup` becomes a *second*
/// panic inside Tauri (`app.rs`: `panic!("Failed to setup app: {e}")`), which
/// must not put a second box over the first. Whoever swaps this to `false`
/// first is the one who speaks.
static LAUNCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Every panic goes in the app's log, and one that ends a launch says so.
///
/// The app is `windows_subsystem = "windows"`, so the default hook's line goes
/// to a stderr nobody has. That is how a launch could die with the whole of its
/// cause — `state() called before manage() for skein_lib::store::Store`, the
/// first time — printed into nothing: Lyss double-clicked again until one
/// survived, and the only record was a card that happened to be running a
/// second wall from a terminal.
///
/// **Only the main thread's panic is a failed launch.** That thread is the event
/// loop, so its panic takes the process with it; a panic on a pool thread is
/// one command's failure, and a box saying the wall could not start would be
/// wrong about a wall that then starts. Those go in the log, where the log
/// widget will draw them.
fn speak_for_panics() {
    let main = std::thread::current().id();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        log::error!(target: "panic", "{info}");
        if std::thread::current().id() == main
            && LAUNCHING.swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            complain(&format!("Volery could not start.\n\n{info}"));
        }
    }));
}

/// Build the windows `tauri.conf.json` declares — main and peek — now that
/// everything a command can reach exists.
///
/// **They are `"create": false` in the config so that this is the only place
/// they are made.** Left to Tauri, config windows are built *before* the setup
/// hook runs (`tauri` `app.rs`, `fn setup`: the window loop, then
/// `(setup)(app)`), and building a WebView2 pumps this thread's messages while
/// it waits on the runtime (`wry`'s `create_environment`/`create_controller`,
/// both `wait_with_pump`). So by the time `peek` had finished being made,
/// `main`'s page could already be up and calling commands — against a wall
/// with no store managed yet, because `setup` had not started. What that
/// looked like depended on the command:
///
/// - `load_studio` takes `State<Store>`, so Tauri answered it with `state not
///   managed for field "store"… call .manage()`, which the front end puts in
///   `fault` and never retries: **the wall opened empty under a red bar about
///   the database.**
/// - `read_board` and `read_chronicle` reach for `app.state::<Store>()`, which
///   panics, on the main thread, inside a WebView2 callback that cannot unwind:
///   **the process aborted before its window was ever shown**, and the next
///   double-click usually won the race.
/// - `flyway_births` does the same off the main thread, which is the
///   "runtime thread, then main thread" pair a card saw once from a terminal.
///
/// `complain`'s box made the same gap from the other side: it is a message
/// loop, so a launch refused by `claim_wall` ran the hidden page's commands
/// against no store and aborted out from under its own explanation.
///
/// **Nothing a command reads may be set up after this is called**, which is
/// what `open_wall` is ordered around: making `peek` pumps again, so `main`'s
/// first commands can run in here, before this returns.
/// `launch_tests::no_window_is_made_before_setup` holds the config's half.
fn open_windows(app: &tauri::App) -> Result<(), String> {
    for config in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &config)
            .and_then(|builder| builder.build())
            .map_err(|e| format!("Volery could not open its {} window.\n\n{e}", config.label))?;
    }
    Ok(())
}

/// Everything `setup` does, with every failure worded for a person.
///
/// The order is the design. A wall is built in three bands — the guard and the
/// store, then every piece of state a command can read, then the windows — and
/// the bands may not mix: a window made before the state it calls into is the
/// bug `open_windows` describes, and it does not need `setup` to be slow to
/// bite, only for anything in it to pump messages.
fn open_wall(app: &mut tauri::App) -> Result<(), String> {
    /* First, and before anything that can fail: a failure in `setup` is
       exactly the failure nobody can reproduce on demand, and until this line
       runs every `log!` in the process goes nowhere. It cannot itself fail in
       a way worth stopping for — see `applog::install`. */
    applog::install(app.handle().clone());

    /* Before the store, before the browser's session file, and before anything
       can spawn: everything below this line assumes it is the only process
       holding this wall. Second, rather than first, only so that the refusal
       reaches the app log. See `claim_wall`. */
    claim_wall(&app.config().identifier)?;

    /* Before any card can spawn, because a card's seeded browser is pointed at
       this file by a static argument and a path that does not exist is a
       browser that will not start. Cannot fail the launch — see
       `browser::ensure_session_file`. */
    browser::ensure_session_file(app.handle());

    /* `VOLERY_WALL_DIR` puts the store somewhere else, and exists for one
       test: two walls of *this* build on one machine, which the flyway cannot
       be proved without. The lab is one wall; a second process of the same
       binary with `VOLERY_SECOND=1` and this set is the other, with a database
       of its own. Test plumbing in the family of `SKEIN_CONTROL` — nothing a
       person sets, and the identifier-keyed folder is untouched when it is
       absent. */
    let dir = match std::env::var("VOLERY_WALL_DIR") {
        Ok(d) if !d.trim().is_empty() => {
            let d = std::path::PathBuf::from(d.trim());
            std::fs::create_dir_all(&d)
                .map_err(|e| format!("Volery could not make {}.\n\n{e}", d.display()))?;
            /* The asset scope in tauri.conf.json is everything under
               `$APPDATA/references`, which is the identifier's folder — so a
               wall with its store moved writes pasted images where the webview
               may not read them, and every one drew as the fallback box (found
               by 34a24070's wall suite). The moved folder is allowed beside
               it. */
            let _ = app.asset_protocol_scope().allow_directory(d.join("references"), true);
            d
        }
        _ => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Volery could not find its data folder.\n\n{e}"))?,
    };
    /* Nothing after this line can run without the database, so this is the one
       failure that stops the app rather than degrading it — and `main` is
       created hidden, so failing without a word is a process that starts,
       shows nothing, and exits. That is what a wedged migration looked like
       from the outside: "skein doesn't start any more", with the whole of the
       cause sitting in a string nobody could read. The message names the file,
       since recovering by hand means knowing which one. See `store::migrate`. */
    let store = Store::open(dir.clone()).map_err(|e| {
        format!(
            "Volery could not open its studio database.\n\n{e}\n\n{}",
            dir.join("skein.db").display()
        )
    })?;
    /* Read now, used by `settle` once there is a window to place. */
    let frame = store.0.lock().ok().and_then(|c| store::read_window_frame(&c));
    app.manage(store);

    /* The ask endpoint, before any conversation can be spawned, so every one
       of them gets a working --mcp-config. A card spawned against port 0 is
       not refused — it is spawned with no ask_user, relay, board or browser
       tools for its whole life, which is why this is above the windows rather
       than merely early. */
    let port = ask::start(app.handle().clone()).map_err(|e| {
        format!("Volery could not start the server its cards ask questions through.\n\n{e}")
    })?;
    app.state::<Asks>().set_port(port);
    /* Off unless SKEIN_CONTROL says otherwise. When it is on, the title bar
       says so — see src/lib/control.svelte.ts, which asks for the endpoint
       once at mount and does not ask again, so it has to be here by then. */
    if let Some(ep) = control::start(app.handle().clone(), &dir)
        .map_err(|e| format!("Volery could not open its control surface.\n\n{e}"))?
    {
        app.state::<Control>().set_endpoint(ep);
    }
    /* Before anything can ask a question: a wall that went down while away has
       to come back away, or the first card to reach `ask_user` parks on a
       deadline nobody is going to meet. See `presence::load`. */
    presence::load(app.handle());
    /* Reads how the browser stood last time and does the launch itself in the
       background, so it costs the window a row read. Above the windows because
       the mode it loads is what `browser_status` answers with. A wall closed
       with a browser up comes back with one. See `browser::resume_at_launch`. */
    browser::resume_at_launch(app.handle());
    /* Join the flyway, if this wall has a key. In the background and
       unawaited, because binding an endpoint reaches a lookup service and
       nothing about a window should wait on somebody else's DNS. A wall with no
       key does nothing here and says nothing, which is every wall until
       somebody enters one. */
    {
        let linking = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            match flyway::link::arrive(linking).await {
                Ok(true) => log::info!("flyway: this wall is on it"),
                Ok(false) => {}
                Err(e) => log::warn!("flyway: could not take a place: {e}"),
            }
        });
    }
    /* Sweeps each card's job for processes whose parent has gone away.
       Started here rather than with the performance meter on purpose: the
       meter exists only while a widget is on the wall, and a guarantee that
       holds while you are looking at it is not one. Sleeps before its first
       sweep, so nothing it says can beat the windows. */
    perf::spawn_reaper(app.handle().clone());
    /* Hands out wakes that have come due. Started here for exactly the reason
       above: a card that asked to be woken at ten past has to be woken at ten
       past whether or not anybody is looking at the wall. */
    later::spawn_waker(app.handle().clone());

    /* Last: the windows, and nothing that a command reads may move below
       this. See `open_windows`. */
    open_windows(app)?;
    /* Place and show the studio window before it has painted a frame. `main`
       is `"visible": false` in tauri.conf.json and this is the only thing that
       shows it — a window sized after it is on screen jumps, on exactly the
       machines the sizing exists for. See window.rs. */
    window::settle(app.handle(), frame);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /* Before the builder, so that nothing this process does can die in a way
       that says nothing — and here rather than in `main`, so the hook
       invocations `main` answers first never install it. */
    speak_for_panics();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Supervisor::default())
        .manage(Servers::default())
        /* Empty until Alt+I asks for one — a wall nobody has opened a shell on
           holds no process, and the one it holds outlives the panel being
           toggled shut. */
        .manage(Shells::default())
        /* Empty until the finder is asked to edit something. One nvim per
           project, and like the shell it outlives the panel being switched back
           to a reading — the five seconds a real config takes to start is paid
           once, not once per file. */
        .manage(Nvims::default())
        .manage(Bangs::default())
        .manage(browser::Browser::default())
        .manage(Runs::default())
        .manage(Asks::default())
        .manage(flyway::link::Flyway::default())
        .manage(presence::Presence::default())
        .manage(aside::Asides::default())
        /* The one open microphone, and never more than one. Default is closed:
           nothing here opens an ear at launch, because an always-on microphone
           is a thing a person asks for rather than a thing an app decides. */
        .manage(voice::Ear::default())
        /* The chain marks and the rate limit, and nothing that survives a quit
           — a card holding an inbox holds it in the `relay` table, not here. */
        .manage(Relays::default())
        .manage(Control::default())
        /* Sign-ins in flight. Nothing to release: a session ends when its child
           does, and the reader threads hold an AppHandle rather than a
           subscription. */
        .manage(signin::Signins::default())
        /* Credentials read out of an accounts document and not yet installed.
           Emptied by `drop_carried` when the panel closes rather than living as
           long as the process — see `accounts.rs`. */
        .manage(accounts::Carried::default())
        /* Empty until a performance widget asks: an app with none on the wall
           never enumerates a process. */
        .manage(Meter::default())
        /* Likewise empty until a usage widget asks. It holds a read offset per
           transcript and the requests already counted, so the first reading
           costs a week of files and every one after it costs the tail. */
        .manage(Usage::default())
        /* And the other half of the same widget, which asks the account rather
           than the filesystem what is left. Empty until something watches: a
           wall with no usage widget on it holds no token and makes no request. */
        .manage(Limits::default())
        /* And likewise empty until a pipelines or reviews widget asks. It holds
           the credential ladder, so a wall with neither on it never spawns a
           `git credential` and never holds a token. */
        .manage(Azdo::default())
        /* Empty until the same widgets ask, and separate from `Azdo` so that a
           wall with no GitHub repository on it holds nothing at all. Cleared
           alongside it by `release_azdo`, which is what makes a fresh
           `gh auth login` take effect without a restart. */
        .manage(Github::default())
        /* Zero until the wall reports otherwise, which is the honest
           answer: a quit in the first seconds of a launch has nothing to
           warn about. See `quit.rs`. */
        .manage(Quit::default())
        /* Whether the studio is spread over every screen, and the frame it came
           from. See `window.rs`. */
        .manage(window::Span::default())
        /* Recent pins per card, for the rate in `pin.rs`. Nothing survives a
           quit on purpose: it is a rate over one minute, and a rate that
           outlived a restart would be a restart that cost you the wall. */
        .manage(Pins::default())
        /* An installer waiting for the wall to come down, or nothing, which is
           every launch but the one after you asked for an update. See
           `update.rs` on why the button arms this rather than running it. */
        .manage(update::Arming::default())
        /* The librespot session, or nothing until somebody asks for one. Held
           rather than started at launch on purpose: a wall opening should not
           announce itself on the network as a speaker nobody asked for. */
        .manage(spotify::Spotify::default())
        .setup(|app| {
            let opened = open_wall(app);
            /* Whichever way it went, the launch has spoken for itself now: a
               wall that opened needs no box, and one that did not gets exactly
               one — this one, worded where the failure happened, rather than
               the panic Tauri makes of an `Err` from here. See `LAUNCHING`. */
            if LAUNCHING.swap(false, std::sync::atomic::Ordering::SeqCst) {
                if let Err(e) = &opened {
                    complain(e);
                }
            }
            Ok(opened?)
        })
        /* Closing the studio closes the app.
         *
         * `peek` is declared in tauri.conf.json and created at startup, then only
         * ever hidden — never destroyed, which is right for a notification
         * surface. But the run loop exits once *every* window has closed, so
         * closing the studio left a live process with nothing on screen: ports
         * still bound, SQLite still held, control.json still advertising a token,
         * and every spawned `claude` still editing a repo with nobody watching.
         * None of the cleanup below had run, because nothing had asked the app to
         * exit. The only way out was Task Manager. */
        .on_window_event(|window, event| {
            if window.label() == "main" {
                /* A spread window that something moved goes back over its box.
                   `hold` is a no-op while it is not spread. */
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::ScaleFactorChanged { .. }
                ) {
                    window::hold(window);
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    /* Where it was, for the next launch. Here rather than on every
                       `Moved`/`Resized`, which on a dragged window is a database
                       write per frame; the only frame that matters is the last one,
                       and this is where it is.

                       Before the question below, deliberately: a close that gets
                       held back still moved the window to wherever it is now, and
                       a frame saved only on the way out would forget every quit
                       somebody thought better of. */
                    if let Some(frame) = window::frame_to_keep(window) {
                        if let Some(store) = window.app_handle().try_state::<Store>() {
                            if let Ok(conn) = store.0.lock() {
                                let _ = store::save_window_frame(&conn, &frame);
                            }
                        }
                    }
                    /* A wall with background work on it says so once before it
                       takes it down. Only once — `should_ask` spends the single
                       refusal it has, so the next close goes through whatever
                       happens to the webview in between. See `quit.rs`; the
                       comment above about Task Manager is exactly the failure
                       that budget exists to keep out. */
                    let busy = window
                        .app_handle()
                        .try_state::<Quit>()
                        .and_then(|q| q.should_ask());
                    if let Some(count) = busy {
                        api.prevent_close();
                        /* If this never arrives the dialog never paints, and the
                           user presses close again — which now exits. That is the
                           whole of the failure handling, and it is why the emit
                           is not checked. */
                        let _ = window.app_handle().emit("app:quit-blocked", count);
                        return;
                    }
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            window::span_screens,
            supervisor::spawn_conversation,
            supervisor::send_prompt,
            supervisor::interrupt_conversation,
            supervisor::set_permission_mode,
            supervisor::close_conversation,
            supervisor::rest_conversation,
            supervisor::read_ai_title,
            supervisor::read_session_effort,
            supervisor::read_transcript,
            supervisor::wake_quiet,
            supervisor::conversation_holding,
            supervisor::settle_conversation_fleet,
            browser::browser_status,
            browser::browser_session_file,
            browser::browser_save_session,
            browser::browser_start,
            browser::browser_stop,
            browser::browser_park,
            browser::browser_show,
            browser::browser_set_mode,
            browser::browser_targets,
            browser::browser_open,
            claude::find_claude,
            claude::install_claude,
            accounts::list_accounts,
            accounts::add_account,
            accounts::remove_account,
            accounts::sign_out,
            accounts::reorder_accounts,
            accounts::set_account_priority,
            accounts::set_account_enabled,
            accounts::set_account_caps,
            accounts::stored_accounts,
            accounts::save_accounts_file,
            accounts::load_accounts_file,
            accounts::install_signin,
            accounts::drop_carried,
            accounts::signin_ages,
            signin::begin_signin,
            signin::paste_signin,
            signin::cancel_signin,
            signin::signin_states,
            limits::read_allowances,
            store::set_conversation_account,
            store::set_conversation_bypass,
            store::set_conversation_hold,
            relay::relay_roster,
            relay::relay_send,
            relay::relay_inboxes,
            board::read_board,
            board::post_notice,
            board::unpost_notice,
            board::board_touch,
            board::relay_board,
            board::relay_post,
            board::relay_unpost,
            timeline::read_timelines,
            timeline::archived_timelines,
            timeline::archive_timeline,
            timeline::place_timeline,
            timeline::resume_timeline,
            chronicle::read_chronicle,
            chronicle::chronicle_note,
            chronicle::chronicle_waiting,
            chronicle::chronicle_seen,
            sink::read_sink,
            sink::sink_add,
            sink::sink_edit,
            sink::sink_settle,
            sink::sink_unsettle,
            sink::sink_delete,
            sink::sink_release,
            sink::sink_tool,
            slash::slash_commands,
            spawn::spawned_by,
            spawn::lineage,
            sessions::list_sessions,
            repair::repair_session,
            repair::discard_repair_backup,
            repair::sweep_repair_backups,
            store::import_conversation,
            store::forget_project,
            store::load_studio,
            store::ensure_project,
            store::set_wall_guidance,
            store::set_default_preset,
            store::set_project_guidance,
            store::set_project_read_only,
            store::reroot_project,
            store::record_conversation,
            store::chat_home,
            store::update_conversation,
            store::clear_conversation,
            store::record_turn,
            store::spend_since,
            store::record_file_touch,
            store::overlapping_conversations,
            store::files_handled_by,
            store::save_placement,
            arrange::known_arrangements,
            arrange::adopt_arrangement,
            store::place_territory,
            store::stick_territory,
            store::size_territory,
            flyway::key::flyway_held,
            flyway::link::flyway_arrive,
            flyway::link::flyway_pull,
            flyway::link::flyway_linked,
            flyway::link::flyway_roster,
            flyway::link::flyway_setup,
            flyway::link::flyway_set_accepting,
            flyway::link::flyway_set_bound,
            flyway::link::flyway_publish_cards,
            flyway::link::flyway_remote_cards,
            flyway::link::flyway_opened,
            flyway::link::flyway_failed,
            flyway::link::flyway_births,
            flyway::link::flyway_prompt,
            flyway::link::flyway_close,
            flyway::link::flyway_prompt_answer,
            flyway::link::flyway_tail,
            flyway::link::flyway_tail_answer,
            flyway::key::flyway_start,
            flyway::key::flyway_join,
            flyway::key::flyway_invite,
            flyway::key::flyway_leave,
            flyway::key::flyway_host,
            store::make_territory,
            store::rename_territory,
            store::forget_territory,
            store::set_card_territory,
            store::close_conversation_record,
            store::save_server_group,
            store::delete_server_group,
            attach::read_attachment,
            store::classify_drop,
            store::import_image,
            store::paste_image,
            store::list_images,
            store::save_image,
            store::delete_image,
            store::sweep_references,
            store::list_widgets,
            store::save_widget,
            store::delete_widget,
            store::read_pomodoro,
            store::save_pomodoro,
            store::record_job,
            store::settle_job,
            store::forget_jobs,
            store::pending_jobs,
            store::open_gate_run,
            store::settle_gate_run,
            store::gate_runs,
            store::gate_trees,
            joblog::job_output,
            quit::note_busy,
            quit::stay,
            perf::sample_performance,
            perf::release_performance,
            perf::kill_process,
            reap::reap_survey,
            workflow::workflow_progress,
            usage::read_usage,
            limits::read_limits,
            limits::release_limits,
            azdo::azdo_runs,
            azdo::azdo_reviews,
            azdo::release_azdo,
            creds::integration_held,
            creds::set_integration_token,
            creds::clear_integration_token,
            creds::verify_integration,
            asana::asana_workspaces,
            asana::asana_projects,
            asana::asana_board,
            asana::asana_mine,
            asana::asana_move,
            azdo::forge_run,
            store::list_ambience,
            store::save_ambience,
            store::activate_ambience,
            store::delete_ambience,
            servers::start_group,
            servers::stop_group,
            servers::group_running,
            servers::servers_quiet,
            bang::bang_run,
            bang::bang_stop,
            bang::bang_running,
            bang::bang_complete,
            shell::open_shell,
            shell::shell_send,
            shell::close_shell,
            shell::shell_alive,
            nvim::open_editor,
            nvim::editor_open,
            nvim::editor_input,
            nvim::editor_paste,
            nvim::editor_mouse,
            nvim::editor_resize,
            nvim::close_editor,
            nvim::editor_alive,
            project::probe_project,
            project::poll_projects,
            project::fetch_projects,
            actions::run_action,
            actions::cancel_action,
            actions::tail_log,
            actions::read_tail,
            actions::bump_version,
            actions::unreal_exec,
            actions::launch_detached,
            actions::focus_process,
            actions::close_process,
            actions::process_alive,
            ask::answer_ask,
            ask::stir_ask,
            ask::hold_ask,
            presence::presence_read,
            presence::set_presence,
            presence::deferred_asks,
            presence::take_deferred_ask,
            notice::notice_raise,
            notice::notices_read,
            notice::notice_take,
            presence::deferred_acts,
            presence::answer_deferred_act,
            sketch::sketch_json,
            sketch::sketch_cache,
            sketch::sketch_have,
            sketch::sketch_drop,
            sketch::sketch_folder,
            sketch::sketch_adopt,
            open::open_external,
            open::show_in_explorer,
            open::open_folder,
            find::classify_paths,
            find::find_files,
            find::find_grep,
            find::read_file_text,
            find::read_file_media,
            find::read_file_doc,
            find::open_file_outside,
            aside::ask_aside,
            portage::write_layout_file,
            portage::read_layout_file,
            portage::missing_roots,
            control::control_endpoint,
            control::control_attach,
            control::control_reply,
            control::control_real_click,
            control::control_real_drag,
            control::control_real_wheel,
            control::control_real_key,
            status::claude_status,
            voice::voice_hearing,
            voice::voice_listen,
            voice::voice_open,
            voice::voice_close,
            voice::voice_ear,
            steward::voice_steward,
            spotify::spotify_link,
            spotify::spotify_forget,
            spotify::spotify_start,
            spotify::spotify_stop,
            spotify::spotify_status,
            spotify::spotify_command,
            applog::app_log,
            update::latest_release,
            spotify::spotify_play,
            spotify::spotify_cancel_link,
            selector::spotify_search,
            update::latest_tag,
            update::fetch_update,
            update::arm_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building skein")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                /* Children die with the app: nothing is left editing a repo
                   unwatched, and no orphan keeps holding a dev server port.
                   Anything still open is marked interrupted so its card comes
                   back saying so rather than pretending it finished. */
                let running = app.state::<Supervisor>().shutdown();
                app.state::<Servers>().shutdown();
                /* And the shell, which is the one process here a person was
                   driving by hand — so it can be holding anything at all. */
                app.state::<Shells>().shutdown();
                /* And the editor, which holds language servers — and, if
                   anything was left unsaved, leaves the swap files nvim keeps
                   for exactly this. Writing a buffer nobody asked to have
                   written would be the one thing here that cannot be undone. */
                app.state::<Nvims>().shutdown();
                /* The `!` runs and the completion shell go with everything
                   else — a build started from the dock is a tree of processes
                   like any other. */
                app.state::<Bangs>().shutdown();
                /* A build left running would go on writing to a repo nobody is
                   watching, exactly as a conversation would. */
                app.state::<Runs>().shutdown();
                /* Take the published control token away with us, so a dead port
                   never reads as a live one. */
                app.state::<Control>().cleanup();
                if let Some(store) = app.try_state::<Store>() {
                    if let Ok(conn) = store.0.lock() {
                        store::mark_interrupted(&conn, &running);
                    }
                }
                /* Last of all, and only if something armed it: an update
                   installer needs the exe it is replacing to have let go, which
                   is everything above this line. `Arming::take` spends the
                   arming, because this handler runs twice on a clean quit and
                   two installers racing for one directory is worse than none. */
                update::run_armed(app);
            }
        });
}
