use super::*;
use crate::herdr::wire::ServerMessage;

fn framed(payload: &[u8]) -> Vec<u8> {
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(payload);
    frame
}

#[test]
fn a_message_survives_a_round_trip() {
    let message = ServerMessage::EndpointControl {
        kind: "k".into(),
        data: "d".into(),
    };
    let frame = encode(&message).unwrap();
    assert_eq!(
        u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize,
        frame.len() - 4
    );
    let back: ServerMessage = read(&mut frame.as_slice()).unwrap();
    assert_eq!(back, message);
}

#[test]
fn end_of_stream_before_a_frame_is_a_close() {
    let error = read::<ServerMessage>(&mut [].as_slice()).unwrap_err();
    assert!(matches!(error, Error::Closed), "{error:?}");
}

#[test]
fn a_truncated_payload_is_an_error_not_a_close() {
    let mut frame = framed(&[1, 2, 3]);
    frame.truncate(5);
    let error = read::<ServerMessage>(&mut frame.as_slice()).unwrap_err();
    assert!(matches!(error, Error::Io(_)), "{error:?}");
}

#[test]
fn oversized_and_empty_frames_are_refused_before_reading_them() {
    let huge = ((MAX_GRAPHICS_FRAME_SIZE + 1) as u32).to_le_bytes();
    assert!(matches!(
        read::<ServerMessage>(&mut huge.as_slice()),
        Err(Error::TooLarge(_))
    ));
    let empty = 0u32.to_le_bytes();
    assert!(matches!(
        read::<ServerMessage>(&mut empty.as_slice()),
        Err(Error::Empty)
    ));
}

#[test]
fn trailing_bytes_are_refused() {
    let mut payload = encode(&ServerMessage::EndpointControl {
        kind: "k".into(),
        data: String::new(),
    })
    .unwrap()[4..]
        .to_vec();
    payload.push(0);
    assert!(matches!(
        decode::<ServerMessage>(&payload),
        Err(Error::TrailingBytes(1))
    ));
}

#[test]
fn garbage_is_a_decode_error() {
    let frame = framed(&[0xff; 16]);
    assert!(matches!(
        read::<ServerMessage>(&mut frame.as_slice()),
        Err(Error::Decode(_))
    ));
}
