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

/// Parse a raw CoT XML message into a `CotEvent`.
///
/// Returns `Err` with a human-readable string if the XML is malformed or any
/// required field is missing. Non-fatal missing optional fields (hae, speed,
/// course, callsign) fall back to defaults rather than returning an error.
///
/// GeoChat detail blocks (`<__chat>`, `<chatgrp>`, `<remarks>`) are extracted
/// when present so the frontend can route chat events to the chat store
/// without re-parsing the XML.
pub fn parse_cot(data: &[u8]) -> Result<CotEvent, String> {
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
