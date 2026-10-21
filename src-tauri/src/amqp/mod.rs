//! A minimal AMQP 1.0 client: enough to receive from Azure Event Hubs.
//!
//! Hand-rolled rather than the Azure SDK, by Lyss's approval of the design:
//! the SDK is async (a second runtime's worth of machinery under a thread that
//! only ever waits on one socket), large, and — the part that decides it on
//! this machine — would bring its own TLS stack, where every outbound client
//! here has to trust `forge::tls_config()`'s merged roots to get through the
//! Netskope interception at all. What a receiver needs of AMQP is small: SASL
//! ANONYMOUS, one session, request/response on `$cbs` and `$management`, and
//! receiver links with credit. That is these three files.
//!
//! - `codec` — the type system, frames and message sections, as bytes.
//! - `conn` — one connection and session as a state machine, generic over
//!   `Read + Write` so a test drives it against a fake broker.
//! - `ws` — the WebSocket binding on 443, over rustls.
//!
//! Event Hubs itself — the SAS token, the CBS handshake, partition ids, the
//! selector filter — is a layer up, in `eventhub.rs`.

pub mod codec;
pub mod conn;
pub mod ws;
