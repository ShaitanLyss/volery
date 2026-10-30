//! Screens on the wall: a machine's monitor, live, and drivable — this laptop
//! minus Volery, and every other machine on the flyway. `docs/SCREENS.md` is the
//! contract between the lanes building it; this file holds the types they all
//! meet at, so that each can be built against the same shapes before the others
//! exist.
//!
//! Called `cast` rather than `screens` because `screen.rs` is already the
//! display power request, and two modules a letter apart is a misread waiting
//! to happen. What the person sees is still "a screen".
//!
//! - `wire` — the bytes a frame and an input event are on every boundary: the
//!   loopback socket and the flyway carry the same messages. Pure.
//!
//! The rest arrive with their lanes (see the table in `docs/SCREENS.md`).

/* Built ahead of the lanes that call it, as `flyway` once was; this comes off
   when the hub is reached from `lib.rs`. */
#![allow(dead_code)]

pub mod wire;

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// A monitor this machine can show, as announced to the wall and the flyway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Monitor {
    /// Stable for as long as the monitor is plugged in: the adapter LUID and
    /// output index, so two machines' ids never need comparing.
    pub id: String,
    /// What Windows calls it, for the picker ("Generic PnP Monitor", or the
    /// panel's own name where EDID gives one).
    pub name: String,
    /// Native size in physical pixels, and where it sits on the desktop.
    pub w: u32,
    pub h: u32,
    pub x: i32,
    pub y: i32,
    pub hz: u32,
    pub primary: bool,
}

/// What a viewer wants of a source. Sent whenever the tile changes size,
/// scrolls out of view or is focused; the host derives the rendition from it
/// (the table in `docs/SCREENS.md`, "Adaptive by construction").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Want {
    /// The tile's size in *device* pixels — what a frame would be drawn at.
    pub w: u32,
    pub h: u32,
    /// The most the viewer can use; the host may send fewer.
    pub fps: u32,
    pub visible: bool,
    pub focused: bool,
}

/// One input event, as a viewer sends it. Layouts in `wire`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// Normalised 0..=65535 over the source monitor.
    MouseAbs { x: u16, y: u16 },
    /// Raw counts, from a pointer-locked viewer.
    MouseRel { dx: i16, dy: i16 },
    Button { button: Button, down: bool },
    /// 120 per notch, Windows' sign: positive `dy` is away from the user.
    Wheel { dx: i16, dy: i16 },
    /// PS/2 set-1 make code; `0xE0xx` for extended keys.
    Key { scan: u16, down: bool },
    /// Lift every key and button this viewer holds down.
    ReleaseAll,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

/// One message on its way to a viewer, already encoded to wire bytes: the hub
/// encodes a frame once however many viewers there are, and the loopback
/// socket and the flyway forward these untouched.
#[derive(Clone, Debug)]
pub enum Out {
    /// A binary message: video, cursor shape, cursor position.
    Binary(Arc<[u8]>),
    /// A JSON text message: config, state, stats.
    Text(Arc<str>),
}

impl Out {
    /// Whether this is a video frame that a decoder can start from. A viewer
    /// that has fallen behind drops everything until one of these.
    pub fn is_keyframe(&self) -> bool {
        matches!(self, Out::Binary(b) if wire::is_keyframe(b))
    }
}

/// Somewhere frames go: a loopback socket session, or a flyway connection to
/// another wall.
///
/// **`send` must never block.** It is called from the encoder's thread, so a
/// viewer that blocks stalls every other viewer of the same monitor. One that
/// cannot keep up drops frames until the next keyframe and asks for one. It
/// returns false once the viewer is gone, and the hub forgets it.
pub trait Viewer: Send + Sync + 'static {
    fn send(&self, out: Out) -> bool;
}
