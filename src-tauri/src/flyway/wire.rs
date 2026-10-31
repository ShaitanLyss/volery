//! Bytes between two of this person's machines.
//!
//! The thin layer everything else was built above. `session.rs` decides what to
//! say, `seal.rs` makes it unreadable to anything in between, and this carries
//! it — which is why it is the last piece written rather than the first: a
//! transport chosen early is a transport everything accidentally depends on the
//! shape of.
//!
//! ### Why iroh rather than a relay of our own
//!
//! A relay we wrote would have to be deployed, paid for and kept up, and the
//! first time it was down the feature would be down. iroh dials a peer by its
//! **public key**, hole-punches where the network allows it, and falls back to
//! relays somebody else operates. There is nothing to stand up, and a node's
//! identity being a keypair is already exactly the model `seal.rs` has.
//!
//! What that buys is also what it costs: the connection is only as private as
//! QUIC's TLS, and the relay is a third party on the path when hole-punching
//! fails. Neither matters here, because **the payload is sealed before it
//! reaches this file** and the relay forwards bytes it cannot read. That
//! ordering is the whole reason the transport was allowed to be a late,
//! replaceable decision.
//!
//! ### Finding each other
//!
//! Dialling by public key needs that key. Rather than carrying a 52-character
//! node id in an invite or running a rendezvous, a wall's identity is derived
//! from the wall key and the machine's name (`WallKey::node_secret`) — so any
//! wall holding the key can recompute any other's from its name alone. An
//! invite is a key and a hostname; nothing stores a node id to find somebody
//! again.
//!
//! The `N0` preset publishes each endpoint's whereabouts to a DNS lookup
//! service keyed by that public key, which is what makes dialling work from
//! another network at all rather than only across a LAN.
//!
//! ### The one setting that decides whether this works from an office
//!
//! `CaTlsConfig::system()`. See the note beside `iroh` in `Cargo.toml` — the
//! default verifies against a compiled-in copy of Mozilla's roots, which is the
//! client that passes everywhere it is tested and fails on the network with a
//! TLS-intercepting gateway in front of it.
//!
//! ### Two languages, and answering one dial at a time no longer
//!
//! The wire speaks `ALPN` — the envelope of `frame.rs` — and still answers and
//! dials `ALPN_V1`, the sink alone, so a wall one release behind keeps syncing.
//! And dials are answered each on a task of their own: one at a time was right
//! while the only dial was a pull every forty-five seconds, and wrong once a
//! push can arrive mid-pull and wait out the pull's whole round trip behind it.
//!
//! ### A third language, and the one connection that is held open
//!
//! `volery/cast/1` is a screen (`cast.rs`). It is told apart *before* the
//! handshake finishes — the ALPN is read off the dialler's first packet — so it
//! can be accepted under a transport of its own (`cast_transport`) rather than
//! the one every sink pull uses. And it is the one connection this file hands
//! out whole instead of carrying frames over it, because the shapes that make a
//! screen feel local — a stream per frame, datagrams for the pointer — are
//! QUIC's own and would be lost behind any wrapper narrow enough to be worth
//! having. `link/cast.rs` is the one caller, and it reads nothing of iroh but
//! streams, datagrams and the path.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::{presets, ConnectOptions, Connection, Incoming, QuicTransportConfig, ServerConfig, VarInt};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, EndpointId, SecretKey};

use super::cast;
use super::frame::{self, Frame};
use super::seal::WallKey;

/// What this protocol is called on the wire. Versioned, so a wall running an
/// older build is refused at the handshake with something legible rather than
/// connecting and failing to parse a frame later.
///
/// **2** is the envelope (`frame.rs`): the sink, the fleet and the cards on one
/// connection. A frame of v1 is a frame of v2 — the envelope is untagged and a
/// bare sink message is one of its variants — so this wall still *answers* v1,
/// and still *dials* it when a peer refuses 2. That pair is what keeps two
/// machines one release apart syncing their sink in both directions while the
/// second one updates, instead of each going quiet to the other.
pub const ALPN: &[u8] = b"volery/flyway/2";
pub const ALPN_V1: &[u8] = b"volery/flyway/1";

/// The most one frame may be. A peer that announces a larger one is refused
/// rather than allocated for — the only thing on the other end *should* be
/// another Volery, and a bound is what makes that "should" cost nothing to be
/// wrong about.
pub(crate) const MAX_FRAME: usize = 8 * 1024 * 1024;

/// How long one exchange may take, dial included.
///
/// A peer that is asleep is the ordinary case, and how long iroh takes to give
/// up on one depends on what the lookup service last heard about it — so
/// without a bound of our own a sleeping laptop holds its slot in a tick for
/// however long a relay takes to say so. Twenty seconds is far past a real
/// exchange (a few round trips and a few frames) and well inside a tick.
const EXCHANGE_WITHIN: Duration = Duration::from_secs(20);

/// How long an exchange carrying `bytes` may take: the ordinary twenty seconds,
/// plus a second for every 128 KB — about a megabit a second, the floor of a
/// slow uplink or a relay somebody else runs. A prompt with pictures in it is
/// up to `attach::CARRY_MOST`, seven megabytes, which no link writes in twenty
/// seconds below three megabits; at this rate it has 76.
pub fn carrying_within(bytes: usize) -> Duration {
    EXCHANGE_WITHIN + Duration::from_secs((bytes / (128 * 1024)) as u64)
}

/// Why an exchange came to nothing, in the one distinction the caller acts on.
#[derive(Debug)]
pub enum Fault {
    /// The far wall answered and does not speak this version — an older build.
    /// Worth a second dial in the old language; nothing else is.
    Older(String),
    /// Asleep, unreachable, or broken. The next tick will try again.
    Other(String),
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Fault::Older(e) => write!(f, "that wall runs an older Volery ({e})"),
            Fault::Other(e) => f.write_str(e),
        }
    }
}

/// Who dialled, and in which language.
#[derive(Debug, Clone, Copy)]
pub struct Dialler {
    pub id: EndpointId,
    /// Spoke `ALPN` rather than `ALPN_V1`. An old wall must be answered in
    /// sink frames alone, or its reader fails on the first frame it has no
    /// word for and drops the events that came before it.
    pub current: bool,
}

/// A bound endpoint: this wall, reachable by the identity its key implies.
pub struct Wire {
    endpoint: Endpoint,
    key: Arc<WallKey>,
    room: String,
    /// What a screen's connection is accepted under (`cast_transport`).
    cast_server: Arc<ServerConfig>,
}

/// A connection that finished its handshake, told apart by its language.
pub enum Arrival {
    /// The sink, the fleet and the cards: one exchange, answered by `answer`.
    Flyway(Connection),
    /// A screen (`link/cast.rs`), held for as long as it is watched.
    Cast(Connection),
}

/// The transport a screen's connection runs on, both ends.
///
/// - **Cubic, noq's default, and not BBR** — which is the opposite of what
///   the textbook says for real-time media, and was measured rather than
///   assumed (`examples/cast-flyway-probe.rs`, 2026-10-31, loopback, release):
///   100 KB frames paced at 60 fps arrived p50 1.95 ms / p95 2.89 ms under
///   Cubic and p50 125 ms / p95 1.57 s under noq 1.3's `Bbr3`, and a burst ran
///   546 against 254 Mbit/s. BBR's startup and probing are built for a bulk
///   flow that keeps the pipe full; a screen is app-limited — a burst every
///   16 ms and silence between — and noq's v3 reads that silence badly. The
///   bitrate is steered from above anyway (`cast::Steer`), which is the job
///   BBR would have been doing for the queue.
/// - **A second's keep-alive, and iroh's own idle timeout.** The keep-alive
///   stops a NAT mapping lapsing on a quiet screen (paused, not visible). The
///   idle was eight seconds, so a shut laptop would read as gone quickly — and
///   that undercut iroh's per-path idle (fifteen) and its five-second path
///   heartbeat, which its docs warn against: two lab walls on one machine saw
///   the screen's connection close "timed out" every minute or so while the
///   flyway beside it was fine (2026-10-31). A shut laptop now takes iroh's
///   thirty seconds to read as gone, and the tile says `ended` then.
/// - **No send fairness**: streams go out in the order they were written, so
///   the oldest frame finishes first instead of every frame in flight arriving
///   late together; the control stream outranks them all by priority.
/// - **Windows sized for a keyframe**: a 4K keyframe can pass the default
///   1.25 MB stream window, which would stall it for a round trip mid-frame.
pub fn cast_transport() -> QuicTransportConfig {
    let b = QuicTransportConfig::builder()
        .keep_alive_interval(Duration::from_secs(1))
        .send_fairness(false)
        .max_concurrent_uni_streams(VarInt::from_u32(1024))
        .max_concurrent_bidi_streams(VarInt::from_u32(4))
        .stream_receive_window(VarInt::from_u32(8 * 1024 * 1024))
        .send_window(32 * 1024 * 1024);
    b.build()
}

impl Wire {
    /// Bind this wall's endpoint.
    ///
    /// The secret is derived rather than stored, so a machine that has the wall
    /// key is already the peer the others expect — there is no second thing to
    /// back up, and a wall restored from nothing is itself again as soon as the
    /// key is entered.
    pub async fn start(key: WallKey, host: &str) -> Result<Self, String> {
        let secret = SecretKey::from_bytes(&key.node_secret(host)?);
        let room = key.room("wall");

        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret)
            /* The load-bearing line. See the module note. */
            .ca_tls_config(CaTlsConfig::system())
            /* Current first: when a dialler offers several, the order here is
               the preference. Ours only ever offer one at a time. */
            .alpns(vec![ALPN.to_vec(), ALPN_V1.to_vec(), cast::ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("could not take a place on the flyway: {e}"))?;
        let cast_server = Arc::new(
            endpoint
                .create_server_config_builder(vec![cast::ALPN.to_vec()])
                .set_transport_config(cast_transport())
                .build(),
        );

        Ok(Self { endpoint, key: Arc::new(key), room, cast_server })
    }

    /// Let go of the endpoint: every connection ends and `next_dial` answers
    /// `None`, which is what stops the accept loop. A wall that has left the
    /// flyway does this, and a wall that did not would go on answering as a
    /// member of it (`link/leaving.rs`).
    pub async fn close(&self) {
        self.endpoint.close().await;
    }

    /// Who this wall is, to anybody dialling it.
    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
    }

    /// The wall key, for a channel that derives keys of its own from it
    /// (`cast.rs`).
    pub fn key(&self) -> &WallKey {
        &self.key
    }

    /// Who a machine of that name is on this flyway.
    ///
    /// Computed, not looked up: this is the whole of how a wall finds another
    /// without an address, a node id or a server.
    pub fn peer(&self, host: &str) -> Result<EndpointId, String> {
        Ok(SecretKey::from_bytes(&self.key.node_secret(host)?).public())
    }

    /// Say something to another wall and hear what it says back.
    ///
    /// One connection per exchange — for a pull and for a push alike, since a
    /// push here is a pull's shape: send, finish, read (see `link.rs` on why
    /// nothing is held open). `current: false` dials in the old language, and
    /// the caller is the one who knows to send it only sink frames.
    pub async fn exchange(&self, peer: EndpointId, out: Vec<Frame>, current: bool) -> Result<Vec<Frame>, Fault> {
        self.exchange_within(peer, out, current, EXCHANGE_WITHIN).await
    }

    /// `exchange`, given longer — for the one exchange that carries megabytes
    /// (`carrying_within`). Everything else keeps the twenty seconds.
    pub async fn exchange_within(
        &self,
        peer: EndpointId,
        out: Vec<Frame>,
        current: bool,
        within: Duration,
    ) -> Result<Vec<Frame>, Fault> {
        let alpn = if current { ALPN } else { ALPN_V1 };
        match tokio::time::timeout(within, self.exchange_on(peer, alpn, out)).await {
            Ok(got) => got,
            Err(_) => Err(Fault::Other(format!(
                "no answer within {}s — that wall is probably asleep",
                within.as_secs()
            ))),
        }
    }

    async fn exchange_on(&self, peer: EndpointId, alpn: &[u8], out: Vec<Frame>) -> Result<Vec<Frame>, Fault> {
        let conn = self.endpoint.connect(peer, alpn).await.map_err(|e| {
            let why = format!("could not reach that wall: {e}");
            if refused_protocol(&why) {
                Fault::Older(why)
            } else {
                Fault::Other(why)
            }
        })?;
        let got = self.talk(&conn, out).await.map_err(Fault::Other);
        /* Closed explicitly so the far side learns it is over now rather than
           on a timeout — a dropped QUIC connection is indistinguishable from a
           slow one until the idle timer fires. */
        conn.close(0u32.into(), b"done");
        got
    }

    /// The next wall to dial in, or `None` once the endpoint has closed.
    ///
    /// Split from answering so the caller can answer each on its own task —
    /// see the module note.
    pub async fn next_dial(&self) -> Option<Incoming> {
        self.endpoint.accept().await
    }

    /// Finish a dial's handshake, under the transport its language wants.
    ///
    /// The ALPN is read off the dialler's first packet, before anything is
    /// agreed, because a server's transport is fixed at accept — a screen
    /// accepted as a sink pull would run on Cubic with a thirty-second idle.
    /// A packet that cannot be read is accepted the ordinary way, and the
    /// handshake then says what it is.
    pub async fn arrive(&self, incoming: Incoming) -> Result<Arrival, String> {
        let casting = incoming
            .decrypt()
            .and_then(|d| d.alpns())
            .is_some_and(|mut a| a.next().and_then(Result::ok).is_some_and(|p| &p[..] == cast::ALPN));
        let conn = if casting {
            incoming
                .accept_with(self.cast_server.clone())
                .map_err(|e| format!("a screen dialled and was not accepted: {e}"))?
                .await
        } else {
            incoming.await
        }
        .map_err(|e| format!("a wall dialled and did not finish: {e}"))?;
        Ok(if conn.alpn() == cast::ALPN { Arrival::Cast(conn) } else { Arrival::Flyway(conn) })
    }

    /// Open a screen's connection to another wall: one per pair of walls, held
    /// by `link/cast.rs` while any screen between them is open.
    pub async fn dial_cast(&self, peer: EndpointId) -> Result<Connection, String> {
        let go = async {
            let connecting = self
                .endpoint
                .connect_with_opts(peer, cast::ALPN, ConnectOptions::new().with_transport_config(cast_transport()))
                .await
                .map_err(|e| format!("could not reach that wall: {e}"))?;
            connecting.await.map_err(|e| format!("could not reach that wall: {e}"))
        };
        match tokio::time::timeout(EXCHANGE_WITHIN, go).await {
            Ok(got) => got.map_err(|why| {
                if refused_protocol(&why) {
                    format!("that wall runs a Volery that cannot show screens ({why})")
                } else {
                    why
                }
            }),
            Err(_) => Err(format!(
                "no answer within {}s — that wall is probably asleep",
                EXCHANGE_WITHIN.as_secs()
            )),
        }
    }

    /// Answer one wall that dialled us, on a connection `arrive` finished.
    ///
    /// `reply` is handed what arrived and who sent it, and says what to send
    /// back, which keeps every decision about *meaning* in `link.rs` and leaves
    /// this file knowing only about bytes.
    pub async fn answer<F, Fut>(&self, conn: Connection, reply: F) -> Result<(), String>
    where
        F: FnOnce(Vec<Frame>, Dialler) -> Fut,
        Fut: Future<Output = Vec<Frame>>,
    {
        let who = Dialler { id: conn.remote_id(), current: conn.alpn() == ALPN };

        let (mut send, mut recv) = conn
            .accept_bi()
            .await
            .map_err(|e| format!("no stream: {e}"))?;

        let heard = self.read_all(&mut recv).await?;
        for m in reply(heard, who).await {
            self.write_one(&mut send, &m).await?;
        }
        send.finish().map_err(|e| format!("could not finish: {e}"))?;
        /* Bounded, so a dialler that never closes holds this task and nothing
           else — which is what one task per dial bought. */
        let _ = tokio::time::timeout(EXCHANGE_WITHIN, conn.closed()).await;
        Ok(())
    }

    async fn talk(&self, conn: &Connection, out: Vec<Frame>) -> Result<Vec<Frame>, String> {
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| format!("could not open a stream: {e}"))?;
        for m in &out {
            self.write_one(&mut send, m).await?;
        }
        /* Finished before reading, because the far side reads to the end of the
           stream before it answers. Without this both ends wait for each other
           and the exchange hangs until the idle timeout — which reads as "the
           other machine is asleep" and is not. */
        send.finish().map_err(|e| format!("could not finish: {e}"))?;
        self.read_all(&mut recv).await
    }

    async fn write_one(&self, send: &mut iroh::endpoint::SendStream, m: &Frame) -> Result<(), String> {
        let plain = serde_json::to_vec(m).map_err(|e| format!("could not write a frame: {e}"))?;
        let sealed = self.key.seal(&self.room, &plain)?;
        let n = u32::try_from(sealed.len()).map_err(|_| "that frame is too large".to_string())?;
        send.write_all(&n.to_be_bytes())
            .await
            .map_err(|e| format!("could not send: {e}"))?;
        send.write_all(&sealed)
            .await
            .map_err(|e| format!("could not send: {e}"))?;
        Ok(())
    }

    async fn read_all(&self, recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<Frame>, String> {
        let mut out = Vec::new();
        loop {
            let mut len = [0u8; 4];
            match recv.read_exact(&mut len).await {
                Ok(()) => {}
                /* The ordinary end of a stream, not a fault. */
                Err(_) => return Ok(out),
            }
            let n = u32::from_be_bytes(len) as usize;
            if n > MAX_FRAME {
                return Err("that wall announced a frame too large to be one of ours".into());
            }
            let mut buf = vec![0u8; n];
            recv.read_exact(&mut buf)
                .await
                .map_err(|e| format!("a frame was cut short: {e}"))?;
            let plain = self.key.open(&self.room, &buf)?;
            /* A newer build's word, or a word in a newer shape, is passed over
               rather than ending the exchange — see `frame.rs`. */
            frame::take(&plain, &mut out)?;
        }
    }
}

/// Whether a dial failed because the far wall does not speak this version.
///
/// Read off the error's words, which is the thing this codebase usually
/// refuses to do — and it is done here because the fallback it gates is
/// harmless when it is wrong in either direction. A false yes costs one extra
/// dial in the old language, which a wall that is merely asleep refuses just
/// the same; a false no leaves an old wall's sink unsynced until it updates,
/// which is what every wall did before this existed. The TLS alert for "no
/// protocol in common" is 120, and the transport spells it as a crypto error
/// carrying that number.
fn refused_protocol(why: &str) -> bool {
    let w = why.to_lowercase();
    w.contains("application protocol")
        || w.contains("known protocol")
        || w.contains("alpn")
        || w.contains("error 120")
        || w.contains("0x178")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_wall_is_told_apart_from_a_sleeping_one() {
        assert!(refused_protocol("could not reach that wall: the cryptographic handshake failed: error 120"));
        assert!(refused_protocol("peer doesn't support any known protocol"));
        assert!(!refused_protocol("could not reach that wall: timed out"));
        assert!(!refused_protocol("No addressing information available"));
    }

    /// The versions are what the handshake is refused on, so the current one
    /// must differ from the one it falls back to — or the fallback is a loop.
    #[test]
    fn the_two_languages_are_two() {
        assert_ne!(ALPN, ALPN_V1);
        assert!(ALPN.starts_with(b"volery/flyway/"));
    }

    /// A screen is its own language, so `arrive` can tell it apart, and it is
    /// neither of the two a sink pull falls back between.
    #[test]
    fn a_screen_speaks_a_third_language() {
        assert_ne!(cast::ALPN, ALPN);
        assert_ne!(cast::ALPN, ALPN_V1);
        let _ = cast_transport();
    }
}
