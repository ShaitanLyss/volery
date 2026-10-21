//! AMQP over a WebSocket, on 443.
//!
//! The AMQP WebSocket binding tunnels the byte stream through binary messages,
//! and Azure takes it at `wss://<namespace>/$servicebus/websocket` with the
//! `AMQPWSB10` subprotocol. The point of it here is the port: 5671 is the
//! first thing a corporate network closes and 443 is the last, and this machine
//! sits behind Netskope.
//!
//! **TLS is `forge::tls_config()`, and that is load-bearing.** Netskope
//! re-signs what it inspects with a CA that is in Windows' store and in no
//! bundled root set, and passes other hosts through untouched — so a client
//! trusting either set alone works for half the internet and fails for the
//! other half, depending on a policy nobody here can read (`forge.rs::tls`).
//! The merged set is the one that has been proven on this network.
//!
//! Blocking `tungstenite`, the crate `browser.rs` already uses, over a rustls
//! `StreamOwned`. The socket has a read timeout so that a read comes back to
//! the AMQP layer's clock (`conn.rs`); a timeout surfaces as `TimedOut` and
//! loses nothing, because tungstenite keeps a partial frame in its own buffer.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};
use ureq::rustls::{ClientConnection, StreamOwned};

pub type Tls = StreamOwned<ClientConnection, TcpStream>;

/// A WebSocket read and written as the byte stream it carries.
pub struct WsStream<S: Read + Write> {
    ws: WebSocket<S>,
    held: Vec<u8>,
    out: Vec<u8>,
}

impl<S: Read + Write> WsStream<S> {
    pub fn new(ws: WebSocket<S>) -> Self {
        WsStream { ws, held: Vec::new(), out: Vec::new() }
    }
}

fn io_of(e: tungstenite::Error) -> io::Error {
    match e {
        tungstenite::Error::Io(e) => e,
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
            io::Error::new(io::ErrorKind::UnexpectedEof, "the websocket closed")
        }
        other => io::Error::other(other.to_string()),
    }
}

impl<S: Read + Write> Read for WsStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.held.is_empty() {
            match self.ws.read() {
                Ok(Message::Binary(b)) => self.held.extend_from_slice(&b),
                /* Pings are answered by tungstenite itself; a text frame is
                   not part of the binding and carries nothing to read. */
                Ok(Message::Close(_)) => return Ok(0),
                Ok(_) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(0),
                Err(e) => return Err(io_of(e)),
            }
        }
        let n = buf.len().min(self.held.len());
        buf[..n].copy_from_slice(&self.held[..n]);
        self.held.drain(..n);
        Ok(n)
    }
}

impl<S: Read + Write> Write for WsStream<S> {
    /// Buffered until `flush`, so one AMQP frame — which `conn.rs` writes and
    /// then flushes — is one WebSocket message rather than several.
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.out.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if !self.out.is_empty() {
            let bytes = std::mem::take(&mut self.out);
            self.ws.send(Message::binary(bytes)).map_err(io_of)?;
        }
        Ok(())
    }
}

/// A handle that can cut the connection from another thread — the way a
/// receiver is stopped without it having to poll a flag.
pub struct Cutter(TcpStream);

impl Cutter {
    pub fn cut(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }
}

/// How long the TLS and WebSocket handshakes may take before the read timeout
/// is brought down to the receiver's tick.
const HANDSHAKE: Duration = Duration::from_secs(20);
const CONNECT: Duration = Duration::from_secs(15);

/// Dial `wss://host/$servicebus/websocket` and hand back the byte stream.
/// `tick` is the read timeout the AMQP layer will run on.
pub fn dial(host: &str, tick: Duration) -> io::Result<(WsStream<Tls>, Cutter)> {
    let addrs: Vec<_> = (host, 443).to_socket_addrs()?.collect();
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("{host} resolved to nothing"));
    let mut tcp = None;
    for a in addrs {
        match TcpStream::connect_timeout(&a, CONNECT) {
            Ok(s) => {
                tcp = Some(s);
                break;
            }
            Err(e) => last = e,
        }
    }
    let tcp = tcp.ok_or(last)?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(HANDSHAKE))?;
    tcp.set_write_timeout(Some(HANDSHAKE))?;
    let cutter = Cutter(tcp.try_clone()?);

    let name = ureq::rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    let tls = ClientConnection::new(crate::forge::tls_config(), name)
        .map_err(|e| io::Error::other(e.to_string()))?;
    let stream = StreamOwned::new(tls, tcp);

    let mut req = format!("wss://{host}/$servicebus/websocket")
        .into_client_request()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        tungstenite::http::HeaderValue::from_static("AMQPWSB10"),
    );
    let (ws, _response) = tungstenite::client(req, stream).map_err(|e| match e {
        tungstenite::HandshakeError::Failure(e) => io_of(e),
        tungstenite::HandshakeError::Interrupted(_) => {
            io::Error::new(io::ErrorKind::TimedOut, "the websocket handshake did not finish")
        }
    })?;
    ws.get_ref().sock.set_read_timeout(Some(tick))?;
    ws.get_ref().sock.set_write_timeout(Some(Duration::from_secs(30)))?;
    Ok((WsStream::new(ws), cutter))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The binding against a WebSocket server on a loopback socket: what one
    /// side writes and flushes is one binary message, and what arrives in
    /// several messages reads back as one stream.
    #[test]
    fn a_websocket_reads_and_writes_as_a_stream() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            let got = ws.read().unwrap();
            ws.send(Message::binary(b"AMQP".to_vec())).unwrap();
            ws.send(Message::binary(b"\x00\x01\x00\x00".to_vec())).unwrap();
            got
        });
        let tcp = TcpStream::connect(addr).unwrap();
        let (ws, _) = tungstenite::client(format!("ws://{addr}/"), tcp).unwrap();
        let mut s = WsStream::new(ws);
        s.write_all(b"AM").unwrap();
        s.write_all(b"QP\x00\x01\x00\x00").unwrap();
        s.flush().unwrap();
        let mut back = [0u8; 8];
        s.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"AMQP\x00\x01\x00\x00");
        let got = server.join().unwrap();
        assert_eq!(got, Message::binary(b"AMQP\x00\x01\x00\x00".to_vec()), "one flush, one message");
    }
}
