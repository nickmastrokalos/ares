// Periodic presence announce for TAK GeoChat / SA.
//
// TAK clients populate their chat contacts list from `a-f-G-U-C` ("contact
// info — friend, ground, unit, civilian") events broadcast on the announce
// multicast group (default udp://224.10.10.1:18740). Each event carries
// callsign + UID + endpoint, which is what lets a peer "right-click → Send
// Direct Chat" without ever having received a message from us.
//
// We send a stripped-down version of that event — no live location (we
// don't have an operator GPS yet), no team color choice, no battery — just
// enough for our callsign to appear in WinTAK's contacts.
//
// Stale window is 5 minutes so a peer that misses one or two announces in
// a row still treats us as fresh.

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
 * Build a presence-announce CoT XML string.
 *
 * @param {object} params
 * @param {string} params.selfUid                  Stable per-install UID.
 * @param {string} params.selfCallsign             Operator callsign.
 * @param {string} [params.selfCotType]            Full CoT type (e.g. `a-f-G-U-C-I`).
 *                                                  Falls back to the v1 placeholder
 *                                                  `a-f-G-U-C` when not provided.
 * @param {{lat:number,lon:number}|null} [params.selfLocation]
 *                                                  Operator's manual location. When
 *                                                  null, the announce uses lat/lon
 *                                                  (0, 0) as a presence-only beacon.
 * @param {string} [params.appVersion]             App version label for the takv block.
 * @param {Date}   [params.now]
 * @returns {string}
 */
export function composeAnnounceXml({
  selfUid,
  selfCallsign,
  selfCotType  = 'a-f-G-U-C',
  selfLocation = null,
  appVersion   = '1.x',
  now          = new Date()
}) {
  const time  = iso(now)
  const stale = iso(addMinutes(now, 5))

  const lat = (selfLocation && Number.isFinite(selfLocation.lat)) ? selfLocation.lat : 0
  const lon = (selfLocation && Number.isFinite(selfLocation.lon)) ? selfLocation.lon : 0

  // `endpoint="*:-1:stcp"` is TAK shorthand for "I'm not on a streaming
  // server; reach me through whatever multicast group we share."
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${escapeXml(selfUid)}" type="${escapeXml(selfCotType)}" ` +
    `how="m-g" time="${time}" start="${time}" stale="${stale}">` +
      `<point lat="${lat}" lon="${lon}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>` +
      `<detail>` +
        `<contact callsign="${escapeXml(selfCallsign)}" endpoint="*:-1:stcp"/>` +
        `<__group name="Cyan" role="Team Member"/>` +
        `<takv platform="Ares" version="${escapeXml(appVersion)}" device="Ares" os="Tauri"/>` +
        `<status readiness="true"/>` +
        `<uid Droid="${escapeXml(selfCallsign)}"/>` +
      `</detail>` +
    `</event>`
  )
}
