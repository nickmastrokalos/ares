// Host-side built-in routing avoidances. Plugins contribute via
// `api.routing.registerAvoidance`; the host uses the same surface
// for constraints whose data is host-owned (e.g. tracksStore) so
// the assistant doesn't have to know which contributor came from
// where.

import { circlePolygon, corridorPolygon } from '@/services/geometry'
import { destinationPoint } from '@/services/geometry'

const KTS_TO_MPS = 0.5144444
// Minimum SOG before we project a swept corridor for a track. Stationary
// or near-stationary tracks get only the keepout circle — projecting a
// corridor from a drifting track along its last reported (probably
// noisy) heading just produces phantom obstacles.
const MIN_MOVING_KTS = 0.5

/**
 * Wire all built-in avoidances into the plugin registry. Called
 * once from MapView after the registry is constructed.
 *
 * Currently registers:
 *   - `tracks` — surface tracks from the host's tracksStore. Defaults
 *     to friendly atom CoT (`a-f-S-*`); air / ground / hostile tracks
 *     are excluded by default. Mirrors the AIS obstacle model:
 *     a circle at the current position plus, for moving tracks, a
 *     swept corridor along the last reported course.
 */
export function registerHostAvoidances(pluginRegistry, { tracksStore }) {
  pluginRegistry.routing.hostRegisterAvoidance({
    id:          'tracks',
    label:       'Surface tracks',
    description:
      'Friendly surface tracks the route should avoid. Each matching ' +
      'track gets a circular keepout at its current position; moving ' +
      'tracks (course-over-ground > 0.5 kts) additionally get a swept ' +
      'corridor extending along their course for the projection horizon.',
    paramsSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['S', 'A', 'G'],
          default: 'S',
          description: '2525 dimension code: S=surface, A=air, G=ground. Defaults to surface — air tracks are not a useful obstacle for ground/surface routes.'
        },
        affil: {
          type: 'array',
          items: { type: 'string', enum: ['f', 'h', 'n', 'u'] },
          default: ['f'],
          description: '2525 affiliation codes to include: f=friendly, h=hostile, n=neutral, u=unknown. Defaults to friendly only — hostile tracks may be intentional engagement targets, not obstacles.'
        },
        standoff_meters: {
          type: 'integer',
          minimum: 0,
          default: 1852,
          description: 'Radius of the keepout circle around each matching track, in metres. Default is 1 nautical mile.'
        },
        horizon_minutes: {
          type: 'integer',
          minimum: 0,
          default: 30,
          description: 'How far forward (in minutes) to project moving tracks along their COG when building the swept corridor.'
        }
      }
    },
    async getObstacles({ params }) {
      const domain          = params?.domain ?? 'S'
      const affil           = Array.isArray(params?.affil) && params.affil.length ? params.affil : ['f']
      const standoffMeters  = Number.isFinite(params?.standoff_meters) ? params.standoff_meters : 1852
      const horizonMinutes  = Number.isFinite(params?.horizon_minutes) ? params.horizon_minutes : 30
      const horizonSeconds  = horizonMinutes * 60
      const polygons = []
      if (!tracksStore?.tracks) return polygons
      for (const t of tracksStore.tracks.values()) {
        if (typeof t.cotType !== 'string' || !t.cotType.startsWith('a-')) continue
        const parts   = t.cotType.split('-')
        const tAffil  = (parts[1] ?? '').toLowerCase()
        const tDomain = (parts[2] ?? '').toUpperCase()
        if (tDomain !== domain) continue
        if (!affil.includes(tAffil)) continue
        if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue
        const here = [t.lon, t.lat]
        polygons.push(circlePolygon(here, standoffMeters))
        const sog    = Number(t.speed)            // m/s on the wire
        const sogKts = Number.isFinite(sog) ? sog / KTS_TO_MPS : NaN
        const cog    = Number(t.course)
        if (Number.isFinite(sogKts) && sogKts > MIN_MOVING_KTS && Number.isFinite(cog) && horizonSeconds > 0) {
          const distance = sog * horizonSeconds
          const there    = destinationPoint(here, distance, cog)
          polygons.push(corridorPolygon(here, there, standoffMeters))
        }
      }
      return polygons
    }
  })
}
