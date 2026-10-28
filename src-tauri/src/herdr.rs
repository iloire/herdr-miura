//! Our own client of the local Herdr daemon, written against Herdr's
//! endpoint protocol: its wire types, the handshake, framing, socket
//! discovery, the session rules, and the connection worker. It reaches this
//! machine's daemon over its Unix socket, or another machine's over `ssh`.

mod client;
mod codec;
mod endpoint;
mod error;
mod health;
mod session;
mod socket;
pub mod ssh;
mod surface;
pub mod wire;

pub use client::{ClientHandle, ConnectOptions, Target, connect};
pub use error::{Error, Outdated};
pub use session::Event;

pub type Result<T, E = Error> = std::result::Result<T, E>;
