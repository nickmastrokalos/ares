import { destinationPoint, distanceBetween, bearingBetween } from './geometry'

const DEG = Math.PI / 180

function vectorFromHeading(speedMs, courseDeg) {
  // Local-tangent x=east, y=north. Course is degrees from north, clockwise.
  const th = courseDeg * DEG
  return [speedMs * Math.sin(th), speedMs * Math.cos(th)]
}

function headingFromVector([vx, vy]) {
  const deg = Math.atan2(vx, vy) / DEG
  return ((deg % 360) + 360) % 360
}

function closingSpeedForAim(fLon, fLat, fSpeedMs, fHeadingDeg, hLon, hLat, hSpeedMs, hCourseDeg) {
  // Positive = range closing, negative = opening. Uses ENU components relative to friendly.
  const [vFx, vFy] = vectorFromHeading(fSpeedMs, fHeadingDeg)
  const [vHx, vHy] = vectorFromHeading(hSpeedMs, hCourseDeg)
  const vRx = vFx - vHx
  const vRy = vFy - vHy
  // Range vector F→H in local tangent plane (small-angle ok, only sign + relative magnitude matter).
  const R = distanceBetween([fLon, fLat], [hLon, hLat])
  if (R < 1e-6) return 0
  const brg = bearingBetween([fLon, fLat], [hLon, hLat]) * DEG
  const rx = Math.sin(brg)
  const ry = Math.cos(brg)
  return vRx * rx + vRy * ry
}

/**
 * Solve for an intercept point given:
 *   - Friendly position (fLon, fLat) and speed (fSpeedMs, m/s)
 *   - Hostile position (hLon, hLat), speed (hSpeedMs, m/s), and course (hCourse, degrees)
 *   - Desired intercept geometry: range from hostile (rangeM, meters, 0 = direct) and
 *     bearing relative to hostile heading (bearing, degrees: 0=ahead, 90=right,
 *     180=tail, 270=left). Bearing is ignored when rangeM is 0.
 *
 * Returns one of:
 *   { heading, tti, interceptLon, interceptLat, closingSpeedMs }
 *   { error: string }
 */
export function solveIntercept({ fLon, fLat, fSpeedMs, hLon, hLat, hSpeedMs, hCourse, rangeM, bearing }) {
  if (fSpeedMs <= 0) return { error: 'No friendly speed' }
  if (rangeM < 0) return { error: 'Invalid range' }

  const absIntercept = ((hCourse + bearing) % 360 + 360) % 360

  // ---- Stationary hostile ----
  if (hSpeedMs < 0.01) {
    const P = rangeM === 0 ? [hLon, hLat] : destinationPoint([hLon, hLat], rangeM, absIntercept)
    const dist = distanceBetween([fLon, fLat], P)
    if (dist < 1) {
      return { heading: 0, tti: 0, interceptLon: P[0], interceptLat: P[1], closingSpeedMs: 0 }
    }
    const heading = bearingBetween([fLon, fLat], P)
    return {
      heading: Math.round(heading),
      tti: Math.round(dist / fSpeedMs),
      interceptLon: P[0],
      interceptLat: P[1],
      closingSpeedMs: fSpeedMs
    }
  }

  // ---- Moving hostile — iterative solver ----
  let T = 0
  let P = null

  for (let i = 0; i < 60; i++) {
    const Ht = destinationPoint([hLon, hLat], hSpeedMs * T, hCourse)
    P = rangeM === 0 ? Ht : destinationPoint(Ht, rangeM, absIntercept)

    const dist = distanceBetween([fLon, fLat], P)

    if (dist < 1) {
      return { heading: 0, tti: 0, interceptLon: P[0], interceptLat: P[1], closingSpeedMs: 0 }
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

  const heading = bearingBetween([fLon, fLat], P)
  const closingSpeedMs = closingSpeedForAim(fLon, fLat, fSpeedMs, heading, hLon, hLat, hSpeedMs, hCourse)

  return {
    heading: Math.round(heading),
    tti: Math.round(T),
    interceptLon: P[0],
    interceptLat: P[1],
    closingSpeedMs
  }
}

/**
 * Closest point of approach — used when the friendly can't catch the hostile.
 * Finds the heading that minimizes |F(t) - H(t)|² subject to |vF| = fSpeedMs,
 * along with the time-to-CPA and the minimum range.
 *
 * Returns:
 *   { heading, tti, aimCoord, missDistance, closingSpeedMs }
 *   { error: 'Diverging — friendly can only open the range' } when no CPA exists
 *   in the future (t* ≤ 0) and the friendly is slower than the hostile.
 */
export function solveCpa({ fLon, fLat, fSpeedMs, hLon, hLat, hSpeedMs, hCourse }) {
  if (fSpeedMs <= 0) return { error: 'No friendly speed' }

  // Work in a local ENU tangent plane centered on the friendly.
  const R0 = distanceBetween([fLon, fLat], [hLon, hLat])
  if (R0 < 1) {
    return {
      heading: 0,
      tti: 0,
      aimCoord: [hLon, hLat],
      missDistance: 0,
      closingSpeedMs: 0
    }
  }

  const brg0 = bearingBetween([fLon, fLat], [hLon, hLat]) * DEG
  const r0x = R0 * Math.sin(brg0)
  const r0y = R0 * Math.cos(brg0)

  const [vHx, vHy] = vectorFromHeading(hSpeedMs, hCourse)

  // Sample headings at 1°, refine best at 0.05°.
  let best = null
  const evaluate = (hdgDeg) => {
    const [vFx, vFy] = vectorFromHeading(fSpeedMs, hdgDeg)
    const vRx = vFx - vHx
    const vRy = vFy - vHy
    const vR2 = vRx * vRx + vRy * vRy
    if (vR2 < 1e-9) {
      // Relative velocity zero — range stays R0 forever.
      return { hdg: hdgDeg, tti: 0, miss: R0, diverging: false }
    }
    // Relative position vector initial: H - F = (r0x, r0y). Friendly picks vF so
    // the range to the hostile over time is |(r0x, r0y) + (-vRx, -vRy)*t|.
    // Actually position delta H(t) - F(t) = (r0x + vHx*t) - (vFx*t, vFy*t)
    //                                     = (r0x + (vHx - vFx)*t, r0y + (vHy - vFy)*t)
    // Let wx = vHx - vFx = -vRx, wy = vHy - vFy = -vRy.
    // |D(t)|² = (r0x + wx*t)² + (r0y + wy*t)²
    // d/dt = 0 at t* = -(r0x*wx + r0y*wy) / (wx² + wy²) = (r0x*vRx + r0y*vRy) / vR²
    const tStar = (r0x * vRx + r0y * vRy) / vR2
    const diverging = tStar <= 0
    const t = Math.max(tStar, 0)
    const dx = r0x + (-vRx) * t
    const dy = r0y + (-vRy) * t
    const miss = Math.sqrt(dx * dx + dy * dy)
    return { hdg: hdgDeg, tti: t, miss, diverging }
  }

  for (let hdg = 0; hdg < 360; hdg += 1) {
    const e = evaluate(hdg)
    if (e.diverging) continue
    if (!best || e.miss < best.miss) best = e
  }

  if (!best) {
    return { error: 'Diverging — friendly can only open the range' }
  }

  // Refine around the best heading in ±1° with 0.05° steps.
  const center = best.hdg
  for (let d = -1; d <= 1; d += 0.05) {
    const hdg = ((center + d) % 360 + 360) % 360
    const e = evaluate(hdg)
    if (e.diverging) continue
    if (e.miss < best.miss) best = e
  }

  // Cap ridiculous TTIs the same way the intercept solver does.
  if (!isFinite(best.tti) || best.tti > 7200) {
    return { error: 'Diverging — friendly can only open the range' }
  }

  // Aim point = hostile position at t = tti.
  const aimCoord = destinationPoint([hLon, hLat], hSpeedMs * best.tti, hCourse)
  const closingSpeedMs = closingSpeedForAim(fLon, fLat, fSpeedMs, best.hdg, hLon, hLat, hSpeedMs, hCourse)

  return {
    heading: Math.round(best.hdg),
    tti: Math.round(best.tti),
    aimCoord,
    missDistance: best.miss,
    closingSpeedMs
  }
}

/**
 * Dispatcher: picks solveIntercept for direct/offset and falls back to solveCpa
 * when the friendly can't catch the hostile.
 *
 * spec = {
 *   fLon, fLat, fSpeedMs,
 *   hLon, hLat, hSpeedMs, hCourse,
 *   mode: 'direct' | 'offset',
 *   offsetRange?:   meters   (required in offset mode),
 *   offsetBearing?: degrees  (required in offset mode)
 * }
 *
 * Returns:
 *   { type: 'intercept', heading, tti, aimCoord, closingSpeedMs }
 *   { type: 'cpa',       heading, tti, aimCoord, missDistance, closingSpeedMs }
 *   { error: string }
 */
export function solve(spec) {
  const rangeM = spec.mode === 'offset' ? Number(spec.offsetRange) || 0 : 0
  const bearing = spec.mode === 'offset' ? Number(spec.offsetBearing) || 0 : 0

  const r = solveIntercept({
    fLon: spec.fLon, fLat: spec.fLat, fSpeedMs: spec.fSpeedMs,
    hLon: spec.hLon, hLat: spec.hLat, hSpeedMs: spec.hSpeedMs, hCourse: spec.hCourse,
    rangeM, bearing
  })

  if (!r.error) {
    return {
      type: 'intercept',
      heading: r.heading,
      tti: r.tti,
      aimCoord: [r.interceptLon, r.interceptLat],
      closingSpeedMs: r.closingSpeedMs
    }
  }

  if (r.error === 'No solution — friendly speed too low') {
    const cpa = solveCpa({
      fLon: spec.fLon, fLat: spec.fLat, fSpeedMs: spec.fSpeedMs,
      hLon: spec.hLon, hLat: spec.hLat, hSpeedMs: spec.hSpeedMs, hCourse: spec.hCourse
    })
    if (cpa.error) return { error: cpa.error }
    return {
      type: 'cpa',
      heading: cpa.heading,
      tti: cpa.tti,
      aimCoord: cpa.aimCoord,
      missDistance: cpa.missDistance,
      closingSpeedMs: cpa.closingSpeedMs
    }
  }

  return { error: r.error }
}
