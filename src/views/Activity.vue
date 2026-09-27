<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { EventRow } from '../../shared/types';
import { api } from '../api';
import { fullTime } from '../format';

const events = ref<EventRow[]>([]);
const loading = ref(true);
async function load() {
  loading.value = true;
  events.value = await api<EventRow[]>('/events?limit=200');
  loading.value = false;
}
onMounted(load);
const isProblem = (k: string) => /error|failed|missing|unanswered|timeout|ignored/.test(k);
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Activity</h1>
        <p class="mt-1 text-muted">Everything SOS2me did, newest first. Useful when something didn't ring.</p>
      </div>
      <button class="btn-quiet" @click="load">Refresh</button>
    </div>
    <section class="card !p-0">
      <p v-if="!loading && !events.length" class="p-6 text-muted">Nothing yet.</p>
      <ul class="divide-y divide-line">
        <li
          v-for="e in events"
          :key="e.id"
          class="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:gap-6 sm:px-6"
        >
          <span class="w-44 shrink-0 text-sm text-faint">{{ fullTime(e.ts) }}</span>
          <span class="flex-1">
            <span :class="isProblem(e.kind) && 'text-rose-600'">{{ e.detail || e.kind }}</span>
            <RouterLink
              v-if="e.message_id"
              :to="`/admin/messages/${e.message_id}`"
              class="ml-2 text-sm whitespace-nowrap text-sage-700 hover:underline"
              >view</RouterLink
            >
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
