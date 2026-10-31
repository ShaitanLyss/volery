//! What a screen's connection actually carries: throughput, per-frame latency
//! and round trip, on a direct path and through n0's relay, under BBR and Cubic.
//!
//! ```powershell
//! cd src-tauri && cargo run --release --example cast-flyway-probe            # every arm
//! cd src-tauri && cargo run --release --example cast-flyway-probe -- direct  # one arm
//! ```
//!
//! Both ends are in one process, so a frame's latency is exact — one clock
//! stamps it on the way out and reads it on the way in — and the bytes are the
//! real ones: `flyway::cast`'s keys off the connection's exporter, its sealed
//! messages, a uni stream per frame, the video header `cast::wire` writes, and
//! `wire::cast_transport` for the Cubic arms (what ships). What it cannot tell you is another
//! network: a direct arm here is loopback, and the relay arm is n0's relay from
//! *this* machine to itself — the relay's own throughput, which is the number
//! the relay cap in `cast.rs` rests on.
//!
//! It reaches the network (n0's relays and lookup), so it is an example, not a
//! test — `flyway-link.rs`'s reasoning.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iroh::endpoint::{presets, Connection, QuicTransportConfig, VarInt};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, SecretKey};
use skein_lib::cast::wire::{read_video, video, VideoHeader};
use skein_lib::flyway::cast as fc;
use skein_lib::flyway::seal::WallKey;
use skein_lib::flyway::wire::cast_transport;

const KEY: [u8; 32] = [42u8; 32];

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros() as u64
}

#[derive(Clone, Copy)]
struct Arm {
    name: &'static str,
    relay_only: bool,
    bbr: bool,
}

/// `wire::cast_transport` (Cubic, as shipped), or the same settings under BBR.
fn transport(bbr: bool) -> QuicTransportConfig {
    if !bbr {
        return cast_transport();
    }
    QuicTransportConfig::builder()
        .congestion_controller_factory(Arc::new(noq_proto::congestion::Bbr3Config::default()))
        .keep_alive_interval(Duration::from_secs(1))
        .send_fairness(false)
        .max_concurrent_uni_streams(VarInt::from_u32(1024))
        .stream_receive_window(VarInt::from_u32(8 * 1024 * 1024))
        .send_window(32 * 1024 * 1024)
        .build()
}

async fn endpoint(seed: u8, arm: Arm) -> Endpoint {
    let mut b = Endpoint::builder(presets::N0)
        .secret_key(SecretKey::from_bytes(&[seed; 32]))
        .ca_tls_config(CaTlsConfig::system())
        .alpns(vec![fc::ALPN.to_vec()])
        .transport_config(transport(arm.bbr));
    if arm.relay_only {
        b = b.clear_ip_transports();
    }
    b.bind().await.expect("bind")
}

fn keys(conn: &Connection, viewer: bool) -> (fc::Sealer, fc::Opener) {
    let mut ex = [0u8; 32];
    conn.export_keying_material(&mut ex, fc::EXPORTER_LABEL, b"").expect("exporter");
    fc::keys(&WallKey::from_bytes(KEY), &ex, viewer).expect("keys")
}

fn path_of(conn: &Connection) -> String {
    let paths = conn.paths();
    paths
        .iter()
        .find(|p| p.is_selected())
        .map(|p| format!("{} rtt {:.1}ms", if p.is_relay() { "relay" } else { "direct" }, p.rtt().as_secs_f64() * 1000.0))
        .unwrap_or_else(|| "no path".into())
}

/// Send `n` frames of `size` bytes, one stream each, `gap` apart (zero: as
/// fast as the connection takes them). Returns when all are written.
async fn send_frames(conn: Connection, seal: Arc<fc::Sealer>, n: u32, size: usize, gap: Duration) {
    let payload = vec![0x5au8; size];
    let start = Instant::now();
    let mut tasks = Vec::new();
    for seq in 0..n {
        if !gap.is_zero() {
            let due = start + gap * seq;
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                tokio::time::sleep(wait).await;
            }
        }
        let h = VideoHeader { key: seq % 120 == 0, w: 1920, h: 1080, seq, capture_us: now_us(), encoded_us: now_us() };
        let msg = seal.seal(fc::K_BIN, 1, &video(&h, &payload)).unwrap();
        let conn = conn.clone();
        tasks.push(tokio::spawn(async move {
            let mut s = conn.open_uni().await.unwrap();
            s.write_all(&fc::prefix(msg.len()).unwrap()).await.unwrap();
            s.write_all(&msg).await.unwrap();
            s.finish().unwrap();
            let _ = s.stopped().await;
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}

/// Read frames until `n` have arrived or `within` passes; latencies in µs.
async fn read_frames(conn: Connection, open: Arc<fc::Opener>, n: u32, within: Duration) -> (Vec<u64>, u64, Duration) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let reader = {
        let conn = conn.clone();
        tokio::spawn(async move {
            while let Ok(mut r) = conn.accept_uni().await {
                let (open, tx) = (open.clone(), tx.clone());
                tokio::spawn(async move {
                    let mut len = [0u8; 4];
                    if r.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let mut buf = vec![0u8; fc::announced(len).unwrap()];
                    if r.read_exact(&mut buf).await.is_err() {
                        return;
                    }
                    let o = open.open(buf).unwrap();
                    let (h, body) = read_video(o.body()).unwrap();
                    let _ = tx.send((now_us().saturating_sub(h.capture_us), body.len() as u64));
                });
            }
        })
    };
    let start = Instant::now();
    let (mut lat, mut bytes) = (Vec::new(), 0u64);
    while lat.len() < n as usize {
        match tokio::time::timeout(within.saturating_sub(start.elapsed()), rx.recv()).await {
            Ok(Some((l, b))) => {
                lat.push(l);
                bytes += b;
            }
            _ => break,
        }
    }
    reader.abort();
    (lat, bytes, start.elapsed())
}

fn pct(v: &mut [u64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_unstable();
    v[((v.len() - 1) as f64 * p).round() as usize] as f64 / 1000.0
}

async fn ping(conn: &Connection, seal: &fc::Sealer, open: &fc::Opener, host: Connection, host_seal: Arc<fc::Sealer>, host_open: Arc<fc::Opener>) -> Vec<u64> {
    let echo = tokio::spawn(async move {
        while let Ok(d) = host.read_datagram().await {
            let o = host_open.open(d.to_vec()).unwrap();
            let t = fc::read_ping(o.body()).unwrap();
            let m = host_seal.seal(fc::K_PONG, 0, &fc::pong(t, now_us())).unwrap();
            let _ = host.send_datagram(bytes::Bytes::from(m));
        }
    });
    let mut rtts = Vec::new();
    let mut clock = fc::Clock::default();
    for _ in 0..20 {
        let m = seal.seal(fc::K_PING, 0, &now_us().to_le_bytes()).unwrap();
        conn.send_datagram(bytes::Bytes::from(m)).unwrap();
        if let Ok(Ok(d)) = tokio::time::timeout(Duration::from_secs(2), conn.read_datagram()).await {
            let o = open.open(d.to_vec()).unwrap();
            let (sent, h) = fc::read_pong(o.body()).unwrap();
            let back = now_us();
            clock.sample(sent, h, back);
            rtts.push(back - sent);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    echo.abort();
    println!("    clock offset (same clock, so should be ~0): {:?} µs", clock.offset_us());
    rtts
}

async fn run(arm: Arm) {
    println!("\n== {} ==", arm.name);
    let host = endpoint(1, arm).await;
    let viewer = endpoint(2, arm).await;
    host.online().await;
    viewer.online().await;
    let accept = {
        let host = host.clone();
        tokio::spawn(async move { host.accept().await.unwrap().await.unwrap() })
    };
    let t = Instant::now();
    let v = viewer.connect(host.addr(), fc::ALPN).await.expect("connect");
    let h = accept.await.unwrap();
    println!("    connected in {:?}, path {}", t.elapsed(), path_of(&v));
    if !arm.relay_only {
        /* Give hole-punching (here: loopback discovery) a moment to take the
           connection off the relay it starts on. */
        tokio::time::sleep(Duration::from_secs(2)).await;
        println!("    after 2s, path {}", path_of(&v));
    }
    let (v_seal, v_open) = keys(&v, true);
    let (h_seal, h_open) = keys(&h, false);
    let (h_seal, h_open) = (Arc::new(h_seal), Arc::new(h_open));

    let mut rtts = ping(&v, &v_seal, &v_open, h.clone(), h_seal.clone(), h_open.clone()).await;
    println!("    datagram ping rtt p50 {:.2} ms, p95 {:.2} ms ({} of 20)", pct(&mut rtts, 0.5), pct(&mut rtts, 0.95), rtts.len());

    let v_open = Arc::new(v_open);
    /* Paced like a screen: 60 fps, 1080p-sized frames. On a relay, what the
       cap allows instead: 15 fps of ~6.6 KB (800 kbit/s). */
    let (n, size, gap) = if arm.relay_only { (60, 6_600, Duration::from_millis(66)) } else { (240, 100_000, Duration::from_micros(16_667)) };
    let reading = tokio::spawn(read_frames(v.clone(), v_open.clone(), n, Duration::from_secs(20)));
    send_frames(h.clone(), h_seal.clone(), n, size, gap).await;
    let (mut lat, bytes, took) = reading.await.unwrap();
    println!(
        "    paced {}×{} KB at {:.0} fps: {} arrived, latency p50 {:.2} ms p95 {:.2} ms max {:.2} ms, {:.1} Mbit/s",
        n,
        size / 1000,
        1.0 / gap.as_secs_f64(),
        lat.len(),
        pct(&mut lat, 0.5),
        pct(&mut lat, 0.95),
        pct(&mut lat, 1.0),
        bytes as f64 * 8.0 / took.as_secs_f64() / 1e6
    );

    /* Burst: as fast as the connection takes them — the path's throughput. */
    let (n, size) = if arm.relay_only { (40, 64_000) } else { (200, 256_000) };
    let reading = tokio::spawn(read_frames(v.clone(), v_open.clone(), n, Duration::from_secs(60)));
    let t = Instant::now();
    send_frames(h.clone(), h_seal.clone(), n, size, Duration::ZERO).await;
    let (mut lat, bytes, _) = reading.await.unwrap();
    let took = t.elapsed();
    println!(
        "    burst {}×{} KB: {} arrived in {:.2}s → {:.1} Mbit/s, latency p50 {:.1} ms max {:.1} ms; path {}",
        n,
        size / 1000,
        lat.len(),
        took.as_secs_f64(),
        bytes as f64 * 8.0 / took.as_secs_f64() / 1e6,
        pct(&mut lat, 0.5),
        pct(&mut lat, 1.0),
        path_of(&v)
    );
    v.close(0u32.into(), b"done");
    h.close(0u32.into(), b"done");
    viewer.close().await;
    host.close().await;
}

fn main() {
    tauri::async_runtime::block_on(arms());
}

async fn arms() {
    let only = std::env::args().nth(1);
    let arms = [
        Arm { name: "direct, bbr", relay_only: false, bbr: true },
        Arm { name: "direct, cubic", relay_only: false, bbr: false },
        Arm { name: "relay, bbr", relay_only: true, bbr: true },
        Arm { name: "relay, cubic", relay_only: true, bbr: false },
    ];
    for arm in arms {
        if only.as_deref().is_some_and(|o| !arm.name.starts_with(o)) {
            continue;
        }
        if tokio::time::timeout(Duration::from_secs(120), run(arm)).await.is_err() {
            println!("    timed out");
        }
    }
}
