<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <label class="flex cursor-pointer items-start justify-between gap-4 py-1">
    <span>
      <span class="block font-medium">{{ label }}</span>
      <span v-if="hint" class="hint block">{{ hint }}</span>
    </span>
    <span class="relative mt-0.5 inline-flex shrink-0">
      <input v-model="model" type="checkbox" class="peer sr-only" />
      <span
        class="h-7 w-12 rounded-full bg-line transition-colors peer-checked:bg-sage-600 peer-focus-visible:ring-2 peer-focus-visible:ring-sage-500 peer-focus-visible:ring-offset-2"
      />
      <span
        class="absolute top-1 left-1 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
      />
    </span>
  </label>
</template>
