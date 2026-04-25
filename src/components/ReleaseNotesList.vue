<script setup>
import { computed } from 'vue'
import { RELEASES } from '@/data/releaseNotes'
import { compareSemver } from '@/services/version'

const props = defineProps({
  // Optional: only show entries whose version is strictly greater than this.
  // Used by the post-update overlay; the Settings tab passes nothing.
  sinceVersion: { type: String, default: null }
})

const SECTION_META = [
  { key: 'added',   label: 'Added',   icon: 'mdi-plus-circle-outline'   },
  { key: 'changed', label: 'Changed', icon: 'mdi-circle-edit-outline'   },
  { key: 'fixed',   label: 'Fixed',   icon: 'mdi-wrench-outline'        }
]

// `version: 'unreleased'` is a WIP entry the dev accumulates between version
// bumps — never shown to users. It gets stamped with a real version + date
// at bump time. See docs/release-notes.md.
const visible = computed(() => {
  const released = RELEASES.filter(r => r.version !== 'unreleased')
  if (!props.sinceVersion) return released
  return released.filter(r => compareSemver(r.version, props.sinceVersion) > 0)
})

function nonEmptySections(release) {
  return SECTION_META.filter(s => Array.isArray(release[s.key]) && release[s.key].length > 0)
}
</script>

<template>
  <div v-if="visible.length === 0" class="empty text-caption text-medium-emphasis">
    No release notes available.
  </div>

  <div
    v-for="release in visible"
    :key="release.version"
    class="release"
  >
    <div class="release-header">
      <span class="version">v{{ release.version }}</span>
      <span class="date text-caption text-medium-emphasis">{{ release.date }}</span>
    </div>

    <div
      v-for="section in nonEmptySections(release)"
      :key="section.key"
      class="section"
    >
      <div class="section-label text-caption text-medium-emphasis">
        <v-icon :icon="section.icon" size="12" class="me-1" />
        {{ section.label }}
      </div>
      <ul class="entries">
        <li
          v-for="(item, i) in release[section.key]"
          :key="i"
          class="text-body-2"
        >
          {{ item }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.empty {
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.15);
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}

.release {
  padding: 12px 0;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.release:first-child {
  padding-top: 0;
}

.release:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.release-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.version {
  font-family: monospace;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.date {
  font-family: monospace;
  font-size: 11px;
}

.section {
  margin-top: 6px;
}

.section-label {
  display: flex;
  align-items: center;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
  margin-bottom: 2px;
}

.entries {
  margin: 0;
  padding-left: 20px;
}

.entries li {
  margin-bottom: 2px;
  line-height: 1.4;
}
</style>
