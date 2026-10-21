//! Azure Event Hubs, read over `amqp`: the first event source.
//!
//! A Fabric Eventstream's custom endpoint *is* an Event Hub — its connection
//! string is `Endpoint=sb://eventstream-….servicebus.windows.net/;
//! SharedAccessKeyName=key_…;SharedAccessKey=…;EntityPath=es_…` — so this one
//! client reads both.
//!
//! Every wire detail below was checked against the official SDKs' source and
//! Microsoft's AMQP protocol guide rather than written from memory (2026-10-21,
//! the research is summarised in `.claude/rules/subscriptions.md`):
//!
//! - **SAS**: the key is the UTF-8 bytes of the base64 text, *not* decoded;
//!   the string signed is the URL-encoded resource, a line feed, and the
//!   expiry in seconds; `sig` is URL-encoded again in the token. Every SDK
//!   does exactly this.
//! - **CBS**: SASL ANONYMOUS, then `put-token` on `$cbs` within twenty seconds
//!   of connecting or the service drops the connection. One token for
//!   `sb://<ns>/<hub>` covers every partition and the management node — "a SAS
//!   token is valid for all resources prefixed with the resource URI".
//! - **Partitions**: a `READ` on `$management`, `type` `com.microsoft:eventhub`,
//!   carrying the token again as `security_token`; the reply's body is a map
//!   with `partition_ids`, an array of strings.
//! - **Receivers**: `<hub>/ConsumerGroups/<cg>/Partitions/<id>`, no epoch —
//!   a non-epoch reader shares the partition with up to four others on the same
//!   consumer group, which is what lets several walls read one stream without a
//!   consumer group each. Positioned with the `apache.org:selector-filter:string`
//!   filter, descriptor `0x0000468C00000004`, the expression JS and Rust send.
//! - **Expiry**: the service drops the links when a token expires, so it is
//!   renewed on the same `$cbs` link at three quarters of its hour — no
//!   reconnect.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value as Json};

use crate::amqp::codec::{self, Message, Value};
use crate::amqp::conn::{Conn, Error, Event, Opts};
use crate::amqp::ws::{self, Cutter, Tls, WsStream};
use crate::subscribe::ledger::Start;
use crate::subscribe::sources::{Raw, Source};

/// How a source proves itself to the hub.
#[derive(Clone, PartialEq)]
enum Cred {
    /// A shared-access key, signed into a SAS token per connection.
    Key { name: String, key: String },
    /// A ready-made `SharedAccessSignature` — usable, and not renewable.
    Signature(String),
    /// A Microsoft Entra service principal: a client-credentials token for
    /// `https://eventhubs.azure.net/.default`, handed to CBS as a `jwt`.
    ///
    /// Added the day the first stream went live (2026-10-21): the tenant
    /// **disables SAS keys on Fabric Eventstream custom endpoints**, so the
    /// stream has no connection string at all and Entra ID is the only way in.
    /// Nova's Fabric service principal is the identity authorised to read it.
    Entra { tenant: String, client_id: String, secret: String },
}

/// The parts of a connection string this needs. The secret never leaves this
/// struct except as a signature or a token request.
///
/// An Event Hubs connection string is `Endpoint=sb://…;SharedAccessKeyName=…;
/// SharedAccessKey=…;EntityPath=…`. A source authorised by Entra ID has no
/// such string, so it is written in the same shape with the service
/// principal's three fields instead of the key — `Endpoint=sb://…;EntityPath=…;
/// TenantId=…;ClientId=…;ClientSecret=…` — which keeps it one secret, in one
/// vault entry, through one field in the panel.
#[derive(Clone, PartialEq)]
pub struct ConnString {
    pub host: String,
    pub entity: String,
    cred: Cred,
}

impl std::fmt::Debug for ConnString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let how = match &self.cred {
            Cred::Key { name, .. } => format!("key {name}"),
            Cred::Signature(_) => "a signature".to_string(),
            Cred::Entra { client_id, .. } => format!("entra {client_id}"),
        };
        write!(f, "ConnString({} / {}, {how})", self.host, self.entity)
    }
}

/// A credential as CBS takes it.
#[derive(Clone)]
pub struct Token {
    pub value: String,
    /// The CBS `type`: `servicebus.windows.net:sastoken` or `jwt`.
    pub kind: &'static str,
    /// When it stops working, in epoch milliseconds.
    pub expires_at: i64,
    /// Whether a fresh one can be made — a ready-made signature cannot.
    pub renewable: bool,
}

impl ConnString {
    /// Read one, refusing with a sentence a person can act on. A connection
    /// string with no `EntityPath` is a namespace-level one, which names no hub
    /// to read — Event Hubs' portal hands out both, and the namespace one is
    /// the one somebody copies by mistake.
    pub fn parse(s: &str) -> Result<ConnString, String> {
        let mut parts: HashMap<String, String> = HashMap::new();
        for seg in s.trim().split(';') {
            let seg = seg.trim();
            if seg.is_empty() {
                continue;
            }
            let Some((k, v)) = seg.split_once('=') else {
                return Err(format!("`{seg}` is not a key=value part of a connection string"));
            };
            parts.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
        let endpoint = parts
            .get("endpoint")
            .ok_or("the connection string has no Endpoint=sb://… part")?;
        let host = endpoint
            .trim_start_matches("sb://")
            .trim_start_matches("amqps://")
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_string();
        if host.is_empty() || host.contains('/') || host.contains(' ') {
            return Err(format!("the Endpoint {endpoint} does not name a namespace host"));
        }
        let entity = parts.get("entitypath").cloned().unwrap_or_default();
        if entity.is_empty() {
            return Err("the connection string has no EntityPath — that is the namespace's, \
                        and names no event hub to read. Copy the one from the hub (or the \
                        Eventstream's custom endpoint) itself."
                .into());
        }
        let get = |k: &str| parts.get(k).cloned().filter(|v| !v.is_empty());
        let entra = [get("tenantid"), get("clientid"), get("clientsecret")];
        let cred = if entra.iter().any(Option::is_some) {
            match entra {
                [Some(tenant), Some(client_id), Some(secret)] => Cred::Entra { tenant, client_id, secret },
                _ => {
                    return Err("an Entra ID source needs all three of TenantId, ClientId and \
                                ClientSecret beside Endpoint and EntityPath"
                        .into())
                }
            }
        } else if let Some(sig) = get("sharedaccesssignature") {
            Cred::Signature(sig)
        } else {
            match (get("sharedaccesskeyname"), get("sharedaccesskey")) {
                (Some(name), Some(key)) => Cred::Key { name, key },
                _ => {
                    return Err("the connection string needs SharedAccessKeyName and \
                                SharedAccessKey (or a SharedAccessSignature) — or, for a stream \
                                that takes Entra ID only, TenantId, ClientId and ClientSecret"
                        .into())
                }
            }
        };
        Ok(ConnString { host, entity, cred })
    }

    pub fn audience(&self) -> String {
        format!("sb://{}/{}", self.host, self.entity)
    }

    /// A credential for this hub, good for about an hour. Entra's is a
    /// network round trip to `login.microsoftonline.com`, so this is called on
    /// a runner thread or off the main thread, never on it.
    pub fn token(&self) -> Result<Token, String> {
        let now = crate::store::now();
        match &self.cred {
            Cred::Key { name, key } => {
                let expiry = (now / 1_000) as u64 + TOKEN_LIFE.as_secs();
                Ok(Token {
                    value: sas_token(&self.audience(), name, key, expiry),
                    kind: "servicebus.windows.net:sastoken",
                    expires_at: expiry as i64 * 1_000,
                    renewable: true,
                })
            }
            Cred::Signature(sig) => Ok(Token {
                value: sig.clone(),
                kind: "servicebus.windows.net:sastoken",
                expires_at: signature_expiry(sig).unwrap_or(now + TOKEN_LIFE.as_millis() as i64),
                renewable: false,
            }),
            Cred::Entra { tenant, client_id, secret } => {
                let (value, lasts) = entra_token(tenant, client_id, secret)?;
                Ok(Token { value, kind: "jwt", expires_at: now + lasts * 1_000, renewable: true })
            }
        }
    }
}

/// The `se=` of a ready-made signature, in epoch milliseconds.
fn signature_expiry(sig: &str) -> Option<i64> {
    sig.split(['&', ' '])
        .find_map(|p| p.strip_prefix("se="))
        .and_then(|v| v.parse::<i64>().ok())
        .map(|s| s * 1_000)
}

/// The scope a token for Event Hubs is asked for.
const EVENTHUBS_SCOPE: &str = "https://eventhubs.azure.net/.default";

/// A client-credentials token from Microsoft Entra ID: `(access_token,
/// seconds it lasts)`. Through `forge::agent`, which carries the merged roots
/// this network needs.
fn entra_token(tenant: &str, client_id: &str, secret: &str) -> Result<(String, i64), String> {
    let url = format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", encode(tenant));
    let res = crate::forge::agent().post(&url).send_form(&[
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", secret),
        ("scope", EVENTHUBS_SCOPE),
    ]);
    let body = match res {
        Ok(r) => r.into_string().map_err(|e| format!("reading Entra's answer: {e}"))?,
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            return Err(format!("Entra ID refused the service principal ({code}){}", entra_said(&body)));
        }
        Err(e) => return Err(format!("could not reach Entra ID: {e}")),
    };
    read_token_reply(&body)
}

/// The token and its lifetime out of Entra's JSON. Pure.
fn read_token_reply(body: &str) -> Result<(String, i64), String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "Entra ID answered with something that is not JSON".to_string())?;
    let token = v
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("Entra ID gave no token{}", entra_said(body)))?;
    let lasts = v
        .get("expires_in")
        .and_then(|e| e.as_i64().or_else(|| e.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(3_600);
    Ok((token.to_string(), lasts))
}

/// Entra's own first line of an error — `AADSTS7000215: Invalid client secret
/// provided…` names the fix, where a status code does not.
fn entra_said(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error_description").and_then(|d| d.as_str()).map(str::to_string))
        .and_then(|d| d.lines().next().map(|l| format!(": {}", l.trim())))
        .unwrap_or_default()
}

/// Percent-encode everything but the unreserved set — what
/// `encodeURIComponent` does, which is the JS SDK's choice.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn sas_token(resource: &str, key_name: &str, key: &str, expiry: u64) -> String {
    let sr = encode(resource);
    let signed = format!("{sr}\n{expiry}");
    let k = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key.as_bytes());
    let sig = crate::base64(ring::hmac::sign(&k, signed.as_bytes()).as_ref());
    format!("SharedAccessSignature sr={sr}&sig={}&se={expiry}&skn={}", encode(&sig), encode(key_name))
}

/// How long a token is minted for, and when it is replaced — the SDKs' own
/// hour, renewed at forty-five minutes as the JS one does.
const TOKEN_LIFE: Duration = Duration::from_secs(60 * 60);
const TOKEN_RENEW: Duration = Duration::from_secs(45 * 60);
/// The read timeout the socket runs on: how often a quiet receiver comes back
/// to look at its clock (heartbeat, renewal, a deadline). Not a poll of
/// anything — a socket blocked in a read costs nothing.
const TICK: Duration = Duration::from_secs(2);
/// The idle timeout this side states: the service must be heard from at least
/// this often, and twice it in silence is a dead connection. Both SDKs use 60s.
const IDLE: Duration = Duration::from_secs(60);
/// Link credit per partition. Rust's SDK prefetches 300.
const CREDIT: u32 = 300;
/// The selector filter's descriptor, as JS and Rust send it.
const SELECTOR: u64 = 0x0000_468C_0000_0004;

pub struct EventHub<S: Read + Write = WsStream<Tls>> {
    conn: Conn<S>,
    cutter: Option<Arc<Cutter>>,
    cs: ConnString,
    group: String,
    cbs: (u32, u32),
    cbs_reply: String,
    /// The credential CBS last accepted — also what `$management` is handed —
    /// and when to replace it; `None` for one that cannot be renewed.
    token: Option<Token>,
    renew_at: Option<Instant>,
    receivers: HashMap<u32, String>,
    /// Where each partition was last positioned and the last sequence it gave —
    /// what a link the service detached is re-attached from.
    position: HashMap<String, Start>,
    /// Re-attaches in the current minute, per partition: past a few, the
    /// connection is the problem and it is handed back to be redialled.
    reattached: HashMap<String, (Instant, u32)>,
}

impl EventHub {
    /// Dial, authenticate, and be ready to open partitions.
    pub fn connect(cs: &ConnString, group: &str) -> Result<EventHub, String> {
        let (stream, cutter) = ws::dial(&cs.host, TICK).map_err(|e| format!("could not reach {}: {e}", cs.host))?;
        EventHub::over(stream, Some(Arc::new(cutter)), cs, group)
    }
}

impl<S: Read + Write> EventHub<S> {
    /// The same over any byte stream — the wss one above, or a test's pipe.
    pub fn over(stream: S, cutter: Option<Arc<Cutter>>, cs: &ConnString, group: &str) -> Result<EventHub<S>, String> {
        let opts = Opts {
            container_id: format!("volery-{}", &crate::store::uuid_v4()[..8]),
            hostname: cs.host.clone(),
            idle: IDLE,
            patience: Duration::from_secs(30),
        };
        let mut conn = Conn::connect(stream, &opts).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let cbs_reply = format!("cbs-{}", crate::store::uuid_v4());
        let tx = conn.attach_sender("cbs-tx", "$cbs", deadline).map_err(|e| e.to_string())?;
        let rx = conn
            .attach_receiver(
                "cbs-rx",
                Value::described(codec::SOURCE, vec![Value::str("$cbs")]),
                &cbs_reply,
                None,
                10,
                deadline,
            )
            .map_err(|e| e.to_string())?;
        let mut hub = EventHub {
            conn,
            cutter,
            cs: cs.clone(),
            group: group.to_string(),
            cbs: (tx, rx),
            cbs_reply,
            token: None,
            renew_at: None,
            receivers: HashMap::new(),
            position: HashMap::new(),
            reattached: HashMap::new(),
        };
        hub.put_token(deadline)?;
        Ok(hub)
    }

    pub fn cutter(&self) -> Option<Arc<Cutter>> {
        self.cutter.clone()
    }

    fn put_token(&mut self, deadline: Instant) -> Result<(), String> {
        let token = self.cs.token()?;
        let req = put_token_message(&token, &self.cs.audience(), &self.cbs_reply);
        let reply = self
            .conn
            .request(self.cbs.0, self.cbs.1, &req, deadline)
            .map_err(|e| format!("authorising: {e}"))?;
        status(&reply, if token.kind == "jwt" { "the service refused the Entra token" } else { "the service refused the key" })?;
        /* Renewed at three quarters of its life — the JS SDK's 45 of 60
           minutes — and never sooner than a minute, so a token handed over
           nearly spent cannot turn this into a loop. */
        self.renew_at = token.renewable.then(|| {
            let left = (token.expires_at - crate::store::now()).max(0) as u64;
            Instant::now() + Duration::from_millis(left * 3 / 4).max(Duration::from_secs(60)).min(TOKEN_RENEW)
        });
        self.token = Some(token);
        Ok(())
    }

    fn read_partitions(&mut self) -> Result<Vec<String>, String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let reply_to = format!("mgmt-{}", crate::store::uuid_v4());
        let tx = self.conn.attach_sender("mgmt-tx", "$management", deadline).map_err(|e| e.to_string())?;
        let rx = self
            .conn
            .attach_receiver(
                "mgmt-rx",
                Value::described(codec::SOURCE, vec![Value::str("$management")]),
                &reply_to,
                None,
                10,
                deadline,
            )
            .map_err(|e| e.to_string())?;
        let security = self.token.as_ref().map(|t| t.value.clone()).unwrap_or_default();
        let req = Message {
            properties: vec![Value::Str(crate::store::uuid_v4()), Value::Null, Value::Null, Value::Null, Value::Str(reply_to)],
            application: vec![
                (Value::str("operation"), Value::str("READ")),
                (Value::str("name"), Value::Str(self.cs.entity.clone())),
                (Value::str("type"), Value::str("com.microsoft:eventhub")),
                (Value::str("security_token"), Value::Str(security)),
            ],
            ..Default::default()
        };
        let reply = self.conn.request(tx, rx, &req, deadline).map_err(|e| format!("reading the hub: {e}"))?;
        status(&reply, "the service would not describe the hub")?;
        let _ = self.conn.detach(tx);
        let _ = self.conn.detach(rx);
        let ids = reply
            .value
            .as_ref()
            .and_then(|v| v.get("partition_ids"))
            .map(|v| match v {
                Value::Array(a) | Value::List(a) => a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect(),
                _ => Vec::new(),
            })
            .unwrap_or_default();
        if ids.is_empty() {
            return Err("the hub described itself with no partitions".into());
        }
        Ok(ids)
    }

    fn attach(&mut self, partition: &str, from: Start) -> Result<u32, Error> {
        let address = format!("{}/ConsumerGroups/{}/Partitions/{}", self.cs.entity, self.group, partition);
        let source = Value::described(
            codec::SOURCE,
            vec![
                Value::Str(address),
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Map(vec![(
                    Value::sym("apache.org:selector-filter:string"),
                    Value::Described(Box::new(Value::Ulong(SELECTOR)), Box::new(Value::Str(selector(from)))),
                )]),
            ],
        );
        let name = format!("volery-{partition}-{}", &crate::store::uuid_v4()[..8]);
        let handle = self.conn.attach_receiver(
            &name,
            source,
            &name,
            None,
            CREDIT,
            Instant::now() + Duration::from_secs(20),
        )?;
        self.receivers.insert(handle, partition.to_string());
        self.position.insert(partition.to_string(), from);
        Ok(handle)
    }
}

/// The selector expression for a starting position.
pub fn selector(from: Start) -> String {
    match from {
        Start::After(seq) => format!("amqp.annotation.x-opt-sequence-number > '{seq}'"),
        Start::Since(ms) => format!("amqp.annotation.x-opt-enqueued-time > '{ms}'"),
    }
}

/// The CBS `put-token` request for a credential. Pure, so the two kinds of
/// token can be held to the wire shape without a hub.
fn put_token_message(token: &Token, audience: &str, reply_to: &str) -> Message {
    Message {
        properties: vec![
            Value::Str(crate::store::uuid_v4()),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Str(reply_to.to_string()),
        ],
        application: vec![
            (Value::str("operation"), Value::str("put-token")),
            (Value::str("type"), Value::str(token.kind)),
            (Value::str("name"), Value::Str(audience.to_string())),
            (Value::str("expiration"), Value::Timestamp(token.expires_at)),
        ],
        value: Some(Value::Str(token.value.clone())),
        ..Default::default()
    }
}

/// A management reply's verdict: any 2xx is yes, anything else is the
/// service's own words.
fn status(reply: &Message, what: &str) -> Result<(), String> {
    let code = reply
        .app("status-code")
        .or_else(|| reply.app("statusCode"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if (200..300).contains(&code) {
        return Ok(());
    }
    let said = reply
        .app("status-description")
        .or_else(|| reply.app("statusDescription"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Err(format!("{what} ({code}){}", if said.is_empty() { String::new() } else { format!(": {said}") }))
}

impl<S: Read + Write> Source for EventHub<S> {
    fn partitions(&mut self) -> Result<Vec<String>, String> {
        self.read_partitions()
    }

    fn open(&mut self, partition: &str, from: Start) -> Result<(), String> {
        self.attach(partition, from).map(|_| ()).map_err(|e| format!("partition {partition}: {e}"))
    }

    fn next(&mut self, deadline: Instant) -> Result<Option<Raw>, String> {
        loop {
            if self.renew_at.is_some_and(|at| Instant::now() >= at) {
                self.put_token(Instant::now() + Duration::from_secs(20))?;
            }
            /* A ready-made signature cannot be renewed, so its renewal time is
               no deadline: folding a passed one in made every wait `now`, and
               the loop spun a core without reading the socket again. */
            let wait = match self.renew_at {
                Some(at) => deadline.min(at.max(Instant::now())),
                None => deadline,
            };
            match self.conn.next(wait).map_err(|e| e.to_string())? {
                None if Instant::now() >= deadline => return Ok(None),
                None => continue,
                Some(Event::Message { handle, message }) => {
                    let Some(partition) = self.receivers.get(&handle).cloned() else { continue };
                    let Some(sequence) = message.annotation("x-opt-sequence-number").and_then(Value::as_i64) else {
                        continue;
                    };
                    let enqueued_at = message
                        .annotation("x-opt-enqueued-time")
                        .and_then(Value::as_i64)
                        .unwrap_or_else(crate::store::now);
                    self.position.insert(partition.clone(), Start::After(sequence));
                    let properties = message
                        .application
                        .iter()
                        .filter_map(|(k, v)| Some((k.as_str()?.to_string(), json_of(v))))
                        .collect();
                    let body = match (&message.data, &message.value) {
                        (Some(d), _) => d.clone(),
                        (None, Some(Value::Str(s))) => s.clone().into_bytes(),
                        (None, Some(Value::Binary(b))) => b.clone(),
                        (None, Some(v)) => json_of(v).to_string().into_bytes(),
                        (None, None) => Vec::new(),
                    };
                    return Ok(Some(Raw { partition, sequence, enqueued_at, properties, body }));
                }
                Some(Event::Detached { handle, error }) => {
                    let Some(partition) = self.receivers.remove(&handle) else {
                        if handle == self.cbs.0 || handle == self.cbs.1 {
                            return Err(format!(
                                "the service closed the authorisation link{}",
                                error.map(|e| format!(" — {e}")).unwrap_or_default()
                            ));
                        }
                        continue;
                    };
                    /* The service detaches an idle link after thirty minutes
                       and every link at a token's expiry; re-attach from where
                       it stood, unless it keeps happening, which means the
                       connection itself is the problem. */
                    let why = error.map(|e| e.to_string()).unwrap_or_else(|| "no reason given".into());
                    let now = Instant::now();
                    let entry = self.reattached.entry(partition.clone()).or_insert((now, 0));
                    if now.duration_since(entry.0) > Duration::from_secs(60) {
                        *entry = (now, 0);
                    }
                    entry.1 += 1;
                    if entry.1 > 3 {
                        return Err(format!("partition {partition} keeps being detached: {why}"));
                    }
                    let from = self.position.get(&partition).copied().unwrap_or(Start::Since(crate::store::now()));
                    self.attach(&partition, from).map_err(|e| format!("re-attaching partition {partition} after {why}: {e}"))?;
                }
            }
        }
    }

    fn close(&mut self) {
        self.conn.close();
        if let Some(c) = &self.cutter {
            c.cut();
        }
    }
}

/// An AMQP value as JSON, for a filter to read and a card to be handed.
pub fn json_of(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Str(s) | Value::Sym(s) => Json::String(s.clone()),
        Value::Ubyte(_) | Value::Ushort(_) | Value::Uint(_) | Value::Ulong(_) => {
            v.as_u64().map(Json::from).unwrap_or(Json::Null)
        }
        Value::Byte(_) | Value::Short(_) | Value::Int(_) | Value::Long(_) | Value::Timestamp(_) => {
            v.as_i64().map(Json::from).unwrap_or(Json::Null)
        }
        Value::Float(f) => Json::from(*f as f64),
        Value::Double(f) => Json::from(*f),
        Value::Char(c) => Json::String(c.to_string()),
        Value::Uuid(u) => Json::String(u.iter().map(|b| format!("{b:02x}")).collect()),
        Value::Binary(b) => Json::String(String::from_utf8_lossy(b).into_owned()),
        Value::Decimal(_) => Json::Null,
        Value::List(items) | Value::Array(items) => Json::Array(items.iter().map(json_of).collect()),
        Value::Map(pairs) => {
            let mut m = Map::new();
            for (k, v) in pairs {
                let key = k.as_str().map(str::to_string).unwrap_or_else(|| json_of(k).to_string());
                m.insert(key, json_of(v));
            }
            Json::Object(m)
        }
        Value::Described(_, inner) => json_of(inner),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fabric_eventstream_connection_string_is_read() {
        let cs = ConnString::parse(
            "Endpoint=sb://eventstream-1a2b3c.servicebus.windows.net/;SharedAccessKeyName=key_9f;\
             SharedAccessKey=abc+/def=;EntityPath=es_nova_feedback",
        )
        .unwrap();
        assert_eq!(cs.host, "eventstream-1a2b3c.servicebus.windows.net");
        assert_eq!(cs.entity, "es_nova_feedback");
        assert_eq!(cs.audience(), "sb://eventstream-1a2b3c.servicebus.windows.net/es_nova_feedback");
        /* The key never appears in anything printed. */
        assert!(!format!("{cs:?}").contains("abc+"));
    }

    #[test]
    fn a_namespace_connection_string_is_refused_with_why() {
        let e = ConnString::parse("Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=v").unwrap_err();
        assert!(e.contains("EntityPath"), "{e}");
        assert!(ConnString::parse("EntityPath=x").unwrap_err().contains("Endpoint"));
        assert!(ConnString::parse("Endpoint=sb://ns/;EntityPath=x").unwrap_err().contains("SharedAccessKey"));
    }

    /// The signature against one computed independently — with Python's
    /// `hmac`/`base64`/`urllib.parse.quote(safe='')`, the reference SDK's own
    /// primitives — for this exact resource, key and expiry.
    #[test]
    fn the_sas_token_is_the_one_the_sdks_make() {
        let t = sas_token("sb://ns.servicebus.windows.net/hub", "key_9f", "c2VjcmV0a2V5", 1_800_000_000);
        assert!(t.starts_with("SharedAccessSignature sr=sb%3A%2F%2Fns.servicebus.windows.net%2Fhub&sig="), "{t}");
        assert!(t.ends_with("&se=1800000000&skn=key_9f"), "{t}");
        let sig = t.split("&sig=").nth(1).unwrap().split('&').next().unwrap();
        assert_eq!(sig, EXPECTED_SIG, "{t}");
    }
    /// `python -c "import hmac,hashlib,base64,urllib.parse as u; r=u.quote('sb://ns.servicebus.windows.net/hub',safe='');
    /// print(u.quote(base64.b64encode(hmac.new(b'c2VjcmV0a2V5',(r+'\n1800000000').encode(),hashlib.sha256).digest()).decode(),safe=''))"`
    const EXPECTED_SIG: &str = "BX97zhsZ4x41X3kereq8VNhMkJdWW%2FiGx0BtF24owtw%3D";

    /// The stream that went live takes Entra ID only (SAS is disabled on the
    /// tenant's Eventstream endpoints), so its source is written with the
    /// service principal's three fields in place of a key.
    #[test]
    fn an_entra_source_is_read_and_its_secret_never_printed() {
        let cs = ConnString::parse(
            "Endpoint=sb://esehsywdq8b4703p87n53q.servicebus.windows.net/;\
             EntityPath=esehsywdq8b4703p87n53q_eh;TenantId=t-1;ClientId=16aac3c0;ClientSecret=s3cr3t~x",
        )
        .unwrap();
        assert_eq!(cs.audience(), "sb://esehsywdq8b4703p87n53q.servicebus.windows.net/esehsywdq8b4703p87n53q_eh");
        assert!(matches!(&cs.cred, Cred::Entra { client_id, .. } if client_id == "16aac3c0"));
        let shown = format!("{cs:?}");
        assert!(shown.contains("entra 16aac3c0") && !shown.contains("s3cr3t"), "{shown}");
        let half = ConnString::parse("Endpoint=sb://ns/;EntityPath=hub;TenantId=t;ClientId=c").unwrap_err();
        assert!(half.contains("all three"), "{half}");
    }

    #[test]
    fn a_jwt_goes_to_cbs_as_a_jwt() {
        let t = Token { value: "eyJ0eXAi".into(), kind: "jwt", expires_at: 1_787_000_000_000, renewable: true };
        let m = put_token_message(&t, "sb://ns/hub", "cbs-reply");
        assert_eq!(m.app("type").and_then(Value::as_str), Some("jwt"));
        assert_eq!(m.app("name").and_then(Value::as_str), Some("sb://ns/hub"));
        assert_eq!(m.app("expiration"), Some(&Value::Timestamp(1_787_000_000_000)));
        assert_eq!(m.value.as_ref().and_then(Value::as_str), Some("eyJ0eXAi"));
        assert_eq!(m.property(4).as_str(), Some("cbs-reply"));
    }

    #[test]
    fn entra_answers_are_read_for_the_token_and_the_reason() {
        assert_eq!(
            read_token_reply(r#"{"token_type":"Bearer","expires_in":3599,"access_token":"abc"}"#).unwrap(),
            ("abc".to_string(), 3599)
        );
        let e = read_token_reply(
            r#"{"error":"invalid_client","error_description":"AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x"}"#,
        )
        .unwrap_err();
        assert!(e.contains("AADSTS7000215: Invalid client secret provided."), "{e}");
        assert!(!e.contains("Trace ID"));
        assert_eq!(signature_expiry("SharedAccessSignature sr=x&sig=y&se=1800000000&skn=k"), Some(1_800_000_000_000));
    }

    #[test]
    fn the_selector_says_where_to_start() {
        assert_eq!(selector(Start::After(42)), "amqp.annotation.x-opt-sequence-number > '42'");
        assert_eq!(selector(Start::Since(1_787_000_000_000)), "amqp.annotation.x-opt-enqueued-time > '1787000000000'");
    }

    /// The whole client against a scripted hub on an in-memory pipe: CBS
    /// authorisation with a SAS token for the hub's audience, the `$management`
    /// READ for partition ids, one receiver per partition positioned by the
    /// selector filter, and an event read back with its annotations, properties
    /// and body.
    #[test]
    fn a_hub_is_authorised_described_and_read() {
        use crate::amqp::conn::tests::{pipe, Peer};
        let (client, server) = pipe();
        let broker = std::thread::spawn(move || {
            let mut p = Peer::new(server);
            p.handshake(0);
            p.accept_attach(0, None); // $cbs sender
            let cbs_rx = p.accept_attach(1, None); // $cbs receiver
            assert_eq!(cbs_rx.field(5).field(0).as_str(), Some("$cbs"));
            p.until(codec::FLOW);
            let (_, payload) = p.until(codec::TRANSFER);
            let put = Message::decode(&payload).unwrap();
            assert_eq!(put.app("operation").and_then(Value::as_str), Some("put-token"));
            assert_eq!(put.app("type").and_then(Value::as_str), Some("servicebus.windows.net:sastoken"));
            assert_eq!(put.app("name").and_then(Value::as_str), Some("sb://ns.servicebus.windows.net/hub"));
            let token = put.value.as_ref().and_then(Value::as_str).unwrap().to_string();
            assert!(token.starts_with("SharedAccessSignature sr=sb%3A%2F%2Fns.servicebus.windows.net%2Fhub&sig="), "{token}");
            assert_eq!(put.property(4), cbs_rx.field(6).field(0), "reply-to is the receiver's own target");
            let mut ok = Message {
                properties: vec![Value::Null, Value::Null, Value::Null, Value::Null, Value::Null, put.property(0).clone()],
                application: vec![(Value::str("status-code"), Value::Int(202))],
                ..Default::default()
            };
            p.transfer(1, 0, &ok, 1, true);

            p.accept_attach(2, None); // $management sender
            p.accept_attach(3, None); // $management receiver
            p.until(codec::FLOW);
            let (_, payload) = p.until(codec::TRANSFER);
            let read = Message::decode(&payload).unwrap();
            assert_eq!(read.app("operation").and_then(Value::as_str), Some("READ"));
            assert_eq!(read.app("name").and_then(Value::as_str), Some("hub"));
            assert_eq!(read.app("type").and_then(Value::as_str), Some("com.microsoft:eventhub"));
            assert!(read.app("security_token").and_then(Value::as_str).unwrap().starts_with("SharedAccessSignature"));
            ok.properties[5] = read.property(0).clone();
            ok.application = vec![(Value::str("status-code"), Value::Int(200))];
            ok.value = Some(Value::Map(vec![
                (Value::str("name"), Value::str("hub")),
                (Value::str("partition_ids"), Value::Array(vec![Value::str("0"), Value::str("1")])),
            ]));
            p.transfer(3, 0, &ok, 1, true);

            let a0 = p.accept_attach(4, None);
            p.until(codec::FLOW);
            let a1 = p.accept_attach(5, None);
            p.until(codec::FLOW);
            let filter = |a: &Value| {
                let f = a.field(5).field(7).get("apache.org:selector-filter:string").cloned().unwrap();
                assert_eq!(f.descriptor(), Some(SELECTOR));
                (a.field(5).field(0).as_str().unwrap().to_string(), f.field(0).clone())
            };
            let Value::Described(_, expr0) = a0.field(5).field(7).get("apache.org:selector-filter:string").cloned().unwrap() else { panic!() };
            assert_eq!(filter(&a0).0, "hub/ConsumerGroups/cg/Partitions/0");
            assert_eq!(*expr0, Value::str("amqp.annotation.x-opt-sequence-number > '41'"));
            let Value::Described(_, expr1) = a1.field(5).field(7).get("apache.org:selector-filter:string").cloned().unwrap() else { panic!() };
            assert_eq!(filter(&a1).0, "hub/ConsumerGroups/cg/Partitions/1");
            assert_eq!(*expr1, Value::str("amqp.annotation.x-opt-enqueued-time > '1000'"));
            assert_eq!(a0.field(3), &Value::Ubyte(1), "asks for settled deliveries");

            let event = Message {
                annotations: vec![
                    (Value::sym("x-opt-sequence-number"), Value::Long(7)),
                    (Value::sym("x-opt-offset"), Value::str("4096")),
                    (Value::sym("x-opt-enqueued-time"), Value::Timestamp(1_787_000_000_000)),
                ],
                application: vec![(Value::str("channel"), Value::str("ui")), (Value::str("source"), Value::str("nova-feedback"))],
                data: Some(br#"{"v":1,"eventId":1311}"#.to_vec()),
                ..Default::default()
            };
            p.transfer(5, 0, &event, 2, true);
            p
        });
        let cs = ConnString::parse(
            "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=dmFsdWU=;EntityPath=hub",
        )
        .unwrap();
        let mut hub = EventHub::over(client, None, &cs, "cg").unwrap();
        assert_eq!(hub.partitions().unwrap(), vec!["0".to_string(), "1".to_string()]);
        hub.open("0", Start::After(41)).unwrap();
        hub.open("1", Start::Since(1_000)).unwrap();
        let raw = hub.next(Instant::now() + Duration::from_secs(5)).unwrap().expect("the event");
        assert_eq!(raw.partition, "1");
        assert_eq!(raw.sequence, 7);
        assert_eq!(raw.enqueued_at, 1_787_000_000_000);
        assert_eq!(raw.properties["channel"], serde_json::json!("ui"));
        assert_eq!(raw.body, br#"{"v":1,"eventId":1311}"#.to_vec());
        let _peer = broker.join().unwrap();
    }

    #[test]
    fn amqp_values_read_as_json() {
        let v = Value::Map(vec![
            (Value::sym("channel"), Value::str("ui")),
            (Value::str("n"), Value::Long(3)),
            (Value::str("list"), Value::Array(vec![Value::str("EOS")])),
        ]);
        assert_eq!(json_of(&v), serde_json::json!({"channel": "ui", "n": 3, "list": ["EOS"]}));
    }
}
