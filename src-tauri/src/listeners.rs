use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle;

use crate::cot::parse_cot;

/// Manages active UDP/TCP CoT listener tasks.
///
/// Each listener is keyed by `"{address}:{port}"`. Stopping a listener
/// aborts the underlying Tokio task; resources are cleaned up automatically.
pub struct ListenerManager {
    listeners: HashMap<String, JoinHandle<()>>,
}

impl ListenerManager {
    pub fn new() -> Self {
        Self {
            listeners: HashMap::new(),
        }
    }

    /// Start a UDP listener bound to `address:port`. Emits `cot-event` for
    /// every successfully parsed CoT message. If a listener already exists
    /// for this address:port it is stopped and replaced.
    ///
    /// When `address` is an IPv4 multicast address (`224.0.0.0/4`) the socket
    /// is bound to `0.0.0.0:port` and the OS is told to join the multicast
    /// group via `IP_ADD_MEMBERSHIP` / `join_multicast_v4`. Without this the
    /// kernel silently drops all inbound multicast packets.
    pub fn start_udp(&mut self, address: String, port: u16, app: AppHandle) {
        let key = format!("{address}:{port}");
        self.stop(&key);

        let handle = tauri::async_runtime::spawn(async move {
            // Detect IPv4 multicast (224.0.0.0/4) and handle separately.
            let socket = match address.parse::<std::net::Ipv4Addr>() {
                Ok(group) if group.is_multicast() => {
                    // Build socket via socket2 so we can set SO_REUSEADDR
                    // *before* bind — required on macOS for multicast, harmless
                    // elsewhere.
                    let sock2 = match socket2::Socket::new(
                        socket2::Domain::IPV4,
                        socket2::Type::DGRAM,
                        Some(socket2::Protocol::UDP),
                    ) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[cot] UDP socket create failed: {e}");
                            return;
                        }
                    };
                    if let Err(e) = sock2.set_reuse_address(true) {
                        eprintln!("[cot] UDP set_reuse_address failed: {e}");
                        return;
                    }
                    // macOS also needs SO_REUSEPORT for multicast.
                    #[cfg(not(windows))]
                    if let Err(e) = sock2.set_reuse_port(true) {
                        eprintln!("[cot] UDP set_reuse_port failed (non-fatal): {e}");
                    }
                    let bind_addr: socket2::SockAddr =
                        std::net::SocketAddrV4::new(std::net::Ipv4Addr::UNSPECIFIED, port).into();
                    if let Err(e) = sock2.bind(&bind_addr) {
                        eprintln!("[cot] UDP bind 0.0.0.0:{port} failed: {e}");
                        return;
                    }
                    sock2.set_nonblocking(true).ok();

                    // Join the multicast group on every local IPv4 interface so
                    // traffic arriving on any NIC is received. Fall back to
                    // UNSPECIFIED (OS default) if enumeration fails.
                    let local_v4: Vec<std::net::Ipv4Addr> = if_addrs::get_if_addrs()
                        .map(|ifaces| {
                            ifaces
                                .into_iter()
                                .filter_map(|iface| match iface.addr.ip() {
                                    std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
                                    _ => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default();

                    if local_v4.is_empty() {
                        // Fallback: let the OS pick the default interface.
                        if let Err(e) = sock2.join_multicast_v4(
                            &group,
                            &std::net::Ipv4Addr::UNSPECIFIED,
                        ) {
                            eprintln!("[cot] UDP join_multicast_v4 {group} on default failed: {e}");
                            return;
                        }
                        eprintln!("[cot] joined multicast {group} on default interface");
                    } else {
                        for iface in &local_v4 {
                            match sock2.join_multicast_v4(&group, iface) {
                                Ok(()) => eprintln!("[cot] joined multicast {group} on {iface}"),
                                Err(e) => eprintln!("[cot] join_multicast_v4 {group} on {iface} failed (non-fatal): {e}"),
                            }
                        }
                    }

                    let std_sock: std::net::UdpSocket = sock2.into();
                    match tokio::net::UdpSocket::from_std(std_sock) {
                        Ok(s) => {
                            eprintln!(
                                "[cot] UDP listener started on 0.0.0.0:{port} (multicast {group})"
                            );
                            s
                        }
                        Err(e) => {
                            eprintln!("[cot] UDP from_std failed: {e}");
                            return;
                        }
                    }
                }
                _ => {
                    // Unicast (or non-IPv4): bind directly as before.
                    let bind_addr = format!("{address}:{port}");
                    match tokio::net::UdpSocket::bind(&bind_addr).await {
                        Ok(s) => {
                            eprintln!("[cot] UDP listener started on {bind_addr}");
                            s
                        }
                        Err(e) => {
                            eprintln!("[cot] UDP bind {bind_addr} failed: {e}");
                            return;
                        }
                    }
                }
            };

            let mut buf = vec![0u8; 65536];
            loop {
                match socket.recv_from(&mut buf).await {
                    Ok((len, _peer)) => {
                        let data = &buf[..len];
                        match parse_cot(data) {
                            Ok(event) => {
                                if let Err(e) = app.emit("cot-event", &event) {
                                    eprintln!("[cot] emit error: {e}");
                                }
                            }
                            Err(e) => {
                                // Diagnostic: dump the first 96 bytes so we
                                // can tell XML / TAK-protocol-v1 / garbage
                                // apart. Strip after the issue is resolved.
                                let n = data.len().min(96);
                                let head = &data[..n];
                                let hex = head
                                    .iter()
                                    .map(|b| format!("{:02x}", b))
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                let ascii: String = head
                                    .iter()
                                    .map(|&b| if (32..127).contains(&b) { b as char } else { '.' })
                                    .collect();
                                eprintln!(
                                    "[cot] parse error from UDP ({address}:{port}, {len}B): {e}\n  hex:   {hex}\n  ascii: {ascii}"
                                );
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[cot] UDP recv error ({address}:{port}): {e}");
                        break;
                    }
                }
            }
        });

        self.listeners.insert(key, handle);
    }

    /// Start a TCP listener bound to `address:port`. Each accepted connection
    /// is handled in its own task; messages are framed by `</event>`.
    pub fn start_tcp(&mut self, address: String, port: u16, app: AppHandle) {
        let key = format!("{address}:{port}");
        self.stop(&key);

        let bind_addr = format!("{address}:{port}");
        let handle = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[cot] TCP bind {bind_addr} failed: {e}");
                    return;
                }
            };
            eprintln!("[cot] TCP listener started on {bind_addr}");

            loop {
                match listener.accept().await {
                    Ok((stream, peer)) => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_tcp_connection(stream, peer.to_string(), app_clone).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("[cot] TCP accept error on {bind_addr}: {e}");
                        break;
                    }
                }
            }
        });

        self.listeners.insert(key, handle);
    }

    /// Stop and remove the listener at `key` (format: `"{address}:{port}"`).
    pub fn stop(&mut self, key: &str) {
        if let Some(handle) = self.listeners.remove(key) {
            handle.abort();
        }
    }

    /// Stop all listeners and clear the map.
    pub fn stop_all(&mut self) {
        for (_, handle) in self.listeners.drain() {
            handle.abort();
        }
    }
}

/// Maximum bytes buffered per TCP connection before the connection is dropped.
/// A legitimate CoT message is a few KB at most; 1 MB is a generous ceiling
/// that prevents a misbehaving or malicious peer from exhausting memory.
const MAX_TCP_BUF: usize = 1_048_576;

/// Read from a TCP connection, accumulate bytes, split on `</event>`,
/// parse each complete message and emit to the frontend.
async fn handle_tcp_connection(
    stream: tokio::net::TcpStream,
    peer: String,
    app: AppHandle,
) {
    use tokio::io::AsyncReadExt;

    let mut stream = stream;
    let mut buf = Vec::new();
    let mut tmp = vec![0u8; 4096];

    loop {
        match stream.read(&mut tmp).await {
            Ok(0) => break, // connection closed
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > MAX_TCP_BUF {
                    eprintln!(
                        "[cot] TCP buffer exceeded {} bytes from {peer}, dropping connection",
                        MAX_TCP_BUF
                    );
                    break;
                }
                // Split on </event> — each complete tag is one CoT message.
                while let Some(end) = find_end_tag(&buf) {
                    let message = buf[..end].to_vec();
                    buf.drain(..end);
                    match parse_cot(&message) {
                        Ok(event) => {
                            if let Err(e) = app.emit("cot-event", &event) {
                                eprintln!("[cot] emit error: {e}");
                            }
                        }
                        Err(e) => {
                            eprintln!("[cot] parse error from TCP {peer}: {e}");
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!("[cot] TCP read error from {peer}: {e}");
                break;
            }
        }
    }
}

/// Find the byte offset immediately *after* the first `</event>` in `buf`.
/// Returns `None` if the closing tag has not arrived yet.
fn find_end_tag(buf: &[u8]) -> Option<usize> {
    const TAG: &[u8] = b"</event>";
    buf.windows(TAG.len())
        .position(|w| w == TAG)
        .map(|pos| pos + TAG.len())
}
