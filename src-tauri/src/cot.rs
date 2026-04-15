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
}

/// Parse a raw CoT XML message into a `CotEvent`.
///
/// Returns `Err` with a human-readable string if the XML is malformed or any
/// required field is missing. Non-fatal missing optional fields (hae, speed,
/// course, callsign) fall back to defaults rather than returning an error.
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
                    _ => {}
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
    })
}
