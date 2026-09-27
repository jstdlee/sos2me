<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AlertStatus } from '../../shared/types';
import { api, ApiError } from '../api';
import BunniesHug from '../components/BunniesHug.vue';
import Icon from '../components/Icon.vue';

const props = defineProps<{ token: string }>();
const storeKey = `sos2me:kid:${props.token}`;

const info = ref<{ pinRequired: boolean; quickReplies: string[] }>();
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

// ── Send ──
async function send(body: string, sos = false) {
  if (sending.value) return;
  sending.value = true;
  error.value = '';
  try {
    const r = await api<{ id: string; status: AlertStatus }>(`/kid/${props.token}/send`, {
      body: { text: body, sos, key: deviceKey.value },
    });
    sent.value = { id: r.id, sos, status: r.status, by: null };
    text.value = '';
    startPolling();
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
          <button class="btn-quiet mt-8" @click="sent = null">Send another</button>
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
