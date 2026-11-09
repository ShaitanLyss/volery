//! A person's gesture on another wall's card — the vocabulary is the flyway
//! core's (`flyway_core::act`, whose module note is the design), re-exported
//! whole. The one thing added here is the half that reads this wall: whether
//! a service named in a `provider` move is one this wall can run a card on.

pub use flyway_core::act::*;

use serde_json::Value;

/// `flyway_core::act::read_args_with`, asked against this wall's own provider
/// table — the only form of it this wall ever calls.
pub fn read_args(verb: &str, args: &Value) -> Result<Value, String> {
    read_args_with(verb, args, &|p| crate::provider::named(p).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The provider check is the one this wall adds, and it is the provider
    /// table's answer: a service it knows is taken, `claude` always is, and a
    /// name it has never heard of is refused in words.
    #[test]
    fn a_provider_move_is_held_to_this_walls_services() {
        assert_eq!(
            read_args("provider", &json!({ "provider": "deepseek" })).unwrap(),
            json!({ "provider": "deepseek", "sawWorking": false })
        );
        assert!(read_args("provider", &json!({ "provider": "claude", "sawWorking": true })).is_ok());
        assert!(read_args("provider", &json!({ "provider": "nobody" })).unwrap_err().contains("no service called nobody"));
        assert!(read_args("provider", &json!({ "provider": " " })).is_err());
    }
}
