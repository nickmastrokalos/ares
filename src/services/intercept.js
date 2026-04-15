import { destinationPoint, distanceBetween, bearingBetween } from './geometry'

/**
 * Solve for an intercept point given:
 *   - Friendly position (fLon, fLat) and speed (fSpeedMs, m/s)
 *   - Hostile position (hLon, hLat), speed (hSpeedMs, m/s), and course (hCourse, degrees)
 *   - Desired intercept geometry: range from hostile (rangeM, meters) and
 *     bearing relative to hostile heading (bearing, degrees: 0=ahead, 90=right,
 *     180=tail, 270=left)
 *
 * Returns one of:
 *   { heading, tti, interceptLon, interceptLat }
 *   { error: string }
 */
export function solveIntercept({ fLon, fLat, fSpeedMs, hLon, hLat, hSpeedMs, hCourse, rangeM, bearing }) {
  if (fSpeedMs <= 0) return { error: 'No friendly speed' }
  if (rangeM <= 0) return { error: 'Invalid range' }

  // Absolute bearing from north to the intercept point relative to hostile
  const absIntercept = ((hCourse + bearing) % 360 + 360) % 360

  // ---- Stationary hostile ----
  if (hSpeedMs < 0.01) {
    const P = destinationPoint([hLon, hLat], rangeM, absIntercept)
    const dist = distanceBetween([fLon, fLat], P)
    if (dist < 1) {
      return { heading: 0, tti: 0, interceptLon: P[0], interceptLat: P[1] }
    }
    return {
      heading: Math.round(bearingBetween([fLon, fLat], P)),
      tti: Math.round(dist / fSpeedMs),
      interceptLon: P[0],
      interceptLat: P[1]
    }
  }

  // ---- Moving hostile — iterative solver ----
  let T = 0
  let P = null

  for (let i = 0; i < 60; i++) {
    const Ht = destinationPoint([hLon, hLat], hSpeedMs * T, hCourse)
    P = destinationPoint(Ht, rangeM, absIntercept)

    const dist = distanceBetween([fLon, fLat], P)

    if (dist < 1) {
      return { heading: 0, tti: 0, interceptLon: P[0], interceptLat: P[1] }
    }

    const T_new = dist / fSpeedMs

    if (!isFinite(T_new) || T_new > 7200) {
      return { error: 'No solution — friendly speed too low' }
    }

    if (Math.abs(T_new - T) < 0.5) {
      T = T_new
      break
    }

    T = T_new
  }

  if (!P) return { error: 'No solution — friendly speed too low' }

  return {
    heading: Math.round(bearingBetween([fLon, fLat], P)),
    tti: Math.round(T),
    interceptLon: P[0],
    interceptLat: P[1]
  }
}
