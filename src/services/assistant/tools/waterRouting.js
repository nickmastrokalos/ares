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
import { nameOrDefault, rejectIfContextDerived } from '@/services/featureNaming'
import { geometryBounds, destinationPoint, circlePolygon, corridorPolygon, distanceBetween } from '@/services/geometry'

// Per-contributor cap for plugin-supplied obstacle polygons. The
// A* grid rasteriser cost grows linearly with polygon count; 200
// is high enough to capture realistic forecast clusters without
// blowing the plan-time budget. Excess polygons are dropped and
// the elision count surfaces back in `applied_avoidances` so the
// assistant can mention coarsening in its narrative.
const AVOID_EXTRAS_POLY_CAP = 200

// 5 % bbox padding around start + end + vias for plugin
// `getObstacles` calls. Matches the implicit corridor padding the
// existing planner already uses internally.
const AVOID_EXTRAS_BBOX_PAD = 0.05

// Knots → metres per second.
const KTS_TO_MPS = 1852 / 3600

// Below this speed, vessel is treated as stationary (point keepout instead
// of corridor). Avoids degenerate ~zero-length corridors and, more
// importantly, avoids drawing a corridor from a drifting vessel along the
// last reported (unreliable) heading.
const AIS_MIN_MOVING_KTS = 0.5

// Build the obstacle polygons for a single AIS vessel. Every vessel
// gets a circular keepout at its current position (radius =
// `standoffMeters`) so a route can't pass within that distance of the
// vessel regardless of approach angle. Moving vessels additionally
// get a swept-corridor rectangle extending `horizonSeconds` forward
// along their current COG, capturing where they're going.
//
// (The corridor alone isn't sufficient: it only covers points ahead
// of the vessel along its track, leaving the area immediately port /
// starboard of the current position outside its bounds. A route
// approaching from abeam could then thread between the corridor and
// the vessel itself. The current-position circle closes that gap.)
function vesselObstaclePolygons(vessel, horizonSeconds, standoffMeters) {
  const here = [vessel.longitude, vessel.latitude]
  const polygons = [circlePolygon(here, standoffMeters)]
  const sog = Number(vessel.SOG)
  const cog = vessel.COG
  if (Number.isFinite(sog) && sog > AIS_MIN_MOVING_KTS && cog != null && cog >= 0) {
    const distance = sog * KTS_TO_MPS * horizonSeconds
    const there = destinationPoint(here, distance, cog)
    polygons.push(corridorPolygon(here, there, standoffMeters))
  }
  return polygons
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

// Resolve a `depart_at_iso` value (ISO 8601 string or 'now') to a
// JS Date. Returns null on a malformed string so the caller can
// reject with a clean error.
function resolveDepartAt(iso) {
  if (!iso || iso === 'now') return new Date()
  const t = Date.parse(String(iso))
  return Number.isFinite(t) ? new Date(t) : null
}

/**
 * Given a planned polyline and trip kinematics (departure time
 * + speed in knots), produce per-vertex ETAs as ISO strings and
 * cumulative metres travelled. Used to anchor environmental
 * forecasts to the time the craft will actually be at each
 * waypoint instead of a single fixed horizon.
 */
function computeLegEtas(coords, departAt, speedKts) {
  if (!Array.isArray(coords) || coords.length === 0) return []
  const speedMs = speedKts * KTS_TO_MPS
  const out = [{ etaIso: departAt.toISOString(), metersFromStart: 0 }]
  let acc = 0
  for (let i = 1; i < coords.length; i++) {
    acc += distanceBetween(coords[i - 1], coords[i])
    const seconds = speedMs > 0 ? acc / speedMs : 0
    out.push({
      etaIso: new Date(departAt.getTime() + seconds * 1000).toISOString(),
      metersFromStart: acc
    })
  }
  return out
}

/**
 * Bounding box of every waypoint we know about (start, end, vias)
 * plus a 5 % pad on each side. Used to scope plugin
 * `getObstacles` calls — they sample inside this rectangle.
 */
function corridorBbox(points) {
  let west  = Infinity, south = Infinity
  let east  = -Infinity, north = -Infinity
  for (const [lon, lat] of points) {
    if (lon < west)  west  = lon
    if (lon > east)  east  = lon
    if (lat < south) south = lat
    if (lat > north) north = lat
  }
  if (!Number.isFinite(west)) return null
  const padX = (east - west)  * AVOID_EXTRAS_BBOX_PAD || 0.01
  const padY = (north - south) * AVOID_EXTRAS_BBOX_PAD || 0.01
  return [west - padX, south - padY, east + padX, north + padY]
}

export function waterRoutingTools({ featuresStore, aisStore, routingRegistry }) {
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
        const reject = rejectIfContextDerived(name); if (reject) return reject
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
      description: 'Plan AND IMMEDIATELY DRAW a route from `start` to `end` with any combination of constraints stacked: AVOID named features (`avoid_feature_ids`, e.g. keepout boxes), AVOID land (`avoid_land: true`), AVOID AIS vessel paths (`avoid_ais: true` — projects each vessel forward along its current course/speed and treats the swept corridor as an obstacle), AVOID environmental constraints contributed by plugins (`avoid_extras` — see below), and/or PASS THROUGH named features (`via_feature_ids`, e.g. "go through Polygon 1"). On success this tool ADDS THE ROUTE TO THE MAP as a feature in one step — there is NO separate "show / display" step. Narrate the result in past tense ("I drew the route…"); do NOT ask the user "would you like me to display this on the map?" — it is already there. Each via feature contributes one intermediate waypoint at its center; legs are planned independently with the same avoidance constraints. Resolve named features to ids via `map_find_entity` first. Avoid/via features must be polygon-shaped (`polygon`, `box`, `circle`, `ellipse`, `sector`). For `avoid_ais`, you can override the projection horizon (`ais_horizon_minutes`, default 30) and clearance (`ais_standoff_meters`, default 1852 = 1 nm) when the user is explicit ("within 5 nm" → 9260 m, "for the next hour" → 60 min). Otherwise leave the defaults alone. For environmental constraints (cloud cover, sea state, currents, surface tracks, etc.) call `routing_list_avoidances` FIRST to discover the available contributors and their params, then pass them as `avoid_extras` (e.g. `{ "cloud-cover": { "threshold_pct": 60, "hours_ahead": 7 } }`). When `speed_kts` is supplied, the planner returns per-vertex ETAs you can feed into `route_evaluate_along` for forecast questions like "what\'s the cloud cover at each waypoint when I get there?". PREFER THIS TOOL whenever the user names ANY area to avoid, ANY area to pass through, or asks to avoid land / AIS / any environmental constraint; fall back to `map_draw_route_water_only` only when none of those constraints apply.',
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
            description: 'Also avoid AIS vessels. Every vessel currently in `aisStore` gets a circular keepout of radius `ais_standoff_meters` at its present position (so the route cannot pass within that distance regardless of approach angle); moving vessels (SOG > ~0.5 kts) additionally get a swept corridor of the same half-width extending `ais_horizon_minutes` forward along their COG. Default false.'
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
            description: 'Optional standoff distance from each AVOIDED user-feature obstacle in meters. Default 0 (route may hug obstacle edges). Has no effect on via features, land, AIS, or `avoid_extras` contributors — those have their own buffers / params.'
          },
          avoid_extras: {
            type: 'object',
            additionalProperties: true,
            description: 'Plugin-contributed environmental avoidances, keyed by avoidance id. Each value is the params object that contributor accepts (call `routing_list_avoidances` to discover available ids and their `paramsSchema`). Example: `{ "cloud-cover": { "hours_ahead": 7, "threshold_pct": 60 }, "tracks": { "standoff_meters": 500 } }`. Each contributor returns obstacle polygons that get merged into the planner\'s obstacle list. Contributor polygon counts are capped per call — the response\'s `applied_avoidances` reports any elision so you can mention coarsening in your narrative.'
          },
          depart_at_iso: {
            type: 'string',
            description: 'ISO 8601 departure timestamp, or "now". Optional — only used when `speed_kts` is also set. Drives per-vertex ETA computation along the planned polyline.'
          },
          speed_kts: {
            type: 'number',
            description: 'Average speed-over-ground in knots. Optional but RECOMMENDED whenever environmental constraints (`avoid_extras`) are involved or the user mentions a speed / arrival time. When set, the route\'s `properties.waypoints` carry per-vertex ETAs that `route_evaluate_along` can feed back to forecast evaluators. Pass the user\'s stated speed or the platform\'s declared cruise; do not silently default — ask the user if uncertain.'
          },
          name:  { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the route in their request (e.g. "call it the Bravo run"). Otherwise OMIT this field — the system auto-generates a default like `route-a3f9`. Do NOT invent descriptive names from context — anything that mentions coordinates, MGRS prefixes, departure times, mission state, or constraint summaries is wrong. Bad examples to AVOID: "Night route 40R BN to 40R DQ", "Sea-state route at 25 kts", "Route avoiding land". Just OMIT `name` for all of those.' },
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
      async handler({ start, end, avoid_feature_ids = [], via_feature_ids = [], avoid_land = false, avoid_ais = false, ais_horizon_minutes = 30, ais_standoff_meters = 1852, buffer_meters = 0, avoid_extras = null, depart_at_iso, speed_kts, name, color = DEFAULT_FEATURE_COLOR }) {
        const reject = rejectIfContextDerived(name); if (reject) return reject
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

        // Project AIS vessels into the obstacle list. Every vessel gets
        // a circular keepout at its current position (radius = standoff);
        // moving vessels additionally get a swept-corridor rectangle
        // extending `horizonSeconds` forward along their COG.
        let aisVesselCount = 0
        if (avoid_ais && aisStore?.vessels) {
          const horizonSeconds = Math.max(0, Number(ais_horizon_minutes) || 0) * 60
          const standoff = Math.max(0, Number(ais_standoff_meters) || 0)
          if (horizonSeconds > 0 && standoff > 0) {
            for (const vessel of aisStore.vessels.values()) {
              if (vessel.longitude == null || vessel.latitude == null) continue
              obstacles.push(...vesselObstaclePolygons(vessel, horizonSeconds, standoff))
              aisVesselCount++
            }
          }
        }

        // Plugin-contributed environmental avoidances. Each entry
        // in `avoid_extras` keys an avoidance contributor by id;
        // we look it up in the routing registry, call its
        // `getObstacles({ bbox, params })`, and merge the
        // resulting polygons into the obstacle list. Per-
        // contributor cap of AVOID_EXTRAS_POLY_CAP polygons keeps
        // the planner cost bounded; elision is reported back so
        // the assistant can mention it.
        const appliedAvoidances = []
        if (avoid_extras && typeof avoid_extras === 'object' && routingRegistry) {
          const bbox = corridorBbox([start, end, ...vias])
          for (const [extraId, rawParams] of Object.entries(avoid_extras)) {
            const entry = routingRegistry.getAvoidance(extraId)
            if (!entry) {
              const declared = routingRegistry.findDeclaredAvoidance?.(extraId)
              if (declared) {
                if (declared.reason === 'plugin_incompatible') {
                  return { error: `Avoidance "${extraId}" is provided by the "${declared.requires_plugin_name}" plugin, which is incompatible with the current host version. Upgrade Ares to the version the plugin requires, then re-call this tool.` }
                }
                return { error: `Avoidance "${extraId}" is currently disabled. It's provided by the "${declared.requires_plugin_name}" plugin — enable it in Settings → Plugins, then re-call this tool.` }
              }
              const known = routingRegistry.listAvoidances().enabled.map(a => a.id).join(', ')
              return { error: `Unknown avoidance id "${extraId}". Currently enabled ids: ${known || '(none registered)'}. Call routing_list_avoidances to see disabled-but-available contributors.` }
            }
            const params = (rawParams && typeof rawParams === 'object') ? rawParams : {}
            let raw
            try {
              raw = await entry.getObstacles({ bbox, params })
            } catch (err) {
              return { error: `Avoidance "${extraId}" failed: ${err?.message ?? err}` }
            }
            const polys  = Array.isArray(raw) ? raw : []
            const kept   = polys.slice(0, AVOID_EXTRAS_POLY_CAP)
            const elided = Math.max(0, polys.length - kept.length)
            obstacles.push(...kept)
            appliedAvoidances.push({
              id:            extraId,
              polygon_count: kept.length,
              elided,
              params
            })
          }
        }

        if (obstacles.length === 0 && vias.length === 0 && !avoid_land) {
          return { error: 'Pass at least one of `avoid_feature_ids`, `via_feature_ids`, `avoid_land: true`, `avoid_ais: true`, or an entry in `avoid_extras` — otherwise this is just a direct route and `map_draw_route` should be used instead.' }
        }

        // buffer_meters → degrees: planar 1° ≈ 111 km.
        const bufferDeg = (Number(buffer_meters) || 0) / 111000
        const plan = vias.length
          ? await planRouteThroughVias(start, end, vias, obstacles, { bufferDeg, includeLand: avoid_land })
          : await planRouteAvoidingObstacles(start, end, obstacles, { bufferDeg, includeLand: avoid_land })
        if (!plan.ok) return { error: plan.reason }
        const coords = plan.coordinates
        const geometry = { type: 'LineString', coordinates: coords }

        // Per-vertex ETAs when the operator/assistant supplied a
        // speed. The waypoint-meta array carries them so
        // `route_evaluate_along` can re-derive without needing
        // depart/speed re-passed.
        const waypointMeta = rebuildWaypointMeta(coords.length)
        let etaInfo = null
        if (Number.isFinite(speed_kts) && speed_kts > 0) {
          const departAt = resolveDepartAt(depart_at_iso ?? 'now')
          if (!departAt) {
            return { error: `Could not parse depart_at_iso "${depart_at_iso}". Use ISO 8601 or "now".` }
          }
          const etas = computeLegEtas(coords, departAt, speed_kts)
          etas.forEach((leg, i) => { waypointMeta[i].etaIso = leg.etaIso })
          etaInfo = {
            depart_at_iso: departAt.toISOString(),
            speed_kts,
            arrive_at_iso: etas[etas.length - 1]?.etaIso ?? null
          }
        }

        const properties = {
          name: nameOrDefault(name, 'route', featuresStore),
          color,
          waypoints: waypointMeta,
          ...(etaInfo ? { route_etas: etaInfo } : {})
        }
        const id = await featuresStore.addFeature('route', geometry, properties)
        return {
          id,
          success: true,
          drawn: true,
          note: `Route drawn on the map as feature ${id}. No further action needed to display it. Describe the result in past tense.`,
          waypointCount: coords.length,
          lengthMeters: plan.lengthMeters,
          avoidedFeatureCount: avoid_feature_ids.length,
          viaFeatureCount: vias.length,
          avoidedLand: avoid_land,
          avoidedAisVesselCount: aisVesselCount,
          applied_avoidances: appliedAvoidances,
          ...(etaInfo ? { etas: etaInfo } : {})
        }
      }
    },

    {
      name: 'routing_list_avoidances',
      description: 'List every avoidance contributor known to the route planner. Returns `{ enabled, disabled }`. `enabled` contains live contributors with their `id`, `label`, `description`, `ownerPluginId` (or null for host-built-ins), and `paramsSchema`. `disabled` contains contributors a plugin DECLARED via its manifest `provides` block but isn\'t live right now — each entry carries the requiring plugin id / name plus a `reason` (`plugin_disabled`, `plugin_incompatible`, …). When the user asks for a constraint that\'s only in `disabled`, tell them which plugin to enable in Settings → Plugins and DO NOT plan the route — wait for the user to enable it and re-ask.',
      readonly: true,
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const result = routingRegistry?.listAvoidances?.()
        return result ?? { enabled: [], disabled: [] }
      }
    },

    {
      name: 'routing_list_evaluators',
      description: 'List every point-sampling evaluator known to the route planner. Returns `{ enabled, disabled }`. `enabled` contains live evaluators with `id`, `label`, `description`, `ownerPluginId`, and `paramsSchema`. `disabled` contains evaluators a plugin DECLARED but isn\'t live, with the requiring plugin name and `reason`. Use enabled ids with `route_evaluate_along` for forecast-along-the-route questions; for disabled ids, tell the user which plugin to enable.',
      readonly: true,
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const result = routingRegistry?.listEvaluators?.()
        return result ?? { enabled: [], disabled: [] }
      }
    },

    {
      name: 'route_evaluate_along',
      description: 'Walk an existing route\'s waypoints and call a registered evaluator at each one, anchored to that waypoint\'s ETA. Returns a per-waypoint array of `{ index, lat, lon, etaIso, value, unit }`. Pre-requisite: the route must have been planned with `speed_kts` so its waypoints carry ETAs. Discover available evaluator ids via `routing_list_evaluators`. Example use: "what\'s the cloud cover at each waypoint of my route when I get there?".',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          route_id:     { type: 'integer', description: 'Mission feature id of the route (returned by `map_draw_route_avoiding_features`).' },
          evaluator_id: { type: 'string',  description: 'Id of a registered evaluator (see `routing_list_evaluators`).' },
          params:       { type: 'object', additionalProperties: true, description: 'Optional params passed to the evaluator. Validate against the evaluator\'s `paramsSchema`.' }
        },
        required: ['route_id', 'evaluator_id']
      },
      async handler({ route_id, evaluator_id, params = {} }) {
        const row = featuresStore.features.find(f => f.id === route_id)
        if (!row) return { error: `Feature ${route_id} not found.` }
        if (row.type !== 'route') return { error: `Feature ${route_id} is type "${row.type}", not a route.` }
        const evaluator = routingRegistry?.getEvaluator?.(evaluator_id)
        if (!evaluator) {
          const declared = routingRegistry?.findDeclaredEvaluator?.(evaluator_id)
          if (declared) {
            if (declared.reason === 'plugin_incompatible') {
              return { error: `Evaluator "${evaluator_id}" is provided by the "${declared.requires_plugin_name}" plugin, which is incompatible with the current host version. Upgrade Ares to the version the plugin requires, then re-call this tool.` }
            }
            return { error: `Evaluator "${evaluator_id}" is currently disabled. It's provided by the "${declared.requires_plugin_name}" plugin — enable it in Settings → Plugins, then re-call this tool.` }
          }
          const known = (routingRegistry?.listEvaluators?.()?.enabled ?? []).map(e => e.id).join(', ')
          return { error: `Unknown evaluator id "${evaluator_id}". Currently enabled ids: ${known || '(none registered)'}. Call routing_list_evaluators to see disabled-but-available evaluators.` }
        }
        let geometry, properties
        try {
          geometry   = JSON.parse(row.geometry)
          properties = JSON.parse(row.properties)
        } catch {
          return { error: `Route ${route_id} has malformed geometry / properties.` }
        }
        const coords = geometry?.coordinates ?? []
        const wpMeta = Array.isArray(properties?.waypoints) ? properties.waypoints : []
        const samples = []
        for (let i = 0; i < coords.length; i++) {
          const [lon, lat] = coords[i]
          const etaIso = wpMeta[i]?.etaIso ?? null
          if (!etaIso) {
            return { error: `Route ${route_id} has no ETAs (was it planned with speed_kts?). Re-plan with a speed to get per-waypoint ETAs before calling this tool.` }
          }
          let result
          try {
            result = await evaluator.sampleAt({ lat, lon, atIso: etaIso, params })
          } catch (err) {
            return { error: `Evaluator "${evaluator_id}" threw at waypoint ${i}: ${err?.message ?? err}` }
          }
          samples.push({
            index:  i,
            lat,
            lon,
            etaIso,
            value: result?.value ?? null,
            unit:  result?.unit  ?? null
          })
        }
        return { route_id, evaluator_id, samples }
      }
    }

  ]
}
