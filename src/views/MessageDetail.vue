<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { EventRow, MessageRow } from '../../shared/types';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import StatusPill from '../components/StatusPill.vue';
import { fullTime, levelBadge, levelText, sourceText } from '../format';

const props = defineProps<{ id: string }>();
const message = ref<MessageRow>();
const events = ref<EventRow[]>([]);
const error = ref('');

async function load() {
  try {
    const r = await api<{ message: MessageRow; events: EventRow[] }>(`/messages/${props.id}`);
    message.value = r.message;
    events.value = r.events;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function stop() {
  await api(`/messages/${props.id}/stop`, { body: {} });
  await load();
}
const dotTone = (kind: string) =>
  /error|failed|unanswered|timeout/.test(kind)
    ? 'bg-rose-500'
    : /confirmed|answered|sms_sent/.test(kind)
      ? 'bg-sage-600'
      : 'bg-line';

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  timer = setInterval(() => message.value?.status === 'calling' && load(), 4000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="space-y-6">
    <RouterLink to="/admin/messages" class="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
      <Icon name="back" :size="16" /> Messages
    </RouterLink>
    <p v-if="error" class="text-rose-600">{{ error }}</p>
    <template v-if="message">
      <section class="card">
        <div class="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span class="rounded-full px-2.5 py-0.5 text-xs font-medium" :class="levelBadge[message.level]">{{
            levelText[message.level]
          }}</span>
          <StatusPill :status="message.status" />
          <span>{{ sourceText[message.source] }} · {{ fullTime(message.received_at) }}</span>
        </div>
        <h1 v-if="message.subject" class="mt-4 text-xl font-semibold">{{ message.subject }}</h1>
        <p class="mt-3 text-lg leading-relaxed whitespace-pre-wrap">{{ message.body || '(empty)' }}</p>
        <p v-if="message.insight" class="mt-4 rounded-2xl bg-lav-50 px-4 py-3 text-lav-600">
          <span class="font-semibold">AI note:</span> {{ message.insight }}
        </p>
        <dl class="mt-5 grid gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-muted">From</dt>
            <dd>{{ message.sender || '—' }}</dd>
          </div>
          <div>
            <dt class="text-muted">Why this level</dt>
            <dd>{{ message.reason }}</dd>
          </div>
          <div v-if="message.acknowledged_by">
            <dt class="text-muted">Confirmed by</dt>
            <dd>{{ message.acknowledged_by }}</dd>
          </div>
        </dl>
        <button v-if="message.status === 'calling'" class="btn-danger mt-5" @click="stop">
          Stop calling
        </button>
      </section>

      <section class="card">
        <h2 class="section-title">What happened</h2>
        <ol class="mt-4 space-y-0">
          <li v-for="(e, i) in events" :key="e.id" class="relative flex gap-4 pb-5">
            <span v-if="i < events.length - 1" class="absolute top-4 left-[5px] h-full w-px bg-line" />
            <span
              class="relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-surface"
              :class="dotTone(e.kind)"
            />
            <div>
              <p>{{ e.detail || e.kind }}</p>
              <p class="text-sm text-faint">{{ fullTime(e.ts) }}</p>
            </div>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
