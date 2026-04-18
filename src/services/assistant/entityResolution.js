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

  const c = featureCentroid(featuresStore, featureId)
  if (!c.ok) return c
  return { ok: true, ep: { kind: 'feature', featureId, coord: c.coord } }
}
