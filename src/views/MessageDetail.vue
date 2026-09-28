<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  parseJson,
  type EventRow,
  type MessageContext,
  type MessageRow,
  type Situation,
} from '../../shared/types';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import StatusPill from '../components/StatusPill.vue';
import { fullTime, levelBadge, levelText, sourceText } from '../format';

const props = defineProps<{ id: string }>();
const message = ref<MessageRow>();
const events = ref<EventRow[]>([]);
const error = ref('');
const situation = computed(() => parseJson<Situation>(message.value?.situation));
const ctx = computed(() => parseJson<MessageContext>(message.value?.context));
const mapUrl = computed(() => {
  const g = ctx.value?.gps ?? ctx.value?.ipLocation;
  return g?.lat !== undefined && g.lon !== undefined ? `https://maps.google.com/?q=${g.lat},${g.lon}` : '';
});
const ipPlace = computed(() =>
  [ctx.value?.ipLocation?.city, ctx.value?.ipLocation?.region, ctx.value?.ipLocation?.country]
    .filter(Boolean)
    .join(', '),
);
const deviceText = computed(() => {
  const d = ctx.value?.device;
  if (!d) return '';
  return [
    d.network && (d.network === 'wifi' ? 'Wi-Fi' : d.network === 'cellular' ? 'Mobile data' : d.network),
    d.battery !== undefined && `battery ${d.battery}%${d.charging ? ' (charging)' : ''}`,
    d.platform,
    d.timezone,
  ]
    .filter(Boolean)
    .join(' · ');
});

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
        <div v-if="situation" class="mt-4 rounded-2xl bg-sky-50 px-4 py-3">
          <p class="text-sm font-semibold text-sky-700">What's happening</p>
          <p class="mt-1 text-lg leading-snug">{{ situation.now }}</p>
          <p v-if="situation.likely" class="mt-1">
            <span class="font-semibold">Most likely:</span> {{ situation.likely }}
          </p>
          <p class="mt-1 text-sm text-muted">
            From the last {{ situation.basedOn }} message{{ situation.basedOn === 1 ? '' : 's' }} ·
            {{ situation.confidence }} confidence · read out on the call
          </p>
        </div>
        <p v-if="message.insight" class="mt-4 rounded-2xl bg-lav-50 px-4 py-3 text-lav-600">
          <span class="font-semibold">AI note:</span> {{ message.insight }}
        </p>
        <div v-if="ctx?.details?.length" class="mt-4">
          <p class="text-sm font-semibold text-muted">Added after sending</p>
          <ul class="mt-1 space-y-1">
            <li v-for="d in ctx.details" :key="d.at" class="leading-snug">
              “{{ d.text }}” <span class="text-sm text-faint">{{ fullTime(d.at) }}</span>
            </li>
          </ul>
        </div>
        <dl class="mt-5 grid gap-x-6 gap-y-2 border-t border-line pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-muted">From</dt>
            <dd>{{ message.sender || '—' }}</dd>
          </div>
          <div>
            <dt class="text-muted">Why this level</dt>
            <dd>{{ message.reason }}</dd>
          </div>
          <div v-if="ctx?.gps || ipPlace" class="sm:col-span-2">
            <dt class="text-muted">Where</dt>
            <dd>
              <template v-if="ctx?.gps">
                {{ ctx.place || `${ctx.gps.lat}, ${ctx.gps.lon}` }}
                <span class="text-muted">(GPS ±{{ ctx.gps.accuracy }} m)</span>
              </template>
              <template v-else>
                Around {{ ipPlace }} <span class="text-muted">(from the internet connection, not exact)</span>
              </template>
              <a
                v-if="mapUrl"
                :href="mapUrl"
                target="_blank"
                rel="noopener"
                class="ml-1 text-sage-700 underline"
                >Open map</a
              >
            </dd>
          </div>
          <div v-if="ctx?.nearby?.length" class="sm:col-span-2">
            <dt class="text-muted">Nearby</dt>
            <dd>{{ ctx.nearby.join(' · ') }}</dd>
          </div>
          <div v-if="ctx?.ip">
            <dt class="text-muted">Connection</dt>
            <dd class="break-all">
              {{ ctx.ip }}<template v-if="ctx.hostname"> · {{ ctx.hostname }}</template>
              <span v-if="ctx.isp" class="block text-muted">{{ ctx.isp }}</span>
            </dd>
          </div>
          <div v-if="deviceText">
            <dt class="text-muted">Phone</dt>
            <dd>{{ deviceText }}</dd>
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
