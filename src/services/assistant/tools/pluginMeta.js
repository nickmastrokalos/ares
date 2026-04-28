// Plugin-capability discovery for the assistant. The host indexes
// each plugin's manifest `provides` block at load time (regardless
// of activation), so even disabled plugins can advertise what they
// *would* contribute. The model uses this when it can't satisfy a
// request out of the box — to tell the user "enable plugin X to
// unlock that".
//
// `plugin_capabilities_list` is the single discovery surface; the
// routing-specific `routing_list_avoidances` / `routing_list_evaluators`
// tools cover the same ground for routing-only flows but this one
// is the right call when the user mentions ANY plugin-typed
// capability and the model wants to know what's available vs.
// what's a click away.

export function pluginMetaTools({ pluginCapabilities }) {
  return [
    {
      name: 'plugin_capabilities_list',
      description:
        'List every plugin-contributed capability the host knows about, split into ' +
        '`enabled` (currently registered with the host — assistant tools, route-planner ' +
        'avoidances, and route-planner evaluators) and `disabled` (plugins that are ' +
        'loaded on disk but currently inactive or incompatible — they have declared ' +
        'capabilities in their manifest `provides` block but those capabilities are not ' +
        'live right now). Use this when the user asks for something you can\'t do — if ' +
        'the relevant capability appears under `disabled`, tell them which plugin to ' +
        'enable in Settings → Plugins (using the `plugin.name` field) instead of refusing. ' +
        'Each disabled block carries a `reason` (`plugin_disabled` for a plugin the user ' +
        'can simply turn on, `plugin_incompatible` for one that needs a host upgrade, ' +
        '`plugin_not_registered` for a plugin that\'s active but didn\'t register the ' +
        'declared capability — typically a plugin bug worth surfacing). Read-only.',
      readonly: true,
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        if (typeof pluginCapabilities?.list !== 'function') {
          return { enabled: { tools: [], avoidances: [], evaluators: [] }, disabled: [] }
        }
        return pluginCapabilities.list()
      }
    }
  ]
}
