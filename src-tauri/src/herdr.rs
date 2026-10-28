//! Our own client of the local Herdr daemon, written against Herdr's
//! endpoint protocol: its wire types, the handshake, framing, socket
//! discovery, the session rules, and the connection worker. Local Unix
//! sockets only; SSH, WSL, and cloud hosts are not reached from here.

mod client;
mod codec;
mod endpoint;
mod error;
mod session;
mod socket;
mod surface;
pub mod wire;

pub use client::{ClientHandle, ConnectOptions, connect};
pub use error::{Error, Outdated};
pub use session::Event;

pub type Result<T, E = Error> = std::result::Result<T, E>;
