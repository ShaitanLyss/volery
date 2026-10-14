//! A person opening a card on another wall, from the wall's own menu.
//!
//! The agents' road to another machine is `spawn` with a `host`
//! (`spawn::elsewhere`), and it refuses an empty brief: a card an *agent* opens
//! with nothing to do is a process and an API turn spent on nothing, and the
//! agent always has something to say or it would not be asking. A person's
//! right-click on a remote project's section is the other case. It is a `+`
//! over there — Lyss: *"shadow projects should behave as local projects by
//! design"* — and a local `+` opens a card that spends nothing until somebody
//! types into it. So the person's ask carries no brief at all, and the far
//! wall opens an empty card exactly as its own `+` would; the person types the
//! first message from this wall's dock once the card's shadow arrives.
//!
//! What makes that safe to allow is **who is asking**, and the wire already
//! says it: `Origin::card` is `None` for a person and the asking card for an
//! agent. So the empty brief is allowed for exactly that shape and nothing else
//! (`brief_refusal`), on the wall that opens the card, which is the one that
//! has to be right — an agent's ask arriving empty from a build that forgot the
//! guard is still refused there.
//!
//! Everything else a remote spawn is held to is unchanged: the far wall's "take
//! work from other walls" switch, a quiet wall refused at once and never queued,
//! the far wall's own bounds (`Facts::bound`), the territory by name from what
//! that wall announced. Pure; the command is `link::flyway_open`.

use super::fleet::{Facts, Refusal, Request, Territory};
use serde_json::json;

/// The word a wall announces in `Facts::can` when it opens a card a *person*
/// on another wall asked for with no brief. A wall from before this refuses an
/// empty brief whoever asked, so the asker checks for the word and says
/// *needs updating* up front rather than letting the far wall answer with an
/// agent's reason. Not one of `fleet::CAN`, for `tail::WORD`'s reason: those
/// are what an *agent* may ask, and an agent may not ask this.
pub const WORD: &str = "open_empty";

/// Why a far wall will not open a card on this brief, or `None` when it will.
///
/// Empty is refused only when a card asked — an agent's ask always has a brief
/// or it is one of the spirals `spawn.md` is about. A person's ask may be
/// empty, because a person is at a keyboard and types the first message.
pub fn brief_refusal(brief: &str, asker_card: Option<&str>) -> Option<&'static str> {
    if brief.trim().is_empty() && asker_card.is_some() {
        return Some("the brief was empty, and a card opened with nothing to do is a process spent on nothing");
    }
    None
}

/// The request a person's right-click makes, judged against what that wall
/// last said about itself (`None` for a wall this one has never heard).
///
/// Refuses here what can be refused without a round trip, so the menu's click
/// says why at once: a wall never heard, one too old to open an empty card,
/// one not taking work, a project it does not hold, a model or effort `spawn`
/// would not take either. Quiet is refused by `Fleet::ask` itself, which owns
/// that clock; the bounds and the switch are weighed again by the far wall at
/// the moment it decides, since what it announced can be half a minute old.
pub fn person_request(
    id: String,
    host: &str,
    project: &str,
    model: Option<&str>,
    effort: Option<&str>,
    facts: Option<&Facts>,
) -> Result<Request, String> {
    let host = host.trim();
    let project = project.trim();
    if host.is_empty() {
        return Err("no wall was named, so no card was asked for".into());
    }
    let Some(facts) = facts else {
        return Err(format!("{host} is not a wall this one has heard from, so no card was asked for"));
    };
    if !facts.can.iter().any(|c| c == WORD) {
        return Err(format!("{host} needs updating to open a card from here"));
    }
    if !facts.accepting {
        return Err(Refusal::NotAccepting.reason(host));
    }
    let setup = json!({ "model": model, "effort": effort });
    let model = crate::spawn::asked_model(&setup)?;
    let effort = crate::spawn::asked_effort(&setup, model.as_deref())?;
    let territory = territory_named(&facts.territories, project).ok_or_else(|| {
        let has = if facts.territories.is_empty() {
            "no projects at all".to_string()
        } else {
            facts.territories.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ")
        };
        format!("{host} has no project called {project:?} — it holds {has}")
    })?;
    Ok(Request {
        id,
        card: None,
        to: host.to_string(),
        territory,
        brief: String::new(),
        title: None,
        model,
        effort,
        needs: Vec::new(),
    })
}

/// The territory a section's name stands for, as `spawn::elsewhere` resolves
/// one: by name, case folded, or by identity.
fn territory_named(offered: &[Territory], name: &str) -> Option<Territory> {
    if name.is_empty() {
        return None;
    }
    offered.iter().find(|t| t.name.eq_ignore_ascii_case(name) || t.identity == name).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            accepting: true,
            can: vec![WORD.to_string()],
            territories: vec![
                Territory { identity: "id-skein".into(), name: "skein".into() },
                Territory { identity: "id-rise".into(), name: "RISE".into() },
            ],
            ..Facts::default()
        }
    }

    #[test]
    fn an_empty_brief_is_a_persons_and_never_an_agents() {
        assert_eq!(brief_refusal("", None), None);
        assert_eq!(brief_refusal("  \n", None), None);
        assert!(brief_refusal("", Some("card-1")).is_some());
        assert!(brief_refusal(" \t", Some("card-1")).is_some());
        assert_eq!(brief_refusal("build it", Some("card-1")), None);
        assert_eq!(brief_refusal("build it", None), None);
    }

    #[test]
    fn a_persons_request_is_empty_and_names_nobody() {
        let r = person_request("r1".into(), "lab", "rise", Some("opus"), Some("xhigh"), Some(&facts())).unwrap();
        assert_eq!(r.card, None, "a person's ask names no card, which is what lets it be empty");
        assert_eq!(r.brief, "");
        assert_eq!(r.to, "lab");
        assert_eq!(r.territory.identity, "id-rise", "matched by name, case folded");
        assert_eq!(r.model.as_deref(), Some("opus"));
        assert_eq!(r.effort.as_deref(), Some("xhigh"));
        assert!(r.needs.is_empty() && r.title.is_none());
        /* And the far wall's rule lets exactly this through. */
        assert_eq!(brief_refusal(&r.brief, r.card.as_deref()), None);
    }

    #[test]
    fn the_machines_own_setting_is_no_model_and_no_effort() {
        let r = person_request("r1".into(), "lab", "skein", None, None, Some(&facts())).unwrap();
        assert_eq!((r.model, r.effort), (None, None));
    }

    #[test]
    fn what_can_be_refused_without_a_round_trip_is() {
        let f = facts();
        let no = |host: &str, project: &str, model: Option<&str>, effort: Option<&str>, facts: Option<&Facts>| {
            person_request("r".into(), host, project, model, effort, facts).unwrap_err()
        };
        assert!(no("lab", "skein", None, None, None).contains("not a wall this one has heard"));
        assert!(no("", "skein", None, None, Some(&f)).contains("no wall"));
        let older = Facts { can: vec!["send".into()], ..f.clone() };
        assert!(no("lab", "skein", None, None, Some(&older)).contains("needs updating"));
        let closed = Facts { accepting: false, ..f.clone() };
        assert!(no("lab", "skein", None, None, Some(&closed)).contains("not taking work"));
        let missing = no("lab", "nova", None, None, Some(&f));
        assert!(missing.contains("no project called \"nova\"") && missing.contains("skein, RISE"), "{missing}");
        assert!(no("lab", "", None, None, Some(&f)).contains("no project"));
        /* `spawn`'s own gates on the pair, unchanged. */
        assert!(no("lab", "skein", Some("gpt"), None, Some(&f)).contains("not a model"));
        assert!(no("lab", "skein", Some("haiku"), Some("high"), Some(&f)).contains("takes no thinking effort"));
        assert!(no("lab", "skein", None, Some("high"), Some(&f)).contains("named no model"));
    }
}
