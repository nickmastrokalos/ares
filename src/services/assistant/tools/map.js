import { circlePolygon } from '@/services/geometry'
import { DEFAULT_FEATURE_COLOR } from '@/stores/features'

export function mapTools({ featuresStore }) {
  return [
    {
      name: 'map_list_features',
      description: 'List all features (shapes, routes, tracks) on the current mission map.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      async handler() {
        return featuresStore.features.map(f => {
          const props = JSON.parse(f.properties)
          return {
            id: f.id,
            type: f.type,
            name: props.name ?? f.type,
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
      name: 'map_draw_circle',
      description: 'Draw a circle on the map at the given center coordinate with a radius in meters.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          center: {
            type: 'array',
            items: { type: 'number' },
            minItems: 2,
            maxItems: 2,
            description: 'Center coordinate as [longitude, latitude].'
          },
          radiusMeters: { type: 'number', description: 'Circle radius in meters.' },
          name: { type: 'string', description: 'Optional label for the circle.' },
          color: { type: 'string', description: 'Optional hex color, e.g. #ff0000.' }
        },
        required: ['center', 'radiusMeters']
      },
      previewRender({ center, radiusMeters, name, color }) {
        const [lon, lat] = center
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Circle at ${lat.toFixed(4)}, ${lon.toFixed(4)} · ${radiusMeters} m${col}`
      },
      async handler({ center, radiusMeters, name, color }) {
        const geometry = circlePolygon(center, radiusMeters)
        const props = {
          name: name ?? 'Circle',
          center,
          radius: radiusMeters,
          color: color ?? DEFAULT_FEATURE_COLOR
        }
        const id = await featuresStore.addFeature('circle', geometry, props)
        return { id, success: true }
      }
    },
    {
      name: 'map_draw_polygon',
      description: 'Draw a closed polygon on the map from an ordered list of coordinates.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2
            },
            minItems: 3,
            description: 'Ordered ring of [longitude, latitude] pairs. The ring is auto-closed.'
          },
          name: { type: 'string', description: 'Optional label for the polygon.' },
          color: { type: 'string', description: 'Optional hex color, e.g. #ff0000.' }
        },
        required: ['points']
      },
      previewRender({ points, name, color }) {
        const label = name ? `"${name}" · ` : ''
        const col = color ? ` · ${color}` : ''
        return `${label}Polygon · ${points.length} points${col}`
      },
      async handler({ points, name, color }) {
        const ring = [...points]
        const first = ring[0]
        const last = ring[ring.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
        const geometry = { type: 'Polygon', coordinates: [ring] }
        const props = {
          name: name ?? 'Polygon',
          color: color ?? DEFAULT_FEATURE_COLOR
        }
        const id = await featuresStore.addFeature('polygon', geometry, props)
        return { id, success: true }
      }
    },
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
    }
  ]
}
