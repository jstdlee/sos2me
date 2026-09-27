<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, sessionExpired } from './api';
import Icon, { type IconName } from './components/Icon.vue';
import { markLoggedOut } from './router';

const route = useRoute();
const router = useRouter();
const bare = computed(() => route.meta.public);

const nav: { to: string; label: string; icon: IconName }[] = [
  { to: '/admin', label: 'Home', icon: 'home' },
  { to: '/admin/messages', label: 'Messages', icon: 'inbox' },
  { to: '/admin/settings', label: 'Settings', icon: 'settings' },
  { to: '/admin/activity', label: 'Activity', icon: 'activity' },
];
const isActive = (to: string) => (to === '/admin' ? route.path === '/admin' : route.path.startsWith(to));

watch(sessionExpired, (v) => {
  if (v) router.push({ name: 'login', query: { next: route.fullPath } });
});

async function logout() {
  await api('/logout', { body: {} }).catch(() => undefined);
  markLoggedOut();
  router.push('/admin/login');
}
</script>

<template>
  <RouterView v-if="bare" />
  <div v-else class="min-h-dvh pb-24 sm:pb-10">
    <header class="sticky top-0 z-20 border-b border-line/70 bg-paper/90 backdrop-blur">
      <div class="mx-auto flex h-16 max-w-4xl items-center gap-6 px-4 sm:px-6">
        <RouterLink to="/admin" class="flex items-center gap-2.5 font-semibold tracking-tight">
          <span class="grid size-8 place-items-center rounded-xl bg-sage-600 text-white"
            ><Icon name="phone" :size="16"
          /></span>
          SOS2me
        </RouterLink>
        <nav class="hidden flex-1 gap-1 sm:flex">
          <RouterLink
            v-for="n in nav"
            :key="n.to"
            :to="n.to"
            class="rounded-full px-4 py-2 text-[0.95rem] text-muted transition-colors hover:text-ink"
            :class="isActive(n.to) && 'bg-surface text-ink shadow-[0_0_0_1px_var(--color-line)]'"
            >{{ n.label }}</RouterLink
          >
        </nav>
        <button
          class="ml-auto flex items-center gap-2 text-sm text-muted hover:text-ink sm:ml-0"
          @click="logout"
        >
          <Icon name="logout" :size="18" /> <span class="hidden sm:inline">Log out</span>
        </button>
      </div>
    </header>

    <main class="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <RouterView />
    </main>

    <!-- Bottom tab bar on phones -->
    <nav
      class="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden"
    >
      <RouterLink
        v-for="n in nav"
        :key="n.to"
        :to="n.to"
        class="flex flex-col items-center gap-1 py-2.5 text-xs"
        :class="isActive(n.to) ? 'text-sage-700' : 'text-faint'"
      >
        <Icon :name="n.icon" :size="22" />
        {{ n.label }}
      </RouterLink>
    </nav>
  </div>
</template>
