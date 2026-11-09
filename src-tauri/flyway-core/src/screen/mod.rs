//! A screen as the flyway carries it: a monitor as a wall announces it, what a
//! viewer wants of a source, one input event, and (`wire`) the byte layout of
//! every message on a screen's connection.
//!
//! These lived in `src-tauri/src/cast/`, which still re-exports them as
//! `crate::cast::{Monitor, Want, Input, Button}` and `crate::cast::wire`. The
//! capture, the encoder and the hub stay there: they are this machine's, and
//! a phone that only watches needs none of them. `.claude/rules/cast.md` and
//! `docs/SCREENS.md` have the reasoning.

pub mod wire;

use serde::{Deserialize, Serialize};

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

