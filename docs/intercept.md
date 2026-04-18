# Intercept

> Live-updating intercept and CPA solutions between a friendly and hostile track, with persistent on-map geometry.

## Overview

An intercept pairs a **hostile** track with a **friendly** track and, given the friendly's speed, computes the heading and time-to-intercept (TTI) needed for the friendly to reach either:

- the hostile itself (**direct**), or
- a point offset from the hostile by a range / relative-bearing pair (**offset** — e.g. "5 nmi off the hostile's starboard beam").

If the friendly is slower than the hostile and can't catch it, the solver falls back to the **closest point of approach (CPA)**: the heading that minimises the separation between the two tracks, along with the miss distance and the time at which it occurs.

Endpoints may be CoT tracks, AIS vessels, or manual-track mission features. Multiple intercepts can run at once; each renders independently on the map and persists even when the panel is closed.

## Entry points

- **Toolbar button** (`mdi-target`, Analysis group alongside Measure, Bloodhound, and Perimeter): opens / closes `CallInterceptorPanel.vue`. Closing the panel does not clear solves — use "Clear all".
- **No assistant tools yet** — out of scope for v1 (see *Out of scope* below).

## Panel UX

`CallInterceptorPanel.vue` mirrors `PerimeterPanel.vue` styling — 280 px rgba surface, draggable header, minimize / close. Sections top-to-bottom:

1. **Header** — target icon, "Intercept" title, minimize, close.
2. **Aim-ring row** — numeric input (meters), committed on blur or Enter. Seeded at 150 m; shared across all solves added after it's changed. Existing solves keep the ring radius they were added with.
3. **Add form** (always visible, inline):
   - **Hostile** select — every live CoT, AIS, and manual track. Meta row shows course + speed (or `"No heading — N assumed"` / `"Stationary"`).
   - **Friendly** select — restricted to **friendly-affiliation tracks only** (CoT and manual tracks with `affiliation === 'f'`). AIS vessels never appear here: AIS has no affiliation field (always treated as unknown) and cannot be used as a friendly asset. Paired with the **SPD** input; speed pre-fills from the selected track and tracks updates until the user edits it, with an `override` / `from track` badge indicating which.
   - **Mode toggle** — *Direct* (default) / *Offset*. In offset mode, **RNG** and **BRG** inputs reveal below.
   - **Add** button — commits the current form as a new row. Selections are preserved so the operator can iterate.
4. **Intercept list** — one row per active solve:
   - Kind icons + hostile callsign → friendly callsign.
   - Status pill — `INTERCEPT` (blue) or `CPA` (amber).
   - Big HDG (3-digit, zero-padded) + TTI (auto-formatted `s` / `m` / `m s`).
   - For CPA rows, a `miss {distance}` line underneath.
   - Closing-speed diagnostic: `closing {speed}` when the range is shrinking, `opening {speed}` when it's growing. Useful signal that an intercept is actually tracking (and is also the whole story for a CPA).
   - For offset rows, an `offset {range} / {bearing}° rel` reminder.
   - **Fly-to** (`mdi-crosshairs-gps`) and **✕** buttons.
5. **Clear all** — visible once at least one intercept exists.

## Endpoint kinds

Endpoint refs are typed, resolved from the live stores on every tick:

| Kind      | Stored fields         | Resolved from            | Notes                                                   |
|-----------|-----------------------|--------------------------|---------------------------------------------------------|
| `cot`     | `uid`                 | `tracksStore.tracks`     | Course / speed from CoT, m/s                            |
| `ais`     | `mmsi`                | `aisStore.vessels`       | `COG` degrees (`-1` = unknown), `SOG` knots → m/s       |
| `feature` | `featureId`           | `featuresStore.features` | Manual tracks only — `course` + `speed` (knots → m/s)   |

Each intercept carries a `friendly.speedOverrideMs` so the panel's from-track/override UX survives a reresolve.

## Reactivity

`useMapIntercepts` installs three watchers — one each on `tracksStore.tracks`, `aisStore.vessels`, `featuresStore.features`. Any one firing triggers `reresolveAll()`, which:

1. **Drops** intercepts whose feature hostile **or** feature friendly was deleted (same authoritative-deletion rule as perimeter and bloodhound). CoT / AIS disappearance does **not** drop the intercept — the geometry freezes at the last-known coord.
2. **Re-resolves** each endpoint's `coord`, `course`, and `speedMs`.
3. **Re-runs the solver** for every intercept.
4. **Rebuilds** the four GeoJSON sources in one batch.

Watchers are lazy — installed on the first `addIntercept` and torn down when the last solve is removed or `clearAll()` is called.

## Solver (`src/services/intercept.js`)

Three entry points:

- **`solveIntercept(...)`** — iterative solver. Given friendly position + speed, hostile position + velocity, and a target offset (`rangeM`, `bearing` relative to hostile heading), iterate on TTI: place the hostile at `hostile + vH * T`, offset to the aim point, set `T := dist(friendly, aim) / fSpeedMs`. Converges in a handful of iterations or returns `"No solution — friendly speed too low"` after the 60-iteration / 2-hour cap. `rangeM === 0` is the *direct* case (aim = hostile).
- **`solveCpa(...)`** — closed-form CPA, then polished. Works in a local ENU tangent plane centred on the friendly. Samples every heading at 1° resolution, refines around the best at 0.05°. For each candidate heading it solves `t* = (r0·vR) / |vR|²` for the time of minimum range, rejecting headings where `t* ≤ 0` (diverging — the range only opens). Returns `{ heading, tti, aimCoord = hostile(t*), missDistance, closingSpeedMs }`, or `"Diverging — friendly can only open the range"` if every heading diverges (the friendly is completely boxed out).
- **`solve(spec)`** — dispatcher. Calls `solveIntercept` for both direct and offset modes and falls back to `solveCpa` **only** on the exact `"No solution — friendly speed too low"` error. Returns `{ type: 'intercept' | 'cpa', heading, tti, aimCoord, missDistance?, closingSpeedMs }`.

**Closing speed** is computed from the ENU components of `vF - vH` projected onto the friendly→hostile range vector. Positive = closing, negative = opening.

## Map layers

Four MapLibre sources / layers, rebuilt on each tick. Feature properties carry the intercept `id` and solution `type` (`intercept` or `cpa`).

| Source                   | Layer                          | Role                                                                    | Paint |
|--------------------------|--------------------------------|-------------------------------------------------------------------------|-------|
| `intercept-host-paths`   | `intercept-host-paths-line`    | Hostile current position → hostile position at TTI                      | `#e53935`, width 1.5, dash `[3, 3]` |
| `intercept-aim-rings`    | `intercept-aim-rings-line`     | Dashed ring (default 150 m) centred on the aim point                    | `#4a9ade` (intercept) / `#ffb300` (cpa), width 1.5, dash `[4, 3]` |
| `intercept-lines`        | `intercept-lines-line`         | Solid line from friendly to aim point                                   | `#4a9ade` / `#ffb300`, width 2 |
| `intercept-aim-markers`  | `intercept-aim-markers-circle` | `✕` glyph centred on the aim point                                      | text colour `#4a9ade` / `#ffb300`, dark halo |

Ring geometry is a 64-segment `circlePolygon` — same geodesic approximation as the perimeter ring. Layer *insertion order* matters: rings and host paths go in first, so the primary intercept line draws over them.

## Programmatic API

`useMapIntercepts(getMap)` returns:

```js
{
  intercepts,             // ComputedRef<InterceptSummary[]>
  aimRingRadius,          // Ref<number> — meters, seeds each new add
  addIntercept(spec) → id | null,
  removeIntercept(id) → boolean,
  setAimRingRadius(r),
  clearAll()
}
```

Spec:

```js
{
  hostile:  { kind, uid? | mmsi? | featureId? },
  friendly: { kind, uid? | mmsi? | featureId?, speedOverrideMs? },
  mode:     'direct' | 'offset',
  offsetRange?:   number,   // meters, offset mode only
  offsetBearing?: number    // degrees, relative to hostile heading, offset mode only
}
```

`InterceptSummary`:

```js
{
  id,
  hostile:  { kind, coord, course, speedMs, label, … },
  friendly: { kind, coord, course, speedMs, label, … },
  mode,
  offsetRange,
  offsetBearing,
  aimRingRadius,
  solution: {
    type:           'intercept' | 'cpa',
    heading,
    tti,
    aimCoord:       [lng, lat],
    missDistance?:  number,  // cpa only
    closingSpeedMs: number
  } | { error: string }
}
```

The composable instance is provided under the `'interceptApi'` inject key from `MapView.vue`. `CallInterceptorPanel.vue` injects it rather than instantiating the composable again.

## Files

| File | Role |
|------|------|
| `src/services/intercept.js`                      | `solveIntercept` (iterative), `solveCpa` (closed-form + refine), `solve(spec)` dispatcher. |
| `src/composables/useMapIntercepts.js`            | Composable — id-keyed state, watchers, four map sources, solver dispatch, programmatic API. |
| `src/components/CallInterceptorPanel.vue`        | Draggable panel — aim-ring, add form (hostile + friendly + mode + offset), intercept list. |
| `src/views/MapView.vue`                          | Instantiates the composable, provides `interceptApi`, mounts the panel. |
| `src/components/MapToolbar.vue`                  | `mdi-target` button in the Analysis group (existing). |

## Out of scope (v1)

- **Assistant tools** — the bundle can be added in a follow-up pass modelled on `perimeterTools`.
- **Persistence across app restarts** — intercepts are ephemeral, matching bloodhound / perimeter / range.
- **Kinematic envelope** — the solver still assumes an instantaneous course change; no minimum turn radius.
- **Multi-leg intercepts** — no waypoint support; the friendly flies a single straight leg to the aim point.
- **Affiliation filtering** in the roster dropdowns — both selects list every track regardless of colour code.
