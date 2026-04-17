// Ghost-track assistant tools. A ghost is a simulated marker that walks a
// route at a fixed speed; the user can start / stop / reset it. See
// src/stores/ghosts.js.

function routesOnMap(featuresStore) {
  return featuresStore.features.filter(f => f.type === 'route')
}

function describeGhost(g, featuresStore) {
  const route = featuresStore.features.find(f => f.id === g.routeId)
  let routeName = 'Route'
  try {
    if (route) routeName = JSON.parse(route.properties).name ?? 'Route'
  } catch { /* ignore */ }
  return {
    id:                 g.id,
    name:               g.name,
    routeId:            g.routeId,
    routeName,
    status:             g.status,
    direction:          g.direction,
    speedMs:            g.speedMs,
    startWaypointIndex: g.startWaypointIndex,
    position:           [g.currentLon, g.currentLat]
  }
}

export function ghostTools({ featuresStore, ghostsStore }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'ghost_list',
      description: 'List all ghost tracks currently on the map with their route, status (idle or running), direction, and speed.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return ghostsStore.ghosts.map(g => describeGhost(g, featuresStore))
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'ghost_create',
      description: 'Create a ghost track that will simulate movement along an existing route. The ghost starts idle — call ghost_start to begin motion. If no routes exist on the map, this tool returns an error instructing the user to create a route first.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          routeId: {
            type: 'integer',
            description: 'Route feature id to follow. Required if more than one route exists; may be omitted when there is exactly one route.'
          },
          startWaypointIndex: {
            type: 'integer', minimum: 0,
            description: 'Zero-based waypoint index to start at. Defaults to 0 (the SP).'
          },
          direction: {
            type: 'string', enum: ['forward', 'backward'],
            description: 'Travel direction along the route. Defaults to "forward". If startWaypointIndex is 0 the direction is forced forward; if it is the final waypoint the direction is forced backward.'
          },
          speedMs: {
            type: 'number',
            description: 'Speed in meters per second. Convert from the user\'s units (1 kt = 0.5144 m/s, 1 km/h = 0.2778 m/s, 1 mph = 0.4470 m/s). Defaults to 5.144 m/s (10 kt).'
          }
        },
        required: []
      },
      previewRender({ routeId, startWaypointIndex, direction, speedMs }) {
        const route = routeId != null ? `route #${routeId}` : 'route (auto)'
        const parts = [`Ghost · ${route}`]
        if (startWaypointIndex != null) parts.push(`start @${startWaypointIndex}`)
        if (direction)                  parts.push(direction)
        if (speedMs != null)            parts.push(`${speedMs.toFixed(2)} m/s`)
        return parts.join(' · ')
      },
      async handler({ routeId, startWaypointIndex = 0, direction = 'forward', speedMs = 5.144 }) {
        const routes = routesOnMap(featuresStore)
        if (routes.length === 0) {
          return { error: 'No routes exist on the map. Create a route first, then create a ghost to follow it.' }
        }
        let targetRouteId = routeId
        if (targetRouteId == null) {
          if (routes.length !== 1) {
            return { error: `There are ${routes.length} routes on the map. Specify routeId — candidates: ${routes.map(r => `#${r.id}`).join(', ')}.` }
          }
          targetRouteId = routes[0].id
        } else if (!routes.some(r => r.id === targetRouteId)) {
          return { error: `Route ${targetRouteId} not found (or is not a route).` }
        }
        const id = ghostsStore.createGhost({
          routeId: targetRouteId,
          startWaypointIndex,
          direction,
          speedMs
        })
        if (id == null) return { error: `Could not create ghost — route ${targetRouteId} has fewer than 2 waypoints.` }
        return { success: true, id, routeId: targetRouteId }
      }
    },

    {
      name: 'ghost_start',
      description: 'Start (or resume) motion on an existing ghost track. The ghost walks its route until it reaches an endpoint or is stopped.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Ghost id from ghost_list.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Start ghost #${id}`
      },
      async handler({ id }) {
        if (!ghostsStore.ghosts.some(g => g.id === id)) return { error: `Ghost ${id} not found.` }
        ghostsStore.startGhost(id)
        return { success: true }
      }
    },

    {
      name: 'ghost_stop',
      description: 'Stop an existing ghost track in place. It remains on the map at its current position and can be started again later.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Ghost id from ghost_list.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Stop ghost #${id}`
      },
      async handler({ id }) {
        if (!ghostsStore.ghosts.some(g => g.id === id)) return { error: `Ghost ${id} not found.` }
        ghostsStore.stopGhost(id)
        return { success: true }
      }
    },

    {
      name: 'ghost_reset',
      description: 'Reset a ghost track back to its configured start waypoint. The ghost also becomes idle — call ghost_start afterward to resume motion.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Ghost id from ghost_list.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Reset ghost #${id}`
      },
      async handler({ id }) {
        if (!ghostsStore.ghosts.some(g => g.id === id)) return { error: `Ghost ${id} not found.` }
        ghostsStore.resetGhost(id)
        return { success: true }
      }
    },

    {
      name: 'ghost_delete',
      description: 'Permanently remove a ghost track from the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Ghost id from ghost_list.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Delete ghost #${id}`
      },
      async handler({ id }) {
        if (!ghostsStore.ghosts.some(g => g.id === id)) return { error: `Ghost ${id} not found.` }
        ghostsStore.deleteGhost(id)
        return { success: true }
      }
    },

    {
      name: 'ghost_set_speed',
      description: 'Change the speed of an existing ghost track. Takes effect immediately whether the ghost is running or idle.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id:      { type: 'integer', description: 'Ghost id from ghost_list.' },
          speedMs: { type: 'number', description: 'New speed in meters per second. Convert from the user\'s units (1 kt = 0.5144 m/s).' }
        },
        required: ['id', 'speedMs']
      },
      previewRender({ id, speedMs }) {
        return `Ghost #${id} · speed → ${speedMs.toFixed(2)} m/s`
      },
      async handler({ id, speedMs }) {
        if (!ghostsStore.ghosts.some(g => g.id === id)) return { error: `Ghost ${id} not found.` }
        ghostsStore.setSpeed(id, speedMs)
        return { success: true }
      }
    }

  ]
}
