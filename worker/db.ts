import {
  DEFAULT_CONFIG,
  EMPTY_MAILBOX,
  EMPTY_NTFY,
  SECRET_MASK,
  type AlertStatus,
  type Config,
  type EventRow,
  type MessageContext,
  type MessageRow,
  type Situation,
} from '../shared/types';
import type { Env } from './env';
import { timingSafeEqual } from './twilio';

export const nowIso = () => new Date().toISOString();

export function randomToken(bytes = 18): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Password / PIN hashing ──────────────────────────────
// Stored as "h:<salt>:<sha256(salt:value)>". Anything else in these fields is a new plain value.
// The salt is derived from the value, so re-applying the same config.json produces the same
// hash — sessions and kid devices stay signed in. (A 4-digit PIN can't be protected by salting
// anyway; the real protection is that D1 is private and guesses are rate-limited.)

const isHashed = (v: string) => v.startsWith('h:');
export async function hashSecret(value: string): Promise<string> {
  const salt = (await sha256Hex(`sos2me-salt:${value}`)).slice(0, 12);
  return `h:${salt}:${await sha256Hex(`${salt}:${value}`)}`;
}
export async function verifyHashed(stored: string, value: string): Promise<boolean> {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(await sha256Hex(`${salt}:${value}`), hash);
}

// ── Settings ────────────────────────────────────────────

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, nowIso())
    .run();
}

/** Deep-merge stored config over defaults so new fields get sensible values after upgrades. */
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
  if (defaults && typeof defaults === 'object') {
    const src = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaults)) out[k] = mergeDefaults(v, src[k]);
    return out as T;
  }
  if (typeof defaults === 'number' && typeof stored === 'string' && stored.trim() !== '' && !isNaN(+stored)) {
    return Number(stored) as T;
  }
  return (
    stored === undefined || stored === null || typeof stored !== typeof defaults ? defaults : stored
  ) as T;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
const list = (xs: string[]) => [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];
const id = (x: { id?: string }) => String(x.id || randomToken(6));
const str = (v: unknown) => String(v ?? '').trim();

/** Fill missing fields with defaults and clean user input. Does not hash (see finalizeSecrets). */
export function normalizeConfig(input: unknown): Config {
  const cfg = mergeDefaults(DEFAULT_CONFIG, input);
  cfg.childName = cfg.childName.trim().slice(0, 40) || DEFAULT_CONFIG.childName;
  cfg.childAge = str(cfg.childAge).slice(0, 10);
  cfg.publicBaseUrl = str(cfg.publicBaseUrl).replace(/\/+$/, '');
  cfg.contacts = cfg.contacts
    .map((c) => ({
      id: id(c),
      name: str(c.name).slice(0, 40),
      phone: str(c.phone).replace(/[\s()-]/g, ''),
      email: str(c.email).toLowerCase(),
      enabled: c.enabled !== false,
    }))
    .filter((c) => c.phone || c.name || c.email);
  for (const p of Object.values(cfg.policy)) {
    p.rounds = clamp(p.rounds, 1, 20);
    p.retryMinutes = clamp(p.retryMinutes, 1, 120);
    p.redialOnDecline = Math.max(0, Math.min(3, Math.round(Number(p.redialOnDecline) || 0)));
  }
  cfg.rules.urgentKeywords = list(cfg.rules.urgentKeywords);
  cfg.ai.timeoutSeconds = clamp(cfg.ai.timeoutSeconds, 3, 30);
  cfg.situation.windowHours = clamp(cfg.situation.windowHours, 1, 72);
  cfg.situation.maxMessages = clamp(cfg.situation.maxMessages, 1, 20);
  cfg.ai.models = cfg.ai.models
    .map((m) => ({
      id: id(m),
      provider: (['workers-ai', 'openrouter', 'openai'] as const).includes(m.provider)
        ? m.provider
        : 'workers-ai',
      model: str(m.model),
      enabled: m.enabled !== false,
    }))
    .filter((m) => m.model);
  for (const k of Object.keys(cfg.twilio) as (keyof Config['twilio'])[]) cfg.twilio[k] = str(cfg.twilio[k]);
  for (const k of Object.keys(cfg.services) as (keyof Config['services'])[])
    cfg.services[k] = str(cfg.services[k]);
  const ch = cfg.channels;
  ch.allowedSenders = list(ch.allowedSenders).map((x) => x.toLowerCase());
  ch.watchNames = list(ch.watchNames).slice(0, 20);
  // OpenRouter keys are "sk-or-v1-" + 64 hex chars; accept the bare hex part too.
  if (/^[0-9a-f]{64}$/i.test(cfg.services.openrouterApiKey)) {
    cfg.services.openrouterApiKey = `sk-or-v1-${cfg.services.openrouterApiKey}`;
  }
  ch.kidPage.quickReplies = list(ch.kidPage.quickReplies).slice(0, 8);
  ch.emailRouting.forwardTo = str(ch.emailRouting.forwardTo);
  ch.mailboxes = ch.mailboxes.map((m) => ({
    ...mergeDefaults({ ...EMPTY_MAILBOX }, m),
    id: id(m),
    type: m.type === 'imap' ? 'imap' : 'agentmail',
    address: str(m.address),
    port: clamp(m.port || 993, 1, 65535),
  }));
  ch.ntfy = ch.ntfy.map((n) => ({
    ...mergeDefaults({ ...EMPTY_NTFY }, n),
    id: id(n),
    baseUrl: str(n.baseUrl || 'https://ntfy.sh').replace(/\/+$/, ''),
    topic: str(n.topic),
    username: str(n.username),
  }));
  cfg.health.time = /^\d{1,2}:\d{2}$/.test(cfg.health.time) ? cfg.health.time.padStart(5, '0') : '09:00';
  cfg.health.extraEmails = list(cfg.health.extraEmails).map((x) => x.toLowerCase());
  return cfg;
}

/** Hash any plain admin password / kid PIN. Returns true if something changed. */
async function hashPlainSecrets(cfg: Config): Promise<boolean> {
  let changed = false;
  if (cfg.adminPassword && !isHashed(cfg.adminPassword)) {
    cfg.adminPassword = await hashSecret(cfg.adminPassword);
    changed = true;
  }
  const kp = cfg.channels.kidPage;
  if (kp.pin && !isHashed(kp.pin)) {
    kp.pin = await hashSecret(kp.pin);
    changed = true;
  }
  if (!kp.token) {
    kp.token = randomToken();
    changed = true;
  }
  return changed;
}

export async function loadConfig(env: Env): Promise<Config> {
  const raw = await getSetting(env, 'config');
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const cfg = normalizeConfig(parsed);
  // Persist on first load of a config.json-seeded row: hashes passwords and fixes list ids,
  // so ids stay stable between loads (secrets in lists are matched back by id on save).
  if ((await hashPlainSecrets(cfg)) || !listsHaveIds(parsed)) await saveConfig(env, cfg);
  return cfg;
}

function listsHaveIds(raw: unknown): boolean {
  const c = (raw ?? {}) as Partial<Config>;
  const lists: unknown[][] = [
    c.contacts ?? [],
    c.ai?.models ?? [],
    c.channels?.mailboxes ?? [],
    c.channels?.ntfy ?? [],
  ];
  return lists.every((l) => l.every((x) => !!(x as { id?: string }).id));
}

export async function saveConfig(env: Env, cfg: Config): Promise<void> {
  await putSetting(env, 'config', JSON.stringify(cfg));
}

// ── Secrets in the GUI: never sent to the browser ─────────

const SERVICE_SECRETS = [
  'agentmailApiKey',
  'openrouterApiKey',
  'openaiApiKey',
  'cloudflareApiToken',
] as const;

/** Copy for the browser with every secret replaced by SECRET_MASK (or '' when unset). */
export function maskSecrets(cfg: Config): Config {
  const out = structuredClone(cfg);
  const m = (v: string) => (v ? SECRET_MASK : '');
  out.adminPassword = m(out.adminPassword);
  out.channels.kidPage.pin = m(out.channels.kidPage.pin);
  out.twilio.authToken = m(out.twilio.authToken);
  out.twilio.apiKeySecret = m(out.twilio.apiKeySecret);
  for (const k of SERVICE_SECRETS) out.services[k] = m(out.services[k]);
  for (const b of out.channels.mailboxes) {
    b.apiKey = m(b.apiKey);
    b.password = m(b.password);
  }
  for (const n of out.channels.ntfy) n.token = m(n.token);
  return out;
}

/** Wherever the browser sent SECRET_MASK ("unchanged"), put the stored secret back. */
export function restoreSecrets(inc: Config, cur: Config): Config {
  const keep = (v: string, old: string | undefined) => (v === SECRET_MASK ? (old ?? '') : v);
  inc.adminPassword = keep(inc.adminPassword, cur.adminPassword);
  inc.channels.kidPage.pin = keep(inc.channels.kidPage.pin, cur.channels.kidPage.pin);
  inc.twilio.authToken = keep(inc.twilio.authToken, cur.twilio.authToken);
  inc.twilio.apiKeySecret = keep(inc.twilio.apiKeySecret, cur.twilio.apiKeySecret);
  for (const k of SERVICE_SECRETS) inc.services[k] = keep(inc.services[k], cur.services[k]);
  for (const b of inc.channels.mailboxes) {
    const old = cur.channels.mailboxes.find((x) => x.id === b.id);
    b.apiKey = keep(b.apiKey, old?.apiKey);
    b.password = keep(b.password, old?.password);
  }
  for (const n of inc.channels.ntfy)
    n.token = keep(n.token, cur.channels.ntfy.find((x) => x.id === n.id)?.token);
  // An empty admin password field means "keep", so the dashboard can't lock itself out by accident.
  if (!inc.adminPassword) inc.adminPassword = cur.adminPassword;
  return inc;
}

export async function finalizeConfig(cfg: Config): Promise<Config> {
  await hashPlainSecrets(cfg);
  return cfg;
}

// ── Messages ────────────────────────────────────────────

export async function insertMessage(
  env: Env,
  m: Omit<MessageRow, 'updated_at' | 'acknowledged_by' | 'insight' | 'context' | 'situation'> & {
    insight?: string;
    context?: string;
    situation?: string;
  },
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (id, source, sender, subject, body, received_at, level, reason, insight, status, context, situation, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?6)`,
  )
    .bind(
      m.id,
      m.source,
      m.sender,
      m.subject,
      m.body,
      m.received_at,
      m.level,
      m.reason,
      m.insight ?? '',
      m.status,
      m.context ?? '',
      m.situation ?? '',
    )
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setMessageContext(env: Env, id: string, context: MessageContext): Promise<void> {
  await env.DB.prepare('UPDATE messages SET context = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, JSON.stringify(context), nowIso())
    .run();
}

export async function setMessageSituation(env: Env, id: string, situation: Situation): Promise<void> {
  await env.DB.prepare('UPDATE messages SET situation = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, JSON.stringify(situation), nowIso())
    .run();
}

/** The child's messages between two times, oldest first (tests excluded). For the usual routine. */
export async function olderMessages(
  env: Env,
  sinceIso: string,
  beforeIso: string,
  limit: number,
): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE received_at >= ? AND received_at < ? AND source != 'test' ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(sinceIso, beforeIso, limit)
    .all<MessageRow>();
  return results.reverse();
}

/** The child's messages since `sinceIso`, oldest first (tests excluded). */
export async function recentMessages(env: Env, sinceIso: string, limit: number): Promise<MessageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM messages WHERE received_at >= ? AND source != 'test' ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(sinceIso, limit)
    .all<MessageRow>();
  return results.reverse();
}

export async function messageExists(env: Env, id: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM messages WHERE id = ?').bind(id).first());
}

export async function setMessageStatus(
  env: Env,
  id: string,
  status: AlertStatus,
  acknowledgedBy?: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE messages SET status = ?2, acknowledged_by = COALESCE(?3, acknowledged_by), updated_at = ?4 WHERE id = ?1`,
  )
    .bind(id, status, acknowledgedBy ?? null, nowIso())
    .run();
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>();
}

export async function listMessages(env: Env, limit = 50, before?: string): Promise<MessageRow[]> {
  const stmt = before
    ? env.DB.prepare('SELECT * FROM messages WHERE received_at < ? ORDER BY received_at DESC LIMIT ?').bind(
        before,
        limit,
      )
    : env.DB.prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT ?').bind(limit);
  const { results } = await stmt.all<MessageRow>();
  return results;
}

// ── Events ──────────────────────────────────────────────

export async function logEvent(
  env: Env,
  kind: string,
  detail: string | Record<string, unknown> = '',
  messageId: string | null = null,
): Promise<void> {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  try {
    await env.DB.prepare('INSERT INTO events (ts, message_id, kind, detail) VALUES (?, ?, ?, ?)')
      .bind(nowIso(), messageId, kind, text.slice(0, 2000))
      .run();
  } catch (e) {
    console.error('logEvent failed', kind, e);
  }
}

export async function listEvents(
  env: Env,
  opts: { messageId?: string; limit?: number } = {},
): Promise<EventRow[]> {
  const limit = opts.limit ?? 100;
  const stmt = opts.messageId
    ? env.DB.prepare('SELECT * FROM events WHERE message_id = ? ORDER BY id ASC LIMIT ?').bind(
        opts.messageId,
        limit,
      )
    : env.DB.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').bind(limit);
  const { results } = await stmt.all<EventRow>();
  return results;
}
