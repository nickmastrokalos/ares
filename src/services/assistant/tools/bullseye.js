import { resolveEndpoint } from '@/services/assistant/entityResolution'

// Bullseye is a single per-mission reference point with concentric range
// rings and optional N/E/S/W spokes. One active bullseye at a time; setting
// replaces the previous one. See docs/bullseye.md.
//
// The bullseye is NOT a mission feature — `map_list_features` /
// `map_move_feature` do not touch it. Always use these dedicated tools
// when the user references "the bullseye".
//
// Location inputs accept raw coordinates or resolve against a mission
// feature, CoT track, or AIS vessel via the shared `resolveEndpoint` helper.
// Only the instantaneous coordinate is captured — the bullseye does not
// follow a moving source.

const AT_PROPS = {
  atFeatureId:  { type: 'integer', description: 'Place at the centroid of this mission feature id.' },
  atTrackUid:   { type: 'string',  description: 'Place at the current position of this CoT track uid (from cot_list_tracks).' },
  atVesselMmsi: { type: 'string',  description: 'Place at the current position of this AIS vessel MMSI (from ais_list_vessels).' },
  atCoordinate: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2, maxItems: 2,
    description: 'Place at this raw [lon, lat] coordinate.'
  }
}

function atSummary(args) {
  if (args.atTrackUid    != null) return `track:${args.atTrackUid}`
  if (args.atVesselMmsi  != null) return `vessel:${args.atVesselMmsi}`
  if (args.atFeatureId   != null) return `feature:#${args.atFeatureId}`
  if (Array.isArray(args.atCoordinate)) {
    const [lon, lat] = args.atCoordinate
    return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`
  }
  return '?'
}

export function bullseyeTools({ featuresStore, tracksStore, aisStore, bullseyeApi }) {
  const stores = { featuresStore, tracksStore, aisStore }

  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'bullseye_get',
      description: 'Return the active bullseye for the current mission, or null if none is placed. Reports centre coordinate, name, ring interval (metres), ring count, and whether cardinal spokes are shown.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        const b = bullseyeApi.bullseye.value
        if (!b) return null
        return {
          lat: b.lat,
          lon: b.lon,
          name: b.name,
          ringIntervalMeters: b.ringInterval,
          ringCount: b.ringCount,
          showCardinals: b.showCardinals
        }
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'bullseye_set',
      description: 'Place the bullseye at a location, replacing any existing bullseye. Provide exactly one placement option: atFeatureId, atTrackUid, atVesselMmsi, or atCoordinate. Optional fields configure the rings and label. Use this when the user says "place bullseye at …" or "set bullseye to …".\n\nIMPORTANT — resolving named placements: if the user references a target by name or callsign, call `map_find_entity` FIRST to determine whether it maps to a feature, CoT track, or AIS vessel, then pass the matching field.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...AT_PROPS,
          name:               { type: 'string',  description: 'Optional label shown above the centre. Defaults to the current or system default ("BULLSEYE").' },
          ringIntervalMeters: { type: 'number',  description: 'Spacing between rings in metres. Defaults to the current or 1852 m (1 nautical mile).' },
          ringCount:          { type: 'integer', description: 'Number of concentric rings. Defaults to the current or 5.' },
          showCardinals:      { type: 'boolean', description: 'Whether to draw N/E/S/W spokes. Defaults to the current or true.' }
        },
        required: []
      },
      previewRender(args) {
        const bits = []
        bits.push(atSummary(args))
        if (args.name                !== undefined) bits.push(`name:"${args.name}"`)
        if (args.ringIntervalMeters  !== undefined) bits.push(`${args.ringIntervalMeters} m`)
        if (args.ringCount           !== undefined) bits.push(`× ${args.ringCount}`)
        if (args.showCardinals === false)           bits.push('no cardinals')
        return `Set bullseye · ${bits.join(' · ')}`
      },
      async handler(args) {
        const res = resolveEndpoint(stores, {
          featureId:  args.atFeatureId,
          trackUid:   args.atTrackUid,
          vesselMmsi: args.atVesselMmsi,
          coordinate: args.atCoordinate
        }, 'at')
        if (!res.ok) return { error: res.error }

        const [lon, lat] = res.ep.coord
        const patch = { lat, lon }
        if (args.name               !== undefined) patch.name          = String(args.name)
        if (args.ringIntervalMeters !== undefined) {
          const r = Number(args.ringIntervalMeters)
          if (!Number.isFinite(r) || r <= 0) return { error: 'ringIntervalMeters must be a positive number.' }
          patch.ringInterval = r
        }
        if (args.ringCount          !== undefined) {
          const n = Number(args.ringCount)
          if (!Number.isInteger(n) || n <= 0) return { error: 'ringCount must be a positive integer.' }
          patch.ringCount = n
        }
        if (args.showCardinals      !== undefined) patch.showCardinals = Boolean(args.showCardinals)

        const next = bullseyeApi.setBullseye(patch)
        if (!next) return { error: 'Failed to set bullseye.' }
        return {
          success: true,
          lat: next.lat, lon: next.lon, name: next.name,
          ringIntervalMeters: next.ringInterval, ringCount: next.ringCount,
          showCardinals: next.showCardinals
        }
      }
    },

    {
      name: 'bullseye_update',
      description: 'Modify the existing bullseye. Any subset of fields may be changed: name, ring interval, ring count, cardinals, or position. To move the bullseye, provide exactly one of moveToFeatureId / moveToTrackUid / moveToVesselMmsi / moveToCoordinate. Omit all move fields to leave position unchanged. Errors if no bullseye is placed — use bullseye_set instead.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          name:               { type: 'string',  description: 'New label. Optional.' },
          ringIntervalMeters: { type: 'number',  description: 'New ring spacing in metres.' },
          ringCount:          { type: 'integer', description: 'New ring count.' },
          showCardinals:      { type: 'boolean', description: 'Toggle N/E/S/W spokes.' },
          moveToFeatureId:  { type: 'integer', description: 'Move to the centroid of this mission feature id.' },
          moveToTrackUid:   { type: 'string',  description: 'Move to the current position of this CoT track uid.' },
          moveToVesselMmsi: { type: 'string',  description: 'Move to the current position of this AIS vessel MMSI.' },
          moveToCoordinate: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2, maxItems: 2,
            description: 'Move to this raw [lon, lat] coordinate.'
          }
        },
        required: []
      },
      previewRender(args) {
        const parts = []
        if (args.name               !== undefined) parts.push(`name:"${args.name}"`)
        if (args.ringIntervalMeters !== undefined) parts.push(`${args.ringIntervalMeters} m`)
        if (args.ringCount          !== undefined) parts.push(`× ${args.ringCount}`)
        if (args.showCardinals      !== undefined) parts.push(`cardinals:${args.showCardinals ? 'on' : 'off'}`)
        const moveSpec = {
          atFeatureId:  args.moveToFeatureId,
          atTrackUid:   args.moveToTrackUid,
          atVesselMmsi: args.moveToVesselMmsi,
          atCoordinate: args.moveToCoordinate
        }
        const movingAny = [moveSpec.atFeatureId, moveSpec.atTrackUid, moveSpec.atVesselMmsi, moveSpec.atCoordinate]
          .some(v => v != null)
        if (movingAny) parts.push(`move→${atSummary(moveSpec)}`)
        return `Update bullseye · ${parts.join(' · ') || '(no-op)'}`
      },
      async handler(args) {
        if (!bullseyeApi.bullseye.value) return { error: 'No bullseye is placed. Use bullseye_set to create one.' }

        const patch = {}
        if (args.name               !== undefined) patch.name          = String(args.name)
        if (args.ringIntervalMeters !== undefined) {
          const r = Number(args.ringIntervalMeters)
          if (!Number.isFinite(r) || r <= 0) return { error: 'ringIntervalMeters must be a positive number.' }
          patch.ringInterval = r
        }
        if (args.ringCount          !== undefined) {
          const n = Number(args.ringCount)
          if (!Number.isInteger(n) || n <= 0) return { error: 'ringCount must be a positive integer.' }
          patch.ringCount = n
        }
        if (args.showCardinals      !== undefined) patch.showCardinals = Boolean(args.showCardinals)

        const moveFields = [args.moveToFeatureId, args.moveToTrackUid, args.moveToVesselMmsi, args.moveToCoordinate]
        const moveCount  = moveFields.filter(v => v != null).length
        if (moveCount > 1) {
          return { error: 'Provide at most one of moveToFeatureId, moveToTrackUid, moveToVesselMmsi, or moveToCoordinate.' }
        }
        if (moveCount === 1) {
          const res = resolveEndpoint(stores, {
            featureId:  args.moveToFeatureId,
            trackUid:   args.moveToTrackUid,
            vesselMmsi: args.moveToVesselMmsi,
            coordinate: args.moveToCoordinate
          }, 'moveTo')
          if (!res.ok) return { error: res.error }
          const [lon, lat] = res.ep.coord
          patch.lat = lat
          patch.lon = lon
        }

        if (Object.keys(patch).length === 0) {
          return { error: 'Provide at least one of name, ringIntervalMeters, ringCount, showCardinals, or a moveTo* field.' }
        }

        const next = bullseyeApi.updateBullseye(patch)
        if (!next) return { error: 'Failed to update bullseye.' }
        return {
          success: true,
          lat: next.lat, lon: next.lon, name: next.name,
          ringIntervalMeters: next.ringInterval, ringCount: next.ringCount,
          showCardinals: next.showCardinals
        }
      }
    },

    {
      name: 'bullseye_clear',
      description: 'Remove the active bullseye (rings + centre + labels). No-op if none is placed.',
      readonly: false,
      inputSchema: { type: 'object', properties: {}, required: [] },
      previewRender() {
        return 'Clear bullseye'
      },
      async handler() {
        bullseyeApi.clearBullseye()
        return { success: true }
      }
    }

  ]
}
