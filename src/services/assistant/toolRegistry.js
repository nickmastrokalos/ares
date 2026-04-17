// Each registered token maps to an array of ToolDefs.
// ToolDef = { name, description, inputSchema, handler, readonly, previewRender? }
//
// readonly: true  → handler runs immediately when the model calls the tool.
// readonly: false → handler is queued; the UI shows a confirm card first.
// previewRender(args) → string shown in the confirm card body.

const registry = new Map()

export function register(defs) {
  const token = Symbol()
  registry.set(token, defs)
  return token
}

export function unregister(token) {
  registry.delete(token)
}

export function list() {
  const all = []
  for (const defs of registry.values()) {
    all.push(...defs)
  }
  return all
}

export function getByName(name) {
  for (const defs of registry.values()) {
    const found = defs.find(d => d.name === name)
    if (found) return found
  }
  return null
}
