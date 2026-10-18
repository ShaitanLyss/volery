//! Taking a file dragged from Explorer: a drop target on every window the page
//! is drawn in, from the moment that window joins ours.
//!
//! Tauri's native drop (`dragDropEnabled`, on by default) is how a folder
//! becomes a card and an image lands on the wall, and it is one path on every
//! OS: paths and a position, as `tauri://drag-*` events. On macOS and Linux it
//! is by construction already — wry's handlers are a WKWebView subclass's own
//! `dragging*` methods and GTK signals connected on the webview widget at
//! build, so there is nothing that arrives later to miss (wry 0.55.1,
//! `wkwebview/drag_drop.rs`, `webkitgtk/drag_drop.rs`; 0.57.0 is unchanged).
//! Windows is the one where it was not, and this module is the whole of the
//! difference. Nothing in the front end knows it exists.
//!
//! ### Why wry's own registration loses, even on an idle machine
//!
//! wry turns WebView2's own drop off (`SetAllowExternalDrop(false)`) and, at
//! the end of `build()`, walks the child windows that exist and registers an
//! `IDropTarget` on each. Three measured facts make that a race it usually
//! loses (2026-10-18; the probes are `tools/drop/`, the record is
//! `.claude/rules/attach.md`):
//!
//! - **The window a drop lands on is not ours.** The tree is `Tauri Window` →
//!   `WRY_WEBVIEW` → `Chrome_WidgetWin_0` (this process) → `Chrome_WidgetWin_1`
//!   → `Chrome_RenderWidgetHostHWND` (both the msedgewebview2 *browser*
//!   process). `WindowFromPoint` over the page answers the last one.
//! - **OLE's hit test walks up to a registered ancestor only within one
//!   process.** A target on our `Chrome_WidgetWin_0` is never reached from a
//!   browser-owned window under it; the cursor is the no-entry sign.
//! - **The browser windows join our tree after `build()`, on their own
//!   schedule.** `Chrome_WidgetWin_1` is created top-level and *reparented*
//!   under ours, and the render window is parked in a hidden window of the
//!   browser's and moved back. Chromium registers its own target on
//!   `Chrome_WidgetWin_1` and takes it away again ~100ms later, once the
//!   allow-external-drop setting reaches it.
//!
//! So wry's walk found only our own window, put its target where no drop can
//! reach it, and every OS drop was refused. Polled from launch, an *idle* lab
//! wall did exactly that, and the installed 0.62 was in that state. 0.63.1's
//! answer was to walk again once the page had loaded, which is
//! check-after: right for every launch measured, and no guarantee.
//!
//! ### What is done instead
//!
//! Every way a window joins our tree is announced by a WinEvent:
//! `EVENT_OBJECT_CREATE` and `EVENT_OBJECT_PARENTCHANGE`, raised by the process
//! that owns the window. So once the window is built, an out-of-context hook is
//! put on the browser process — **hook first, then walk** — and every event for
//! a window whose root is one of ours walks our tree again and gives each window
//! without our target one. Whatever existed before the hook is found by the
//! walk; whatever arrives after raises an event. No step waits for anything to
//! have happened.
//!
//! **Ours replaces whatever is there**, wry's included, so on Windows there is
//! exactly one target implementation, and it is this one: it is what a browser
//! drag's formats get taught to later (sink fd7ef025). The events are the ones
//! Tauri itself emits, name for name and payload for payload.
//!
//! The browser process is not forever. WebView2's `ProcessFailed` re-reads its
//! id and re-hooks if it changed, and the window's destruction unhooks, so no
//! hook outlives the process or the window it was for. [`Ledger`] is that
//! bookkeeping, apart from the OS so it can be asserted.
//!
//! Two residues, both measured harmless rather than assumed:
//!
//! - Chromium may take back whatever is on `Chrome_WidgetWin_1` when its own
//!   setting lands, and nothing announces that. The render window covers the
//!   whole page and Chromium never touches its target.
//! - The `Intermediate D3D Window` belongs to the GPU process, which is not the
//!   one hooked, so a GPU restart's new one waits for the next walk (the
//!   `ProcessFailed` that announced the restart, or the next browser event).
//!   It is `WS_EX_LAYERED | WS_EX_TRANSPARENT`, which the hit test passes
//!   through: with it bare, a drag over the page still lands on the render
//!   window and is taken (killed the GPU process on a lab, 2026-10-18).
//!
//! A renderer that dies and is reloaded is the case that proves the hook: the
//! new render window is created after everything above has run, and gets its
//! target from its own `EVENT_OBJECT_CREATE` (the lab's log said
//! `drop target on Chrome_RenderWidgetHostHWND`, alone, at the reload).

use std::collections::HashMap;

/// Something to do to the OS hooks, in the order it should be done.
#[derive(Debug, PartialEq, Eq)]
pub enum Op {
    Hook(u32),
    Unhook(u32),
}

/// Which browser process each armed window's page lives in.
///
/// A process is hooked while at least one window lives in it, and unhooked when
/// the last one leaves — by being destroyed, or by its browser being replaced.
/// `main` and `peek` share one browser, so they share one hook.
#[derive(Default)]
pub struct Ledger {
    windows: HashMap<String, u32>,
}

impl Ledger {
    fn living(&self, pid: u32) -> usize {
        self.windows.values().filter(|&&p| p == pid).count()
    }

    /// This window's page is in `pid`. Safe to say twice.
    pub fn arm(&mut self, label: &str, pid: u32) -> Vec<Op> {
        let mut ops = Vec::new();
        if self.windows.get(label) == Some(&pid) {
            return ops;
        }
        if self.living(pid) == 0 {
            ops.push(Op::Hook(pid));
        }
        if let Some(old) = self.windows.insert(label.to_string(), pid) {
            if self.living(old) == 0 {
                ops.push(Op::Unhook(old));
            }
        }
        ops
    }

    /// This window is gone.
    pub fn disarm(&mut self, label: &str) -> Vec<Op> {
        match self.windows.remove(label) {
            Some(old) if self.living(old) == 0 => vec![Op::Unhook(old)],
            _ => Vec::new(),
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::{
        cell::{Cell, RefCell},
        collections::{HashMap, HashSet},
        ffi::OsString,
        os::windows::ffi::OsStringExt,
        path::PathBuf,
        rc::Rc,
    };

    use super::{Ledger, Op};
    use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewWindow, WindowEvent};
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2, COREWEBVIEW2_PROCESS_FAILED_KIND},
        ProcessFailedEventHandler,
    };
    use windows::{
        core::{implement, w, Interface, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT, POINTL},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP,
                    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
                Shell::{DragFinish, DragQueryFileW, HDROP},
                WindowsAndMessaging::{
                    EnumChildWindows, GetAncestor, GetClassNameW, GetPropW,
                    GetWindowThreadProcessId, CHILDID_SELF, EVENT_OBJECT_CREATE,
                    EVENT_OBJECT_PARENTCHANGE, GA_ROOT, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT,
                },
            },
        },
    };

    /// What a drag did, in the order Tauri's own `DragDropEvent` names it.
    enum Event {
        Enter(Vec<PathBuf>, (i32, i32)),
        Over((i32, i32)),
        Drop(Vec<PathBuf>, (i32, i32)),
        Leave,
    }

    type Say = Rc<dyn Fn(Event)>;

    /// One window whose tree is kept armed.
    struct Armed {
        label: String,
        top: HWND,
        /* Positions are measured from the webview's own container, whichever
           window under it took the drop, because that is the page's origin. */
        page: HWND,
        say: Say,
    }

    #[derive(Default)]
    struct State {
        ledger: Ledger,
        hooks: HashMap<u32, [HWINEVENTHOOK; 2]>,
        armed: Vec<Armed>,
        /* Every target this module registered, by window. A registered target
           is only alive while somebody holds it, and a COM object here is not
           `Send`, so the main thread — the only one that touches any of this —
           keeps them. */
        held: HashMap<isize, (String, IDropTarget)>,
        /* A window a registration failed on is said once in the log, not on
           every event that walks past it. */
        refused: HashSet<isize>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
        /* `RegisterDragDrop` on another process's window is a cross-process
           call, and a thread waiting on one pumps messages — which is how a
           hook's callback is delivered. So a walk can be re-entered from inside
           itself; it notes that and goes round again instead. */
        static WALKING: Cell<bool> = const { Cell::new(false) };
        static AGAIN: Cell<bool> = const { Cell::new(false) };
    }

    #[implement(IDropTarget)]
    struct Target {
        page: HWND,
        say: Say,
        effect: Cell<DROPEFFECT>,
        /* A drag that carries no file — text out of a browser — must not
           produce a `Leave` for an `Enter` nobody was told about. */
        valid: Cell<bool>,
    }

    /// The paths in a drag, or `None` when it is not a file drag.
    unsafe fn paths_of(data: &IDataObject) -> Option<(Vec<PathBuf>, HDROP)> {
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let medium = data.GetData(&format).ok()?;
        let hdrop = HDROP(medium.u.hGlobal.0 as _);
        let mut paths = Vec::new();
        for i in 0..DragQueryFileW(hdrop, 0xFFFF_FFFF, None) {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            paths.push(OsString::from_wide(&buf[..len]).into());
        }
        Some((paths, hdrop))
    }

    impl Target {
        fn client(&self, pt: &POINTL) -> (i32, i32) {
            let mut p = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.page, &mut p) };
            (p.x, p.y)
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for Target_Impl {
        fn DragEnter(
            &self,
            data: windows::core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let Some(data) = data.as_ref() else { return Ok(()) };
            let Some((paths, _)) = (unsafe { paths_of(data) }) else {
                self.valid.set(false);
                self.effect.set(DROPEFFECT_NONE);
                unsafe { *effect = DROPEFFECT_NONE };
                return Ok(());
            };
            self.valid.set(true);
            (self.say)(Event::Enter(paths, self.client(pt)));
            self.effect.set(DROPEFFECT_COPY);
            unsafe { *effect = DROPEFFECT_COPY };
            Ok(())
        }

        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if self.valid.get() {
                (self.say)(Event::Over(self.client(pt)));
            }
            unsafe { *effect = self.effect.get() };
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            if self.valid.replace(false) {
                (self.say)(Event::Leave);
            }
            Ok(())
        }

        fn Drop(
            &self,
            data: windows::core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if !self.valid.replace(false) {
                unsafe { *effect = DROPEFFECT_NONE };
                return Ok(());
            }
            let Some(data) = data.as_ref() else { return Ok(()) };
            if let Some((paths, hdrop)) = unsafe { paths_of(data) } {
                (self.say)(Event::Drop(paths, self.client(pt)));
                unsafe { DragFinish(hdrop) };
            }
            unsafe { *effect = DROPEFFECT_COPY };
            Ok(())
        }
    }

    /// Every window under `top`, at any depth, in one list.
    fn descendants(top: HWND) -> Vec<HWND> {
        unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> BOOL {
            (*(found.0 as *mut Vec<HWND>)).push(hwnd);
            true.into()
        }
        let mut found: Vec<HWND> = Vec::new();
        let _ = unsafe { EnumChildWindows(Some(top), Some(each), LPARAM(&mut found as *mut _ as isize)) };
        found
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
        String::from_utf16_lossy(&buf[..len])
    }

    /// Walk every armed tree until a pass finds nothing new, re-entrancy and
    /// all. The only thing in this module that registers anything.
    fn settle() {
        if WALKING.replace(true) {
            AGAIN.set(true);
            return;
        }
        loop {
            AGAIN.set(false);
            STATE.with(|s| walk(&mut s.borrow_mut()));
            if !AGAIN.get() {
                break;
            }
        }
        WALKING.set(false);
    }

    /// Give every window under every armed tree our target, unless it already
    /// carries it.
    fn walk(state: &mut State) {
        let mut armed_now: Vec<String> = Vec::new();
        let trees: Vec<(String, HWND, HWND, Say)> =
            state.armed.iter().map(|a| (a.label.clone(), a.top, a.page, a.say.clone())).collect();
        for (label, top, page, say) in trees {
            for hwnd in descendants(top) {
                let key = hwnd.0 as isize;
                /* `OleDropTargetInterface` holds the very pointer that was
                   registered, so "is it ours" is a comparison and not a guess. */
                let current = unsafe { GetPropW(hwnd, w!("OleDropTargetInterface")) };
                if let Some((_, ours)) = state.held.get(&key) {
                    if current.0 == ours.as_raw() {
                        continue;
                    }
                }
                /* Somebody else's — wry's, or Chromium's own on its widget
                   window — comes off, so that one implementation answers. On a
                   browser-owned window this can report RPC_E_WRONG_THREAD and
                   still have taken it off, which is why its result is not read:
                   the registration below is the thing that says whether it
                   worked. */
                if !current.is_invalid() {
                    let _ = unsafe { RevokeDragDrop(hwnd) };
                }
                let target: IDropTarget = Target {
                    page,
                    say: say.clone(),
                    effect: Cell::new(DROPEFFECT_NONE),
                    valid: Cell::new(false),
                }
                .into();
                /* Cross-process: most of these windows belong to the browser
                   process, not to us. That OLE takes a registration made from
                   another process, and calls the target here when a drag
                   enters that window, is MEASURED rather than documented —
                   `tools/drop/run-ole.ps1 -Mode crossreg` and `probe-reg.ps1`, see
                   attach.md. If a WebView2 update ever stops it, this is
                   where it shows: a warning naming the window's class. */
                match unsafe { RegisterDragDrop(hwnd, &target) } {
                    Ok(()) => {
                        state.refused.remove(&key);
                        state.held.insert(key, (label.clone(), target));
                        armed_now.push(class_of(hwnd));
                    }
                    Err(e) => {
                        if state.refused.insert(key) {
                            let mut pid = 0u32;
                            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
                            log::warn!(
                                target: "dropzone",
                                "could not give {} (pid {pid}) a drop target: {e} — a file dropped over it will be refused",
                                class_of(hwnd)
                            );
                        }
                    }
                }
            }
        }
        if !armed_now.is_empty() {
            log::info!(target: "dropzone", "drop target on {}", armed_now.join(", "));
        }
    }

    /// The hook's whole cost for a window that is not ours is two compares and
    /// `GetAncestor`. The process it watches is the browser, which creates and
    /// reparents windows for every page and popup it hosts, not only ours.
    unsafe extern "system" fn on_event(
        _hook: HWINEVENTHOOK,
        _event: u32,
        hwnd: HWND,
        object: i32,
        child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if object != OBJID_WINDOW.0 || child != CHILDID_SELF as i32 || hwnd.is_invalid() {
            return;
        }
        if WALKING.get() {
            AGAIN.set(true);
            return;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let ours = STATE.with(|s| s.borrow().armed.iter().any(|a| a.top == root));
        if ours {
            settle();
        }
    }

    fn apply(state: &mut State, ops: Vec<Op>) {
        for op in ops {
            match op {
                Op::Hook(pid) => {
                    let hook = |event| unsafe {
                        SetWinEventHook(event, event, None, Some(on_event), pid, 0, WINEVENT_OUTOFCONTEXT)
                    };
                    let hooks = [hook(EVENT_OBJECT_CREATE), hook(EVENT_OBJECT_PARENTCHANGE)];
                    if hooks.iter().any(|h| h.is_invalid()) {
                        log::warn!(target: "dropzone", "could not watch browser process {pid} for new windows");
                    }
                    state.hooks.insert(pid, hooks);
                }
                Op::Unhook(pid) => {
                    for hook in state.hooks.remove(&pid).into_iter().flatten() {
                        if !hook.is_invalid() {
                            let _ = unsafe { UnhookWinEvent(hook) };
                        }
                    }
                }
            }
        }
    }

    fn browser_of(core: &ICoreWebView2) -> Option<u32> {
        let mut pid = 0u32;
        unsafe { core.BrowserProcessId(&mut pid) }.ok().filter(|_| pid != 0).map(|_| pid)
    }

    /// Main thread. This window's page is in `pid`: hook it if it is not
    /// already, then walk.
    pub fn arm(label: &str, pid: u32) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let ops = s.ledger.arm(label, pid);
            apply(&mut s, ops);
        });
        settle();
    }

    fn disarm(label: &str) {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let ops = s.ledger.disarm(label);
            apply(&mut s, ops);
            s.armed.retain(|a| a.label != label);
            /* Dropping the last reference to a target whose window is gone is
               all the release there is; a window still standing gets an
               explicit revoke first so OLE lets go of it too. */
            let keys: Vec<isize> =
                s.held.iter().filter(|(_, (l, _))| l == label).map(|(k, _)| *k).collect();
            for key in keys {
                let _ = unsafe { RevokeDragDrop(HWND(key as _)) };
                s.held.remove(&key);
            }
        });
    }

    pub fn watch<R: Runtime>(window: &WebviewWindow<R>) {
        /* As a number: an `HWND` is a pointer and not `Send`, and the webview is
           reached through a closure that has to be. */
        let Ok(top) = window.hwnd().map(|h| h.0 as isize) else { return };
        let label = window.label().to_string();
        let app: AppHandle<R> = window.app_handle().clone();

        {
            let label = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    disarm(&label);
                }
            });
        }

        let watched = label.clone();
        let result = window.with_webview(move |webview| {
            let controller = webview.controller();
            let mut page = HWND::default();
            let _ = unsafe { controller.ParentWindow(&mut page) };
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                log::warn!(target: "dropzone", "{watched}: no webview to watch, so no file drop");
                return;
            };

            let to = EventTarget::webview(watched.clone());
            let say: Say = Rc::new(move |event| {
                let pos = |(x, y): (i32, i32)| serde_json::json!({ "x": x, "y": y });
                let _ = match event {
                    Event::Enter(paths, p) => app.emit_to(
                        to.clone(),
                        "tauri://drag-enter",
                        serde_json::json!({ "paths": paths, "position": pos(p) }),
                    ),
                    Event::Over(p) => {
                        app.emit_to(to.clone(), "tauri://drag-over", serde_json::json!({ "position": pos(p) }))
                    }
                    Event::Drop(paths, p) => app.emit_to(
                        to.clone(),
                        "tauri://drag-drop",
                        serde_json::json!({ "paths": paths, "position": pos(p) }),
                    ),
                    Event::Leave => app.emit_to(to.clone(), "tauri://drag-leave", ()),
                };
            });
            STATE.with(|s| {
                s.borrow_mut().armed.push(Armed {
                    label: watched.clone(),
                    top: HWND(top as _),
                    page: if page.is_invalid() { HWND(top as _) } else { page },
                    say,
                })
            });

            /* A renderer, GPU or browser process that dies is replaced, and a
               replaced browser is a new pid whose windows the old hook would
               never hear. So every failure asks again; `arm` is a no-op when
               the answer has not changed. */
            let again = watched.clone();
            let mut token = 0i64;
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if let Some(args) = args {
                    let _ = unsafe { args.ProcessFailedKind(&mut kind) };
                }
                let browser = sender.as_ref().and_then(browser_of);
                log::info!(target: "dropzone", "{again}: a webview process failed (kind {}), browser is {browser:?}", kind.0);
                match browser {
                    Some(pid) => arm(&again, pid),
                    None => log::warn!(target: "dropzone", "{again}: a webview process failed and its browser could not be read"),
                }
                Ok(())
            }));
            let _ = unsafe { core.add_ProcessFailed(&handler, &mut token) };

            match browser_of(&core) {
                Some(pid) => arm(&watched, pid),
                None => log::warn!(target: "dropzone", "{watched}: could not read the browser process, so no file drop"),
            }
        });
        if let Err(e) = result {
            log::warn!(target: "dropzone", "{label}: could not reach the webview ({e}), so no file drop");
        }
    }
}

/// Keep a file dragged from Explorer landing on this window, for as long as it
/// stands. Called once, right after `build()`. A no-op off Windows, where wry's
/// drop is already part of the webview it is built with.
#[cfg(windows)]
pub fn watch<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    imp::watch(window);
}

#[cfg(not(windows))]
pub fn watch<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg(test)]
mod tests {
    use super::{Ledger, Op};

    #[test]
    fn the_first_window_in_a_browser_hooks_it_and_saying_so_again_does_nothing() {
        let mut l = Ledger::default();
        assert_eq!(l.arm("main", 10), vec![Op::Hook(10)]);
        assert_eq!(l.arm("main", 10), vec![]);
    }

    #[test]
    fn two_windows_in_one_browser_share_one_hook_until_the_last_goes() {
        let mut l = Ledger::default();
        assert_eq!(l.arm("main", 10), vec![Op::Hook(10)]);
        assert_eq!(l.arm("peek", 10), vec![]);
        assert_eq!(l.disarm("peek"), vec![]);
        assert_eq!(l.disarm("main"), vec![Op::Unhook(10)]);
        assert_eq!(l.disarm("main"), vec![]);
    }

    #[test]
    fn a_replaced_browser_is_hooked_before_the_dead_one_is_let_go() {
        let mut l = Ledger::default();
        l.arm("main", 10);
        assert_eq!(l.arm("main", 20), vec![Op::Hook(20), Op::Unhook(10)]);
        assert_eq!(l.disarm("main"), vec![Op::Unhook(20)]);
    }

    #[test]
    fn a_dead_browser_another_window_still_lives_in_stays_hooked() {
        let mut l = Ledger::default();
        l.arm("main", 10);
        l.arm("peek", 10);
        assert_eq!(l.arm("main", 20), vec![Op::Hook(20)]);
        assert_eq!(l.arm("peek", 20), vec![Op::Unhook(10)]);
    }
}
