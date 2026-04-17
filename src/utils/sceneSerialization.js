function stableSerialize(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableSerialize(value[k])}`).join(',')}}`
}

function buildSceneDataKey(cardTypeId, source, controls) {
  return `${cardTypeId}|${source ?? ''}|${stableSerialize(controls ?? {})}`
}

export { stableSerialize, buildSceneDataKey }
