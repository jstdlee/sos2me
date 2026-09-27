import { createRouter, createWebHistory } from 'vue-router';
import { api, sessionExpired } from './api';

// "/" is the kid page (PIN-protected, when enabled in Settings → Kid channels).
// The parent dashboard lives under /admin.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'kid-home',
      component: () => import('./views/Kid.vue'),
      props: { token: 'home' },
      meta: { public: true },
    },
    // Secret-link variant, always available: /k/<token>
    {
      path: '/k/:token',
      name: 'kid',
      component: () => import('./views/Kid.vue'),
      props: true,
      meta: { public: true },
    },
    {
      path: '/admin/login',
      name: 'login',
      component: () => import('./views/Login.vue'),
      meta: { public: true },
    },
    { path: '/admin', name: 'home', component: () => import('./views/Home.vue') },
    { path: '/admin/messages', name: 'messages', component: () => import('./views/Messages.vue') },
    {
      path: '/admin/messages/:id',
      name: 'message',
      component: () => import('./views/MessageDetail.vue'),
      props: true,
    },
    {
      path: '/admin/settings/:tab?',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
      props: true,
    },
    { path: '/admin/activity', name: 'activity', component: () => import('./views/Activity.vue') },
    // Old dashboard URLs → /admin
    { path: '/login', redirect: '/admin/login' },
    { path: '/messages/:rest(.*)*', redirect: (to) => `/admin${to.fullPath}` },
    { path: '/settings/:rest(.*)*', redirect: (to) => `/admin${to.fullPath}` },
    { path: '/activity', redirect: '/admin/activity' },
    { path: '/admin/:rest(.*)*', redirect: '/admin' },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

let checked = false;
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  if (!checked || sessionExpired.value) {
    const s = await api<{ authed: boolean }>('/session').catch(() => ({ authed: false }));
    checked = s.authed;
    sessionExpired.value = false;
    if (!s.authed) return { name: 'login', query: { next: to.fullPath } };
  }
  return true;
});

export function markLoggedOut() {
  checked = false;
}
