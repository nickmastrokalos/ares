#!/usr/bin/env node
/**
 * CoT test harness — generates synthetic Cursor on Target (CoT) XML messages
 * and sends them over UDP or TCP to a configurable target.
 *
 * Tracks follow a fixed waypoint route at a steady speed, looping back to the
 * start on completion. Multiple tracks are evenly spaced along the route.
 *
 * Usage:
 *   node scripts/cot-sender.mjs [options]
 *
 * Options:
 *   --host      Target host          (default: 127.0.0.1)
 *   --port      Target port          (default: 4242)
 *   --protocol  udp | tcp            (default: udp)
 *   --tracks    Number of tracks     (default: 5)
 *   --speed     Track speed (knots)  (default: 25)
 */

import * as dgram from 'node:dgram'
import * as net from 'node:net'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { host: '127.0.0.1', port: 4242, protocol: 'udp', tracks: 5, speed: 25 }
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    const val = argv[i + 1]
    if (key === 'host') args.host = val
    else if (key === 'port') args.port = Number(val)
    else if (key === 'protocol') args.protocol = val.toLowerCase()
    else if (key === 'tracks') args.tracks = Math.max(1, Number(val))
    else if (key === 'speed') args.speed = Number(val)
  }
  return args
}

const opts = parseArgs(process.argv)

// Send at 1 Hz.
const INTERVAL_MS = 1000

// ---------------------------------------------------------------------------
// Route definition — closed loop, returns to start
// ---------------------------------------------------------------------------

const WAYPOINTS = [
  { lat: 36.91492, lon: -76.16714 },  // SP
  { lat: 36.91479, lon: -76.17772 },  // WP 1
  { lat: 36.91851, lon: -76.17804 },  // WP 2
  { lat: 36.93504, lon: -76.17676 },  // WP 3
  { lat: 36.93337, lon: -76.15672 },  // WP 4
  { lat: 36.94183, lon: -76.13444 },  // WP 5
  { lat: 36.96245, lon: -76.13717 },  // WP 6
  { lat: 36.96758, lon: -76.17099 },  // WP 7
  { lat: 36.96079, lon: -76.20209 },  // WP 8
  { lat: 36.93863, lon: -76.20097 },  // WP 9
  { lat: 36.93440, lon: -76.17788 },  // WP 10
  { lat: 36.92427, lon: -76.17820 },  // WP 11
  { lat: 36.91376, lon: -76.17932 },  // WP 12
  { lat: 36.91376, lon: -76.16923 },  // WP 13
  { lat: 36.91376, lon: -76.16923 },  // EP
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

function haversine(p1, p2) {
  const R = 6_371_000
  const φ1 = p1.lat * DEG, φ2 = p2.lat * DEG
  const Δφ = (p2.lat - p1.lat) * DEG
  const Δλ = (p2.lon - p1.lon) * DEG
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearing(p1, p2) {
  const φ1 = p1.lat * DEG, φ2 = p2.lat * DEG
  const Δλ = (p2.lon - p1.lon) * DEG
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360
}

// Linearly interpolate between two waypoints (fine for the short segments here).
function lerpPoint(p1, p2, t) {
  return { lat: p1.lat + t * (p2.lat - p1.lat), lon: p1.lon + t * (p2.lon - p1.lon) }
}

// ---------------------------------------------------------------------------
// Pre-compute route geometry
// ---------------------------------------------------------------------------

const N = WAYPOINTS.length

// Segment lengths and bearings for each leg (including the closing leg back to WP0).
const SEG_LENGTHS = Array.from({ length: N }, (_, i) => haversine(WAYPOINTS[i], WAYPOINTS[(i + 1) % N]))
const SEG_BEARINGS = Array.from({ length: N }, (_, i) => bearing(WAYPOINTS[i], WAYPOINTS[(i + 1) % N]))

// Cumulative distances from the route start, one entry per segment start.
const CUM_DIST = SEG_LENGTHS.reduce((acc, len) => {
  acc.push(acc[acc.length - 1] + len)
  return acc
}, [0])

const TOTAL_DIST = CUM_DIST[N]

// Return { lat, lon, course } for a given distance along the route.
function positionAt(dist) {
  const d = ((dist % TOTAL_DIST) + TOTAL_DIST) % TOTAL_DIST

  // Find the segment that contains this distance.
  let seg = N - 1
  for (let i = 0; i < N; i++) {
    if (d < CUM_DIST[i + 1]) { seg = i; break }
  }

  const frac = (d - CUM_DIST[seg]) / SEG_LENGTHS[seg]
  const pos = lerpPoint(WAYPOINTS[seg], WAYPOINTS[(seg + 1) % N], frac)
  return { lat: pos.lat, lon: pos.lon, course: SEG_BEARINGS[seg] }
}

// ---------------------------------------------------------------------------
// Track state
// ---------------------------------------------------------------------------

const NATO = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
  'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet',
  'Kilo', 'Lima', 'Mike', 'November', 'Oscar',
  'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango',
  'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'
]

// CoT type: friendly surface combatant
const COT_TYPE = 'a-f-S-C'

// Speed in m/s — distance advanced each 1-second tick.
const SPEED_MS = opts.speed * (1852 / 3600)

const trackState = Array.from({ length: opts.tracks }, (_, i) => ({
  uid: `ARES-USV-${i + 1}`,
  callsign: `USV-${NATO[i % NATO.length]}`,
  dist: (TOTAL_DIST * i) / opts.tracks   // evenly spaced start positions
}))

// ---------------------------------------------------------------------------
// CoT XML builder
// ---------------------------------------------------------------------------

function isoNow(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString()
}

function buildCot(track) {
  const { lat, lon, course } = positionAt(track.dist)
  const time = isoNow()
  const stale = isoNow(10)

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<event version="2.0" uid="${track.uid}" type="${COT_TYPE}" ` +
    `time="${time}" start="${time}" stale="${stale}" how="m-g">` +
    `<point lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}" ` +
    `hae="0.0" ce="10.0" le="10.0"/>` +
    `<detail>` +
    `<contact callsign="${track.callsign}"/>` +
    `<track speed="${SPEED_MS.toFixed(2)}" course="${course.toFixed(1)}"/>` +
    `</detail>` +
    `</event>`
  )
}

function stepTracks() {
  for (const t of trackState) {
    t.dist = (t.dist + SPEED_MS) % TOTAL_DIST
  }
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

const LAP_MINS = (TOTAL_DIST / SPEED_MS / 60).toFixed(1)
const DIST_KM = (TOTAL_DIST / 1000).toFixed(2)

function statusLine(proto) {
  return (
    `\r[CoT] ${opts.tracks} USV(s) → ${proto}://${opts.host}:${opts.port}` +
    `  route ${DIST_KM} km  ${opts.speed} kts  lap ${LAP_MINS} min`
  )
}

// ---------------------------------------------------------------------------
// UDP sender
// ---------------------------------------------------------------------------

function sendUdp() {
  const socket = dgram.createSocket('udp4')

  function tick() {
    stepTracks()
    for (const track of trackState) {
      socket.send(Buffer.from(buildCot(track), 'utf8'), opts.port, opts.host, (err) => {
        if (err) console.error(`[CoT] UDP send error: ${err.message}`)
      })
    }
    process.stdout.write(statusLine('udp'))
  }

  tick()
  setInterval(tick, INTERVAL_MS)
  process.on('SIGINT', () => { console.log('\n[CoT] Stopped.'); socket.close(); process.exit(0) })
}

// ---------------------------------------------------------------------------
// TCP sender — persistent connection, re-connects on close
// ---------------------------------------------------------------------------

function sendTcp() {
  let client = null
  let intervalId = null

  function connect() {
    client = net.createConnection({ host: opts.host, port: opts.port }, () => {
      console.log(`[CoT] TCP connected to ${opts.host}:${opts.port}`)

      function tick() {
        if (!client || client.destroyed) return
        stepTracks()
        for (const track of trackState) client.write(buildCot(track), 'utf8')
        process.stdout.write(statusLine('tcp'))
      }

      tick()
      intervalId = setInterval(tick, INTERVAL_MS)
    })

    client.on('close', () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null }
      console.log('\n[CoT] TCP connection closed — retrying in 3s')
      setTimeout(connect, 3000)
    })

    client.on('error', (err) => { console.error(`[CoT] TCP error: ${err.message}`) })
  }

  connect()
  process.on('SIGINT', () => {
    if (intervalId) clearInterval(intervalId)
    if (client) client.destroy()
    console.log('\n[CoT] Stopped.')
    process.exit(0)
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

console.log(
  `[CoT] ${opts.tracks} USV(s)  ` +
  `route ${DIST_KM} km  ` +
  `${opts.speed} kts (${SPEED_MS.toFixed(2)} m/s)  ` +
  `lap ${LAP_MINS} min  ` +
  `→ ${opts.protocol.toUpperCase()} ${opts.host}:${opts.port}`
)
console.log(`[CoT] ${N} waypoints, closing loop back to origin`)
console.log('[CoT] Press Ctrl+C to stop\n')

if (opts.protocol === 'tcp') {
  sendTcp()
} else {
  sendUdp()
}
