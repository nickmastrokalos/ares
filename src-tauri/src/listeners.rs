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
    pub fn start_udp(&mut self, address: String, port: u16, app: AppHandle) {
        let key = format!("{address}:{port}");
        self.stop(&key);

        let bind_addr = format!("{address}:{port}");
        let handle = tauri::async_runtime::spawn(async move {
            let socket = match tokio::net::UdpSocket::bind(&bind_addr).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[cot] UDP bind {bind_addr} failed: {e}");
                    return;
                }
            };
            eprintln!("[cot] UDP listener started on {bind_addr}");

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
                                eprintln!("[cot] parse error from UDP: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[cot] UDP recv error on {bind_addr}: {e}");
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
