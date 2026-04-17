const MIN_SIZE = 1
const STEP = 0.05

function toNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function snap(v, step = STEP) {
  return step > 0 ? Math.round(v / step) * step : v
}

function toRect(layout) {
  return {
    x: Math.max(0, snap(toNum(layout?.x, 0))),
    y: Math.max(0, snap(toNum(layout?.y, 0))),
    w: Math.max(MIN_SIZE, snap(toNum(layout?.w, 1))),
    h: Math.max(MIN_SIZE, snap(toNum(layout?.h, 1))),
  }
}

export function clampLayout(layout) {
  return toRect(layout)
}

export function detectCollision(a, b) {
  const r1 = toRect(a)
  const r2 = toRect(b)
  return !(r1.x + r1.w <= r2.x || r2.x + r2.w <= r1.x || r1.y + r1.h <= r2.y || r2.y + r2.h <= r1.y)
}

export function placeNewCard(existingCards, defaultW = 3, defaultH = 2, cols = 12) {
  const maxCols = Math.max(MIN_SIZE, toNum(cols, 12))
  const w = Math.min(maxCols, Math.max(MIN_SIZE, snap(toNum(defaultW, 3))))
  const h = Math.max(MIN_SIZE, snap(toNum(defaultH, 2)))
  const cards = Array.isArray(existingCards) ? existingCards : []

  for (let y = 0; y <= 400; y += STEP) {
    for (let x = 0; x <= cols - w; x += STEP) {
      const candidate = { x, y, w, h }
      if (!cards.some(c => detectCollision(candidate, c.layout || c))) return candidate
    }
  }

  const lowestY = cards.reduce((max, c) => {
    const l = clampLayout(c.layout || c)
    return Math.max(max, l.y + l.h)
  }, 0)
  return { x: 0, y: lowestY, w, h }
}
