//! The link's half of the flyway's directory (`flyway/directory.rs`): reading
//! it on a clock of its own, adding this wall, and taking a name out when this
//! wall leaves or a person forgets one.
//!
//! On its own loop rather than inside the tick, because the two answer
//! different questions at different rates. The tick talks to walls this one
//! already knows, every thirty seconds. The directory is how it learns of a
//! wall it does not know, which wants a read every few minutes, and a slow
//! relay must not hold a tick's dials behind it.

use std::sync::Arc;
use std::time::Duration;

use super::super::directory::{self, Read};
use super::Link;

/// How long leaving waits to take this wall's name out. Best effort: a leave
/// that could not reach the relay leaves a name the others dial and get no
/// answer from, one failed dial per backoff, and the wall takes it out itself
/// if it ever joins and leaves again.
const WITHDRAW_WITHIN: Duration = Duration::from_secs(6);

impl Link {
    /// One read of the directory: keep its names for the tick to dial, and add
    /// this wall or renew the record if `directory::wanted` says so.
    pub(super) async fn consult_directory(self: &Arc<Self>) {
        let read = self.wire.directory_read().await;
        if let Ok(mut d) = self.directory.lock() {
            /* An unreadable read keeps what was last read: a relay hiccup is
               not the list becoming empty. */
            if !matches!(read, Read::Unreadable) {
                *d = directory::names(&read);
            }
        }
        let Some(walls) = directory::wanted(&read, &self.me, now_micros()) else { return };
        let joining = !matches!(&read, Read::Found { walls, .. } if walls.iter().any(|w| w.eq_ignore_ascii_case(&self.me)));
        match self.write_directory(&walls).await {
            Ok(()) if joining => log::info!("flyway: this wall is in the flyway's directory"),
            Ok(()) => log::debug!("flyway: renewed the flyway's directory"),
            Err(e) => log::info!("flyway: could not write the flyway's directory: {e}"),
        }
    }

    /// Take `name` out of the directory, if it is there.
    pub(super) async fn unlist(self: &Arc<Self>, name: &str) -> Result<bool, String> {
        let read = self.wire.directory_read().await;
        let Some(walls) = directory::without(&read, name) else { return Ok(false) };
        self.write_directory(&walls).await?;
        if let Ok(mut d) = self.directory.lock() {
            d.retain(|w| !w.eq_ignore_ascii_case(name));
        }
        Ok(true)
    }

    /// This wall leaving: its own name out, bounded.
    pub(super) async fn withdraw_from_directory(self: &Arc<Self>) {
        let me = self.me.clone();
        match tokio::time::timeout(WITHDRAW_WITHIN, self.unlist(&me)).await {
            Ok(Ok(true)) => log::info!("flyway: took this wall out of the flyway's directory"),
            Ok(Ok(false)) => {}
            Ok(Err(e)) => log::info!("flyway: could not take this wall out of the directory: {e}"),
            Err(_) => log::info!("flyway: the directory did not answer in time; this wall's name stays there"),
        }
    }

    async fn write_directory(&self, walls: &std::collections::BTreeSet<String>) -> Result<(), String> {
        let values = directory::encode(self.wire.key(), walls, &self.me)?;
        self.wire.directory_write(&values).await
    }
}

fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}
