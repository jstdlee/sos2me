import type { Config } from '../shared/types';
import type { Env } from './env';

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  apiKeySid: string;
  apiKeySecret: string;
  fromNumber: string;
  apiBase: string;
}

/** Dashboard settings win; secrets in the environment are the fallback. */
export function twilioCreds(env: Env, cfg: Config): TwilioCreds {
  const t = cfg.twilio;
  return {
    accountSid: t.accountSid || env.TWILIO_ACCOUNT_SID || '',
    authToken: t.authToken || env.TWILIO_AUTH_TOKEN || '',
    apiKeySid: t.apiKeySid || env.TWILIO_API_KEY_SID || '',
    apiKeySecret: t.apiKeySecret || env.TWILIO_API_KEY_SECRET || '',
    fromNumber: t.fromNumber || env.TWILIO_FROM_NUMBER || '',
    apiBase: env.TWILIO_API_BASE || 'https://api.twilio.com',
  };
}

export const twilioConfigured = (c: TwilioCreds) =>
  Boolean(c.accountSid && c.fromNumber && (c.authToken || (c.apiKeySid && c.apiKeySecret)));

function authHeader(c: TwilioCreds): string {
  const useKey = c.apiKeySid && c.apiKeySecret;
  return 'Basic ' + btoa(`${useKey ? c.apiKeySid : c.accountSid}:${useKey ? c.apiKeySecret : c.authToken}`);
}

async function twilioRequest(
  c: TwilioCreds,
  path: string,
  form?: [string, string][],
): Promise<Record<string, unknown> & { incoming_phone_numbers?: unknown[] }> {
  if (!c.accountSid || !(c.authToken || c.apiKeySecret)) throw new Error('Twilio is not configured');
  const res = await fetch(`${c.apiBase}/2010-04-01/Accounts/${c.accountSid}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: authHeader(c),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const hints: Record<number, string> = {
      20008: ' (these are Test credentials — use the Live Account SID and Auth Token)',
      20003: ' (wrong Account SID / token / API key combination)',
      70004: ' (this API key lacks permission, or belongs to a different Account SID — use a Standard key)',
    };
    const hint = hints[Number(data.code)] ?? '';
    throw new Error(`Twilio ${res.status}: ${String(data.message ?? res.statusText)}${hint}`);
  }
  return data;
}

export async function sendSms(c: TwilioCreds, to: string, body: string): Promise<string> {
  const data = await twilioRequest(c, '/Messages.json', [
    ['To', to],
    ['From', c.fromNumber],
    ['Body', body.slice(0, 1500)],
  ]);
  return String(data.sid ?? '');
}

export async function placeCall(
  c: TwilioCreds,
  opts: { to: string; twiml: string; statusUrl?: string; ringSeconds?: number },
): Promise<string> {
  // The spoken message travels with the call, so it plays even if our public address is unknown or
  // unreachable. Status callbacks are an optional speed-up; we also poll Twilio (see escalation.ts).
  const callbacks: [string, string][] = opts.statusUrl
    ? [
        ['StatusCallback', opts.statusUrl],
        ['StatusCallbackMethod', 'POST'],
        ['StatusCallbackEvent', 'answered'],
        ['StatusCallbackEvent', 'completed'],
      ]
    : [];
  const data = await twilioRequest(c, '/Calls.json', [
    ['To', opts.to],
    ['From', c.fromNumber],
    ['Twiml', opts.twiml],
    ...callbacks,
    ['Timeout', String(opts.ringSeconds ?? 30)],
  ]);
  return String(data.sid ?? '');
}

/** Current state of a call, for when status callbacks can't reach us. */
export async function fetchCall(
  c: TwilioCreds,
  callSid: string,
): Promise<{ status: string; duration: number }> {
  const data = await twilioRequest(c, `/Calls/${callSid}.json`);
  return { status: String(data.status ?? ''), duration: Number(data.duration ?? 0) };
}

/** Hang up a call that is still ringing/in progress (e.g. someone else already confirmed). */
export async function endCall(c: TwilioCreds, callSid: string): Promise<void> {
  await twilioRequest(c, `/Calls/${callSid}.json`, [['Status', 'completed']]).catch(() => undefined);
}

/** For the daily check: account status and remaining balance. */
export async function accountHealth(c: TwilioCreds): Promise<string> {
  // API keys may not read the Account resource (error 70004), so use Balance + the from-number.
  const bal = await twilioRequest(c, '/Balance.json');
  const balance = `${bal.balance} ${bal.currency}`;
  if (Number(bal.balance) < 2) throw new Error(`Twilio balance is low: ${balance}`);
  const testServer =
    c.apiBase !== 'https://api.twilio.com' ? ` [TEST SERVER ${c.apiBase}, not real Twilio]` : '';
  const nums = await twilioRequest(c, '/IncomingPhoneNumbers.json?PageSize=50');
  const list = (Array.isArray(nums.incoming_phone_numbers) ? nums.incoming_phone_numbers : []).map((n) =>
    String((n as { phone_number?: string }).phone_number ?? ''),
  );
  if (!list.includes(c.fromNumber)) {
    const found = list.length
      ? `numbers on this account: ${list.join(', ')}`
      : 'no numbers found on this account';
    throw new Error(`${c.fromNumber} was not found (${found})${testServer}`);
  }
  if (c.authToken && c.apiKeySid) {
    // Callbacks are signed with the account's Auth Token; a Test token here would reject them all.
    const tokenOnly = { ...c, apiKeySid: '', apiKeySecret: '' };
    await twilioRequest(tokenOnly, '/Balance.json').catch((e) => {
      throw new Error(
        `Auth Token doesn't belong to ${c.accountSid} (Test token?) — calls couldn't be confirmed. ${e}`,
      );
    });
  }
  const warn = c.authToken ? '' : ' — add the Live Auth Token so callbacks can be verified';
  return `balance ${balance}, calling from ${c.fromNumber}${warn}${testServer}`;
}

// ── Webhook signature (https://www.twilio.com/docs/usage/webhooks/webhooks-security) ──

export async function verifySignature(
  authToken: string,
  request: Request,
  params: Record<string, string>,
): Promise<boolean> {
  if (!authToken) return true; // cannot verify without the auth token; flagged in the dashboard
  const signature = request.headers.get('X-Twilio-Signature');
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], request.url);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// ── TwiML ───────────────────────────────────────────────

const xml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

export function twiml(inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

export function say(text: string, voice: { language: string; voice: string }): string {
  const attrs = [`language="${xml(voice.language || 'en-US')}"`];
  if (voice.voice) attrs.push(`voice="${xml(voice.voice)}"`);
  return `<Say ${attrs.join(' ')}>${xml(text)}</Say>`;
}

export function gather(actionUrl: string, inner: string, timeoutSeconds = 8): string {
  return `<Gather input="dtmf" numDigits="1" timeout="${timeoutSeconds}" method="POST" action="${xml(actionUrl)}">${inner}</Gather>`;
}
