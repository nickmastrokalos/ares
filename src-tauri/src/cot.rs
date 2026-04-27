use quick_xml::Reader;
use quick_xml::events::Event;
use serde::{Deserialize, Serialize};

/// A parsed CoT (Cursor on Target) event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CotEvent {
    pub uid: String,
    pub cot_type: String,
    pub lat: f64,
    pub lon: f64,
    pub hae: f64,
    pub speed: f64,
    pub course: f64,
    pub callsign: String,
    pub time: String,
    pub stale: String,

    // ---- GeoChat (optional) ----
    // Populated when the event is a `b-t-f` chat message carrying a
    // `<__chat>` detail block. All fields are optional so non-chat events
    // serialize cleanly with `Option::None` collapsing to `null` on the
    // JS side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_room_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_sender_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_sender_callsign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_recipient_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_text: Option<String>,
}

/// Parse a raw CoT message into a `CotEvent`. Auto-detects the wire
/// format by looking at the first few bytes:
///
///   - `0xbf 0x01 0xbf` → TAK Protocol v1 (binary protobuf, used by
///     WinTAK and current ATAK builds). Decoded via `crate::tak_v1`.
///   - anything else → legacy XML (`<event>...</event>`) decoded by
///     `parse_cot_xml`.
///
/// Both paths return the same `CotEvent` shape so listeners and the
/// `cot-event` channel are agnostic to which format the peer used.
pub fn parse_cot(data: &[u8]) -> Result<CotEvent, String> {
    if let Some(result) = crate::tak_v1::try_parse_v1(data) {
        return result;
    }
    parse_cot_xml(data)
}

/// Parse a raw CoT XML message into a `CotEvent`.
///
/// Returns `Err` with a human-readable string if the XML is malformed or any
/// required field is missing. Non-fatal missing optional fields (hae, speed,
/// course, callsign) fall back to defaults rather than returning an error.
///
/// GeoChat detail blocks (`<__chat>`, `<chatgrp>`, `<remarks>`) are extracted
/// when present so the frontend can route chat events to the chat store
/// without re-parsing the XML.
pub fn parse_cot_xml(data: &[u8]) -> Result<CotEvent, String> {
    let mut reader = Reader::from_reader(data);
    reader.config_mut().trim_text(true);

    let mut uid = String::new();
    let mut cot_type = String::new();
    let mut time = String::new();
    let mut stale = String::new();
    let mut lat = f64::NAN;
    let mut lon = f64::NAN;
    let mut hae = 0.0f64;
    let mut speed = 0.0f64;
    let mut course = 0.0f64;
    let mut callsign = String::new();

    let mut chat_room: Option<String> = None;
    let mut chat_room_id: Option<String> = None;
    let mut chat_sender_uid: Option<String> = None;
    let mut chat_sender_callsign: Option<String> = None;
    let mut chat_recipient_uid: Option<String> = None;
    let mut chat_text: Option<String> = None;

    // True while the parser is inside a `<remarks>...remarks body...</remarks>`
    // pair. The next Text event captured during this window is the chat
    // message body.
    let mut in_remarks = false;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.name().as_ref() {
                    b"event" => {
                        for attr in e.attributes().flatten() {
                            let key = attr.key.as_ref();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key {
                                b"uid" => uid = val,
                                b"type" => cot_type = val,
                                b"time" => time = val,
                                b"stale" => stale = val,
                                _ => {}
                            }
                        }
                    }
                    b"point" => {
                        for attr in e.attributes().flatten() {
                            let key = attr.key.as_ref();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key {
                                b"lat" => lat = val.parse().unwrap_or(f64::NAN),
                                b"lon" => lon = val.parse().unwrap_or(f64::NAN),
                                b"hae" => hae = val.parse().unwrap_or(0.0),
                                _ => {}
                            }
                        }
                    }
                    b"contact" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"callsign" {
                                callsign = attr.unescape_value().unwrap_or_default().into_owned();
                            }
                        }
                    }
                    b"track" => {
                        for attr in e.attributes().flatten() {
                            let key = attr.key.as_ref();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key {
                                b"speed" => speed = val.parse().unwrap_or(0.0),
                                b"course" => course = val.parse().unwrap_or(0.0),
                                _ => {}
                            }
                        }
                    }
                    b"__chat" => {
                        for attr in e.attributes().flatten() {
                            let key = attr.key.as_ref();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key {
                                b"chatroom"       => chat_room = Some(val),
                                b"id"             => chat_room_id = Some(val),
                                b"senderCallsign" => chat_sender_callsign = Some(val),
                                _ => {}
                            }
                        }
                    }
                    b"chatgrp" => {
                        // chatgrp uid0 is the recipient (or "All Chat Rooms")
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"uid0" {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                chat_recipient_uid = Some(val);
                            }
                        }
                    }
                    b"link" => {
                        // The chat sender's UID is carried on the `<link>`
                        // element with relation="p-p". We accept any link
                        // with a uid attribute as the sender; the surrounding
                        // event uid encodes routing, not sender identity.
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"uid" && chat_sender_uid.is_none() {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                chat_sender_uid = Some(val);
                            }
                        }
                    }
                    b"remarks" => {
                        in_remarks = true;
                        // remarks `to` attribute is the recipient too — keep
                        // the chatgrp value if already set, otherwise fall
                        // back to this.
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"to" && chat_recipient_uid.is_none() {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                chat_recipient_uid = Some(val);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if in_remarks {
                    let text = t.unescape().unwrap_or_default().into_owned();
                    if !text.trim().is_empty() {
                        chat_text = Some(text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"remarks" {
                    in_remarks = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    if uid.is_empty() {
        return Err("missing uid".to_string());
    }
    if lat.is_nan() || lon.is_nan() {
        return Err("missing lat/lon".to_string());
    }
    if callsign.is_empty() {
        callsign = uid.clone();
    }

    Ok(CotEvent {
        uid,
        cot_type,
        lat,
        lon,
        hae,
        speed,
        course,
        callsign,
        time,
        stale,
        chat_room,
        chat_room_id,
        chat_sender_uid,
        chat_sender_callsign,
        chat_recipient_uid,
        chat_text,
    })
}

/// Holder for the optional chat-detail fields. Used by the v1 path to
/// merge XML-fragment chat metadata into a CotEvent built from
/// protobuf — WinTAK puts the GeoChat `<__chat>` / `<chatgrp>` /
/// `<remarks>` blocks inside `Detail.xml_detail` rather than the
/// structured fields, so we re-parse them here with the same rules
/// the full-XML path uses above.
#[derive(Default)]
pub struct ChatDetail {
    pub chat_room:            Option<String>,
    pub chat_room_id:         Option<String>,
    pub chat_sender_uid:      Option<String>,
    pub chat_sender_callsign: Option<String>,
    pub chat_recipient_uid:   Option<String>,
    pub chat_text:            Option<String>,
}

/// Extract chat-detail fields from a `<detail>...</detail>` XML
/// fragment (without the wrapping `<event>`). Pass the contents of a
/// protobuf `Detail.xml_detail` blob — wraps it in a synthetic
/// `<detail>` so the parser sees a well-formed root, then walks the
/// same element rules as the full-XML path.
pub fn extract_chat_detail_fragment(xml_detail: &str) -> ChatDetail {
    let mut out = ChatDetail::default();
    if xml_detail.trim().is_empty() {
        return out;
    }
    // Wrap so the parser has a single root regardless of how many
    // sibling elements the producer put in the blob.
    let wrapped = format!("<detail>{xml_detail}</detail>");
    let mut reader = Reader::from_reader(wrapped.as_bytes());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_remarks = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                match e.name().as_ref() {
                    b"__chat" => {
                        for attr in e.attributes().flatten() {
                            let key = attr.key.as_ref();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key {
                                b"chatroom"       => out.chat_room = Some(val),
                                b"id"             => out.chat_room_id = Some(val),
                                b"senderCallsign" => out.chat_sender_callsign = Some(val),
                                _ => {}
                            }
                        }
                    }
                    b"chatgrp" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"uid0" {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                out.chat_recipient_uid = Some(val);
                            }
                        }
                    }
                    b"link" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"uid" && out.chat_sender_uid.is_none() {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                out.chat_sender_uid = Some(val);
                            }
                        }
                    }
                    b"remarks" => {
                        in_remarks = true;
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"to" && out.chat_recipient_uid.is_none() {
                                let val = attr.unescape_value().unwrap_or_default().into_owned();
                                out.chat_recipient_uid = Some(val);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref t)) => {
                if in_remarks {
                    let text = t.unescape().unwrap_or_default().into_owned();
                    if !text.trim().is_empty() {
                        out.chat_text = Some(text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"remarks" {
                    in_remarks = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // bad fragment — bail with whatever we got
            _ => {}
        }
        buf.clear();
    }
    out
}
