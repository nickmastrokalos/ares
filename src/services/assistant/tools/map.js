import {
  circlePolygon,
  ellipsePolygon,
  sectorPolygon,
  rotatedBoxPolygon,
} from '@/services/geometry'
import { DEFAULT_FEATURE_COLOR } from '@/stores/features'
import { parseCoordinate } from '@/services/coordinates'

export function mapTools({ featuresStore, flyToGeometry }) {
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
      description: 'List all features on the current mission map (shapes, routes, tracks, etc.).',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return featuresStore.features.map(f => {
          const props = JSON.parse(f.properties)
          return {
            id: f.id,
            type: f.type,
            name: props.name ?? props.callsign ?? f.type,
            color: props.color ?? DEFAULT_FEATURE_COLOR
          }
        })
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
          name: { type: 'string' },
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
      async handler({ coordinate, name = 'Point', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = { type: 'Point', coordinates: coordinate }
        const id = await featuresStore.addFeature('point', geometry, { name, color })
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['points']
      },
      previewRender({ points, name, color }) {
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Line · ${points.length} points${col}`
      },
      async handler({ points, name = 'Line', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = { type: 'LineString', coordinates: points }
        const id = await featuresStore.addFeature('line', geometry, { name, color })
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['points']
      },
      previewRender({ points, name, color }) {
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Polygon · ${points.length} points${col}`
      },
      async handler({ points, name = 'Polygon', color = DEFAULT_FEATURE_COLOR }) {
        const ring = [...points]
        const first = ring[0], last = ring[ring.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
        const geometry = { type: 'Polygon', coordinates: [ring] }
        const id = await featuresStore.addFeature('polygon', geometry, { name, color })
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
          name: { type: 'string' },
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
      async handler({ center, radiusMeters, name = 'Circle', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = circlePolygon(center, radiusMeters)
        const id = await featuresStore.addFeature('circle', geometry, { name, center, radius: radiusMeters, color })
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['center', 'radiusMajor', 'radiusMinor']
      },
      previewRender({ center, radiusMajor, radiusMinor, name }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        return `${label}Ellipse at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radiusMajor}×${radiusMinor} m`
      },
      async handler({ center, radiusMajor, radiusMinor, rotation = 0, name = 'Ellipse', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = ellipsePolygon(center, radiusMajor, radiusMinor, rotation)
        const id = await featuresStore.addFeature('ellipse', geometry, {
          name, center, radiusMajor, radiusMinor, rotation, color
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['center', 'radius', 'startAngle', 'endAngle']
      },
      previewRender({ center, radius, startAngle, endAngle, name }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        return `${label}Sector at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radius} m · ${startAngle}°–${endAngle}°`
      },
      async handler({ center, radius, startAngle, endAngle, name = 'Sector', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = sectorPolygon(center, radius, startAngle, endAngle)
        const id = await featuresStore.addFeature('sector', geometry, {
          name, center, radius, startAngle, endAngle, color
        })
        return { id, success: true }
      }
    },

    {
      name: 'map_draw_box',
      description: 'Draw a rectangular box on the map defined by southwest and northeast corners, with optional rotation.',
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['sw', 'ne']
      },
      previewRender({ sw, ne, rotationDeg, name }) {
        const label = name ? `"${name}" · ` : ''
        const rot = rotationDeg ? ` · ${rotationDeg}°` : ''
        return `${label}Box SW ${sw[1].toFixed(4)}, ${sw[0].toFixed(4)} → NE ${ne[1].toFixed(4)}, ${ne[0].toFixed(4)}${rot}`
      },
      async handler({ sw, ne, rotationDeg = 0, name = 'Box', color = DEFAULT_FEATURE_COLOR }) {
        const geometry = rotatedBoxPolygon(sw, ne, rotationDeg)
        const id = await featuresStore.addFeature('box', geometry, { name, sw, ne, rotationDeg, color })
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
          name: { type: 'string' },
          color: { type: 'string' }
        },
        required: ['waypoints']
      },
      previewRender({ waypoints, name }) {
        const label = name ? `"${name}" · ` : ''
        return `${label}Route · ${waypoints.length} waypoints`
      },
      async handler({ waypoints, name = 'Route', color = DEFAULT_FEATURE_COLOR }) {
        const total = waypoints.length
        const coords = waypoints.map(wp => wp.coordinate)
        const wps = waypoints.map((wp, i) => {
          const defaultLabel = i === 0 ? 'SP' : i === total - 1 ? 'EP' : `WP ${i}`
          const role = i === 0 ? 'SP' : i === total - 1 ? 'EP' : 'WP'
          return { label: wp.label ?? defaultLabel, role }
        })
        const geometry = { type: 'LineString', coordinates: coords }
        const id = await featuresStore.addFeature('route', geometry, { name, color, waypoints: wps })
        return { id, success: true }
      }
    },

    // ── Track ────────────────────────────────────────────────────────────────

    {
      name: 'map_create_track',
      description: 'Place a manual track (unit, contact, or position) on the map at a coordinate. When the user says "a friendly track", "a hostile contact", etc., extract the affiliation word into the `affiliation` field — do NOT include it in the callsign.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: '[longitude, latitude]'
          },
          callsign: { type: 'string', description: 'Short label or callsign. Do not include the affiliation word (friendly/hostile/neutral/unknown) here.' },
          affiliation: {
            type: 'string',
            enum: ['friendly', 'hostile', 'neutral', 'unknown'],
            description: 'Tactical affiliation. Infer from user phrasing: "friendly track" → "friendly", "hostile contact" → "hostile". If the user did not specify, use "unknown".'
          },
          course: { type: 'number', description: 'Heading in degrees (0–360). Defaults to 0.' },
          speed: { type: 'number', description: 'Speed in knots. Defaults to 0.' }
        },
        required: ['coordinate', 'callsign', 'affiliation']
      },
      previewRender({ coordinate, callsign, affiliation }) {
        const [lon, lat] = coordinate
        const aff = affiliation ?? 'unknown'
        return `Track "${callsign}" (${aff}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      },
      async handler({ coordinate, callsign, affiliation = 'unknown', course = 0, speed = 0 }) {
        const geometry = { type: 'Point', coordinates: coordinate }
        const id = await featuresStore.addFeature('manual-track', geometry, { callsign, affiliation, course, speed, hae: 0 })
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
        await featuresStore.updateFeatureProperties(id, { name })
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
      description: 'Update the callsign, affiliation, course, or speed of an existing manual track.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Track feature id.' },
          callsign: { type: 'string' },
          affiliation: { type: 'string', enum: ['friendly', 'hostile', 'neutral', 'unknown'] },
          course: { type: 'number' },
          speed: { type: 'number' }
        },
        required: ['id']
      },
      previewRender({ id, callsign, affiliation }) {
        const parts = [`Track #${id}`]
        if (callsign) parts.push(`callsign → "${callsign}"`)
        if (affiliation) parts.push(`affiliation → ${affiliation}`)
        return parts.join(' · ')
      },
      async handler({ id, ...patch }) {
        const allowed = ['callsign', 'affiliation', 'course', 'speed']
        const filtered = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)))
        await featuresStore.updateFeatureProperties(id, filtered)
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
    }

  ]
}
