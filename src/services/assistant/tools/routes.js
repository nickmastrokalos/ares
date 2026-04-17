// Route-specific assistant tools.
//
// Rename, color, and delete go through the generic map_* tools in map.js
// (map_rename_feature, map_update_feature_color, map_delete_feature). The
// tools here cover waypoint mutation and remarks — fields that only exist
// on route features.

function parseRoute(row) {
  if (!row || row.type !== 'route') return null
  return {
    geometry:   JSON.parse(row.geometry),
    properties: JSON.parse(row.properties)
  }
}

// Waypoint labels follow the SP / WP N / EP convention in RoutePanel.
// Regenerate from scratch after any insert/delete so indices stay consistent.
function rebuildWaypointMeta(count) {
  return Array.from({ length: count }, (_, i) => {
    const isSp = i === 0
    const isEp = i === count - 1
    const role  = isSp ? 'SP' : isEp ? 'EP' : 'WP'
    const label = isSp ? 'SP' : isEp ? 'EP' : `WP ${i}`
    return { label, role }
  })
}

function findRoute(featuresStore, id) {
  const row = featuresStore.features.find(f => f.id === id)
  if (!row) return { error: `Feature ${id} not found.` }
  if (row.type !== 'route') return { error: `Feature ${id} is type "${row.type}", not a route.` }
  return { row, parsed: parseRoute(row) }
}

export function routeTools({ featuresStore }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'route_list',
      description: 'List all routes on the current mission with their waypoint counts.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return featuresStore.features
          .filter(f => f.type === 'route')
          .map(f => {
            const p = JSON.parse(f.properties)
            const g = JSON.parse(f.geometry)
            return {
              id: f.id,
              name: p.name ?? 'Route',
              color: p.color ?? '#ffffff',
              waypointCount: g?.coordinates?.length ?? 0,
              hasRemarks: Boolean((p.remarks ?? '').trim())
            }
          })
      }
    },

    {
      name: 'route_get',
      description: 'Get a route\'s full waypoint list (index, label, role, coordinate) and remarks.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Route feature id.' }
        },
        required: ['id']
      },
      async handler({ id }) {
        const found = findRoute(featuresStore, id)
        if (found.error) return { error: found.error }
        const { geometry, properties } = found.parsed
        const coords = geometry.coordinates
        const wps    = properties.waypoints ?? []
        const total  = coords.length
        const waypoints = coords.map((coord, i) => {
          const wp    = wps[i] ?? {}
          const label = wp.label ?? (i === 0 ? 'SP' : i === total - 1 ? 'EP' : `WP ${i}`)
          const role  = wp.role  ?? (i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP')
          return { index: i, label, role, coordinate: coord }
        })
        return {
          id,
          name:    properties.name    ?? 'Route',
          color:   properties.color   ?? '#ffffff',
          remarks: properties.remarks ?? '',
          waypoints
        }
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'route_add_waypoint',
      description: 'Insert a new waypoint into a route. Omit "index" to append at the end (becomes the new EP). Labels and roles are regenerated after the insert so SP / WP N / EP remain consistent.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Route feature id.' },
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'New waypoint [longitude, latitude].'
          },
          index: {
            type: 'integer', minimum: 0,
            description: 'Zero-based position to insert at. Omit to append at the end.'
          }
        },
        required: ['id', 'coordinate']
      },
      previewRender({ id, coordinate, index }) {
        const [lon, lat] = coordinate
        const where = index == null ? 'append' : `insert @${index}`
        return `Route #${id} · ${where} · ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      },
      async handler({ id, coordinate, index }) {
        const found = findRoute(featuresStore, id)
        if (found.error) return { error: found.error }
        const { row, parsed } = found
        const coords = [...parsed.geometry.coordinates]
        const at = index == null ? coords.length : Math.max(0, Math.min(index, coords.length))
        coords.splice(at, 0, coordinate)
        const nextProps = {
          ...parsed.properties,
          waypoints: rebuildWaypointMeta(coords.length)
        }
        await featuresStore.updateFeature(row.id, { type: 'LineString', coordinates: coords }, nextProps)
        return { success: true, waypointCount: coords.length }
      }
    },

    {
      name: 'route_delete_waypoint',
      description: 'Remove a waypoint from a route by zero-based index. A route must keep at least 2 waypoints — attempts to go below that are refused.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id:    { type: 'integer', description: 'Route feature id.' },
          index: { type: 'integer', minimum: 0, description: 'Zero-based waypoint index to remove.' }
        },
        required: ['id', 'index']
      },
      previewRender({ id, index }) {
        return `Route #${id} · delete waypoint @${index}`
      },
      async handler({ id, index }) {
        const found = findRoute(featuresStore, id)
        if (found.error) return { error: found.error }
        const { row, parsed } = found
        const coords = [...parsed.geometry.coordinates]
        if (index < 0 || index >= coords.length) {
          return { error: `Waypoint index ${index} is out of range (0..${coords.length - 1}).` }
        }
        if (coords.length <= 2) {
          return { error: 'Route must have at least 2 waypoints; cannot delete.' }
        }
        coords.splice(index, 1)
        const nextProps = {
          ...parsed.properties,
          waypoints: rebuildWaypointMeta(coords.length)
        }
        await featuresStore.updateFeature(row.id, { type: 'LineString', coordinates: coords }, nextProps)
        return { success: true, waypointCount: coords.length }
      }
    },

    {
      name: 'route_move_waypoint',
      description: 'Change the coordinate of an existing waypoint. Use this when the user wants to move a specific SP / EP / WP to a new location without rebuilding the whole route.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id:    { type: 'integer', description: 'Route feature id.' },
          index: { type: 'integer', minimum: 0, description: 'Zero-based waypoint index to move.' },
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'New [longitude, latitude] for that waypoint.'
          }
        },
        required: ['id', 'index', 'coordinate']
      },
      previewRender({ id, index, coordinate }) {
        const [lon, lat] = coordinate
        return `Route #${id} · move waypoint @${index} → ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      },
      async handler({ id, index, coordinate }) {
        const found = findRoute(featuresStore, id)
        if (found.error) return { error: found.error }
        const { row, parsed } = found
        const coords = [...parsed.geometry.coordinates]
        if (index < 0 || index >= coords.length) {
          return { error: `Waypoint index ${index} is out of range (0..${coords.length - 1}).` }
        }
        coords[index] = coordinate
        await featuresStore.updateFeature(row.id, { type: 'LineString', coordinates: coords }, parsed.properties)
        return { success: true }
      }
    },

    {
      name: 'route_set_remarks',
      description: 'Set, edit, or clear the remarks (free-text notes) on a route. Pass an empty string to clear.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id:      { type: 'integer', description: 'Route feature id.' },
          remarks: { type: 'string', description: 'New remarks text. Empty string clears.' }
        },
        required: ['id', 'remarks']
      },
      previewRender({ id, remarks }) {
        const snippet = remarks?.trim()
          ? `"${remarks.length > 40 ? remarks.slice(0, 40) + '…' : remarks}"`
          : '(clear)'
        return `Route #${id} · remarks → ${snippet}`
      },
      async handler({ id, remarks }) {
        const found = findRoute(featuresStore, id)
        if (found.error) return { error: found.error }
        await featuresStore.updateFeatureProperties(id, { remarks })
        return { success: true }
      }
    }

  ]
}
