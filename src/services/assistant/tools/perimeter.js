import { resolveTarget } from '@/services/assistant/entityResolution'

// A perimeter is a live-following standoff ring around a single track —
// dashed circle at a user-given radius. Optional breach alert flips the ring
// red and halos any intruding track. One perimeter per owner track.
//
// Targets are tracks only: CoT (uid), AIS vessel (mmsi), or a mission
// feature (manual track). Raw coordinates are not accepted — perimeters
// must follow a live source.

function ownerKeyFromSpec(spec) {
  if (spec.targetTrackUid    != null) return `cot:${spec.targetTrackUid}`
  if (spec.targetVesselMmsi  != null) return `ais:${spec.targetVesselMmsi}`
  if (spec.targetFeatureId   != null) return `feature:${spec.targetFeatureId}`
  return null
}

const TARGET_PROPS = {
  targetFeatureId:  { type: 'integer', description: 'Target track: mission feature id (manual track).' },
  targetTrackUid:   { type: 'string',  description: 'Target track: CoT track uid (from cot_list_tracks).' },
  targetVesselMmsi: { type: 'string',  description: 'Target track: AIS vessel MMSI (from ais_list_vessels).' }
}

function targetSummary(spec) {
  if (spec.targetTrackUid    != null) return `track:${spec.targetTrackUid}`
  if (spec.targetVesselMmsi  != null) return `vessel:${spec.targetVesselMmsi}`
  if (spec.targetFeatureId   != null) return `#${spec.targetFeatureId}`
  return '?'
}

export function perimeterTools({ featuresStore, tracksStore, aisStore, perimeterApi }) {
  const stores = { featuresStore, tracksStore, aisStore }

  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'perimeter_list',
      description: 'List all active perimeter rings. A perimeter is a standoff ring (dashed circle) attached to a single track — CoT, AIS vessel, or mission feature (manual track). Each entry reports the owner track (kind, identifier, current coordinate, human label), radius in meters, alert flag, and the list of intruding tracks currently inside the ring.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return perimeterApi.perimeters.value.map(r => ({
          ownerKey: r.ownerKey,
          owner: { ...r.owner },
          radius: r.radius,
          alert: r.alert,
          breached: r.breached.map(b => ({ ...b }))
        }))
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'perimeter_add',
      description: 'Add a perimeter ring around a track, or replace the existing ring if that track already has one (one perimeter per track). The target is specified by exactly one of: `targetTrackUid` (CoT), `targetVesselMmsi` (AIS), or `targetFeatureId` (mission feature / manual track). The ring follows the track as it moves and — when alert is true — flips red with red halos around any other track inside the radius.\n\nIMPORTANT — resolving named targets: if the user references the track by name or callsign (e.g. "USV-Alpha", "Oceanus V"), you MUST call `map_find_entity` FIRST, then pass the matching identifier field based on the returned "kind":\n  • kind="cot"     → pass as `targetTrackUid`\n  • kind="ais"     → pass as `targetVesselMmsi`\n  • kind="feature" → pass as `targetFeatureId` (manual tracks only — perimeters do not attach to shapes or routes)\nDo NOT assume a name maps to a feature id without calling `map_find_entity`. Do NOT rely on `map_list_features` alone — it excludes CoT tracks and AIS vessels.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          radiusMeters: { type: 'number', description: 'Standoff radius in meters.' },
          alert:        { type: 'boolean', description: 'Whether breaches should flag the ring red and halo intruders. Defaults to true.' }
        },
        required: ['radiusMeters']
      },
      previewRender(args) {
        const a = args.alert === false ? ' (no alert)' : ''
        return `Perimeter · ${targetSummary(args)} · ${args.radiusMeters} m${a}`
      },
      async handler(args) {
        const res = resolveTarget(stores, {
          featureId:  args.targetFeatureId,
          trackUid:   args.targetTrackUid,
          vesselMmsi: args.targetVesselMmsi
        }, 'target')
        if (!res.ok) return { error: res.error }

        const r = Number(args.radiusMeters)
        if (!Number.isFinite(r) || r <= 0) return { error: 'radiusMeters must be a positive number.' }

        const ownerKey = perimeterApi.addPerimeter(res.ep, r, args.alert !== false)
        if (!ownerKey) return { error: 'Map not ready.' }
        return { success: true, ownerKey }
      }
    },

    {
      name: 'perimeter_remove',
      description: 'Remove the perimeter from a specific track. Specify the target exactly as for perimeter_add.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: { ...TARGET_PROPS },
        required: []
      },
      previewRender(args) {
        return `Remove perimeter · ${targetSummary(args)}`
      },
      async handler(args) {
        const key = ownerKeyFromSpec(args)
        if (!key) return { error: 'Provide exactly one of targetFeatureId, targetTrackUid, or targetVesselMmsi.' }
        const ok = perimeterApi.removePerimeter(key)
        return ok ? { success: true } : { error: `No perimeter on ${targetSummary(args)}.` }
      }
    },

    {
      name: 'perimeter_set_radius',
      description: 'Update the standoff radius (in meters) on an existing perimeter.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          radiusMeters: { type: 'number', description: 'New standoff radius in meters.' }
        },
        required: ['radiusMeters']
      },
      previewRender(args) {
        return `Set perimeter radius · ${targetSummary(args)} → ${args.radiusMeters} m`
      },
      async handler(args) {
        const key = ownerKeyFromSpec(args)
        if (!key) return { error: 'Provide exactly one of targetFeatureId, targetTrackUid, or targetVesselMmsi.' }
        const r = Number(args.radiusMeters)
        if (!Number.isFinite(r) || r <= 0) return { error: 'radiusMeters must be a positive number.' }
        const ok = perimeterApi.setRadius(key, r)
        return ok ? { success: true } : { error: `No perimeter on ${targetSummary(args)}.` }
      }
    },

    {
      name: 'perimeter_set_alert',
      description: 'Toggle the breach alert on an existing perimeter. When alert is true, the ring flips red and halos intruders; when false, the ring stays blue regardless of intruders.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...TARGET_PROPS,
          alert: { type: 'boolean', description: 'Whether to enable breach alerts.' }
        },
        required: ['alert']
      },
      previewRender(args) {
        return `Set perimeter alert · ${targetSummary(args)} → ${args.alert ? 'on' : 'off'}`
      },
      async handler(args) {
        const key = ownerKeyFromSpec(args)
        if (!key) return { error: 'Provide exactly one of targetFeatureId, targetTrackUid, or targetVesselMmsi.' }
        const ok = perimeterApi.setAlert(key, Boolean(args.alert))
        return ok ? { success: true } : { error: `No perimeter on ${targetSummary(args)}.` }
      }
    },

    {
      name: 'perimeter_clear',
      description: 'Remove every perimeter ring from the map at once. Use when the user says "clear perimeters", "remove all perimeters", etc.',
      readonly: false,
      inputSchema: { type: 'object', properties: {}, required: [] },
      previewRender() {
        return 'Clear all perimeters'
      },
      async handler() {
        perimeterApi.clearAll()
        return { success: true }
      }
    }

  ]
}
