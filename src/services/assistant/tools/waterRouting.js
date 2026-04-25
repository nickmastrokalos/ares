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
//                                         through named features, avoid
//                                         land, and/or avoid AIS vessel
//                                         projected paths (current
//                                         course/speed × horizon).

import { checkRouteCrossesLand, planWaterRoute, planRouteAvoidingObstacles, planRouteThroughVias } from '@/services/landRouting'
import { nameOrDefault } from '@/services/featureNaming'
import { geometryBounds, destinationPoint, circlePolygon, corridorPolygon } from '@/services/geometry'

// Knots → metres per second.
const KTS_TO_MPS = 1852 / 3600

// Below this speed, vessel is treated as stationary (point keepout instead
// of corridor). Avoids degenerate ~zero-length corridors and, more
// importantly, avoids drawing a corridor from a drifting vessel along the
// last reported (unreliable) heading.
const AIS_MIN_MOVING_KTS = 0.5

// Build an obstacle polygon for a single AIS vessel projected
// `horizonSeconds` forward along its current course/speed, with
// `standoffMeters` clearance on either side.
function vesselObstaclePolygon(vessel, horizonSeconds, standoffMeters) {
  const here = [vessel.longitude, vessel.latitude]
  const sog  = Number(vessel.SOG)
  const cog  = vessel.COG
  if (Number.isFinite(sog) && sog > AIS_MIN_MOVING_KTS && cog != null && cog >= 0) {
    const distance = sog * KTS_TO_MPS * horizonSeconds
    const there = destinationPoint(here, distance, cog)
    return corridorPolygon(here, there, standoffMeters)
  }
  return circlePolygon(here, standoffMeters)
}

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

export function waterRoutingTools({ featuresStore, aisStore }) {
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
      description: 'Plan and draw a route from `start` to `end` with any combination of constraints stacked: AVOID named features (`avoid_feature_ids`, e.g. keepout boxes), AVOID land (`avoid_land: true`), AVOID AIS vessel paths (`avoid_ais: true` — projects each vessel forward along its current course/speed and treats the swept corridor as an obstacle), and/or PASS THROUGH named features (`via_feature_ids`, e.g. "go through Polygon 1"). Each via feature contributes one intermediate waypoint at its center; legs are planned independently with the same avoidance constraints. Resolve named features to ids via `map_find_entity` first. Avoid/via features must be polygon-shaped (`polygon`, `box`, `circle`, `ellipse`, `sector`). For `avoid_ais`, you can override the projection horizon (`ais_horizon_minutes`, default 30) and clearance (`ais_standoff_meters`, default 1852 = 1 nm) when the user is explicit ("within 5 nm" → 9260 m, "for the next hour" → 60 min). Otherwise leave the defaults alone. PREFER THIS TOOL whenever the user names ANY area to avoid, ANY area to pass through, or asks to avoid land or AIS; fall back to `map_draw_route_water_only` only when none of those constraints apply.',
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
            description: 'Mission feature ids the route must pass through (in the order given). Each adds one intermediate waypoint at the feature\'s center. Use when the user says "through", "via", "stopping at", or similar.'
          },
          avoid_land: {
            type: 'boolean',
            description: 'Also avoid bundled coastline data (Natural Earth 10m). Set true when the user asks the route to stay over water / not cross land. Default false.'
          },
          avoid_ais: {
            type: 'boolean',
            description: 'Also avoid AIS vessel projected paths. Each vessel currently in `aisStore` is projected `ais_horizon_minutes` forward along its course (COG) and speed (SOG); the corridor of width `ais_standoff_meters` around that projection becomes an obstacle. Stationary vessels (SOG ≤ 0.5 kts or no COG) become a circular keepout at their current position. Default false.'
          },
          ais_horizon_minutes: {
            type: 'number',
            description: 'Projection horizon for AIS vessels in MINUTES. Default 30. Set when the user gives a time window ("for the next hour" → 60).'
          },
          ais_standoff_meters: {
            type: 'number',
            description: 'Clearance distance from each AIS vessel\'s projected path in METERS. Default 1852 (1 nm). Set when the user gives an explicit distance — convert: 1 nm = 1852 m, 1 mi = 1609.344 m, 1 km = 1000 m.'
          },
          buffer_meters: {
            type: 'number',
            description: 'Optional standoff distance from each AVOIDED user-feature obstacle in meters. Default 0 (route may hug obstacle edges). Has no effect on via features, land, or AIS — those have their own buffers.'
          },
          name:  { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the route. Otherwise OMIT — the system auto-generates a default like `route-a3f9`. Do NOT invent descriptive names from context.' },
          color: { type: 'string', description: 'Optional hex color. Defaults to white.' }
        },
        required: ['start', 'end']
      },
      previewRender({ start, end, avoid_feature_ids, via_feature_ids, avoid_land, avoid_ais, name }) {
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
        if (avoid_ais) parts.push('avoiding AIS')
        const what = parts.length ? parts.join(' · ') : 'direct'
        return `${label}Route · ${what} · ${fmt(start)} → ${fmt(end)}`
      },
      async handler({ start, end, avoid_feature_ids = [], via_feature_ids = [], avoid_land = false, avoid_ais = false, ais_horizon_minutes = 30, ais_standoff_meters = 1852, buffer_meters = 0, name, color = DEFAULT_FEATURE_COLOR }) {
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

        // Project AIS vessels into the obstacle list. Each moving vessel
        // becomes a corridor (current → projected position over the
        // horizon, ± standoff); stationary vessels become a circle.
        let aisObstacleCount = 0
        if (avoid_ais && aisStore?.vessels) {
          const horizonSeconds = Math.max(0, Number(ais_horizon_minutes) || 0) * 60
          const standoff = Math.max(0, Number(ais_standoff_meters) || 0)
          if (horizonSeconds > 0 && standoff > 0) {
            for (const vessel of aisStore.vessels.values()) {
              if (vessel.longitude == null || vessel.latitude == null) continue
              obstacles.push(vesselObstaclePolygon(vessel, horizonSeconds, standoff))
              aisObstacleCount++
            }
          }
        }

        if (obstacles.length === 0 && vias.length === 0 && !avoid_land) {
          return { error: 'Pass at least one of `avoid_feature_ids`, `via_feature_ids`, `avoid_land: true`, or `avoid_ais: true` — otherwise this is just a direct route and `map_draw_route` should be used instead.' }
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
          avoidedFeatureCount: avoid_feature_ids.length,
          viaFeatureCount: vias.length,
          avoidedLand: avoid_land,
          avoidedAisCount: aisObstacleCount
        }
      }
    }

  ]
}
