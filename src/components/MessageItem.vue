<script setup lang="ts">
import type { MessageRow } from '../../shared/types';
import { levelDot, levelText, sourceText, timeAgo } from '../format';
import Icon from './Icon.vue';
import StatusPill from './StatusPill.vue';

defineProps<{ m: MessageRow }>();
</script>

<template>
  <RouterLink
    :to="`/admin/messages/${m.id}`"
    class="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-paper/60 sm:px-6"
  >
    <span
      class="mt-1.5 size-2.5 shrink-0 rounded-full"
      :class="levelDot[m.level]"
      :title="levelText[m.level]"
    />
    <div class="min-w-0 flex-1">
      <p class="line-clamp-2 text-[1.02rem] leading-snug">
        <span v-if="m.subject" class="font-medium">{{ m.subject }} · </span>{{ m.body || '(empty)' }}
      </p>
      <p v-if="m.insight" class="mt-1 line-clamp-1 text-sm text-muted italic">{{ m.insight }}</p>
      <p class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <span>{{ timeAgo(m.received_at) }}</span>
        <span aria-hidden="true">·</span>
        <span>{{ sourceText[m.source] }}</span>
        <StatusPill :status="m.status" class="ml-1" />
      </p>
    </div>
    <Icon name="chevron" class="mt-1 shrink-0 text-faint group-hover:text-muted" />
  </RouterLink>
</template>
