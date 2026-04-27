//! TAK Protocol v1 binary CoT decoder.
//!
//! Wire format (UDP mesh):
//!
//! ```text
//! 0xbf 0x01 0xbf <protobuf-encoded TakMessage>
//! ```
//!
//! End of the datagram = end of the message. No varint length, no
//! framing escapes — that's what TAK Server's TCP-streaming variant
//! adds, and we don't handle that here (mesh-only first cut). The
//! schema is vendored in `proto/takmessage.proto` and compiled to
//! Rust at build time via prost (using the pure-Rust protox compiler
//! so we don't need a system protoc install).
//!
//! Decoded events are mapped onto the existing `CotEvent` shape so
//! downstream code (listeners, frontend chat / track stores) doesn't
//! care which format the peer used.

use crate::cot::{extract_chat_detail_fragment, CotEvent};

/// Generated prost types from `proto/takmessage.proto`. The package
/// path comes from the proto's `package atakmap.commoncommo.protobuf.v1`
/// declaration.
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/atakmap.commoncommo.protobuf.v1.rs"));
}

/// Magic preamble identifying a TAK Protocol v1 mesh datagram.
const MAGIC: [u8; 3] = [0xbf, 0x01, 0xbf];

/// Try to parse `data` as a TAK Protocol v1 mesh packet. Returns:
///   - `None` if `data` doesn't start with the magic prefix (caller
///     should fall back to the XML parser).
///   - `Some(Ok(event))` on a successful decode.
///   - `Some(Err(msg))` if the magic was present but the protobuf
///     was malformed or required fields were missing.
pub fn try_parse_v1(data: &[u8]) -> Option<Result<CotEvent, String>> {
    if data.len() < MAGIC.len() || data[..MAGIC.len()] != MAGIC {
        return None;
    }
    Some(decode_takmessage(&data[MAGIC.len()..]))
}

fn decode_takmessage(body: &[u8]) -> Result<CotEvent, String> {
    use prost::Message;
    let msg = proto::TakMessage::decode(body)
        .map_err(|e| format!("proto decode: {e}"))?;
    let evt = msg
        .cot_event
        .ok_or_else(|| "TakMessage missing cot_event".to_string())?;

    if evt.uid.is_empty() {
        return Err("CotEvent missing uid".to_string());
    }
    // Lat/lon of 0/0 isn't strictly invalid (Null Island is a valid
    // coordinate) but a protobuf default is far more likely than a
    // peer actually broadcasting from the equator+prime-meridian; we
    // still accept it rather than rejecting, matching the XML path's
    // behavior of returning the value as-is.

    let detail = evt.detail.as_ref();

    let callsign_from_contact = detail
        .and_then(|d| d.contact.as_ref())
        .map(|c| c.callsign.clone())
        .filter(|s| !s.is_empty());
    let callsign = callsign_from_contact.unwrap_or_else(|| evt.uid.clone());

    let speed = detail
        .and_then(|d| d.track.as_ref())
        .map(|t| t.speed)
        .unwrap_or(0.0);
    let course = detail
        .and_then(|d| d.track.as_ref())
        .map(|t| t.course)
        .unwrap_or(0.0);

    // Chat-detail blocks (used for GeoChat `b-t-f` events) are placed
    // inside `Detail.xml_detail` by WinTAK rather than carried as
    // structured fields. Re-parse the fragment with the same rules
    // the XML path uses so the resulting CotEvent looks identical
    // regardless of which transport format the peer used.
    let chat = detail
        .map(|d| extract_chat_detail_fragment(&d.xml_detail))
        .unwrap_or_default();

    Ok(CotEvent {
        uid:                  evt.uid.clone(),
        cot_type:             evt.r#type.clone(),
        lat:                  evt.lat,
        lon:                  evt.lon,
        hae:                  evt.hae,
        speed,
        course,
        callsign,
        // Times are epoch-millisecond u64s; convert to ISO-8601 to
        // match the XML path's `time` / `stale` representation.
        time:                 ms_to_iso(evt.send_time),
        stale:                ms_to_iso(evt.stale_time),
        chat_room:            chat.chat_room,
        chat_room_id:         chat.chat_room_id,
        chat_sender_uid:      chat.chat_sender_uid,
        chat_sender_callsign: chat.chat_sender_callsign,
        chat_recipient_uid:   chat.chat_recipient_uid,
        chat_text:            chat.chat_text,
    })
}

/// Format epoch-milliseconds as the ISO-8601 string the XML path emits
/// (`YYYY-MM-DDTHH:MM:SS.mmmZ`). 0 → empty string so downstream code
/// that already treats empty as "no timestamp" stays correct.
fn ms_to_iso(ms: u64) -> String {
    if ms == 0 {
        return String::new();
    }
    // UTC breakdown without pulling in chrono / time. We compute days
    // since 1970-01-01 then walk year/month/day with the canonical
    // 400-year-cycle algorithm.
    let secs   = ms / 1_000;
    let millis = ms % 1_000;
    let mut days = (secs / 86_400) as i64;
    let tod  = (secs % 86_400) as u32;
    let hour = tod / 3_600;
    let mins = (tod % 3_600) / 60;
    let secs = tod % 60;

    // Civil-from-days (Howard Hinnant), well-trodden algorithm.
    days += 719_468;
    let era = if days >= 0 { days / 146_097 } else { (days - 146_096) / 146_097 };
    let doe = (days - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y   = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp  = (5 * doy + 2) / 153;
    let d   = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m   = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y   = (y + (if m <= 2 { 1 } else { 0 })) as i32;

    format!(
        "{y:04}-{m:02}-{d:02}T{hour:02}:{mins:02}:{secs:02}.{millis:03}Z"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    fn build_sample_takmessage(uid: &str, callsign: &str, lat: f64, lon: f64) -> Vec<u8> {
        let msg = proto::TakMessage {
            tak_control: Some(proto::TakControl {
                min_proto_version: 1,
                max_proto_version: 1,
                contact_uid: uid.to_string(),
            }),
            cot_event: Some(proto::CotEvent {
                r#type:     "a-f-G-U-C".into(),
                access:     String::new(),
                qos:        String::new(),
                opex:       String::new(),
                uid:        uid.into(),
                send_time:  1_700_000_000_000,
                start_time: 1_700_000_000_000,
                stale_time: 1_700_000_300_000,
                how:        "h-g-i-g-o".into(),
                lat,
                lon,
                hae:        50.0,
                ce:         9999999.0,
                le:         9999999.0,
                detail:     Some(proto::Detail {
                    xml_detail: String::new(),
                    contact:    Some(proto::Contact {
                        endpoint: "*:-1:stcp".into(),
                        callsign: callsign.into(),
                    }),
                    group:      None,
                    precision_location: None,
                    status:     None,
                    takv:       None,
                    track:      Some(proto::Track {
                        speed:  12.5,
                        course: 90.0,
                    }),
                }),
            }),
        };
        let mut body = Vec::new();
        msg.encode(&mut body).expect("encode");
        let mut packet = Vec::with_capacity(MAGIC.len() + body.len());
        packet.extend_from_slice(&MAGIC);
        packet.extend_from_slice(&body);
        packet
    }

    #[test]
    fn decodes_round_tripped_takmessage() {
        let packet = build_sample_takmessage("PEER-1", "Dragon", 38.78, -75.10);
        let result = try_parse_v1(&packet).expect("magic detected");
        let event = result.expect("decoded");
        assert_eq!(event.uid, "PEER-1");
        assert_eq!(event.cot_type, "a-f-G-U-C");
        assert_eq!(event.callsign, "Dragon");
        assert!((event.lat - 38.78).abs() < 1e-9);
        assert!((event.lon - (-75.10)).abs() < 1e-9);
        assert!((event.speed - 12.5).abs() < 1e-9);
        assert!(event.time.starts_with("2023-"));
        assert!(event.time.ends_with("Z"));
    }

    #[test]
    fn rejects_packet_without_magic() {
        let packet = b"<event uid=\"X\"></event>";
        assert!(try_parse_v1(packet).is_none());
    }

    #[test]
    fn surfaces_decode_error_on_bad_body() {
        let mut packet = MAGIC.to_vec();
        packet.extend_from_slice(b"not protobuf bytes");
        let result = try_parse_v1(&packet).expect("magic detected");
        assert!(result.is_err());
    }

    #[test]
    fn extracts_chat_detail_from_xml_detail_blob() {
        let chat_xml = "<__chat chatroom=\"All Chat Rooms\" id=\"all\" senderCallsign=\"Dragon\"/>\
                        <link uid=\"PEER-1\" relation=\"p-p\"/>\
                        <chatgrp uid0=\"All Chat Rooms\"/>\
                        <remarks>hello world</remarks>";
        let msg = proto::TakMessage {
            tak_control: None,
            cot_event: Some(proto::CotEvent {
                r#type: "b-t-f".into(),
                uid:    "MSG-42".into(),
                send_time:  1_700_000_000_000,
                stale_time: 1_700_000_300_000,
                lat: 0.0, lon: 0.0, hae: 0.0,
                detail: Some(proto::Detail {
                    xml_detail: chat_xml.into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        };
        let mut body = Vec::new();
        msg.encode(&mut body).unwrap();
        let mut packet = MAGIC.to_vec();
        packet.extend_from_slice(&body);
        let event = try_parse_v1(&packet).unwrap().unwrap();
        assert_eq!(event.cot_type, "b-t-f");
        assert_eq!(event.chat_room.as_deref(),         Some("All Chat Rooms"));
        assert_eq!(event.chat_sender_callsign.as_deref(), Some("Dragon"));
        assert_eq!(event.chat_sender_uid.as_deref(),   Some("PEER-1"));
        assert_eq!(event.chat_text.as_deref(),         Some("hello world"));
    }
}
