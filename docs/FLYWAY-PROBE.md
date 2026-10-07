# Running the flyway probe at the office

**One errand, about five minutes, on the work machine.** It answers the single
question that decides how the flyway carries frames between your walls, and
nothing on the home machine can answer it — the whole point is that it reads
*the network it is run on*.

Written 2026-10-07 to be acted on by whoever is at that desk, including a card
with none of this conversation behind it.

---

## What to run

From a clone of this repo on the work machine:

```powershell
cd src-tauri
cargo run --example flyway-probe
```

That is the whole of it. No API turn, no account, no wall, nothing written to
disk, no window. Three connections to public hosts.

If the repo is not on that machine, any clone of `main` at or after `60a1882`
will do; `cargo run --example` needs the MSVC toolchain, which
`.claude/rules/build.md` covers if it is missing. Nothing else in the app has
to build — it is a lib example.

## What it is asking, and why only that desk can say

The office network runs Netskope. Two of its behaviours decide the design:

1. **Does UDP get out?** Web gateways commonly drop QUIC so that browsers fall
   back to TCP they can inspect. If UDP is dropped, peer-to-peer — iroh,
   WebRTC, WireGuard — cannot hole-punch at all, and every frame has to go
   through a relay on TCP/443.
2. **Does TLS on 443 validate?** This network intercepts it. `forge.rs` records
   the probe where `dev.azure.com` came back signed by
   `ca.macquarietelecom-103950.au.goskope.com`, and `forge::tls` merges the
   native root store with `webpki-roots` because `load_native_certs()` returned
   *one* root out of forty-five on the home machine — policy had EKU-restricted
   every built-in one. The probe uses that exact TLS config, so what it tests is
   the client the transport will really use.

Note "Private Access" is not the thing being tested and does not matter here.
NPA is ZTNA — a tunnel to internal company apps — and carries no internet
traffic. Leave it on or off. What is always in the path is the gateway steering
ordinary web traffic, which is what this reads.

## What the answer means

The probe prints its own reading at the end. In short:

| UDP | TLS | What the flyway becomes |
|---|---|---|
| out | validates | Both open. Prefer peer-to-peer (iroh): ~1ms on one LAN where a relay is a round trip through a datacentre. A TCP/443 relay is the floor under it. |
| **blocked** | validates | **The expected case.** No hole-punching, so every frame goes TCP/443 through a relay, and the client must use `forge::tls`'s merged roots or it fails here and nowhere else. P2P can be added later as a fast path for machines that can. |
| out | fails | Surprising. Read the issuers it prints: if they name a gateway CA, that machine does not trust its own interception root, and nothing HTTPS works from it. An IT question, not a flyway one. |
| blocked | fails | Check a browser on the same box before concluding anything. |

## What to do with it

Paste the output back, or record it in the sink against
[`d1cc1c0d`](#) — actually, drop a **new** sink item titled
`flyway probe: what the office network allows` with the output in the body, so
it outlives whatever card reads it. `mcp__skein__drop`, kind `note`.

The decision it unblocks:

- **If UDP is blocked** (expected), the first transport is sealed frames over
  TCP/443 to a relay, and a relay has to exist. That is the next real choice —
  a small Cloudflare Worker, a VPS, or iroh's own relay infrastructure if its
  relay client can be handed our merged root store. None of that can be settled
  until the probe says UDP is out of the question.
- **If UDP gets out**, iroh goes in directly and no relay needs standing up:
  its node identity is a public key, which is already the flyway's model, and
  there is nothing to deploy.

## The one thing that does not change either way

Whatever the transport turns out to be, **the frames are sealed before they
reach it** — `src-tauri/src/flyway/seal.rs`, and everything above it assumes
the pipe is hostile. So this probe decides performance and deployment, not
security, and a wrong guess here costs a rewrite of one module rather than a
rethink.

That also settles the posture question: the traffic is an ordinary HTTPS client
doing ordinary HTTPS things, and the gateway's job is to inspect it. If a
destination turns out to be blocked by category, the answer is to have it
allowlisted, not to disguise the traffic.
