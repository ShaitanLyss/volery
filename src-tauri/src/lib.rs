mod actions;
mod ask;
mod accounts;
mod bang;
mod claude;
mod board;
/// Public so `examples/azdo-probe.rs` can drive the real reading rather than a
/// copy of it — the convention `tools/probe-context.ts` sets for questions of
/// the form "what does this service actually do".
pub mod azdo;
mod control;
/// The rows a forge answers in, and the two providers that fill them. `forge`
/// is vocabulary-neutral on purpose — see its header for the line between a
/// projection that is honest and one that is a lie.
mod forge;
mod github;
/// Public so `examples/find-probe.rs` can drive the real search rather than a
/// copy of it — the same arrangement `azdo` has, and the convention
/// `tools/probe-context.ts` sets for questions of the form "what does this
/// actually do".
pub mod find;
mod guidance;
pub mod hooks;
mod later;
mod nvim;
mod limits;
mod open;
mod perf;
mod pin;
mod portage;
mod project;
mod quit;
mod relay;
mod repair;
mod servers;
mod sessions;
mod signin;
mod shell;
mod sink;
mod spawn;
mod store;
mod supervisor;
mod update;
mod usage;
mod vault;
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
/// pump, and everything that calls this is a failure *before* `run()` — there is
/// no loop yet, and a dialog that never paints is the silence it was added to
/// break. `MessageBoxW` is synchronous and needs nothing but a thread.
///
/// The console line goes out either way, so `bun run tauri dev` shows it too.
fn complain(message: &str) {
    eprintln!("skein: {message}");
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let text = HSTRING::from(message);
        let title = HSTRING::from("Skein");
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        .manage(Runs::default())
        .manage(Asks::default())
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
        /* Recent pins per card, for the rate in `pin.rs`. Nothing survives a
           quit on purpose: it is a rate over one minute, and a rate that
           outlived a restart would be a restart that cost you the wall. */
        .manage(Pins::default())
        /* An installer waiting for the wall to come down, or nothing, which is
           every launch but the one after you asked for an update. See
           `update.rs` on why the button arms this rather than running it. */
        .manage(update::Arming::default())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("no app data dir: {e}"))?;
            /* Nothing after this line can run without the database, so this is
               the one failure that stops the app rather than degrading it — and
               `main` is created hidden, so returning the error alone is a
               process that starts, shows nothing, and exits without saying
               anything. That is what a wedged migration looked like from the
               outside: "skein doesn't start any more", with the whole of the
               cause sitting in a string nobody could read. It says so out loud
               before it goes, and names the file, since recovering by hand
               means knowing which one. See `store::migrate`. */
            let store = Store::open(dir.clone()).map_err(|e| {
                complain(&format!(
                    "Skein could not open its studio database.\n\n{e}\n\n{}",
                    dir.join("skein.db").display()
                ));
                e
            })?;
            /* Place and show the studio window before anything slower than the
               database runs, and before the wall has painted a frame. `main` is
               `"visible": false` in tauri.conf.json and this is the only thing
               that shows it — a window sized after it is on screen jumps, on
               exactly the machines the sizing exists for. See window.rs. */
            let frame = store.0.lock().ok().and_then(|c| store::read_window_frame(&c));
            app.manage(store);
            window::settle(app.handle(), frame);
            /* Bind the ask endpoint before any conversation can be spawned,
               so every one of them gets a working --mcp-config. */
            let port = ask::start(app.handle().clone())?;
            app.state::<Asks>().set_port(port);
            /* Off unless SKEIN_CONTROL says otherwise. When it is on, the title
               bar says so — see src/lib/control.svelte.ts. */
            if let Some(ep) = control::start(app.handle().clone(), &dir)? {
                app.state::<Control>().set_endpoint(ep);
            }
            /* Sweeps each card's job for processes whose parent has gone away.
               Started here rather than with the performance meter on purpose:
               the meter exists only while a widget is on the wall, and a
               guarantee that holds while you are looking at it is not one. */
            perf::spawn_reaper(app.handle().clone());
            /* Hands out wakes that have come due. Started here for exactly the
               reason above: a card that asked to be woken at ten past has to be
               woken at ten past whether or not anybody is looking at the wall. */
            later::spawn_waker(app.handle().clone());
            Ok(())
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
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    /* Where it was, for the next launch. Here rather than on every
                       `Moved`/`Resized`, which on a dragged window is a database
                       write per frame; the only frame that matters is the last one,
                       and this is where it is.

                       Before the question below, deliberately: a close that gets
                       held back still moved the window to wherever it is now, and
                       a frame saved only on the way out would forget every quit
                       somebody thought better of. */
                    if let Some(frame) = window::frame_of(window) {
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
            supervisor::spawn_conversation,
            supervisor::send_prompt,
            supervisor::interrupt_conversation,
            supervisor::set_permission_mode,
            supervisor::close_conversation,
            supervisor::read_ai_title,
            supervisor::read_session_effort,
            supervisor::read_transcript,
            supervisor::wake_quiet,
            claude::find_claude,
            claude::install_claude,
            accounts::list_accounts,
            accounts::add_account,
            accounts::remove_account,
            accounts::sign_out,
            accounts::reorder_accounts,
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
            sink::read_sink,
            sink::sink_add,
            sink::sink_edit,
            sink::sink_settle,
            sink::sink_unsettle,
            sink::sink_delete,
            sink::sink_release,
            sink::sink_tool,
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
            store::set_project_guidance,
            store::reroot_project,
            store::record_conversation,
            store::chat_home,
            store::update_conversation,
            store::clear_conversation,
            store::record_turn,
            store::spend_since,
            store::record_file_touch,
            store::overlapping_conversations,
            store::save_placement,
            store::place_project,
            store::stick_project,
            store::close_conversation_record,
            store::save_server_group,
            store::delete_server_group,
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
            quit::note_busy,
            quit::stay,
            perf::sample_performance,
            perf::release_performance,
            perf::kill_process,
            workflow::workflow_progress,
            usage::read_usage,
            limits::read_limits,
            limits::release_limits,
            azdo::azdo_runs,
            azdo::azdo_reviews,
            azdo::release_azdo,
            azdo::azdo_token,
            azdo::set_azdo_token,
            azdo::clear_azdo_token,
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
            open::open_external,
            find::find_files,
            find::find_grep,
            find::read_file_text,
            portage::write_layout_file,
            portage::read_layout_file,
            portage::missing_roots,
            control::control_endpoint,
            control::control_attach,
            control::control_reply,
            control::control_real_click,
            control::control_real_drag,
            update::latest_release,
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
