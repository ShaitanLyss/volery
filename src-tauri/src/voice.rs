//! Hearing what was said, and nothing else.
//!
//! This is the front door `docs/VOICE.md` left unbuilt: audio in, one line of
//! text out. Everything downstream — resolving referents, building a plan,
//! deciding whether it may simply happen — is `src/lib/voice.ts` and
//! `src/lib/steward.ts`, and none of it knows a microphone exists. A transcript
//! is text on the ordinary event pipeline.
//!
//! ## Why Windows' own recogniser, and what that cost
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
//! So the on-device DNN engines are installed for both, and compiling a
//! dictation grammar costs 3–5ms and needs **no model download and no new
//! crate** — only four more features on the `windows` crate this tree already
//! depends on for job objects. Against whisper, which wants a 75–150MB model
//! file and a C++ build, that is not a close call for a first cut.
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
//! Nothing here changes that setting or asks the OS to. It is a privacy setting
//! on somebody's machine, the local engines being installed does *not* establish
//! that accepting it keeps audio on the machine, and this file is in no position
//! to answer that question. What it does instead is **name the gate exactly**, so
//! the failure is one line telling you what to change rather than a microphone
//! that does nothing.
//!
//! ## And it must be told a language, because the wall's verbs are English
//!
//! `SystemSpeechLanguage` here is `fr-FR`. Left to itself the recogniser would
//! listen in French and hand back French — which the grammar in `voice.ts`
//! cannot parse a word of, since its verbs are `select`, `stop`, `open`. That
//! fails as *"it hears me and nothing happens"*, with nothing anywhere to say
//! why. So the language is an argument with an English default rather than
//! whatever the OS is set to, and the caller may override it the day the
//! vocabulary grows a second language.

use serde::Serialize;

#[cfg(windows)]
use windows::{
    core::{Interface, HSTRING},
    Globalization::Language,
    Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechRecognitionConfidence, SpeechRecognitionResultStatus,
        SpeechRecognitionScenario, SpeechRecognitionTopicConstraint, SpeechRecognizer,
    },
    Win32::System::Com::CoIncrementMTAUsage,
};

/// The language the wall listens in unless told otherwise. See the note above:
/// this is not the system's, on purpose.
pub const DEFAULT_LANGUAGE: &str = "en-US";

/// One utterance, heard.
#[derive(Debug, Serialize)]
pub struct Heard {
    pub text: String,
    /// The recogniser's own word for how sure it is: `high`, `medium`, `low` or
    /// `rejected`. Carried rather than acted on — what to do about a `low` is a
    /// question for the rung that has the wall in front of it, and thresholding
    /// here would throw the evidence away before anybody could weigh it.
    pub confidence: String,
    /// Which language it listened in, so a transcript that came back as
    /// nonsense can be told apart from one that came back in French.
    pub language: String,
    pub ms: u64,
}

/// What the recogniser can do here, asked before anybody holds a key down.
#[derive(Debug, Serialize)]
pub struct Hearing {
    /// What Windows would listen in if it were not told. Reported because it
    /// disagreeing with `DEFAULT_LANGUAGE` is normal and not a fault.
    pub system: String,
    /// Every language dictation works in on this machine.
    pub dictation: Vec<String>,
    /// Whether `DEFAULT_LANGUAGE` is among them.
    pub ready: bool,
}

/* ── saying what went wrong in words somebody can act on ──────────────────── */

/// The gate this machine is behind today, and the only HRESULT named from
/// measurement rather than from memory.
const PRIVACY_NOT_ACCEPTED: i32 = 0x8004_5509_u32 as i32;
/// `E_ACCESSDENIED`. Not a speech code at all — a universal Windows one — which
/// is the only reason it is safe to name without having produced it here.
const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;

/// An HRESULT from the speech stack, in a sentence.
///
/// **Two codes are named and the rest are passed through verbatim**, and the
/// asymmetry is deliberate. Naming HRESULTs out of memory is how a wrong,
/// confident message gets in front of somebody — and a wrong explanation is
/// worse than a raw code, because a raw code can be searched for and a
/// plausible lie cannot. `0x80045509` is named because this machine produces it;
/// `E_ACCESSDENIED` because it means one thing everywhere.
pub(crate) fn explain(code: i32, message: &str) -> String {
    match code {
        PRIVACY_NOT_ACCEPTED => "windows has not accepted its speech privacy policy — \
             Settings → Privacy & security → Speech, then try again"
            .to_string(),
        ACCESS_DENIED => "windows refused the microphone — \
             Settings → Privacy & security → Microphone"
            .to_string(),
        _ => format!("the recogniser refused: {message} (0x{:08x})", code as u32),
    }
}

#[cfg(windows)]
/// A recognition that ended without an error but without words either.
fn why_empty(status: SpeechRecognitionResultStatus) -> Option<&'static str> {
    match status {
        SpeechRecognitionResultStatus::Success => None,
        SpeechRecognitionResultStatus::TimeoutExceeded => Some("nothing was said"),
        SpeechRecognitionResultStatus::MicrophoneUnavailable => Some("no microphone"),
        SpeechRecognitionResultStatus::AudioQualityFailure => Some("the audio was unusable"),
        SpeechRecognitionResultStatus::UserCanceled => Some("cancelled"),
        SpeechRecognitionResultStatus::NetworkFailure => Some("the recogniser wanted a network"),
        SpeechRecognitionResultStatus::TopicLanguageNotSupported => {
            Some("dictation is not installed for that language")
        }
        _ => Some("the recogniser gave no reason"),
    }
}

#[cfg(windows)]
fn confidence_of(c: SpeechRecognitionConfidence) -> &'static str {
    match c {
        SpeechRecognitionConfidence::High => "high",
        SpeechRecognitionConfidence::Medium => "medium",
        SpeechRecognitionConfidence::Low => "low",
        _ => "rejected",
    }
}

/* ── the apartment ────────────────────────────────────────────────────────── */

#[cfg(windows)]
/// Keep a multi-threaded apartment alive for the life of the process.
///
/// `CoIncrementMTAUsage` rather than `RoInitialize`, and the difference matters
/// here: the recognition runs on `spawn_blocking`'s pool, so the thread that
/// needs an apartment is one this code does not own and cannot uninitialize.
/// `RoInitialize` per call would take a reference on every one of them and give
/// none back. This asks the runtime to keep an MTA existing, which is what is
/// actually wanted, and is safe to call more than once — so the `OnceLock` is
/// tidiness rather than correctness.
fn apartment() {
    use std::sync::OnceLock;
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        /* The cookie is deliberately dropped on the floor: giving it back would
           end the apartment, and nothing here ever wants that. */
        let _ = unsafe { CoIncrementMTAUsage() };
    });
}

/* ── asking ───────────────────────────────────────────────────────────────── */

#[cfg(windows)]
pub fn hearing() -> Result<Hearing, String> {
    apartment();
    let system = SpeechRecognizer::SystemSpeechLanguage()
        .and_then(|l| l.LanguageTag())
        .map(|t| t.to_string())
        .map_err(|e| explain(e.code().0, &e.message()))?;
    let mut dictation = Vec::new();
    for lang in &SpeechRecognizer::SupportedTopicLanguages()
        .map_err(|e| explain(e.code().0, &e.message()))?
    {
        if let Ok(tag) = lang.LanguageTag() {
            dictation.push(tag.to_string());
        }
    }
    let ready = dictation.iter().any(|t| t == DEFAULT_LANGUAGE);
    Ok(Hearing { system, dictation, ready })
}

#[cfg(windows)]
pub fn listen(language: &str) -> Result<Heard, String> {
    apartment();
    let began = std::time::Instant::now();
    let fail = |e: windows::core::Error| explain(e.code().0, &e.message());

    let lang = Language::CreateLanguage(&HSTRING::from(language)).map_err(fail)?;
    let rec = SpeechRecognizer::Create(&lang).map_err(fail)?;

    /* Free dictation. A list constraint would be faster and much more accurate,
       and it is the wrong shape: the grammar rung is eight verbs but the steward
       rung exists precisely so you can say anything, and a recogniser restricted
       to a word list could never hand it a sentence it had not been told about. */
    let topic = SpeechRecognitionTopicConstraint::CreateWithTag(
        SpeechRecognitionScenario::Dictation,
        &HSTRING::from("wall"),
        &HSTRING::from("wall"),
    )
    .map_err(fail)?;
    rec.Constraints()
        .map_err(fail)?
        .Append(&topic.cast::<ISpeechRecognitionConstraint>().map_err(fail)?)
        .map_err(fail)?;
    rec.CompileConstraintsAsync().map_err(fail)?.get().map_err(fail)?;

    /* The timeouts are left as Windows sets them — measured here as 5s of
       initial silence and 0.5s of end silence. 0.5s is probably too eager for a
       sentence with a pause in it, and that is a number to change once somebody
       can hear it being wrong; setting one now would be an unmeasured guess
       about a thing whose whole point is how it feels. */
    let result = rec.RecognizeAsync().map_err(fail)?.get().map_err(fail)?;

    let status = result.Status().map_err(fail)?;
    if let Some(why) = why_empty(status) {
        return Err(why.to_string());
    }
    Ok(Heard {
        text: result.Text().map_err(fail)?.to_string(),
        confidence: confidence_of(result.Confidence().map_err(fail)?).to_string(),
        language: language.to_string(),
        ms: began.elapsed().as_millis() as u64,
    })
}

#[cfg(not(windows))]
pub fn hearing() -> Result<Hearing, String> {
    Err("speech recognition is Windows-only here".into())
}

#[cfg(not(windows))]
pub fn listen(_language: &str) -> Result<Heard, String> {
    Err("speech recognition is Windows-only here".into())
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/// What the recogniser can do, before anything is held down.
///
/// `async` and off the main thread like everything else that talks to the OS —
/// this one is only a few milliseconds, but `CoIncrementMTAUsage` and the first
/// touch of the speech stack are not things to do on the thread that paints
/// every card on the wall. See the `off_main` rule in `CLAUDE.md`.
#[tauri::command]
pub async fn voice_hearing() -> Result<Hearing, String> {
    crate::off_main(hearing).await?
}

/// Listen for one utterance and hand back what was said.
///
/// **Blocks for as long as somebody is talking**, plus up to five seconds of
/// silence before they start, so it is `off_main` for the reason the rule gives
/// rather than as a precaution: on the main thread this would stop the whole
/// wall being painted for the duration and then land the backlog at once.
#[tauri::command]
pub async fn voice_listen(language: Option<String>) -> Result<Heard, String> {
    let language = language.unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    crate::off_main(move || listen(&language)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_this_machine_is_behind_is_named_and_actionable() {
        let said = explain(PRIVACY_NOT_ACCEPTED, "The speech privacy policy was not accepted");
        assert!(said.contains("Privacy & security"), "{said}");
        assert!(said.contains("Speech"), "{said}");
        /* And it does not put the raw code in front of somebody who now has
           something to do instead. */
        assert!(!said.contains("0x"), "{said}");
    }

    #[test]
    fn a_refused_microphone_names_the_other_panel() {
        assert!(explain(ACCESS_DENIED, "Access is denied").contains("Microphone"));
    }

    #[test]
    fn a_code_nobody_has_measured_is_passed_through_rather_than_guessed_at() {
        /* The property worth protecting: a raw code can be searched for, and a
           plausible-but-wrong explanation cannot be. */
        let said = explain(0x8004_5510_u32 as i32, "Something else went wrong");
        assert!(said.contains("Something else went wrong"), "{said}");
        assert!(said.contains("0x80045510"), "{said}");
    }

    #[test]
    fn the_default_language_is_not_the_system_one() {
        /* Not a tautology — it is the whole of why this constant exists. The
           wall's verbs are English and this machine's speech language is French,
           so a recogniser left to itself hands back words no rung can parse and
           the failure is "it hears me and nothing happens". */
        assert_eq!(DEFAULT_LANGUAGE, "en-US");
    }

    #[cfg(windows)]
    #[test]
    fn the_engines_are_installed_and_dictation_is_reachable() {
        /* Touches the real speech stack and asks it what it has, which needs no
           microphone and no privacy policy — the probe established that
           compiling is allowed where recognising is not. If this ever fails, the
           machine has lost its language packs and everything below is moot. */
        let h = hearing().expect("the speech stack should answer");
        assert!(!h.system.is_empty());
        assert!(h.ready, "en-US dictation should be installed: {h:?}");
    }
}
