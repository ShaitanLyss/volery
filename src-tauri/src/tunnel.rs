//! An IPv4-first `CONNECT` tunnel on loopback, so librespot can reach Spotify.
//!
//! This exists for one measured reason. librespot's `socket::connect` is:
//!
//! ```ignore
//! let socket_addr = (host, port).to_socket_addrs()?.next().ok_or_else(...)?;
//! TcpStream::connect(&socket_addr).await?
//! ```
//!
//! **`.next()` — the first address `getaddrinfo` returns, and never another.**
//! No Happy Eyeballs, no iteration, no fallback. That is fine until one address
//! family does not answer, and on the network this was found on it does not:
//! probed 2026-08-28, every `ap-*.spotify.com` AAAA record times out (21s, WSAETIMEDOUT)
//! while the A record beside it opens in 30-46ms, and `getaddrinfo` returns the
//! AAAA first. So every access point black-holed, on every port, and
//! `Session::connect` took **253 seconds** to exhaust six of them and give up.
//!
//! Note what it is *not*: this machine's IPv6 works — `ipv6.google.com` answers
//! in 71ms and `dealer.spotify.com` answers over IPv6 in 32ms. It is Spotify's
//! access-point addresses specifically. That distinction matters because it is
//! what makes preferring IPv4 a fix rather than a superstition: there is a
//! working address in the list and librespot simply never reaches it.
//!
//! ### Why a proxy rather than a patch
//!
//! `SessionConfig` has six fields and not one of them is about addresses, so
//! there is no way to tell librespot which family to prefer. But `proxy` changes
//! *which host librespot resolves*: it dials the proxy — `127.0.0.1`, which has
//! exactly one address and no ambiguity — and asks it over HTTP `CONNECT` to
//! reach the access point on its behalf. **The address decision moves to code we
//! own**, which is this file, and librespot is left on a supported path.
//!
//! The alternative was vendoring `librespot-core` and fixing `socket.rs` to
//! iterate. It is the smaller diff and it was not chosen: `spotify.md` already
//! argues that a protocol reimplementation tracks a moving target, and a fork of
//! one is a thing that has to be re-merged forever for four lines. A supported
//! config field costs nothing at upgrade time.
//!
//! Measured on the same network, same session, minutes apart:
//!
//! | | |
//! |---|---|
//! | librespot, direct | 253s, then "Tried too many access points" |
//! | through this, `ap_port` 4070 | **connected in 1.94s** |
//! | through this, `ap_port` 443 | **connected in 1.27s** |
//!
//! ### The trap that comes with it, and it is silent
//!
//! Setting `proxy` **also changes which access-point ports librespot will
//! consider**, and nothing says so at the call site. `ApResolver::port_config`:
//!
//! ```ignore
//! if self.session().config().proxy.is_some() || self.session().config().ap_port.is_some() {
//!     Some(self.session().config().ap_port.unwrap_or(443))
//! } else { None }
//! ```
//!
//! A proxy with no `ap_port` therefore filters the whole list down to port 443
//! and throws away Spotify's own preference order (4070, then 443, then 80). So
//! `spotify.rs` sets `ap_port` explicitly and tries the ladder itself — see
//! `AP_PORTS` there. Anyone setting `proxy` here without an `ap_port` has
//! silently picked 443 for everybody.
//!
//! ### Bounds
//!
//! **Loopback only.** This forwards to wherever the client names, so a listener
//! reachable from off the machine would be an open relay. `127.0.0.1` is not a
//! preference.
//!
//! **One listener for the process**, brought up by the first session that asks
//! and then reused — the same shape the performance sampler and the workflow
//! poller use for the same reason. It holds no Tauri subscription and spawns no
//! child process, so neither the release rule nor the job-object rule has
//! anything to bite on here; what it holds is one tokio task per live
//! connection, each ending when its connection does.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// The port the tunnel is on, once something has asked for it.
static PORT: Mutex<Option<u16>> = Mutex::new(None);

/// Where librespot should send its `CONNECT`s, bringing the tunnel up if this is
/// the first ask.
///
/// The bind is `std`'s rather than tokio's on purpose: it is synchronous and
/// instant, which means the whole of "have we got one yet, and if not make one"
/// happens under a plain `Mutex` with no `await` inside it. Two cards starting a
/// session at the same moment therefore get one listener rather than a race for
/// which of two is remembered.
pub(crate) fn endpoint() -> Result<url::Url, String> {
    let port = ensure()?;
    url::Url::parse(&format!("http://127.0.0.1:{port}"))
        .map_err(|e| format!("could not address the loopback tunnel: {e}"))
}

fn ensure() -> Result<u16, String> {
    let mut held = PORT
        .lock()
        .map_err(|_| "the tunnel's port is poisoned".to_string())?;
    if let Some(port) = *held {
        return Ok(port);
    }

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("could not open a loopback tunnel: {e}"))?;
    /* `TcpListener::from_std` requires it, and a blocking listener handed to
       tokio would park a worker thread on `accept` — which is the freeze this
       codebase already has a rule about. */
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not make the tunnel non-blocking: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("the tunnel has no address: {e}"))?
        .port();

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                log_line(&format!("could not adopt the listener: {e}"));
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((client, _)) => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = serve(client).await {
                            log_line(&format!("{e}"));
                        }
                    });
                }
                Err(e) => {
                    /* The listener itself is gone; there is nothing to retry
                       onto. Clearing the port lets the next session bring a
                       fresh one up rather than dialling a dead one forever. */
                    log_line(&format!("stopped accepting: {e}"));
                    if let Ok(mut held) = PORT.lock() {
                        *held = None;
                    }
                    return;
                }
            }
        }
    });

    *held = Some(port);
    Ok(port)
}

/// Nowhere to put this yet — the app installs no `log` sink at all, which is the
/// gap that made the failure above take a scratch crate and two sign-ins to
/// diagnose. Kept as one function so that when a sink exists this is one edit.
/// See the sink item.
fn log_line(what: &str) {
    let _ = what;
    #[cfg(debug_assertions)]
    eprintln!("skein: spotify tunnel: {what}");
}

/// Split a `CONNECT` target into host and port.
///
/// `rsplit_once` rather than `split_once`, because an IPv6 literal target is
/// mostly colons and the port is the field after the *last* of them — splitting
/// forwards reads `[::1]:4070` as host `[` and port `:1]:4070`.
///
/// A named function rather than three lines inside `serve` so that the
/// assertions below are about *this* code. An assertion that restates its
/// subject is documentation; see sink `0b97adde`.
fn split_target(target: &str) -> Option<(&str, u16)> {
    let (host, port) = target.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host, port.parse::<u16>().ok()?))
}

/// Put IPv4 addresses ahead of IPv6, and change nothing else.
///
/// **Sorted rather than filtered**, and that is the load-bearing half: a host
/// with only AAAA records has to go on working, and `dealer.spotify.com`
/// answers over IPv6 in 32ms on the very network that made this file necessary.
/// Stable within a family, so the resolver's own preference among several A
/// records survives.
fn prefer_ipv4(addrs: &mut [SocketAddr]) {
    addrs.sort_by_key(|a| match a.ip() {
        IpAddr::V4(_) => 0,
        IpAddr::V6(_) => 1,
    });
}

async fn serve(client: TcpStream) -> io::Result<()> {
    let mut reader = BufReader::new(client);

    /* `CONNECT ap-gae2.spotify.com:4070 HTTP/1.1`, then a blank line — that is
       literally all librespot sends (`proxytunnel.rs` writes the request line
       and `\r\n\r\n` with no headers at all). Read to the blank line anyway
       rather than assuming the absence, so a future librespot that adds a `Host`
       does not arrive here as a protocol error. */
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header).await?;
        if n == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default().to_string();
    if !method.eq_ignore_ascii_case("CONNECT") {
        return refuse(reader.into_inner(), 405, "only CONNECT").await;
    }

    let Some((host, port)) = split_target(&target).map(|(h, p)| (h.to_string(), p)) else {
        return refuse(reader.into_inner(), 400, "bad target").await;
    };

    /* The whole point of the file. Every address rather than the first, IPv4
       ahead of IPv6 rather than in whatever order the resolver felt like — so a
       host whose AAAA is a black hole still connects, and a host with no A
       record at all still works, which is why this sorts rather than filters. */
    let mut addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await?
        .collect();
    prefer_ipv4(&mut addrs);
    if addrs.is_empty() {
        return refuse(reader.into_inner(), 502, "no address").await;
    }

    let mut upstream = None;
    for addr in &addrs {
        match TcpStream::connect(addr).await {
            Ok(socket) => {
                upstream = Some(socket);
                break;
            }
            Err(e) => log_line(&format!("{host}:{port} via {addr}: {e}")),
        }
    }
    let Some(mut upstream) = upstream else {
        log_line(&format!("{host}:{port}: no address answered"));
        return refuse(reader.into_inner(), 502, "upstream unreachable").await;
    };

    let mut client = reader.into_inner();
    client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await?;

    /* Nothing the client sent is stranded in the `BufReader`: `proxy_connect`
       returns only once it has parsed our response, so librespot writes its
       first protocol byte strictly after the 200 above. */
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

async fn refuse(mut client: TcpStream, code: u16, why: &str) -> io::Result<()> {
    /* A `content-length: 0` rather than a body, because the only reader of this
       is `httparse` inside librespot and it wants a complete response to report
       a reason from. */
    let response = format!("HTTP/1.1 {code} {why}\r\ncontent-length: 0\r\n\r\n");
    client.write_all(response.as_bytes()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sort is the fix, so it is the thing asserted.
    #[test]
    fn ipv4_comes_first_and_nothing_is_dropped() {
        let mut addrs: Vec<SocketAddr> = vec![
            "[2405:6e00:64::68c7:f1ca]:4070".parse().unwrap(),
            "104.199.241.202:4070".parse().unwrap(),
            "[2600:1901:1:292::]:4070".parse().unwrap(),
            "35.186.224.24:4070".parse().unwrap(),
        ];
        prefer_ipv4(&mut addrs);

        assert!(addrs[0].is_ipv4(), "an IPv4 address has to be tried first");
        assert!(addrs[1].is_ipv4());
        assert!(addrs[2].is_ipv6());
        assert!(addrs[3].is_ipv6());
        /* Sorted, not filtered: a host with only AAAA records must still work. */
        assert_eq!(addrs.len(), 4);
        /* Stable within a family, so the resolver's own order survives. */
        assert_eq!(addrs[0].ip().to_string(), "104.199.241.202");
        assert_eq!(addrs[2].ip().to_string(), "2405:6e00:64::68c7:f1ca");
    }

    /// A host with no A record at all is the case a filter would have broken,
    /// and `dealer.spotify.com` reaching Spotify over IPv6 on the network this
    /// was found on is why that is not hypothetical.
    #[test]
    fn an_ipv6_only_host_is_left_alone() {
        let mut addrs: Vec<SocketAddr> = vec![
            "[2600:1901:1:292::]:443".parse().unwrap(),
            "[2405:6e00:64::1]:443".parse().unwrap(),
        ];
        prefer_ipv4(&mut addrs);
        assert_eq!(addrs.len(), 2);
        assert_eq!(addrs[0].ip().to_string(), "2600:1901:1:292::");
    }

    #[test]
    fn a_target_is_split_on_its_last_colon() {
        assert_eq!(
            split_target("ap-gae2.spotify.com:4070"),
            Some(("ap-gae2.spotify.com", 4070))
        );
        /* The reason it is `rsplit_once`: forwards, this reads as host `[`. */
        assert_eq!(split_target("[2405:6e00:64::1]:443"), Some(("[2405:6e00:64::1]", 443)));
    }

    #[test]
    fn a_malformed_target_is_refused_rather_than_guessed() {
        assert_eq!(split_target("ap-gae2.spotify.com"), None, "no port at all");
        assert_eq!(split_target("ap-gae2.spotify.com:"), None, "empty port");
        assert_eq!(split_target(":4070"), None, "empty host");
        assert_eq!(split_target("ap-gae2.spotify.com:https"), None, "port is not a number");
        assert_eq!(split_target("ap-gae2.spotify.com:70000"), None, "port does not fit a u16");
    }
}
