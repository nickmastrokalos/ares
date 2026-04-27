# TAK GeoChat (v1)

Send and receive chat messages with WinTAK / iTAK / ATAK over the standard TAK GeoChat-on-CoT format. v1 is intentionally narrow: outbound UDP (unicast and multicast), inbound via the existing CoT listeners, in-memory thread history, no TAK Server / SSL / attachments.

## Wire format

A chat message is a CoT event of type `b-t-f` carrying these detail blocks:

```xml
<event version="2.0" uid="GeoChat.<senderUid>.<recipientUid>.<nonce>"
       type="b-t-f" how="h-g-i-g-o"
       time="..." start="..." stale="...">
  <point lat="0" lon="0" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <__chat parent="RootContactGroup" groupOwner="false"
            chatroom="<roomDisplayName>" id="<roomId>"
            senderCallsign="<myCallsign>">
      <chatgrp uid0="<recipientUid_or_All>" id="<roomId>"/>
    </__chat>
    <link uid="<myUid>" type="a-f-G" relation="p-p"/>
    <remarks source="Ares.<myUid>" to="<recipientUid_or_All>" time="...">
      <message body>
    </remarks>
    <marti><dest callsign="<recipientCallsign>"/></marti>   <!-- direct only -->
  </detail>
</event>
```

Confirmed against the WinTAK SDK class `WinTak.Net.Chat.CoTChatMessage.ComposeDocument`. Same shape ATAK + iTAK use — fully cross-client.

### Routing semantics

| Mode | `roomId` | `chatgrp.uid0` | `<marti>` |
|------|----------|----------------|-----------|
| All Chat Rooms (group) | `"All Chat Rooms"` | `"All Chat Rooms"` | absent |
| Direct           | recipient peer UID | recipient peer UID | `<dest callsign="…"/>` |

Peers filter direct messages by recipient. The local Chat panel keys direct rooms by **sender** UID on inbound and **recipient** UID on outbound, so the same peer always lands in the same thread.

## Architecture

| Layer | File | Role |
|-------|------|------|
| Rust outbound | `src-tauri/src/cot_sender.rs` | `send_udp` (unicast / multicast, multicast TTL = 1) and a `send_tcp` stub for future TAK Server work. |
| Tauri command | `src-tauri/src/lib.rs::send_cot` | Dispatches `(address, port, protocol, xml)` to the right sender. |
| Rust inbound | `src-tauri/src/cot.rs` | Existing `parse_cot` extended to extract `<__chat>`, `<chatgrp>`, `<link uid>`, `<remarks>` into optional `chat_*` fields on `CotEvent`. |
| Frontend encoder | `src/services/chat.js` | `composeChatXml({ ... })` — builds the XML above. Exposes `ALL_CHAT_ROOM = { id, name }`. |
| Pinia store | `src/stores/chat.js` | Subscribes to `cot-event`, routes `b-t-f` events into per-room threads, manages outbound via `invoke('send_cot')`. Also derives a `knownContacts` list from `tracksStore` so the user can start a direct chat with any track that has a callsign. |
| Settings | `src/stores/settings.js` | `selfCallsign` (default `'ARES'`), `selfUid` (auto-generated UUID, persisted). The chat outbound endpoint is **not** a separate setting — see "Protected listeners" below. |
| Settings UI | `src/components/SettingsDialog.vue` → Network tab | Edit callsign / regenerate UID / configure chat destination. |
| Chat UI | `src/components/ChatPanel.vue` | Floating draggable panel: room list on the left, conversation + composer on the right. `+ Direct` button opens a contacts popover sourced from `tracksStore`. |
| Toolbar | `src/components/MapToolbar.vue` | `mdi-chat-outline` button in the Feeds group (wide layout) and Feeds dropdown (narrow). |

## Self identity

- `selfUid` is generated on first `settingsStore.load()` (`crypto.randomUUID()`) and saved immediately so the value is stable across restarts. Settings → Network → "Regenerate" replaces it; useful if two installs ever share one (after a copy-paste of app data) so peers stop conflating them.
- `selfCallsign` defaults to `null` — the chat panel and the announce broadcaster gate on this. The first time the user opens the chat panel they see a "Pick a callsign" splash; nothing else in the chat surface unlocks until they save one. Clearing the field in Settings → Network re-locks the panel.

## Active / inactive

`settingsStore.takActive` (default `false`) is the master switch for **outbound** TAK traffic. Setting up an identity does not start emitting; the user has to flip Active on. The toggle has two surfaces, both bound to the same setting:

- **Chat panel header** — pill next to the callsign chip. Green dot + "Active" when on, dim dot + "Inactive" when off. Click to toggle.
- **Settings → Network** — `TAK comms active` switch at the top of the tab.

When inactive: the announce timer is stopped and `chatStore.sendMessage` refuses with `TAK comms inactive — flip the Active switch …`. When the user flips active on, the chat store fires an immediate one-shot announce so they appear in peer contact lists within ~1 s, then the regular 60 s timer takes over.

**Inbound is never gated.** Listeners stay enabled regardless so peer broadcasts continue to populate the track list whether or not we're emitting — operators can lurk and see the picture without committing to broadcast.

## Presence announce

A 60 s timer in the chat store broadcasts a contact-info CoT (`a-f-G-U-C`, or whatever `selfCotType` is set to) on the protected `tak-chat-announce` connection (default `udp://224.10.10.1:18740`) so peers populate their chat contacts list with our callsign + UID and (when `selfLocation` is set) put the operator on their map. The announce CoT carries a 5 minute stale window — long enough to absorb a missed broadcast or two.

The announcer auto-starts when `setupReady` (callsign + UID set + chat-store listening) AND `takActive` are both true. It auto-stops if any of those flip false.

## Outbound flow

`chatStore.sendMessage(roomId, text)`:
1. Resolve room (`group` vs `direct`), pull `selfUid` / `selfCallsign` from settings.
2. `composeChatXml(...)` produces the XML and a deterministic event uid.
3. Append a local-echo message to the room's thread immediately so the operator sees their message without round-trip latency.
4. `invoke('send_cot', { address, port, protocol, xml })`. Failure paths set `sendErrors[msgUid]`; the panel renders an outline + inline error string under the message.

## Inbound flow

`chatStore.startListening()` subscribes to the same `cot-event` Tauri stream `tracksStore` already uses. On every event:
- Skip non-chat events (`cot_type !== 'b-t-f'` or no `chat_text`).
- Skip our own echoes (`chat_sender_uid === selfUid`) — important when the chat destination is the same multicast group we listen on.
- Decide group vs direct from `chat_room_id` / `chat_recipient_uid`.
- Upsert the room (group already pinned at boot; direct rooms keyed by sender UID).
- Append message; bump unread count if the room isn't currently active.

## Protected listeners

WinTAK splits its multicast traffic across three groups by default:

| Connection (kind)          | Default            | Direction | Purpose                                  |
|----------------------------|--------------------|-----------|------------------------------------------|
| `tak-chat-messages`        | `udp://224.10.10.1:17012` | in + out  | GeoChat send + receive            |
| `tak-chat-announce`        | `udp://224.10.10.1:18740` | in + out  | Presence broadcast + receive (Ares emits an `a-f-G-U-C` here every 60 s) |
| `tak-sa`                   | `udp://239.2.3.1:6969`    | in        | Situational awareness — positions, shapes (inbound only in v1) |

`settingsStore.load()` seeds these three entries into `cotListeners` on first run, each marked `protected: true`. The `ConnectionsDialog` hides the delete button on protected entries — they can be retargeted (different address / port / protocol) or toggled off, but not removed. A small `mdi-shield-lock-outline` glyph indicates the protection. Bidirectional rows (`tak-chat-messages` and `tak-chat-announce` — both used for outbound traffic in v1) also show `mdi-swap-vertical-variant`. The `tak-sa` row carries no extra marker since we only listen on it.

The chat store derives its outbound destination by looking up the entry with `kind === 'tak-chat-messages'`, so retargeting that listener also retargets outbound chat — there's exactly one place to point at the right group.

## Wire formats: XML and TAK Protocol v1

ATAK (older builds) and Ares speak GeoChat as XML on the wire — a `<event>...</event>` document carrying the `<__chat>` / `<chatgrp>` / `<remarks>` detail blocks described above.

**WinTAK and current ATAK builds** instead emit the binary **TAK Protocol v1** wire format on the same UDP-mesh groups. A v1 datagram is `0xbf 0x01 0xbf` followed by a protobuf-encoded `TakMessage`. The schema is vendored at `src-tauri/proto/takmessage.proto` and compiled at build time via [`prost`](https://docs.rs/prost) + [`protox`](https://docs.rs/protox) (pure-Rust protoc replacement, so dev / CI machines don't need a system `protoc` install).

`cot::parse_cot` auto-detects the format by looking at the first three bytes:

```
bf 01 bf  →  tak_v1::try_parse_v1   (binary protobuf)
otherwise →  cot::parse_cot_xml      (XML)
```

Both paths return the same `CotEvent` shape, so the listener pipeline (UDP + TCP) and the frontend `cot-event` channel are agnostic to the format the peer used. Chat detail blocks are extracted via the shared `extract_chat_detail_fragment` helper — WinTAK puts them inside `Detail.xml_detail` (an XML fragment string) rather than structured protobuf fields, so the same XML rules apply once the wrapping protobuf is decoded.

Outbound is still XML in v1 of the chat subsystem — current ATAK / WinTAK builds accept XML inbound on the standard mesh groups, so XML is sufficient until proven otherwise. A v1 outbound encoder is a clean follow-up if a peer turns out strict.

## Out of scope (v1)

- **TAK Server / SSL streaming** — the Rust `send_tcp` stub returns "not supported yet". Adding this means a persistent connection manager and (eventually) PEM/PKCS12 cert handling. Inbound TAK Protocol v1's TCP streaming framing (varint-length + protobuf) lives here too.
- **Outbound TAK Protocol v1** — we accept v1 inbound but still write XML outbound. Add an encoder in `cot_sender.rs` if a strict peer drops our XML announces.
- **Attachments / file transfer** — TAK uses MissionPackage downloads with a `<hierarchy>` element; not implemented.
- **Read receipts** (`b-t-f-d` / `b-t-f-r`).
- **Persistence** — chat history is in-memory; restart loses threads. Migrating to SQLite is a follow-up.
- **Location-stamped chat** — outbound messages always carry `point lat=0 lon=0`; we don't yet attach the operator's last known position.
