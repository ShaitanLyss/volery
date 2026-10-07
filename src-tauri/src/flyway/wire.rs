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

use std::sync::Arc;

use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointId, SecretKey};
use iroh::tls::CaTlsConfig;

use super::seal::WallKey;
use super::session::Msg;

/// What this protocol is called on the wire. Versioned, so a wall running an
/// older build is refused at the handshake with something legible rather than
/// connecting and failing to parse a frame later.
pub const ALPN: &[u8] = b"volery/flyway/1";

/// The most one frame may be. A peer that announces a larger one is refused
/// rather than allocated for — the only thing on the other end *should* be
/// another Volery, and a bound is what makes that "should" cost nothing to be
/// wrong about.
const MAX_FRAME: usize = 8 * 1024 * 1024;

/// A bound endpoint: this wall, reachable by the identity its key implies.
pub struct Wire {
    endpoint: Endpoint,
    key: Arc<WallKey>,
    room: String,
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
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("could not take a place on the flyway: {e}"))?;

        Ok(Self { endpoint, key: Arc::new(key), room })
    }

    /// Who this wall is, to anybody dialling it.
    pub fn id(&self) -> EndpointId {
        self.endpoint.id()
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
    /// One connection per exchange, which is the right shape for a sink that
    /// settles in a few frames and the wrong one for a live transcript. When
    /// the second comes, it wants a connection held open and this becomes the
    /// thing it is built on rather than the thing it replaces.
    pub async fn exchange(&self, peer: EndpointId, out: Vec<Msg>) -> Result<Vec<Msg>, String> {
        let conn = self
            .endpoint
            .connect(peer, ALPN)
            .await
            .map_err(|e| format!("could not reach that wall: {e}"))?;
        let got = self.talk(&conn, out).await;
        /* Closed explicitly so the far side learns it is over now rather than
           on a timeout — a dropped QUIC connection is indistinguishable from a
           slow one until the idle timer fires. */
        conn.close(0u32.into(), b"done");
        got
    }

    /// Answer one wall that dialled us.
    ///
    /// `reply` is handed what arrived and says what to send back, which keeps
    /// every decision about *meaning* in `session.rs` and leaves this file
    /// knowing only about bytes.
    pub async fn serve_one<F>(&self, reply: F) -> Result<(), String>
    where
        F: FnOnce(Vec<Msg>) -> Vec<Msg>,
    {
        let incoming = self
            .endpoint
            .accept()
            .await
            .ok_or_else(|| "the endpoint has closed".to_string())?;
        let conn = incoming
            .await
            .map_err(|e| format!("a wall dialled and did not finish: {e}"))?;

        let (mut send, mut recv) = conn
            .accept_bi()
            .await
            .map_err(|e| format!("no stream: {e}"))?;

        let heard = self.read_all(&mut recv).await?;
        for m in reply(heard) {
            self.write_one(&mut send, &m).await?;
        }
        send.finish().map_err(|e| format!("could not finish: {e}"))?;
        conn.closed().await;
        Ok(())
    }

    async fn talk(&self, conn: &Connection, out: Vec<Msg>) -> Result<Vec<Msg>, String> {
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

    async fn write_one(
        &self,
        send: &mut iroh::endpoint::SendStream,
        m: &Msg,
    ) -> Result<(), String> {
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

    async fn read_all(&self, recv: &mut iroh::endpoint::RecvStream) -> Result<Vec<Msg>, String> {
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
            let m: Msg = serde_json::from_slice(&plain)
                .map_err(|e| format!("a frame was not one of ours: {e}"))?;
            out.push(m);
        }
    }
}
