//! AMQP 1.0's type system and framing, as bytes.
//!
//! The whole of OASIS AMQP 1.0 part 1 (types) and the frame header of part 2,
//! and nothing that knows what a link is. `conn.rs` builds on this; Event Hubs
//! is two layers further up. Kept apart so the encoding can be round-tripped in
//! a test with no peer at all, which is where a hand-rolled protocol is most
//! likely to be wrong and least likely to say so — a peer handed a malformed
//! frame simply closes the socket.
//!
//! **Every read is bounded by the buffer it is given.** The bytes come from a
//! server on the other side of a TLS-intercepting proxy, and a length prefix is
//! a claim about what follows, not a fact: a decoder that trusted one would
//! index past the end of a slice and panic on a reader thread. So every size is
//! checked before it is used, and nesting is capped (`MAX_DEPTH`) so a list of
//! lists of lists cannot walk the stack off the end.

use std::fmt;

/// One AMQP value. The encoding is chosen when it is written (`encode`), never
/// stored here, so two values that mean the same compare equal whichever of the
/// three widths of `uint` they arrived in.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Ubyte(u8),
    Ushort(u16),
    Uint(u32),
    Ulong(u64),
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    /// The decimal types, kept as their raw bytes: nothing here does arithmetic
    /// on one, and a reader that dropped them would desynchronise the stream.
    Decimal(Vec<u8>),
    Char(char),
    /// Milliseconds since the Unix epoch.
    Timestamp(i64),
    Uuid([u8; 16]),
    Binary(Vec<u8>),
    Str(String),
    Sym(String),
    List(Vec<Value>),
    /// Pairs in wire order. AMQP maps are ordered and may repeat a key, so this
    /// is not a `HashMap`.
    Map(Vec<(Value, Value)>),
    /// Homogeneous by the wire's rule; `encode` takes the first element's type.
    Array(Vec<Value>),
    Described(Box<Value>, Box<Value>),
}

impl Value {
    pub fn sym(s: &str) -> Value {
        Value::Sym(s.to_string())
    }
    pub fn str(s: &str) -> Value {
        Value::Str(s.to_string())
    }
    /// A described list — the shape of every performative and section.
    pub fn described(code: u64, fields: Vec<Value>) -> Value {
        Value::Described(Box::new(Value::Ulong(code)), Box::new(Value::List(trim(fields))))
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) | Value::Sym(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        match *self {
            Value::Ubyte(n) => Some(n as u64),
            Value::Ushort(n) => Some(n as u64),
            Value::Uint(n) => Some(n as u64),
            Value::Ulong(n) => Some(n),
            Value::Byte(n) if n >= 0 => Some(n as u64),
            Value::Short(n) if n >= 0 => Some(n as u64),
            Value::Int(n) if n >= 0 => Some(n as u64),
            Value::Long(n) if n >= 0 => Some(n as u64),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match *self {
            Value::Byte(n) => Some(n as i64),
            Value::Short(n) => Some(n as i64),
            Value::Int(n) => Some(n as i64),
            Value::Long(n) => Some(n),
            Value::Timestamp(n) => Some(n),
            Value::Ubyte(n) => Some(n as i64),
            Value::Ushort(n) => Some(n as i64),
            Value::Uint(n) => Some(n as i64),
            Value::Ulong(n) => i64::try_from(n).ok(),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match *self {
            Value::Bool(b) => Some(b),
            _ => None,
        }
    }
    /// The descriptor code of a described value, when it is a `ulong` — which
    /// every descriptor this crate meets is. A symbolic descriptor answers
    /// `None` and is matched by name where it matters.
    pub fn descriptor(&self) -> Option<u64> {
        match self {
            Value::Described(d, _) => d.as_u64(),
            _ => None,
        }
    }
    /// The fields of a described list, or of a bare list.
    pub fn fields(&self) -> &[Value] {
        match self {
            Value::Described(_, v) => v.fields(),
            Value::List(v) => v,
            _ => &[],
        }
    }
    /// One field by position, `Null` past the end — a list is allowed to stop
    /// early, and the fields it leaves off are null by the spec's rule.
    pub fn field(&self, i: usize) -> &Value {
        self.fields().get(i).unwrap_or(&Value::Null)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
    /// A map's value under a key spelled as either a string or a symbol —
    /// services are not consistent about which they use, and a lookup that
    /// cared would miss half of them.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(pairs) => pairs
                .iter()
                .find(|(k, _)| k.as_str() == Some(key))
                .map(|(_, v)| v),
            Value::Described(_, v) => v.get(key),
            _ => None,
        }
    }
}

/// Trailing nulls go: a list may end early and the spec reads the missing
/// fields as null, so the shorter encoding is the same value.
fn trim(mut fields: Vec<Value>) -> Vec<Value> {
    while matches!(fields.last(), Some(Value::Null)) {
        fields.pop();
    }
    fields
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecodeError(pub String);

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "amqp decode: {}", self.0)
    }
}

fn bad(what: impl Into<String>) -> DecodeError {
    DecodeError(what.into())
}

/// How deep values may nest before the decoder refuses. A performative is three
/// deep at most (attach → source → filter map → described filter); sixty-four is
/// generous for anything a broker sends and finite for anything hostile.
const MAX_DEPTH: usize = 64;

/// The most elements an array of zero-width values may claim.
const MAX_EMPTY_ELEMENTS: usize = 1 << 16;

/* ── encoding ───────────────────────────────────────────────────────────── */

pub fn encode(v: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    put(&mut out, v);
    out
}

pub fn put(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => out.push(0x40),
        Value::Bool(true) => out.push(0x41),
        Value::Bool(false) => out.push(0x42),
        Value::Ubyte(n) => {
            out.push(0x50);
            out.push(*n);
        }
        Value::Ushort(n) => {
            out.push(0x60);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Uint(0) => out.push(0x43),
        Value::Uint(n) if *n < 256 => {
            out.push(0x52);
            out.push(*n as u8);
        }
        Value::Uint(n) => {
            out.push(0x70);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Ulong(0) => out.push(0x44),
        Value::Ulong(n) if *n < 256 => {
            out.push(0x53);
            out.push(*n as u8);
        }
        Value::Ulong(n) => {
            out.push(0x80);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Byte(n) => {
            out.push(0x51);
            out.push(*n as u8);
        }
        Value::Short(n) => {
            out.push(0x61);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Int(n) if (-128..=127).contains(n) => {
            out.push(0x54);
            out.push(*n as i8 as u8);
        }
        Value::Int(n) => {
            out.push(0x71);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Long(n) if (-128..=127).contains(n) => {
            out.push(0x55);
            out.push(*n as i8 as u8);
        }
        Value::Long(n) => {
            out.push(0x81);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Float(f) => {
            out.push(0x72);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        Value::Double(f) => {
            out.push(0x82);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
        Value::Decimal(b) => {
            out.push(match b.len() {
                4 => 0x74,
                8 => 0x84,
                _ => 0x94,
            });
            let mut b = b.clone();
            b.resize(match b.len() {
                4 => 4,
                8 => 8,
                _ => 16,
            }, 0);
            out.extend_from_slice(&b);
        }
        Value::Char(c) => {
            out.push(0x73);
            out.extend_from_slice(&(*c as u32).to_be_bytes());
        }
        Value::Timestamp(t) => {
            out.push(0x83);
            out.extend_from_slice(&t.to_be_bytes());
        }
        Value::Uuid(u) => {
            out.push(0x98);
            out.extend_from_slice(u);
        }
        Value::Binary(b) => variable(out, 0xa0, 0xb0, b),
        Value::Str(s) => variable(out, 0xa1, 0xb1, s.as_bytes()),
        Value::Sym(s) => variable(out, 0xa3, 0xb3, s.as_bytes()),
        Value::List(items) if items.is_empty() => out.push(0x45),
        Value::List(items) => {
            let mut body = Vec::new();
            for it in items {
                put(&mut body, it);
            }
            compound(out, 0xc0, 0xd0, items.len(), &body);
        }
        Value::Map(pairs) => {
            let mut body = Vec::new();
            for (k, v) in pairs {
                put(&mut body, k);
                put(&mut body, v);
            }
            compound(out, 0xc1, 0xd1, pairs.len() * 2, &body);
        }
        Value::Array(items) => array(out, items),
        Value::Described(d, v) => {
            out.push(0x00);
            put(out, d);
            put(out, v);
        }
    }
}

fn variable(out: &mut Vec<u8>, short: u8, long: u8, bytes: &[u8]) {
    if bytes.len() < 256 {
        out.push(short);
        out.push(bytes.len() as u8);
    } else {
        out.push(long);
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

/// A list or a map: size counts the count field and everything after it.
fn compound(out: &mut Vec<u8>, short: u8, long: u8, count: usize, body: &[u8]) {
    if body.len() + 1 < 256 && count < 256 {
        out.push(short);
        out.push((body.len() + 1) as u8);
        out.push(count as u8);
    } else {
        out.push(long);
        out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
        out.extend_from_slice(&(count as u32).to_be_bytes());
    }
    out.extend_from_slice(body);
}

/// An array is one constructor and then bare values. Written always in the
/// 32-bit form with the fixed-width constructor of its first element's type,
/// which is the one shape every reader must accept; nothing sent here is large
/// enough for the compact forms to be worth a second code path.
fn array(out: &mut Vec<u8>, items: &[Value]) {
    let mut body = Vec::new();
    match items.first() {
        None => body.push(0x40),
        Some(first) => {
            let code = wide_code(first);
            body.push(code);
            for it in items {
                element(&mut body, code, it);
            }
        }
    }
    out.push(0xf0);
    out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    out.extend_from_slice(&(items.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
}

fn wide_code(v: &Value) -> u8 {
    match v {
        Value::Bool(_) => 0x56,
        Value::Ubyte(_) => 0x50,
        Value::Ushort(_) => 0x60,
        Value::Uint(_) => 0x70,
        Value::Ulong(_) => 0x80,
        Value::Byte(_) => 0x51,
        Value::Short(_) => 0x61,
        Value::Int(_) => 0x71,
        Value::Long(_) => 0x81,
        Value::Float(_) => 0x72,
        Value::Double(_) => 0x82,
        Value::Char(_) => 0x73,
        Value::Timestamp(_) => 0x83,
        Value::Uuid(_) => 0x98,
        Value::Binary(_) => 0xb0,
        Value::Str(_) => 0xb1,
        Value::Sym(_) => 0xb3,
        Value::List(_) => 0xd0,
        Value::Map(_) => 0xd1,
        Value::Array(_) => 0xf0,
        _ => 0x40,
    }
}

/// A value without its constructor, in the width `code` names.
fn element(out: &mut Vec<u8>, code: u8, v: &Value) {
    let mut full = Vec::new();
    match (code, v) {
        (0x56, Value::Bool(b)) => {
            out.push(u8::from(*b));
            return;
        }
        (0x70, Value::Uint(n)) => {
            out.extend_from_slice(&n.to_be_bytes());
            return;
        }
        (0x80, Value::Ulong(n)) => {
            out.extend_from_slice(&n.to_be_bytes());
            return;
        }
        (0x71, Value::Int(n)) => {
            out.extend_from_slice(&n.to_be_bytes());
            return;
        }
        (0x81, Value::Long(n)) => {
            out.extend_from_slice(&n.to_be_bytes());
            return;
        }
        (0xb0, Value::Binary(b)) => {
            out.extend_from_slice(&(b.len() as u32).to_be_bytes());
            out.extend_from_slice(b);
            return;
        }
        (0xb1, Value::Str(s)) | (0xb3, Value::Sym(s)) => {
            out.extend_from_slice(&(s.len() as u32).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
            return;
        }
        (0xd0, Value::List(items)) => {
            let mut body = Vec::new();
            for it in items {
                put(&mut body, it);
            }
            out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
            out.extend_from_slice(&(items.len() as u32).to_be_bytes());
            out.extend_from_slice(&body);
            return;
        }
        (0xd1, Value::Map(pairs)) => {
            let mut body = Vec::new();
            for (k, v) in pairs {
                put(&mut body, k);
                put(&mut body, v);
            }
            out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
            out.extend_from_slice(&((pairs.len() * 2) as u32).to_be_bytes());
            out.extend_from_slice(&body);
            return;
        }
        _ => {}
    }
    /* Every other fixed-width type: its ordinary encoding is the wide
       constructor followed by the bytes, so write that and drop the byte. */
    put(&mut full, v);
    if full.first() == Some(&code) {
        out.extend_from_slice(&full[1..]);
    }
}

/* ── decoding ───────────────────────────────────────────────────────────── */

pub struct Reader<'a> {
    buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    pub fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|e| *e <= self.buf.len())
            .ok_or_else(|| bad(format!("{n} bytes wanted at {} of {}", self.pos, self.buf.len())))?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, DecodeError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub fn value(&mut self) -> Result<Value, DecodeError> {
        self.value_at(0)
    }

    fn value_at(&mut self, depth: usize) -> Result<Value, DecodeError> {
        if depth > MAX_DEPTH {
            return Err(bad("nested too deep"));
        }
        let code = self.u8()?;
        if code == 0x00 {
            let d = self.value_at(depth + 1)?;
            let v = self.value_at(depth + 1)?;
            return Ok(Value::Described(Box::new(d), Box::new(v)));
        }
        self.body(code, depth)
    }

    /// The value a constructor introduces. Shared by plain values and array
    /// elements, which is where the one subtle part of AMQP's encoding lives.
    fn body(&mut self, code: u8, depth: usize) -> Result<Value, DecodeError> {
        Ok(match code {
            0x40 => Value::Null,
            0x41 => Value::Bool(true),
            0x42 => Value::Bool(false),
            0x56 => Value::Bool(self.u8()? != 0),
            0x50 => Value::Ubyte(self.u8()?),
            0x60 => Value::Ushort(self.u16()?),
            0x70 => Value::Uint(self.u32()?),
            0x52 => Value::Uint(self.u8()? as u32),
            0x43 => Value::Uint(0),
            0x80 => Value::Ulong(self.u64()?),
            0x53 => Value::Ulong(self.u8()? as u64),
            0x44 => Value::Ulong(0),
            0x51 => Value::Byte(self.u8()? as i8),
            0x61 => Value::Short(self.u16()? as i16),
            0x71 => Value::Int(self.u32()? as i32),
            0x54 => Value::Int(self.u8()? as i8 as i32),
            0x81 => Value::Long(self.u64()? as i64),
            0x55 => Value::Long(self.u8()? as i8 as i64),
            0x72 => Value::Float(f32::from_bits(self.u32()?)),
            0x82 => Value::Double(f64::from_bits(self.u64()?)),
            0x74 => Value::Decimal(self.take(4)?.to_vec()),
            0x84 => Value::Decimal(self.take(8)?.to_vec()),
            0x94 => Value::Decimal(self.take(16)?.to_vec()),
            0x73 => Value::Char(char::from_u32(self.u32()?).unwrap_or('\u{fffd}')),
            0x83 => Value::Timestamp(self.u64()? as i64),
            0x98 => Value::Uuid(self.take(16)?.try_into().unwrap()),
            0xa0 => {
                let n = self.u8()? as usize;
                Value::Binary(self.take(n)?.to_vec())
            }
            0xb0 => {
                let n = self.u32()? as usize;
                Value::Binary(self.take(n)?.to_vec())
            }
            0xa1 | 0xa3 | 0xb1 | 0xb3 => {
                let n = if code & 0xf0 == 0xa0 { self.u8()? as usize } else { self.u32()? as usize };
                let s = String::from_utf8_lossy(self.take(n)?).into_owned();
                if code & 0x0f == 0x01 {
                    Value::Str(s)
                } else {
                    Value::Sym(s)
                }
            }
            0x45 => Value::List(Vec::new()),
            0xc0 | 0xd0 | 0xc1 | 0xd1 => {
                let wide = code & 0xf0 == 0xd0;
                let (size, count) = if wide {
                    (self.u32()? as usize, self.u32()? as usize)
                } else {
                    (self.u8()? as usize, self.u8()? as usize)
                };
                let counted = if wide { 4 } else { 1 };
                let body_len = size
                    .checked_sub(counted)
                    .ok_or_else(|| bad("compound size smaller than its count"))?;
                let body = self.take(body_len)?;
                let mut inner = Reader::new(body);
                let mut items = Vec::with_capacity(count.min(body.len()));
                for _ in 0..count {
                    items.push(inner.value_at(depth + 1)?);
                }
                if code & 0x0f == 0x00 {
                    Value::List(items)
                } else {
                    if items.len() % 2 != 0 {
                        return Err(bad("map with an odd number of elements"));
                    }
                    let mut pairs = Vec::with_capacity(items.len() / 2);
                    let mut it = items.into_iter();
                    while let (Some(k), Some(v)) = (it.next(), it.next()) {
                        pairs.push((k, v));
                    }
                    Value::Map(pairs)
                }
            }
            0xe0 | 0xf0 => {
                let wide = code == 0xf0;
                let (size, count) = if wide {
                    (self.u32()? as usize, self.u32()? as usize)
                } else {
                    (self.u8()? as usize, self.u8()? as usize)
                };
                let counted = if wide { 4 } else { 1 };
                let body_len = size
                    .checked_sub(counted)
                    .ok_or_else(|| bad("array size smaller than its count"))?;
                let body = self.take(body_len)?;
                let mut inner = Reader::new(body);
                /* An element constructor may itself be described — one
                   descriptor for the whole array — and then the code after it. */
                let mut descriptor = None;
                let mut ecode = inner.u8()?;
                if ecode == 0x00 {
                    descriptor = Some(inner.value_at(depth + 1)?);
                    ecode = inner.u8()?;
                }
                /* Every element costs at least a byte except the six
                   constructors that are the whole value. A count of four
                   billion of those in a thirteen-byte header is a request to
                   allocate until the process dies, and a producer on the stream
                   chooses these bytes. */
                if matches!(ecode, 0x40..=0x45) && count > MAX_EMPTY_ELEMENTS {
                    return Err(bad(format!("an array of {count} empty elements")));
                }
                let mut items = Vec::with_capacity(count.min(body.len()));
                for _ in 0..count {
                    let v = inner.body(ecode, depth + 1)?;
                    items.push(match &descriptor {
                        Some(d) => Value::Described(Box::new(d.clone()), Box::new(v)),
                        None => v,
                    });
                }
                Value::Array(items)
            }
            other => return Err(bad(format!("unknown constructor 0x{other:02x}"))),
        })
    }
}

pub fn decode(buf: &[u8]) -> Result<Value, DecodeError> {
    Reader::new(buf).value()
}

/* ── frames ─────────────────────────────────────────────────────────────── */

/// The two frame types this peer speaks.
pub const AMQP_FRAME: u8 = 0x00;
pub const SASL_FRAME: u8 = 0x01;

/// The protocol headers, sent before anything else in each layer.
pub const SASL_HEADER: [u8; 8] = *b"AMQP\x03\x01\x00\x00";
pub const AMQP_HEADER: [u8; 8] = *b"AMQP\x00\x01\x00\x00";

/// One frame off the wire. `body` empty is a heartbeat.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub kind: u8,
    pub channel: u16,
    pub body: Vec<u8>,
}

impl Frame {
    /// The performative and whatever payload follows it (a transfer's message
    /// bytes). `None` for a heartbeat.
    pub fn split(&self) -> Result<Option<(Value, &[u8])>, DecodeError> {
        if self.body.is_empty() {
            return Ok(None);
        }
        let mut r = Reader::new(&self.body);
        let perf = r.value()?;
        Ok(Some((perf, &self.body[r.pos..])))
    }
}

pub fn frame(kind: u8, channel: u16, performative: Option<&Value>, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    if let Some(p) = performative {
        put(&mut body, p);
    }
    body.extend_from_slice(payload);
    let size = (8 + body.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.push(2); // doff, in four-byte words: no extended header
    out.push(kind);
    out.extend_from_slice(&channel.to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// Take one whole frame off the front of `buf`, or `Ok(None)` if it is not all
/// here yet. The caller keeps the remainder.
///
/// `max` is the largest frame this side agreed to take; a header claiming more
/// is a peer that has lost the stream, and reading on would mean buffering
/// whatever it chose to claim.
pub fn take_frame(buf: &mut Vec<u8>, max: usize) -> Result<Option<Frame>, DecodeError> {
    if buf.len() < 8 {
        return Ok(None);
    }
    let size = u32::from_be_bytes(buf[0..4].try_into().unwrap()) as usize;
    let doff = buf[4] as usize * 4;
    if size < 8 || doff < 8 || doff > size {
        return Err(bad(format!("frame header size {size} doff {doff}")));
    }
    if size > max {
        return Err(bad(format!("frame of {size} bytes over the agreed {max}")));
    }
    if buf.len() < size {
        return Ok(None);
    }
    let kind = buf[5];
    let channel = u16::from_be_bytes(buf[6..8].try_into().unwrap());
    let body = buf[doff..size].to_vec();
    buf.drain(..size);
    Ok(Some(Frame { kind, channel, body }))
}

/* ── performative codes (part 2) ────────────────────────────────────────── */

pub const OPEN: u64 = 0x10;
pub const BEGIN: u64 = 0x11;
pub const ATTACH: u64 = 0x12;
pub const FLOW: u64 = 0x13;
pub const TRANSFER: u64 = 0x14;
pub const DISPOSITION: u64 = 0x15;
pub const DETACH: u64 = 0x16;
pub const END: u64 = 0x17;
pub const CLOSE: u64 = 0x18;
pub const ERROR: u64 = 0x1d;
pub const SOURCE: u64 = 0x28;
pub const TARGET: u64 = 0x29;
pub const ACCEPTED: u64 = 0x24;

pub const SASL_MECHANISMS: u64 = 0x40;
pub const SASL_INIT: u64 = 0x41;
pub const SASL_OUTCOME: u64 = 0x44;

/* ── messages (part 3) ──────────────────────────────────────────────────── */

const HEADER: u64 = 0x70;
const DELIVERY_ANNOTATIONS: u64 = 0x71;
const MESSAGE_ANNOTATIONS: u64 = 0x72;
const PROPERTIES: u64 = 0x73;
const APPLICATION_PROPERTIES: u64 = 0x74;
const DATA: u64 = 0x75;
const AMQP_SEQUENCE: u64 = 0x76;
const AMQP_VALUE: u64 = 0x77;
const FOOTER: u64 = 0x78;

/// A message, as much of it as anything here reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Message {
    /// The properties section's fields by position — `message-id` is 0,
    /// `reply-to` 4, `correlation-id` 5.
    pub properties: Vec<Value>,
    /// Message annotations: where Event Hubs puts the sequence number, offset
    /// and enqueued time.
    pub annotations: Vec<(Value, Value)>,
    pub application: Vec<(Value, Value)>,
    /// Every data section, concatenated — the spec's own reading of several.
    pub data: Option<Vec<u8>>,
    /// An amqp-value body.
    pub value: Option<Value>,
}

impl Message {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.properties.is_empty() {
            put(&mut out, &Value::described(PROPERTIES, self.properties.clone()));
        }
        if !self.annotations.is_empty() {
            put(
                &mut out,
                &Value::Described(
                    Box::new(Value::Ulong(MESSAGE_ANNOTATIONS)),
                    Box::new(Value::Map(self.annotations.clone())),
                ),
            );
        }
        if !self.application.is_empty() {
            put(
                &mut out,
                &Value::Described(
                    Box::new(Value::Ulong(APPLICATION_PROPERTIES)),
                    Box::new(Value::Map(self.application.clone())),
                ),
            );
        }
        if let Some(d) = &self.data {
            put(
                &mut out,
                &Value::Described(Box::new(Value::Ulong(DATA)), Box::new(Value::Binary(d.clone()))),
            );
        }
        if let Some(v) = &self.value {
            put(&mut out, &Value::Described(Box::new(Value::Ulong(AMQP_VALUE)), Box::new(v.clone())));
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Message, DecodeError> {
        let mut r = Reader::new(bytes);
        let mut m = Message::default();
        while !r.done() {
            let section = r.value()?;
            let Value::Described(d, v) = section else {
                return Err(bad("a message section that is not described"));
            };
            match d.as_u64() {
                Some(PROPERTIES) => m.properties = v.fields().to_vec(),
                Some(MESSAGE_ANNOTATIONS) => {
                    if let Value::Map(p) = *v {
                        m.annotations = p;
                    }
                }
                Some(APPLICATION_PROPERTIES) => {
                    if let Value::Map(p) = *v {
                        m.application = p;
                    }
                }
                Some(DATA) => {
                    if let Value::Binary(b) = *v {
                        m.data.get_or_insert_with(Vec::new).extend_from_slice(&b);
                    }
                }
                Some(AMQP_VALUE) => m.value = Some(*v),
                /* Read and set aside: a sequence body is not something an
                   event stream here sends, and the header, delivery
                   annotations and footer carry nothing this reader uses. */
                Some(HEADER | DELIVERY_ANNOTATIONS | AMQP_SEQUENCE | FOOTER) => {}
                _ => {}
            }
        }
        Ok(m)
    }

    pub fn annotation(&self, key: &str) -> Option<&Value> {
        self.annotations.iter().find(|(k, _)| k.as_str() == Some(key)).map(|(_, v)| v)
    }
    pub fn app(&self, key: &str) -> Option<&Value> {
        self.application.iter().find(|(k, _)| k.as_str() == Some(key)).map(|(_, v)| v)
    }
    pub fn property(&self, i: usize) -> &Value {
        self.properties.get(i).unwrap_or(&Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(v: Value) {
        let bytes = encode(&v);
        assert_eq!(decode(&bytes).unwrap(), v, "{bytes:02x?}");
    }

    #[test]
    fn every_scalar_comes_back_as_itself() {
        for v in [
            Value::Null,
            Value::Bool(true),
            Value::Bool(false),
            Value::Ubyte(7),
            Value::Ushort(65_000),
            Value::Uint(0),
            Value::Uint(200),
            Value::Uint(70_000),
            Value::Ulong(0),
            Value::Ulong(255),
            Value::Ulong(u64::MAX),
            Value::Byte(-3),
            Value::Short(-300),
            Value::Int(-5),
            Value::Int(1 << 20),
            Value::Long(-1),
            Value::Long(i64::MIN),
            Value::Double(1.5),
            Value::Float(-2.25),
            Value::Char('é'),
            Value::Timestamp(1_787_000_000_123),
            Value::Uuid([9; 16]),
            Value::Binary(vec![1, 2, 3]),
            Value::Binary(vec![0xab; 300]),
            Value::str("hé"),
            Value::Str("x".repeat(400)),
            Value::sym("apache.org:selector-filter:string"),
        ] {
            round(v);
        }
    }

    #[test]
    fn compounds_nest_and_keep_their_order() {
        round(Value::List(vec![]));
        round(Value::List(vec![Value::Uint(1), Value::str("a"), Value::Null]));
        round(Value::Map(vec![
            (Value::sym("b"), Value::Long(2)),
            (Value::sym("a"), Value::List(vec![Value::Bool(true)])),
        ]));
        /* Big enough to need the 32-bit forms. */
        round(Value::List((0..300).map(|i| Value::Uint(i)).collect()));
        round(Value::described(
            ATTACH,
            vec![Value::str("link"), Value::Uint(0), Value::Bool(true)],
        ));
    }

    #[test]
    fn arrays_round_trip_including_symbols() {
        round(Value::Array(vec![Value::sym("ANONYMOUS"), Value::sym("PLAIN")]));
        round(Value::Array(vec![Value::str("0"), Value::str("1"), Value::str("2")]));
        round(Value::Array(vec![Value::Long(3), Value::Long(-4)]));
        round(Value::Array(vec![Value::Bool(true), Value::Bool(false)]));
        round(Value::Array(vec![]));
    }

    /// A broker's array in the compact form, which `encode` never writes and a
    /// reader must take — the `sasl-server-mechanisms` a peer sends is one.
    #[test]
    fn a_compact_array_is_read() {
        // array8: size, count, constructor sym8, then two sym8 bodies.
        let bytes = [0xe0, 0x0d, 0x02, 0xa3, 0x05, b'P', b'L', b'A', b'I', b'N', 0x04, b'X', b'Y', b'Z', b'W'];
        let v = Reader::new(&bytes).value().unwrap();
        assert_eq!(v, Value::Array(vec![Value::sym("PLAIN"), Value::sym("XYZW")]), "{v:?}");
    }

    #[test]
    fn trailing_nulls_are_left_off_a_described_list() {
        let v = Value::described(FLOW, vec![Value::Uint(1), Value::Null, Value::Null]);
        assert_eq!(v.fields().len(), 1);
        assert!(v.field(5).is_null(), "a field past the end reads as null");
    }

    #[test]
    fn a_lying_length_is_an_error_not_a_panic() {
        for bytes in [
            vec![0xb1, 0xff, 0xff, 0xff, 0xff, b'a'],
            vec![0xc0, 0x05, 0x09],
            vec![0xd0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x09],
            vec![0xc1, 0x02, 0x01, 0x40],
            vec![0x00],
            vec![0xff],
            vec![],
        ] {
            assert!(decode(&bytes).is_err(), "{bytes:02x?}");
        }
        /* An array of four billion nulls in thirteen bytes. */
        assert!(decode(&[0xf0, 0, 0, 0, 5, 0xff, 0xff, 0xff, 0xff, 0x40]).is_err());
        /* And a nesting bomb is refused rather than recursed into. */
        let mut bomb = Vec::new();
        for _ in 0..200 {
            bomb.push(0x00);
        }
        assert!(decode(&bomb).is_err());
    }

    #[test]
    fn a_frame_is_taken_only_when_all_of_it_is_here() {
        let perf = Value::described(BEGIN, vec![Value::Null, Value::Uint(0)]);
        let bytes = frame(AMQP_FRAME, 3, Some(&perf), b"tail");
        let mut buf = bytes[..bytes.len() - 1].to_vec();
        assert_eq!(take_frame(&mut buf, 1 << 20).unwrap(), None);
        buf.push(*bytes.last().unwrap());
        buf.extend_from_slice(&frame(AMQP_FRAME, 0, None, &[]));
        let f = take_frame(&mut buf, 1 << 20).unwrap().unwrap();
        assert_eq!(f.channel, 3);
        let (p, rest) = f.split().unwrap().unwrap();
        assert_eq!(p.descriptor(), Some(BEGIN));
        assert_eq!(rest, b"tail");
        /* The heartbeat behind it. */
        let hb = take_frame(&mut buf, 1 << 20).unwrap().unwrap();
        assert!(hb.body.is_empty() && hb.split().unwrap().is_none());
        assert!(buf.is_empty());
    }

    #[test]
    fn an_oversized_frame_is_refused() {
        let mut buf = frame(AMQP_FRAME, 0, None, &[0; 64]);
        assert!(take_frame(&mut buf, 32).is_err());
        let mut bad = vec![0, 0, 0, 4, 2, 0, 0, 0];
        assert!(take_frame(&mut bad, 1 << 20).is_err());
    }

    #[test]
    fn a_message_round_trips_its_sections() {
        let m = Message {
            properties: vec![Value::str("id-1"), Value::Null, Value::Null, Value::Null, Value::str("reply")],
            annotations: vec![
                (Value::sym("x-opt-sequence-number"), Value::Long(42)),
                (Value::sym("x-opt-enqueued-time"), Value::Timestamp(1_000)),
            ],
            application: vec![(Value::str("channel"), Value::str("ui"))],
            data: Some(br#"{"v":1}"#.to_vec()),
            value: None,
        };
        let back = Message::decode(&m.encode()).unwrap();
        assert_eq!(back.annotation("x-opt-sequence-number"), Some(&Value::Long(42)));
        assert_eq!(back.app("channel").and_then(Value::as_str), Some("ui"));
        assert_eq!(back.property(4).as_str(), Some("reply"));
        assert_eq!(back.data.as_deref(), Some(&br#"{"v":1}"#[..]));
    }
}
