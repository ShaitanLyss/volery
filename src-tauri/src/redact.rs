//! Taking the secrets out of a prompt before anything keeps it.
//!
//! `docs/ANALYTICS.md` §3.8 keeps a prompt's **form** and, from phase 5b, a
//! **redacted, sealed body**. This module is the redaction half and it runs on
//! every prompt this wall ingests, whether or not a vault exists: what it
//! returns is a count, and this lane stores the count and drops the text.
//!
//! Three things about the arrangement are the design:
//!
//! - **It over-redacts on purpose.** A false positive costs a phrase out of an
//!   archive nobody has asked to read yet; a false negative is a credential in a
//!   file that gets copied to a peer. The two corpora in the tests below are
//!   what holds the line in both directions: every fake secret goes, and an
//!   ordinary design brief comes back byte for byte.
//! - **It has no dependencies.** Every pattern is a hand-rolled scanner over
//!   bytes, which is more code than `regex` would be and buys something this
//!   repository has learned to want: the corpora can be **executed** on a
//!   machine that cannot link the crate (`tools/lift-redact.ts`, the technique
//!   `.claude/rules/build.md` describes). A redactor whose tests only ever
//!   compile is a redactor nobody has run.
//! - **It never logs.** Not a match, not a fragment, not a length. The one
//!   number that leaves here is `redactions`, and `withheld` when the text was
//!   too secret to be worth keeping at all.
//!
//! The replacement markers are deliberately plain ASCII: they are what a body
//! reads as once it is unsealed, and `<path>.rs` keeps the one piece of a path
//! that says what it was.

/// What one pass did.
#[derive(Debug, Clone, PartialEq)]
pub struct Redacted {
    /// The text with every match replaced.
    pub text: String,
    /// How many spans were taken out, one per replacement. A fence counts once
    /// however many lines it held, because the block is one thing removed.
    pub redactions: usize,
    /// More than [`WITHHOLD_PAST`] high-entropy tokens survived every named
    /// pattern, so the text is one long secret and nothing of it is kept.
    /// `text` is empty when this is true.
    pub withheld: bool,
}

/// Past this many high-entropy tokens, the body is not kept at all.
///
/// A prompt with one unrecognised token is a prompt with an odd word in it; one
/// with nine is a key material dump wearing a sentence. §3.8's number.
pub const WITHHOLD_PAST: usize = 8;

/// Redact `text`, and say what was taken.
pub fn redact(text: &str) -> Redacted {
    let mut out = text.to_string();
    let mut redactions = 0usize;

    /* Fenced code first, and that ordering is a decision rather than an
       accident. A block is removed whole, so nothing inside it is classified,
       counted twice, or left half-redacted; the fence line and the language
       stay, because `<code omitted: 40 lines>` under `rust` says far more than
       the same marker under nothing. */
    let (next, n) = apply(&out, fences(&out));
    out = next;
    redactions += n;

    for rule in [
        private_keys as fn(&str) -> Vec<Found>,
        tokens,
        bearer,
        connection_strings,
        url_userinfo,
        assignments,
        emails,
        guids,
        hex,
        macs,
        ips,
        phones,
        home_paths,
        long_blobs,
    ] {
        let (next, n) = apply(&out, rule(&out));
        out = next;
        redactions += n;
    }

    /* The backstop, last, and it decides whether anything is kept. */
    let (next, n, hits) = entropy(&out);
    out = next;
    redactions += n;
    let withheld = hits > WITHHOLD_PAST;

    Redacted {
        text: if withheld { String::new() } else { out },
        redactions,
        withheld,
    }
}

/// One span the text is going to lose.
#[derive(Debug)]
struct Found {
    start: usize,
    end: usize,
    with: String,
}

impl Found {
    fn take(start: usize, end: usize, with: &str) -> Self {
        Found {
            start,
            end,
            with: with.to_string(),
        }
    }
}

/// Splice the spans in, left to right. An overlap loses to the span that
/// started first, which is how an earlier rule keeps what it took.
fn apply(text: &str, mut found: Vec<Found>) -> (String, usize) {
    if found.is_empty() {
        return (text.to_string(), 0);
    }
    found.sort_by_key(|f| f.start);
    let mut out = String::with_capacity(text.len());
    let mut at = 0usize;
    let mut n = 0usize;
    for f in found {
        if f.start < at || f.end > text.len() || f.start > f.end {
            continue;
        }
        if !text.is_char_boundary(f.start) || !text.is_char_boundary(f.end) {
            continue;
        }
        out.push_str(&text[at..f.start]);
        out.push_str(&f.with);
        at = f.end;
        n += 1;
    }
    out.push_str(&text[at..]);
    (out, n)
}

/// Is there no letter-and-digit run against this byte, in the sense a regex's
/// `\b` means it? Used so a marker only ever starts at a word.
fn edge(b: &[u8], at: usize) -> bool {
    at == 0 || !(b[at - 1].is_ascii_alphanumeric() || b[at - 1] == b'_')
}

/// The same at the far end of a match.
fn ends(b: &[u8], at: usize) -> bool {
    at >= b.len() || !(b[at].is_ascii_alphanumeric() || b[at] == b'_')
}

/// Every occurrence of `needle`, case-insensitively, at a word edge.
/// ASCII only, which is all any of these markers are.
fn find_ci(text: &str, needle: &str) -> Vec<usize> {
    find_ci_where(text, needle, |b, at| edge(b, at))
}

/// The same, but a match may also begin a *segment* of a compound name: the
/// byte before it need only be a separator rather than the start of the text.
///
/// The assignment rule's alone, and it is the difference between catching a
/// pasted `.env` line and missing the commonest spelling of one. A credential
/// is very often named in a compound (`DB_PASSWORD`, `MY_SECRET`, `API_TOKEN`),
/// and requiring a word edge there made `DB_PASSWORD=…` invisible: nothing else
/// in the pipeline takes a 22-character word either. The caller still requires a
/// `:` or `=` immediately after the key, so `tokenizer`, `some_tokenization` and
/// `my_password_hint` stay prose.
fn find_ci_segment(text: &str, needle: &str) -> Vec<usize> {
    find_ci_where(text, needle, |b, at| {
        at == 0 || !b[at - 1].is_ascii_alphanumeric()
    })
}

fn find_ci_where(text: &str, needle: &str, starts: impl Fn(&[u8], usize) -> bool) -> Vec<usize> {
    let hay = text.as_bytes();
    let ndl = needle.as_bytes();
    let mut out = Vec::new();
    if ndl.is_empty() || hay.len() < ndl.len() {
        return out;
    }
    let mut i = 0;
    while i + ndl.len() <= hay.len() {
        if hay[i..i + ndl.len()].eq_ignore_ascii_case(ndl) && starts(hay, i) {
            out.push(i);
            i += ndl.len();
        } else {
            i += 1;
        }
    }
    out
}

/* ── fences, found once for two readers ──────────────────────────────────── */

/// One fenced code block.
#[derive(Debug, Clone, PartialEq)]
pub struct Fenced {
    /// Byte offset of the opening fence line.
    pub start: usize,
    /// Byte offset just past the opening fence line, where the body begins.
    pub body_start: usize,
    /// Byte offset of the closing fence line's first byte, or the end of the
    /// text for a fence that never closed.
    pub body_end: usize,
    /// Byte offset just past the closing fence line, or the end of the text.
    pub end: usize,
    /// The opening line as written, trailing whitespace removed. The language
    /// lives here, which is why it survives a redaction.
    pub opener: String,
    /// The closing fence line as written, when there was one.
    pub closer: Option<String>,
    /// Lines strictly between the fences.
    pub lines: usize,
}

/// Every fenced block in `text`, in order.
///
/// **One reader, two jobs.** `fences` below replaces a block whole and needs the
/// spans; `prompt::form` counts fences and the code lines in them. Those two
/// must not disagree about what a fence is, so there is one scanner and the
/// second reader counts rather than searches.
///
/// A fence is a line whose first non-space characters are ```` ``` ```` or `~~~`,
/// which is what a markdown renderer accepts, indented blocks included. An
/// unclosed fence runs to the end of the text, which is also what a renderer
/// does, and is why `lines` counts the rest.
pub fn fence_blocks(text: &str) -> Vec<Fenced> {
    /* (start, body_start, opener) while a block is open. */
    let mut open: Option<(usize, usize, String)> = None;
    let mut out: Vec<Fenced> = Vec::new();
    let mut line_start = 0usize;
    for line in text.split_inclusive('\n') {
        let start = line_start;
        line_start += line.len();
        let mut line_end = line_start - usize::from(line.ends_with('\n'));
        if line_end > start && text.as_bytes()[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let body = &text[start..line_end];
        let trimmed = body.trim_start();
        if !(trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            continue;
        }
        match open.take() {
            None => open = Some((start, line_start, body.trim_end().to_string())),
            Some((s, body_start, opener)) => out.push(Fenced {
                start: s,
                body_start,
                body_end: start,
                end: line_end,
                lines: text[body_start..start].lines().count(),
                opener,
                closer: Some(body.trim_end().to_string()),
            }),
        }
    }
    if let Some((start, body_start, opener)) = open {
        out.push(Fenced {
            start,
            body_start,
            body_end: text.len(),
            end: text.len(),
            lines: text[body_start..].lines().count(),
            opener,
            closer: None,
        });
    }
    out
}

/// ```` ``` ```` or `~~~` blocks: the marker, the language and the fence stay;
/// the body becomes one line saying how many lines it had.
fn fences(text: &str) -> Vec<Found> {
    fence_blocks(text)
        .into_iter()
        .map(|f| {
            let with = match f.closer {
                Some(closer) => format!("{}\n<code omitted: {} lines>\n{closer}", f.opener, f.lines),
                None => format!("{}\n<code omitted: {} lines>", f.opener, f.lines),
            };
            Found {
                start: f.start,
                end: f.end,
                with,
            }
        })
        .collect()
}

/// `-----BEGIN … PRIVATE KEY-----` through its `END`, whole.
fn private_keys(text: &str) -> Vec<Found> {
    const OPEN: &str = "-----BEGIN ";
    let mut out = Vec::new();
    let mut at = 0usize;
    while let Some(hit) = text[at..].find(OPEN) {
        let start = at + hit;
        /* Past the opening marker's own dashes, or the label search lands on
           them and the label reads as empty. */
        let label_from = start + OPEN.len();
        let label_end = match text[label_from..].find("-----") {
            Some(e) => label_from + e,
            None => break,
        };
        if !text[start..label_end].contains("PRIVATE KEY") {
            at = label_end;
            continue;
        }
        /* The END line closes with the same marker; a block that never closes
           still runs to the end of the text, which is the safe reading. */
        let end = match text[label_end..].find("-----END ") {
            Some(e) => {
                let from = label_end + e + 9;
                match text[from..].find("-----") {
                    Some(close) => (from + close + 5).min(text.len()),
                    None => text.len(),
                }
            }
            None => text.len(),
        };
        out.push(Found::take(start, end, "<private key>"));
        at = end;
    }
    out
}

/// Known token prefixes, each anchored at a word edge so that `task-` and
/// `risk-` survive the `sk-` prefix they contain.
///
/// Every one of these is a *prefix*, so a minimum body length is the other half
/// of the anchor: `sk-` on its own is a fragment of prose, `sk-` plus sixteen
/// characters is a key.
const PREFIXES: [(&str, usize); 21] = [
    ("sk-", 12),
    ("sk_live_", 12),
    ("sk_test_", 12),
    ("rk_live_", 12),
    ("rk_test_", 12),
    ("ghp_", 16),
    ("gho_", 16),
    ("ghu_", 16),
    ("ghs_", 16),
    ("ghr_", 16),
    ("github_pat_", 16),
    ("glpat-", 12),
    ("xoxb-", 10),
    ("xoxp-", 10),
    ("xoxa-", 10),
    ("xoxr-", 10),
    ("xoxs-", 10),
    ("AKIA", 16),
    ("ASIA", 16),
    ("eyJ", 10),
    ("AIza", 20),
];

fn tokens(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let body = |i: usize| -> bool {
        b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'-' | b'.' | b'+' | b'/' | b'=')
    };
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let mut taken = false;
        for (prefix, least) in PREFIXES {
            let p = prefix.as_bytes();
            if i + p.len() > b.len() || !edge(b, i) || !b[i..i + p.len()].eq_ignore_ascii_case(p) {
                continue;
            }
            let mut end = i + p.len();
            while end < b.len() && body(end) {
                end += 1;
            }
            /* `AKIA` is a fixed-width family, and dots only belong in a JWT, so
               a trailing punctuation run is given back either way. */
            while end > i + p.len() && matches!(b[end - 1], b'.' | b'-' | b'_' | b'+' | b'/' | b'=') {
                end -= 1;
            }
            if end - (i + p.len()) < least {
                continue;
            }
            /* A JWT is three segments; anything else followed by another dot is
               prose, an identifier, or a filename. */
            if prefix == "eyJ" {
                let segs = text[i..end].matches('.').count();
                if segs < 2 {
                    continue;
                }
            }
            out.push(Found::take(i, end, "<token>"));
            i = end;
            taken = true;
            break;
        }
        if !taken {
            i += 1;
        }
    }
    out
}

/// `Bearer <token>`, keeping the scheme word so the sentence still reads.
fn bearer(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for at in find_ci(text, "bearer") {
        let mut i = at + 6;
        if i >= b.len() || !b[i].is_ascii_whitespace() {
            continue;
        }
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
            i += 1;
        }
        let start = i;
        while i < b.len()
            && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'_' | b'-' | b'.' | b'=' | b'+' | b'/'))
        {
            i += 1;
        }
        if i - start >= 12 {
            out.push(Found::take(start, i, "<redacted>"));
        }
    }
    out
}

/// `scheme://…` for the schemes that carry a login. Replaced whole, because the
/// host is as much of the secret as the password when the string is a DSN.
const SCHEMES: [&str; 12] = [
    "postgres://",
    "postgresql://",
    "mysql://",
    "mongodb://",
    "mongodb+srv://",
    "redis://",
    "rediss://",
    "amqp://",
    "amqps://",
    "mssql://",
    "sqlserver://",
    "jdbc:",
];

fn connection_strings(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for scheme in SCHEMES {
        for at in find_ci(text, scheme) {
            let mut end = at + scheme.len();
            while end < b.len() && !b[end].is_ascii_whitespace() && !matches!(b[end], b'"' | b'\'' | b'`' | b'<' | b'>') {
                end += 1;
            }
            /* `jdbc:` alone is a word in a sentence about Java; a connection
               string names something after it. */
            if end - at <= scheme.len() + 2 {
                continue;
            }
            out.push(Found::take(at, end, "<connection string>"));
        }
    }
    out
}

/// `scheme://user:password@host` for any scheme at all.
fn url_userinfo(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(hit) = text[from..].find("://") {
        let sep = from + hit;
        /* The scheme starts at the run of scheme characters before it. */
        let mut start = sep;
        while start > 0
            && (b[start - 1].is_ascii_alphanumeric() || matches!(b[start - 1], b'+' | b'.' | b'-'))
        {
            start -= 1;
        }
        if start == sep || !b[start].is_ascii_alphabetic() || !edge(b, start) {
            from = sep + 3;
            continue;
        }
        let mut end = sep + 3;
        let mut authority = String::new();
        while end < b.len() && !b[end].is_ascii_whitespace() && !matches!(b[end], b'"' | b'\'' | b'`' | b'<' | b'>') {
            if matches!(b[end], b'/' | b'?' | b'#') && authority.is_empty() {
                authority.push_str(&text[sep + 3..end]);
            }
            end += 1;
        }
        if authority.is_empty() {
            authority.push_str(&text[sep + 3..end]);
        }
        /* Any userinfo at all, with or without a colon. A token used *as* the
           user is a real spelling (`https://abc123def456@api.host/`) and the
           colon test walked straight past it. The authority is the only part
           looked at, so an `@` in a path is not a login. */
        let has_login = authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| !userinfo.is_empty());
        if has_login {
            out.push(Found::take(start, end, "<url with credentials>"));
        }
        from = end.max(sep + 3);
    }
    out
}

/// `password = …`, `"api_key": "…"`, `token: …`. The key is kept and the value
/// goes, because `password = <redacted>` still tells a reader what the sentence
/// was about.
const KEYS: [&str; 18] = [
    "password",
    "passwd",
    "passphrase",
    "pwd",
    "secret",
    "client_secret",
    "clientsecret",
    "token",
    "access_token",
    "refresh_token",
    "auth_token",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "secret_key",
    "private_key",
    "credential",
];

fn assignments(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for key in KEYS {
        for at in find_ci_segment(text, key) {
            let mut i = at + key.len();
            while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
                i += 1;
            }
            if i >= b.len() || !matches!(b[i], b':' | b'=') {
                continue;
            }
            i += 1;
            while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
                i += 1;
            }
            let quote = if i < b.len() && matches!(b[i], b'"' | b'\'') {
                let q = b[i];
                i += 1;
                Some(q)
            } else {
                None
            };
            let start = i;
            while i < b.len() {
                let c = b[i];
                if c.is_ascii_whitespace() || matches!(c, b',' | b';' | b')' | b'}' | b'>') {
                    break;
                }
                if Some(c) == quote {
                    break;
                }
                i += 1;
            }
            /* Six is short enough for a real key and long enough that
               `password: none` in a design note survives. */
            if i - start >= 6 {
                out.push(Found::take(start, i, "<redacted>"));
            }
        }
    }
    out
}

fn emails(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'@' {
            i += 1;
            continue;
        }
        let mut start = i;
        while start > 0
            && (b[start - 1].is_ascii_alphanumeric() || matches!(b[start - 1], b'.' | b'_' | b'%' | b'+' | b'-'))
        {
            start -= 1;
        }
        let mut end = i + 1;
        while end < b.len()
            && (b[end].is_ascii_alphanumeric() || matches!(b[end], b'.' | b'-' | b'_'))
        {
            end += 1;
        }
        let local = &text[start..i];
        let domain = &text[i + 1..end];
        let tld = domain.rsplit('.').next().unwrap_or("");
        if !local.is_empty() && domain.contains('.') && tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()) {
            out.push(Found::take(start, end, "<email>"));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// 8-4-4-4-12 hex, which is an account, a database key or a machine id.
fn guids(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let hex_at = |i: usize| i < b.len() && b[i].is_ascii_hexdigit();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let shape = [8usize, 4, 4, 4, 12];
        let mut at = i;
        let mut fits = edge(b, i);
        for (n, width) in shape.iter().enumerate() {
            for _ in 0..*width {
                if !hex_at(at) {
                    fits = false;
                    break;
                }
                at += 1;
            }
            if !fits {
                break;
            }
            if n < shape.len() - 1 {
                if at >= b.len() || b[at] != b'-' {
                    fits = false;
                    break;
                }
                at += 1;
            }
        }
        if fits && ends(b, at) {
            out.push(Found::take(i, at, "<guid>"));
            i = at;
        } else {
            i += 1;
        }
    }
    out
}

/// A commit SHA or any hex token of seven or more.
///
/// The digit requirement is what keeps English out of it. A seven-letter word
/// made only of `a`-`f` is rare but real (`defaced`), and the two thresholds
/// below cover the hashes it would otherwise cost: a short hash almost always
/// carries a digit, and anything long enough to be a full SHA is caught whether
/// it does or not.
fn hex(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if !b[i].is_ascii_hexdigit() || !edge(b, i) {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < b.len() && b[end].is_ascii_hexdigit() {
            end += 1;
        }
        let run = &text[i..end];
        let digited = run.bytes().any(|c| c.is_ascii_digit());
        if ends(b, end) && run.len() >= 7 && (digited || run.len() >= 12) {
            out.push(Found::take(i, end, "<hex>"));
        }
        i = end.max(i + 1);
    }
    out
}

/// `aa:bb:cc:dd:ee:ff` and its hyphen spelling.
///
/// Before the address rules, because a MAC is a special case of the general
/// IPv6 shape and would otherwise be taken by it.
fn macs(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if !b[i].is_ascii_hexdigit() || !edge(b, i) {
            i += 1;
            continue;
        }
        let sep = if i + 2 < b.len() && matches!(b[i + 2], b':' | b'-') {
            b[i + 2]
        } else {
            i += 1;
            continue;
        };
        let mut at = i;
        let mut groups = 0;
        loop {
            if at + 2 > b.len() || !b[at].is_ascii_hexdigit() || !b[at + 1].is_ascii_hexdigit() {
                break;
            }
            groups += 1;
            at += 2;
            if at < b.len() && b[at] == sep {
                at += 1;
                continue;
            }
            break;
        }
        if groups == 6 && ends(b, at) {
            out.push(Found::take(i, at, "<mac>"));
            i = at;
        } else {
            i += 1;
        }
    }
    out
}

/// IPv4 dotted quads and IPv6, both of which name a machine on a network
/// somebody may not have meant to describe.
///
/// A bare `a:b:c` is left alone on purpose: `12:30:45` is a time, and the rule
/// for what an address is has to exclude it. So the hex form needs either the
/// `::` compression or four or more groups.
fn ips(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if !b[i].is_ascii_digit() || !edge(b, i) {
            i += 1;
            continue;
        }
        /* IPv4: four decimal groups of one to three digits. */
        let mut at = i;
        let mut quads = 0;
        loop {
            let mut d = 0;
            while at < b.len() && b[at].is_ascii_digit() && d < 3 {
                at += 1;
                d += 1;
            }
            if d == 0 || (at < b.len() && b[at].is_ascii_digit()) {
                break;
            }
            quads += 1;
            if quads < 4 {
                if at < b.len() && b[at] == b'.' {
                    at += 1;
                    continue;
                }
                break;
            }
            break;
        }
        if quads == 4 && ends(b, at) {
            out.push(Found::take(i, at, "<ip>"));
            i = at;
            continue;
        }
        /* IPv6, from the same start only if this run is hex at all. */
        let mut at = i;
        let mut groups = 0;
        let mut compressed = false;
        loop {
            let mut d = 0;
            while at < b.len() && b[at].is_ascii_hexdigit() && d < 4 {
                at += 1;
                d += 1;
            }
            if d == 0 {
                break;
            }
            groups += 1;
            if at < b.len() && b[at] == b':' {
                at += 1;
                if at < b.len() && b[at] == b':' {
                    compressed = true;
                    at += 1;
                }
                continue;
            }
            break;
        }
        if (compressed || groups >= 4) && ends(b, at) && at - i > 2 {
            out.push(Found::take(i, at, "<ip>"));
            i = at;
            continue;
        }
        i = at.max(i + 1);
    }
    out
}

/// A phone number: nine to fifteen digits, with a separator or a `+` so that a
/// date (`2026-08-13`, eight digits) and a version (`2.1.319`) are not one.
fn phones(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        if !b[i].is_ascii_digit() || !edge(b, i) {
            i += 1;
            continue;
        }
        let mut at = i;
        let mut digits = 0;
        let mut separators = 0;
        let mut marker = false;
        while at < b.len() {
            let c = b[at];
            if c.is_ascii_digit() {
                digits += 1;
            } else if matches!(c, b' ' | b'.' | b'-' | b'(' | b')') {
                separators += 1;
            } else if c == b'+' {
                marker = true;
            } else {
                break;
            }
            at += 1;
        }
        while at > i && !b[at - 1].is_ascii_digit() {
            at -= 1;
        }
        let run = &text[i..at];
        let dated = {
            let parts: Vec<&str> = run.split(['-', '.', '/']).collect();
            parts.len() == 3
                && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
                && (parts[0].len() == 4 || (parts[0].len() <= 2 && parts[2].len() <= 4))
        };
        if (9..=15).contains(&digits) && (separators > 0 || marker) && !dated {
            out.push(Found::take(i, at, "<phone>"));
            i = at;
        } else {
            i = at.max(i + 1);
        }
    }
    out
}

/// The absolute paths that name a person: anything under a home directory.
///
/// **Not every absolute path.** A design brief is mostly paths (`src/lib/x.ts`,
/// `C:\\workbench\\volery\\src-tauri`), and the false-positive corpus asserts
/// they come through, because a body with the paths taken out is a body nobody
/// can follow. What does name somebody is the directory prefix they live in, so
/// that is what goes, and the extension stays because `.rs` and `.png` are the
/// part that says what the thing was.
const HOMES: [&str; 5] = ["\\users\\", "/users/", "/home/", "~/", "~\\"];

fn home_paths(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for home in HOMES {
        for at in find_ci(text, home) {
            /* Windows spellings may start at the drive letter. */
            let mut start = at;
            if home.starts_with('\\') && start >= 2 && b[start - 1].is_ascii_alphabetic() && b[start - 2] == b':' {
                start -= 2;
            }
            let mut end = at + home.len();
            /* One segment is the person; everything after it is the path. */
            while end < b.len() && !b[end].is_ascii_whitespace() && !matches!(b[end], b'"' | b'\'' | b'`' | b'<' | b'>' | b'|' | b',') {
                end += 1;
            }
            let path = &text[start..end];
            let last = path.rsplit(['\\', '/']).next().unwrap_or("");
            let extension = match last.rfind('.') {
                Some(dot) if dot > 0 => {
                    let ext = &last[dot + 1..];
                    if !ext.is_empty() && ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                        format!(".{ext}")
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            };
            /* A bare `~/` in a sentence about shells is not a path anybody
               leaked; it is a marker with nothing behind it. */
            if end == at + home.len() {
                continue;
            }
            out.push(Found::take(start, end, &format!("<path>{extension}")));
        }
    }
    out
}

/// A long base64 or hex run: forty characters or more of one alphabet, which is
/// a blob rather than a word.
///
/// **Two things keep English out of it**, because forty unbroken letters is
/// exactly what a thoughtful sentence produces. A run in either spelling needs
/// a digit, and a run with no punctuation needs one upper-case letter in five:
/// real base64 carries roughly two in five, where a forty-four character
/// camel-case identifier (`getUserAccountByIdentifierFromTheDatabase`) carries
/// one in nine. Hex is already gone by here, at twelve characters.
fn long_blobs(text: &str) -> Vec<Found> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < b.len() {
        let plain = b[i].is_ascii_alphanumeric() || matches!(b[i], b'+' | b'/' | b'=');
        let urlish = plain || matches!(b[i], b'-' | b'_');
        if !urlish || !edge(b, i) {
            i += 1;
            continue;
        }
        let mut end = i;
        while end < b.len() && (b[end].is_ascii_alphanumeric() || matches!(b[end], b'+' | b'/' | b'=' | b'-' | b'_')) {
            end += 1;
        }
        let run = &text[i..end];
        let digited = run.bytes().any(|c| c.is_ascii_digit());
        let uppers = run.bytes().filter(|c| c.is_ascii_uppercase()).count();
        let tight = run.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='));
        let blobish = if tight { digited || uppers * 5 >= run.len() } else { digited };
        if ends(b, end) && run.len() >= 40 && blobish {
            out.push(Found::take(i, end, "<blob>"));
        }
        i = end.max(i + 1);
    }
    out
}

/// Shannon entropy of a byte run, in bits per byte.
fn entropy_of(run: &[u8]) -> f64 {
    if run.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    for b in run {
        counts[*b as usize] += 1;
    }
    let n = run.len() as f64;
    counts
        .iter()
        .filter(|c| **c > 0)
        .map(|c| {
            let p = *c as f64 / n;
            -p * p.log2()
        })
        .sum()
}

/// The backstop: any token left that is long and mixed enough to be a key.
///
/// It asks for a digit **and** upper **and** lower case, which is what keeps a
/// long camel-case identifier out of it, and then entropy on top. A token that
/// is all one case and a digit was caught by `tokens` or `long_blobs` already;
/// what survives to here is the shape nobody wrote a pattern for.
fn entropy(text: &str) -> (String, usize, usize) {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut hits = 0usize;
    let mut at = 0usize;
    while at < text.len() {
        let mut token_end = at;
        while token_end < b.len() && !b[token_end].is_ascii_whitespace() {
            token_end += 1;
        }
        let token = &text[at..token_end];
        let trimmed = token.trim_matches(|c: char| {
            !(c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
        });
        let random = trimmed.len() >= 24
            && trimmed.bytes().any(|c| c.is_ascii_digit())
            && trimmed.bytes().any(|c| c.is_ascii_uppercase())
            && trimmed.bytes().any(|c| c.is_ascii_lowercase())
            && entropy_of(trimmed.as_bytes()) >= 3.5;
        if random {
            hits += 1;
            out.push_str("<redacted>");
        } else {
            out.push_str(token);
        }
        /* The whitespace goes back exactly as it came, so the text that comes
           out is the text that went in less the secrets. */
        let mut ws = token_end;
        while ws < b.len() && b[ws].is_ascii_whitespace() {
            ws += 1;
        }
        out.push_str(&text[token_end..ws]);
        at = ws;
    }
    (out, hits, hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One fake of every shape §3.8 lists, plus the backstop. The third column
    /// is the thing that must not survive, and the assertion is on the *text*
    /// rather than only the count: a count of one with the secret still in it
    /// is exactly the failure this corpus exists to make impossible.
    #[test]
    fn every_shape_of_secret_is_taken_out() {
        let corpus: &[(&str, &str, &str)] = &[
            (
                "private key",
                "here it is\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----\ndone",
                "b3BlbnNzaC1rZXk",
            ),
            ("openai", "the key is sk-proj-9fK2mQ7tR4vX1zL8nB6wY3pA please", "sk-proj-9fK2mQ7tR4vX1zL8nB6wY3pA"),
            ("anthropic", "ANTHROPIC_API_KEY=sk-ant-api03-4Kd9Lm2Np7Qr1St6Vw3Xy8Za", "4Kd9Lm2Np7Qr1St6Vw3Xy8Za"),
            ("github", "use ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 for it", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
            ("github pat", "token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG0123456789"),
            ("slack", "the bot is xoxb-1234567890-0987654321-AbCdEfGhIjKl", "xoxb-1234567890"),
            ("aws", "AKIAIOSFODNN7EXAMPLE is what they pasted", "AKIAIOSFODNN7EXAMPLE"),
            ("jwt", "Authorization eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ", "eyJhbGciOiJIUzI1NiJ9"),
            ("bearer", "curl -H 'Authorization: Bearer abcdef1234567890xyz'", "abcdef1234567890xyz"),
            ("dsn", "postgres://admin:hunter2@db.internal:5432/app", "hunter2"),
            ("url login", "https://lyss:p4ssw0rd@example.com/path", "p4ssw0rd"),
            ("assignment", "api_key = \"9f8e7d6c5b4a3210\"", "9f8e7d6c5b4a3210"),
            ("password phrase", "the password: correct-horse-battery", "correct-horse-battery"),
            /* The compound spellings, which are how a `.env` line actually
               arrives and which a word-edge rule missed entirely. */
            ("compound password", "DB_PASSWORD=swordfish", "swordfish"),
            (
                "compound secret",
                "MY_SECRET=correcthorsebatterystaple",
                "correcthorsebatterystaple",
            ),
            ("compound token", "API_TOKEN=abcdefghijklmnop", "abcdefghijklmnop"),
            ("url token userinfo", "see https://abc123def456@api.host/path", "abc123def456"),
            ("email", "write to lyss.delprat@example.co.uk about it", "lyss.delprat@example.co.uk"),
            ("guid", "the machine id is 3f2504e0-4f89-11d3-9a0c-0305e82c3301", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
            ("short sha", "see commit a3f9c1b for the change", "a3f9c1b"),
            ("long sha", "see 4b825dc642cb6eb9a060e54bf8d69288fbee4904 for the change", "4b825dc6"),
            ("ipv4", "it answered from 192.168.1.42 on the lan", "192.168.1.42"),
            ("ipv6", "it answered from 2001:db8::8a2e:370:7334 too", "2001:db8::8a2e"),
            ("mac", "its address is 00:1A:2B:3C:4D:5E today", "00:1A:2B:3C:4D:5E"),
            ("phone", "call +1 (415) 555-0123 about it", "555-0123"),
            ("home path", "open C:\\Users\\lyss\\.claude\\settings.json and look", "lyss"),
            ("unix home path", "read /home/lyss/.config/nvim/init.lua tonight", "lyss"),
            ("base64", "the blob is iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "iVBORw0KGgo"),
            ("fence", "look:\n```python\nprint('hi')\nprint('there')\n```\nafter", "print('there')"),
            ("entropy backstop", "and aB3xK9mQ2pR7tW1yZ5cV8nL4", "aB3xK9mQ2pR7tW1yZ5cV8nL4"),
        ];
        for (what, text, secret) in corpus {
            let out = redact(text);
            assert!(
                out.redactions > 0 || out.withheld,
                "{what}: nothing was redacted from {text:?}"
            );
            assert!(
                !out.text.contains(secret),
                "{what}: {secret:?} survived as {:?}",
                out.text
            );
            assert!(!out.text.contains("PRIVATE KEY"), "{what}: the key block survived");
        }
    }

    /// The other direction, and the one that decides whether a body is worth
    /// keeping at all: an ordinary design brief comes through byte for byte.
    #[test]
    fn an_ordinary_design_brief_comes_through_intact() {
        let brief = "\
# the analytics room

The panel should read as one document rather than a pile of cards, so the
chart, the table and the inspector share a single column. Sketch the layout at
`src/lib/analytics.ts` and `C:\\workbench\\volery\\src-tauri\\src\\analytics.rs`
before touching either.

Two things to weigh. A task- or risk-shaped toggle belongs on the left rail,
because that is where the eye already goes; a dropdown for it would hide the
current mode. And the copy should stay lowercase and quiet, the way the rest of
the wall reads.

The first cut should land on branch `analytics-room` at commit a3f9c1, keeping
the saved view format exactly as it is so nothing has to be migrated. If the
chart gets slow past a year, refuse the span rather than truncate it.

A 24-hour window is 288 points at five-minute grain, which is what the room
draws today. Do not change the 90-day retention on the fine tier.

- keep the keyboard path for every control
- say the chord in the tooltip
- leave the hall for a later phase
";
        let out = redact(brief);
        assert_eq!(out.redactions, 0, "an ordinary brief lost {} spans: {:?}", out.redactions, out.text);
        assert!(!out.withheld);
        assert_eq!(out.text, brief);
    }

    /// The prefix rule is anchored, and that is the whole of what keeps two very
    /// ordinary words from being eaten by `sk-`.
    #[test]
    fn task_and_risk_survive_the_prefix_they_contain() {
        let out = redact("a task-shaped toggle and a risk-shaped one");
        assert_eq!(out.redactions, 0, "{:?}", out.text);
        assert_eq!(out.text, "a task-shaped toggle and a risk-shaped one");
    }

    /// A short hash survives and a full one does not, because a commit is a
    /// secret only when it is long enough to be one.
    #[test]
    fn a_six_character_hash_survives_and_a_full_sha_does_not() {
        let short = redact("see a3f9c1 for it");
        assert_eq!(short.redactions, 0, "{:?}", short.text);
        let long = redact("see 4b825dc642cb6eb9a060e54bf8d69288fbee4904 for it");
        assert_eq!(long.redactions, 1);
        assert!(long.text.contains("<hex>"));
    }

    /// A fence keeps its markers and its language and loses its body, and the
    /// marker says how much went.
    #[test]
    fn a_fence_keeps_its_language_and_counts_its_lines() {
        let out = redact("before\n```rust\nfn a() {}\nfn b() {}\n```\nafter");
        assert_eq!(out.redactions, 1);
        assert_eq!(
            out.text,
            "before\n```rust\n<code omitted: 2 lines>\n```\nafter"
        );
    }

    /// Past eight unrecognised tokens the body is not kept at all, and the
    /// counts still say what was there. §3.8's rule, and the acceptance test
    /// that a withheld body keeps its form counts.
    #[test]
    fn more_than_eight_unknown_tokens_withhold_the_whole_body() {
        let one = "a key aB3xK9mQ2pR7tW1yZ5cV8nL4";
        let kept = redact(one);
        assert!(!kept.withheld);
        assert!(kept.text.contains("<redacted>"));
        assert!(!kept.text.contains("Zm9vYmFy"));

        let many = (0..9)
            .map(|i| format!("aB3xK9mQ2pR7tW1yZ5cV8nL4{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let out = redact(&many);
        assert!(out.withheld, "nine tokens did not withhold the body");
        assert_eq!(out.text, "", "a withheld body kept some of itself");
        assert_eq!(out.redactions, 9, "the counts still say what was taken");
    }

    /// A long camel-case identifier is not a secret, and the backstop's
    /// character-class test is what says so.
    #[test]
    fn a_long_identifier_is_not_a_secret() {
        let out = redact("call getUserAccountByIdentifierFromTheDatabase then return");
        assert_eq!(out.redactions, 0, "{:?}", out.text);
    }

    /// The text comes back in the order it went in, which a span splicer gets
    /// wrong the moment it applies replacements front to back.
    #[test]
    fn spans_are_spliced_left_to_right() {
        let out = redact("mail a@b.co then c@d.co then 10.0.0.1");
        assert_eq!(out.text, "mail <email> then <email> then <ip>");
    }
}
