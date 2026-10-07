//! What this network lets the flyway out through — run it at the desk you need
//! it to work from.
//!
//! The flyway has to carry frames between one person's machines, and which
//! transport it can use is a fact about the *network*, not about the code. On
//! this network the question is settled and uninteresting. On a corporate one
//! with Netskope's gateway in front of it, it decides the whole design, and
//! nothing on this desk can answer it:
//!
//! - **Does UDP get out at all?** QUIC is commonly dropped by web gateways
//!   precisely so browsers fall back to TCP that can be inspected. If it is
//!   dropped here, peer-to-peer (iroh, WebRTC, WireGuard) cannot hole-punch and
//!   everything has to go through a relay on TCP/443.
//! - **Does TLS on 443 validate?** This network intercepts it — `forge.rs`
//!   records the probe where `dev.azure.com` came back signed by
//!   `ca.macquarietelecom-103950.au.goskope.com` — so the only client that
//!   works here is one trusting the machine's own root store. `forge::tls`
//!   merges the native roots with `webpki-roots` because `load_native_certs()`
//!   returned *one* root out of forty-five on this machine, policy having
//!   EKU-restricted every built-in one. Any new network client that brings its
//!   own root set fails on exactly one network and works everywhere it is tested.
//!
//! ```powershell
//! cd src-tauri && cargo run --example flyway-probe
//! ```
//!
//! No API turn, no account, nothing written. Three connections to public hosts
//! and about five seconds. It reads the network it is run on and nothing else —
//! there is no traffic here that is not an ordinary HTTPS client doing what an
//! ordinary HTTPS client does, which is also the posture the transport will
//! take: the gateway's job is to inspect, and the answer to a blocked
//! destination is to have it allowlisted rather than to dress the traffic up as
//! something else.

use std::io::Write;
use std::net::{ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// Public STUN servers — the cheapest honest test of whether a UDP datagram
/// reaches the internet and something comes back. Two, because one being down
/// is not the same answer as UDP being blocked, and a probe that cannot tell
/// those apart is a probe that reports a network fault as a policy.
const STUN: &[(&str, &str)] = &[
    ("stun.l.google.com:19302", "google"),
    ("stun.cloudflare.com:3478", "cloudflare"),
];

/// Hosts to open TLS to. `cloudflare.com` is an ordinary public site; the other
/// two are what the flyway and the app actually dial, so a gateway that
/// categorises them differently shows up as a difference here.
const TLS_HOSTS: &[&str] = &["cloudflare.com", "api.github.com", "dev.azure.com"];

fn main() {
    println!("flyway probe — what this network lets out\n");

    let udp = probe_udp();
    println!();
    let tls = probe_tls();

    println!("\n=== what this run established ===");
    match (udp, tls) {
        (true, true) => {
            println!("UDP gets out and TLS validates. Both transports are open here:");
            println!("peer-to-peer (iroh) will hole-punch and fall back to its own relay,");
            println!("and a TCP/443 relay works as a floor under it. Prefer P2P — on one");
            println!("LAN it is ~1ms where a relay is a round trip through a datacentre.");
        }
        (false, true) => {
            println!("UDP is blocked and TLS validates. **This is the Netskope case**, and");
            println!("it is the one the transport has to be built for: no hole-punching, so");
            println!("every frame goes over TCP/443 through a relay, and the client must use");
            println!("`forge::tls`'s merged root store or it fails here and nowhere else.");
            println!("P2P can still be added later as a fast path for machines that can.");
        }
        (true, false) => {
            println!("UDP gets out but TLS did not validate, which is the surprising pair.");
            println!("Read the issuers above: if they name a gateway CA, this machine does");
            println!("not trust its own interception root and nothing HTTPS will work from");
            println!("it — which is an IT question rather than a flyway one.");
        }
        (false, false) => {
            println!("Neither got out. Either this machine has no route at all, or the");
            println!("gateway is refusing both — check a browser on the same box before");
            println!("concluding anything about the flyway.");
        }
    }
}

/// Can a datagram leave and something come back?
fn probe_udp() -> bool {
    println!("UDP — can a datagram reach the internet and be answered?");
    let mut any = false;
    for (addr, who) in STUN {
        match stun_round_trip(addr) {
            Ok(ms) => {
                println!("  {:<28} answered in {ms}ms", format!("{who} ({addr})"));
                any = true;
            }
            Err(e) => println!("  {:<28} {e}", format!("{who} ({addr})")),
        }
    }
    if !any {
        println!("  → no UDP out. Hole-punching is not available on this network.");
    }
    any
}

/// A STUN binding request, which is 20 bytes and needs no library: a header of
/// type 0x0001, length 0, the magic cookie, and twelve random-ish bytes of
/// transaction id. Anything that answers with our transaction id proves the
/// round trip, and that is the whole of what is being asked.
fn stun_round_trip(addr: &str) -> Result<u128, String> {
    let target = addr
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve: {e}"))?
        .find(|a| a.is_ipv4())
        .ok_or("no IPv4 address")?;

    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("could not open a socket: {e}"))?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok();

    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
    req.extend_from_slice(&[0x21, 0x12, 0xA4, 0x42]);
    let tx: [u8; 12] = std::array::from_fn(|i| (i as u8).wrapping_mul(37).wrapping_add(11));
    req.extend_from_slice(&tx);

    let began = Instant::now();
    sock.send_to(&req, target).map_err(|e| format!("send refused: {e}"))?;

    let mut buf = [0u8; 256];
    match sock.recv_from(&mut buf) {
        Ok((n, _)) if n >= 20 && buf[8..20] == tx => Ok(began.elapsed().as_millis()),
        Ok((n, _)) => Err(format!("answered {n} bytes that were not ours")),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
            || e.kind() == std::io::ErrorKind::TimedOut =>
        {
            Err("no answer in 3s — blocked, or dropped silently".into())
        }
        Err(e) => Err(format!("{e}")),
    }
}

/// Does an ordinary HTTPS request work, and who signed it?
///
/// Through `ureq` with the app's own TLS config, so what is being tested is
/// exactly the client the transport will use rather than a different one that
/// happens to agree.
fn probe_tls() -> bool {
    println!("TLS on 443 — does an ordinary HTTPS client work here?");
    let agent = ureq::AgentBuilder::new()
        .tls_config(skein_lib::forge::tls_config())
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(8))
        .build();

    let mut ok = 0;
    for host in TLS_HOSTS {
        let began = Instant::now();
        let url = format!("https://{host}/");
        match agent.get(&url).call() {
            Ok(r) => {
                println!(
                    "  {:<22} {} in {}ms",
                    host,
                    r.status(),
                    began.elapsed().as_millis()
                );
                ok += 1;
            }
            /* A 4xx is the server answering, which is all this asks. Only a
               transport error is a failure here. */
            Err(ureq::Error::Status(code, _)) => {
                println!("  {:<22} {code} in {}ms (answered — fine)", host, began.elapsed().as_millis());
                ok += 1;
            }
            Err(e) => println!("  {:<22} {e}", host),
        }
        std::io::stdout().flush().ok();
    }
    if ok == 0 {
        println!("  → nothing validated. If this machine browses the web, the root store");
        println!("    is the difference: see `forge::tls` and the merge it does.");
    }
    ok > 0
}
