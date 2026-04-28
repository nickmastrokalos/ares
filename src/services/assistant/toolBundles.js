import { mapTools }          from './tools/map'
import { routeTools }        from './tools/routes'
import { waterRoutingTools } from './tools/waterRouting'
import { aisTools }          from './tools/ais'
import { adsbTools }         from './tools/adsb'
import { cotTools }          from './tools/cot'
import { bloodhoundTools }   from './tools/bloodhound'
import { perimeterTools }    from './tools/perimeter'
import { ghostTools }        from './tools/ghosts'
import { annotationTools }   from './tools/annotations'
import { bullseyeTools }     from './tools/bullseye'
import { snapshotTools }     from './tools/snapshot'
import { videoTools }        from './tools/video'
import { pluginMetaTools }   from './tools/pluginMeta'

// One place to aggregate every tool bundle that ships with MapView. Adding
// a new bundle = import + spread here; MapView no longer churns when we
// register tools for new map features. Each factory destructures only the
// deps it needs, so passing the union is safe.
export function buildMapToolBundles(deps) {
  return [
    ...mapTools(deps),
    ...routeTools(deps),
    ...waterRoutingTools(deps),
    ...aisTools(deps),
    ...adsbTools(deps),
    ...cotTools(deps),
    ...bloodhoundTools(deps),
    ...perimeterTools(deps),
    ...ghostTools(deps),
    ...annotationTools(deps),
    ...bullseyeTools(deps),
    ...snapshotTools(deps),
    ...videoTools(deps),
    ...pluginMetaTools(deps)
  ]
}
