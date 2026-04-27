//! TAK Protocol v1 binary CoT decoder + encoder.
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

use crate::cot::{extract_chat_detail_fragment, parse_cot_xml, CotEvent};
use prost::Message;
use quick_xml::events::Event;
use quick_xml::Reader;

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

/// Transcode an XML CoT document into a TAK Protocol v1 mesh datagram
/// (magic prefix + protobuf-encoded TakMessage). Used by `cot_sender::send_udp`
/// so the frontend can keep composing XML while peers — including
/// strict WinTAK builds — receive the binary format they expect.
///
/// We extract every field WinTAK validates (uid, type, time/start/stale,
/// how, point, contact, takv, __group, status, track) into the
/// structured protobuf fields, AND keep the verbatim inner XML of
/// `<detail>...</detail>` on `Detail.xml_detail` so any extension
/// blocks (`<__chat>`, `<chatgrp>`, `<remarks>`, plugin custom
/// fragments) round-trip through to the peer.
pub fn encode_xml_to_v1(xml: &str) -> Result<Vec<u8>, String> {
    let event = parse_cot_xml(xml.as_bytes())?;
    let extras = extract_xml_extras(xml.as_bytes());
    let xml_detail = extract_detail_inner(xml.as_bytes());

    let send_ms  = iso_to_epoch_ms(&event.time).unwrap_or(0);
    let start_ms = iso_to_epoch_ms(&extras.start).unwrap_or(send_ms);
    let stale_ms = iso_to_epoch_ms(&event.stale).unwrap_or(0);

    let track = if event.speed != 0.0 || event.course != 0.0 {
        Some(proto::Track { speed: event.speed, course: event.course })
    } else {
        None
    };

    let takv = extras.takv.map(|(platform, version, device, os)| proto::Takv {
        device, platform, os, version,
    });
    let group = extras.group.map(|(name, role)| proto::Group { name, role });
    let status = extras.battery.map(|battery| proto::Status { battery });

    let msg = proto::TakMessage {
        tak_control: Some(proto::TakControl {
            min_proto_version: 1,
            max_proto_version: 1,
            contact_uid: event.uid.clone(),
        }),
        cot_event: Some(proto::CotEvent {
            r#type:     event.cot_type,
            access:     extras.access,
            qos:        extras.qos,
            opex:       extras.opex,
            uid:        event.uid,
            send_time:  send_ms,
            start_time: start_ms,
            stale_time: stale_ms,
            // `how` ("m-g", "h-e", etc.) is a required-feeling field
            // for strict TAK clients; default to "m-g" (manual / GPS)
            // when the source XML didn't include one rather than
            // emitting the empty string.
            how:        if extras.how.is_empty() { "m-g".into() } else { extras.how },
            lat:        event.lat,
            lon:        event.lon,
            hae:        event.hae,
            ce:         extras.ce.unwrap_or(9_999_999.0),
            le:         extras.le.unwrap_or(9_999_999.0),
            detail: Some(proto::Detail {
                xml_detail,
                contact: Some(proto::Contact {
                    // Default endpoint mirrors what ATAK / WinTAK use
                    // for "no streaming endpoint, contact via the same
                    // mesh group you saw me on."
                    endpoint: if extras.endpoint.is_empty() {
                        "*:-1:stcp".into()
                    } else {
                        extras.endpoint
                    },
                    callsign: event.callsign,
                }),
                group,
                precision_location: None,
                status,
                takv,
                track,
            }),
        }),
    };

    let mut out = Vec::with_capacity(MAGIC.len() + 128);
    out.extend_from_slice(&MAGIC);
    msg.encode(&mut out).map_err(|e| format!("proto encode: {e}"))?;
    Ok(out)
}

/// Sidecar fields not captured by `parse_cot_xml` — pulled out with
/// a separate XML walk so we can populate the rest of the protobuf
/// `Detail` and `CotEvent` shape WinTAK / strict TAK clients expect.
#[derive(Default)]
struct XmlExtras {
    start:    String,         // ISO start time (often equals time)
    how:      String,
    access:   String,
    qos:      String,
    opex:     String,
    ce:       Option<f64>,
    le:       Option<f64>,
    endpoint: String,
    takv:     Option<(String, String, String, String)>, // platform, version, device, os
    group:    Option<(String, String)>,                  // name, role
    battery:  Option<u32>,
}

fn extract_xml_extras(xml: &[u8]) -> XmlExtras {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut out = XmlExtras::default();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let name = e.name();
                let name = name.as_ref();
                match name {
                    b"event" => {
                        for attr in e.attributes().flatten() {
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match attr.key.as_ref() {
                                b"how"    => out.how    = val,
                                b"start"  => out.start  = val,
                                b"access" => out.access = val,
                                b"qos"    => out.qos    = val,
                                b"opex"   => out.opex   = val,
                                _ => {}
                            }
                        }
                    }
                    b"point" => {
                        for attr in e.attributes().flatten() {
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match attr.key.as_ref() {
                                b"ce" => out.ce = val.parse().ok(),
                                b"le" => out.le = val.parse().ok(),
                                _ => {}
                            }
                        }
                    }
                    b"contact" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"endpoint" {
                                out.endpoint = attr.unescape_value().unwrap_or_default().into_owned();
                            }
                        }
                    }
                    b"takv" => {
                        let mut platform = String::new();
                        let mut version  = String::new();
                        let mut device   = String::new();
                        let mut os       = String::new();
                        for attr in e.attributes().flatten() {
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match attr.key.as_ref() {
                                b"platform" => platform = val,
                                b"version"  => version  = val,
                                b"device"   => device   = val,
                                b"os"       => os       = val,
                                _ => {}
                            }
                        }
                        out.takv = Some((platform, version, device, os));
                    }
                    b"__group" => {
                        let mut g_name = String::new();
                        let mut g_role = String::new();
                        for attr in e.attributes().flatten() {
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match attr.key.as_ref() {
                                b"name" => g_name = val,
                                b"role" => g_role = val,
                                _ => {}
                            }
                        }
                        out.group = Some((g_name, g_role));
                    }
                    b"status" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"battery" {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                if let Ok(n) = val.parse::<u32>() {
                                    out.battery = Some(n);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Pull the inner content of the first `<detail>...</detail>` element
/// out of a CoT XML document, verbatim. Simple substring search —
/// our composers always emit the unattributed `<detail>...</detail>`
/// form, never `<detail attr=...>` or `<detail/>`. Returns an empty
/// string if neither marker is found, which the caller treats as
/// "no detail."
fn extract_detail_inner(xml: &[u8]) -> String {
    let open  = b"<detail>";
    let close = b"</detail>";
    let Some(open_pos)  = xml.windows(open.len()).position(|w| w == open)  else { return String::new(); };
    let body_start = open_pos + open.len();
    let Some(close_off) = xml[body_start..].windows(close.len()).position(|w| w == close) else { return String::new(); };
    String::from_utf8_lossy(&xml[body_start..body_start + close_off]).into_owned()
}

/// Parse `YYYY-MM-DDTHH:MM:SS.mmmZ` (with millisecond precision optional)
/// to epoch milliseconds. Returns `None` for unparseable / empty
/// input — caller substitutes 0 for "no timestamp".
fn iso_to_epoch_ms(iso: &str) -> Option<u64> {
    if iso.is_empty() { return None; }
    // Expected shape: 1234-56-78T12:34:56[.789]Z   (Z optional but
    // recommended). Anything else → None.
    let bytes = iso.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T'
       || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year:  i64 = std::str::from_utf8(&bytes[0..4]).ok()?.parse().ok()?;
    let month: u64 = std::str::from_utf8(&bytes[5..7]).ok()?.parse().ok()?;
    let day:   u64 = std::str::from_utf8(&bytes[8..10]).ok()?.parse().ok()?;
    let hour:  u64 = std::str::from_utf8(&bytes[11..13]).ok()?.parse().ok()?;
    let mins:  u64 = std::str::from_utf8(&bytes[14..16]).ok()?.parse().ok()?;
    let secs:  u64 = std::str::from_utf8(&bytes[17..19]).ok()?.parse().ok()?;
    let mut millis: u64 = 0;
    if bytes.len() >= 23 && bytes[19] == b'.' {
        millis = std::str::from_utf8(&bytes[20..23]).ok()?.parse().ok()?;
    }

    // Days since 1970-01-01 via the same algorithm `ms_to_iso` uses
    // in reverse (Howard Hinnant's civil-from / days-from formulae).
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y / 400 } else { (y - 399) / 400 };
    let yoe = (y - era * 400) as u64;
    let m  = month;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe as i64 - 719_468;
    let secs_total = (days as i128) * 86_400 + (hour * 3_600 + mins * 60 + secs) as i128;
    let ms_total   = secs_total * 1_000 + millis as i128;
    if ms_total < 0 { None } else { Some(ms_total as u64) }
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
    fn xml_round_trip_through_v1() {
        // Compose an XML CoT that mirrors what `composeChatXml` /
        // `composeAnnounceXml` produce on the frontend, run it through
        // encode_xml_to_v1, then through try_parse_v1, and confirm the
        // CotEvent we get back matches the inputs.
        let xml = r#"<?xml version="1.0"?>
<event uid="DRAGON-1" type="a-f-G-U-C" time="2026-04-27T12:00:00.000Z" start="2026-04-27T12:00:00.000Z" stale="2026-04-27T12:05:00.000Z">
  <point lat="38.78" lon="-75.10" hae="50.0" ce="9999999" le="9999999"/>
  <detail>
    <contact callsign="Dragon"/>
    <track speed="12.5" course="90.0"/>
    <takv platform="Ares" version="1.x"/>
  </detail>
</event>"#;
        let bytes = encode_xml_to_v1(xml).expect("encode");
        assert_eq!(&bytes[..MAGIC.len()], &MAGIC);

        let event = try_parse_v1(&bytes).unwrap().unwrap();
        assert_eq!(event.uid, "DRAGON-1");
        assert_eq!(event.cot_type, "a-f-G-U-C");
        assert_eq!(event.callsign, "Dragon");
        assert!((event.lat - 38.78).abs() < 1e-9);
        assert!((event.lon - (-75.10)).abs() < 1e-9);
        assert!((event.hae - 50.0).abs() < 1e-9);
        assert!((event.speed - 12.5).abs() < 1e-9);
        assert!((event.course - 90.0).abs() < 1e-9);
        // Round-tripped time should match (ms precision preserved).
        assert!(event.time.starts_with("2026-04-27T12:00:00.000"));
    }

    #[test]
    fn announce_xml_populates_structured_fields() {
        // Same shape composeAnnounceXml emits — verify the encoder
        // translates `how`, `<contact endpoint>`, `<takv>`, `<__group>`
        // into structured protobuf fields rather than dropping them.
        let xml = r#"<?xml version="1.0"?>
<event version="2.0" uid="DRAGON-1" type="a-f-G-U-C" how="m-g" time="2026-04-27T12:00:00.000Z" start="2026-04-27T12:00:00.000Z" stale="2026-04-27T12:05:00.000Z">
  <point lat="38.78" lon="-75.10" hae="50.0" ce="9999999" le="9999999"/>
  <detail>
    <contact callsign="Dragon" endpoint="*:-1:stcp"/>
    <takv platform="Ares" version="1.1.4" device="Ares" os="Tauri"/>
    <__group name="Cyan" role="Team Member"/>
    <status battery="87"/>
  </detail>
</event>"#;
        let bytes = encode_xml_to_v1(xml).expect("encode");
        // Decode the body (skip magic) and inspect the protobuf shape.
        let msg = proto::TakMessage::decode(&bytes[MAGIC.len()..]).expect("decode");
        let evt = msg.cot_event.expect("cot_event");
        assert_eq!(evt.how, "m-g");
        let det = evt.detail.expect("detail");
        let contact = det.contact.expect("contact");
        assert_eq!(contact.callsign, "Dragon");
        assert_eq!(contact.endpoint, "*:-1:stcp");
        let takv = det.takv.expect("takv");
        assert_eq!(takv.platform, "Ares");
        assert_eq!(takv.version,  "1.1.4");
        assert_eq!(takv.device,   "Ares");
        assert_eq!(takv.os,       "Tauri");
        let group = det.group.expect("group");
        assert_eq!(group.name, "Cyan");
        assert_eq!(group.role, "Team Member");
        let status = det.status.expect("status");
        assert_eq!(status.battery, 87);
    }

    #[test]
    fn xml_chat_round_trip_preserves_detail_fragment() {
        let xml = r#"<event uid="MSG-7" type="b-t-f" time="2026-04-27T12:00:00.000Z" start="2026-04-27T12:00:00.000Z" stale="2026-04-27T12:05:00.000Z">
  <point lat="0" lon="0" hae="0" ce="9999999" le="9999999"/>
  <detail>
    <__chat chatroom="All Chat Rooms" id="all" senderCallsign="Dragon"/>
    <link uid="DRAGON-1" relation="p-p"/>
    <chatgrp uid0="All Chat Rooms"/>
    <remarks>hello world</remarks>
  </detail>
</event>"#;
        let bytes = encode_xml_to_v1(xml).expect("encode");
        let event = try_parse_v1(&bytes).unwrap().unwrap();
        assert_eq!(event.cot_type, "b-t-f");
        assert_eq!(event.chat_room.as_deref(),         Some("All Chat Rooms"));
        assert_eq!(event.chat_sender_callsign.as_deref(), Some("Dragon"));
        assert_eq!(event.chat_sender_uid.as_deref(),   Some("DRAGON-1"));
        assert_eq!(event.chat_text.as_deref(),         Some("hello world"));
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
