// Default-name generator for newly created mission features.
//
// Convention: `<type>-<4-digit-hex>` (lowercase) — e.g. `polygon-a3f9`,
// `route-7c2e`, `box-9201`. Each new feature gets a fresh random suffix
// so concurrent draws don't collide and the user doesn't have to think
// about a name unless they care to. With 16-bit suffixes there's a
// 1-in-65k chance of a per-attempt collision; the helper checks against
// existing feature names and retries up to a few times before falling
// back to a timestamp-based suffix.
//
// Out of scope: manual tracks. Their affiliation-prefixed callsigns
// (`FRND-1`, `HSTL-2`, …) are tactically meaningful and stay as they
// are.

const MAX_ATTEMPTS = 8

function randHex4() {
  return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
}

function existingNames(featuresStore) {
  const names = new Set()
  if (!featuresStore?.features) return names
  for (const f of featuresStore.features) {
    try {
      const props = JSON.parse(f.properties)
      if (typeof props?.name === 'string' && props.name.length) {
        names.add(props.name)
      }
    } catch { /* skip malformed row */ }
  }
  return names
}

/**
 * Generate a default name for a new feature of `type`. If `featuresStore`
 * is provided, the helper checks for collisions and retries; otherwise
 * it returns the first random suffix it generated.
 *
 * @param {string} type — feature type slug, e.g. 'polygon', 'route', 'box'
 * @param {{ features: any[] } | null | undefined} [featuresStore]
 * @returns {string}
 */
export function defaultFeatureName(type, featuresStore) {
  const taken = existingNames(featuresStore)
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const candidate = `${type}-${randHex4()}`
    if (!taken.has(candidate)) return candidate
  }
  // Fallback — vanishingly unlikely to be hit, but timestamp suffix
  // guarantees uniqueness if MAX_ATTEMPTS happen to all collide.
  const ts = Date.now().toString(16).slice(-4)
  return `${type}-${ts}`
}

/**
 * Returns `name` if the caller (a UI form, an assistant tool argument,
 * etc.) supplied a non-blank string; otherwise generates a default via
 * `defaultFeatureName`. Convenience wrapper for the common
 * "use-supplied-or-generate" pattern at feature-creation sites.
 */
export function nameOrDefault(name, type, featuresStore) {
  if (typeof name === 'string' && name.trim().length) return name
  return defaultFeatureName(type, featuresStore)
}
