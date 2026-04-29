import { geometryBounds } from '@/services/geometry'

// Shared entity-resolution helpers used by tool bundles that accept a
// target/endpoint identified by one of (featureId | trackUid | vesselMmsi |
// coordinate). Unified return envelope: { ok: true, ... } | { ok: false, error }.
//
// The label argument shapes the error message so callers still produce
// bundle-specific wording (e.g. "fromFeatureId", "targetVesselMmsi") without
// duplicating the resolution logic.

export function featureCentroid(featuresStore, featureId) {
  const row = featuresStore.features.find(f => f.id === featureId)
  if (!row) return { ok: false, error: `Feature ${featureId} not found.` }
  const props = JSON.parse(row.properties)
  if (props.center) return { ok: true, coord: props.center }
  if (row.type === 'box' && props.sw && props.ne) {
    return { ok: true, coord: [(props.sw[0] + props.ne[0]) / 2, (props.sw[1] + props.ne[1]) / 2] }
  }
  const geom = JSON.parse(row.geometry)
  if (geom.type === 'Point') return { ok: true, coord: geom.coordinates }
  const bounds = geometryBounds(geom)
  if (!bounds) return { ok: false, error: `Feature ${featureId} has no usable geometry.` }
  const [[w, s], [e, n]] = bounds
  return { ok: true, coord: [(w + e) / 2, (s + n) / 2] }
}

// Resolve a `trackUid` argument into a tracksStore entry. The agent
// occasionally hands a callsign or partial uid here ("Armada 144",
// "144") instead of the resolved CoT uid (`armada-<bigint>`),
// typically when it skipped or mis-routed the `map_find_entity`
// step. Direct uid lookup wins; if it misses, fall back to a single
// substring match across each track's callsign + uid. Multi-match
// returns an error listing the candidates so the model can
// disambiguate on the next turn instead of silently picking one.
function resolveTrackByUidOrName(tracksStore, trackUid) {
  const t = tracksStore.tracks.get(trackUid)
  if (t) return { ok: true, track: t }
  const needle = String(trackUid).toLowerCase()
  const hits = []
  for (const candidate of tracksStore.tracks.values()) {
    const callsign = (candidate.callsign ?? candidate.uid).toLowerCase()
    const uid      = candidate.uid.toLowerCase()
    if (callsign.includes(needle) || uid.includes(needle)) hits.push(candidate)
  }
  if (hits.length === 1) return { ok: true, track: hits[0] }
  if (hits.length > 1) {
    const list = hits.slice(0, 8).map(h => `${h.callsign ?? h.uid} (uid=${h.uid})`).join('; ')
    return { ok: false, error: `Ambiguous CoT track "${trackUid}" — multiple matches: ${list}. Pass the full uid via map_find_entity.` }
  }
  return { ok: false, error: `CoT track ${trackUid} not found. Call map_find_entity first to resolve the user's name to a uid.` }
}

export function resolveEndpoint({ featuresStore, tracksStore, aisStore }, spec, label) {
  const { featureId, trackUid, vesselMmsi, coordinate } = spec
  const provided = [featureId != null, trackUid != null, vesselMmsi != null, coordinate != null].filter(Boolean).length
  if (provided !== 1) {
    return { ok: false, error: `Provide exactly one of ${label}FeatureId, ${label}TrackUid, ${label}VesselMmsi, or ${label}Coordinate.` }
  }

  if (coordinate) {
    return { ok: true, ep: { kind: 'point', coord: coordinate } }
  }

  if (trackUid != null) {
    const r = resolveTrackByUidOrName(tracksStore, trackUid)
    if (!r.ok) return r
    return { ok: true, ep: { kind: 'cot', uid: r.track.uid, coord: [r.track.lon, r.track.lat] } }
  }

  if (vesselMmsi != null) {
    const mmsi = String(vesselMmsi)
    const v = aisStore.vessels.get(mmsi)
    if (!v) return { ok: false, error: `AIS vessel ${mmsi} not found in the current feed window.` }
    return { ok: true, ep: { kind: 'ais', mmsi, coord: [v.longitude, v.latitude] } }
  }

  const c = featureCentroid(featuresStore, featureId)
  if (!c.ok) return c
  return { ok: true, ep: { kind: 'feature', featureId, coord: c.coord } }
}

export function resolveTarget({ featuresStore, tracksStore, aisStore }, spec, label) {
  const { featureId, trackUid, vesselMmsi } = spec
  const provided = [featureId != null, trackUid != null, vesselMmsi != null].filter(Boolean).length
  if (provided !== 1) {
    return { ok: false, error: `Provide exactly one of ${label}FeatureId, ${label}TrackUid, or ${label}VesselMmsi.` }
  }

  if (trackUid != null) {
    const r = resolveTrackByUidOrName(tracksStore, trackUid)
    if (!r.ok) return r
    return { ok: true, ep: { kind: 'cot', uid: r.track.uid, coord: [r.track.lon, r.track.lat] } }
  }

  if (vesselMmsi != null) {
    const mmsi = String(vesselMmsi)
    const v = aisStore.vessels.get(mmsi)
    if (!v) return { ok: false, error: `AIS vessel ${mmsi} not found in the current feed window.` }
    return { ok: true, ep: { kind: 'ais', mmsi, coord: [v.longitude, v.latitude] } }
  }

  const c = featureCentroid(featuresStore, featureId)
  if (!c.ok) return c
  return { ok: true, ep: { kind: 'feature', featureId, coord: c.coord } }
}
