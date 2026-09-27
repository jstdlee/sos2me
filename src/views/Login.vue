<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import BunnyPeek from '../components/BunnyPeek.vue';
import Icon from '../components/Icon.vue';

const password = ref('');
const error = ref('');
const busy = ref(false);
const router = useRouter();
const route = useRoute();

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await api('/login', { body: { password: password.value } });
    router.replace(typeof route.query.next === 'string' ? route.query.next : '/admin');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-4">
    <form class="w-full max-w-sm" @submit.prevent="submit">
      <div class="mb-14 text-center">
        <span class="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-sage-600 text-white"
          ><Icon name="phone" :size="26"
        /></span>
        <h1 class="text-2xl font-semibold tracking-tight">SOS2me</h1>
        <p class="mt-1 text-muted">Your child's messages, as a phone call.</p>
      </div>
      <div class="relative isolate">
        <BunnyPeek tone="grey" class="absolute -top-[3.3rem] right-8 -z-10 w-20" />
        <div class="card space-y-4">
          <div>
            <label class="label" for="pw">Parent password</label>
            <input
              id="pw"
              v-model="password"
              type="password"
              class="field"
              autocomplete="current-password"
              autofocus
              required
            />
          </div>
          <p v-if="error" class="rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-600" role="alert">
            {{ error }}
          </p>
          <button class="btn-primary w-full" :disabled="busy">{{ busy ? 'Checking…' : 'Sign in' }}</button>
        </div>
      </div>
    </form>
  </div>
</template>
