<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import {
  DEFAULT_URGENT_KEYWORDS,
  EMPTY_MAILBOX,
  EMPTY_NTFY,
  LEVELS,
  type AiProvider,
  type Config,
  type HealthReport,
  type Level,
  type StatusInfo,
} from '../../shared/types';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import SecretInput from '../components/SecretInput.vue';
import TagInput from '../components/TagInput.vue';
import Toggle from '../components/Toggle.vue';
import { fullTime, levelDot, levelText } from '../format';

const props = defineProps<{ tab?: string }>();
const router = useRouter();

const tabs = [
  { id: 'family', label: 'Family' },
  { id: 'alerts', label: 'Calls & alerts' },
  { id: 'words', label: 'Urgent words' },
  { id: 'ai', label: 'AI' },
  { id: 'channels', label: 'Kid channels' },
  { id: 'connections', label: 'Connections' },
  { id: 'system', label: 'System' },
] as const;
const current = computed(() => (tabs.some((t) => t.id === props.tab) ? props.tab! : 'family'));

const cfg = ref<Config>();
const saved = ref('');
const status = ref<StatusInfo>();
const saving = ref(false);
const error = ref('');
const notice = ref('');
const dirty = computed(() => !!cfg.value && JSON.stringify(cfg.value) !== saved.value);
/** Remount secret inputs after save/discard so they pick up the new "saved" state. */
const saveCount = ref(0);

async function load() {
  const [c, s] = await Promise.all([api<Config>('/config'), api<StatusInfo>('/status')]);
  cfg.value = c;
  saved.value = JSON.stringify(c);
  status.value = s;
}
async function save() {
  if (!cfg.value) return;
  saving.value = true;
  error.value = '';
  try {
    const c = await api<Config>('/config', { method: 'PUT', body: cfg.value });
    cfg.value = c;
    saved.value = JSON.stringify(c);
    saveCount.value++;
    status.value = await api<StatusInfo>('/status');
    flash('Saved');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
function discard() {
  cfg.value = JSON.parse(saved.value);
  saveCount.value++;
  error.value = '';
}
function flash(msg: string) {
  notice.value = msg;
  setTimeout(() => (notice.value = ''), 2500);
}
const needSave = () => (dirty.value ? (flash('Save your changes first'), true) : false);
onMounted(load);

// Warn before leaving with unsaved edits.
watch(dirty, (d) => (window.onbeforeunload = d ? () => true : null));
onBeforeRouteLeave((to) => {
  if (!dirty.value || to.name === 'settings') return true;
  const leave = window.confirm('You have unsaved changes. Leave anyway?');
  if (leave) window.onbeforeunload = null;
  return leave;
});

const uid = () => crypto.randomUUID().slice(0, 8);
function move<T>(list: T[], i: number, d: -1 | 1) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}

// ── Family ──
function addContact() {
  cfg.value!.contacts.push({ id: uid(), name: '', phone: '', email: '', enabled: true });
}
const testing = ref('');
async function testCall(id: string) {
  if (needSave()) return;
  testing.value = id;
  try {
    const r = await api<{ id: string; warning?: string }>('/test/call', { body: { contactId: id } });
    if (r.warning) window.alert(r.warning);
    router.push(`/admin/messages/${r.id}`);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    testing.value = '';
  }
}

// ── Detection ──
const tryText = ref('');
const tryFrom = ref('');
const tryResult = ref<{ level: Level; reason: string; insight: string; aiErrors: string[] }>();
const trying = ref(false);
async function tryClassify() {
  if (needSave()) return;
  trying.value = true;
  try {
    tryResult.value = await api('/test/classify', {
      body: { text: tryText.value, from: tryFrom.value || undefined },
    });
  } finally {
    trying.value = false;
  }
}
async function sendTest() {
  if (needSave() || !tryText.value.trim()) return;
  if (!confirm('This will really call / text / email according to your settings. Continue?')) return;
  const r = await api<{ id: string } | null>('/test/message', { body: { text: tryText.value } });
  if (r) router.push(`/admin/messages/${r.id}`);
}
function addModel() {
  cfg.value!.ai.models.push({ id: uid(), provider: 'openrouter', model: '', enabled: true });
}
const modelSuggestions: Record<AiProvider, string[]> = {
  'workers-ai': [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
  ],
  openrouter: ['openrouter/free'],
  openai: ['gpt-5-mini', 'deepseek-chat'],
};
const providerLabel: Record<AiProvider, string> = {
  'workers-ai': 'Cloudflare Workers AI',
  openrouter: 'OpenRouter',
  openai: 'OpenAI-compatible',
};

// ── Channels ──
const kidLink = computed(() => {
  const kp = cfg.value?.channels.kidPage;
  if (!kp) return '';
  return kp.homeAtRoot && kp.pin ? `${location.origin}/` : `${location.origin}/k/${kp.token}`;
});
async function rotate() {
  if (!confirm('Make a new link? The old link on your child’s phone will stop working.')) return;
  const { token } = await api<{ token: string }>('/config/kid-token/rotate', { body: {} });
  cfg.value!.channels.kidPage.token = token;
  const base = JSON.parse(saved.value) as Config;
  base.channels.kidPage.token = token;
  saved.value = JSON.stringify(base);
  flash('New link created');
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  flash('Copied');
}
const addMailbox = () => cfg.value!.channels.mailboxes.push({ id: uid(), ...EMPTY_MAILBOX });
const addNtfy = () => cfg.value!.channels.ntfy.push({ id: uid(), ...EMPTY_NTFY });

// ── Connections ──
async function testEmail() {
  if (needSave()) return;
  try {
    const r = await api<{ to: string[] }>('/test/email', { body: {} });
    flash(`Test email sent to ${r.to.join(', ')}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
const origin = location.origin;
const detectedUrl = computed(() => (location.protocol === 'https:' ? location.origin : ''));

// ── System ──
const health = ref<HealthReport | null>(null);
watch(status, (s) => (health.value = s?.lastHealth ?? null));
const checking = ref(false);
async function runCheck(notify: boolean) {
  if (needSave()) return;
  checking.value = true;
  try {
    health.value = await api<HealthReport>('/health/run', { body: { notify } });
    if (notify)
      flash(health.value.emailed.length ? `Report emailed to ${health.value.emailed.join(', ')}` : 'Done');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    checking.value = false;
  }
}

const languages = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-AU', 'English (Australia)'],
  ['en-IN', 'English (India)'],
  ['cmn-CN', 'Chinese Mandarin'],
  ['yue-HK', 'Cantonese'],
  ['ms-MY', 'Malay'],
  ['ta-IN', 'Tamil'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['ja-JP', 'Japanese'],
  ['ko-KR', 'Korean'],
];
const policyDesc: Record<Level, string> = {
  urgent: 'Urgent words, key-mashing, the SOS button, or the AI senses danger.',
  concern: 'The AI thinks your child is sad, worried, bullied or unwell — check in soon.',
  normal: '“Pick me up at 5”, “I’m home”, good news.',
};
</script>

<template>
  <div v-if="cfg" class="space-y-6 pb-24">
    <h1 class="text-2xl font-bold tracking-tight">Settings</h1>

    <nav
      class="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
      aria-label="Settings sections"
    >
      <RouterLink
        v-for="t in tabs"
        :key="t.id"
        :to="`/admin/settings/${t.id}`"
        replace
        class="rounded-full px-4 py-2 text-[0.95rem] whitespace-nowrap"
        :class="current === t.id ? 'bg-sage-600 text-white' : 'text-muted hover:bg-surface hover:text-ink'"
        >{{ t.label }}</RouterLink
      >
    </nav>

    <!-- ───────────── FAMILY ───────────── -->
    <template v-if="current === 'family'">
      <section class="card grid gap-4 sm:grid-cols-[1fr_8rem]">
        <div>
          <label class="label" for="child">Child's name</label>
          <input id="child" v-model="cfg.childName" class="field" placeholder="e.g. Alex" />
          <p class="hint">Spoken on every call: “a new message from Alex…”.</p>
        </div>
        <div>
          <label class="label" for="age">Age</label>
          <input id="age" v-model="cfg.childAge" class="field" inputmode="numeric" placeholder="11" />
          <p class="hint">Helps the AI.</p>
        </div>
      </section>

      <section class="card">
        <h2 class="section-title">Who gets called</h2>
        <p class="hint">
          One person at a time, top to bottom. Phone in international format, e.g. +65 8123 4567. Email is
          used for alert emails and the daily check.
        </p>
        <ul class="mt-5 space-y-3">
          <li
            v-for="(c, i) in cfg.contacts"
            :key="c.id"
            class="rounded-2xl border border-line p-4"
            :class="!c.enabled && 'opacity-60'"
          >
            <div class="flex items-start gap-3">
              <span
                class="mt-2 grid size-8 shrink-0 place-items-center rounded-full bg-sage-50 text-sm font-bold text-sage-700"
                >{{ i + 1 }}</span
              >
              <div class="grid flex-1 gap-3 sm:grid-cols-3">
                <input v-model="c.name" class="field" placeholder="Name, e.g. Mum" aria-label="Name" />
                <input
                  v-model="c.phone"
                  class="field"
                  placeholder="+6581234567"
                  inputmode="tel"
                  aria-label="Phone number"
                />
                <input
                  v-model="c.email"
                  class="field"
                  type="email"
                  placeholder="email (optional)"
                  aria-label="Email"
                />
              </div>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-1 pl-11 text-sm">
              <label class="mr-auto flex items-center gap-2"
                ><input v-model="c.enabled" type="checkbox" class="size-4 accent-sage-600" /> Active</label
              >
              <button
                class="rounded-full px-3 py-1.5 text-muted hover:bg-paper disabled:opacity-40"
                :disabled="i === 0"
                @click="move(cfg.contacts, i, -1)"
              >
                Up
              </button>
              <button
                class="rounded-full px-3 py-1.5 text-muted hover:bg-paper disabled:opacity-40"
                :disabled="i === cfg.contacts.length - 1"
                @click="move(cfg.contacts, i, 1)"
              >
                Down
              </button>
              <button
                class="rounded-full px-3 py-1.5 text-sage-700 hover:bg-sage-50"
                :disabled="testing === c.id"
                @click="testCall(c.id)"
              >
                {{ testing === c.id ? 'Calling…' : 'Test call' }}
              </button>
              <button
                class="rounded-full px-3 py-1.5 text-rose-600 hover:bg-rose-50"
                @click="cfg.contacts.splice(i, 1)"
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
        <button class="btn-quiet mt-4" @click="addContact">
          <Icon name="plus" :size="16" /> Add a person
        </button>
      </section>
    </template>

    <!-- ───────────── ALERTS ───────────── -->
    <template v-if="current === 'alerts'">
      <section class="card">
        <Toggle
          v-model="cfg.paused"
          label="Pause all alerts"
          hint="Messages are still recorded, but nobody is called, texted or emailed."
        />
      </section>
      <section v-for="lvl in LEVELS" :key="lvl" class="card space-y-2">
        <div class="flex items-start gap-3">
          <span class="mt-2 size-2.5 rounded-full" :class="levelDot[lvl]" />
          <div>
            <h2 class="section-title">{{ levelText[lvl] }}</h2>
            <p class="hint !mt-0.5">{{ policyDesc[lvl] }}</p>
          </div>
        </div>
        <div class="divide-y divide-line">
          <div class="py-3">
            <Toggle
              v-model="cfg.policy[lvl].call"
              label="Phone call"
              hint="We call and read the message out loud."
            />
          </div>
          <div class="py-3">
            <Toggle
              v-model="cfg.policy[lvl].sms"
              label="Text message (SMS)"
              hint="Sent to everyone at once."
            />
          </div>
          <div class="py-3">
            <Toggle
              v-model="cfg.policy[lvl].email"
              label="Email"
              hint="Sent via AgentMail to parents with an email address."
            />
          </div>
          <template v-if="cfg.policy[lvl].call">
            <div class="py-3">
              <Toggle
                v-model="cfg.policy[lvl].requireConfirm"
                label="Keep calling until someone presses 1"
                hint="Stops voicemail from counting as “answered”."
              />
            </div>
            <div class="grid gap-4 py-3 sm:grid-cols-2">
              <div>
                <label class="label">Go through the list</label>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="cfg.policy[lvl].rounds"
                    type="number"
                    min="1"
                    max="20"
                    class="field w-24"
                  />
                  <span class="text-muted">time(s)</span>
                </div>
              </div>
              <div v-if="cfg.policy[lvl].rounds > 1">
                <label class="label">Wait between rounds</label>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="cfg.policy[lvl].retryMinutes"
                    type="number"
                    min="1"
                    max="120"
                    class="field w-24"
                  />
                  <span class="text-muted">minutes</span>
                </div>
              </div>
              <div>
                <label class="label">If they decline, call again right away</label>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="cfg.policy[lvl].redialOnDecline"
                    type="number"
                    min="0"
                    max="3"
                    class="field w-24"
                  />
                  <span class="text-muted">time(s), then the next contact</span>
                </div>
                <p class="hint">
                  No answer goes straight to the next contact. On iPhone, a second call within 3 minutes rings
                  through Do Not Disturb.
                </p>
              </div>
            </div>
          </template>
        </div>
      </section>
      <section class="card space-y-5">
        <h2 class="section-title">Voice on the call</h2>
        <div class="divide-y divide-line">
          <div class="py-3">
            <Toggle
              v-model="cfg.voice.readMessage"
              label="Read the message out loud"
              hint="Off: the call only says “please check your messages”."
            />
          </div>
          <div class="py-3">
            <Toggle
              v-model="cfg.voice.readAiSummary"
              label="Read the AI's note"
              hint="e.g. “Assistant's note: Alex sounds scared and wants you to come now.”"
            />
          </div>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label">Language</label>
            <select v-model="cfg.voice.language" class="field">
              <option v-for="[v, l] in languages" :key="v" :value="v">{{ l }}</option>
            </select>
          </div>
          <div>
            <label class="label">Voice <span class="font-normal text-muted">(optional)</span></label>
            <input v-model="cfg.voice.voice" class="field" placeholder="e.g. Polly.Joanna-Neural" />
            <p class="hint">
              Any
              <a
                class="text-sage-700 underline"
                href="https://www.twilio.com/docs/voice/twiml/say/text-speech#available-voices-and-languages"
                target="_blank"
                rel="noopener"
                >Twilio voice</a
              >
              that matches the language.
            </p>
          </div>
        </div>
      </section>
    </template>

    <!-- ───────────── URGENT WORDS ───────────── -->
    <template v-if="current === 'words'">
      <section class="card space-y-4">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 class="section-title">
              Urgent words
              <span class="text-sm font-normal text-muted">({{ cfg.rules.urgentKeywords.length }})</span>
            </h2>
            <p class="hint">
              Any of these makes a message urgent. English, Chinese and Malay included — add your family's
              code word.
            </p>
          </div>
          <button
            class="text-sm text-sage-700 hover:underline"
            @click="cfg.rules.urgentKeywords = [...DEFAULT_URGENT_KEYWORDS]"
          >
            Reset to built-in list
          </button>
        </div>
        <TagInput v-model="cfg.rules.urgentKeywords" placeholder="Add a word or phrase…" />
        <div class="divide-y divide-line">
          <div class="py-3">
            <Toggle
              v-model="cfg.rules.gibberishIsUrgent"
              label="Treat key-mashing as urgent"
              hint="“asdkjhqwe” or “!!!???” — your child may not be able to type."
            />
          </div>
          <div class="py-3">
            <Toggle
              v-model="cfg.rules.aiCanSoften"
              label="Let the AI soften obvious jokes"
              hint="“lol help me with maths” becomes “Check in” instead of “Urgent”. Never lower than that."
            />
          </div>
        </div>
      </section>
    </template>

    <!-- ───────────── AI ───────────── -->
    <template v-if="current === 'ai'">
      <section class="card space-y-4">
        <Toggle
          v-model="cfg.ai.enabled"
          label="AI helper"
          hint="Reads the feeling behind a message — fear, sadness, bullying, self-harm, grooming — even without urgent words."
        />
        <template v-if="cfg.ai.enabled">
          <div>
            <p class="label">Models, tried in order</p>
            <ul class="space-y-2">
              <li
                v-for="(m, i) in cfg.ai.models"
                :key="m.id"
                class="flex flex-col gap-2 rounded-2xl border border-line p-3 sm:flex-row sm:items-center"
                :class="!m.enabled && 'opacity-60'"
              >
                <span class="text-sm font-semibold text-muted sm:w-20">{{
                  i === 0 ? 'Main' : `Backup ${i}`
                }}</span>
                <select v-model="m.provider" class="field sm:w-52">
                  <option v-for="(l, p) in providerLabel" :key="p" :value="p">{{ l }}</option>
                </select>
                <input
                  v-model="m.model"
                  class="field font-mono text-sm"
                  :list="`models-${m.provider}`"
                  placeholder="model id"
                />
                <div class="flex items-center gap-1 text-sm">
                  <label class="flex items-center gap-1.5 px-2"
                    ><input v-model="m.enabled" type="checkbox" class="size-4 accent-sage-600" /> On</label
                  >
                  <button
                    class="rounded-full px-2 py-1 text-muted hover:bg-paper"
                    :disabled="i === 0"
                    @click="move(cfg.ai.models, i, -1)"
                  >
                    ↑
                  </button>
                  <button
                    class="rounded-full px-2 py-1 text-muted hover:bg-paper"
                    :disabled="i === cfg.ai.models.length - 1"
                    @click="move(cfg.ai.models, i, 1)"
                  >
                    ↓
                  </button>
                  <button
                    class="rounded-full px-2 py-1 text-rose-600 hover:bg-rose-50"
                    aria-label="Remove"
                    @click="cfg.ai.models.splice(i, 1)"
                  >
                    <Icon name="x" :size="16" />
                  </button>
                </div>
              </li>
            </ul>
            <datalist v-for="(list, p) in modelSuggestions" :id="`models-${p}`" :key="p">
              <option v-for="x in list" :key="x" :value="x" />
            </datalist>
            <button class="btn-quiet mt-3" @click="addModel">
              <Icon name="plus" :size="16" /> Add a model
            </button>
          </div>
          <div>
            <label class="label">Give up on a model after</label>
            <div class="flex items-center gap-2">
              <input
                v-model.number="cfg.ai.timeoutSeconds"
                type="number"
                min="3"
                max="30"
                class="field w-24"
              />
              <span class="text-muted">seconds, then try the next</span>
            </div>
          </div>
        </template>
      </section>

      <section class="card space-y-3">
        <h2 class="section-title">Try it</h2>
        <textarea
          v-model="tryText"
          rows="2"
          class="field"
          placeholder="Type a message your child might send…"
        />
        <input
          v-model="tryFrom"
          class="field"
          type="email"
          placeholder="Optional: pretend it's an email from someone else, e.g. teacher@school.edu.sg"
        />
        <div class="flex flex-wrap gap-2">
          <button class="btn-quiet" :disabled="!tryText.trim() || trying" @click="tryClassify">
            {{ trying ? 'Thinking…' : 'Check (no call)' }}
          </button>
          <button class="btn-quiet" :disabled="!tryText.trim()" @click="sendTest">Send as a real test</button>
        </div>
        <div
          v-if="tryResult"
          class="rounded-2xl px-4 py-3"
          :class="
            {
              urgent: 'bg-rose-50 text-rose-600',
              concern: 'bg-lav-50 text-lav-600',
              normal: 'bg-sage-50 text-sage-700',
            }[tryResult.level]
          "
        >
          <p>
            <strong>{{ levelText[tryResult.level] }}</strong> — {{ tryResult.reason }}
          </p>
          <p v-if="tryResult.insight" class="mt-1 italic">“{{ tryResult.insight }}”</p>
          <p v-for="e in tryResult.aiErrors" :key="e" class="mt-1 text-sm text-muted">AI error: {{ e }}</p>
        </div>
      </section>
      <section class="card space-y-4">
        <h2 class="section-title">AI provider keys</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label">Cloudflare account ID</label>
            <input v-model="cfg.services.cloudflareAccountId" class="field font-mono" spellcheck="false" />
          </div>
          <div>
            <label class="label">Cloudflare API token</label>
            <SecretInput :key="`cf${saveCount}`" v-model="cfg.services.cloudflareApiToken" />
          </div>
        </div>
        <p class="hint !mt-0">
          Only needed for local development — once deployed, Workers AI works without a token.
        </p>
        <div>
          <label class="label">OpenRouter API key</label>
          <SecretInput
            :key="`or${saveCount}`"
            v-model="cfg.services.openrouterApiKey"
            placeholder="sk-or-…"
          />
          <p class="hint">Free models need “free endpoints” allowed at openrouter.ai/settings/privacy.</p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label">OpenAI-compatible base URL</label>
            <input
              v-model="cfg.services.openaiBaseUrl"
              class="field font-mono"
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div>
            <label class="label">API key</label>
            <SecretInput :key="`oa${saveCount}`" v-model="cfg.services.openaiApiKey" />
          </div>
          <div>
            <label class="label">Model ID</label>
            <input
              v-model="cfg.services.openaiModel"
              class="field font-mono"
              placeholder="e.g. gpt-5-mini, deepseek-chat"
            />
            <p class="hint">Used by “OpenAI-compatible” models in the chain that leave the model empty.</p>
          </div>
        </div>
      </section>
    </template>

    <!-- ───────────── KID CHANNELS ───────────── -->
    <template v-if="current === 'channels'">
      <section class="card space-y-4">
        <Toggle
          v-model="cfg.channels.kidPage.enabled"
          label="Kid page"
          hint="A private web page for your child's phone: SOS button, quick replies, free text."
        />
        <template v-if="cfg.channels.kidPage.enabled">
          <div class="flex flex-col gap-2 sm:flex-row">
            <input :value="kidLink" readonly class="field font-mono text-sm" aria-label="Kid page link" />
            <div class="flex gap-2">
              <button class="btn-quiet" @click="copy(kidLink)"><Icon name="copy" :size="16" /> Copy</button>
              <button class="btn-quiet" title="Make a new link" @click="rotate">
                <Icon name="refresh" :size="16" /> New
              </button>
            </div>
          </div>
          <div class="max-w-sm">
            <label class="label" for="kidpin">PIN</label>
            <SecretInput
              id="kidpin"
              :key="`pin${saveCount}`"
              v-model="cfg.channels.kidPage.pin"
              placeholder="4–8 digits, empty = no PIN"
              inputmode="numeric"
            />
            <p class="hint">Asked once on each phone. Changing it logs the kid page out everywhere.</p>
          </div>
          <div class="rounded-2xl bg-sky-50 p-4">
            <Toggle
              v-model="cfg.channels.kidPage.homeAtRoot"
              label="Kid page at the main address"
              :hint="`Open the kid page at ${origin}/ — easy to remember. The dashboard stays at ${origin}/admin. Anyone can find this address, so the PIN is required.`"
            />
            <p
              v-if="cfg.channels.kidPage.homeAtRoot && !cfg.channels.kidPage.pin"
              class="mt-2 text-sm text-rose-600"
            >
              Set a PIN above — without one the main address stays closed.
            </p>
            <p v-else-if="cfg.channels.kidPage.homeAtRoot" class="mt-2 text-sm text-muted">
              Tip: use 6 or more digits. After 10 wrong tries the PIN pad pauses for 2 minutes (phones already
              unlocked keep working).
            </p>
          </div>
          <div>
            <label class="label">Quick replies</label>
            <TagInput v-model="cfg.channels.kidPage.quickReplies" placeholder="Add a button…" />
          </div>
        </template>
      </section>

      <section class="card space-y-3">
        <h2 class="section-title">Accept email only from</h2>
        <p class="hint !mt-0">
          Applies to every mailbox and Email Routing. Full address or @domain. Other mail is ignored.
        </p>
        <TagInput v-model="cfg.channels.allowedSenders" placeholder="kid@gmail.com or @school.edu.sg" />
      </section>

      <section class="card space-y-3">
        <Toggle
          v-model="cfg.channels.acceptMentions"
          label="Also read email from anyone that mentions these names"
          hint="e.g. a teacher or another parent writing about your child. Names match in any capitalisation (alex, ALEX, Alex) as whole words. The AI reads it; you're only called or texted if it's urgent or worth a check-in — everyday mail is just recorded."
        />
        <TagInput
          v-if="cfg.channels.acceptMentions"
          v-model="cfg.channels.watchNames"
          :placeholder="`Names, e.g. ${cfg.childName}, nickname, 中文名`"
        />
        <p v-if="cfg.channels.acceptMentions && !cfg.channels.watchNames.length" class="hint !mt-0">
          Empty = your child's name ({{ cfg.childName }}).
        </p>
      </section>

      <section class="card">
        <h2 class="section-title">Mailboxes</h2>
        <p class="hint">
          Checked every minute. AgentMail inboxes need no password; Gmail/Outlook use IMAP with an app
          password.
        </p>
        <ul class="mt-4 space-y-3">
          <li
            v-for="(b, i) in cfg.channels.mailboxes"
            :key="b.id"
            class="space-y-3 rounded-2xl border border-line p-4"
            :class="!b.enabled && 'opacity-60'"
          >
            <div class="grid gap-3 sm:grid-cols-[1fr_13rem]">
              <input v-model="b.name" class="field" placeholder="Name, e.g. Kid inbox" />
              <select v-model="b.type" class="field">
                <option value="agentmail">AgentMail</option>
                <option value="imap">IMAP (Gmail, Outlook…)</option>
              </select>
            </div>
            <template v-if="b.type === 'agentmail'">
              <input v-model="b.address" class="field" type="email" placeholder="inbox@agentmail.to" />
              <SecretInput
                :key="`mb${b.id}${saveCount}`"
                v-model="b.apiKey"
                placeholder="API key (empty = use the one in Connections)"
              />
            </template>
            <template v-else>
              <div class="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                <input v-model="b.host" class="field" placeholder="imap.gmail.com" />
                <input v-model.number="b.port" class="field" type="number" placeholder="993" />
                <input v-model="b.folder" class="field" placeholder="INBOX" />
              </div>
              <input v-model="b.address" class="field" type="email" placeholder="username / email" />
              <SecretInput :key="`mp${b.id}${saveCount}`" v-model="b.password" placeholder="app password" />
            </template>
            <div class="flex items-center gap-2 text-sm">
              <label class="mr-auto flex items-center gap-2"
                ><input v-model="b.enabled" type="checkbox" class="size-4 accent-sage-600" /> Active</label
              >
              <button
                class="rounded-full px-3 py-1.5 text-rose-600 hover:bg-rose-50"
                @click="cfg.channels.mailboxes.splice(i, 1)"
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
        <button class="btn-quiet mt-4" @click="addMailbox">
          <Icon name="plus" :size="16" /> Add a mailbox
        </button>
      </section>

      <section class="card">
        <h2 class="section-title">ntfy topics</h2>
        <p class="hint">Checked every minute. Use long, random topic names, or protect them with a token.</p>
        <ul class="mt-4 space-y-3">
          <li
            v-for="(n, i) in cfg.channels.ntfy"
            :key="n.id"
            class="space-y-3 rounded-2xl border border-line p-4"
            :class="!n.enabled && 'opacity-60'"
          >
            <div class="grid gap-3 sm:grid-cols-3">
              <input v-model="n.name" class="field" placeholder="Name" />
              <input v-model="n.baseUrl" class="field" placeholder="https://ntfy.sh" />
              <input v-model="n.topic" class="field" placeholder="topic" />
            </div>
            <div class="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <input
                v-model="n.username"
                class="field"
                placeholder="Username (optional)"
                autocomplete="off"
              />
              <SecretInput
                :key="`nt${n.id}${saveCount}`"
                v-model="n.token"
                :placeholder="n.username ? 'Password' : 'Access token tk_… (optional)'"
              />
            </div>
            <div class="flex items-center gap-2 text-sm">
              <label class="mr-auto flex items-center gap-2"
                ><input v-model="n.enabled" type="checkbox" class="size-4 accent-sage-600" /> Active</label
              >
              <button
                class="rounded-full px-3 py-1.5 text-rose-600 hover:bg-rose-50"
                @click="cfg.channels.ntfy.splice(i, 1)"
              >
                Remove
              </button>
            </div>
          </li>
        </ul>
        <button class="btn-quiet mt-4" @click="addNtfy"><Icon name="plus" :size="16" /> Add a topic</button>
      </section>

      <section class="card space-y-4">
        <Toggle
          v-model="cfg.channels.emailRouting.enabled"
          label="Cloudflare Email Routing"
          hint="Mail to e.g. sos@your-domain.com arrives instantly. Needs your own domain on Cloudflare."
        />
        <div v-if="cfg.channels.emailRouting.enabled">
          <label class="label"
            >Also forward every email to <span class="font-normal text-muted">(optional)</span></label
          >
          <input
            v-model="cfg.channels.emailRouting.forwardTo"
            class="field"
            type="email"
            placeholder="parent@example.com"
          />
        </div>
      </section>
    </template>

    <!-- ───────────── CONNECTIONS ───────────── -->
    <template v-if="current === 'connections'">
      <section class="card space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="section-title">Twilio — phone calls & SMS</h2>
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
            :class="status?.twilio ? 'bg-sage-100 text-sage-700' : 'bg-rose-100 text-rose-600'"
            >{{ status?.twilio ? 'Connected' : 'Not set up' }}</span
          >
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label">Account SID</label>
            <input
              v-model="cfg.twilio.accountSid"
              class="field font-mono"
              placeholder="AC…"
              spellcheck="false"
            />
          </div>
          <div>
            <label class="label"
              >Auth Token <span class="font-normal text-muted">(Live, not Test)</span></label
            >
            <SecretInput :key="`tw${saveCount}`" v-model="cfg.twilio.authToken" />
          </div>
          <div>
            <label class="label">Twilio phone number</label>
            <input
              v-model="cfg.twilio.fromNumber"
              class="field font-mono"
              placeholder="+15550001111"
              inputmode="tel"
            />
          </div>
          <div>
            <label class="label">API Key SID <span class="font-normal text-muted">(optional)</span></label>
            <input
              v-model="cfg.twilio.apiKeySid"
              class="field font-mono"
              placeholder="SK…"
              spellcheck="false"
            />
          </div>
          <div class="sm:col-start-2">
            <label class="label">API Key Secret <span class="font-normal text-muted">(optional)</span></label>
            <SecretInput :key="`tws${saveCount}`" v-model="cfg.twilio.apiKeySecret" />
          </div>
        </div>
        <p class="hint">
          The Auth Token also verifies that callbacks really come from Twilio. Setup guide:
          docs/twilio-setup.md.
        </p>
      </section>

      <section class="card space-y-3">
        <h2 class="section-title">Public address</h2>
        <input
          v-model="cfg.publicBaseUrl"
          class="field font-mono"
          :placeholder="status?.publicBaseUrl || 'https://sos2me.example.workers.dev'"
        />
        <p class="hint !mt-0">
          Twilio calls this address back. Leave empty to use
          <strong>{{
            status?.publicBaseUrl || detectedUrl || 'the https address you open the dashboard on'
          }}</strong
          >.
        </p>
      </section>

      <section class="card space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="section-title">AgentMail — send & receive email</h2>
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
            :class="status?.agentmail ? 'bg-sage-100 text-sage-700' : 'bg-paper text-muted'"
            >{{ status?.agentmail ? 'Connected' : 'Not set up' }}</span
          >
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="label">API key</label>
            <SecretInput :key="`am${saveCount}`" v-model="cfg.services.agentmailApiKey" placeholder="am_…" />
          </div>
          <div>
            <label class="label">Send alerts from</label>
            <input
              v-model="cfg.services.agentmailFrom"
              class="field"
              type="email"
              placeholder="inbox@agentmail.to"
            />
          </div>
        </div>
        <button class="btn-quiet" @click="testEmail">
          <Icon name="mail" :size="16" /> Send a test email to parents
        </button>
      </section>
    </template>

    <!-- ───────────── SYSTEM ───────────── -->
    <template v-if="current === 'system'">
      <section class="card max-w-xl space-y-3">
        <h2 class="section-title">Dashboard password</h2>
        <SecretInput :key="`pw${saveCount}`" v-model="cfg.adminPassword" placeholder="New password" />
        <p class="hint !mt-0">Changing it signs out every other device.</p>
      </section>

      <section class="card space-y-4">
        <Toggle
          v-model="cfg.health.enabled"
          label="Daily system check"
          hint="Tests every AI model, Twilio, mailboxes, ntfy and email — and emails you if anything is broken."
        />
        <template v-if="cfg.health.enabled">
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label class="label">Time</label>
              <input v-model="cfg.health.time" type="time" class="field" />
            </div>
            <div>
              <label class="label">Time zone</label>
              <input v-model="cfg.health.timezone" class="field" placeholder="Asia/Singapore" />
            </div>
          </div>
          <div>
            <label class="label">Also email</label>
            <TagInput v-model="cfg.health.extraEmails" placeholder="someone@example.com" />
            <p class="hint">Parents with an email address always get it.</p>
          </div>
          <div class="divide-y divide-line">
            <div class="py-3">
              <Toggle v-model="cfg.health.emailWhenOk" label="Email even when all is well" />
            </div>
            <div class="py-3">
              <Toggle v-model="cfg.health.smsOnFailure" label="Also text parents when something breaks" />
            </div>
          </div>
        </template>
        <div class="flex flex-wrap gap-2">
          <button class="btn-quiet" :disabled="checking" @click="runCheck(false)">
            <Icon name="refresh" :size="16" /> {{ checking ? 'Checking…' : 'Run check now' }}
          </button>
          <button class="btn-quiet" :disabled="checking" @click="runCheck(true)">
            <Icon name="mail" :size="16" /> Run and email report
          </button>
        </div>
        <ul v-if="health" class="space-y-2 rounded-2xl bg-paper p-4 text-sm">
          <li class="text-muted">Last run {{ fullTime(health.ranAt) }}</li>
          <li v-for="c in health.checks" :key="c.name" class="flex gap-2">
            <Icon
              :name="c.ok && !c.warn ? 'check' : 'alert'"
              :size="16"
              class="mt-0.5 shrink-0"
              :class="!c.ok ? 'text-rose-500' : c.warn ? 'text-lav-600' : 'text-sage-600'"
            />
            <span
              ><span class="font-semibold">{{ c.name }}</span> —
              <span :class="!c.ok ? 'text-rose-600' : c.warn ? 'text-lav-600' : ''">{{
                c.detail
              }}</span></span
            >
          </li>
        </ul>
      </section>
    </template>

    <!-- Sticky save bar -->
    <div
      v-if="dirty || error || notice"
      class="fixed inset-x-0 bottom-[4.5rem] z-30 px-4 sm:bottom-6"
      role="status"
    >
      <div
        class="mx-auto flex max-w-4xl items-center gap-3 rounded-2xl border border-line bg-surface px-5 py-3 shadow-lg shadow-ink/5"
      >
        <p class="flex-1 text-sm" :class="error ? 'text-rose-600' : 'text-muted'">
          {{ error || notice || 'You have unsaved changes' }}
        </p>
        <button v-if="error && !dirty" class="text-sm text-muted" @click="error = ''">Dismiss</button>
        <template v-if="dirty">
          <button class="btn-quiet !min-h-10 !px-4" @click="discard">Discard</button>
          <button class="btn-primary !min-h-10 !px-4" :disabled="saving" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
