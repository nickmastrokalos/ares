import { invoke } from '@tauri-apps/api/core'
import { distanceBetween } from '@/services/geometry'
import { featureCentroid } from '@/services/assistant/entityResolution'
import { isValidIP } from '@/services/network'

const VALID_PROTOCOLS = ['udp', 'tcp']

function summariseListener(l, index) {
  return {
    index,
    name:     l.name ?? '',
    address:  l.address,
    port:     l.port,
    protocol: l.protocol ?? 'udp',
    enabled:  Boolean(l.enabled)
  }
}

// Resolve a user-supplied listener name to its index in the settings
// store. Names are case-insensitive and must be unique among listeners.
function findListenerByName(settingsStore, name) {
  const needle = String(name ?? '').trim().toLowerCase()
  if (!needle) return { error: 'Listener `name` is required.' }
  const matches = []
  settingsStore.cotListeners.forEach((l, i) => {
    if ((l.name ?? '').trim().toLowerCase() === needle) {
      matches.push({ index: i, listener: l })
    }
  })
  if (matches.length === 0) {
    return { error: `No CoT listener named "${name}". Call cot_list_listeners to see what's configured.` }
  }
  if (matches.length > 1) {
    return { error: `Multiple CoT listeners share the name "${name}". Rename them in Settings → Listeners and try again.` }
  }
  return matches[0]
}

// CoT (Cursor-on-Target) live tracks. These come from UDP/TCP listeners and
// live in `tracksStore.tracks` — separate from mission features (which are in
// `featuresStore.features`). They are identified by a string `uid`, not an
// integer feature id.
//
// CoT type format: "a-{affiliation}-{...}". Affiliation char at index 2 →
// f/h/n/u = friendly/hostile/civilian/unknown.

const AFFIL_WORD = { f: 'friendly', h: 'hostile', n: 'civilian', u: 'unknown' }

function affiliationOf(cotType) {
  return AFFIL_WORD[cotType?.[2]] ?? 'unknown'
}

function summariseTrack(t) {
  return {
    uid:         t.uid,
    callsign:    t.callsign ?? t.uid,
    cotType:     t.cotType ?? null,
    affiliation: affiliationOf(t.cotType),
    coordinate:  [t.lon, t.lat],
    speedMs:     t.speed  ?? 0,
    courseDeg:   t.course ?? 0,
    haeMeters:   t.hae    ?? 0,
    stale:       t.stale  ?? null,
    updatedAt:   t.updatedAt ?? null
  }
}

function resolveCenter(featuresStore, tracksStore, featureId, trackUid, coordinate) {
  if (coordinate) return { ok: true, point: coordinate }
  if (trackUid) {
    const t = tracksStore.tracks.get(trackUid)
    if (!t) return { ok: false, error: `CoT track ${trackUid} not found.` }
    return { ok: true, point: [t.lon, t.lat] }
  }
  if (featureId == null) {
    return { ok: false, error: 'Provide featureId, trackUid, or coordinate.' }
  }
  const c = featureCentroid(featuresStore, featureId)
  return c.ok ? { ok: true, point: c.coord } : c
}

export function cotTools({ tracksStore, featuresStore, settingsStore }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'cot_list_tracks',
      description: 'List live CoT (Cursor-on-Target) tracks received from active listeners. These are distinct from manual tracks (which come from map_list_features) and are identified by a string "uid", not an integer id. Each track carries its callsign, CoT type, affiliation (friendly / hostile / civilian / unknown), position, speed (m/s), course, altitude, and staleness. Supply the optional filters to narrow the list — use them whenever the user asks for a subset like "friendly tracks" or "by callsign bravo".',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          affiliation: {
            type: 'string',
            enum: ['friendly', 'hostile', 'civilian', 'unknown'],
            description: 'Return only tracks with this affiliation.'
          },
          name: {
            type: 'string',
            description: 'Case-insensitive substring of callsign or uid.'
          },
          limit: {
            type: 'integer', minimum: 1, maximum: 1000,
            description: 'Max tracks to return. Default 200.'
          }
        },
        required: []
      },
      async handler({ affiliation, name, limit = 200 }) {
        const needle = name?.trim().toLowerCase() ?? ''
        const all = Array.from(tracksStore.tracks.values()).map(summariseTrack)
        const filtered = all.filter(t => {
          if (affiliation && t.affiliation !== affiliation) return false
          if (needle) {
            if (!t.callsign.toLowerCase().includes(needle) && !t.uid.toLowerCase().includes(needle)) return false
          }
          return true
        })
        return {
          listening: tracksStore.listening,
          totalCount: tracksStore.tracks.size,
          returnedCount: Math.min(filtered.length, limit),
          truncated: filtered.length > limit,
          tracks: filtered.slice(0, limit)
        }
      }
    },

    {
      name: 'cot_get_track',
      description: 'Get the full detail for a single CoT track by its uid (from cot_list_tracks).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'Track uid.' }
        },
        required: ['uid']
      },
      async handler({ uid }) {
        const t = tracksStore.tracks.get(uid)
        if (!t) return { error: `CoT track ${uid} not found.` }
        return summariseTrack(t)
      }
    },

    {
      name: 'cot_tracks_near',
      description: 'Find CoT tracks within a radius of a center point. Center may be a feature id, a CoT track uid, or a raw [longitude, latitude]. Results include the distance in meters and are sorted nearest-first. Convert the user\'s units to meters (1 nm = 1852 m, 1 mi = 1609.344 m, 1 km = 1000 m). Pass an affiliation to filter — e.g. "hostile tracks within 10 nm of FRND-1".',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          featureId:    { type: 'integer', description: 'Feature id for the center.' },
          trackUid:     { type: 'string',  description: 'CoT track uid for the center.' },
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Raw center [longitude, latitude].'
          },
          radiusMeters: { type: 'number', description: 'Search radius in meters.' },
          affiliation: {
            type: 'string',
            enum: ['friendly', 'hostile', 'civilian', 'unknown'],
            description: 'Filter results to this affiliation only.'
          },
          limit:        { type: 'integer', minimum: 1, maximum: 500, description: 'Max tracks to return. Default 50.' }
        },
        required: ['radiusMeters']
      },
      async handler({ featureId, trackUid, coordinate, radiusMeters, affiliation, limit = 50 }) {
        const center = resolveCenter(featuresStore, tracksStore, featureId, trackUid, coordinate)
        if (!center.ok) return { error: center.error }
        const matches = []
        for (const t of tracksStore.tracks.values()) {
          if (trackUid && t.uid === trackUid) continue  // don't match the center against itself
          const affil = affiliationOf(t.cotType)
          if (affiliation && affil !== affiliation) continue
          const d = distanceBetween(center.point, [t.lon, t.lat])
          if (d <= radiusMeters) matches.push({ ...summariseTrack(t), distanceMeters: d })
        }
        matches.sort((a, b) => a.distanceMeters - b.distanceMeters)
        return {
          center: center.point,
          radiusMeters,
          matchCount: matches.length,
          returnedCount: Math.min(matches.length, limit),
          truncated: matches.length > limit,
          tracks: matches.slice(0, limit)
        }
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'cot_remove_track',
      description: 'Remove a CoT track from the local cache by uid. Note: if the underlying listener is still receiving CoT for that uid the track will reappear on the next update — this is a local clear, not a network action.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'CoT track uid from cot_list_tracks.' }
        },
        required: ['uid']
      },
      previewRender({ uid }) {
        return `Remove CoT track ${uid}`
      },
      async handler({ uid }) {
        if (!tracksStore.tracks.has(uid)) return { error: `CoT track ${uid} not found.` }
        tracksStore.removeTrack(uid)
        return { success: true }
      }
    },

    // ── Listeners ────────────────────────────────────────────────────────────

    {
      name: 'cot_list_listeners',
      description: 'List all configured CoT listeners (UDP / TCP sockets receiving Cursor-on-Target traffic). Each entry has its name, address, port, protocol, and enabled state. Call this BEFORE referring to a listener by name in cot_add_listener / cot_remove_listener / cot_set_listener_enabled, or whenever the user asks "what listeners are running?", "show CoT listeners", and similar.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return {
          listeners: settingsStore.cotListeners.map((l, i) => summariseListener(l, i))
        }
      }
    },

    {
      name: 'cot_add_listener',
      description: 'Configure a new CoT listener and start receiving on it immediately. Use when the user asks to "start listening on UDP <port>", "add a TCP listener at <ip>:<port>", and similar. Validates that the IP address is well-formed, the port is 1-65535, the protocol is `udp` or `tcp`, and the address:port pair is not already configured. The listener is enabled (started) on creation.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          name:     { type: 'string',  description: 'OPTIONAL human-readable name for the listener (e.g. "VRS", "ATAK"). Pass ONLY if the user names it; otherwise OMIT.' },
          address:  { type: 'string',  description: 'IP address to bind / receive on. IPv4 or IPv6.' },
          port:     { type: 'integer', minimum: 1, maximum: 65535, description: 'Port number 1-65535.' },
          protocol: { type: 'string',  enum: VALID_PROTOCOLS, description: 'Transport. Defaults to `udp` if omitted.' }
        },
        required: ['address', 'port']
      },
      previewRender({ name, address, port, protocol }) {
        const proto = (protocol || 'udp').toUpperCase()
        const labelled = name ? `"${name}" · ` : ''
        return `Add CoT listener · ${labelled}${proto} ${address}:${port}`
      },
      async handler({ name, address, port, protocol = 'udp' }) {
        const addr = String(address ?? '').trim()
        if (!addr) return { error: '`address` is required.' }
        if (!isValidIP(addr)) return { error: `"${address}" is not a valid IP address.` }
        const p = Number(port)
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          return { error: '`port` must be an integer between 1 and 65535.' }
        }
        const proto = String(protocol ?? 'udp').toLowerCase()
        if (!VALID_PROTOCOLS.includes(proto)) {
          return { error: `\`protocol\` must be one of ${VALID_PROTOCOLS.join(', ')}.` }
        }
        if (settingsStore.cotListeners.some(l => l.address === addr && l.port === p)) {
          return { error: `A listener at ${addr}:${p} is already configured.` }
        }

        await settingsStore.addCotListener({
          name: (name ?? '').trim(),
          address: addr,
          port: p,
          protocol: proto
        })
        try {
          await invoke('start_listener', { address: addr, port: p, protocol: proto })
        } catch (err) {
          return { error: `Listener saved but failed to start: ${err?.message ?? err}` }
        }
        const idx = settingsStore.cotListeners.length - 1
        return { success: true, listener: summariseListener(settingsStore.cotListeners[idx], idx) }
      }
    },

    {
      name: 'cot_remove_listener',
      description: 'Stop and remove a CoT listener by name. Closes the socket first, then deletes the configuration. Verify the name with cot_list_listeners.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Listener name as shown in cot_list_listeners.' }
        },
        required: ['name']
      },
      previewRender({ name }) {
        return `Remove CoT listener "${name}"`
      },
      async handler({ name }) {
        const found = findListenerByName(settingsStore, name)
        if (found.error) return { error: found.error }
        const { index, listener } = found
        if (listener.enabled) {
          try {
            await invoke('stop_listener', { address: listener.address, port: listener.port })
          } catch (err) {
            return { error: `Failed to stop listener before removal: ${err?.message ?? err}` }
          }
        }
        await settingsStore.removeCotListener(index)
        return { success: true, removed: summariseListener(listener, index) }
      }
    },

    {
      name: 'cot_set_listener_enabled',
      description: 'Start or stop an existing CoT listener identified by name. Pass `enabled: true` to start it (open the socket), `enabled: false` to stop. Verify the name with cot_list_listeners. Use when the user says "disable the VRS listener", "turn the ATAK feed off", "start the listener called X", etc.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          name:    { type: 'string',  description: 'Listener name as shown in cot_list_listeners.' },
          enabled: { type: 'boolean', description: 'True to start, false to stop.' }
        },
        required: ['name', 'enabled']
      },
      previewRender({ name, enabled }) {
        return `${enabled ? 'Start' : 'Stop'} CoT listener "${name}"`
      },
      async handler({ name, enabled }) {
        const found = findListenerByName(settingsStore, name)
        if (found.error) return { error: found.error }
        const { index, listener } = found
        if (Boolean(listener.enabled) === Boolean(enabled)) {
          return {
            success: true,
            listener: summariseListener(listener, index),
            note: `Listener "${name}" was already ${enabled ? 'enabled' : 'disabled'}.`
          }
        }
        try {
          if (enabled) {
            await invoke('start_listener', {
              address: listener.address,
              port: listener.port,
              protocol: listener.protocol ?? 'udp'
            })
          } else {
            await invoke('stop_listener', { address: listener.address, port: listener.port })
          }
        } catch (err) {
          return { error: `Failed to ${enabled ? 'start' : 'stop'} listener: ${err?.message ?? err}` }
        }
        await settingsStore.toggleCotListener(index)
        return { success: true, listener: summariseListener(settingsStore.cotListeners[index], index) }
      }
    }

  ]
}
