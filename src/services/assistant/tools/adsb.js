import { distanceBetween } from '@/services/geometry'
import { featureCentroid } from '@/services/assistant/entityResolution'

// ADS-B assistant tools. The airplanes.live feed is free and key-less, so
// these tools have no "configured" gate — only the Active toggle matters.

function summariseAircraft(a) {
  const flight = (a.flight ?? '').trim()
  const altRaw = a.alt_baro
  const altitudeFt = typeof altRaw === 'number'
    ? altRaw
    : (altRaw === 'ground' ? 0 : null)
  return {
    hex:          String(a.hex),
    callsign:     flight || null,
    registration: a.r ?? null,
    type:         a.t ?? null,
    coordinate:   [a.lon, a.lat],
    altitudeFt,
    onGround:     altRaw === 'ground',
    speedKnots:   Number.isFinite(a.gs) ? a.gs : null,
    trackDeg:     Number.isFinite(a.track) ? a.track : null,
    headingDeg:   Number.isFinite(a.true_heading) ? a.true_heading
                : Number.isFinite(a.mag_heading) ? a.mag_heading
                : null,
    squawk:       a.squawk ?? null
  }
}

function resolveCenter(featuresStore, featureId, coordinate) {
  if (coordinate) return { ok: true, point: coordinate }
  if (featureId == null) {
    return { ok: false, error: 'Provide either featureId or coordinate.' }
  }
  const c = featureCentroid(featuresStore, featureId)
  return c.ok ? { ok: true, point: c.coord } : c
}

export function adsbTools({ adsbStore, featuresStore }) {
  return [

    // ── Read ─────────────────────────────────────────────────────────────────

    {
      name: 'adsb_get_status',
      description: 'Report the current ADS-B feed state: whether the feed is enabled, whether aircraft are visible on the map, whether heading-arrow icons are on, and the current aircraft count.',
      readonly: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async handler() {
        return {
          enabled:       adsbStore.enabled,
          visible:       adsbStore.visible,
          headingArrows: adsbStore.headingArrows,
          aircraftCount: adsbStore.aircraftCount
        }
      }
    },

    {
      name: 'adsb_list_aircraft',
      description: 'List ADS-B aircraft currently known to the app. Each aircraft has its 24-bit ICAO hex, callsign (the broadcast `flight` field), registration, type code, [longitude, latitude], altitude in feet (0 = on ground), ground speed in knots, true track, and squawk. Returns an empty list when the feed is disabled or no aircraft have been fetched yet. Use the optional "callsign" filter (case-insensitive substring match) to narrow results when the user refers to a flight by callsign or hex (e.g. "ual123", "ac45").',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          callsign: { type: 'string', description: 'Case-insensitive substring of callsign (flight) or hex.' },
          limit:    { type: 'integer', minimum: 1, maximum: 1000, description: 'Max number of aircraft to return. Default 100.' }
        },
        required: []
      },
      async handler({ callsign, limit = 100 }) {
        if (!adsbStore.enabled) return { enabled: false, aircraft: [], note: 'ADS-B feed is disabled. Enable it with adsb_set_enabled to fetch aircraft.' }
        const needle = callsign?.trim().toLowerCase() ?? ''
        const all = Array.from(adsbStore.aircraft.values()).map(summariseAircraft)
        const filtered = needle
          ? all.filter(a =>
              (a.callsign && a.callsign.toLowerCase().includes(needle)) ||
              a.hex.toLowerCase().includes(needle)
            )
          : all
        const truncated = filtered.length > limit
        return {
          enabled: true,
          totalCount:    adsbStore.aircraftCount,
          returnedCount: Math.min(filtered.length, limit),
          truncated,
          aircraft: filtered.slice(0, limit)
        }
      }
    },

    {
      name: 'adsb_aircraft_near',
      description: 'Find ADS-B aircraft within a given radius of a center point. The center is either a feature id (anything on the map — a track, shape, point) or a raw [longitude, latitude]. Results include the computed distance in meters and are sorted nearest-first. Convert the user\'s units to meters before calling (1 nm = 1852 m, 1 mi = 1609.344 m, 1 km = 1000 m).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {
          featureId:    { type: 'integer', description: 'Feature id whose position is the search center.' },
          coordinate: {
            type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
            description: 'Center [longitude, latitude]. Provide this OR featureId.'
          },
          radiusMeters: { type: 'number', description: 'Search radius in meters.' },
          limit:        { type: 'integer', minimum: 1, maximum: 500, description: 'Max number of nearest aircraft to return. Default 50.' }
        },
        required: ['radiusMeters']
      },
      async handler({ featureId, coordinate, radiusMeters, limit = 50 }) {
        if (!adsbStore.enabled) return { enabled: false, aircraft: [], note: 'ADS-B feed is disabled. Enable it with adsb_set_enabled to fetch aircraft.' }
        const center = resolveCenter(featuresStore, featureId, coordinate)
        if (!center.ok) return { error: center.error }
        const matches = []
        for (const a of adsbStore.aircraft.values()) {
          const d = distanceBetween(center.point, [a.lon, a.lat])
          if (d <= radiusMeters) matches.push({ ...summariseAircraft(a), distanceMeters: d })
        }
        matches.sort((a, b) => a.distanceMeters - b.distanceMeters)
        return {
          enabled: true,
          center:  center.point,
          radiusMeters,
          matchCount:    matches.length,
          returnedCount: Math.min(matches.length, limit),
          truncated:     matches.length > limit,
          aircraft: matches.slice(0, limit)
        }
      }
    },

    // ── Write ────────────────────────────────────────────────────────────────

    {
      name: 'adsb_set_enabled',
      description: 'Turn the ADS-B feed on or off. The airplanes.live feed is free and requires no API key, so enabling just starts the 10-second poll.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', description: 'True to turn the feed on, false to turn it off.' }
        },
        required: ['enabled']
      },
      previewRender({ enabled }) {
        return `ADS-B feed → ${enabled ? 'on' : 'off'}`
      },
      async handler({ enabled }) {
        await adsbStore.setEnabled(enabled)
        return { success: true, enabled: adsbStore.enabled }
      }
    },

    {
      name: 'adsb_set_visible',
      description: 'Show or hide ADS-B aircraft on the map. Hiding does not turn the feed off — data still refreshes in the background.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          visible: { type: 'boolean', description: 'True to show aircraft, false to hide them.' }
        },
        required: ['visible']
      },
      previewRender({ visible }) {
        return `ADS-B aircraft → ${visible ? 'visible' : 'hidden'}`
      },
      async handler({ visible }) {
        await adsbStore.setVisible(visible)
        return { success: true, visible: adsbStore.visible }
      }
    },

    {
      name: 'adsb_set_heading_arrows',
      description: 'Switch the ADS-B aircraft icon between plain circles and direction-aware arrows (rotated to each aircraft\'s true track). The history-trail rendering — fading polylines behind each aircraft — is governed by the global `Track breadcrumbs` setting (Settings → Tracks), not this tool.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          arrows: { type: 'boolean', description: 'True to render aircraft as heading arrows, false to render as plain circles.' }
        },
        required: ['arrows']
      },
      previewRender({ arrows }) {
        return `ADS-B heading arrows → ${arrows ? 'on' : 'off'}`
      },
      async handler({ arrows }) {
        await adsbStore.setHeadingArrows(arrows)
        return { success: true, headingArrows: adsbStore.headingArrows }
      }
    }

  ]
}
