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

/// Send a single CoT XML payload to `address:port` over UDP.
///
/// Binds an ephemeral local socket, sends one datagram, drops the socket.
/// For multicast destinations the socket's TTL is set to 1 (local segment).
pub async fn send_udp(address: &str, port: u16, xml: &str) -> Result<(), String> {
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
        .send_to(xml.as_bytes(), &target)
        .await
        .map_err(|e| format!("send: {e}"))?;
    Ok(())
}

/// Stub for outbound TCP / streaming. Not implemented in v1.
pub async fn send_tcp(_address: &str, _port: u16, _xml: &str) -> Result<(), String> {
    Err("TCP / streaming destinations are not supported yet — use UDP".into())
}
