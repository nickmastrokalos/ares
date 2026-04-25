import {
  circlePolygon,
  ellipsePolygon,
  sectorPolygon,
  rotatedBoxPolygon,
  destinationPoint,
  distanceBetween,
  bearingBetween,
  geometryBounds,
  pointInPolygon,
} from '@/services/geometry'
import { DEFAULT_FEATURE_COLOR } from '@/stores/features'
import { parseCoordinate } from '@/services/coordinates'
import { BASEMAPS } from '@/services/basemaps'
import { nameOrDefault } from '@/services/featureNaming'

// Mirrors the track builder UI (ManualTrackPanel / useMapManualTracks).
const AFFIL_ENUM   = ['friendly', 'hostile', 'civilian', 'unknown']
const AFFIL_MAP    = { friendly: 'f', hostile: 'h', civilian: 'n', unknown: 'u' }
const DEFAULT_AFFIL_CODE = 'f'

// Mirrors TRACK_TYPE_CATALOG in src/services/trackTypes.js.
const ENTITY_SUFFIX = {
  // Ground
  ground:            'G',
  infantry:          'G-U-C-I',
  armor:             'G-U-C-A',
  artillery:         'G-U-C-F',
  engineer:          'G-U-C-E',
  recon:             'G-U-C-R',
  hq:                'G-U-H',
  support:           'G-U-S',
  unmanned_ground:   'G-U-C-V-U',
  // Air
  air:               'A',
  fixed_wing:        'A-M-F',
  uav:               'A-M-F-Q',
  helicopter:        'A-M-H',
  attack_helicopter: 'A-M-H-H',
  // Sea
  surface:           'S',
  combatant:         'S-C',
  unmanned_surface:  'S-C-U',
  submarine:         'U',
  // SOF
  sof:               'F',
}
const ENTITY_ENUM = Object.keys(ENTITY_SUFFIX)

// Inverse of AFFIL_MAP — converts the single-letter code stored on a track
// back into the word the agent reasons with ("friendly", "hostile", …).
const AFFIL_WORD = Object.fromEntries(Object.entries(AFFIL_MAP).map(([w, c]) => [c, w]))

export function mapTools({ featuresStore, tracksStore, aisStore, settingsStore, flyToGeometry, flyTo, switchBasemap }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'map_get_mission_info',
      description: 'Get the name of the active mission and a count of its features.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        const m = featuresStore.activeMission
        return {
          missionId: featuresStore.activeMissionId,
          missionName: m?.name ?? null,
          featureCount: featuresStore.features.length
        }
      }
    },

    {
      name: 'map_list_features',
      description: 'List mission-owned features on the map — shapes, routes, points, and MANUAL tracks. Manual tracks expose "affiliation" (friendly / hostile / civilian / unknown). IMPORTANT: this does NOT include live CoT tracks received from listeners (call cot_list_tracks) and does NOT include AIS vessels (call ais_list_vessels). When the user refers to an entity by NAME or CALLSIGN and you are not certain which source owns it, DO NOT guess — call `map_find_entity` instead, which searches all three sources at once. When the user says "tracks" without qualification, consider consulting both this tool and cot_list_tracks. For containment questions ("what is inside the box?"), prefer map_features_in_area, which checks both sources in one call.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return featuresStore.features.map(f => {
          const props = JSON.parse(f.properties)
          const summary = {
            id: f.id,
            type: f.type,
            name: props.name ?? props.callsign ?? f.type,
            color: props.color ?? DEFAULT_FEATURE_COLOR
          }
          if (f.type === 'manual-track') {
            summary.affiliation = AFFIL_WORD[props.affiliation] ?? 'unknown'
            if (props.cotType) summary.cotType = props.cotType
          }
          return summary
        })
      }
    },

    {
      name: 'map_find_entity',
      description: 'Resolve a name or identifier to a concrete on-map entity across ALL live sources in one call — CoT tracks (from listeners), AIS vessels, and mission features (shapes, routes, manual tracks, points). ALWAYS call this FIRST whenever the user references something by name or callsign (e.g. "USV-Alpha", "Oceanus V", "FRND-1") before feeding an id into any other tool (bloodhound_add, map_measure_distance, map_fly_to_feature, map_move_feature, etc.). Do NOT guess which list tool owns a name. Each result has a "kind" field telling you which identifier field to use downstream: kind="cot" → use uid (pass as trackUid / fromTrackUid), kind="ais" → use mmsi (pass as vesselMmsi / fromVesselMmsi), kind="feature" → use id (pass as featureId / fromFeatureId).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Case-insensitive substring to match against callsigns, vessel names, feature names, uids, and MMSIs.'
          },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['cot', 'ais', 'feature'] },
            description: 'Optional whitelist of entity kinds to search. Omit to search all three.'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Max total results to return. Default 25.'
          }
        },
        required: ['name']
      },
      async handler({ name, kinds, limit = 25 }) {
        const needle = String(name ?? '').trim().toLowerCase()
        if (!needle) return { error: 'Provide a non-empty name.' }
        const allow = kinds?.length ? new Set(kinds) : null
        const results = []

        if (!allow || allow.has('cot')) {
          const tracks = tracksStore?.tracks
          if (tracks) {
            for (const t of tracks.values()) {
              const callsign = t.callsign ?? t.uid
              if (callsign.toLowerCase().includes(needle) || t.uid.toLowerCase().includes(needle)) {
                results.push({
                  kind: 'cot',
                  uid: t.uid,
                  name: callsign,
                  coordinate: [t.lon, t.lat],
                  affiliation: AFFIL_WORD[t.cotType?.[2]] ?? 'unknown',
                  cotType: t.cotType ?? null
                })
              }
            }
          }
        }

        if (!allow || allow.has('ais')) {
          const vessels = aisStore?.vessels
          if (vessels) {
            for (const v of vessels.values()) {
              const vname = v.name ?? String(v.mmsi)
              const mmsi  = String(v.mmsi)
              if (vname.toLowerCase().includes(needle) || mmsi.includes(needle)) {
                results.push({
                  kind: 'ais',
                  mmsi,
                  name: vname,
                  coordinate: [v.longitude, v.latitude],
                  vesselType: v.vesselType ?? ''
                })
              }
            }
          }
        }

        if (!allow || allow.has('feature')) {
          for (const f of featuresStore.features) {
            const props = JSON.parse(f.properties)
            const fname = props.name ?? props.callsign ?? f.type
            if (fname.toLowerCase().includes(needle)) {
              const entry = {
                kind: 'feature',
                id: f.id,
                type: f.type,
                name: fname,
                color: props.color ?? DEFAULT_FEATURE_COLOR
              }
              if (f.type === 'manual-track') {
                entry.affiliation = AFFIL_WORD[props.affiliation] ?? 'unknown'
                if (props.cotType) entry.cotType = props.cotType
              }
              results.push(entry)
            }
          }
        }

        return {
          query: name,
          matchCount: results.length,
          returnedCount: Math.min(results.length, limit),
          truncated: results.length > limit,
          results: results.slice(0, limit)
        }
      }
    },

    {
      name: 'map_get_feature',
      description: 'Get the full geometry and properties of a specific feature by id.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id from map_list_features.' }
        },
        required: ['id']
      },
      async handler({ id }) {
        const row = featuresStore.features.find(f => f.id === id)
        if (!row) return { error: `Feature ${id} not found.` }
        return {
          id: row.id,
          type: row.type,
          geometry: JSON.parse(row.geometry),
          properties: JSON.parse(row.properties)
        }
      }
    },

    {
      name: 'map_convert_coordinate',
      description: 'Convert a coordinate string in MGRS, DMS, or decimal-degrees format to [longitude, latitude]. Call this whenever the user provides a coordinate that is not already in decimal degrees.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: { type: 'string', description: 'Coordinate string, e.g. "18S UF 92912 87596", "36°57\'05"N 76°13\'22"W", or "36.95136, -76.22277".' },
          format: {
            type: 'string',
            enum: ['mgrs', 'dms', 'dd'],
            description: 'Format of the input string. Use "mgrs" for MGRS, "dms" for degrees/minutes/seconds, "dd" for decimal degrees.'
          }
        },
        required: ['coordinate', 'format']
      },
      async handler({ coordinate, format }) {
        const result = parseCoordinate(coordinate, format)
        if (!result) return { error: `Could not parse "${coordinate}" as ${format}.` }
        const [lng, lat] = result
        return { longitude: lng, latitude: lat }
      }
    },

    {
      name: 'map_offset_coordinate',
      description: 'Compute a new [longitude, latitude] offset from a starting point by a bearing and distance. Use this whenever the user wants to place, draw, or reference a location relative to an existing feature or coordinate (e.g. "1 mile west of FRND-1", "500 m north of the circle"). This is the correct first step for "place a new X near Y" — do NOT use map_move_feature, which would relocate the reference feature. Convert the user\'s units to meters (1 mi = 1609.344 m, 1 nm = 1852 m, 1 km = 1000 m) and direction to a compass bearing (N=0, E=90, S=180, W=270).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          fromFeatureId:  { type: 'integer', description: 'Feature id whose representative point is the origin.' },
          fromCoordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Origin [longitude, latitude]. Provide this OR fromFeatureId.'
          },
          bearing:        { type: 'number', description: 'Compass bearing in degrees (0=N, 90=E, 180=S, 270=W).' },
          distanceMeters: { type: 'number', description: 'Distance in meters. Always convert from the user\'s units.' }
        },
        required: ['bearing', 'distanceMeters']
      },
      async handler({ fromFeatureId, fromCoordinate, bearing, distanceMeters }) {
        let origin = fromCoordinate
        if (!origin) {
          if (fromFeatureId == null) return { error: 'Provide either fromFeatureId or fromCoordinate.' }
          const row = featuresStore.features.find(f => f.id === fromFeatureId)
          if (!row) return { error: `Feature ${fromFeatureId} not found.` }
          const props = JSON.parse(row.properties)
          if (props.center) origin = props.center
          else if (row.type === 'box' && props.sw && props.ne) {
            origin = [(props.sw[0] + props.ne[0]) / 2, (props.sw[1] + props.ne[1]) / 2]
          } else {
            const geom = JSON.parse(row.geometry)
            if (geom.type === 'Point') origin = geom.coordinates
            else {
              const bounds = geometryBounds(geom)
              if (!bounds) return { error: `Feature ${fromFeatureId} has no usable geometry.` }
              origin = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
            }
          }
        }
        const [lng, lat] = destinationPoint(origin, distanceMeters, bearing)
        return { longitude: lng, latitude: lat, coordinate: [lng, lat], origin }
      }
    },

    {
      name: 'map_measure_distance',
      description: 'Compute the great-circle distance and initial bearing between two points on the map. Use this whenever the user asks "how far", "distance", "bearing", or similar — do NOT draw a line or create any feature to answer these questions. Supply either a feature id or a raw [longitude, latitude] for each endpoint (but not both for the same endpoint).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          fromFeatureId:  { type: 'integer', description: 'Feature id for the starting point.' },
          fromCoordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Starting [longitude, latitude].'
          },
          toFeatureId:    { type: 'integer', description: 'Feature id for the ending point.' },
          toCoordinate:   {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Ending [longitude, latitude].'
          }
        },
        required: []
      },
      async handler({ fromFeatureId, fromCoordinate, toFeatureId, toCoordinate }) {
        const resolve = (id, coord, label) => {
          if (coord) return { ok: true, point: coord }
          if (id == null) return { ok: false, error: `Provide either ${label}FeatureId or ${label}Coordinate.` }
          const row = featuresStore.features.find(f => f.id === id)
          if (!row) return { ok: false, error: `Feature ${id} not found.` }
          const props = JSON.parse(row.properties)
          // Centered shapes expose a canonical center in props; otherwise use
          // the geometry's bbox midpoint (works for lines / polygons / routes).
          if (props.center) return { ok: true, point: props.center }
          if (row.type === 'box' && props.sw && props.ne) {
            return { ok: true, point: [(props.sw[0] + props.ne[0]) / 2, (props.sw[1] + props.ne[1]) / 2] }
          }
          const geom = JSON.parse(row.geometry)
          if (geom.type === 'Point') return { ok: true, point: geom.coordinates }
          const bounds = geometryBounds(geom)
          if (!bounds) return { ok: false, error: `Feature ${id} has no usable geometry.` }
          const [[w, s], [e, n]] = bounds
          return { ok: true, point: [(w + e) / 2, (s + n) / 2] }
        }

        const from = resolve(fromFeatureId, fromCoordinate, 'from')
        if (!from.ok) return { error: from.error }
        const to = resolve(toFeatureId, toCoordinate, 'to')
        if (!to.ok) return { error: to.error }

        const meters  = distanceBetween(from.point, to.point)
        const bearing = bearingBetween(from.point, to.point)
        return {
          distanceMeters: meters,
          distanceKm:     meters / 1000,
          distanceNm:     meters / 1852,
          distanceMi:     meters / 1609.344,
          bearingDeg:     bearing,
          from: from.point,
          to:   to.point
        }
      }
    },

    {
      name: 'map_features_in_area',
      description: 'Find every map feature (points, tracks, routes — both manual tracks AND live CoT tracks) that lies inside a given shape (circle, ellipse, sector, box, polygon). Use this whenever the user asks "what is inside X", "any tracks in X", "which features are inside the Xray box" — it is the right tool for containment questions, and it covers CoT tracks that manual-feature listing misses. By default all feature kinds and CoT tracks are included; narrow with the optional filters.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          shapeId: {
            type: 'integer',
            description: 'Feature id of the enclosing shape (must be a circle, ellipse, sector, box, or polygon).'
          },
          includeCotTracks: {
            type: 'boolean',
            description: 'Include live CoT tracks from listeners. Default true.'
          },
          affiliation: {
            type: 'string',
            enum: ['friendly', 'hostile', 'civilian', 'unknown'],
            description: 'Keep only tracks (manual + CoT) with this affiliation. Does not filter non-track features.'
          },
          featureTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional whitelist of feature.type values to keep (e.g. ["manual-track","point"]). Omit to include all.'
          }
        },
        required: ['shapeId']
      },
      async handler({ shapeId, includeCotTracks = true, affiliation, featureTypes }) {
        const shape = featuresStore.features.find(f => f.id === shapeId)
        if (!shape) return { error: `Feature ${shapeId} not found.` }
        const geom = JSON.parse(shape.geometry)
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
          return { error: `Feature ${shapeId} is type "${shape.type}" with geometry "${geom.type}" — not an enclosing area. Use a circle, ellipse, sector, box, or polygon.` }
        }

        const typeAllowed = featureTypes?.length ? new Set(featureTypes) : null

        // Point for a feature's containment test. Tracks / points → their coord;
        // multi-vertex features → representative centroid (bbox mid).
        function pointFor(row) {
          const rgeom = JSON.parse(row.geometry)
          if (rgeom.type === 'Point') return rgeom.coordinates
          const b = geometryBounds(rgeom)
          if (!b) return null
          return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2]
        }

        const AFFIL_WORD = { f: 'friendly', h: 'hostile', n: 'civilian', u: 'unknown' }

        const features = []
        for (const row of featuresStore.features) {
          if (row.id === shapeId) continue
          if (typeAllowed && !typeAllowed.has(row.type)) continue
          const props = JSON.parse(row.properties)
          const isTrack = row.type === 'manual-track'
          const affil = isTrack ? (AFFIL_WORD[props.affiliation] ?? 'unknown') : null
          if (affiliation && isTrack && affil !== affiliation) continue
          const pt = pointFor(row)
          if (!pt) continue
          if (!pointInPolygon(pt, geom)) continue
          const entry = {
            source: 'feature',
            id: row.id,
            type: row.type,
            name: props.name ?? props.callsign ?? row.type,
            coordinate: pt
          }
          if (isTrack) entry.affiliation = affil
          features.push(entry)
        }

        const cotTracks = []
        if (includeCotTracks && tracksStore) {
          for (const t of tracksStore.tracks.values()) {
            const affil = AFFIL_WORD[t.cotType?.[2]] ?? 'unknown'
            if (affiliation && affil !== affiliation) continue
            const pt = [t.lon, t.lat]
            if (!pointInPolygon(pt, geom)) continue
            cotTracks.push({
              source: 'cot',
              uid: t.uid,
              callsign: t.callsign ?? t.uid,
              cotType: t.cotType ?? null,
              affiliation: affil,
              coordinate: pt
            })
          }
        }

        return {
          shapeId,
          shapeName: JSON.parse(shape.properties).name ?? shape.type,
          featureMatches: features,
          cotTrackMatches: cotTracks,
          totalCount: features.length + cotTracks.length
        }
      }
    },

    // ── Draw — point / line ──────────────────────────────────────────────────

    {
      name: 'map_draw_point',
      description: 'Place a point marker on the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: '[longitude, latitude]'
          },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string', description: 'Hex color e.g. #ff0000' }
        },
        required: ['coordinate']
      },
      previewRender({ coordinate, name, color }) {
        const [lon, lat] = coordinate
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Point at ${lat.toFixed(4)}, ${lon.toFixed(4)}${col}`
      },
      async handler({ coordinate, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = { type: 'Point', coordinates: coordinate }
        const id = await featuresStore.addFeature('point', geometry, {
          name: nameOrDefault(name, 'point', featuresStore), color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_line',
      description: 'Draw a line (polyline) on the map through an ordered list of coordinates.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            minItems: 2,
            description: 'Ordered list of [longitude, latitude] pairs.'
          },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['points']
      },
      previewRender({ points, name, color }) {
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Line · ${points.length} points${col}`
      },
      async handler({ points, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = { type: 'LineString', coordinates: points }
        const id = await featuresStore.addFeature('line', geometry, {
          name: nameOrDefault(name, 'line', featuresStore), color
        })
        return { id, success: true }
      }
    },

    // ── Draw — polygons ──────────────────────────────────────────────────────

    {
      name: 'map_draw_polygon',
      description: 'Draw a closed polygon on the map from an ordered list of coordinates.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            minItems: 3,
            description: 'Ordered ring of [longitude, latitude] pairs. Auto-closed.'
          },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['points']
      },
      previewRender({ points, name, color }) {
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Polygon · ${points.length} points${col}`
      },
      async handler({ points, name, color = DEFAULT_FEATURE_COLOR }) {
        const ring = [...points]
        const first = ring[0], last = ring[ring.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
        const geometry = { type: 'Polygon', coordinates: [ring] }
        const id = await featuresStore.addFeature('polygon', geometry, {
          name: nameOrDefault(name, 'polygon', featuresStore), color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_circle',
      description: 'Draw a circle on the map at a center coordinate with a given radius.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          center: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Center [longitude, latitude].'
          },
          radiusMeters: { type: 'number', description: 'Radius in meters.' },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['center', 'radiusMeters']
      },
      previewRender({ center, radiusMeters, name, color }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Circle at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radiusMeters} m${col}`
      },
      async handler({ center, radiusMeters, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = circlePolygon(center, radiusMeters)
        const id = await featuresStore.addFeature('circle', geometry, {
          name: nameOrDefault(name, 'circle', featuresStore),
          center, radius: radiusMeters, color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_ellipse',
      description: 'Draw an ellipse on the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          center: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Center [longitude, latitude].'
          },
          radiusMajor: { type: 'number', description: 'Major-axis radius in meters.' },
          radiusMinor: { type: 'number', description: 'Minor-axis radius in meters.' },
          rotation: { type: 'number', description: 'Rotation in degrees (azimuth of major axis from north). Default 0.' },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['center', 'radiusMajor', 'radiusMinor']
      },
      previewRender({ center, radiusMajor, radiusMinor, name }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        return `${label}Ellipse at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radiusMajor}×${radiusMinor} m`
      },
      async handler({ center, radiusMajor, radiusMinor, rotation = 0, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = ellipsePolygon(center, radiusMajor, radiusMinor, rotation)
        const id = await featuresStore.addFeature('ellipse', geometry, {
          name: nameOrDefault(name, 'ellipse', featuresStore),
          center, radiusMajor, radiusMinor, rotation, color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_sector',
      description: 'Draw a sector (pie slice) on the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          center: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Center [longitude, latitude].'
          },
          radius: { type: 'number', description: 'Radius in meters.' },
          startAngle: { type: 'number', description: 'Start bearing in degrees (0 = north, clockwise).' },
          endAngle: { type: 'number', description: 'End bearing in degrees (clockwise from north).' },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['center', 'radius', 'startAngle', 'endAngle']
      },
      previewRender({ center, radius, startAngle, endAngle, name }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        return `${label}Sector at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radius} m · ${startAngle}°–${endAngle}°`
      },
      async handler({ center, radius, startAngle, endAngle, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = sectorPolygon(center, radius, startAngle, endAngle)
        const id = await featuresStore.addFeature('sector', geometry, {
          name: nameOrDefault(name, 'sector', featuresStore),
          center, radius, startAngle, endAngle, color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_box',
      description: 'Draw a rectangular box on the map defined by southwest and northeast corners, with optional rotation. When the user asks to box/wrap/enclose existing features, prefer map_draw_box_around_features instead.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          sw: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Southwest corner [longitude, latitude].'
          },
          ne: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Northeast corner [longitude, latitude].'
          },
          rotationDeg: { type: 'number', description: 'Rotation in degrees. Default 0.' },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['sw', 'ne']
      },
      previewRender({ sw, ne, rotationDeg, name }) {
        const label = name ? `"${name}" · ` : ''
        const rot = rotationDeg ? ` · ${rotationDeg}°` : ''
        return `${label}Box SW ${sw[1].toFixed(4)}, ${sw[0].toFixed(4)} → NE ${ne[1].toFixed(4)}, ${ne[0].toFixed(4)}${rot}`
      },
      async handler({ sw, ne, rotationDeg = 0, name, color = DEFAULT_FEATURE_COLOR }) {
        const geometry = rotatedBoxPolygon(sw, ne, rotationDeg)
        const id = await featuresStore.addFeature('box', geometry, {
          name: nameOrDefault(name, 'box', featuresStore),
          sw, ne, rotationDeg, color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_box_around_features',
      description: 'Draw an axis-aligned bounding box around one or more existing features. Use this whenever the user asks to box / wrap / enclose / surround existing features — do NOT compute the bounding box yourself and call map_draw_box. Padding defaults to 500 m so the box is always clearly visible even when features are close together.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          featureIds: {
            type: 'array', items: { type: 'integer' }, minItems: 1,
            description: 'IDs of features from map_list_features to enclose.'
          },
          paddingMeters: {
            type: 'number',
            description: 'Margin (in meters) added around the tightest bounding box so the box stays visible. Defaults to 500.'
          },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['featureIds']
      },
      previewRender({ featureIds, paddingMeters = 500, name }) {
        const label = name ? `"${name}" · ` : ''
        const ids = featureIds.map(i => `#${i}`).join(', ')
        return `${label}Box around ${ids} · +${paddingMeters} m`
      },
      async handler({ featureIds, paddingMeters = 500, name, color = DEFAULT_FEATURE_COLOR }) {
        const rows = featureIds
          .map(id => featuresStore.features.find(f => f.id === id))
          .filter(Boolean)
        if (!rows.length) return { error: 'No matching features found.' }

        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
        const visit = ([lng, lat]) => {
          if (lng < minLng) minLng = lng
          if (lat < minLat) minLat = lat
          if (lng > maxLng) maxLng = lng
          if (lat > maxLat) maxLat = lat
        }
        const walk = (geom) => {
          if (!geom) return
          if (geom.type === 'Point') visit(geom.coordinates)
          else if (geom.type === 'LineString') geom.coordinates.forEach(visit)
          else if (geom.type === 'Polygon') geom.coordinates.forEach(ring => ring.forEach(visit))
          else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(visit)))
        }
        for (const row of rows) walk(JSON.parse(row.geometry))
        if (!Number.isFinite(minLng)) return { error: 'Selected features have no usable geometry.' }

        // Convert padding in meters to degree offsets at the bbox's middle latitude.
        const midLat = (minLat + maxLat) / 2
        const metersPerDegLat = 111_320
        const metersPerDegLng = 111_320 * Math.cos(midLat * Math.PI / 180)
        const dLat = paddingMeters / metersPerDegLat
        const dLng = paddingMeters / metersPerDegLng

        const sw = [minLng - dLng, minLat - dLat]
        const ne = [maxLng + dLng, maxLat + dLat]
        const geometry = rotatedBoxPolygon(sw, ne, 0)
        const id = await featuresStore.addFeature('box', geometry, {
          name: nameOrDefault(name, 'box', featuresStore),
          sw, ne, rotationDeg: 0, color
        })
        return { id, success: true }
      }
    },

    // ── Draw — route ─────────────────────────────────────────────────────────

    {
      name: 'map_draw_route',
      description: 'Draw a route on the map from an ordered list of waypoints. First waypoint is SP (start point), last is EP (end point).',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          waypoints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                coordinate: {
                  type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
                  description: '[longitude, latitude]'
                },
                label: { type: 'string', description: 'Optional waypoint label (e.g. "Alpha", "Bravo"). Defaults to SP/WP N/EP.' }
              },
              required: ['coordinate']
            },
            minItems: 2,
            description: 'Ordered waypoints. First = SP, last = EP, rest = WP.'
          },
          name: { type: 'string', description: 'OPTIONAL display name. Pass ONLY when the user explicitly names the feature in their request (e.g. "polygon called Keepout", "box named Alpha"). If the user did not provide a name, OMIT this field — the system auto-generates a default like `circle-a3f9` / `box-7c2e` / `route-9201`. Do NOT invent descriptive names from context such as "Circle at 40R EP 13166 05853", "Polygon around target", or "Route SP→EP".' },
          color: { type: 'string' }
        },
        required: ['waypoints']
      },
      previewRender({ waypoints, name }) {
        const label = name ? `"${name}" · ` : ''
        return `${label}Route · ${waypoints.length} waypoints`
      },
      async handler({ waypoints, name, color = DEFAULT_FEATURE_COLOR }) {
        const total = waypoints.length
        const coords = waypoints.map(wp => wp.coordinate)
        const wps = waypoints.map((wp, i) => {
          const defaultLabel = i === 0 ? 'SP' : i === total - 1 ? 'EP' : `WP ${i}`
          const role = i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP'
          return { label: wp.label ?? defaultLabel, role }
        })
        const geometry = { type: 'LineString', coordinates: coords }
        const id = await featuresStore.addFeature('route', geometry, {
          name: nameOrDefault(name, 'route', featuresStore),
          color, waypoints: wps
        })
        return { id, success: true }
      }
    },

    // ── Track ────────────────────────────────────────────────────────────────

    {
      name: 'map_create_track',
      description: 'Place a manual track on the map. Infer affiliation from user phrasing ("friendly" → "friendly", "hostile" → "hostile", "civilian" or "neutral" → "civilian"). Always supply entity_type — infer it from context ("tank" → "armor", "helo" → "helicopter", "ship" → "surface", "unmanned ship/boat" → "unmanned_surface", "drone" → "uav"); use "ground" when the user says just "track" or "contact" without specifying an entity type.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: '[longitude, latitude]'
          },
          callsign: { type: 'string', description: 'Short label or callsign. Do not include the affiliation word here.' },
          affiliation: {
            type: 'string',
            enum: AFFIL_ENUM,
            description: 'Tactical affiliation. Infer from user phrasing ("friendly track" → "friendly", "hostile contact" → "hostile", "neutral/civilian" → "civilian"). Use "friendly" when the user has not specified an affiliation.'
          },
          entity_type: {
            type: 'string',
            enum: ENTITY_ENUM,
            description: 'MIL-STD-2525 entity type. Infer from context: "tank"→"armor", "helo"→"helicopter", "atk helo"→"attack_helicopter", "fighter/jet"→"fixed_wing", "drone"→"uav", "ship/boat"→"surface", "warship"→"combatant", "unmanned ship/usv"→"unmanned_surface", "ugv"→"unmanned_ground", "sub"→"submarine", "sof"→"sof". Use "ground" (generic ground) as the default when the user has not specified an entity type.'
          },
          course: { type: 'number', description: 'Heading in degrees (0–360). Defaults to 0.' },
          speed:  { type: 'number', description: 'Speed in knots. Defaults to 0.' },
          hae:    { type: 'number', description: 'Height above ellipsoid (altitude) in meters. Defaults to 0.' }
        },
        required: ['coordinate', 'callsign', 'entity_type']
      },
      previewRender({ coordinate, callsign, affiliation, entity_type }) {
        const [lon, lat] = coordinate
        const aff  = affiliation ?? 'friendly'
        const type = entity_type ? ` · ${entity_type}` : ''
        return `Track "${callsign}" (${aff}${type}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      },
      async handler({ coordinate, callsign, affiliation, entity_type, course = 0, speed = 0, hae = 0 }) {
        const affilCode = AFFIL_MAP[affiliation] ?? DEFAULT_AFFIL_CODE
        const suffix    = ENTITY_SUFFIX[entity_type]
        const cotType   = suffix ? `a-${affilCode}-${suffix}` : null
        const geometry  = { type: 'Point', coordinates: coordinate }
        const id = await featuresStore.addFeature('manual-track', geometry, {
          callsign, affiliation: affilCode, cotType, course, speed, hae
        })
        return { id, success: true }
      }
    },

    // ── Edit ─────────────────────────────────────────────────────────────────

    {
      name: 'map_rename_feature',
      description: 'Rename a feature on the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id.' },
          name: { type: 'string', description: 'New name.' }
        },
        required: ['id', 'name']
      },
      previewRender({ id, name }) {
        return `Rename feature #${id} → "${name}"`
      },
      async handler({ id, name }) {
        const row = featuresStore.features.find(f => f.id === id)
        const patch = row?.type === 'manual-track' ? { callsign: name } : { name }
        await featuresStore.updateFeatureProperties(id, patch)
        return { success: true }
      }
    },

    {
      name: 'map_update_feature_color',
      description: 'Change the color of a feature on the map.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id.' },
          color: { type: 'string', description: 'Hex color e.g. #ff0000.' }
        },
        required: ['id', 'color']
      },
      previewRender({ id, color }) {
        return `Recolor feature #${id} → ${color}`
      },
      async handler({ id, color }) {
        await featuresStore.updateFeatureProperties(id, { color })
        return { success: true }
      }
    },

    {
      name: 'map_update_track',
      description: 'Update an existing manual track — callsign, affiliation, entity type, course, speed, or altitude. Supply only the fields that are changing.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Track feature id.' },
          callsign: { type: 'string' },
          affiliation: {
            type: 'string',
            enum: AFFIL_ENUM
          },
          entity_type: {
            type: 'string',
            enum: ENTITY_ENUM,
            description: 'Change the entity type / MIL-STD-2525 symbol.'
          },
          course: { type: 'number', description: 'Heading in degrees (0–360).' },
          speed:  { type: 'number', description: 'Speed in knots.' },
          hae:    { type: 'number', description: 'Height above ellipsoid (altitude) in meters.' }
        },
        required: ['id']
      },
      previewRender({ id, callsign, affiliation, entity_type, course, speed, hae }) {
        const parts = [`Track #${id}`]
        if (callsign)         parts.push(`callsign → "${callsign}"`)
        if (affiliation)      parts.push(`affiliation → ${affiliation}`)
        if (entity_type)      parts.push(`type → ${entity_type}`)
        if (course !== undefined) parts.push(`course → ${course}°`)
        if (speed  !== undefined) parts.push(`speed → ${speed} kt`)
        if (hae    !== undefined) parts.push(`alt → ${hae} m`)
        return parts.join(' · ')
      },
      async handler({ id, callsign, affiliation, entity_type, course, speed, hae }) {
        const row = featuresStore.features.find(f => f.id === id)
        const existing = row ? JSON.parse(row.properties) : {}

        const patch = {}
        if (callsign !== undefined) patch.callsign = callsign
        if (course   !== undefined) patch.course   = course
        if (speed    !== undefined) patch.speed    = speed
        if (hae      !== undefined) patch.hae      = hae

        // Resolve affiliation — translate word → single char, fall back to existing.
        let affilCode = existing.affiliation ?? DEFAULT_AFFIL_CODE
        if (affiliation !== undefined) {
          affilCode = AFFIL_MAP[affiliation] ?? affilCode
          patch.affiliation = affilCode
        }

        // Rebuild cotType whenever entity_type changes (uses updated affilCode).
        if (entity_type !== undefined) {
          const suffix = ENTITY_SUFFIX[entity_type]
          patch.cotType = suffix ? `a-${affilCode}-${suffix}` : null
        }

        await featuresStore.updateFeatureProperties(id, patch)
        return { success: true }
      }
    },

    {
      name: 'map_update_shape',
      description: 'Update shape-specific geometric fields on an existing shape (circle, ellipse, sector, box) and/or common rendering fields (opacity). The tool validates fields against the shape type and rebuilds the geometry from the helpers — supply only the fields that are changing. Use map_move_feature for translation, map_update_feature_color for color, and map_rename_feature for name.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id from map_list_features.' },
          opacity:      { type: 'number', minimum: 0, maximum: 1, description: 'Fill opacity 0–1. Applies to any fillable shape.' },
          radius:       { type: 'number', description: 'Radius in meters. Circle & sector only.' },
          radiusMajor:  { type: 'number', description: 'Semi-major-axis radius in meters. Ellipse only.' },
          radiusMinor:  { type: 'number', description: 'Semi-minor-axis radius in meters. Ellipse only.' },
          rotationDeg:  { type: 'number', description: 'Rotation in degrees. Ellipse (as "rotation") and box (as "rotationDeg").' },
          startAngle:   { type: 'number', description: 'Start bearing in degrees (0=N, clockwise). Sector only.' },
          endAngle:     { type: 'number', description: 'End bearing in degrees. Sector only.' }
        },
        required: ['id']
      },
      previewRender({ id, opacity, radius, radiusMajor, radiusMinor, rotationDeg, startAngle, endAngle }) {
        const parts = [`Shape #${id}`]
        if (radius       !== undefined) parts.push(`radius → ${radius} m`)
        if (radiusMajor  !== undefined) parts.push(`major → ${radiusMajor} m`)
        if (radiusMinor  !== undefined) parts.push(`minor → ${radiusMinor} m`)
        if (rotationDeg  !== undefined) parts.push(`rot → ${rotationDeg}°`)
        if (startAngle   !== undefined) parts.push(`start → ${startAngle}°`)
        if (endAngle     !== undefined) parts.push(`end → ${endAngle}°`)
        if (opacity      !== undefined) parts.push(`opacity → ${Math.round(opacity * 100)}%`)
        return parts.join(' · ')
      },
      async handler({ id, opacity, radius, radiusMajor, radiusMinor, rotationDeg, startAngle, endAngle }) {
        const row = featuresStore.features.find(f => f.id === id)
        if (!row) return { error: `Feature ${id} not found.` }
        const existing = JSON.parse(row.properties)

        // Reject shape-specific fields that don't apply to this feature type.
        const validators = {
          circle:  ['radius'],
          ellipse: ['radiusMajor', 'radiusMinor', 'rotationDeg'],
          sector:  ['radius', 'startAngle', 'endAngle'],
          box:     ['rotationDeg'],
        }
        const provided = { radius, radiusMajor, radiusMinor, rotationDeg, startAngle, endAngle }
        const allowed  = new Set(validators[row.type] ?? [])
        for (const [field, val] of Object.entries(provided)) {
          if (val !== undefined && !allowed.has(field)) {
            return { error: `Field "${field}" does not apply to feature type "${row.type}". Allowed: ${[...allowed].join(', ') || '(none — use map_move_feature / map_update_feature_color / map_rename_feature)'}.` }
          }
        }

        const nextProps = { ...existing }
        if (opacity !== undefined) nextProps.opacity = opacity

        let geometry = null
        switch (row.type) {
          case 'circle': {
            if (radius !== undefined) nextProps.radius = radius
            geometry = circlePolygon(nextProps.center, nextProps.radius)
            break
          }
          case 'ellipse': {
            if (radiusMajor !== undefined) nextProps.radiusMajor = radiusMajor
            if (radiusMinor !== undefined) nextProps.radiusMinor = radiusMinor
            if (rotationDeg !== undefined) nextProps.rotation    = rotationDeg
            geometry = ellipsePolygon(
              nextProps.center,
              nextProps.radiusMajor,
              nextProps.radiusMinor,
              nextProps.rotation ?? 0
            )
            break
          }
          case 'sector': {
            if (radius     !== undefined) nextProps.radius     = radius
            if (startAngle !== undefined) nextProps.startAngle = startAngle
            if (endAngle   !== undefined) nextProps.endAngle   = endAngle
            geometry = sectorPolygon(
              nextProps.center,
              nextProps.radius,
              nextProps.startAngle,
              nextProps.endAngle
            )
            break
          }
          case 'box': {
            if (rotationDeg !== undefined) nextProps.rotationDeg = rotationDeg
            geometry = rotatedBoxPolygon(nextProps.sw, nextProps.ne, nextProps.rotationDeg ?? 0)
            break
          }
          default: {
            // Non-rebuilt types (point, line, polygon, route): only opacity is valid here.
            if (opacity === undefined) {
              return { error: `Feature type "${row.type}" has no shape-specific fields. Use map_move_feature, map_update_feature_color, or map_rename_feature.` }
            }
            await featuresStore.updateFeatureProperties(id, { opacity })
            return { success: true }
          }
        }

        await featuresStore.updateFeature(id, geometry, nextProps)
        return { success: true }
      }
    },

    {
      name: 'map_move_feature',
      description: 'Translate an EXISTING feature (point, track, shape, line, route) by a bearing and distance. Use this ONLY when the user explicitly asks to move, relocate, shift, or reposition a feature that is already on the map. Do NOT call this when the user asks to place, create, add, or draw a new feature near/west of/east of/etc. an existing one — for that, call map_offset_coordinate first to compute the new coordinate, then call the appropriate create/draw tool. Also do NOT create a new feature and delete the old one. Convert units to meters (1 mi = 1609.344 m, 1 nm = 1852 m, 1 km = 1000 m) and direction to a compass bearing (N=0, E=90, S=180, W=270, NE=45, etc.).',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id from map_list_features.' },
          bearing: { type: 'number', description: 'Compass bearing in degrees (0=N, 90=E, 180=S, 270=W).' },
          distanceMeters: { type: 'number', description: 'Distance to move, in meters. Always convert from the user\'s units.' }
        },
        required: ['id', 'bearing', 'distanceMeters']
      },
      previewRender({ id, bearing, distanceMeters }) {
        return `Move feature #${id} · ${bearing}° · ${distanceMeters} m`
      },
      async handler({ id, bearing, distanceMeters }) {
        const row = featuresStore.features.find(f => f.id === id)
        if (!row) return { error: `Feature ${id} not found.` }

        const props = JSON.parse(row.properties)
        const shift = (pt) => destinationPoint(pt, distanceMeters, bearing)
        let geometry
        const nextProps = { ...props }

        switch (row.type) {
          case 'point':
          case 'manual-track': {
            const src = JSON.parse(row.geometry).coordinates
            geometry = { type: 'Point', coordinates: shift(src) }
            break
          }
          case 'circle': {
            const newCenter = shift(props.center)
            geometry = circlePolygon(newCenter, props.radius)
            nextProps.center = newCenter
            break
          }
          case 'ellipse': {
            const newCenter = shift(props.center)
            geometry = ellipsePolygon(newCenter, props.radiusMajor, props.radiusMinor, props.rotation ?? 0)
            nextProps.center = newCenter
            break
          }
          case 'sector': {
            const newCenter = shift(props.center)
            geometry = sectorPolygon(newCenter, props.radius, props.startAngle, props.endAngle)
            nextProps.center = newCenter
            break
          }
          case 'box': {
            const newSw = shift(props.sw)
            const newNe = shift(props.ne)
            geometry = rotatedBoxPolygon(newSw, newNe, props.rotationDeg ?? 0)
            nextProps.sw = newSw
            nextProps.ne = newNe
            break
          }
          case 'polygon': {
            const src = JSON.parse(row.geometry)
            geometry = { type: 'Polygon', coordinates: src.coordinates.map(ring => ring.map(shift)) }
            break
          }
          case 'line':
          case 'route': {
            const src = JSON.parse(row.geometry)
            geometry = { type: 'LineString', coordinates: src.coordinates.map(shift) }
            break
          }
          default:
            return { error: `Moving features of type "${row.type}" is not supported.` }
        }

        await featuresStore.updateFeature(id, geometry, nextProps)
        return { success: true }
      }
    },

    // ── Delete ───────────────────────────────────────────────────────────────

    {
      name: 'map_delete_feature',
      description: 'Permanently delete a feature from the map by id.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id from map_list_features.' }
        },
        required: ['id']
      },
      previewRender({ id }) {
        return `Delete feature #${id}`
      },
      async handler({ id }) {
        await featuresStore.removeFeature(id)
        return { success: true }
      }
    },

    // ── Navigation ───────────────────────────────────────────────────────────

    {
      name: 'map_fly_to_feature',
      description: 'Pan and zoom the map to a specific feature.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Feature id to fly to.' }
        },
        required: ['id']
      },
      async handler({ id }) {
        if (!flyToGeometry) return { error: 'flyToGeometry not available.' }
        const row = featuresStore.features.find(f => f.id === id)
        if (!row) return { error: `Feature ${id} not found.` }
        flyToGeometry(JSON.parse(row.geometry))
        return { success: true }
      }
    },

    {
      name: 'map_fly_to',
      description: 'Pan and zoom the map to a named geographic location (city, state, country, landmark, region). Use your own geographic knowledge to resolve the name to [longitude, latitude] and pick a sensible zoom level: landmark/neighborhood ~14, city ~11, state/province ~6, country ~4, continent ~2. Call this whenever the user asks to go to / show / center / pan to / move to a named place.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: '[longitude, latitude] of the place.'
          },
          zoom: {
            type: 'number',
            description: 'MapLibre zoom level. Landmark ~14, city ~11, state ~6, country ~4, continent ~2. Defaults to 11.'
          },
          label: {
            type: 'string',
            description: 'Human-readable place name (for logging/context; not rendered on the map).'
          }
        },
        required: ['coordinate']
      },
      async handler({ coordinate, zoom }) {
        if (!flyTo) return { error: 'flyTo not available.' }
        flyTo({ coordinate, zoom })
        return { success: true }
      }
    },

    // ── Basemap ──────────────────────────────────────────────────────────────

    {
      name: 'map_list_basemaps',
      description: 'List the online basemap styles the user can switch to (e.g. Street, Dark, Light, Satellite). Also reports which one is currently active. Use this whenever the user says "change the map" without specifying which — present the available options and ask them to pick.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        const activeId = settingsStore?.selectedBasemap ?? null
        return {
          activeId,
          basemaps: BASEMAPS.map(b => ({ id: b.id, name: b.name, active: b.id === activeId }))
        }
      }
    },

    {
      name: 'map_set_basemap',
      description: 'Switch the map to a specific online basemap. Accepts the basemap id (from map_list_basemaps) — e.g. "arcgis-satellite", "arcgis-dark", "arcgis-light", "osm". When the user names a style loosely ("satellite", "dark mode", "streets"), map it to the matching id.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            enum: BASEMAPS.map(b => b.id),
            description: 'Basemap id to activate.'
          }
        },
        required: ['id']
      },
      previewRender({ id }) {
        const match = BASEMAPS.find(b => b.id === id)
        return `Basemap → ${match?.name ?? id}`
      },
      async handler({ id }) {
        if (!switchBasemap) return { error: 'switchBasemap not available.' }
        if (!BASEMAPS.some(b => b.id === id)) return { error: `Unknown basemap "${id}".` }
        await switchBasemap(id)
        return { success: true, id }
      }
    }

  ]
}
