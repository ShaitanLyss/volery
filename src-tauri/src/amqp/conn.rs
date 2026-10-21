//! One AMQP 1.0 connection with one session on it, as a client.
//!
//! Generic over `Read + Write`, and that is the whole of why it is a module of
//! its own: the real stream is a WebSocket over rustls over TCP through a
//! corporate proxy, and nothing about any of those is something a test can
//! stand up. So the state machine — SASL, open, begin, attach, credit, transfer,
//! detach — is driven here against a fake peer on an in-memory pipe
//! (`tests::Peer`), and the only thing the real stream adds is bytes.
//!
//! **Small on purpose.** One session (Event Hubs uses exactly one per
//! connection anyway — the protocol guide says so), no link recovery (the
//! service does not support it), no transactions. What it does have is the
//! three things a receiver that stays up for days cannot do without:
//!
//! - **Heartbeats in both directions.** The peer states an idle timeout in its
//!   `open`; staying silent for that long gets the connection dropped. So an
//!   empty frame goes out at half of it. And this side states one too
//!   (`Opts::idle`), which makes the peer talk at least that often — so a
//!   connection that has died under a sleeping laptop is *noticed*, at twice our
//!   own timeout, rather than read from for ever.
//! - **Credit replenished as it is spent**, so a receiver never stalls with the
//!   broker holding events it is not allowed to send.
//! - **Events that arrive during a request are kept**, not dropped — a token
//!   renewal on `$cbs` happens while partition receivers are live, and a message
//!   that came in between the request and its reply is still a message.
//!
//! The read side never blocks past a deadline: the stream is expected to time
//! out its reads (the socket's read timeout; the test pipe's own), and every
//! loop here comes back to look at the clock when it does. A partly received
//! frame survives a timeout because the buffer here, not the stream, owns it.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use super::codec::{self, Frame, Message, Value};

/// What a session's windows are opened at. Event Hubs resets them through link
/// flow anyway; this only has to be large enough that a burst of small events
/// never waits on a window update.
const WINDOW: u32 = 5_000;

/// The largest frame this side will take. A megabyte is Event Hubs' own maximum
/// and a single event can be that large.
const MAX_FRAME: u32 = 1 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct AmqpError {
    pub condition: String,
    pub description: String,
}

impl AmqpError {
    fn from(v: &Value) -> Option<AmqpError> {
        if v.descriptor() != Some(codec::ERROR) {
            return None;
        }
        Some(AmqpError {
            condition: v.field(0).as_str().unwrap_or("").to_string(),
            description: v.field(1).as_str().unwrap_or("").to_string(),
        })
    }
}

impl std::fmt::Display for AmqpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.description.is_empty() {
            write!(f, "{}", self.condition)
        } else {
            write!(f, "{}: {}", self.condition, self.description)
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Decode(codec::DecodeError),
    /// The peer closed the connection or ended the session, with its reason.
    Closed(Option<AmqpError>),
    /// The peer refused a link — attached with no source or target and
    /// detached it, which is how a broker says "no such entity" or "not
    /// authorised for it".
    Refused(Option<AmqpError>),
    Protocol(String),
    /// A deadline this side set passed while waiting for `what`.
    Timeout(&'static str),
    /// Nothing at all from the peer for twice our idle timeout: the connection
    /// is dead without having been closed, which is what a laptop's sleep does
    /// to a TCP connection.
    Quiet,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "connection failed: {e}"),
            Error::Decode(e) => write!(f, "{e}"),
            Error::Closed(Some(e)) => write!(f, "the service closed the connection — {e}"),
            Error::Closed(None) => write!(f, "the service closed the connection"),
            Error::Refused(Some(e)) => write!(f, "the service refused the link — {e}"),
            Error::Refused(None) => write!(f, "the service refused the link"),
            Error::Protocol(s) => write!(f, "protocol: {s}"),
            Error::Timeout(what) => write!(f, "timed out waiting for {what}"),
            Error::Quiet => write!(f, "the connection went quiet and is presumed dead"),
        }
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<codec::DecodeError> for Error {
    fn from(e: codec::DecodeError) -> Self {
        Error::Decode(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// What happened on a link.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Message { handle: u32, message: Message },
    /// The peer detached a link — `error` says why, if it said.
    Detached { handle: u32, error: Option<AmqpError> },
}

pub struct Opts {
    pub container_id: String,
    pub hostname: String,
    /// The idle timeout this side states. The peer must be heard from at least
    /// this often, and twice it with nothing is `Error::Quiet`.
    pub idle: Duration,
    /// How long the handshake may take, end to end.
    pub patience: Duration,
}

struct Link {
    name: String,
    receiver: bool,
    /// The peer's handle, once its attach has come back.
    remote: Option<u32>,
    /// Whether its attach came back with the terminus present. Null means the
    /// peer is about to detach it with the reason.
    accepted: bool,
    /// A sender's credit as the peer last granted it; a receiver's as we did.
    credit: u32,
    delivery_count: u32,
    /// What a receiver tops itself back up to.
    grant: u32,
    /// A multi-frame transfer being assembled.
    partial: Option<(Vec<u8>, Option<u32>, bool)>,
}

pub struct Conn<S: Read + Write> {
    io: S,
    rbuf: Vec<u8>,
    max_out: usize,
    peer_idle: Option<Duration>,
    idle: Duration,
    last_sent: Instant,
    last_heard: Instant,
    next_outgoing_id: u32,
    next_incoming_id: u32,
    incoming_window: u32,
    remote_incoming_window: u32,
    links: HashMap<u32, Link>,
    by_remote: HashMap<u32, u32>,
    next_handle: u32,
    next_delivery_id: u32,
    pending: VecDeque<Event>,
}

impl<S: Read + Write> Conn<S> {
    /// SASL ANONYMOUS, then `open` and `begin`. ANONYMOUS because Event Hubs
    /// takes its authorisation over CBS afterwards (`$cbs` `put-token`) and
    /// allows nothing else on the connection until that has happened — the
    /// protocol guide's 20-second window.
    pub fn connect(io: S, opts: &Opts) -> Result<Conn<S>> {
        let now = Instant::now();
        let mut c = Conn {
            io,
            rbuf: Vec::new(),
            max_out: 512,
            peer_idle: None,
            idle: opts.idle,
            last_sent: now,
            last_heard: now,
            next_outgoing_id: 0,
            next_incoming_id: 0,
            incoming_window: WINDOW,
            remote_incoming_window: 0,
            links: HashMap::new(),
            by_remote: HashMap::new(),
            next_handle: 0,
            next_delivery_id: 0,
            pending: VecDeque::new(),
        };
        let deadline = now + opts.patience;

        c.write_raw(&codec::SASL_HEADER)?;
        c.expect_header(&codec::SASL_HEADER, deadline)?;
        let mechs = c.sasl_frame(deadline)?;
        if mechs.descriptor() != Some(codec::SASL_MECHANISMS) {
            return Err(Error::Protocol("expected sasl-mechanisms".into()));
        }
        let offered = match mechs.field(0) {
            Value::Array(a) => a.iter().filter_map(|m| m.as_str().map(str::to_string)).collect(),
            v => v.as_str().map(|s| vec![s.to_string()]).unwrap_or_default(),
        };
        if !offered.iter().any(|m: &String| m == "ANONYMOUS") {
            return Err(Error::Protocol(format!("the service offers no ANONYMOUS ({offered:?})")));
        }
        let init = Value::described(
            codec::SASL_INIT,
            vec![Value::sym("ANONYMOUS"), Value::Binary(Vec::new()), Value::str(&opts.hostname)],
        );
        c.write_raw(&codec::frame(codec::SASL_FRAME, 0, Some(&init), &[]))?;
        let outcome = c.sasl_frame(deadline)?;
        if outcome.descriptor() != Some(codec::SASL_OUTCOME) {
            return Err(Error::Protocol("expected sasl-outcome".into()));
        }
        if outcome.field(0).as_u64() != Some(0) {
            return Err(Error::Protocol(format!("sasl refused, code {:?}", outcome.field(0))));
        }

        c.write_raw(&codec::AMQP_HEADER)?;
        c.expect_header(&codec::AMQP_HEADER, deadline)?;
        let open = Value::described(
            codec::OPEN,
            vec![
                Value::str(&opts.container_id),
                Value::str(&opts.hostname),
                Value::Uint(MAX_FRAME),
                Value::Ushort(0),
                Value::Uint(opts.idle.as_millis().min(u32::MAX as u128) as u32),
            ],
        );
        c.send_perf(&open, &[])?;
        let theirs = c.performative(deadline, "the service's open")?;
        match theirs.descriptor() {
            Some(codec::OPEN) => {}
            Some(codec::CLOSE) => return Err(Error::Closed(AmqpError::from(theirs.field(0)))),
            _ => return Err(Error::Protocol("expected open".into())),
        }
        c.max_out = theirs.field(2).as_u64().map(|n| n as usize).unwrap_or(u32::MAX as usize).max(512);
        c.peer_idle = theirs
            .field(4)
            .as_u64()
            .filter(|ms| *ms > 0)
            .map(Duration::from_millis);

        let begin = Value::described(
            codec::BEGIN,
            vec![
                Value::Null,
                Value::Uint(0),
                Value::Uint(WINDOW),
                Value::Uint(WINDOW),
                Value::Uint(u32::MAX),
            ],
        );
        c.send_perf(&begin, &[])?;
        let theirs = c.performative(deadline, "the service's begin")?;
        match theirs.descriptor() {
            Some(codec::BEGIN) => {}
            Some(codec::CLOSE) => return Err(Error::Closed(AmqpError::from(theirs.field(0)))),
            _ => return Err(Error::Protocol("expected begin".into())),
        }
        c.next_incoming_id = theirs.field(1).as_u64().unwrap_or(0) as u32;
        c.remote_incoming_window = theirs.field(2).as_u64().unwrap_or(0) as u32;
        Ok(c)
    }

    /* ── links ──────────────────────────────────────────────────────────── */

    /// Attach a link this side receives on, grant it `credit`, and wait for the
    /// peer to attach its end. A refusal comes back as `Error::Refused` with the
    /// broker's own reason.
    pub fn attach_receiver(
        &mut self,
        name: &str,
        source: Value,
        target: &str,
        properties: Option<Value>,
        credit: u32,
        deadline: Instant,
    ) -> Result<u32> {
        let handle = self.new_link(name, true, credit);
        let mut fields = vec![
            Value::str(name),
            Value::Uint(handle),
            Value::Bool(true),
            /* snd-settle-mode settled: Event Hubs then sends every delivery
               pre-settled, which is what .NET asks for; the checkpoint here is
               ours, not the broker's, so its settlement carries nothing. An
               unsettled one is still answered, below. */
            Value::Ubyte(1),
            Value::Ubyte(0), // rcv-settle-mode first
            source,
            Value::described(codec::TARGET, vec![Value::str(target)]),
        ];
        if let Some(p) = properties {
            fields.extend([Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, p]);
        }
        self.send_perf(&Value::described(codec::ATTACH, fields), &[])?;
        self.await_attach(handle, deadline)?;
        self.grant(handle)?;
        Ok(handle)
    }

    /// Attach a link this side sends on, and wait for the peer's end.
    pub fn attach_sender(&mut self, name: &str, target: &str, deadline: Instant) -> Result<u32> {
        let handle = self.new_link(name, false, 0);
        let fields = vec![
            Value::str(name),
            Value::Uint(handle),
            Value::Bool(false),
            Value::Ubyte(2),
            Value::Ubyte(0),
            Value::described(codec::SOURCE, vec![Value::str(name)]),
            Value::described(codec::TARGET, vec![Value::str(target)]),
            Value::Null,
            Value::Null,
            Value::Uint(0), // initial-delivery-count, required of a sender
        ];
        self.send_perf(&Value::described(codec::ATTACH, fields), &[])?;
        self.await_attach(handle, deadline)?;
        Ok(handle)
    }

    fn new_link(&mut self, name: &str, receiver: bool, grant: u32) -> u32 {
        let handle = self.next_handle;
        self.next_handle += 1;
        self.links.insert(
            handle,
            Link {
                name: name.to_string(),
                receiver,
                remote: None,
                accepted: false,
                credit: 0,
                delivery_count: 0,
                grant,
                partial: None,
            },
        );
        handle
    }

    fn await_attach(&mut self, handle: u32, deadline: Instant) -> Result<()> {
        loop {
            if let Some(l) = self.links.get(&handle) {
                if l.remote.is_some() && l.accepted {
                    return Ok(());
                }
            }
            /* A refused attach is followed by a detach carrying the reason;
               that arrives as an event, and is the answer to this wait. */
            if let Some(i) = self.pending.iter().position(
                |e| matches!(e, Event::Detached { handle: h, .. } if *h == handle),
            ) {
                let Some(Event::Detached { error, .. }) = self.pending.remove(i) else { unreachable!() };
                return Err(Error::Refused(error));
            }
            let Some(frame) = self.read_frame(deadline)? else {
                return Err(Error::Timeout("the service to attach a link"));
            };
            self.dispatch(frame)?;
        }
    }

    /// Top a receiver's credit back up to its grant.
    fn grant(&mut self, handle: u32) -> Result<()> {
        let Some(l) = self.links.get_mut(&handle) else { return Ok(()) };
        l.credit = l.grant;
        let (count, credit) = (l.delivery_count, l.credit);
        let flow = self.flow_fields(Some((handle, count, credit)));
        self.send_perf(&flow, &[])
    }

    fn flow_fields(&mut self, link: Option<(u32, u32, u32)>) -> Value {
        self.incoming_window = WINDOW;
        let mut f = vec![
            Value::Uint(self.next_incoming_id),
            Value::Uint(self.incoming_window),
            Value::Uint(self.next_outgoing_id),
            Value::Uint(WINDOW),
        ];
        if let Some((h, count, credit)) = link {
            f.extend([Value::Uint(h), Value::Uint(count), Value::Uint(credit)]);
        }
        Value::described(codec::FLOW, f)
    }

    pub fn detach(&mut self, handle: u32) -> Result<()> {
        let d = Value::described(codec::DETACH, vec![Value::Uint(handle), Value::Bool(true)]);
        self.send_perf(&d, &[])
    }

    /// Close politely. Best-effort: a connection being closed is one nobody is
    /// going to read an error from.
    pub fn close(&mut self) {
        let _ = self.send_perf(&Value::described(codec::CLOSE, vec![]), &[]);
    }

    /* ── messages ───────────────────────────────────────────────────────── */

    /// Send one message on a sender link, waiting for credit if there is none.
    pub fn send(&mut self, handle: u32, message: &Message, deadline: Instant) -> Result<()> {
        loop {
            let ready = self.links.get(&handle).map(|l| l.credit > 0).unwrap_or(false)
                && self.remote_incoming_window > 0;
            if ready {
                break;
            }
            let Some(frame) = self.read_frame(deadline)? else {
                return Err(Error::Timeout("credit to send"));
            };
            self.dispatch(frame)?;
        }
        let id = self.next_delivery_id;
        self.next_delivery_id = self.next_delivery_id.wrapping_add(1);
        let payload = message.encode();
        /* Room for the transfer performative itself; it is never near this. */
        let room = self.max_out.saturating_sub(64).max(64);
        let chunks: Vec<&[u8]> = if payload.is_empty() { vec![&[][..]] } else { payload.chunks(room).collect() };
        let last = chunks.len() - 1;
        for (i, chunk) in chunks.into_iter().enumerate() {
            let fields = if i == 0 {
                vec![
                    Value::Uint(handle),
                    Value::Uint(id),
                    Value::Binary(id.to_be_bytes().to_vec()),
                    Value::Uint(0),
                    Value::Bool(false),
                    Value::Bool(i != last),
                ]
            } else {
                vec![
                    Value::Uint(handle),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Bool(i != last),
                ]
            };
            self.send_perf(&Value::described(codec::TRANSFER, fields), chunk)?;
            self.next_outgoing_id = self.next_outgoing_id.wrapping_add(1);
            self.remote_incoming_window = self.remote_incoming_window.saturating_sub(1);
        }
        if let Some(l) = self.links.get_mut(&handle) {
            l.credit -= 1;
            l.delivery_count = l.delivery_count.wrapping_add(1);
        }
        Ok(())
    }

    /// A request on the management pattern: send `message` on `sender`, wait
    /// for the reply on `receiver` whose correlation-id is the message-id.
    /// Anything else that arrives meanwhile is kept for `next`.
    pub fn request(
        &mut self,
        sender: u32,
        receiver: u32,
        message: &Message,
        deadline: Instant,
    ) -> Result<Message> {
        let id = message.property(0).clone();
        self.send(sender, message, deadline)?;
        loop {
            let Some(frame) = self.read_frame(deadline)? else {
                return Err(Error::Timeout("a reply"));
            };
            let before = self.pending.len();
            self.dispatch(frame)?;
            /* Only what this frame added can be the reply. */
            let mut i = before;
            while i < self.pending.len() {
                let is_reply = matches!(
                    &self.pending[i],
                    Event::Message { handle, message } if *handle == receiver && message.property(5) == &id
                );
                if is_reply {
                    let Some(Event::Message { message, .. }) = self.pending.remove(i) else { unreachable!() };
                    return Ok(message);
                }
                if matches!(&self.pending[i], Event::Detached { handle, .. } if *handle == receiver || *handle == sender) {
                    let Some(Event::Detached { error, .. }) = self.pending.remove(i) else { unreachable!() };
                    return Err(Error::Refused(error));
                }
                i += 1;
            }
        }
    }

    /// The next thing that happened on any link, or `None` at the deadline.
    pub fn next(&mut self, deadline: Instant) -> Result<Option<Event>> {
        loop {
            if let Some(e) = self.pending.pop_front() {
                return Ok(Some(e));
            }
            let Some(frame) = self.read_frame(deadline)? else { return Ok(None) };
            self.dispatch(frame)?;
        }
    }

    /* ── frames ─────────────────────────────────────────────────────────── */

    fn dispatch(&mut self, frame: Frame) -> Result<()> {
        if frame.kind != codec::AMQP_FRAME {
            return Err(Error::Protocol(format!("frame type {} after open", frame.kind)));
        }
        let Some((perf, payload)) = frame.split()? else { return Ok(()) };
        match perf.descriptor() {
            Some(codec::ATTACH) => {
                let name = perf.field(0).as_str().unwrap_or("").to_string();
                let remote = perf.field(1).as_u64().unwrap_or(0) as u32;
                /* The peer's role is the opposite of ours, and the terminus it
                   filled in is the one it owns: the source on a link we
                   receive from, the target on one we send to. */
                let found = self.links.iter_mut().find(|(_, l)| l.name == name && l.remote.is_none());
                if let Some((h, l)) = found {
                    let terminus = if l.receiver { perf.field(5) } else { perf.field(6) };
                    l.remote = Some(remote);
                    l.accepted = !terminus.is_null();
                    if l.receiver {
                        l.delivery_count = perf.field(9).as_u64().unwrap_or(0) as u32;
                    }
                    let h = *h;
                    self.by_remote.insert(remote, h);
                }
            }
            Some(codec::FLOW) => {
                if let Some(their_next_in) = perf.field(0).as_u64() {
                    let window = perf.field(1).as_u64().unwrap_or(0) as u32;
                    self.remote_incoming_window = (their_next_in as u32)
                        .wrapping_add(window)
                        .wrapping_sub(self.next_outgoing_id);
                } else {
                    self.remote_incoming_window = perf.field(1).as_u64().unwrap_or(0) as u32;
                }
                if let Some(remote) = perf.field(4).as_u64() {
                    if let Some(h) = self.by_remote.get(&(remote as u32)).copied() {
                        if let Some(l) = self.links.get_mut(&h) {
                            if !l.receiver {
                                let count = perf.field(5).as_u64().unwrap_or(0) as u32;
                                let credit = perf.field(6).as_u64().unwrap_or(0) as u32;
                                l.credit = count.wrapping_add(credit).wrapping_sub(l.delivery_count);
                            }
                        }
                    }
                }
                if perf.field(9).as_bool() == Some(true) {
                    let f = self.flow_fields(None);
                    self.send_perf(&f, &[])?;
                }
            }
            Some(codec::TRANSFER) => self.transfer(&perf, payload)?,
            Some(codec::DISPOSITION) => {}
            Some(codec::DETACH) => {
                let remote = perf.field(0).as_u64().unwrap_or(0) as u32;
                let error = AmqpError::from(perf.field(2));
                if let Some(h) = self.by_remote.remove(&remote) {
                    self.links.remove(&h);
                    self.pending.push_back(Event::Detached { handle: h, error });
                    /* Answer it, or the peer holds the handle open. A detach
                       we started is answered by this one and needs nothing. */
                    let d = Value::described(codec::DETACH, vec![Value::Uint(h), Value::Bool(true)]);
                    let _ = self.send_perf(&d, &[]);
                } else if let Some((h, _)) = self.links.iter().find(|(_, l)| l.remote.is_none()) {
                    /* A detach for a link whose attach never came back with a
                       handle we recorded: still the answer to that attach. */
                    let h = *h;
                    self.links.remove(&h);
                    self.pending.push_back(Event::Detached { handle: h, error });
                }
            }
            Some(codec::END) => return Err(Error::Closed(AmqpError::from(perf.field(0)))),
            Some(codec::CLOSE) => {
                let error = AmqpError::from(perf.field(0));
                let _ = self.send_perf(&Value::described(codec::CLOSE, vec![]), &[]);
                return Err(Error::Closed(error));
            }
            _ => {}
        }
        Ok(())
    }

    fn transfer(&mut self, perf: &Value, payload: &[u8]) -> Result<()> {
        self.next_incoming_id = self.next_incoming_id.wrapping_add(1);
        self.incoming_window = self.incoming_window.saturating_sub(1);
        let remote = perf.field(0).as_u64().unwrap_or(0) as u32;
        let Some(h) = self.by_remote.get(&remote).copied() else {
            return Err(Error::Protocol(format!("transfer on unknown handle {remote}")));
        };
        let more = perf.field(5).as_bool() == Some(true);
        let aborted = perf.field(9).as_bool() == Some(true);
        let Some(l) = self.links.get_mut(&h) else { return Ok(()) };
        let (buf, _id, settled) = l.partial.get_or_insert_with(|| {
            (
                Vec::new(),
                perf.field(1).as_u64().map(|n| n as u32),
                perf.field(4).as_bool() == Some(true),
            )
        });
        if perf.field(4).as_bool() == Some(true) {
            *settled = true;
        }
        buf.extend_from_slice(payload);
        if more && !aborted {
            return Ok(());
        }
        let (bytes, id, settled) = l.partial.take().unwrap();
        l.credit = l.credit.saturating_sub(1);
        l.delivery_count = l.delivery_count.wrapping_add(1);
        let low = l.credit < l.grant / 2 + 1;
        if !aborted {
            let message = Message::decode(&bytes)?;
            self.pending.push_back(Event::Message { handle: h, message });
            if !settled {
                if let Some(id) = id {
                    let d = Value::described(
                        codec::DISPOSITION,
                        vec![
                            Value::Bool(true),
                            Value::Uint(id),
                            Value::Uint(id),
                            Value::Bool(true),
                            Value::described(codec::ACCEPTED, vec![]),
                        ],
                    );
                    self.send_perf(&d, &[])?;
                }
            }
        }
        if low {
            self.grant(h)?;
        } else if self.incoming_window < WINDOW / 2 {
            let f = self.flow_fields(None);
            self.send_perf(&f, &[])?;
        }
        Ok(())
    }

    fn send_perf(&mut self, perf: &Value, payload: &[u8]) -> Result<()> {
        self.write_raw(&codec::frame(codec::AMQP_FRAME, 0, Some(perf), payload))
    }

    fn write_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.io.write_all(bytes)?;
        self.io.flush()?;
        self.last_sent = Instant::now();
        Ok(())
    }

    /// Read until a whole frame is buffered, or the deadline. Sends a heartbeat
    /// when the peer's idle timeout is half spent, and gives up as `Quiet` when
    /// nothing has been heard for twice ours.
    fn read_frame(&mut self, deadline: Instant) -> Result<Option<Frame>> {
        loop {
            if let Some(f) = codec::take_frame(&mut self.rbuf, MAX_FRAME as usize)? {
                return Ok(Some(f));
            }
            let now = Instant::now();
            if let Some(idle) = self.peer_idle {
                if now.duration_since(self.last_sent) >= idle / 2 {
                    self.write_raw(&codec::frame(codec::AMQP_FRAME, 0, None, &[]))?;
                }
            }
            if now >= deadline {
                return Ok(None);
            }
            self.fill()?;
        }
    }

    /// One read's worth into the buffer. A timeout is not an error — it is the
    /// stream coming back so the clock can be looked at.
    fn fill(&mut self) -> Result<()> {
        let mut chunk = [0u8; 16 * 1024];
        match self.io.read(&mut chunk) {
            Ok(0) => Err(Error::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "the stream ended"))),
            Ok(n) => {
                self.rbuf.extend_from_slice(&chunk[..n]);
                self.last_heard = Instant::now();
                Ok(())
            }
            Err(e) if matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {
                if self.last_heard.elapsed() > self.idle * 2 {
                    return Err(Error::Quiet);
                }
                Ok(())
            }
            Err(e) => Err(Error::Io(e)),
        }
    }

    fn expect_header(&mut self, want: &[u8; 8], deadline: Instant) -> Result<()> {
        while self.rbuf.len() < 8 {
            if Instant::now() >= deadline {
                return Err(Error::Timeout("the protocol header"));
            }
            self.fill()?;
        }
        let got: Vec<u8> = self.rbuf.drain(..8).collect();
        if got != want {
            return Err(Error::Protocol(format!("protocol header {got:02x?}")));
        }
        Ok(())
    }

    fn sasl_frame(&mut self, deadline: Instant) -> Result<Value> {
        let Some(f) = self.read_frame(deadline)? else {
            return Err(Error::Timeout("sasl"));
        };
        if f.kind != codec::SASL_FRAME {
            return Err(Error::Protocol("expected a sasl frame".into()));
        }
        f.split()?
            .map(|(p, _)| p)
            .ok_or_else(|| Error::Protocol("empty sasl frame".into()))
    }

    fn performative(&mut self, deadline: Instant, what: &'static str) -> Result<Value> {
        loop {
            let Some(f) = self.read_frame(deadline)? else {
                return Err(Error::Timeout(what));
            };
            if let Some((p, _)) = f.split()? {
                return Ok(p);
            }
        }
    }

    /// The peer's maximum frame size, for a caller sizing a message.
    pub fn max_frame(&self) -> usize {
        self.max_out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};

    /// One end of an in-memory duplex. Reads time out after a few
    /// milliseconds, the way a socket with a read timeout does, so the
    /// connection's clock-watching paths are the ones under test.
    pub struct Pipe {
        rx: Receiver<Vec<u8>>,
        tx: Sender<Vec<u8>>,
        held: Vec<u8>,
    }

    pub fn pipe() -> (Pipe, Pipe) {
        let (a_tx, b_rx) = channel();
        let (b_tx, a_rx) = channel();
        (
            Pipe { rx: a_rx, tx: a_tx, held: Vec::new() },
            Pipe { rx: b_rx, tx: b_tx, held: Vec::new() },
        )
    }

    impl Read for Pipe {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.held.is_empty() {
                match self.rx.recv_timeout(Duration::from_millis(5)) {
                    Ok(b) => self.held = b,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        return Err(io::Error::new(io::ErrorKind::TimedOut, "pipe"))
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.held.len());
            out[..n].copy_from_slice(&self.held[..n]);
            self.held.drain(..n);
            Ok(n)
        }
    }

    impl Write for Pipe {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.tx
                .send(b.to_vec())
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "pipe"))?;
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A scripted broker on the far end of a pipe: just enough of a server to
    /// answer the handshake and then let a test say what it sends.
    pub struct Peer {
        pub io: Pipe,
        buf: Vec<u8>,
        pub seen: Vec<Value>,
    }

    impl Peer {
        pub fn new(io: Pipe) -> Self {
            Peer { io, buf: Vec::new(), seen: Vec::new() }
        }

        fn fill(&mut self) {
            let mut chunk = [0u8; 4096];
            match self.io.read(&mut chunk) {
                Ok(0) => panic!("client hung up"),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(_) => {}
            }
        }

        pub fn header(&mut self) -> Vec<u8> {
            let t = Instant::now();
            while self.buf.len() < 8 {
                assert!(t.elapsed() < Duration::from_secs(5), "no header");
                self.fill();
            }
            self.buf.drain(..8).collect()
        }

        /// The next non-heartbeat performative and its payload.
        pub fn read(&mut self) -> (Value, Vec<u8>) {
            let t = Instant::now();
            loop {
                assert!(t.elapsed() < Duration::from_secs(5), "nothing from the client");
                if let Some(f) = codec::take_frame(&mut self.buf, 1 << 20).unwrap() {
                    if let Some((p, rest)) = f.split().unwrap() {
                        self.seen.push(p.clone());
                        return (p, rest.to_vec());
                    }
                    continue;
                }
                self.fill();
            }
        }

        /// Read performatives until one with this descriptor.
        pub fn until(&mut self, code: u64) -> (Value, Vec<u8>) {
            loop {
                let (p, rest) = self.read();
                if p.descriptor() == Some(code) {
                    return (p, rest);
                }
            }
        }

        pub fn send(&mut self, kind: u8, perf: &Value, payload: &[u8]) {
            self.io.write_all(&codec::frame(kind, 0, Some(perf), payload)).unwrap();
        }

        /// SASL ANONYMOUS, open, begin — the server's half.
        pub fn handshake(&mut self, idle_ms: u32) {
            assert_eq!(self.header(), codec::SASL_HEADER);
            self.io.write_all(&codec::SASL_HEADER).unwrap();
            self.send(
                codec::SASL_FRAME,
                &Value::described(codec::SASL_MECHANISMS, vec![Value::Array(vec![Value::sym("MSSBCBS"), Value::sym("ANONYMOUS")])]),
                &[],
            );
            let (init, _) = self.read();
            assert_eq!(init.descriptor(), Some(codec::SASL_INIT));
            assert_eq!(init.field(0).as_str(), Some("ANONYMOUS"));
            self.send(codec::SASL_FRAME, &Value::described(codec::SASL_OUTCOME, vec![Value::Ubyte(0)]), &[]);
            assert_eq!(self.header(), codec::AMQP_HEADER);
            self.io.write_all(&codec::AMQP_HEADER).unwrap();
            let (open, _) = self.read();
            assert_eq!(open.descriptor(), Some(codec::OPEN));
            self.send(
                codec::AMQP_FRAME,
                &Value::described(
                    codec::OPEN,
                    vec![Value::str("peer"), Value::Null, Value::Uint(65_536), Value::Ushort(0), Value::Uint(idle_ms)],
                ),
                &[],
            );
            let (begin, _) = self.read();
            assert_eq!(begin.descriptor(), Some(codec::BEGIN));
            self.send(
                codec::AMQP_FRAME,
                &Value::described(
                    codec::BEGIN,
                    vec![Value::Ushort(0), Value::Uint(1), Value::Uint(5_000), Value::Uint(5_000), Value::Uint(255)],
                ),
                &[],
            );
        }

        /// Answer the client's next attach, as the opposite role. `refuse`
        /// answers with a null terminus and a detach carrying an error, the way
        /// a broker refuses an entity.
        pub fn accept_attach(&mut self, remote_handle: u32, refuse: Option<&str>) -> Value {
            let (attach, _) = self.until(codec::ATTACH);
            let receiver = attach.field(2).as_bool() == Some(true);
            let (source, target) = match refuse {
                Some(_) if receiver => (Value::Null, attach.field(6).clone()),
                Some(_) => (attach.field(5).clone(), Value::Null),
                None => (attach.field(5).clone(), attach.field(6).clone()),
            };
            self.send(
                codec::AMQP_FRAME,
                &Value::described(
                    codec::ATTACH,
                    vec![
                        attach.field(0).clone(),
                        Value::Uint(remote_handle),
                        Value::Bool(!receiver),
                        Value::Ubyte(2),
                        Value::Ubyte(0),
                        source,
                        target,
                        Value::Null,
                        Value::Null,
                        Value::Uint(0),
                    ],
                ),
                &[],
            );
            if let Some(why) = refuse {
                self.send(
                    codec::AMQP_FRAME,
                    &Value::described(
                        codec::DETACH,
                        vec![
                            Value::Uint(remote_handle),
                            Value::Bool(true),
                            Value::described(codec::ERROR, vec![Value::sym("amqp:not-found"), Value::str(why)]),
                        ],
                    ),
                    &[],
                );
            } else if !receiver {
                /* The client is a sender: grant it credit, as a broker does at
                   once. */
                self.send(
                    codec::AMQP_FRAME,
                    &Value::described(
                        codec::FLOW,
                        vec![
                            Value::Uint(0),
                            Value::Uint(5_000),
                            Value::Uint(1),
                            Value::Uint(5_000),
                            Value::Uint(remote_handle),
                            Value::Uint(0),
                            Value::Uint(100),
                        ],
                    ),
                    &[],
                );
            }
            attach
        }

        /// One transfer of a whole message, split into `pieces` frames.
        pub fn transfer(&mut self, remote_handle: u32, id: u32, message: &Message, pieces: usize, settled: bool) {
            let bytes = message.encode();
            let size = bytes.len().div_ceil(pieces.max(1)).max(1);
            let chunks: Vec<&[u8]> = bytes.chunks(size).collect();
            let last = chunks.len() - 1;
            for (i, c) in chunks.into_iter().enumerate() {
                let fields = vec![
                    Value::Uint(remote_handle),
                    if i == 0 { Value::Uint(id) } else { Value::Null },
                    if i == 0 { Value::Binary(id.to_be_bytes().to_vec()) } else { Value::Null },
                    Value::Uint(0),
                    Value::Bool(settled),
                    Value::Bool(i != last),
                ];
                self.send(codec::AMQP_FRAME, &Value::described(codec::TRANSFER, fields), c);
            }
        }
    }

    fn opts() -> Opts {
        Opts {
            container_id: "volery-test".into(),
            hostname: "ns.servicebus.windows.net".into(),
            idle: Duration::from_secs(30),
            patience: Duration::from_secs(5),
        }
    }

    fn event(seq: i64, body: &str) -> Message {
        Message {
            annotations: vec![(Value::sym("x-opt-sequence-number"), Value::Long(seq))],
            data: Some(body.as_bytes().to_vec()),
            ..Default::default()
        }
    }

    /// The receive path end to end against a fake broker: handshake, attach,
    /// credit, a message split over three frames, an unsettled one answered with
    /// a disposition, credit topped back up, and a detach carrying its reason.
    #[test]
    fn a_receiver_takes_messages_and_keeps_its_credit_up() {
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(60_000);
            p.accept_attach(7, None);
            let (flow, _) = p.until(codec::FLOW);
            assert_eq!(flow.field(4).as_u64(), Some(0), "the link's own handle");
            assert_eq!(flow.field(6).as_u64(), Some(4), "the credit granted");
            p.transfer(7, 0, &event(1, "one"), 3, true);
            p.transfer(7, 1, &event(2, "two"), 1, false);
            let (disp, _) = p.until(codec::DISPOSITION);
            assert_eq!(disp.field(1).as_u64(), Some(1), "the unsettled delivery is settled");
            /* Two of four spent, which is past half: the client tops itself up. */
            let (flow, _) = p.until(codec::FLOW);
            assert_eq!(flow.field(5).as_u64(), Some(2), "delivery-count after two");
            assert_eq!(flow.field(6).as_u64(), Some(4));
            p.transfer(7, 2, &event(3, "three"), 1, true);
            p.send(
                codec::AMQP_FRAME,
                &Value::described(
                    codec::DETACH,
                    vec![
                        Value::Uint(7),
                        Value::Bool(true),
                        Value::described(codec::ERROR, vec![Value::sym("amqp:link:stolen"), Value::str("epoch")]),
                    ],
                ),
                &[],
            );
            p
        });

        let mut c = Conn::connect(client, &opts()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let source = Value::described(codec::SOURCE, vec![Value::str("hub/ConsumerGroups/$Default/Partitions/0")]);
        let h = c.attach_receiver("r0", source, "client", None, 4, deadline).unwrap();
        let mut bodies = Vec::new();
        let detached = loop {
            match c.next(deadline).unwrap().expect("an event before the deadline") {
                Event::Message { handle, message } => {
                    assert_eq!(handle, h);
                    bodies.push(String::from_utf8(message.data.unwrap()).unwrap());
                }
                Event::Detached { error, .. } => break error,
            }
        };
        assert_eq!(bodies, ["one", "two", "three"]);
        assert_eq!(detached.unwrap().condition, "amqp:link:stolen");
        broker.join().unwrap();
    }

    /// A refused entity is an error naming the broker's reason, not a hang.
    #[test]
    fn a_refused_attach_says_why() {
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(0);
            p.accept_attach(0, Some("the messaging entity could not be found"));
            p
        });
        let mut c = Conn::connect(client, &opts()).unwrap();
        let err = c
            .attach_receiver(
                "r",
                Value::described(codec::SOURCE, vec![Value::str("nope")]),
                "client",
                None,
                10,
                Instant::now() + Duration::from_secs(5),
            )
            .unwrap_err();
        assert!(matches!(&err, Error::Refused(Some(e)) if e.description.contains("could not be found")), "{err}");
        broker.join().unwrap();
    }

    /// The management pattern: the reply is matched on correlation-id, and an
    /// event that lands on another link in between is kept, not lost.
    #[test]
    fn a_request_finds_its_reply_and_keeps_what_came_in_between() {
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(0);
            p.accept_attach(10, None); // a partition receiver
            p.until(codec::FLOW);
            p.accept_attach(11, None); // the request sender
            p.accept_attach(12, None); // the reply receiver
            p.until(codec::FLOW);
            let (_, payload) = p.until(codec::TRANSFER);
            let req = Message::decode(&payload).unwrap();
            assert_eq!(req.app("operation").and_then(Value::as_str), Some("put-token"));
            p.transfer(10, 0, &event(9, "meanwhile"), 1, true);
            let mut reply = Message {
                properties: vec![Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, req.property(0).clone()],
                application: vec![(Value::str("status-code"), Value::Int(202))],
                ..Default::default()
            };
            /* A reply to somebody else first, which must not be taken. */
            reply.properties[5] = Value::str("other");
            p.transfer(12, 0, &reply, 1, true);
            reply.properties[5] = req.property(0).clone();
            p.transfer(12, 1, &reply, 1, true);
            p
        });
        let mut c = Conn::connect(client, &opts()).unwrap();
        let d = Instant::now() + Duration::from_secs(5);
        let part = c
            .attach_receiver("p0", Value::described(codec::SOURCE, vec![Value::str("hub/p/0")]), "c", None, 10, d)
            .unwrap();
        let tx = c.attach_sender("cbs-tx", "$cbs", d).unwrap();
        let rx = c
            .attach_receiver("cbs-rx", Value::described(codec::SOURCE, vec![Value::str("$cbs")]), "cbs-reply", None, 10, d)
            .unwrap();
        let req = Message {
            properties: vec![Value::str("req-1"), Value::Null, Value::Null, Value::Null, Value::str("cbs-reply")],
            application: vec![(Value::str("operation"), Value::str("put-token"))],
            value: Some(Value::str("token")),
            ..Default::default()
        };
        let reply = c.request(tx, rx, &req, d).unwrap();
        assert_eq!(reply.app("status-code").and_then(Value::as_i64), Some(202));
        /* The event that arrived mid-request is the next thing read. */
        match c.next(d).unwrap() {
            Some(Event::Message { handle, message }) => {
                assert_eq!(handle, part);
                assert_eq!(message.data.as_deref(), Some(&b"meanwhile"[..]));
            }
            other => panic!("{other:?}"),
        }
        broker.join().unwrap();
    }

    /// The service's idle timeout is honoured: with nothing to say, the client
    /// sends an empty frame at half of it.
    #[test]
    fn silence_is_broken_with_a_heartbeat() {
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(80);
            /* Count raw heartbeat frames for a while. */
            let t = Instant::now();
            let mut beats = 0;
            while t.elapsed() < Duration::from_millis(400) {
                p.fill();
                while let Some(f) = codec::take_frame(&mut p.buf, 1 << 20).unwrap() {
                    if f.body.is_empty() {
                        beats += 1;
                    }
                }
            }
            (beats, p)
        });
        let mut c = Conn::connect(client, &opts()).unwrap();
        assert_eq!(c.next(Instant::now() + Duration::from_millis(300)).unwrap(), None);
        let (beats, _peer) = broker.join().unwrap();
        assert!(beats >= 3, "{beats} heartbeats in 300ms at a 40ms half-timeout");
    }

    /// A peer that says nothing for twice our idle timeout is a dead connection.
    #[test]
    fn a_silent_peer_is_presumed_dead() {
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(0);
            std::thread::sleep(Duration::from_millis(400));
            p
        });
        let mut o = opts();
        o.idle = Duration::from_millis(50);
        let mut c = Conn::connect(client, &o).unwrap();
        let err = c.next(Instant::now() + Duration::from_secs(2)).unwrap_err();
        assert!(matches!(err, Error::Quiet), "{err}");
        broker.join().unwrap();
    }
}
