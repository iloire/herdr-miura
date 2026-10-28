//! Whether a remote link is still alive. A local socket fails loudly when the
//! daemon goes; an SSH link can go quiet instead, so the session pings when
//! nothing has arrived for a while and fails when a ping goes unanswered.
//! Any message from the daemon counts as an answer, the pong included.

use std::time::{Duration, Instant};

/// Silence before a routine ping.
pub const QUIET: Duration = Duration::from_secs(5);
/// How long a routine ping may go unanswered.
pub const PING_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a probe asked for by the app, as when the window comes back
/// after the Mac slept, may go unanswered.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
pub const PING_KIND: &str = "endpoint.health.ping.v1";
pub const CAPABILITY: &str = "health_check";

#[derive(Debug, Clone, Copy)]
struct Ping {
    due: Instant,
    sent: bool,
}

#[derive(Debug)]
pub struct Health {
    received: Instant,
    ping: Option<Ping>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Timeout;

impl Health {
    pub fn new(now: Instant) -> Self {
        Self { received: now, ping: None }
    }

    pub fn received(&mut self, now: Instant) {
        self.received = now;
        self.ping = None;
    }

    /// Asks the link to prove itself soon. A ping already out only has its
    /// deadline brought forward.
    pub fn probe(&mut self, now: Instant) {
        let due = now + PROBE_TIMEOUT;
        match &mut self.ping {
            Some(ping) => ping.due = ping.due.min(due),
            None => self.ping = Some(Ping { due, sent: false }),
        }
    }

    /// When [`Self::tick`] next has something to do.
    pub fn deadline(&self) -> Instant {
        match self.ping {
            // Due at once: any instant already past will do.
            Some(Ping { sent: false, .. }) => self.received,
            Some(ping) => ping.due,
            None => self.received + QUIET,
        }
    }

    /// Whether a ping must be written now, or the link is dead.
    pub fn tick(&mut self, now: Instant) -> Result<bool, Timeout> {
        if let Some(ping) = &mut self.ping {
            if now >= ping.due {
                return Err(Timeout);
            }
            let send = !ping.sent;
            ping.sent = true;
            return Ok(send);
        }
        if now >= self.received + QUIET {
            self.ping = Some(Ping { due: now + PING_TIMEOUT, sent: true });
            return Ok(true);
        }
        Ok(false)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
