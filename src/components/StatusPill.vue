<script setup lang="ts">
import { computed } from 'vue';
import type { AlertStatus } from '../../shared/types';
import { statusText } from '../format';

const props = defineProps<{ status: AlertStatus }>();
const tone = computed(() => {
  switch (props.status) {
    case 'calling':
      return 'bg-lav-100 text-lav-600';
    case 'confirmed':
    case 'answered':
    case 'texted':
      return 'bg-sage-100 text-sage-700';
    case 'unanswered':
    case 'failed':
      return 'bg-rose-100 text-rose-600';
    default:
      return 'bg-paper text-muted';
  }
});
</script>

<template>
  <span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" :class="tone">
    <span v-if="status === 'calling'" class="size-1.5 animate-pulse rounded-full bg-current" />
    {{ statusText[status] }}
  </span>
</template>
