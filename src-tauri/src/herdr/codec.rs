//! Frames on the client socket: a little-endian u32 length, then the message
//! in bincode 2's standard encoding through serde, as Herdr's own
//! `read_message`/`write_message` frame them. Both directions are bounded.

use serde::{Serialize, de::DeserializeOwned};
use std::io::{self, Read, Write};

/// Largest frame sent, and largest received outside graphics.
pub const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;
/// Largest frame received: a surface may carry images.
pub const MAX_GRAPHICS_FRAME_SIZE: usize = 32 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the daemon closed the connection")]
    Closed,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("a frame of {0} bytes is larger than allowed")]
    TooLarge(usize),
    #[error("an empty frame")]
    Empty,
    #[error("a frame left {0} bytes undecoded")]
    TrailingBytes(usize),
    #[error("could not encode a message")]
    Encode(#[from] bincode::error::EncodeError),
    #[error("could not decode a message")]
    Decode(#[from] bincode::error::DecodeError),
}

pub fn encode<M: Serialize>(message: &M) -> Result<Vec<u8>, Error> {
    let mut frame = vec![0; 4];
    bincode::serde::encode_into_std_write(message, &mut frame, bincode::config::standard())?;
    let len = frame.len() - 4;
    if len == 0 {
        return Err(Error::Empty);
    }
    if len > MAX_FRAME_SIZE {
        return Err(Error::TooLarge(len));
    }
    // `len` fits: it is at most MAX_FRAME_SIZE.
    frame[..4].copy_from_slice(&(len as u32).to_le_bytes());
    Ok(frame)
}

pub fn write<M: Serialize>(writer: &mut impl Write, message: &M) -> Result<(), Error> {
    writer.write_all(&encode(message)?)?;
    Ok(writer.flush()?)
}

/// The next whole frame. End of stream before a prefix is [`Error::Closed`].
pub fn read<M: DeserializeOwned>(reader: &mut impl Read) -> Result<M, Error> {
    let mut prefix = [0; 4];
    match reader.read_exact(&mut prefix) {
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Err(Error::Closed),
        result => result?,
    }
    let len = u32::from_le_bytes(prefix) as usize;
    if len == 0 {
        return Err(Error::Empty);
    }
    if len > MAX_GRAPHICS_FRAME_SIZE {
        return Err(Error::TooLarge(len));
    }
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload)?;
    decode(&payload)
}

pub fn decode<M: DeserializeOwned>(payload: &[u8]) -> Result<M, Error> {
    let config = bincode::config::standard().with_limit::<MAX_GRAPHICS_FRAME_SIZE>();
    let (message, used) = bincode::serde::decode_from_slice(payload, config)?;
    if used != payload.len() {
        return Err(Error::TrailingBytes(payload.len() - used));
    }
    Ok(message)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
