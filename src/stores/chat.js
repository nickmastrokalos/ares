import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '@/stores/settings'
import { useTracksStore }   from '@/stores/tracks'
import { composeChatXml, ALL_CHAT_ROOM } from '@/services/chat'
import { composeAnnounceXml } from '@/services/announce'

// Announce every 60 s — frequent enough to keep our entry fresh in
// WinTAK's contacts list (which uses the event's stale time of 5 min)
// but not so often that the multicast group is noisy.
const ANNOUNCE_INTERVAL_MS = 60_000

// Per-room scrollback cap. v1 chat history is purely in-memory; without a
// bound, long sessions on a busy "All Chat Rooms" group would grow the
// per-room array indefinitely. 200 messages is plenty for a working
// session and keeps the panel render tree shallow. Older messages are
// dropped from the front when the cap is exceeded.
const MAX_MESSAGES_PER_ROOM = 200

// Pinia store for TAK GeoChat — sends and receives `b-t-f` chat CoT events
// over the configured chat destination.
//
// Rooms keyed by id:
//   - 'All Chat Rooms' — group broadcast (always present)
//   - <peerUid>        — direct rooms, created when a direct message is
//                        received from a peer or when the user starts a
//                        direct chat with a known track.
//
// Messages live in a per-room array, chronological. v1 stores in memory
// only — no SQLite persistence. Restart of the app loses thread history.

export const useChatStore = defineStore('chat', () => {
  const settingsStore = useSettingsStore()
  const tracksStore   = useTracksStore()

  // ---- Room registry ----
  // Map<roomId, { id, name, kind: 'group' | 'direct', peerUid?, peerCallsign? }>
  const rooms   = ref(new Map())
  // Map<roomId, Array<Message>>
  const messages = ref(new Map())
  // Map<roomId, number> — count of unread messages since the room was last active.
  const unread   = ref(new Map())

  const activeRoomId = ref(ALL_CHAT_ROOM.id)

  // Last error per outbound message so the UI can flag failures inline.
  // Map<messageUid, string>
  const sendErrors = ref(new Map())

  let unlistenFn      = null
  let listening       = false
  let announceTimer   = null

  function ensureRoom(room) {
    if (!rooms.value.has(room.id)) {
      rooms.value.set(room.id, room)
      // trigger reactivity by reassigning the Map ref
      rooms.value = new Map(rooms.value)
    }
    if (!messages.value.has(room.id)) {
      messages.value.set(room.id, [])
      messages.value = new Map(messages.value)
    }
  }

  // Always-on group room.
  ensureRoom({ id: ALL_CHAT_ROOM.id, name: ALL_CHAT_ROOM.name, kind: 'group' })

  function appendMessage(roomId, msg) {
    const list = messages.value.get(roomId) ?? []
    list.push(msg)
    // Bound the per-room history. Drop oldest entries past the cap so
    // memory + render cost stay flat even on a chatty group.
    if (list.length > MAX_MESSAGES_PER_ROOM) {
      list.splice(0, list.length - MAX_MESSAGES_PER_ROOM)
    }
    messages.value.set(roomId, list)
    messages.value = new Map(messages.value)
    if (roomId !== activeRoomId.value) {
      const n = (unread.value.get(roomId) ?? 0) + 1
      unread.value.set(roomId, n)
      unread.value = new Map(unread.value)
    }
  }

  // ---- Inbound ----

  // True when the operator has done the one-time setup (callsign chosen).
  // The ChatPanel uses this to gate the conversation UI behind a friendly
  // "pick a callsign first" splash.
  const setupReady = computed(() => {
    const cs = settingsStore.selfCallsign
    return !!(cs && cs.trim() && settingsStore.selfUid)
  })

  // Master switch for TAK outbound. Mirrors `settingsStore.takActive`
  // for ergonomics — components import the chat store and read this
  // directly rather than reaching into settings.
  const takActive = computed(() => !!settingsStore.takActive)

  async function setActive(val) {
    await settingsStore.setSetting('takActive', !!val)
  }

  async function startListening() {
    if (listening) return
    listening = true
    if (setupReady.value && takActive.value) startAnnouncing()
    unlistenFn = await listen('cot-event', (event) => {
      const e = event.payload
      // Only process actual chat events. Non-chat CoT (positions / shapes)
      // is handled by tracksStore and others.
      if (e.cot_type !== 'b-t-f' || !e.chat_text) return

      // Drop our own echoes — composeChatXml prefixes the event uid with
      // GeoChat.<selfUid>. and our local listener (if pointed at the same
      // group we send to) would otherwise see our own message twice.
      const selfUid = settingsStore.selfUid
      if (selfUid && e.chat_sender_uid === selfUid) return

      const fromUid      = e.chat_sender_uid      ?? e.uid
      const fromCallsign = e.chat_sender_callsign ?? e.callsign ?? fromUid
      const recipientUid = e.chat_recipient_uid   ?? null

      // Group vs direct routing:
      // - If recipientUid resolves to "All Chat Rooms" (or the chat room
      //   id is that), bucket into the group room.
      // - Else, this is a direct message from `fromUid`. Bucket into the
      //   direct room keyed by the sender's UID so subsequent messages
      //   from / to that peer thread together.
      const isGroup =
        e.chat_room_id  === ALL_CHAT_ROOM.id ||
        recipientUid    === ALL_CHAT_ROOM.id ||
        e.chat_room     === ALL_CHAT_ROOM.name

      let roomId
      if (isGroup) {
        roomId = ALL_CHAT_ROOM.id
      } else {
        roomId = fromUid
        ensureRoom({
          id: roomId,
          name: fromCallsign,
          kind: 'direct',
          peerUid: fromUid,
          peerCallsign: fromCallsign
        })
      }

      appendMessage(roomId, {
        uid:          e.uid,
        ts:           e.time || new Date().toISOString(),
        fromUid,
        fromCallsign,
        text:         e.chat_text,
        outbound:     false
      })
    })
  }

  function stopListening() {
    if (unlistenFn) { unlistenFn(); unlistenFn = null }
    listening = false
    stopAnnouncing()
  }

  // ---- Presence announce ----

  // Broadcasts a contact-info CoT (a-f-G-U-C) on the protected
  // `tak-chat-announce` connection so peers (WinTAK / iTAK / ATAK)
  // populate their chat contacts list with our callsign + UID.
  // Skipped when the operator hasn't picked a callsign yet — without
  // one we'd publish a meaningless "ARES" placeholder.
  async function broadcastAnnounce() {
    const callsign = (settingsStore.selfCallsign ?? '').trim()
    const uid      = settingsStore.selfUid
    if (!callsign || !uid) return

    // Send the same presence announce to BOTH the chat-announce group
    // AND the SA group. ATAK / WinTAK track contact liveness primarily
    // off the SA bus (239.2.3.1:6969 by default); a peer that only
    // shows on the chat-announce group is listed in their contacts but
    // marked stale (the "dotted circle" in WinTAK's contact list),
    // which disables direct chat to that peer. Mesh-mode TAK clients
    // dual-publish to both groups for exactly this reason.
    const targets = settingsStore.cotListeners.filter(l =>
      (l.kind === 'tak-chat-announce' || l.kind === 'tak-sa') &&
      l.enabled !== false &&
      l.address && l.port
    )
    if (!targets.length) return

    // Build a real `<contact endpoint>` value from our LAN IP + the
    // chat-messages port. ATAK / WinTAK treat the legacy `*:-1:stcp`
    // placeholder as "no endpoint, peer not eligible for direct
    // chat" — we want them to direct-message us, so we advertise
    // a unicast UDP address that our `0.0.0.0:<port>` listener
    // already accepts. Falls back to the placeholder when the IP
    // lookup fails (e.g. no non-loopback interface yet).
    let endpoint = '*:-1:stcp'
    try {
      const lanIp = await invoke('get_lan_ipv4')
      const chatMsgs = settingsStore.cotListeners.find(l => l.kind === 'tak-chat-messages')
      const chatPort = chatMsgs?.port
      if (lanIp && chatPort) {
        endpoint = `${lanIp}:${chatPort}:udp`
      }
    } catch {
      // Stay with the placeholder; broadcast still goes out, peers
      // just won't be able to direct-message us.
    }

    const xml = composeAnnounceXml({
      selfUid:      uid,
      selfCallsign: callsign,
      selfCotType:  settingsStore.selfCotType ?? undefined,
      selfLocation: settingsStore.selfLocation ?? null,
      team:         settingsStore.selfTeam ?? undefined,
      role:         settingsStore.selfRole ?? undefined,
      endpoint
    })

    for (const t of targets) {
      try {
        await invoke('send_cot', {
          address:  t.address,
          port:     t.port,
          protocol: t.protocol || 'udp',
          xml
        })
      } catch (err) {
        // Non-fatal — silently retry next tick. Surface in dev console only.
        // eslint-disable-next-line no-console
        console.warn(`[chat] announce broadcast failed for ${t.kind}:`, err)
      }
    }
  }

  function startAnnouncing() {
    if (announceTimer) return
    // Fire one immediately so the user shows up in peer contacts within
    // seconds of finishing setup, then on the regular interval.
    broadcastAnnounce()
    announceTimer = setInterval(broadcastAnnounce, ANNOUNCE_INTERVAL_MS)
  }

  function stopAnnouncing() {
    if (announceTimer) {
      clearInterval(announceTimer)
      announceTimer = null
    }
  }

  // Drive announce start/stop off identity AND the master active switch.
  // The user has to flip Active before anything emits; clearing the
  // callsign or flipping inactive both stop the timer.
  watch(
    () => [settingsStore.selfCallsign, settingsStore.selfUid, settingsStore.takActive],
    ([cs, uid, active]) => {
      const ready = !!(cs && cs.trim() && uid)
      if (ready && active && listening) startAnnouncing()
      else stopAnnouncing()
    }
  )

  // Fire an immediate announce when the operator's type or location
  // changes so the user sees themselves jump on the map without waiting
  // for the next 60 s tick. Skipped if we're not yet announcing
  // (callsign + UID not set, listener not started).
  watch(
    () => [
      settingsStore.selfCotType,
      settingsStore.selfLocation,
      settingsStore.selfTeam,
      settingsStore.selfRole
    ],
    () => { if (announceTimer) broadcastAnnounce() },
    { deep: true }
  )

  // ---- Outbound ----

  async function sendMessage(roomId, text) {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return { ok: false, error: 'Empty message' }
    if (!settingsStore.takActive) {
      return { ok: false, error: 'TAK comms inactive — flip the Active switch in the chat panel header to send.' }
    }

    const room = rooms.value.get(roomId)
    if (!room) return { ok: false, error: 'Unknown room' }

    // Outbound destination is derived from the protected `tak-chat-messages`
    // listener so it stays in sync if the user retargets the chat group on
    // a non-default network. The listener is seeded on first run and can't
    // be deleted, so absence here means the user did something unusual.
    const messagesListener = settingsStore.cotListeners.find(
      l => l.kind === 'tak-chat-messages'
    )
    if (!messagesListener?.address || !messagesListener?.port) {
      return { ok: false, error: 'GeoChat Messages listener not configured' }
    }
    const dest = {
      address:  messagesListener.address,
      port:     messagesListener.port,
      protocol: messagesListener.protocol || 'udp'
    }

    const selfUid      = settingsStore.selfUid
    const selfCallsign = (settingsStore.selfCallsign ?? '').trim()
    if (!selfUid) return { ok: false, error: 'Self UID not initialized' }
    if (!selfCallsign) return { ok: false, error: 'Set your callsign in Settings → Network before sending chat.' }

    let recipientUid, recipientCallsign, roomName, finalRoomId
    if (room.kind === 'group') {
      recipientUid      = ALL_CHAT_ROOM.id
      recipientCallsign = undefined
      roomName          = ALL_CHAT_ROOM.name
      finalRoomId       = ALL_CHAT_ROOM.id
    } else {
      recipientUid      = room.peerUid
      recipientCallsign = room.peerCallsign
      roomName          = room.peerCallsign || room.name
      finalRoomId       = room.peerUid
    }

    const { uid: msgUid, xml } = composeChatXml({
      selfUid, selfCallsign,
      recipientUid, recipientCallsign,
      roomId: finalRoomId, roomName,
      text: trimmed
    })

    // Optimistic local echo so the user sees their message immediately.
    appendMessage(roomId, {
      uid:          msgUid,
      ts:           new Date().toISOString(),
      fromUid:      selfUid,
      fromCallsign: selfCallsign,
      text:         trimmed,
      outbound:     true
    })

    try {
      await invoke('send_cot', {
        address:  dest.address,
        port:     Number(dest.port),
        protocol: dest.protocol || 'udp',
        xml
      })
      return { ok: true, uid: msgUid }
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err?.message ?? 'Send failed')
      sendErrors.value.set(msgUid, msg)
      sendErrors.value = new Map(sendErrors.value)
      return { ok: false, error: msg, uid: msgUid }
    }
  }

  // ---- Room management ----

  function openDirectRoom(peerUid, peerCallsign) {
    if (!peerUid) return
    ensureRoom({
      id: peerUid,
      name: peerCallsign || peerUid,
      kind: 'direct',
      peerUid,
      peerCallsign: peerCallsign || peerUid
    })
    setActiveRoom(peerUid)
  }

  function setActiveRoom(roomId) {
    activeRoomId.value = roomId
    if (unread.value.has(roomId)) {
      unread.value.delete(roomId)
      unread.value = new Map(unread.value)
    }
  }

  // ---- Contacts (derived from live CoT tracks) ----
  // Anything in tracksStore with a callsign is a candidate direct-chat
  // partner. The panel uses this to populate the "+ Direct" picker.
  // The operator's own self-track is filtered out — chatting with
  // yourself isn't useful and surfaces as confusing in the picker.
  const knownContacts = computed(() => {
    const selfUid = settingsStore.selfUid
    const out = []
    for (const t of tracksStore.tracks.values()) {
      if (!t.callsign) continue
      if (selfUid && t.uid === selfUid) continue
      out.push({ uid: t.uid, callsign: t.callsign })
    }
    out.sort((a, b) => a.callsign.localeCompare(b.callsign))
    return out
  })

  // Sorted room list for the panel — group room pinned, then directs by
  // most recent message ts.
  const roomList = computed(() => {
    const list = Array.from(rooms.value.values())
    return list.sort((a, b) => {
      if (a.id === ALL_CHAT_ROOM.id) return -1
      if (b.id === ALL_CHAT_ROOM.id) return 1
      const am = messages.value.get(a.id) ?? []
      const bm = messages.value.get(b.id) ?? []
      const at = am.length ? am[am.length - 1].ts : ''
      const bt = bm.length ? bm[bm.length - 1].ts : ''
      return bt.localeCompare(at)
    })
  })

  return {
    rooms, messages, unread, activeRoomId, sendErrors,
    roomList, knownContacts, setupReady, takActive,
    startListening, stopListening,
    sendMessage, openDirectRoom, setActiveRoom,
    setActive
  }
})
