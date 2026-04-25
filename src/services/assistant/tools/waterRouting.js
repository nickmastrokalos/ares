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
import { nameOrDefault } from '@/services/featureNaming'

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
      description: 'Plan a route from `start` to `end` that stays in water (no land crossings) and draw it on the map. Use this ONLY when the user wants to avoid land and has not named any specific areas / keepouts to avoid. If they have ALSO named one or more areas (polygon, box, etc.), use `map_draw_route_avoiding_features` instead with `avoid_land: true` so both constraints are honored in one call. The planner uses Natural Earth 10m coastlines (~1:10M scale) and grid A*. RELIABLE for ocean-crossing and large-bay routes. AT COASTAL SCALES (routes shorter than ~5 km, or routes inside small bays / through narrow inlets / near barrier islands) the dataset is too coarse and the route may visibly clip land per the basemap. When start and end are within ~5 km of each other, briefly tell the user the result may not be accurate at this scale and suggest they either accept the rough plan, supply intermediate waypoints manually via `route_add_waypoint`, or use the regular `map_draw_route` and place waypoints themselves. If start or end is on land with no nearby water, returns an error instead of drawing.',
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
      async handler({ start, end, name, color = DEFAULT_FEATURE_COLOR }) {
        const plan = await planWaterRoute(start, end)
        if (!plan.ok) return { error: plan.reason }
        const coords = plan.coordinates
        const geometry = { type: 'LineString', coordinates: coords }
        const properties = {
          name: nameOrDefault(name, 'route', featuresStore),
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
      description: 'Plan a route from `start` to `end` that does not enter the bounding shape of any feature in `avoid_feature_ids` (keepout boxes, no-go polygons / circles / sectors, etc.) AND optionally also stays off land, then draw it on the map. Use this whenever the user asks to avoid one or more named areas — and set `avoid_land: true` if they also ask the route to stay over water / not cross land. Resolve area names to ids first via `map_find_entity`. The avoided features must be polygon-shaped — `polygon`, `box`, `circle`, `ellipse`, or `sector`. Other types (point, line, route, manual-track) cannot be used as obstacles and produce an error. Optional `buffer_meters` adds a standoff distance from each user obstacle. PREFER THIS TOOL OVER `map_draw_route_water_only` whenever the user has named a specific area to avoid, even if they also ask to avoid land — set both `avoid_feature_ids` and `avoid_land: true` in a single call. Use `map_draw_route_water_only` only when there are no named areas to avoid.',
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
            description: 'Mission feature ids to treat as obstacles. Resolve names to ids via `map_find_entity` first. Pass an empty array if avoiding land only (and prefer `map_draw_route_water_only` in that case).'
          },
          avoid_land: {
            type: 'boolean',
            description: 'Also avoid bundled coastline data (Natural Earth 10m). Set true when the user asks to stay over water / not cross land. Default false.'
          },
          buffer_meters: {
            type: 'number',
            description: 'Optional standoff distance from each user-feature obstacle in meters. Default 0 (route may hug obstacle edges). Land polygons get their own ~555 m coastline buffer regardless of this.'
          },
          name:  { type: 'string', description: 'Optional route name. Defaults to "Route".' },
          color: { type: 'string', description: 'Optional hex color. Defaults to white.' }
        },
        required: ['start', 'end', 'avoid_feature_ids']
      },
      previewRender({ start, end, avoid_feature_ids, avoid_land, name }) {
        const label = name ? `"${name}" · ` : ''
        const fmt = ([x, y]) => `${y.toFixed(4)}, ${x.toFixed(4)}`
        const parts = []
        if (avoid_feature_ids?.length) {
          parts.push(avoid_feature_ids.length === 1 ? '1 obstacle' : `${avoid_feature_ids.length} obstacles`)
        }
        if (avoid_land) parts.push('land')
        const what = parts.length ? `avoiding ${parts.join(' + ')}` : ''
        return `${label}Route ${what} · ${fmt(start)} → ${fmt(end)}`
      },
      async handler({ start, end, avoid_feature_ids = [], avoid_land = false, buffer_meters = 0, name, color = DEFAULT_FEATURE_COLOR }) {
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
        if (obstacles.length === 0 && !avoid_land) {
          return { error: 'Pass at least one feature id in `avoid_feature_ids`, or set `avoid_land: true`.' }
        }
        // buffer_meters → degrees: planar 1° ≈ 111 km. Adequate at coastal
        // scales for the buffer-as-standoff use case.
        const bufferDeg = (Number(buffer_meters) || 0) / 111000
        const plan = await planRouteAvoidingObstacles(start, end, obstacles, { bufferDeg, includeLand: avoid_land })
        if (!plan.ok) return { error: plan.reason }
        const coords = plan.coordinates
        const geometry = { type: 'LineString', coordinates: coords }
        const properties = {
          name: nameOrDefault(name, 'route', featuresStore),
          color,
          waypoints: rebuildWaypointMeta(coords.length)
        }
        const id = await featuresStore.addFeature('route', geometry, properties)
        return {
          id,
          success: true,
          waypointCount: coords.length,
          lengthMeters: plan.lengthMeters,
          avoidedFeatureCount: obstacles.length,
          avoidedLand: avoid_land
        }
      }
    }

  ]
}
