//! An image pasted into a Claude Code session. The terminal shows only
//! `[Image #1]`, and Claude Code's copy under the temp folder goes with a
//! reboot, but the transcript keeps the image for as long as the session. The
//! prompt's line holds the numbers in `imagePasteIds` and the images as base64
//! blocks of its content, in the same order.

use serde::Serialize;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Base64 bytes with their media type.
#[derive(Debug, PartialEq, Serialize)]
pub struct PastedImage {
    mime: String,
    data: String,
}

/// Image number `paste` of the session whose transcript this is. `None` when
/// no prompt holds it, as with one still being typed.
pub fn read(transcript: &Path, paste: u64) -> Option<PastedImage> {
    BufReader::new(File::open(transcript).ok()?)
        .lines()
        .map_while(Result::ok)
        .filter(|line| line.contains("\"imagePasteIds\""))
        .find_map(|line| image(&serde_json::from_str(&line).ok()?, paste))
}

fn image(line: &Value, paste: u64) -> Option<PastedImage> {
    let ids = line.get("imagePasteIds")?.as_array()?;
    let place = ids.iter().position(|id| id.as_u64() == Some(paste))?;
    let source = line
        .pointer("/message/content")?
        .as_array()?
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .nth(place)?
        .get("source")?;
    Some(PastedImage {
        mime: source.get("media_type")?.as_str()?.to_owned(),
        data: source.get("data")?.as_str()?.to_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn block(data: &str) -> Value {
        json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}})
    }

    fn transcript(lines: &[Value]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        file
    }

    fn found(data: &str) -> Option<PastedImage> {
        Some(PastedImage { mime: "image/png".into(), data: data.into() })
    }

    #[test]
    fn finds_each_image_by_its_number_among_a_prompts_blocks() {
        let file = transcript(&[
            json!({"type": "user", "imagePasteIds": [1], "message": {"content": [{"type": "text", "text": "[Image #1]"}, block("one")]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "seen"}]}}),
            json!({"type": "user", "imagePasteIds": [2, 3], "message": {"content": [block("two"), block("three")]}}),
        ]);
        assert_eq!(read(file.path(), 1), found("one"));
        assert_eq!(read(file.path(), 2), found("two"));
        assert_eq!(read(file.path(), 3), found("three"));
        assert_eq!(read(file.path(), 4), None);
    }

    #[test]
    fn a_line_that_only_quotes_the_field_is_passed_over() {
        let file = transcript(&[
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "\"imagePasteIds\": [1]"}, block("tool")]}}),
            json!({"type": "user", "imagePasteIds": [1], "message": {"content": [block("pasted")]}}),
        ]);
        assert_eq!(read(file.path(), 1), found("pasted"));
    }

    #[test]
    fn a_missing_transcript_has_no_image() {
        assert_eq!(read(Path::new("/nonexistent/session.jsonl"), 1), None);
    }
}
