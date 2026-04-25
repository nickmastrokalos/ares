// Lightweight semver comparison for the release-notes "what's new" overlay.
// Only handles plain X.Y.Z strings — pre-release tags ('1.0.0-rc.1') aren't
// in our release flow, so we don't model them.

export function compareSemver(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (ai !== bi) return ai < bi ? -1 : 1
  }
  return 0
}
