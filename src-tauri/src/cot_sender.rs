//! Outbound CoT writer.
//!
//! Mirrors the inbound `listeners.rs` shape: small, self-contained, no shared
//! state. The frontend builds the CoT XML (`src/services/chat.js` for the
//! GeoChat case) and hands it down via the `send_cot` Tauri command — this
//! module is just the socket plumbing.
//!
//! Multicast handling: when the destination is a multicast IPv4 address
//! (224.0.0.0/4), we set `multicast_ttl_v4(1)` so the packet stays on the
//! local segment by default, matching TAK's typical LAN posture. TCP / SSL
//! / TAK-Server streaming are out of scope for v1 — the `send_tcp` arm
//! exists so the dispatching command can grow into them without a signature
//! change.

use std::net::Ipv4Addr;

/// Send a single CoT payload to `address:port` over UDP.
///
/// The frontend always composes XML; we transcode it to TAK Protocol
/// v1 binary on the way out so strict WinTAK builds (which silently
/// drop XML inbound on the standard mesh groups) receive us in their
/// expected format. Modern ATAK accepts v1 inbound too — if a peer
/// turns out to be XML-only-tolerant we can revisit, but the default
/// is now "speak the modern wire format."
///
/// Falls back to sending the raw XML if anything goes wrong with the
/// transcode (parse failure, encode failure) so the legacy path
/// stays operational. Logs a single line so the failure is visible
/// in stderr without spamming the channel.
///
/// Binds an ephemeral local socket, sends one datagram, drops the socket.
/// For multicast destinations the socket's TTL is set to 1 (local segment).
pub async fn send_udp(address: &str, port: u16, xml: &str) -> Result<(), String> {
    let payload: Vec<u8> = match crate::tak_v1::encode_xml_to_v1(xml) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[cot] v1 encode failed, falling back to XML: {e}");
            xml.as_bytes().to_vec()
        }
    };

    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind: {e}"))?;

    if let Ok(addr) = address.parse::<Ipv4Addr>() {
        if addr.is_multicast() {
            socket
                .set_multicast_ttl_v4(1)
                .map_err(|e| format!("multicast ttl: {e}"))?;
        }
    }

    let target = format!("{address}:{port}");
    socket
        .send_to(&payload, &target)
        .await
        .map_err(|e| format!("send: {e}"))?;
    Ok(())
}

/// Stub for outbound TCP / streaming. Not implemented in v1.
pub async fn send_tcp(_address: &str, _port: u16, _xml: &str) -> Result<(), String> {
    Err("TCP / streaming destinations are not supported yet — use UDP".into())
}
