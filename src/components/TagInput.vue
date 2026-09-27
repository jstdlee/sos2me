<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';

const model = defineModel<string[]>({ required: true });
defineProps<{ placeholder?: string }>();
const draft = ref('');

function add() {
  const parts = draft.value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const next = [...model.value];
  for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
  model.value = next;
  draft.value = '';
}
function remove(i: number) {
  model.value = model.value.filter((_, j) => j !== i);
}
</script>

<template>
  <div
    class="rounded-xl border border-line bg-surface p-2 focus-within:border-sage-500 focus-within:ring-2 focus-within:ring-sage-100"
  >
    <div class="flex flex-wrap gap-1.5">
      <span
        v-for="(t, i) in model"
        :key="t"
        class="inline-flex items-center gap-1 rounded-full bg-paper py-1 pr-1.5 pl-3 text-sm"
      >
        {{ t }}
        <button
          type="button"
          class="rounded-full p-0.5 text-faint hover:bg-line hover:text-ink"
          :aria-label="`Remove ${t}`"
          @click="remove(i)"
        >
          <Icon name="x" :size="14" />
        </button>
      </span>
      <input
        v-model="draft"
        class="min-w-[10rem] flex-1 bg-transparent px-2 py-1 outline-none placeholder:text-faint"
        :placeholder="placeholder ?? 'Type and press Enter'"
        @keydown.enter.prevent="add"
        @blur="draft && add()"
      />
    </div>
  </div>
</template>
