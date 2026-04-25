// Routing tools backed by the grid A* + bitmap planner in
// `src/services/landRouting.js`.
//
// `route_check_land_crossing`           — readonly: tests an existing route
//                                         against bundled coastline data.
// `map_draw_route_water_only`           — write: plans a polyline from start
//                                         to end that stays in water.
// `map_draw_route_avoiding_features`    — write: plans a polyline from start
//                                         to end that does not enter the
//                                         supplied user-drawn features
//                                         (keepouts, no-go boxes, etc.).

import { checkRouteCrossesLand, planWaterRoute, planRouteAvoidingObstacles } from '@/services/landRouting'

const DEFAULT_FEATURE_COLOR = '#ffffff'

function rebuildWaypointMeta(count) {
  return Array.from({ length: count }, (_, i) => {
    const isSp = i === 0
    const isEp = i === count - 1
    const role  = isSp ? 'SP' : isEp ? 'EP' : 'WP'
    const label = isSp ? 'SP' : isEp ? 'EP' : `WP ${i}`
    return { label, role }
  })
}

export function waterRoutingTools({ featuresStore }) {
  return [

    {
      name: 'route_check_land_crossing',
      description: 'Test whether an existing route\'s polyline crosses land. Uses Natural Earth 10m coastlines. Returns the index of the first leg (between waypoints i and i+1) that crosses land, or -1 if the route is fully over water.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Route feature id.' }
        },
        required: ['id']
      },
      async handler({ id }) {
        const row = featuresStore.features.find(f => f.id === id)
        if (!row) return { error: `Feature ${id} not found.` }
        if (row.type !== 'route') return { error: `Feature ${id} is type "${row.type}", not a route.` }
        const geom = JSON.parse(row.geometry)
        const result = await checkRouteCrossesLand(geom.coordinates ?? [])
        return { id, ...result }
      }
    },

    {
      name: 'map_draw_route_water_only',
      description: 'Plan a route from `start` to `end` that stays in water (no land crossings) and draw it on the map. Use this when the user explicitly asks to avoid land, asks for a maritime / naval / sea route, or when the start and end are clearly over water with land between them. The planner uses Natural Earth 10m coastlines (~1:10M scale) and grid A* with capped line-of-sight smoothing. RELIABLE for ocean-crossing and large-bay routes. AT COASTAL SCALES (routes shorter than ~5 km, or routes inside small bays / through narrow inlets / near barrier islands) the dataset is too coarse and the route may visibly clip land per the basemap. When start and end are within ~5 km of each other, briefly tell the user the result may not be accurate at this scale and suggest they either accept the rough plan, supply intermediate waypoints manually via `route_add_waypoint`, or use the regular `map_draw_route` and place waypoints themselves. If start or end is on land with no nearby water, returns an error instead of drawing.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Start [longitude, latitude].'
          },
          end: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'End [longitude, latitude].'
          },
          name:  { type: 'string', description: 'Optional route name. Defaults to "Water route".' },
          color: { type: 'string', description: 'Optional hex color. Defaults to white.' }
        },
        required: ['start', 'end']
      },
      previewRender({ start, end, name }) {
        const label = name ? `"${name}" · ` : ''
        const fmt = ([x, y]) => `${y.toFixed(4)}, ${x.toFixed(4)}`
        return `${label}Water route · ${fmt(start)} → ${fmt(end)}`
      },
      async handler({ start, end, name = 'Water route', color = DEFAULT_FEATURE_COLOR }) {
        const plan = await planWaterRoute(start, end)
        if (!plan.ok) return { error: plan.reason }
        const coords = plan.coordinates
        const geometry = { type: 'LineString', coordinates: coords }
        const properties = {
          name,
          color,
          waypoints: rebuildWaypointMeta(coords.length)
        }
        const id = await featuresStore.addFeature('route', geometry, properties)
        return {
          id,
          success: true,
          waypointCount: coords.length,
          lengthMeters: plan.lengthMeters
        }
      }
    },

    {
      name: 'map_draw_route_avoiding_features',
      description: 'Plan a route from `start` to `end` that does not enter the bounding shape of any feature in `avoid_feature_ids` (keepout boxes, no-go polygons / circles / sectors, etc.) and draw it on the map. Use this when the user asks to avoid one or more named areas. Resolve the names to IDs first via `map_find_entity`. The avoided features must be polygon-shaped — `polygon`, `box`, `circle`, `ellipse`, or `sector`. Other types (point, line, route, manual-track) cannot be used as obstacles and produce an error. Optional `buffer_meters` adds a standoff distance from each obstacle. NOTE: this tool does NOT also avoid land — combine with `map_draw_route_water_only` only as a sequential request if both are needed (rare).',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          start: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Start [longitude, latitude].'
          },
          end: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'End [longitude, latitude].'
          },
          avoid_feature_ids: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 1,
            description: 'Mission feature ids to treat as obstacles. Resolve names to ids via `map_find_entity` first.'
          },
          buffer_meters: {
            type: 'number',
            description: 'Optional standoff distance from each obstacle in meters. Default 0 (route may hug obstacle edges).'
          },
          name:  { type: 'string', description: 'Optional route name. Defaults to "Route".' },
          color: { type: 'string', description: 'Optional hex color. Defaults to white.' }
        },
        required: ['start', 'end', 'avoid_feature_ids']
      },
      previewRender({ start, end, avoid_feature_ids, name }) {
        const label = name ? `"${name}" · ` : ''
        const fmt = ([x, y]) => `${y.toFixed(4)}, ${x.toFixed(4)}`
        const obs = avoid_feature_ids.length === 1
          ? `1 obstacle`
          : `${avoid_feature_ids.length} obstacles`
        return `${label}Route avoiding ${obs} · ${fmt(start)} → ${fmt(end)}`
      },
      async handler({ start, end, avoid_feature_ids, buffer_meters = 0, name = 'Route', color = DEFAULT_FEATURE_COLOR }) {
        const obstacles = []
        for (const fid of avoid_feature_ids) {
          const row = featuresStore.features.find(f => f.id === fid)
          if (!row) return { error: `Feature ${fid} not found.` }
          const SUPPORTED = new Set(['polygon', 'box', 'circle', 'ellipse', 'sector'])
          if (!SUPPORTED.has(row.type)) {
            return { error: `Feature ${fid} is type "${row.type}"; only polygon / box / circle / ellipse / sector can be used as obstacles.` }
          }
          const geom = JSON.parse(row.geometry)
          if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
            return { error: `Feature ${fid} has unexpected geometry type "${geom.type}".` }
          }
          obstacles.push(geom)
        }
        // buffer_meters → degrees: planar 1° ≈ 111 km. Cheap conversion;
        // adequate for the buffer-as-standoff use case at coastal scales.
        const bufferDeg = (Number(buffer_meters) || 0) / 111000
        const plan = await planRouteAvoidingObstacles(start, end, obstacles, { bufferDeg })
        if (!plan.ok) return { error: plan.reason }
        const coords = plan.coordinates
        const geometry = { type: 'LineString', coordinates: coords }
        const properties = {
          name, color,
          waypoints: rebuildWaypointMeta(coords.length)
        }
        const id = await featuresStore.addFeature('route', geometry, properties)
        return {
          id,
          success: true,
          waypointCount: coords.length,
          lengthMeters: plan.lengthMeters,
          avoidedFeatureCount: obstacles.length
        }
      }
    }

  ]
}
