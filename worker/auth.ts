import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../shared/types';
import { getSetting, loadConfig, putSetting, randomToken, verifyHashed } from './db';
import type { Env } from './env';
import { timingSafeEqual } from './twilio';

const COOKIE = 'sos_session';
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days — parents shouldn't have to log in often

export async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** SESSION_SECRET if set, otherwise a random secret generated once and kept in D1. */
export async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await getSetting(env, 'sessionSecret');
  if (!s) {
    s = randomToken(32);
    await putSetting(env, 'sessionSecret', s);
  }
  return s;
}

export const passwordIsSet = (env: Env, cfg: Config) => Boolean(cfg.adminPassword || env.ADMIN_PASSWORD);

export async function checkPassword(env: Env, cfg: Config, password: string): Promise<boolean> {
  if (!password) return false;
  if (cfg.adminPassword) return verifyHashed(cfg.adminPassword, password); // set in the dashboard / config.json
  if (!env.ADMIN_PASSWORD) return false;
  const [a, b] = await Promise.all([hmac('pw', password), hmac('pw', env.ADMIN_PASSWORD)]);
  return timingSafeEqual(a, b);
}

/** Changing the password invalidates every session: the signature includes a password fingerprint. */
const fingerprint = (env: Env, cfg: Config) => (cfg.adminPassword || env.ADMIN_PASSWORD || '').slice(-12);

export async function startSession(c: Context<{ Bindings: Env }>, cfg: Config): Promise<void> {
  const exp = String(Date.now() + MAX_AGE_S * 1000);
  const sig = await hmac(await sessionSecret(c.env), `${exp}.${fingerprint(c.env, cfg)}`);
  setCookie(c, COOKIE, `${exp}.${sig}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Strict',
    path: '/',
    maxAge: MAX_AGE_S,
  });
}

export function endSession(c: Context<{ Bindings: Env }>): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function isAuthed(c: Context<{ Bindings: Env }>, cfg?: Config): Promise<boolean> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const conf = cfg ?? (await loadConfig(c.env));
  if (!passwordIsSet(c.env, conf)) return false;
  return timingSafeEqual(await hmac(await sessionSecret(c.env), `${exp}.${fingerprint(c.env, conf)}`), sig);
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await isAuthed(c))) return c.json({ error: 'unauthorized' }, 401);
  // Cheap CSRF guard on top of SameSite=Strict: mutating calls must be JSON.
  if (c.req.method !== 'GET' && !c.req.header('content-type')?.includes('application/json')) {
    return c.json({ error: 'expected JSON' }, 415);
  }
  await next();
};

// ── Simple lockout for password / PIN guessing ──────────

export async function tooManyAttempts(env: Env, key: string): Promise<number> {
  const raw = await getSetting(env, `lock:${key}`);
  const st = raw ? (JSON.parse(raw) as { fails: number; until: number }) : { fails: 0, until: 0 };
  return st.until > Date.now() ? Math.ceil((st.until - Date.now()) / 60000) : 0;
}

/** Admin login: 5 tries, then 5 min. Kid page PIN: 10 tries, then 2 min (a child fumbling shouldn't wait long). */
export const LOCKOUT = { admin: { max: 5, ms: 5 * 60_000 }, kid: { max: 10, ms: 2 * 60_000 } } as const;

export async function recordAttempt(
  env: Env,
  key: string,
  ok: boolean,
  policy: { max: number; ms: number } = LOCKOUT.admin,
): Promise<void> {
  if (ok) return putSetting(env, `lock:${key}`, JSON.stringify({ fails: 0, until: 0 }));
  const raw = await getSetting(env, `lock:${key}`);
  const st = raw ? (JSON.parse(raw) as { fails: number; until: number }) : { fails: 0, until: 0 };
  st.fails += 1;
  if (st.fails >= policy.max) {
    st.until = Date.now() + policy.ms;
    st.fails = 0;
  }
  await putSetting(env, `lock:${key}`, JSON.stringify(st));
}
