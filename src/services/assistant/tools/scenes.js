export function scenesTools({ scenesStore }) {
  return [
    {
      name: 'scenes_list',
      description: 'List all saved scenes (custom dashboards).',
      readonly: true,
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      async handler() {
        return scenesStore.scenes.map(s => ({
          id: s.id,
          label: s.label,
          icon: s.icon,
          cardCount: (s.cards ?? []).length
        }))
      }
    },
    {
      name: 'scenes_create_scene',
      description: 'Create a new scene (dashboard) with a given name.',
      readonly: false,
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Name for the new scene.' },
          icon: { type: 'string', description: 'Optional MDI icon name, e.g. mdi-view-dashboard-outline.' }
        },
        required: ['label']
      },
      previewRender({ label, icon }) {
        const iconStr = icon ? ` · ${icon}` : ''
        return `New scene: "${label}"${iconStr}`
      },
      async handler({ label, icon }) {
        const id = await scenesStore.createScene({ label, icon })
        return { id, success: true }
      }
    }
  ]
}
