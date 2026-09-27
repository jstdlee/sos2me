<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Config, HealthReport, MessageRow, StatusInfo } from '../../shared/types';
import { api } from '../api';
import BunniesHug from '../components/BunniesHug.vue';
import Icon from '../components/Icon.vue';
import MessageItem from '../components/MessageItem.vue';
import { fullTime, levelText, timeAgo } from '../format';

const cfg = ref<Config>();
const status = ref<StatusInfo>();
const messages = ref<MessageRow[]>([]);
const loading = ref(true);
const copied = ref(false);
const checking = ref(false);

async function load() {
  [cfg.value, status.value, messages.value] = await Promise.all([
    api<Config>('/config'),
    api<StatusInfo>('/status'),
    api<MessageRow[]>('/messages?limit=6'),
  ]);
  loading.value = false;
}

const active = computed(() => messages.value.find((m) => m.status === 'calling'));
const last = computed(() => messages.value.find((m) => m.source !== 'test'));
// The newest message was urgent and nobody confirmed it — don't say "all calm".
const missed = computed(() => {
  const m = messages.value[0];
  return m && m.level === 'urgent' && (m.status === 'unanswered' || m.status === 'failed') ? m : undefined;
});
const kidLink = computed(() => {
  const kp = cfg.value?.channels.kidPage;
  if (!kp) return '';
  return kp.homeAtRoot && kp.pin ? `${location.origin}/` : `${location.origin}/k/${kp.token}`;
});
const health = computed<HealthReport | null>(() => status.value?.lastHealth ?? null);

const checklist = computed(() => {
  if (!cfg.value || !status.value) return [];
  return [
    {
      done: status.value.twilio,
      text: 'Connect Twilio',
      hint: 'So SOS2me can place calls.',
      to: '/admin/settings/connections',
    },
    {
      done: cfg.value.contacts.some((c) => c.enabled && c.phone),
      text: 'Add a parent phone number',
      hint: 'Who should we call?',
      to: '/admin/settings/family',
    },
    {
      done: status.value.publicBaseUrl.startsWith('https://'),
      text: 'Set the public https address',
      hint: 'Twilio needs it to reach SOS2me.',
      to: '/admin/settings/connections',
    },
    {
      done: status.value.agentmail,
      text: 'Connect AgentMail',
      hint: 'For alert emails and the daily system check.',
      to: '/admin/settings/connections',
    },
  ];
});
const setupDone = computed(() => checklist.value.every((c) => c.done));

async function stop(id: string) {
  await api(`/messages/${id}/stop`, { body: {} });
  await load();
}
async function setPaused(paused: boolean) {
  if (!cfg.value) return;
  cfg.value = await api<Config>('/config', { method: 'PUT', body: { ...cfg.value, paused } });
}
async function copy() {
  await navigator.clipboard.writeText(kidLink.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1800);
}
async function runCheck() {
  checking.value = true;
  try {
    const report = await api<HealthReport>('/health/run', { body: { notify: false } });
    if (status.value) status.value.lastHealth = report;
  } finally {
    checking.value = false;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  load();
  timer = setInterval(() => document.visibilityState === 'visible' && load(), 10_000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div v-if="loading" class="py-20 text-center text-muted">Loading…</div>
  <div v-else-if="cfg" class="space-y-6">
    <!-- Hero status -->
    <section v-if="active" class="card !border-rose-100 !bg-rose-50" aria-live="polite">
      <p class="flex items-center gap-2 text-sm font-semibold text-rose-600">
        <span class="size-2 animate-pulse rounded-full bg-rose-500" /> Calling parents now
      </p>
      <h1 class="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
        {{ levelText[active.level] }} message from {{ cfg.childName }}
      </h1>
      <p class="mt-3 text-lg leading-relaxed">“{{ active.body }}”</p>
      <p v-if="active.insight" class="mt-2 text-muted italic">{{ active.insight }}</p>
      <div class="mt-6 flex flex-wrap gap-3">
        <RouterLink :to="`/admin/messages/${active.id}`" class="btn-quiet">See call progress</RouterLink>
        <button class="btn-danger" @click="stop(active.id)">I've got it — stop calling</button>
      </div>
    </section>

    <section v-else-if="missed" class="card !border-rose-100 !bg-rose-50">
      <p class="flex items-center gap-2 text-sm font-semibold text-rose-600">
        <Icon name="alert" :size="16" /> Needs attention
      </p>
      <h1 class="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
        Nobody confirmed {{ cfg.childName }}'s urgent message
      </h1>
      <p class="mt-3 text-lg leading-relaxed">“{{ missed.body }}” · {{ timeAgo(missed.received_at) }}</p>
      <RouterLink :to="`/admin/messages/${missed.id}`" class="btn-quiet mt-5">See what happened</RouterLink>
    </section>

    <section v-else-if="cfg.paused" class="card !border-lav-100 !bg-lav-50">
      <p class="flex items-center gap-2 text-sm font-semibold text-lav-600">
        <Icon name="pause" :size="16" /> Paused
      </p>
      <h1 class="mt-3 text-2xl font-bold tracking-tight">Alerts are paused</h1>
      <p class="mt-2 text-muted">Messages are still recorded, but nobody is called or texted.</p>
      <button class="btn-primary mt-5" @click="setPaused(false)">
        <Icon name="play" :size="16" /> Resume alerts
      </button>
    </section>

    <section
      v-else
      class="card relative overflow-hidden !bg-gradient-to-br from-sage-50 via-surface to-sky-50"
    >
      <div class="flex items-center gap-4">
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 text-sm font-semibold text-sage-700">
            <Icon name="heart" :size="16" /> All calm
          </p>
          <h1 class="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            {{
              last
                ? `Last heard from ${cfg.childName} ${timeAgo(last.received_at)}`
                : `Waiting for ${cfg.childName}'s first message`
            }}
          </h1>
          <p v-if="last" class="mt-2 line-clamp-2 text-lg text-muted">“{{ last.body }}”</p>
          <p v-else class="mt-2 text-muted">When a message arrives, we'll phone you and read it out.</p>
        </div>
        <BunniesHug class="hidden w-40 shrink-0 sm:block" />
      </div>
    </section>

    <!-- Setup checklist -->
    <section v-if="!setupDone" class="card">
      <h2 class="section-title">Finish setting up</h2>
      <ul class="mt-3 divide-y divide-line">
        <li v-for="c in checklist" :key="c.text">
          <RouterLink :to="c.to" class="flex items-center gap-4 py-3">
            <span
              class="grid size-7 shrink-0 place-items-center rounded-full border"
              :class="c.done ? 'border-sage-600 bg-sage-600 text-white' : 'border-line text-transparent'"
              ><Icon name="check" :size="14"
            /></span>
            <span class="flex-1">
              <span class="block" :class="c.done && 'text-muted line-through'">{{ c.text }}</span>
              <span v-if="!c.done" class="text-sm text-muted">{{ c.hint }}</span>
            </span>
            <Icon v-if="!c.done" name="chevron" class="text-faint" />
          </RouterLink>
        </li>
      </ul>
    </section>

    <div class="grid gap-6 lg:grid-cols-[1fr_19rem]">
      <!-- Recent messages -->
      <section class="card !p-0">
        <div class="flex items-center justify-between px-5 pt-5 pb-2 sm:px-6">
          <h2 class="section-title">Recent messages</h2>
          <RouterLink to="/admin/messages" class="text-sm text-sage-700 hover:underline">See all</RouterLink>
        </div>
        <div v-if="messages.length" class="divide-y divide-line">
          <MessageItem v-for="m in messages" :key="m.id" :m="m" />
        </div>
        <p v-else class="px-6 pt-2 pb-6 text-muted">No messages yet.</p>
      </section>

      <aside class="space-y-6">
        <!-- System check -->
        <section class="card">
          <div class="flex items-center justify-between">
            <h2 class="section-title">System check</h2>
            <span
              v-if="health"
              class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
              :class="health.ok ? 'bg-sage-100 text-sage-700' : 'bg-rose-100 text-rose-600'"
              >{{ health.ok ? 'All good' : 'Problem' }}</span
            >
          </div>
          <p class="hint">
            {{ health ? `Last run ${fullTime(health.ranAt)}` : 'Not run yet.' }} Runs daily at
            {{ cfg.health.time }}.
          </p>
          <ul v-if="health" class="mt-3 space-y-1.5 text-sm">
            <li v-for="c in health.checks" :key="c.name" class="flex gap-2">
              <Icon
                :name="c.ok && !c.warn ? 'check' : 'alert'"
                :size="16"
                class="mt-0.5 shrink-0"
                :class="!c.ok ? 'text-rose-500' : c.warn ? 'text-lav-600' : 'text-sage-600'"
              />
              <span>
                <span class="font-medium">{{ c.name }}</span>
                <span
                  class="block text-muted"
                  :class="!c.ok ? '!text-rose-600' : c.warn ? '!text-lav-600' : ''"
                  >{{ c.detail }}</span
                >
              </span>
            </li>
          </ul>
          <button class="btn-quiet mt-4 w-full" :disabled="checking" @click="runCheck">
            <Icon name="refresh" :size="16" /> {{ checking ? 'Checking…' : 'Run now' }}
          </button>
        </section>

        <!-- What to do when SOS2me calls -->
        <section class="card !border-sky-100 !bg-sky-50/70">
          <h2 class="section-title flex items-center gap-2">
            <Icon name="phone" :size="18" class="text-sky-700" /> When SOS2me calls you
          </h2>
          <ol class="mt-3 space-y-2.5 text-[0.95rem]">
            <li class="flex gap-3">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-full bg-sky-600 text-xs font-bold text-white"
                >1</span
              >
              <span
                ><strong>Pick up</strong> — it calls from
                {{ status?.twilio ? 'your Twilio number' : 'the SOS2me number' }}.</span
              >
            </li>
            <li class="flex gap-3">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-full bg-sky-600 text-xs font-bold text-white"
                >2</span
              >
              <span
                ><strong>Listen</strong> — it reads {{ cfg.childName }}'s message. Press <strong>2</strong> to
                hear it again.</span
              >
            </li>
            <li class="flex gap-3">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-full bg-sky-600 text-xs font-bold text-white"
                >3</span
              >
              <span>
                <strong>Press 1</strong> to confirm you heard it. Calling stops for everyone, and
                {{ cfg.childName }} sees “heard you ✓”.
              </span>
            </li>
          </ol>
          <p class="hint">
            Urgent messages keep calling until someone presses 1. If you decline, it rings you again at once;
            if you don't answer, it calls the next person.
          </p>
        </section>

        <section v-if="cfg.channels.kidPage.enabled" class="card">
          <h2 class="section-title">Kid page</h2>
          <p class="hint">Open this link on your child's phone and add it to the home screen.</p>
          <button class="btn-quiet mt-4 w-full" @click="copy">
            <Icon :name="copied ? 'check' : 'copy'" :size="16" /> {{ copied ? 'Copied' : 'Copy link' }}
          </button>
          <a
            :href="kidLink"
            target="_blank"
            class="mt-2 block text-center text-sm text-sage-700 hover:underline"
            >Preview</a
          >
        </section>

        <section v-if="!cfg.paused && !active" class="card">
          <h2 class="section-title">Quiet time?</h2>
          <p class="hint">Pause calls while you're together. Messages are still kept.</p>
          <button class="btn-quiet mt-4 w-full" @click="setPaused(true)">
            <Icon name="pause" :size="16" /> Pause alerts
          </button>
        </section>
      </aside>
    </div>
  </div>
</template>
