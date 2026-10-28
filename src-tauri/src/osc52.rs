//! OSC 52 clipboard writes the daemon forwards as base64. Only bounded UTF-8
//! text is accepted; anything else is dropped rather than guessed at, so a
//! hostile escape cannot put arbitrary bytes on the pasteboard.

use base64::{
    Engine,
    alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};

/// Matches herdr-gpui's bound on clipboard reads and writes.
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

const CONFIG: GeneralPurposeConfig =
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent);
const STANDARD: GeneralPurpose = GeneralPurpose::new(&alphabet::STANDARD, CONFIG);
const URL_SAFE: GeneralPurpose = GeneralPurpose::new(&alphabet::URL_SAFE, CONFIG);

pub fn decode(data: &str) -> Option<String> {
    // Refuse before allocating: four symbols carry at most three bytes.
    if data.len() > MAX_TEXT_BYTES.div_ceil(3) * 4 + 4 {
        return None;
    }
    let bytes = STANDARD.decode(data).or_else(|_| URL_SAFE.decode(data)).ok()?;
    (bytes.len() <= MAX_TEXT_BYTES)
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_text_with_or_without_padding() {
        assert_eq!(decode("aGk=").as_deref(), Some("hi"));
        assert_eq!(decode("aGk").as_deref(), Some("hi"));
    }

    #[test]
    fn accepts_url_safe_alphabet() {
        assert_eq!(decode("Pz8_").as_deref(), Some("???"));
        assert_eq!(decode("Pz8/").as_deref(), Some("???"));
    }

    #[test]
    fn rejects_garbage_and_binary() {
        assert_eq!(decode("!!!!"), None);
        assert_eq!(decode("/w=="), None, "0xff is not UTF-8");
    }

    #[test]
    fn rejects_oversized_payload_before_decoding() {
        let huge = "A".repeat(MAX_TEXT_BYTES / 3 * 4 + 16);
        assert_eq!(decode(&huge), None);
    }
}
