import { PluginRegistry } from './executor'
import { acsHousingPlugin } from './plugins/acs'
import { epaNwiContextPlugin } from './plugins/epa-nwi'
import { cdcPlacesPlugin } from './plugins/keyless'
import { STATE_SCHOOL_PLUGINS } from './plugins/ny-schools'
import { nationalSchoolOutcomesPlugin } from './plugins/school-outcomes'
import { ncesSchoolCorePlugin } from './plugins/schools'

/** Sources fetched automatically when a ZIP is opened, in display order. */
const DRILLDOWN_PLUGINS = [
  cdcPlacesPlugin,
  ncesSchoolCorePlugin,
  epaNwiContextPlugin,
  nationalSchoolOutcomesPlugin,
  // Each state plugin covers its own state and safely returns no rows elsewhere.
  ...STATE_SCHOOL_PLUGINS,
]

/** All sources available to the app; ACS powers the initial housing screen. */
export const registry = new PluginRegistry().registerAll([
  acsHousingPlugin,
  ...DRILLDOWN_PLUGINS,
])

/** The executor takes IDs, so derive them from the source list rather than repeat them. */
export const DRILLDOWN_PLUGIN_IDS = DRILLDOWN_PLUGINS.map((plugin) => plugin.id)

const SCHOOL_PLUGIN_IDS = new Set([
  ncesSchoolCorePlugin.id,
  nationalSchoolOutcomesPlugin.id,
  ...STATE_SCHOOL_PLUGINS.map((plugin) => plugin.id),
])

export function isSchoolPlugin(pluginId: string): boolean {
  return SCHOOL_PLUGIN_IDS.has(pluginId)
}
