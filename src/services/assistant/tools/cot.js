import { distanceBetween } from '@/services/geometry'
import { featureCentroid } from '@/services/assistant/entityResolution'

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

export function cotTools({ tracksStore, featuresStore }) {
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
    }

  ]
}
