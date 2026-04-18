<script setup>
import { useDisplay } from 'vuetify'

const { mdAndUp, smAndDown } = useDisplay()

const emit = defineEmits(['toggle-draw', 'toggle-layers', 'toggle-route', 'toggle-overlays', 'toggle-measure', 'toggle-bloodhound', 'toggle-perimeter', 'toggle-track-drop', 'toggle-track-list', 'toggle-ghost', 'toggle-intercept', 'toggle-ais', 'toggle-listeners', 'toggle-settings', 'exit-mission', 'toggle-io'])

const props = defineProps({
  drawPanelOpen: Boolean,
  layersPanelOpen: Boolean,
  overlaysDialogOpen: Boolean,
  measuring: Boolean,
  bloodhoundPanelOpen: Boolean,
  perimeterPanelOpen: Boolean,
  routing: Boolean,
  trackDropPanelOpen: Boolean,
  trackListOpen: Boolean,
  ghostPanelOpen: Boolean,
  interceptPanelOpen: Boolean,
  aisPanelOpen: Boolean,
  missionName: { type: String, default: '' },
  pluginButtons: { type: Array, default: () => [] }
})

// True when any button in that group is active — used to highlight the group activator in collapsed mode.
const annotationActive = () => props.drawPanelOpen || props.layersPanelOpen || props.routing || props.trackDropPanelOpen || props.trackListOpen
const analysisActive   = () => props.measuring || props.bloodhoundPanelOpen || props.perimeterPanelOpen
const operationsActive = () => props.ghostPanelOpen || props.interceptPanelOpen
const feedsActive      = () => props.aisPanelOpen
</script>

<template>
  <v-toolbar density="compact" color="surface">
    <div class="d-flex align-center ga-1 px-2">

      <!-- Mission nav -->
      <v-tooltip text="Missions" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn
            v-bind="tip"
            icon="mdi-chevron-left"
            size="small"
            class="text-medium-emphasis"
            @click="emit('exit-mission')"
          />
        </template>
      </v-tooltip>

      <span v-if="missionName && !smAndDown" class="text-body-2 text-medium-emphasis mission-name">
        {{ missionName }}
      </span>

      <v-divider vertical class="mx-2 toolbar-divider" />

      <!-- ============================================================ -->
      <!--  WIDE layout (mdAndUp): flat buttons per group               -->
      <!-- ============================================================ -->
      <template v-if="mdAndUp">

        <!-- Annotation -->
        <v-tooltip text="Draw" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-pencil-outline" size="small"
              :color="drawPanelOpen ? 'primary' : undefined"
              :class="[drawPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-draw')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Layers" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-layers-outline" size="small"
              :color="layersPanelOpen ? 'primary' : undefined"
              :class="[layersPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-layers')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Route" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-routes" size="small"
              :color="routing ? 'primary' : undefined"
              :class="[routing ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-route')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Overlays" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-shape-outline" size="small"
              class="text-medium-emphasis"
              @click="emit('toggle-overlays')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Track Drop" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-map-marker-account" size="small"
              :color="trackDropPanelOpen ? 'primary' : undefined"
              :class="[trackDropPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-track-drop')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Track List" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-format-list-bulleted" size="small"
              :color="trackListOpen ? 'primary' : undefined"
              :class="[trackListOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-track-list')" />
          </template>
        </v-tooltip>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Analysis -->
        <v-tooltip text="Measure" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-ruler" size="small"
              :color="measuring ? 'primary' : undefined"
              :class="[measuring ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-measure')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Bloodhound" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-map-marker-distance" size="small"
              :color="bloodhoundPanelOpen ? 'primary' : undefined"
              :class="[bloodhoundPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-bloodhound')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Perimeter" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-shield-outline" size="small"
              :color="perimeterPanelOpen ? 'primary' : undefined"
              :class="[perimeterPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-perimeter')" />
          </template>
        </v-tooltip>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Operations -->
        <v-tooltip text="Ghosts" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-ghost" size="small"
              :color="ghostPanelOpen ? 'primary' : undefined"
              :class="[ghostPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-ghost')" />
          </template>
        </v-tooltip>

        <v-tooltip text="Intercept" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-target" size="small"
              :color="interceptPanelOpen ? 'primary' : undefined"
              :class="[interceptPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-intercept')" />
          </template>
        </v-tooltip>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Feeds -->
        <v-tooltip text="AIS Feed" location="bottom">
          <template #activator="{ props: tip }">
            <v-btn v-bind="tip" icon="mdi-ferry" size="small"
              :color="aisPanelOpen ? 'primary' : undefined"
              :class="[aisPanelOpen ? 'toolbar-active' : 'text-medium-emphasis']"
              @click="emit('toggle-ais')" />
          </template>
        </v-tooltip>

      </template>

      <!-- ============================================================ -->
      <!--  NARROW layout (<mdAndUp): one dropdown per group            -->
      <!-- ============================================================ -->
      <template v-else>

        <!-- Annotation group -->
        <v-menu location="bottom">
          <template #activator="{ props: menu }">
            <v-btn v-bind="menu" icon="mdi-pencil-outline" size="small"
              :color="annotationActive() ? 'primary' : undefined"
              :class="[annotationActive() ? 'toolbar-active' : 'text-medium-emphasis']" />
          </template>
          <v-list density="compact" nav>
            <v-list-item prepend-icon="mdi-pencil-outline" title="Draw"
              :active="drawPanelOpen" active-color="primary"
              @click="emit('toggle-draw')" />
            <v-list-item prepend-icon="mdi-layers-outline" title="Layers"
              :active="layersPanelOpen" active-color="primary"
              @click="emit('toggle-layers')" />
            <v-list-item prepend-icon="mdi-routes" title="Route"
              :active="routing" active-color="primary"
              @click="emit('toggle-route')" />
            <v-list-item prepend-icon="mdi-shape-outline" title="Overlays"
              @click="emit('toggle-overlays')" />
            <v-list-item prepend-icon="mdi-map-marker-account" title="Track Drop"
              :active="trackDropPanelOpen" active-color="primary"
              @click="emit('toggle-track-drop')" />
            <v-list-item prepend-icon="mdi-format-list-bulleted" title="Track List"
              :active="trackListOpen" active-color="primary"
              @click="emit('toggle-track-list')" />
          </v-list>
        </v-menu>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Analysis group -->
        <v-menu location="bottom">
          <template #activator="{ props: menu }">
            <v-btn v-bind="menu" icon="mdi-ruler" size="small"
              :color="analysisActive() ? 'primary' : undefined"
              :class="[analysisActive() ? 'toolbar-active' : 'text-medium-emphasis']" />
          </template>
          <v-list density="compact" nav>
            <v-list-item prepend-icon="mdi-ruler" title="Measure"
              :active="measuring" active-color="primary"
              @click="emit('toggle-measure')" />
            <v-list-item prepend-icon="mdi-map-marker-distance" title="Bloodhound"
              :active="bloodhoundPanelOpen" active-color="primary"
              @click="emit('toggle-bloodhound')" />
            <v-list-item prepend-icon="mdi-shield-outline" title="Perimeter"
              :active="perimeterPanelOpen" active-color="primary"
              @click="emit('toggle-perimeter')" />
          </v-list>
        </v-menu>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Operations group -->
        <v-menu location="bottom">
          <template #activator="{ props: menu }">
            <v-btn v-bind="menu" icon="mdi-target" size="small"
              :color="operationsActive() ? 'primary' : undefined"
              :class="[operationsActive() ? 'toolbar-active' : 'text-medium-emphasis']" />
          </template>
          <v-list density="compact" nav>
            <v-list-item prepend-icon="mdi-ghost" title="Ghosts"
              :active="ghostPanelOpen" active-color="primary"
              @click="emit('toggle-ghost')" />
            <v-list-item prepend-icon="mdi-target" title="Intercept"
              :active="interceptPanelOpen" active-color="primary"
              @click="emit('toggle-intercept')" />
          </v-list>
        </v-menu>

        <v-divider vertical class="mx-2 toolbar-divider" />

        <!-- Feeds group -->
        <v-menu location="bottom">
          <template #activator="{ props: menu }">
            <v-btn v-bind="menu" icon="mdi-rss" size="small"
              :color="feedsActive() ? 'primary' : undefined"
              :class="[feedsActive() ? 'toolbar-active' : 'text-medium-emphasis']" />
          </template>
          <v-list density="compact" nav>
            <v-list-item prepend-icon="mdi-ferry" title="AIS Feed"
              :active="aisPanelOpen" active-color="primary"
              @click="emit('toggle-ais')" />
          </v-list>
        </v-menu>

      </template>

      <!-- ============================================================ -->
      <!--  Plugin buttons: always a single dropdown                    -->
      <!-- ============================================================ -->
      <template v-if="pluginButtons.length > 0">
        <v-divider vertical class="mx-2 toolbar-divider" />
        <v-menu location="bottom">
          <template #activator="{ props: menu }">
            <v-tooltip text="Plugins" location="bottom">
              <template #activator="{ props: tip }">
                <v-btn v-bind="{ ...menu, ...tip }" icon="mdi-puzzle-outline" size="small"
                  class="text-medium-emphasis" />
              </template>
            </v-tooltip>
          </template>
          <v-list density="compact" nav>
            <v-list-item
              v-for="btn in pluginButtons"
              :key="btn.id"
              :prepend-icon="btn.icon"
              :title="btn.tooltip || btn.id"
              @click="btn.onClick"
            />
          </v-list>
        </v-menu>
      </template>

    </div>

    <v-spacer />

    <!-- Right cluster: always pinned -->
    <div class="d-flex align-center ga-1 px-2">
      <v-tooltip text="Import / Export" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-swap-vertical" size="small"
            class="text-medium-emphasis"
            @click="emit('toggle-io')" />
        </template>
      </v-tooltip>

      <v-divider vertical class="mx-2 toolbar-divider" />

      <v-tooltip text="Listeners" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-access-point" size="small"
            class="text-medium-emphasis"
            @click="emit('toggle-listeners')" />
        </template>
      </v-tooltip>

      <v-tooltip text="Settings" location="bottom">
        <template #activator="{ props: tip }">
          <v-btn v-bind="tip" icon="mdi-cog-outline" size="small"
            class="text-medium-emphasis"
            @click="emit('toggle-settings')" />
        </template>
      </v-tooltip>
    </div>
  </v-toolbar>
</template>

<style scoped>
.toolbar-active {
  background: rgba(var(--v-theme-surface-light), 0.6);
}

.mission-name {
  max-width: 240px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar-divider {
  border-color: rgba(var(--v-theme-on-surface), 0.7) !important;
}
</style>
