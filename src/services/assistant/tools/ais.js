import { distanceBetween } from '@/services/geometry'
import { featureCentroid } from '@/services/assistant/entityResolution'

// AIS assistant tools. All writes gate on presence of feedUrl + apiKey when
// the user is trying to enable the feed — otherwise the toggle silently does
// nothing (fetchVessels in the store short-circuits on missing config).

function configMissing(aisStore) {
  return !aisStore.feedUrl?.trim() || !aisStore.apiKey?.trim()
}

// Stable summary shape for a raw vessel record (from aisStore.vessels values).
function summariseVessel(v) {
  return {
    mmsi:        String(v.mmsi),
    name:        v.name ?? String(v.mmsi),
    coordinate:  [v.longitude, v.latitude],
    speedKnots:  v.SOG ?? 0,
    courseDeg:   (v.COG     != null && v.COG     >= 0) ? v.COG     : null,
    headingDeg:  (v.heading != null && v.heading >= 0) ? v.heading : null,
    navStatus:   v.navStatus  ?? '',
    vesselType:  v.vesselType ?? ''
  }
}

// Resolve a center point from either a featureId (uses feature center) or a
// raw coordinate.
function resolveCenter(featuresStore, featureId, coordinate) {
  if (coordinate) return { ok: true, point: coordinate }
  if (featureId == null) {
    return { ok: false, error: 'Provide either featureId or coordinate.' }
  }
  const c = featureCentroid(featuresStore, featureId)
  return c.ok ? { ok: true, point: c.coord } : c
}

export function aisTools({ aisStore, featuresStore }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'ais_get_status',
      description: 'Report the current AIS configuration and feed state: whether the feed is enabled, whether vessels are visible on the map, whether heading tails are drawn, and whether the feed URL and API key are configured.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return {
          enabled:   aisStore.enabled,
          visible:   aisStore.visible,
          tails:     aisStore.aisBreadcrumbs,
          configured: !configMissing(aisStore),
          feedUrl:    aisStore.feedUrl || '',
          vesselCount: aisStore.vesselCount
        }
      }
    },

    {
      name: 'ais_list_vessels',
      description: 'List AIS vessels currently known to the app. Each vessel has its MMSI, name (often the vessel callsign), [longitude, latitude], speed in knots, course, and navigation status. Returns an empty list when the feed is disabled or no vessels have been fetched yet. Use the optional "name" filter (case-insensitive substring match) to narrow results when the user refers to a vessel by name (e.g. "mermaid7"). Results are capped at "limit" (default 100) to keep payloads small — raise the limit only if the user really needs the full set.',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          name:  { type: 'string', description: 'Case-insensitive substring of vessel name or MMSI.' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max number of vessels to return. Default 100.' }
        },
        required: []
      },
      async handler({ name, limit = 100 }) {
        if (!aisStore.enabled) return { enabled: false, vessels: [], note: 'AIS feed is disabled. Enable it with ais_set_enabled to fetch vessels.' }
        const needle = name?.trim().toLowerCase() ?? ''
        const all = Array.from(aisStore.vessels.values()).map(summariseVessel)
        const filtered = needle
          ? all.filter(v => v.name.toLowerCase().includes(needle) || v.mmsi.includes(needle))
          : all
        const truncated = filtered.length > limit
        return {
          enabled: true,
          totalCount:   aisStore.vesselCount,
          returnedCount: Math.min(filtered.length, limit),
          truncated,
          vessels: filtered.slice(0, limit)
        }
      }
    },

    {
      name: 'ais_vessels_near',
      description: 'Find AIS vessels within a given radius of a center point. The center is either a feature id (anything on the map — a track, shape, point) or a raw [longitude, latitude]. Results include the computed distance in meters and are sorted nearest-first. Convert the user\'s units to meters before calling (1 nm = 1852 m, 1 mi = 1609.344 m, 1 km = 1000 m).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          featureId:       { type: 'integer', description: 'Feature id whose position is the search center.' },
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Center [longitude, latitude]. Provide this OR featureId.'
          },
          radiusMeters:    { type: 'number', description: 'Search radius in meters.' },
          limit:           { type: 'integer', minimum: 1, maximum: 500, description: 'Max number of nearest vessels to return. Default 50.' }
        },
        required: ['radiusMeters']
      },
      async handler({ featureId, coordinate, radiusMeters, limit = 50 }) {
        if (!aisStore.enabled) return { enabled: false, vessels: [], note: 'AIS feed is disabled. Enable it with ais_set_enabled to fetch vessels.' }
        const center = resolveCenter(featuresStore, featureId, coordinate)
        if (!center.ok) return { error: center.error }
        const matches = []
        for (const v of aisStore.vessels.values()) {
          const d = distanceBetween(center.point, [v.longitude, v.latitude])
          if (d <= radiusMeters) matches.push({ ...summariseVessel(v), distanceMeters: d })
        }
        matches.sort((a, b) => a.distanceMeters - b.distanceMeters)
        return {
          enabled: true,
          center:  center.point,
          radiusMeters,
          matchCount: matches.length,
          returnedCount: Math.min(matches.length, limit),
          truncated: matches.length > limit,
          vessels: matches.slice(0, limit)
        }
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'ais_set_enabled',
      description: 'Turn the AIS feed on or off. When enabling, the feed URL and API key must be configured in Settings → AIS first; this tool refuses to enable if either is missing.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'True to turn the feed on, false to turn it off.' }
        },
        required: ['enabled']
      },
      previewRender({ enabled }) {
        return `AIS feed → ${enabled ? 'on' : 'off'}`
      },
      async handler({ enabled }) {
        if (enabled && configMissing(aisStore)) {
          return { error: 'AIS feed URL or API key is not configured. Open Settings → AIS to add them before enabling the feed.' }
        }
        await aisStore.setEnabled(enabled)
        return { success: true, enabled: aisStore.enabled }
      }
    },

    {
      name: 'ais_set_visible',
      description: 'Show or hide AIS vessels on the map. Hiding does not turn the feed off — data still refreshes in the background.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          visible: { type: 'boolean', description: 'True to show vessels, false to hide them.' }
        },
        required: ['visible']
      },
      previewRender({ visible }) {
        return `AIS vessels → ${visible ? 'visible' : 'hidden'}`
      },
      async handler({ visible }) {
        await aisStore.setVisible(visible)
        return { success: true, visible: aisStore.visible }
      }
    },

    {
      name: 'ais_set_tails',
      description: 'Turn the AIS heading-tail overlay on or off. Tails are short lines drawn behind each moving vessel indicating direction of travel.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          tails: { type: 'boolean', description: 'True to show tails, false to hide them.' }
        },
        required: ['tails']
      },
      previewRender({ tails }) {
        return `AIS tails → ${tails ? 'on' : 'off'}`
      },
      async handler({ tails }) {
        await aisStore.setAisBreadcrumbs(tails)
        return { success: true, tails: aisStore.aisBreadcrumbs }
      }
    }

  ]
}
