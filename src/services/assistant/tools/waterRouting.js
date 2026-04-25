// Routing tools backed by the grid A* + bitmap planner in
// `src/services/landRouting.js`.
//
// `route_check_land_crossing`           — readonly: tests an existing route
//                                         against bundled coastline data.
// `map_draw_route_water_only`           — write: plans a polyline from start
//                                         to end that stays in water.
// `map_draw_route_avoiding_features`    — write: plans a polyline from start
//                                         to end with stacked constraints —
//                                         avoid named features, pass
//                                         through named features (one
//                                         waypoint at each shape's center,
//                                         in order), and/or avoid land.

import { checkRouteCrossesLand, planWaterRoute, planRouteAvoidingObstacles, planRouteThroughVias } from '@/services/landRouting'
import { nameOrDefault } from '@/services/featureNaming'
import { geometryBounds } from '@/services/geometry'

// "Go through" point for a feature: most natural single waypoint that
// puts a route inside the shape. Circles / ellipses / sectors store
// their explicit center; boxes store sw/ne; polygons fall back to bbox
// midpoint. Bbox midpoint can lie outside very concave polygons (e.g.
// L-shapes) but works for every shape the avoid-features tool already
// accepts.
function shapeCenter(geometry, properties) {
  if (Array.isArray(properties?.center) && properties.center.length === 2) return properties.center
  if (Array.isArray(properties?.sw) && Array.isArray(properties?.ne)) {
    return [
      (properties.sw[0] + properties.ne[0]) / 2,
      (properties.sw[1] + properties.ne[1]) / 2
    ]
  }
  const bounds = geometryBounds(geometry)
  if (!bounds) return null
  const [[w, s], [e, n]] = bounds
  return [(w + e) / 2, (s + n) / 2]
}

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
          name:  { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the route in their request. Otherwise OMIT — the system auto-generates a default like `route-a3f9`. Do NOT invent descriptive names from context.' },
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
      description: 'Plan and draw a route from `start` to `end` with one or more constraints stacked: AVOID named features (`avoid_feature_ids`, e.g. keepout boxes / no-go polygons), AVOID land (`avoid_land: true`), and/or PASS THROUGH named features (`via_feature_ids`, e.g. "go through Polygon 1"). Each via feature contributes one intermediate waypoint at its center, in the order given, so the route reads SP → via₁ → via₂ → … → EP, with each leg avoiding the same obstacles. Resolve area names to ids first via `map_find_entity`. Both via and avoid features must be polygon-shaped — `polygon`, `box`, `circle`, `ellipse`, or `sector`. Other types (point, line, route, manual-track) produce an error. Optional `buffer_meters` adds a standoff distance from each AVOIDED user feature (no effect on via features or land — land has its own ~555 m coastline buffer). PREFER THIS TOOL whenever the user names ANY area to avoid OR pass through; only fall back to `map_draw_route_water_only` when there are no named areas at all.',
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
            description: 'Mission feature ids to treat as obstacles (route will not enter them). Resolve names to ids via `map_find_entity` first. Pass an empty array (or omit) if there are no named keepouts.'
          },
          via_feature_ids: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Mission feature ids the route must pass through (in the order given). Each adds one intermediate waypoint at the feature\'s center. Use when the user says "through", "via", "stopping at", or similar. Resolve names to ids via `map_find_entity` first.'
          },
          avoid_land: {
            type: 'boolean',
            description: 'Also avoid bundled coastline data (Natural Earth 10m). Set true when the user asks the route to stay over water / not cross land. Default false.'
          },
          buffer_meters: {
            type: 'number',
            description: 'Optional standoff distance from each AVOIDED user-feature obstacle in meters. Default 0 (route may hug obstacle edges). Has no effect on via features or land.'
          },
          name:  { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the route. Otherwise OMIT — the system auto-generates a default like `route-a3f9`. Do NOT invent descriptive names from context.' },
          color: { type: 'string', description: 'Optional hex color. Defaults to white.' }
        },
        required: ['start', 'end']
      },
      previewRender({ start, end, avoid_feature_ids, via_feature_ids, avoid_land, name }) {
        const label = name ? `"${name}" · ` : ''
        const fmt = ([x, y]) => `${y.toFixed(4)}, ${x.toFixed(4)}`
        const parts = []
        if (via_feature_ids?.length) {
          parts.push(via_feature_ids.length === 1 ? 'via 1 feature' : `via ${via_feature_ids.length} features`)
        }
        if (avoid_feature_ids?.length) {
          parts.push(avoid_feature_ids.length === 1 ? 'avoiding 1 obstacle' : `avoiding ${avoid_feature_ids.length} obstacles`)
        }
        if (avoid_land) parts.push('avoiding land')
        const what = parts.length ? parts.join(' · ') : 'direct'
        return `${label}Route · ${what} · ${fmt(start)} → ${fmt(end)}`
      },
      async handler({ start, end, avoid_feature_ids = [], via_feature_ids = [], avoid_land = false, buffer_meters = 0, name, color = DEFAULT_FEATURE_COLOR }) {
        const SUPPORTED = new Set(['polygon', 'box', 'circle', 'ellipse', 'sector'])

        function resolvePolygonFeature(fid, role) {
          const row = featuresStore.features.find(f => f.id === fid)
          if (!row) return { error: `Feature ${fid} (${role}) not found.` }
          if (!SUPPORTED.has(row.type)) {
            return { error: `Feature ${fid} (${role}) is type "${row.type}"; only polygon / box / circle / ellipse / sector are accepted.` }
          }
          const geom = JSON.parse(row.geometry)
          if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
            return { error: `Feature ${fid} (${role}) has unexpected geometry type "${geom.type}".` }
          }
          return { row, geom, props: JSON.parse(row.properties) }
        }

        const obstacles = []
        for (const fid of avoid_feature_ids) {
          const r = resolvePolygonFeature(fid, 'avoid')
          if (r.error) return { error: r.error }
          obstacles.push(r.geom)
        }

        const vias = []
        for (const fid of via_feature_ids) {
          const r = resolvePolygonFeature(fid, 'via')
          if (r.error) return { error: r.error }
          const c = shapeCenter(r.geom, r.props)
          if (!c) return { error: `Could not determine a center point for via feature ${fid}.` }
          vias.push(c)
        }

        if (obstacles.length === 0 && vias.length === 0 && !avoid_land) {
          return { error: 'Pass at least one of `avoid_feature_ids`, `via_feature_ids`, or `avoid_land: true` — otherwise this is just a direct route and `map_draw_route` should be used instead.' }
        }

        // buffer_meters → degrees: planar 1° ≈ 111 km.
        const bufferDeg = (Number(buffer_meters) || 0) / 111000
        const plan = vias.length
          ? await planRouteThroughVias(start, end, vias, obstacles, { bufferDeg, includeLand: avoid_land })
          : await planRouteAvoidingObstacles(start, end, obstacles, { bufferDeg, includeLand: avoid_land })
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
          viaFeatureCount: vias.length,
          avoidedLand: avoid_land
        }
      }
    }

  ]
}
