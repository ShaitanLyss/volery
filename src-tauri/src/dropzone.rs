//! Taking a file dragged from Explorer, on the windows wry walked too early.
//!
//! Tauri's native drop (`dragDropEnabled`, on by default, and the whole of how
//! a folder becomes a card and an image lands on the wall) is wry's: at the end
//! of building a WebView2 it walks the child windows that exist *at that
//! moment*, calls `RevokeDragDrop` on each and registers an `IDropTarget` of
//! its own (wry 0.55.1, `src/webview2/drag_drop.rs`). The window that matters
//! is `Chrome_WidgetWin_1`, the one WebView2's browser process parents the page
//! under — and the browser process makes it on its own schedule, which may be
//! after `build()` returns. Whether it already exists when the walk runs is a
//! race, and on a machine with ten agents running it is lost.
//!
//! Measured 2026-10-18 on a lab wall, with a patched wry that logged the walk,
//! and a genuine OLE drag (`DoDragDrop` with a `CF_HDROP` object from another
//! process, the cursor moved over the window by `SetCursorPos`):
//!   - walk found the three windows below `WRY_WEBVIEW` → `Chrome_WidgetWin_1`
//!     carried wry's target, the drop reached the page, a folder opened a card;
//!   - walk found only `Chrome_WidgetWin_0` (ours, so already there) → no
//!     target on `Chrome_WidgetWin_1` or `Chrome_RenderWidgetHostHWND`, and the
//!     cursor over the page was the no-entry sign for the whole window.
//! The installed 0.62 and 0.63 were in the second state on every launch looked
//! at. `SetAllowExternalDrop(false)` is why nothing else answers: wry turns
//! WebView2's own target off so its own can take the file, so a window it
//! missed has no target at all, and OLE does not carry on up to the parent
//! that does have one — it is the *other process's* window.
//!
//! So the walk is done again, here, when the page has loaded — by which point
//! the page has painted and every window under it exists — and every window
//! with no target gets one of ours. A window that already has one (wry's, or
//! WebView2's own on the GPU window) is left alone, so a launch that won the
//! race gets exactly one target per window as before and no event twice. The
//! events are the ones Tauri itself emits, name for name and payload for
//! payload, so `onDragDropEvent` neither knows nor cares which target heard it.
//!
//! The target is wry's `DragDropTarget`, cut down: one format (`CF_HDROP`, a
//! list of paths), copy as the only effect, and a plain emit in place of the
//! runtime's message round trip.

#[cfg(windows)]
mod imp {
    use std::{
        cell::{Cell, RefCell},
        ffi::OsString,
        os::windows::ffi::OsStringExt,
        path::PathBuf,
        rc::Rc,
    };

    use tauri::{AppHandle, Emitter, EventTarget, Runtime, WebviewWindow};
    use windows::{
        core::{implement, w, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT, POINTL},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, CF_HDROP, DROPEFFECT,
                    DROPEFFECT_COPY, DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Shell::{DragFinish, DragQueryFileW, HDROP},
                WindowsAndMessaging::{EnumChildWindows, GetPropW},
            },
        },
    };

    thread_local! {
        /* A registered target is only alive while somebody holds it, and a COM
           object here is not `Send`, so the main thread — the only one that
           registers — keeps them for the life of the process. */
        static HELD: RefCell<Vec<IDropTarget>> = const { RefCell::new(Vec::new()) };
    }

    /// What a drag did, in the order Tauri's own `DragDropEvent` names it.
    enum Event {
        Enter(Vec<PathBuf>, (i32, i32)),
        Over((i32, i32)),
        Drop(Vec<PathBuf>, (i32, i32)),
        Leave,
    }

    #[implement(IDropTarget)]
    struct Target {
        hwnd: HWND,
        say: Rc<dyn Fn(Event)>,
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
            let _ = unsafe { ScreenToClient(self.hwnd, &mut p) };
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

    /// Give every window under this one that has no drop target one of ours.
    /// Main thread only, and safe to run as often as you like.
    pub fn arm<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
        let Ok(top) = window.hwnd() else { return };
        let label = window.label().to_string();
        let app = app.clone();
        let say: Rc<dyn Fn(Event)> = Rc::new(move |event| {
            let to = EventTarget::webview(label.clone());
            let pos = |(x, y): (i32, i32)| serde_json::json!({ "x": x, "y": y });
            let _ = match event {
                Event::Enter(paths, p) => {
                    app.emit_to(to, "tauri://drag-enter", serde_json::json!({ "paths": paths, "position": pos(p) }))
                }
                Event::Over(p) => app.emit_to(to, "tauri://drag-over", serde_json::json!({ "position": pos(p) })),
                Event::Drop(paths, p) => {
                    app.emit_to(to, "tauri://drag-drop", serde_json::json!({ "paths": paths, "position": pos(p) }))
                }
                Event::Leave => app.emit_to(to, "tauri://drag-leave", ()),
            };
        });
        for hwnd in descendants(top) {
            if !unsafe { GetPropW(hwnd, w!("OleDropTargetInterface")) }.is_invalid() {
                continue;
            }
            let target: IDropTarget = Target {
                hwnd,
                say: say.clone(),
                effect: Cell::new(DROPEFFECT_NONE),
                valid: Cell::new(false),
            }
            .into();
            if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
                HELD.with(|held| held.borrow_mut().push(target));
            }
        }
    }
}

/// Once the page has loaded, make sure a file dragged from Explorer has
/// somewhere to land. A no-op off Windows, where there is no such race.
#[cfg(windows)]
pub fn arm<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let app = tauri::Manager::app_handle(window).clone();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || imp::arm(&app, &w));
}

#[cfg(not(windows))]
pub fn arm<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
