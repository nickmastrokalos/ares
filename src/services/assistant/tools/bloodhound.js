import { geometryBounds } from '@/services/geometry'

// A bloodhound is a live-tracking range line between two endpoints. Each
// endpoint may be a mission feature, a CoT track (by uid), an AIS vessel
// (by mmsi), or a raw [longitude, latitude]. Lines follow their endpoints
// as sources move or features are edited.
//
// These tools drive useMapBloodhound's programmatic API. Labels are resolved
// from the source stores so handler errors can reference them clearly.

function resolveEndpoint({ featuresStore, tracksStore, aisStore }, spec, label) {
  const { featureId, trackUid, vesselMmsi, coordinate } = spec
  const provided = [featureId != null, trackUid != null, vesselMmsi != null, coordinate != null].filter(Boolean).length
  if (provided !== 1) {
    return { ok: false, error: `Provide exactly one of ${label}FeatureId, ${label}TrackUid, ${label}VesselMmsi, or ${label}Coordinate.` }
  }

  if (coordinate) {
    return { ok: true, ep: { kind: 'point', coord: coordinate } }
  }

  if (trackUid != null) {
    const t = tracksStore.tracks.get(trackUid)
    if (!t) return { ok: false, error: `CoT track ${trackUid} not found.` }
    return { ok: true, ep: { kind: 'cot', uid: trackUid, coord: [t.lon, t.lat] } }
  }

  if (vesselMmsi != null) {
    const mmsi = String(vesselMmsi)
    const v = aisStore.vessels.get(mmsi)
    if (!v) return { ok: false, error: `AIS vessel ${mmsi} not found in the current feed window.` }
    return { ok: true, ep: { kind: 'ais', mmsi, coord: [v.longitude, v.latitude] } }
  }

  const row = featuresStore.features.find(f => f.id === featureId)
  if (!row) return { ok: false, error: `Feature ${featureId} not found.` }
  const props = JSON.parse(row.properties)
  let coord
  if (props.center) coord = props.center
  else if (row.type === 'box' && props.sw && props.ne) {
    coord = [(props.sw[0] + props.ne[0]) / 2, (props.sw[1] + props.ne[1]) / 2]
  } else {
    const geom = JSON.parse(row.geometry)
    if (geom.type === 'Point') coord = geom.coordinates
    else {
      const bounds = geometryBounds(geom)
      if (!bounds) return { ok: false, error: `Feature ${featureId} has no usable geometry.` }
      const [[w, s], [e, n]] = bounds
      coord = [(w + e) / 2, (s + n) / 2]
    }
  }
  return { ok: true, ep: { kind: 'feature', featureId, coord } }
}

const ENDPOINT_PROPS = (label) => ({
  [`${label}FeatureId`]:   { type: 'integer', description: `${label} endpoint: mission feature id (shape, manual track, or route).` },
  [`${label}TrackUid`]:    { type: 'string',  description: `${label} endpoint: CoT track uid (from cot_list_tracks).` },
  [`${label}VesselMmsi`]:  { type: 'string',  description: `${label} endpoint: AIS vessel MMSI (from ais_list_vessels).` },
  [`${label}Coordinate`]: {
    type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
    description: `${label} endpoint: raw [longitude, latitude].`
  }
})

function endpointSummary(spec, label) {
  if (spec[`${label}TrackUid`]    != null) return `track:${spec[`${label}TrackUid`]}`
  if (spec[`${label}VesselMmsi`]  != null) return `vessel:${spec[`${label}VesselMmsi`]}`
  if (spec[`${label}FeatureId`]   != null) return `#${spec[`${label}FeatureId`]}`
  const c = spec[`${label}Coordinate`]
  if (c) return `${c[1].toFixed(3)}, ${c[0].toFixed(3)}`
  return '?'
}

export function bloodhoundTools({ featuresStore, tracksStore, aisStore, bloodhoundApi }) {
  const stores = { featuresStore, tracksStore, aisStore }

  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'bloodhound_list',
      description: 'List all active bloodhound lines. A bloodhound is a live-tracking range line between two endpoints — each endpoint may be a CoT track, AIS vessel, mission feature, or raw coordinate. Each entry includes the two endpoints (with their kind, identifier, current coordinate, and a human label) plus the measured great-circle distance in meters.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return bloodhoundApi.bloodhounds.value.map(r => ({
          id: r.id,
          from: { ...r.epA },
          to:   { ...r.epB },
          distanceMeters: r.distanceMeters
        }))
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'bloodhound_add',
      description: 'Add a bloodhound line between two endpoints. Each endpoint is specified by exactly one of: `*FeatureId` (mission feature), `*TrackUid` (CoT track), `*VesselMmsi` (AIS vessel), or `*Coordinate` ([longitude, latitude]). The rendered line follows both endpoints as they move and displays the great-circle distance in the user\'s distance units.\n\nIMPORTANT — resolving named endpoints: if the user references an endpoint by name or callsign (e.g. "USV-Alpha", "Oceanus V"), you MUST call `map_find_entity` FIRST for each name, then pass the matching identifier field based on the returned "kind":\n  • kind="cot"     → pass as `fromTrackUid` / `toTrackUid`\n  • kind="ais"     → pass as `fromVesselMmsi` / `toVesselMmsi`\n  • kind="feature" → pass as `fromFeatureId` / `toFeatureId`\nDo NOT assume a name maps to a feature id without calling `map_find_entity`. Do NOT rely on `map_list_features` alone — it excludes CoT tracks and AIS vessels, which is a common cause of wrong-endpoint errors.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...ENDPOINT_PROPS('from'),
          ...ENDPOINT_PROPS('to')
        },
        required: []
      },
      previewRender(args) {
        const fromSpec = {
          fromFeatureId:   args.fromFeatureId,
          fromTrackUid:    args.fromTrackUid,
          fromVesselMmsi:  args.fromVesselMmsi,
          fromCoordinate:  args.fromCoordinate
        }
        const toSpec = {
          toFeatureId:   args.toFeatureId,
          toTrackUid:    args.toTrackUid,
          toVesselMmsi:  args.toVesselMmsi,
          toCoordinate:  args.toCoordinate
        }
        return `Bloodhound · ${endpointSummary(fromSpec, 'from')} ↔ ${endpointSummary(toSpec, 'to')}`
      },
      async handler(args) {
        const from = resolveEndpoint(stores, {
          featureId:  args.fromFeatureId,
          trackUid:   args.fromTrackUid,
          vesselMmsi: args.fromVesselMmsi,
          coordinate: args.fromCoordinate
        }, 'from')
        if (!from.ok) return { error: from.error }

        const to = resolveEndpoint(stores, {
          featureId:  args.toFeatureId,
          trackUid:   args.toTrackUid,
          vesselMmsi: args.toVesselMmsi,
          coordinate: args.toCoordinate
        }, 'to')
        if (!to.ok) return { error: to.error }

        const id = bloodhoundApi.addBloodhound(from.ep, to.ep)
        if (id == null) return { error: 'Map not ready.' }
        return { success: true, id }
      }
    },

    {
      name: 'bloodhound_remove',
      description: 'Remove a specific bloodhound line by its id (from bloodhound_list).',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Bloodhound id to remove.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Remove bloodhound #${id}`
      },
      async handler({ id }) {
        const ok = bloodhoundApi.removeBloodhound(id)
        return ok ? { success: true } : { error: `Bloodhound ${id} not found.` }
      }
    },

    {
      name: 'bloodhound_clear',
      description: 'Remove all bloodhound lines from the map at once. Use when the user says "clear bloodhounds", "remove all bloodhound lines", etc.',
      readonly: false,
      inputSchema: { type: 'object', properties: {}, required: [] },
      previewRender() {
        return 'Clear all bloodhound lines'
      },
      async handler() {
        bloodhoundApi.clearAll()
        return { success: true }
      }
    }

  ]
}
