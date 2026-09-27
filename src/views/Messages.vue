<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Level, MessageRow } from '../../shared/types';
import { levelText } from '../format';
import { api } from '../api';
import MessageItem from '../components/MessageItem.vue';

const items = ref<MessageRow[]>([]);
const filter = ref<'all' | Level>('all');
const more = ref(true);
const loading = ref(false);
const PAGE = 30;

async function loadMore() {
  loading.value = true;
  const before = items.value.at(-1)?.received_at;
  const page = await api<MessageRow[]>(
    `/messages?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
  );
  items.value.push(...page);
  more.value = page.length === PAGE;
  loading.value = false;
}
const shown = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter((m) => m.level === filter.value),
);
onMounted(loadMore);
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Messages</h1>
      <div class="flex rounded-full border border-line bg-surface p-1 text-sm" role="tablist">
        <button
          v-for="f in ['all', 'urgent', 'concern', 'normal'] as const"
          :key="f"
          role="tab"
          :aria-selected="filter === f"
          class="rounded-full px-3.5 py-1.5"
          :class="filter === f ? 'bg-sage-600 text-white' : 'text-muted hover:text-ink'"
          @click="filter = f"
        >
          {{ f === 'all' ? 'All' : levelText[f] }}
        </button>
      </div>
    </div>
    <section class="card !p-0">
      <div v-if="shown.length" class="divide-y divide-line">
        <MessageItem v-for="m in shown" :key="m.id" :m="m" />
      </div>
      <p v-else-if="!loading" class="p-6 text-muted">Nothing here yet.</p>
    </section>
    <div v-if="more" class="text-center">
      <button class="btn-quiet" :disabled="loading" @click="loadMore">
        {{ loading ? 'Loading…' : 'Load older' }}
      </button>
    </div>
  </div>
</template>
