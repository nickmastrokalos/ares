// CoT GeoChat encoder.
//
// Produces the same XML shape WinTAK / iTAK / ATAK use for chat messages so
// any TAK client on the same multicast group (or pointed at the same
// destination) can interoperate. The wire format is documented in the SDK:
//   WinTak.Net.Chat.CoTChatMessage.ComposeDocument(...)
//
// All Chat Rooms (group broadcast):
//   roomId   = 'All Chat Rooms'
//   roomName = 'All Chat Rooms'
//   chatgrp uid0 = 'All Chat Rooms'
//
// Direct chat:
//   roomId   = recipient UID
//   roomName = recipient callsign
//   chatgrp uid0 = recipient UID
//
// The sender always identifies itself via:
//   <__chat senderCallsign="...">
//   <link uid="..." type="a-f-G" relation="p-p"/>

export const ALL_CHAT_ROOM = Object.freeze({
  id:   'All Chat Rooms',
  name: 'All Chat Rooms'
})

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function iso(d) {
  return d.toISOString()
}

function addMinutes(d, m) {
  return new Date(d.getTime() + m * 60_000)
}

/**
 * Build a chat-message CoT XML string.
 *
 * @param {object} params
 * @param {string} params.selfUid              Local app UID (UUID).
 * @param {string} params.selfCallsign         Local callsign shown to peers.
 * @param {string} params.recipientUid         Recipient UID — peer UID, or 'All Chat Rooms'.
 * @param {string} [params.recipientCallsign]  Recipient callsign (for <marti><dest>).
 * @param {string} params.roomId               Room id — same as recipientUid for direct, 'All Chat Rooms' for group.
 * @param {string} params.roomName             Display name shown by peers.
 * @param {string} params.text                 Message body.
 * @param {Date}   [params.now]                Defaults to new Date().
 * @returns {{ uid: string, xml: string }}
 */
export function composeChatXml({
  selfUid,
  selfCallsign,
  recipientUid,
  recipientCallsign,
  roomId,
  roomName,
  text,
  now = new Date()
}) {
  const nonce      = Math.random().toString(36).slice(2, 10)
  const eventUid   = `GeoChat.${selfUid}.${recipientUid}.${nonce}`
  const time       = iso(now)
  const stale      = iso(addMinutes(now, 1))
  const remarksSrc = `Ares.${selfUid}`

  const martiBlock = recipientCallsign
    ? `<marti><dest callsign="${escapeXml(recipientCallsign)}"/></marti>`
    : ''

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${escapeXml(eventUid)}" type="b-t-f" how="h-g-i-g-o" ` +
    `time="${time}" start="${time}" stale="${stale}">` +
      `<point lat="0" lon="0" hae="9999999.0" ce="9999999.0" le="9999999.0"/>` +
      `<detail>` +
        `<__chat parent="RootContactGroup" groupOwner="false" ` +
        `chatroom="${escapeXml(roomName)}" id="${escapeXml(roomId)}" ` +
        `senderCallsign="${escapeXml(selfCallsign)}">` +
          `<chatgrp uid0="${escapeXml(recipientUid)}" id="${escapeXml(roomId)}"/>` +
        `</__chat>` +
        `<link uid="${escapeXml(selfUid)}" type="a-f-G" relation="p-p"/>` +
        `<remarks source="${escapeXml(remarksSrc)}" to="${escapeXml(recipientUid)}" time="${time}">` +
          `${escapeXml(text)}` +
        `</remarks>` +
        martiBlock +
      `</detail>` +
    `</event>`

  return { uid: eventUid, xml }
}
