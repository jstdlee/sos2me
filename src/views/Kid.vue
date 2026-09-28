<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AlertStatus } from '../../shared/types';
import { api, ApiError } from '../api';
import BunniesHug from '../components/BunniesHug.vue';
import Icon from '../components/Icon.vue';

const props = defineProps<{ token: string }>();
const storeKey = `sos2me:kid:${props.token}`;

const info = ref<{ pinRequired: boolean; quickReplies: string[]; shareLocation: boolean }>();
const deviceKey = ref<string>(safeGet(storeKey) ?? '');
const locked = computed(() => !!info.value?.pinRequired && !deviceKey.value);
const error = ref('');
const text = ref('');
const sending = ref(false);
const sent = ref<{ id: string; sos: boolean; status: AlertStatus; by: string | null } | null>(null);
const pin = ref('');

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode: PIN will be asked again next time */
  }
}

onMounted(async () => {
  try {
    info.value = await api(`/kid/${props.token}`);
  } catch (e) {
    error.value =
      props.token === 'home' ? "This page isn't switched on yet. Ask your parent." : (e as Error).message;
  }
});

// ── PIN ──
async function pressDigit(d: string) {
  error.value = '';
  if (pin.value.length < 8) pin.value += d;
}
async function unlock() {
  try {
    const r = await api<{ key: string }>(`/kid/${props.token}/unlock`, { body: { pin: pin.value } });
    deviceKey.value = r.key;
    safeSet(storeKey, r.key);
  } catch (e) {
    error.value = (e as Error).message;
    pin.value = '';
  }
}

// ── Where am I: sent with every message so parents can find the child ──
type Gps = { lat: number; lon: number; accuracy: number };
const gpsState = ref<'idle' | 'asking' | 'sent' | 'denied' | 'unavailable'>('idle');
// A function, so TypeScript doesn't assume the state can't change during an await.
const gpsDenied = () => gpsState.value === 'denied';

function locate(timeoutMs = 15_000): Promise<Gps | null> {
  if (!info.value?.shareLocation || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => {
        if (e.code === e.PERMISSION_DENIED) gpsState.value = 'denied';
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    ),
  );
}

/** Battery, Wi-Fi vs mobile data, time zone. (Browsers never reveal the Wi-Fi name or phone name.) */
async function deviceInfo() {
  const nav = navigator as Navigator & {
    connection?: { type?: string; effectiveType?: string };
    getBattery?: () => Promise<{ level: number; charging: boolean }>;
    userAgentData?: { platform?: string };
  };
  const battery = await Promise.race([
    nav.getBattery?.().catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(r, 500)),
  ]);
  return {
    network: nav.connection?.type,
    effectiveType: nav.connection?.effectiveType,
    battery: battery ? Math.round(battery.level * 100) : undefined,
    charging: battery?.charging,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    platform: nav.userAgentData?.platform,
    userAgent: navigator.userAgent,
  };
}

/** Share the location with a message already sent (the GPS was slow, or the child tapped "Share"). */
async function shareLocation(gpsPromise?: Promise<Gps | null>) {
  if (!sent.value) return;
  const id = sent.value.id;
  gpsState.value = 'asking';
  const gps = await (gpsPromise ?? locate());
  if (!gps) {
    if (gpsState.value === 'asking') gpsState.value = 'unavailable';
    return;
  }
  try {
    await api(`/kid/${props.token}/details`, { body: { id, key: deviceKey.value, gps } });
    gpsState.value = 'sent';
  } catch {
    gpsState.value = 'unavailable';
  }
}

// ── Send ──
async function send(body: string, sos = false) {
  if (sending.value) return;
  sending.value = true;
  error.value = '';
  added.value = [];
  gpsState.value = 'idle';
  // Wait a moment for the GPS, but never hold the message back: a late fix is attached afterwards.
  const gpsPromise = locate();
  const quickGps = await Promise.race([
    gpsPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ]);
  try {
    const r = await api<{ id: string; status: AlertStatus }>(`/kid/${props.token}/send`, {
      body: { text: body, sos, key: deviceKey.value, gps: quickGps ?? undefined, device: await deviceInfo() },
    });
    sent.value = { id: r.id, sos, status: r.status, by: null };
    text.value = '';
    startPolling();
    if (quickGps) gpsState.value = 'sent';
    else if (info.value?.shareLocation && !gpsDenied()) void shareLocation(gpsPromise);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // PIN changed on the parent side — ask again.
      deviceKey.value = '';
      safeSet(storeKey, null);
    } else error.value = (e as Error).message || 'Could not send. Try again.';
  } finally {
    sending.value = false;
  }
}

// ── "Mum heard you" ──
let poll: ReturnType<typeof setInterval> | undefined;
function startPolling() {
  clearInterval(poll);
  const started = Date.now();
  poll = setInterval(async () => {
    if (!sent.value || Date.now() - started > 15 * 60_000) return clearInterval(poll);
    try {
      const r = await api<{ status: AlertStatus; by: string | null }>(`/kid/${props.token}/status`, {
        body: { id: sent.value.id, key: deviceKey.value },
      });
      sent.value.status = r.status;
      sent.value.by = r.by;
      if (r.status !== 'calling') clearInterval(poll);
    } catch {
      /* keep trying quietly */
    }
  }, 5000);
}
onUnmounted(() => clearInterval(poll));

// ── Tell us more: helps parents find the child ──
const TIPS = [
  { icon: '📍', label: 'Where I am', prefix: 'I am at ' },
  { icon: '🏢', label: 'A building or shop I see', prefix: 'I can see ' },
  { icon: '🌳', label: 'Park, road or sign', prefix: 'Near me there is ' },
  { icon: '🔊', label: 'What I hear', prefix: 'I can hear ' },
  { icon: '🚪', label: 'The room', prefix: 'The room has ' },
  { icon: '👤', label: 'Who is with me', prefix: 'I am with ' },
];
const more = ref('');
const moreInput = ref<HTMLInputElement>();
const added = ref<string[]>([]);
const adding = ref(false);
function useTip(prefix: string) {
  if (!more.value.trim()) more.value = prefix;
  moreInput.value?.focus();
}
async function addMore() {
  const t = more.value.trim();
  if (!t || !sent.value || adding.value) return;
  adding.value = true;
  error.value = '';
  try {
    const r = await api<{ newId?: string }>(`/kid/${props.token}/details`, {
      body: { id: sent.value.id, key: deviceKey.value, text: t },
    });
    added.value.push(t);
    more.value = '';
    // An urgent detail became its own alert: follow that one instead.
    if (r.newId) {
      sent.value = { ...sent.value, id: r.newId, status: 'calling', by: null };
      startPolling();
    }
  } catch (e) {
    error.value = (e as Error).message || 'Could not send. Try again.';
  } finally {
    adding.value = false;
  }
}

const sentTitle = computed(() => {
  const s = sent.value;
  if (!s) return '';
  if (s.status === 'confirmed' || s.status === 'answered') return `${s.by ?? 'Your parent'} got your message`;
  if (s.status === 'calling') return s.sos ? "We're calling your parents" : 'Calling your parents…';
  return 'Message sent';
});
const sentHint = computed(() => {
  const s = sent.value;
  if (!s) return '';
  if (s.status === 'confirmed' || s.status === 'answered') return 'They heard it on the phone. 💛';
  if (s.status === 'calling') return 'Their phone is ringing. When they press 1, you will see it here.';
  if (s.status === 'unanswered') return "They didn't pick up yet. Try again, or call someone you trust.";
  return 'Your parents will see it.';
});
</script>

<template>
  <div class="kid-bg min-h-dvh">
    <div
      class="mx-auto flex min-h-dvh max-w-md flex-col px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]"
    >
      <div v-if="!info && error" class="m-auto text-center text-muted">{{ error }}</div>

      <!-- PIN -->
      <div v-else-if="info && locked" class="m-auto w-full max-w-xs text-center">
        <BunniesHug class="mx-auto w-40" />
        <h1 class="mt-3 text-2xl font-bold">Hello! 👋</h1>
        <p class="mt-1 text-muted">Enter your secret PIN</p>
        <div class="mt-5 flex justify-center gap-3" aria-live="polite">
          <span
            v-for="i in Math.max(4, pin.length)"
            :key="i"
            class="size-4 rounded-full border-2 border-sky-500"
            :class="i <= pin.length && 'bg-sky-500'"
          />
        </div>
        <p v-if="error" class="mt-3 text-rose-600" role="alert">{{ error }}</p>
        <div class="mt-6 grid grid-cols-3 gap-3">
          <button
            v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']"
            :key="d"
            class="h-16 rounded-2xl bg-surface text-2xl font-bold shadow-sm active:bg-sky-50"
            @click="pressDigit(d)"
          >
            {{ d }}
          </button>
          <button class="h-16 rounded-2xl text-muted" aria-label="Delete" @click="pin = pin.slice(0, -1)">
            ⌫
          </button>
          <button
            class="h-16 rounded-2xl bg-surface text-2xl font-bold shadow-sm active:bg-sky-50"
            @click="pressDigit('0')"
          >
            0
          </button>
          <button
            class="h-16 rounded-2xl bg-sky-600 font-bold text-white disabled:opacity-40"
            :disabled="pin.length < 4"
            @click="unlock"
          >
            OK
          </button>
        </div>
      </div>

      <template v-else-if="info">
        <header class="mb-2 flex items-center gap-3">
          <div class="flex-1">
            <p class="text-muted">Hi there 👋</p>
            <h1 class="text-2xl font-bold tracking-tight">Send a message home</h1>
          </div>
          <BunniesHug class="w-24 shrink-0" />
        </header>

        <!-- Sent -->
        <div
          v-if="sent"
          class="card flex flex-1 flex-col items-center justify-center text-center"
          aria-live="polite"
        >
          <span
            class="grid size-16 place-items-center rounded-full"
            :class="sent.status === 'calling' ? 'bg-sky-100 text-sky-700' : 'bg-sage-100 text-sage-700'"
          >
            <Icon
              :name="sent.status === 'calling' ? 'phone' : 'check'"
              :size="30"
              :class="sent.status === 'calling' && 'animate-pulse'"
            />
          </span>
          <h2 class="mt-5 text-xl font-bold">{{ sentTitle }}</h2>
          <p class="mt-2 text-muted">{{ sentHint }}</p>
          <p v-if="sent.sos" class="mt-4 rounded-2xl bg-sky-50 px-4 py-3 text-sm">
            If you are in danger right now, call <strong>999</strong> (police) or
            <strong>995</strong> (ambulance).
          </p>

          <!-- Tell us more -->
          <div class="mt-6 w-full rounded-2xl bg-paper/70 p-4 text-left">
            <h3 class="font-bold">Help them find you</h3>
            <p class="text-sm text-muted">If you can, tell us more. Tap one, then type.</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                v-for="t in TIPS"
                :key="t.label"
                type="button"
                class="min-h-11 rounded-full border border-line bg-surface px-3 text-sm font-medium active:bg-sky-50"
                @click="useTip(t.prefix)"
              >
                <span aria-hidden="true">{{ t.icon }}</span> {{ t.label }}
              </button>
            </div>
            <form class="mt-3 flex gap-2" @submit.prevent="addMore">
              <input
                ref="moreInput"
                v-model="more"
                class="field"
                placeholder="e.g. I can see a 7-Eleven and a bus stop"
                enterkeyhint="send"
                aria-label="Tell us more"
              />
              <button class="btn-primary !px-4" :disabled="!more.trim() || adding" aria-label="Add">
                <Icon name="send" :size="18" />
              </button>
            </form>
            <ul v-if="added.length" class="mt-3 space-y-1 text-sm" aria-live="polite">
              <li v-for="(a, i) in added" :key="i" class="text-sage-700">✓ {{ a }}</li>
            </ul>
            <p v-if="info.shareLocation" class="mt-3 text-sm" aria-live="polite">
              <span v-if="gpsState === 'sent'" class="text-sage-700">📍 Your location was sent.</span>
              <span v-else-if="gpsState === 'asking'" class="text-muted">📍 Finding your location…</span>
              <template v-else>
                <button type="button" class="btn-quiet !min-h-11" @click="shareLocation()">
                  📍 Share my location
                </button>
                <span v-if="gpsState === 'denied'" class="mt-1 block text-muted">
                  Location is turned off for this page. Allow it in your browser settings, or type where you
                  are.
                </span>
              </template>
            </p>
          </div>
          <p v-if="error" class="mt-3 text-rose-600" role="alert">{{ error }}</p>
          <button class="btn-quiet mt-6" @click="sent = null">Send another</button>
        </div>

        <template v-else>
          <!-- Quick replies -->
          <div class="mt-4 grid grid-cols-2 gap-3">
            <button
              v-for="(q, i) in info.quickReplies"
              :key="q"
              class="relative min-h-16 rounded-2xl border border-line bg-surface px-4 py-3 text-left font-semibold shadow-sm active:bg-blush-50"
              :disabled="sending"
              @click="send(q)"
            >
              <span :class="i % 2 ? 'text-sky-700' : 'text-sage-700'">{{ q }}</span>
            </button>
          </div>

          <!-- Free text -->
          <form class="pt-5" @submit.prevent="send(text)">
            <label class="label" for="msg">Or write a message</label>
            <div class="flex gap-2">
              <input id="msg" v-model="text" class="field" placeholder="Type here…" enterkeyhint="send" />
              <button class="btn-primary !px-4" :disabled="!text.trim() || sending" aria-label="Send">
                <Icon name="send" :size="18" />
              </button>
            </div>
          </form>
          <p class="mt-6 rounded-2xl bg-white/70 px-4 py-3 text-center text-sm text-muted">
            📞 Your parent's phone will ring and read your message. When they <strong>press 1</strong>, you'll
            see “heard you ✓” here.
            <span v-if="info.shareLocation" class="mt-1 block"
              >📍 Your location is sent too, so they can find you.</span
            >
          </p>
          <p v-if="error" class="mt-3 text-center text-rose-600" role="alert">{{ error }}</p>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.kid-bg {
  background-image:
    url('/decor/pompoms.svg'),
    radial-gradient(40rem 30rem at 100% 0%, var(--color-blush-100), transparent 60%),
    radial-gradient(40rem 30rem at 0% 100%, var(--color-sky-100), transparent 60%);
  background-size:
    420px 420px,
    auto,
    auto;
}
</style>
