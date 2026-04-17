<script setup>
defineProps({
  message: { type: Object, required: true }
})

function textBlocks(blocks) {
  if (typeof blocks === 'string') return [blocks]
  return blocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
}

function toolChips(blocks) {
  if (typeof blocks === 'string' || !Array.isArray(blocks)) return []
  return blocks
    .filter(b => b.type === 'tool_use' || b.type === 'tool_result')
    .map(b => b.type === 'tool_use' ? b.name : null)
    .filter(Boolean)
}
</script>

<template>
  <div class="msg-row" :class="message.role">
    <!-- User message -->
    <div v-if="message.role === 'user' && typeof message.blocks === 'string'" class="user-bubble">
      {{ message.blocks }}
    </div>

    <!-- Assistant message -->
    <div v-else-if="message.role === 'assistant'" class="assistant-content">
      <div v-for="(text, i) in textBlocks(message.blocks)" :key="i" class="assistant-text">
        {{ text }}
      </div>
      <div v-if="toolChips(message.blocks).length" class="tool-chips">
        <span v-for="name in toolChips(message.blocks)" :key="name" class="tool-chip">
          • {{ name }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  margin-bottom: 6px;
}

.msg-row.user {
  justify-content: flex-end;
}

.msg-row.assistant {
  justify-content: flex-start;
}

.user-bubble {
  max-width: 80%;
  background: rgba(var(--v-theme-primary), 0.15);
  border: 1px solid rgba(var(--v-theme-primary), 0.25);
  border-radius: 8px 8px 0 8px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.87);
  white-space: pre-wrap;
  word-break: break-word;
}

.assistant-content {
  max-width: 90%;
}

.assistant-text {
  font-size: 12px;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface), 0.87);
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.tool-chip {
  font-size: 10px;
  color: rgba(var(--v-theme-on-surface), 0.45);
  letter-spacing: 0.02em;
}
</style>
