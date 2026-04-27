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

/// Best-effort guess at the host's LAN IPv4 address — the address
/// to advertise on `<contact endpoint>` so peers know where to
/// unicast direct chat. Returns `None` when the only addresses
/// available are loopback / link-local / virtual.
///
/// Heuristic: pick the first non-loopback, non-link-local, non-CGNAT
/// IPv4 interface. CGNAT (100.64.0.0/10) is excluded because Tailscale
/// and similar overlays land there and aren't typically the right
/// answer for LAN TAK peers. If no interface meets that bar, fall
/// back to the first non-loopback IPv4 we find (better than nothing).
#[tauri::command]
pub fn get_lan_ipv4() -> Option<String> {
    let addrs = if_addrs::get_if_addrs().ok()?;
    let mut candidates: Vec<Ipv4Addr> = addrs.into_iter().filter_map(|i| match i.addr {
        if_addrs::IfAddr::V4(v) => Some(v.ip),
        _ => None,
    }).collect();
    candidates.sort();
    candidates.dedup();

    let is_cgnat = |ip: &Ipv4Addr| {
        let o = ip.octets();
        o[0] == 100 && (o[1] >= 64 && o[1] <= 127)
    };

    for ip in &candidates {
        if !ip.is_loopback() && !ip.is_link_local() && !is_cgnat(ip) {
            return Some(ip.to_string());
        }
    }
    candidates.into_iter().find(|ip| !ip.is_loopback()).map(|ip| ip.to_string())
}

/// Send a single CoT payload to `address:port` over UDP.
///
/// For *multicast* destinations we send the same packet on every
/// non-loopback IPv4 interface the host advertises. Multicast egress
/// is otherwise OS-selected from the routing table — on macOS that's
/// often a VPN / virtual adapter rather than the LAN interface where
/// TAK peers actually live, so a `0.0.0.0:0`-bound send goes
/// somewhere Wireshark and WinTAK both don't see. Sending on every
/// V4 interface is the same robustness trick most TAK clients use.
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
pub async fn send_udp(address: &str, port: u16, xml: &str) -> Result<(), String> {
    let payload: Vec<u8> = match crate::tak_v1::encode_xml_to_v1(xml) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[cot] v1 encode failed, falling back to XML: {e}");
            xml.as_bytes().to_vec()
        }
    };

    let target = format!("{address}:{port}");
    let parsed = address.parse::<Ipv4Addr>().ok();
    let is_multicast = parsed.map(|a| a.is_multicast()).unwrap_or(false);

    if is_multicast {
        // Enumerate every non-loopback IPv4 interface and send on each.
        // OS-default multicast egress on macOS often picks the wrong
        // adapter (default route ≠ TAK LAN). Empty list → fall back to
        // 0.0.0.0:0 which lets the OS pick (better than failing).
        let mut interfaces: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|i| match i.addr {
                if_addrs::IfAddr::V4(v) if !v.ip.is_loopback() && !v.ip.is_link_local()
                    => Some(v.ip),
                _ => None,
            })
            .collect();
        interfaces.sort();
        interfaces.dedup();

        if interfaces.is_empty() {
            return send_via(None, &target, &payload, true).await;
        }

        let mut sent_any = false;
        let mut last_err: Option<String> = None;
        for iface in &interfaces {
            match send_via(Some(*iface), &target, &payload, true).await {
                Ok(()) => sent_any = true,
                Err(e) => {
                    eprintln!("[cot] → {target} via {iface} FAILED: {e}");
                    last_err = Some(e);
                }
            }
        }
        if !sent_any {
            return Err(last_err.unwrap_or_else(|| "no interfaces sent".into()));
        }
        Ok(())
    } else {
        // Unicast: bind to all-interfaces, OS routing picks correctly.
        send_via(None, &target, &payload, false).await
    }
}

/// Bind a UDP socket — to a specific local interface IP if `iface` is
/// `Some`, otherwise to `0.0.0.0:0` and let the OS choose — and send
/// `payload` to `target`. For multicast destinations, sets TTL=1
/// (local segment); the bound source IP also tells the kernel which
/// interface to egress on.
async fn send_via(
    iface: Option<Ipv4Addr>,
    target: &str,
    payload: &[u8],
    is_multicast: bool,
) -> Result<(), String> {
    let bind = match iface {
        Some(ip) => format!("{ip}:0"),
        None     => "0.0.0.0:0".to_string(),
    };
    let socket = tokio::net::UdpSocket::bind(&bind)
        .await
        .map_err(|e| format!("bind {bind}: {e}"))?;
    if is_multicast {
        // TTL=64 matches what ATAK / WinTAK use on the wire (verified
        // from a captured WinTAK announce: IP-header TTL byte = 0x40).
        // TTL=1 (the "stay on local segment" default) silently drops
        // outbound at the first router — fine when every peer is on
        // the same broadcast domain, broken on any deployment that
        // routes multicast between subnets, which is the common TAK
        // setup.
        socket
            .set_multicast_ttl_v4(64)
            .map_err(|e| format!("multicast ttl: {e}"))?;
    }
    let where_ = iface.map(|i| i.to_string()).unwrap_or_else(|| "0.0.0.0".into());
    eprintln!(
        "[cot] → {target} via {where_} ({} B, head: {})",
        payload.len(),
        payload.iter().take(16).map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
    );
    let bytes_sent = socket
        .send_to(payload, target)
        .await
        .map_err(|e| format!("send via {where_}: {e}"))?;
    eprintln!("[cot] → {target} via {where_} sent {bytes_sent} B");
    Ok(())
}

/// Stub for outbound TCP / streaming. Not implemented in v1.
pub async fn send_tcp(_address: &str, _port: u16, _xml: &str) -> Result<(), String> {
    Err("TCP / streaming destinations are not supported yet — use UDP".into())
}
