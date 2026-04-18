import { resolveEndpoint } from '@/services/assistant/entityResolution'

// Annotations are operator-placed sticky notes pinned to map coordinates —
// free text, coloured, draggable. See docs/annotations.md for the full
// feature contract.
//
// Coordinates for new/updated annotations are resolved via the shared
// `resolveEndpoint` helper so the assistant can place a note on a raw
// coordinate, at the centroid of a mission feature, or on a live CoT track
// or AIS vessel. Only the instantaneous coordinate is used — annotations
// do not follow tracks the way perimeters do.

const DEFAULT_COLOR = '#ffeb3b'

const SWATCHES = [
  '#ffeb3b', '#ffb74d', '#f06292', '#e57373',
  '#81c784', '#64b5f6', '#ba68c8', '#e0e0e0'
]

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

function clipText(s, n = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function annotationTools({ featuresStore, tracksStore, aisStore, annotationsApi }) {
  const stores = { featuresStore, tracksStore, aisStore }

  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'annotation_list',
      description: 'List every annotation (sticky note) placed on the map for the active mission. Returns id, text, colour (hex), and coordinate (lat, lon) for each.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return annotationsApi.annotations.value.map(a => ({
          id: a.id,
          text: a.text,
          color: a.color,
          lat: a.lat,
          lon: a.lon
        }))
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'annotation_add',
      description: `Drop a new annotation (sticky note) on the map. Provide exactly one placement option: atFeatureId, atTrackUid, atVesselMmsi, or atCoordinate. For tracks/vessels, the annotation is placed at the track's current coordinate — it does NOT follow the track afterwards.\n\nIMPORTANT — resolving named placements: if the user references a target by name or callsign (e.g. "FARP 1", "USV-Alpha"), call \`map_find_entity\` FIRST to determine whether it maps to a feature, a CoT track, or an AIS vessel, then pass the matching field.\n\nThe colour is a hex string. Recommended palette matches the panel swatches: ${SWATCHES.join(', ')}. Any hex is accepted; defaults to ${DEFAULT_COLOR} if omitted.`,
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          ...AT_PROPS,
          text:  { type: 'string', description: 'Annotation body text (plain text, may contain line breaks).' },
          color: { type: 'string', description: `Hex colour (e.g. ${DEFAULT_COLOR}). Optional.` }
        },
        required: ['text']
      },
      previewRender(args) {
        const c = args.color ? ` · ${args.color}` : ''
        return `Annotation · ${atSummary(args)} · "${clipText(args.text)}"${c}`
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
        const text  = String(args.text ?? '').trim()
        if (!text) return { error: 'text must not be empty.' }
        const color = args.color || DEFAULT_COLOR

        const created = await annotationsApi.addAnnotation({ lat, lon, text, color })
        if (!created) return { error: 'Failed to add annotation (no active mission or database error).' }
        return { success: true, id: created.id, lat: created.lat, lon: created.lon, text: created.text, color: created.color }
      }
    },

    {
      name: 'annotation_update',
      description: 'Update an existing annotation by id. Any subset of fields may be changed in a single call: text, color, or position. To move the pin, provide exactly one of moveToFeatureId / moveToTrackUid / moveToVesselMmsi / moveToCoordinate — these are resolved the same way as for annotation_add. Omit all move fields to leave the position unchanged.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id:    { type: 'integer', description: 'Annotation id (from annotation_list).' },
          text:  { type: 'string',  description: 'New body text. Optional.' },
          color: { type: 'string',  description: 'New hex colour. Optional.' },
          moveToFeatureId:  { type: 'integer', description: 'Move the pin to the centroid of this mission feature id.' },
          moveToTrackUid:   { type: 'string',  description: 'Move the pin to the current position of this CoT track uid.' },
          moveToVesselMmsi: { type: 'string',  description: 'Move the pin to the current position of this AIS vessel MMSI.' },
          moveToCoordinate: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2, maxItems: 2,
            description: 'Move the pin to this raw [lon, lat] coordinate.'
          }
        },
        required: ['id']
      },
      previewRender(args) {
        const current = annotationsApi.annotations.value.find(x => x.id === args.id)
        const head = current
          ? `Update annotation #${args.id} ("${clipText(current.text)}")`
          : `Update annotation #${args.id}`
        const parts = []
        if (args.text  !== undefined) parts.push(`text:"${clipText(args.text)}"`)
        if (args.color !== undefined) parts.push(`color:${args.color}`)
        const moveSpec = {
          atFeatureId:  args.moveToFeatureId,
          atTrackUid:   args.moveToTrackUid,
          atVesselMmsi: args.moveToVesselMmsi,
          atCoordinate: args.moveToCoordinate
        }
        const movingAny = [moveSpec.atFeatureId, moveSpec.atTrackUid, moveSpec.atVesselMmsi, moveSpec.atCoordinate]
          .some(v => v != null)
        if (movingAny) parts.push(`move→${atSummary(moveSpec)}`)
        return `${head} · ${parts.join(' · ') || '(no-op)'}`
      },
      async handler(args) {
        const id = Number(args.id)
        if (!Number.isFinite(id)) return { error: 'id is required.' }
        if (!annotationsApi.annotations.value.some(a => a.id === id)) {
          return { error: `Annotation ${id} not found.` }
        }

        const patch = {}
        if (args.text  !== undefined) {
          const t = String(args.text).trim()
          if (!t) return { error: 'text must not be empty.' }
          patch.text = t
        }
        if (args.color !== undefined) patch.color = String(args.color)

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
          return { error: 'Provide at least one of text, color, or a moveTo* field.' }
        }

        const next = await annotationsApi.updateAnnotation(id, patch)
        if (!next) return { error: `Failed to update annotation ${id}.` }
        return { success: true, id: next.id, lat: next.lat, lon: next.lon, text: next.text, color: next.color }
      }
    },

    {
      name: 'annotation_delete',
      description: 'Delete a single annotation by id.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Annotation id (from annotation_list).' }
        },
        required: ['id']
      },
      previewRender(args) {
        const a = annotationsApi.annotations.value.find(x => x.id === args.id)
        const preview = a ? ` · "${clipText(a.text)}"` : ''
        return `Delete annotation #${args.id}${preview}`
      },
      async handler(args) {
        const id = Number(args.id)
        if (!Number.isFinite(id)) return { error: 'id is required.' }
        if (!annotationsApi.annotations.value.some(a => a.id === id)) {
          return { error: `Annotation ${id} not found.` }
        }
        await annotationsApi.removeAnnotation(id)
        return { success: true }
      }
    },

    {
      name: 'annotation_clear_all',
      description: 'Delete every annotation for the active mission at once. Use when the user says "clear annotations", "remove all notes", etc.',
      readonly: false,
      inputSchema: { type: 'object', properties: {}, required: [] },
      previewRender() {
        return 'Clear all annotations'
      },
      async handler() {
        await annotationsApi.clearAnnotations()
        return { success: true }
      }
    }

  ]
}
