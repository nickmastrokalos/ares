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

// Patterns that, if present in a `name`, almost certainly mean the LLM
// fabricated the value from prompt context (the user said "circle at <coord>"
// and the agent passed `name: "Circle at 40R EP 13166 05853"`). Tool
// descriptions already tell the model to OMIT in that case; this is the
// handler-side backstop for when it doesn't comply.
//
// Patterns are coordinate-shaped (high precision, low false-positive on
// natural-language names like "Keepout", "Bay recon", "Alpha"):
//   - MGRS — `40R EP 13166 05853`
//   - Decimal coord with degree symbol + N/S/E/W — `36.918° N`
//   - Decimal coord pair with comma — `36.918, -76.112`
const CONTEXT_DERIVED_PATTERNS = [
  // Full MGRS — "40R EP 13166 05853"
  /\b\d{1,2}[A-Z]\s+[A-Z]{2}\s+\d{4,5}\s+\d{4,5}\b/i,
  // MGRS prefix shorthand — "40R BN" or "40R BN to 40R DQ" (zone +
  // 100 km square id without digits). The model often shortens
  // coordinate-derived names this way; same red flag as the full form.
  /\b\d{1,2}[A-Z]\s+[A-Z]{2}\b/i,
  // Decimal-degrees with explicit hemisphere — "36.918° N"
  /-?\d{1,3}\.\d+\s*°\s*[NSEW]/i,
  // Decimal coord pair separated by comma — "36.918, -76.112"
  /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/
]

/**
 * Returns true if the supplied text matches a pattern that's almost
 * certainly a coordinate-derived name produced by the LLM rather than
 * something a user typed. False positives on natural-language names
 * are very low (the patterns require coordinate-shaped substrings).
 */
export function looksContextDerived(text) {
  if (typeof text !== 'string') return false
  const t = text.trim()
  if (!t) return false
  return CONTEXT_DERIVED_PATTERNS.some(re => re.test(t))
}

/**
 * If `name` is a coordinate-derived string per `looksContextDerived`,
 * returns an `{ error }` object that an assistant-tool handler can
 * return as-is to refuse the call. Otherwise returns null. The error
 * message tells the model to OMIT the field so the auto-default
 * naming kicks in.
 */
export function rejectIfContextDerived(name, kind = 'name') {
  if (!looksContextDerived(name)) return null
  return {
    error: `The supplied ${kind} ("${name}") looks coordinate-derived from the prompt rather than user-supplied. Re-call this tool WITHOUT the \`${kind}\` field — the system will auto-generate a default. Only pass \`${kind}\` when the user has explicitly named the feature in their request.`
  }
}
