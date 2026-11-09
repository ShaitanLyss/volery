//! The bytes a screen is made of, on every boundary it crosses.
//!
//! The loopback socket and the flyway carry the same messages, so they are
//! defined once, here, and `src/lib/cast.ts` decodes the same layouts — its
//! tests hold fixtures copied from the ones below, which is what keeps the two
//! halves from drifting. Little-endian throughout: both ends are x86, and JS's
//! `DataView` takes the endianness as an argument anyway.
//!
//! Tables, with the reasoning behind each choice, are in `docs/SCREENS.md`.

use super::{Button, Input};

pub const VIDEO: u8 = 0x01;
pub const CURSOR_SHAPE: u8 = 0x02;
pub const CURSOR_POS: u8 = 0x03;
pub const AUDIO: u8 = 0x04;

pub const MOUSE_ABS: u8 = 0x11;
pub const MOUSE_REL: u8 = 0x12;
pub const BUTTON: u8 = 0x13;
pub const WHEEL: u8 = 0x14;
pub const KEY: u8 = 0x15;
pub const RELEASE_ALL: u8 = 0x16;
/// Reserved for controllers, which are a later stage.
pub const PAD: u8 = 0x17;

/// The fixed part of a video message, before the Annex-B payload.
pub const VIDEO_HEADER: usize = 26;
const KEY_FLAG: u8 = 0x01;

/// What a video message's header says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoHeader {
    pub key: bool,
    pub w: u16,
    pub h: u16,
    pub seq: u32,
    /// The host's wall clock, µs since the Unix epoch, when the frame was
    /// captured and when the encoder handed it back.
    pub capture_us: u64,
    pub encoded_us: u64,
}

/// A whole video message: the header, then the encoder's bytes as they are.
pub fn video(h: &VideoHeader, annex_b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(VIDEO_HEADER + annex_b.len());
    out.push(VIDEO);
    out.push(if h.key { KEY_FLAG } else { 0 });
    out.extend_from_slice(&h.w.to_le_bytes());
    out.extend_from_slice(&h.h.to_le_bytes());
    out.extend_from_slice(&h.seq.to_le_bytes());
    out.extend_from_slice(&h.capture_us.to_le_bytes());
    out.extend_from_slice(&h.encoded_us.to_le_bytes());
    out.extend_from_slice(annex_b);
    out
}

pub fn read_video(b: &[u8]) -> Option<(VideoHeader, &[u8])> {
    if b.len() < VIDEO_HEADER || b[0] != VIDEO {
        return None;
    }
    let h = VideoHeader {
        key: b[1] & KEY_FLAG != 0,
        w: u16::from_le_bytes([b[2], b[3]]),
        h: u16::from_le_bytes([b[4], b[5]]),
        seq: u32::from_le_bytes(b[6..10].try_into().ok()?),
        capture_us: u64::from_le_bytes(b[10..18].try_into().ok()?),
        encoded_us: u64::from_le_bytes(b[18..26].try_into().ok()?),
    };
    Some((h, &b[VIDEO_HEADER..]))
}

pub fn is_keyframe(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == VIDEO && b[1] & KEY_FLAG != 0
}

/// A cursor image: straight-alpha RGBA, `w * h * 4` bytes. Sent once per new
/// shape; positions name it by `shape`.
pub fn cursor_shape(w: u16, h: u16, hot_x: u16, hot_y: u16, shape: u32, rgba: &[u8]) -> Vec<u8> {
    debug_assert_eq!(rgba.len(), w as usize * h as usize * 4);
    let mut out = Vec::with_capacity(14 + rgba.len());
    out.push(CURSOR_SHAPE);
    out.push(0);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&hot_x.to_le_bytes());
    out.extend_from_slice(&hot_y.to_le_bytes());
    out.extend_from_slice(&shape.to_le_bytes());
    out.extend_from_slice(rgba);
    out
}

/// Where the cursor is, in source pixels from the monitor's top-left.
pub fn cursor_pos(visible: bool, x: i16, y: i16, shape: u32) -> [u8; 10] {
    let mut out = [0u8; 10];
    out[0] = CURSOR_POS;
    out[1] = visible as u8;
    out[2..4].copy_from_slice(&x.to_le_bytes());
    out[4..6].copy_from_slice(&y.to_le_bytes());
    out[6..10].copy_from_slice(&shape.to_le_bytes());
    out
}

fn button_code(b: Button) -> u8 {
    match b {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
        Button::Back => 3,
        Button::Forward => 4,
    }
}

fn button_of(code: u8) -> Option<Button> {
    Some(match code {
        0 => Button::Left,
        1 => Button::Right,
        2 => Button::Middle,
        3 => Button::Back,
        4 => Button::Forward,
        _ => return None,
    })
}

/// Append one input event's bytes. Several go in one message.
pub fn put_input(out: &mut Vec<u8>, e: &Input) {
    match *e {
        Input::MouseAbs { x, y } => {
            out.push(MOUSE_ABS);
            out.extend_from_slice(&x.to_le_bytes());
            out.extend_from_slice(&y.to_le_bytes());
        }
        Input::MouseRel { dx, dy } => {
            out.push(MOUSE_REL);
            out.extend_from_slice(&dx.to_le_bytes());
            out.extend_from_slice(&dy.to_le_bytes());
        }
        Input::Button { button, down } => {
            out.push(BUTTON);
            out.push(button_code(button));
            out.push(down as u8);
        }
        Input::Wheel { dx, dy } => {
            out.push(WHEEL);
            out.extend_from_slice(&dx.to_le_bytes());
            out.extend_from_slice(&dy.to_le_bytes());
        }
        Input::Key { scan, down } => {
            out.push(KEY);
            out.extend_from_slice(&scan.to_le_bytes());
            out.push(down as u8);
        }
        Input::ReleaseAll => out.push(RELEASE_ALL),
    }
}

/// Every event in one message, in order. A message that ends mid-event, or
/// carries a kind this build does not know, yields what came before it and
/// stops: the rest cannot be framed, and a guessed key event is a key the
/// person did not press.
pub fn read_inputs(mut b: &[u8]) -> Vec<Input> {
    let mut out = Vec::new();
    let u16_at = |b: &[u8], i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let i16_at = |b: &[u8], i: usize| i16::from_le_bytes([b[i], b[i + 1]]);
    while let Some(&kind) = b.first() {
        let (e, len) = match kind {
            MOUSE_ABS if b.len() >= 5 => (Input::MouseAbs { x: u16_at(b, 1), y: u16_at(b, 3) }, 5),
            MOUSE_REL if b.len() >= 5 => (Input::MouseRel { dx: i16_at(b, 1), dy: i16_at(b, 3) }, 5),
            BUTTON if b.len() >= 3 => match button_of(b[1]) {
                Some(button) => (Input::Button { button, down: b[2] != 0 }, 3),
                None => break,
            },
            WHEEL if b.len() >= 5 => (Input::Wheel { dx: i16_at(b, 1), dy: i16_at(b, 3) }, 5),
            KEY if b.len() >= 4 => (Input::Key { scan: u16_at(b, 1), down: b[3] != 0 }, 4),
            RELEASE_ALL => (Input::ReleaseAll, 1),
            _ => break,
        };
        out.push(e);
        b = &b[len..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /* These byte strings are the fixtures `test/cast.test.ts` copies. Change
       one here and the front's copy must change with it, in the same commit. */

    #[test]
    fn a_video_header_is_twenty_six_bytes_little_endian() {
        let h = VideoHeader {
            key: true,
            w: 2560,
            h: 1440,
            seq: 7,
            capture_us: 1_761_800_000_000_001,
            encoded_us: 1_761_800_000_004_321,
        };
        let msg = video(&h, &[0, 0, 0, 1, 0x67]);
        assert_eq!(
            &msg[..VIDEO_HEADER],
            &[
                0x01, 0x01, 0x00, 0x0a, 0xa0, 0x05, 0x07, 0x00, 0x00, 0x00, //
                0x01, 0x50, 0x2a, 0x07, 0x59, 0x42, 0x06, 0x00, //
                0xe1, 0x60, 0x2a, 0x07, 0x59, 0x42, 0x06, 0x00,
            ]
        );
        assert_eq!(read_video(&msg), Some((h, &[0u8, 0, 0, 1, 0x67][..])));
        assert!(is_keyframe(&msg));
    }

    #[test]
    fn a_delta_frame_is_not_a_keyframe_and_a_short_message_is_not_a_frame() {
        let h = VideoHeader { key: false, w: 1, h: 1, seq: 0, capture_us: 0, encoded_us: 0 };
        let msg = video(&h, &[]);
        assert!(!is_keyframe(&msg));
        assert_eq!(read_video(&msg[..VIDEO_HEADER - 1]), None);
    }

    #[test]
    fn cursor_messages_carry_their_shape_id() {
        let shape = cursor_shape(1, 1, 0, 0, 9, &[1, 2, 3, 4]);
        assert_eq!(shape, [0x02, 0, 1, 0, 1, 0, 0, 0, 0, 0, 9, 0, 0, 0, 1, 2, 3, 4]);
        assert_eq!(cursor_pos(true, -3, 1440, 9), [0x03, 1, 0xfd, 0xff, 0xa0, 0x05, 9, 0, 0, 0]);
    }

    #[test]
    fn input_events_round_trip_concatenated() {
        let events = [
            Input::MouseAbs { x: 0, y: 65535 },
            Input::MouseRel { dx: -5, dy: 300 },
            Input::Button { button: Button::Right, down: true },
            Input::Wheel { dx: 0, dy: -120 },
            Input::Key { scan: 0xE01D, down: false },
            Input::ReleaseAll,
        ];
        let mut msg = Vec::new();
        for e in &events {
            put_input(&mut msg, e);
        }
        assert_eq!(
            msg,
            [
                0x11, 0x00, 0x00, 0xff, 0xff, //
                0x12, 0xfb, 0xff, 0x2c, 0x01, //
                0x13, 0x01, 0x01, //
                0x14, 0x00, 0x00, 0x88, 0xff, //
                0x15, 0x1d, 0xe0, 0x00, //
                0x16,
            ]
        );
        assert_eq!(read_inputs(&msg), events);
    }

    #[test]
    fn a_truncated_or_unknown_event_ends_the_read_without_guessing() {
        let mut msg = Vec::new();
        put_input(&mut msg, &Input::Key { scan: 0x1e, down: true });
        put_input(&mut msg, &Input::Key { scan: 0x1e, down: false });
        assert_eq!(read_inputs(&msg[..6]), vec![Input::Key { scan: 0x1e, down: true }]);
        assert_eq!(read_inputs(&[0x13, 9, 1]), vec![]);
        assert_eq!(read_inputs(&[0x7f, 0x16]), vec![]);
    }
}
