//! Hearing what was said, and nothing else.
//!
//! This is the front door `docs/VOICE.md` left unbuilt: audio in, one line of
//! text out. Everything downstream — resolving referents, building a plan,
//! deciding whether it may simply happen — is `src/lib/voice.ts` and
//! `src/lib/steward.ts`, and none of it knows a microphone exists. A transcript
//! is text on the ordinary event pipeline.
//!
//! ## What runs here now
//!
//! Since 2026-09-09 the recogniser is **sherpa-onnx, in this process**: Silero
//! VAD bounds the utterance, moonshine-base-en transcribes what it bounded, and
//! no audio leaves the machine. What it replaced was Windows'
//! `SpeechRecognitionTopicConstraint` - Microsoft's *cloud* dictation service.
//!
//! **The four sections below are history and are kept deliberately.** They are
//! the record of how a cloud service came to be described here as an on-device
//! one, and it is an easy mistake to make twice: the probe that chose that path
//! looked entirely healthy, and every number taken off it was true. What was
//! wrong was the inference. Deleting them leaves a file that looks as though it
//! was right the first time. The new engine's own section follows them.
//!
//! ## History: why Windows' own recogniser, and what that cost
//!
//! Probed 2026-09-06 with a scratch crate (`build.md`'s pattern — a *library*
//! question answered outside the app's dependency graph, so a no is free):
//!
//! ```text
//! system language:  fr-FR
//! dictation:        en-US fr-FR
//! en-US: compile SpeechRecognitionResultStatus(0) in 5ms
//! fr-FR: compile SpeechRecognitionResultStatus(0) in 3ms
//! ```
//!
//! Compiling a dictation grammar costs 3–5ms and needs **no model download and
//! no new crate** — only four more features on the `windows` crate this tree
//! already depends on for job objects. Against whisper, which wants a 75–150MB
//! model file and a C++ build, that read as an easy first cut.
//!
//! ## It reads audio off this machine, and the probe above did not show that
//!
//! **The inference from that probe was wrong, and it was wrong in the direction
//! that matters.** `SupportedTopicLanguages` answering `en-US fr-FR` says which
//! languages a *topic constraint* is available in. It does not say the
//! recognition happens here, and it does not. Microsoft's own documentation
//! says so in three places, most plainly on `SpeechRecognitionTopicConstraint`
//! itself: *"a pre-defined grammar constraint provided through a web service"*,
//! *"a remote web service performs the recognition and returns the results to
//! the device"*, *"they are online (not on the device) … they do require a
//! connection to a network"*. So `listen` below, which uses exactly that
//! constraint, sends the microphone to Microsoft. That is what the privacy
//! policy in the next section is a policy *about*, and reading the gate as an
//! arbitrary obstacle rather than as the disclosure it is, is how this file came
//! to describe a cloud service as "Windows' own on-device recogniser".
//!
//! ## And the web-service path is flaky, which took three tries to state right
//!
//! Measured 2026-09-08 with a scratch crate on `listen`'s exact argv, silent
//! one-shot recognitions, over an afternoon:
//!
//! ```text
//!            topic constraint (listen)      list constraint (local)
//! window 1   0/7  — every one Unknown       3/3  Success
//! window 2   5/8, 3 Unknown                 4/4  Success
//! ```
//!
//! A healthy run takes 5.5–6.3s: the whole 5s initial-silence window, correctly
//! reporting that nothing was said. A failure bails at 0.9–4s, which is not long
//! enough to have listened to anything. **The local path has never once failed
//! across either window; the web-service path went from always to sometimes with
//! nothing in this tree changing.**
//!
//! **The rate is the thing not to state confidently, and it was got wrong twice
//! in one afternoon in opposite directions** — first *"roughly one in three, try
//! again"* off six runs, then *"7/7, this cannot work here, retrying cannot
//! help"* off seven. Both were real measurements and both were too small to see
//! that the thing moves. What holds across every window is the *shape*: the local
//! constraint works and the remote one is unreliable, so a failure here is the
//! service and never the microphone.
//!
//! Two causes were proposed and both are withdrawn. It is **not** this network's
//! TLS interception — Windows' own voice typing (Win+H), a packaged first-party
//! client on the same wire, transcribes fine, and the endpoints answer HTTP
//! through the Netskope proxy. It is **not** the missing MSIX package identity
//! either, or the successes above could not have happened unpackaged. What is
//! left is a cloud round-trip that sometimes does not complete, and nothing here
//! can see inside it.
//!
//! So the honest options are a retry — which does help, since the next attempt is
//! usually fine — or getting off the web service: a `SpeechRecognitionListConstraint`
//! or SRGS grammar runs on the machine and has not failed yet, but only ever matches
//! phrases enumerated in advance, which is the shape `listen` deliberately rejected
//! below because the steward rung exists so you can say anything. Whisper (16fa718)
//! is the other end: local, offline, unrestricted, a model file and a C++ build.
//! Nothing here picks between them.
//!
//! ## The one thing it will not do, and where that leaves us
//!
//! `RecognizeAsync` refuses with `0x80045509` —
//! *SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED* — until Windows' speech privacy
//! policy has been accepted, which is Settings → Privacy & security → Speech.
//! Note where the line falls: **compiling** the grammar works without it,
//! **recognising** does not, which is why the probe looked entirely healthy right
//! up to the moment it listened.
//!
//! Nothing here changes that setting or asks the OS to. What it does instead is
//! **name the gate exactly**, so the failure is one line telling you what to
//! change rather than a microphone that does nothing.
//!
//! This file used to add that the local engines being installed *did not*
//! establish that accepting the policy keeps audio on the machine, and that it
//! was in no position to answer the question. The hedge was right and the
//! question is now answered: it does not. See the section above.
//!
//! ## And it must be told a language, because the wall's verbs are English
//!
//! `SystemSpeechLanguage` was `fr-FR` when this was written. Left to itself the
//! recogniser would listen in French and hand back French — which the grammar
//! in `voice.ts` cannot parse a word of, since its verbs are `select`, `stop`,
//! `open`. That fails as *"it hears me and nothing happens"*, with nothing
//! anywhere to say why. So the language is an argument with an English default
//! rather than whatever the OS is set to, and the caller may override it the
//! day the vocabulary grows a second language.
//!
//! **It read `en-US` two days later**, with nobody having touched this file —
//! which is the argument rather than a footnote to it. A value that moves under
//! you between one probe and the next is not a value to inherit silently, and
//! the day it moves back is a day the wall stops answering to its own verbs
//! with nothing in the transcript to say why. `hearing()` still reports it, so
//! the disagreement stays visible.

//! ## And so: a local engine, chosen by measurement rather than by preference
//!
//! `docs/VOICE.md` Design 3 ("the wall listens") decided on 2026-09-05 that the
//! microphone would eventually be always-on, and its own cost section says that
//! forces local speech-to-text outright — audio from a room leaving this
//! machine is not a thing to ship. So the question was never *whether* but
//! *which*, and it was answered with a scratch crate rather than a leaderboard,
//! because a public benchmark is not a measurement of this laptop.
//!
//! Measured 2026-09-09 on this CPU, under normal wall load, three repeats each
//! (sink `90130c65`):
//!
//! ```text
//! model                              size   load        tail       rtf
//! nemotron-3.5-streaming-0.6b-320ms  682MB  12.3-19.1s  0ms        1.80-2.90
//! moonshine-base-en-int8             286MB  7.0-8.6s    391-718ms  0.15-0.28
//! ```
//!
//! **`rtf` is the column that decided it.** Real-time factor above 1.0 means
//! the engine falls behind a live microphone faster than you can speak, so the
//! streaming model cannot do the job its streaming-ness exists for on this
//! hardware. Moonshine at 0.15-0.28 leaves headroom for the fourteen other
//! things this laptop is doing. There is no GPU or NPU path to reach for:
//! sherpa-onnx 1.13.7 links a CPU-only ONNX Runtime and does not accept
//! `openvino`, `npu` or `vitisai` as provider strings at all.
//!
//! **What was given up, and it is a real loss.** The Windows path emitted
//! `HypothesisGenerated` while you were still talking, and the section above
//! argues at length that watching your own words appear is the only honest
//! evidence a listening bar can show. Moonshine is a *batch* engine: nothing
//! comes back until a segment is decoded. So `voice:hypothesis` still fires,
//! but it now carries one **completed VAD segment** at a time rather than a
//! word — sentence-grained where it used to be word-grained. The bar is still
//! never merely "listening…", which was the property worth keeping; it just
//! updates in fewer, larger steps.
//!
//! **And the accuracy numbers above are upper bounds.** Every clip was Windows
//! TTS: no room tone, no accent, no disfluency. This file has already produced
//! three confident wrong claims in two days by stating a rate off a sample
//! under ten — so there is deliberately no accuracy figure here, and anyone
//! adding one should count their samples first. What *was* observed is
//! qualitative and consistent: general English is fine, and the wall's own
//! vocabulary is what breaks ("volery" comes back as "volley", "skein" as
//! "Scain"). See sink `6b81e132`.
//!
//! ## Why the models are fetched rather than shipped
//!
//! ~286MB of weights cannot go in a git repository and would double the
//! installer. They are downloaded once, on the first listen, into the app's own
//! data directory, and reused forever after.
//!
//! That is only cheap because this tree had already solved the hard half. A
//! *build-time* download by `sherpa-onnx-sys` fails on this network with
//! `UnknownIssuer` — it uses rustls with its own bundled roots, and the
//! Netskope CA that signs everything here lives in the Windows store. The
//! **app** has no such problem: `forge::tls_config` merges the native roots
//! with the public ones for exactly this reason, and `update.rs` already
//! fetches from GitHub through it. So this reuses that agent rather than adding
//! a second HTTP stack. See the `ureq` note in `Cargo.toml`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sherpa_onnx::{
    OfflineModelConfig, OfflineMoonshineModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use tauri::{Emitter, Manager};

/// The language the wall listens in unless told otherwise.
///
/// Kept as a constant, and kept as an *argument* to `listen`, even though the
/// engine below is English-only — the history above is the argument for it. The
/// OS speech language moved from `fr-FR` to `en-US` between two probes with
/// nobody touching this file, and a value that moves under you is not one to
/// inherit silently. Now that the model rather than the OS decides, this is a
/// claim about moonshine-base-**en**, and `english_only` enforces it.
pub const DEFAULT_LANGUAGE: &str = "en-US";

/// What Silero and moonshine both want. Not a preference — the VAD is trained
/// at this rate, and `WINDOW` below is its frame size in samples at it.
const RATE: u32 = 16_000;
/// Silero's frame. Feeding it anything else works but makes the detector's own
/// timing arithmetic wrong, so the capture loop buffers up to exactly this.
const WINDOW: usize = 512;

/// How long to wait for somebody to start talking before giving up.
///
/// Five seconds because that is what the Windows path used, and "nothing was
/// said" after about five seconds is a reading people are already used to here.
const ONSET_PATIENCE: Duration = Duration::from_secs(5);
/// How much silence ends an utterance once it has begun.
///
/// Deliberately longer than Silero's own `min_silence_duration`: that one
/// decides where a *segment* stops, this one decides whether another is coming.
/// Set them equal and a breath in the middle of a sentence ends the whole turn.
const TRAILING_SILENCE: Duration = Duration::from_millis(900);
/// A ceiling, so a stuck-open microphone cannot hold a blocking thread forever.
const MAX_UTTERANCE: Duration = Duration::from_secs(30);

/* ── one utterance, heard ─────────────────────────────────────────────────── */

/// One utterance, heard.
#[derive(Debug, Serialize)]
pub struct Heard {
    pub text: String,
    /// **This engine reports no confidence, and the field stays honest by
    /// saying so rather than by inventing a number.**
    ///
    /// The four values are the Windows recogniser's vocabulary, and the front
    /// end's `Transcript` type still spells all four, so the wire shape is
    /// unchanged. What changed is that only two can now occur: `rejected` when
    /// nothing was transcribed, `medium` when something was. `medium` rather
    /// than `high` because a model that cannot score itself has not earned
    /// `high` — but it is a placeholder, not a measurement, and **nothing may
    /// threshold on it**. Nothing does today; `voicing.svelte.ts` reads only
    /// `text`. If something ever needs to weigh how sure the recogniser was,
    /// the honest fix is a new field, not a finer guess in this one.
    pub confidence: String,
    /// Which language it listened in, so a transcript that came back as
    /// nonsense can be told apart from one that came back in French.
    pub language: String,
    pub ms: u64,
}

/// What the recogniser can do here, asked before anybody holds a key down.
///
/// Redefined 2026-09-09 along with the engine. It used to report Windows'
/// system speech language and its installed dictation languages, which are
/// facts about a service this file no longer calls. Nothing in `src/` consumes
/// it — the command is registered and has no caller — so this was free to
/// change today, and worth changing before something starts depending on a
/// shape that describes the wrong recogniser.
#[derive(Debug, Serialize)]
pub struct Hearing {
    /// The one language the installed model transcribes. A statement about
    /// moonshine-base-**en**, not a setting.
    pub language: String,
    /// Whether the weights are already on disk. `false` means the first listen
    /// will spend a while fetching before it can hear anything, which is worth
    /// being able to say *before* somebody holds the key down.
    pub ready: bool,
    /// Roughly what is still to fetch, in megabytes. Zero when `ready`.
    pub to_fetch_mb: u64,
    /// The input device that would be used, when there is one.
    pub device: Option<String>,
}

/* ── the models ───────────────────────────────────────────────────────────── */

/// The moonshine release unpacks to a directory of this name; the four weights
/// plus the token table inside it are what the recogniser is handed.
const MOONSHINE: &str = "sherpa-onnx-moonshine-base-en-int8";
const MOONSHINE_ARCHIVE: &str = "sherpa-onnx-moonshine-base-en-int8.tar.bz2";
const SILERO: &str = "silero_vad.onnx";
/// sherpa publishes models under one long-lived tag rather than per release.
const MODEL_BASE: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
/// What the fetch costs, so there is something to say before it is spent.
const MOONSHINE_MB: u64 = 286;

/// Where the weights live, and whether they are all there.
struct Models {
    preprocessor: PathBuf,
    encoder: PathBuf,
    uncached_decoder: PathBuf,
    cached_decoder: PathBuf,
    tokens: PathBuf,
    silero: PathBuf,
}

impl Models {
    /// The layout, without asking the disk anything. Pure, so the test at the
    /// bottom can check the names against what the release actually ships.
    fn at(dir: &Path) -> Self {
        let m = dir.join(MOONSHINE);
        Self {
            preprocessor: m.join("preprocess.onnx"),
            encoder: m.join("encode.int8.onnx"),
            uncached_decoder: m.join("uncached_decode.int8.onnx"),
            cached_decoder: m.join("cached_decode.int8.onnx"),
            tokens: m.join("tokens.txt"),
            silero: dir.join(SILERO),
        }
    }

    fn complete(&self) -> bool {
        [
            &self.preprocessor,
            &self.encoder,
            &self.uncached_decoder,
            &self.cached_decoder,
            &self.tokens,
            &self.silero,
        ]
        .iter()
        .all(|p| p.is_file())
    }
}

/// An agent that gets through this network. See the module header.
/* ── saying where a long first run has got to ────────────────────── */

/// How often a fetch or an unpack may say where it is.
///
/// This is a number about *reading*, not about cost. The line lands on the same
/// bar a transcript does, so too fast and the digits blur into noise, too slow
/// and it reads as stuck. A quarter-second is about the quickest a changing
/// number stays legible.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// How often the unpack looks at the directory it is filling. Coarser than
/// `PROGRESS_EVERY` because each look walks the tree, and the answer only moves
/// as fast as bzip2 does.
const UNPACK_POLL: Duration = Duration::from_millis(400);

/// A throttle that still guarantees the last word.
///
/// **The final call must always land.** A progress line frozen at 97% because
/// the throttle happened to swallow the last update is precisely the *is this
/// stuck?* question the whole section exists to answer, so `now` exists
/// alongside `throttled` and every phase ends with one.
struct Say<'a> {
    to: &'a dyn Fn(&str),
    last: Option<Instant>,
}

impl<'a> Say<'a> {
    fn new(to: &'a dyn Fn(&str)) -> Self {
        Self { to, last: None }
    }

    fn now(&mut self, line: &str) {
        self.last = Some(Instant::now());
        (self.to)(line);
    }

    fn throttled(&mut self, line: &str) {
        if self.last.map_or(true, |t| t.elapsed() >= PROGRESS_EVERY) {
            self.now(line);
        }
    }
}

/// Megabytes, decimal, because that is the unit the download is advertised in
/// and a progress line that disagrees with the notice above it invites the
/// wrong question.
fn mb(bytes: u64) -> u64 {
    bytes / 1_000_000
}

/// Bytes on disk under a directory, walked. Used only to watch an unpack move.
fn tree_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| match e.metadata() {
            Ok(m) if m.is_file() => m.len(),
            Ok(m) if m.is_dir() => tree_bytes(&e.path()),
            _ => 0,
        })
        .sum()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .tls_config(crate::forge::tls_config())
        /* Per read, not per download. A 286MB body over a corporate proxy is
           minutes of reads, and a total timeout here would abort a healthy
           fetch part-way through. */
        .timeout_read(Duration::from_secs(120))
        .build()
}

fn download(url: &str, to: &Path, what: &str, say: &mut Say) -> Result<(), String> {
    let res = agent()
        .get(url)
        .call()
        .map_err(|e| format!("fetch {url}: {e}"))?;
    /* Advisory. A proxy that re-encodes may not send one, and the fallback is a
       count rather than a percentage — which still answers the only question
       being asked, namely whether the number is moving. */
    let total: Option<u64> = res.header("Content-Length").and_then(|h| h.parse().ok());
    let mut body = res.into_reader();
    let mut file =
        std::fs::File::create(to).map_err(|e| format!("create {}: {e}", to.display()))?;

    /* This was `std::io::copy`, which is the right call everywhere except here:
       it reports one number, at the end, and the end is several minutes away on
       this link. The loop below is that same copy with somewhere to stand in
       the middle of it. */
    let mut buf = vec![0u8; 64 * 1024];
    let mut got: u64 = 0;
    loop {
        let n = body.read(&mut buf).map_err(|e| format!("read {url}: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("write {}: {e}", to.display()))?;
        got += n as u64;
        let line = match total {
            Some(t) if t > 0 => {
                format!("fetching {what} \u{2014} {}% of {}MB", got * 100 / t, mb(t))
            }
            _ => format!("fetching {what} \u{2014} {}MB so far", mb(got)),
        };
        say.throttled(&line);
    }
    say.now(&format!("fetched {what} \u{2014} {}MB", mb(got)));
    Ok(())
}

/// No console window flashing up behind a GUI app.
#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Unpack a `.tar.bz2` with the system's own tar.
///
/// **Named by absolute path on Windows, and that is not fussiness.** Cygwin's
/// `tar` comes first on this machine's PATH and it *silently truncates a large
/// archive and exits 0* — measured 2026-09-09, a 453MB archive that passed
/// `bzip2 -t` extracted to 170MB with status zero, and every "corrupt download"
/// that afternoon turned out to be this rather than the network. Sink
/// `113d6b0e`.
///
/// Shelling out rather than linking `tar` and `bzip2`: both are already in the
/// graph behind `sherpa-onnx-sys`, but as *build* dependencies — using them
/// here would put two more crates in the shipped binary to unpack one archive
/// once. bsdtar has shipped in Windows since 1809.
fn untar(archive: &Path, into: &Path, what: &str, say: &mut Say) -> Result<(), String> {
    let tar = if cfg!(windows) {
        "C:/Windows/System32/tar.exe"
    } else {
        "tar"
    };
    let mut cmd = Command::new(tar);
    cmd.arg("-xf").arg(archive).arg("-C").arg(into);
    quiet(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("start {tar}: {e}"))?;
    /* CLAUDE.md: every spawn goes in a job object. This one is short-lived and
       starts nothing of its own, so the job buys little here — but "every" is
       the rule precisely because the exceptions get argued one at a time until
       there are eighty orphans under the wall. */
    let job = crate::servers::jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    /* **Polling the directory is the only progress this phase can have, and it
       is worth having.** bzip2 is single-threaded and the speech archive is
       minutes of it; `tar` is somebody else's process with nothing to report.
       So what gets measured is the thing it produces \u{2014} bytes arriving on disk.
       Deliberately not a percentage: the uncompressed size is not known until
       it is finished, and inventing a denominator would be worse than not
       having one. A number that only goes up is already the whole difference
       between *working* and *hung*. */
    let status = loop {
        match child.try_wait().map_err(|e| format!("{tar}: {e}"))? {
            Some(status) => break status,
            None => {
                say.throttled(&format!("unpacking {what} \u{2014} {}MB", mb(tree_bytes(into))));
                std::thread::sleep(UNPACK_POLL);
            }
        }
    };
    if !status.success() {
        return Err(format!("{tar} failed unpacking {}", archive.display()));
    }
    say.now(&format!("unpacked {what} \u{2014} {}MB", mb(tree_bytes(into))));
    Ok(())
}

/// Make sure the weights are on disk, fetching them once if they are not.
///
/// Each download lands under a temporary name and is moved into place only when
/// it is whole, so an interrupted fetch leaves nothing that *looks* finished.
/// That matters more than usual here: the failure it prevents is a half-written
/// 122MB decoder, which ONNX Runtime rejects with a message about a protobuf
/// that names nothing to do about it.
fn ensure_models(dir: &Path, report: &dyn Fn(&str)) -> Result<Models, String> {
    let models = Models::at(dir);
    if models.complete() {
        return Ok(models);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("make {}: {e}", dir.display()))?;
    let mut say = Say::new(report);

    if !models.silero.is_file() {
        let tmp = dir.join("silero_vad.onnx.part");
        download(&format!("{MODEL_BASE}/{SILERO}"), &tmp, "the endpointer", &mut say)?;
        std::fs::rename(&tmp, &models.silero).map_err(|e| format!("install {SILERO}: {e}"))?;
    }

    if !models.tokens.is_file() {
        let archive = dir.join(MOONSHINE_ARCHIVE);
        download(
            &format!("{MODEL_BASE}/{MOONSHINE_ARCHIVE}"),
            &archive,
            "the speech model",
            &mut say,
        )?;
        untar(&archive, dir, "the speech model", &mut say)?;
        /* Best-effort: the archive is 200MB of no further use, but failing to
           delete it is not a reason to fail the listen it was fetched for. */
        let _ = std::fs::remove_file(&archive);
    }

    let models = Models::at(dir);
    if !models.complete() {
        return Err(format!(
            "the speech models in {} are incomplete — delete that directory and try again",
            dir.display()
        ));
    }
    Ok(models)
}

/* ── the microphone ───────────────────────────────────────────────────────── */

/// What the capture side hands back: the live stream — which must outlive the
/// loop, since dropping it stops the microphone — and the shape it is really
/// running at, which is not always the shape that was asked for.
struct Capture {
    _stream: cpal::Stream,
    rate: u32,
    channels: usize,
}

/// Open the default input, preferring a configuration that needs no resampling.
///
/// **16kHz is asked for rather than assumed.** Most microphones offer it, and
/// then nothing below has to resample — which is the difference between feeding
/// Silero exactly what it was trained on and feeding it something close. When
/// the device will not do 16k the loop resamples, and `resample` says what that
/// costs.
fn open_microphone(tx: mpsc::Sender<Vec<f32>>) -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone — this machine has no default input device")?;

    let mut chosen: Option<cpal::SupportedStreamConfig> = None;
    if let Ok(ranges) = device.supported_input_configs() {
        for r in ranges {
            if r.min_sample_rate().0 <= RATE
                && RATE <= r.max_sample_rate().0
                && r.sample_format() == cpal::SampleFormat::F32
            {
                chosen = Some(r.with_sample_rate(cpal::SampleRate(RATE)));
                break;
            }
        }
    }
    let config = match chosen {
        Some(c) => c,
        None => device
            .default_input_config()
            .map_err(|e| format!("no usable input configuration: {e}"))?,
    };

    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();

    /* An error on the audio thread is logged and dropped rather than
       propagated, because there is nowhere to propagate it *to*: the loop below
       is already blocked on the channel, and a device that has stopped
       producing arrives there as silence — which is a reading it already knows
       how to end on. */
    let err = |e| log::warn!("voice: input stream error: {e}");

    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &_| {
                let _ = tx.send(data.to_vec());
            },
            err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _: &_| {
                let _ = tx.send(data.iter().map(|s| *s as f32 / 32768.0).collect());
            },
            err,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _: &_| {
                let _ = tx.send(
                    data.iter()
                        .map(|s| (*s as f32 - 32768.0) / 32768.0)
                        .collect(),
                );
            },
            err,
            None,
        ),
        other => return Err(format!("microphone sample format {other:?} is not handled")),
    }
    .map_err(|e| format!("open microphone: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("start microphone: {e}"))?;
    Ok(Capture {
        _stream: stream,
        rate,
        channels,
    })
}

/// Average interleaved channels down to one.
fn mono(block: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return block.to_vec();
    }
    block
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Bring a block to 16kHz.
///
/// **This is a box-filter decimator rather than a polyphase resampler, and the
/// difference is worth stating rather than hiding.** Averaging every input
/// sample that falls inside an output period suppresses most of the energy that
/// would otherwise alias — which is why it is done at all, since plain
/// nearest-sample decimation folds hiss straight into the speech band. It is
/// not as good as a windowed sinc, and **its effect on recognition accuracy has
/// not been measured**: every engine number in the header came from 16kHz
/// files, so they say nothing about this path. It only runs when the device
/// refuses 16kHz.
fn resample(block: &[f32], from: u32) -> Vec<f32> {
    if from == RATE || block.is_empty() {
        return block.to_vec();
    }
    let ratio = from as f64 / RATE as f64;
    let out_len = (block.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio).floor() as usize;
        let end = (((i + 1) as f64 * ratio).ceil() as usize).min(block.len());
        if start >= end {
            continue;
        }
        let span = &block[start..end];
        out.push(span.iter().sum::<f32>() / span.len() as f32);
    }
    out
}

/* ── listening ────────────────────────────────────────────────────────────── */

/// The engine is English-only, so a request for anything else is refused in
/// words rather than answered with confident nonsense.
fn english_only(language: &str) -> Result<(), String> {
    if language.to_ascii_lowercase().starts_with("en") {
        return Ok(());
    }
    Err(format!(
        "the installed model transcribes English only, and {language} was asked for — \
         moonshine-base-en is what this build downloads, and a multilingual model \
         is a different set of weights and a different decision"
    ))
}

fn build_recognizer(m: &Models) -> Result<OfflineRecognizer, String> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config = OfflineModelConfig {
        moonshine: OfflineMoonshineModelConfig {
            preprocessor: Some(m.preprocessor.display().to_string()),
            encoder: Some(m.encoder.display().to_string()),
            uncached_decoder: Some(m.uncached_decoder.display().to_string()),
            cached_decoder: Some(m.cached_decoder.display().to_string()),
            merged_decoder: None,
        },
        tokens: Some(m.tokens.display().to_string()),
        /* Four is what the measurements in the header were taken with, on a
           machine that was already busy. More is not obviously better here —
           the wall has a dozen other cards wanting the same cores. */
        num_threads: 4,
        ..Default::default()
    };
    OfflineRecognizer::create(&config).ok_or_else(|| {
        "could not load the speech model — try deleting the speech directory in the app's \
         data folder so it is fetched again"
            .into()
    })
}

fn build_vad(m: &Models) -> Result<VoiceActivityDetector, String> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(m.silero.display().to_string()),
            threshold: 0.5,
            /* Where a *segment* ends. `TRAILING_SILENCE` above is the separate
               question of whether another segment is coming after it. */
            min_silence_duration: 0.35,
            /* Short enough for "stop", which is one of the eight instant verbs
               and is the shortest thing anybody will say to this wall. */
            min_speech_duration: 0.15,
            window_size: WINDOW as i32,
            max_speech_duration: 20.0,
        },
        sample_rate: RATE as i32,
        num_threads: 1,
        ..Default::default()
    };
    VoiceActivityDetector::create(&config, 30.0)
        .ok_or_else(|| "could not load the voice activity detector".into())
}

fn transcribe(rec: &OfflineRecognizer, samples: &[f32]) -> String {
    let stream = rec.create_stream();
    stream.accept_waveform(RATE as i32, samples);
    rec.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default()
}

/// Listen for one utterance and hand back what was said.
///
/// The shape of the loop is the whole design: audio arrives in blocks on a
/// channel, is brought to mono 16kHz, and is handed to the VAD in exact
/// `WINDOW` frames. Whenever the VAD has *finished* a segment, that segment is
/// transcribed immediately and the running text emitted as a hypothesis — so a
/// long sentence appears in pieces while it is still being spoken, which is as
/// close as a batch engine gets to the running commentary the Windows path had.
///
/// It ends on the first of: `TRAILING_SILENCE` after something was heard,
/// `ONSET_PATIENCE` with nothing heard at all, or `MAX_UTTERANCE` regardless.
pub fn listen(
    models_dir: &Path,
    language: &str,
    partial: impl Fn(&str) + Send + 'static,
) -> Result<Heard, String> {
    english_only(language)?;

    /* The very first listen ever made pays for ~286MB, and a bar that reads
       "listening…" for several minutes is indistinguishable from one that is
       broken — the same *real cause reported as silence* the comment below is
       about, which is why it is worth a line here rather than a note in a
       changelog.

       There is exactly one channel from here to that bar, `voice:hypothesis`,
       because the point of this whole change is that nothing in `src/` had to
       move for it. So the notice goes down that channel, and it is **the one
       thing ever sent that way that is not a guess at what was said**. That is
       a real if small abuse of the field, and it is bounded: the first decoded
       segment overwrites it, the final transcript overwrites it, and nothing
       downstream ever acts on a hypothesis. */
    if !Models::at(models_dir).complete() {
        partial(&format!(
            "fetching the speech model, about {MOONSHINE_MB}MB — first run only"
        ));
    }

    let models = ensure_models(models_dir, &partial)?;
    let recognizer = build_recognizer(&models)?;
    let vad = build_vad(&models)?;

    let (tx, rx) = mpsc::channel::<Vec<f32>>();
    let capture = open_microphone(tx)?;

    /* **The clock starts when the microphone does, and that is the whole of why
       it is declared here rather than at the top.** `ensure_models` downloads
       286MB on a first run, and `build_recognizer` is seconds more; timed from
       the start of the call, `ONSET_PATIENCE` would already be spent by the
       time there was anything to listen to, so the loop's very first check
       would fire and report *nothing was said* — on a freshly installed app,
       for the first thing anybody ever tried to say to it, without the
       microphone having been opened at all.

       That is the failure this file has now been bitten by three times in three
       different costumes: a real cause reported as silence. It also makes `ms`
       honest, since what a caller wants from that field is how long the
       utterance took and not how long a one-off download did. */
    let began = Instant::now();

    let mut frame: Vec<f32> = Vec::with_capacity(WINDOW * 2);
    let mut said: Vec<String> = Vec::new();
    let mut heard_speech = false;
    let mut last_voice = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(block) => {
                let block = mono(&block, capture.channels);
                frame.extend_from_slice(&resample(&block, capture.rate));
                while frame.len() >= WINDOW {
                    let rest = frame.split_off(WINDOW);
                    vad.accept_waveform(&frame);
                    frame = rest;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            /* The device went away mid-utterance. Whatever was already decoded
               is still worth handing back, so this breaks rather than errors. */
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if vad.detected() {
            heard_speech = true;
            last_voice = Instant::now();
        }

        while !vad.is_empty() {
            /* Copied out and the borrow dropped before `pop`, because the
               segment is a view onto memory that `pop` is entitled to free. */
            let samples: Vec<f32> = match vad.front() {
                Some(seg) => seg.samples().to_vec(),
                None => break,
            };
            vad.pop();

            let text = transcribe(&recognizer, &samples);
            if !text.is_empty() {
                said.push(text);
                partial(&said.join(" "));
            }
            heard_speech = true;
            last_voice = Instant::now();
        }

        if heard_speech && last_voice.elapsed() >= TRAILING_SILENCE {
            break;
        }
        if !heard_speech && began.elapsed() >= ONSET_PATIENCE {
            break;
        }
        if began.elapsed() >= MAX_UTTERANCE {
            break;
        }
    }

    /* Anything the VAD is still holding when the loop ends — a final segment
       whose trailing silence *is* the silence that ended the turn. Without this
       the last few words of every utterance go missing, which reads as the
       recogniser mishearing rather than as the loop stopping early. */
    vad.flush();
    while !vad.is_empty() {
        let Some(samples) = vad.front().map(|s| s.samples().to_vec()) else {
            break;
        };
        vad.pop();
        let text = transcribe(&recognizer, &samples);
        if !text.is_empty() {
            said.push(text);
        }
    }

    let text = said.join(" ").trim().to_string();
    Ok(Heard {
        confidence: if text.is_empty() { "rejected" } else { "medium" }.to_string(),
        text,
        language: language.to_string(),
        ms: began.elapsed().as_millis() as u64,
    })
}

/// What the recogniser could do, without opening the microphone.
pub fn hearing(models_dir: &Path) -> Result<Hearing, String> {
    let ready = Models::at(models_dir).complete();
    let device = cpal::default_host()
        .default_input_device()
        .and_then(|d| d.name().ok());
    Ok(Hearing {
        language: DEFAULT_LANGUAGE.to_string(),
        ready,
        to_fetch_mb: if ready { 0 } else { MOONSHINE_MB },
        device,
    })
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/// Where the weights live: beside the database, under the durable identity.
///
/// Resolved from the `AppHandle` rather than spelled out, so this is not a
/// third hard-coded copy of `dev.skein.studio` — which `CLAUDE.md` explains at
/// length is the one string a rename must not touch, because it is the folder
/// everything this app has ever written lives in.
fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("speech"))
}

/// What the recogniser can do, before anything is held down.
#[tauri::command]
pub async fn voice_hearing(app: tauri::AppHandle) -> Result<Hearing, String> {
    let dir = models_dir(&app)?;
    crate::off_main(move || hearing(&dir)).await?
}

/// Listen for one utterance and hand back what was said.
///
/// **Blocks for as long as somebody is talking**, plus up to five seconds of
/// silence before they start — and, on the very first call ever made, for
/// however long ~286MB takes to arrive. So it is `off_main` for the reason the
/// rule gives rather than as a precaution: on the main thread this would stop
/// every card on the wall being painted for the duration, and then land the
/// whole backlog at once.
#[tauri::command]
pub async fn voice_listen(
    app: tauri::AppHandle,
    language: Option<String>,
) -> Result<Heard, String> {
    let language = language.unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    let dir = models_dir(&app)?;
    crate::off_main(move || {
        listen(&dir, &language, move |words| {
            /* One more event on the pipe that already carries `conv:event`,
               which is the whole of why nothing downstream of here needs to
               know a microphone exists. Failures are dropped: a guess that did
               not reach the window is a guess, and the recognition it belongs
               to is still running. */
            let _ = app.emit("voice:hypothesis", words);
        })
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_language_is_not_the_system_one() {
        /* Not a tautology — it is the whole of why this constant exists. The
           wall's verbs are English and the OS's speech language is whatever it
           is this week (`fr-FR` on 2026-09-06, `en-US` on 2026-09-08, with
           nobody touching it in between), so a recogniser left to itself could
           hand back words no rung can parse — and that fails as "it hears me
           and nothing happens". The engine being English-only settles the
           question rather than making the constant pointless. */
        assert_eq!(DEFAULT_LANGUAGE, "en-US");
        assert!(english_only(DEFAULT_LANGUAGE).is_ok());
    }

    #[test]
    fn a_language_this_model_cannot_speak_is_refused_by_name() {
        /* The property: it names the language that was asked for and says what
           is installed, rather than transcribing French as though it were
           English and handing back words nobody said. */
        let said = english_only("fr-FR").expect_err("french is not available");
        assert!(said.contains("fr-FR"), "{said}");
        assert!(said.contains("English"), "{said}");
    }

    #[test]
    fn the_files_opened_are_the_files_the_release_ships() {
        /* The test that would catch a rename inside the archive without
           anybody having to hold a microphone. These five names were read off
           the extracted release directory on 2026-09-09. */
        let m = Models::at(Path::new("/models"));
        for p in [
            &m.preprocessor,
            &m.encoder,
            &m.uncached_decoder,
            &m.cached_decoder,
            &m.tokens,
        ] {
            assert!(
                p.to_string_lossy().contains(MOONSHINE),
                "moonshine files live inside the extracted directory: {}",
                p.display()
            );
        }
        assert!(m.encoder.to_string_lossy().ends_with("encode.int8.onnx"));
        /* Silero sits beside that directory rather than inside it — separate
           download, separate model, and it survives deleting the other. */
        assert!(!m.silero.to_string_lossy().contains(MOONSHINE));
    }

    #[test]
    fn resampling_is_a_no_op_at_the_rate_the_models_want() {
        let block = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(resample(&block, RATE), block);
    }

    #[test]
    fn resampling_averages_rather_than_drops() {
        /* Averaging is the entire point. Nearest-sample decimation would answer
           [1.0, 1.0] here and fold the alternating component into the speech
           band as hiss; the average is the DC content, which is what a real
           low-pass would leave behind too. */
        let block = vec![1.0, 0.0, 1.0, 0.0];
        let out = resample(&block, RATE * 2);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|s| (*s - 0.5).abs() < 1e-6), "{out:?}");
    }

    #[test]
    fn channels_are_averaged_not_picked() {
        /* A microphone with a dead right channel should read as quiet rather
           than as silence, and taking channel zero would make those two cases
           indistinguishable. */
        assert_eq!(mono(&[1.0, 0.0, 1.0, 0.0], 2), vec![0.5, 0.5]);
        assert_eq!(mono(&[0.25, 0.75], 1), vec![0.25, 0.75]);
    }

    #[test]
    fn a_model_directory_missing_a_file_is_not_complete() {
        /* `complete` is what stands between a half-finished download and ONNX
           Runtime failing with a message about a protobuf. It has to be an
           every-file check rather than a directory-exists one. */
        let dir = std::env::temp_dir().join("volery-voice-test-incomplete");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(MOONSHINE)).expect("make the test directory");
        std::fs::write(dir.join(SILERO), b"not really a model").expect("write silero");
        assert!(
            !Models::at(&dir).complete(),
            "silero alone is not the whole set"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
