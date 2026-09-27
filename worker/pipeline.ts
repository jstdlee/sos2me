import type { AlertStatus, Config, Level, Source } from '../shared/types';
import { classify } from './classify';
import { getSetting, insertMessage, loadConfig, logEvent, nowIso, putSetting, sha256Hex } from './db';
import type { Env } from './env';
import { parentEmails, sendParentsMail } from './mailer';
import { sendSms, twilioConfigured, twilioCreds } from './twilio';

export interface Incoming {
  source: Source;
  sender: string;
  subject?: string;
  body: string;
  /** Stable id from the source (email Message-ID, ntfy id); used to ignore duplicates. */
  externalId?: string;
  /** The kid page's SOS button skips classification. */
  forceUrgent?: boolean;
  /**
   * Set when the email is from someone other than the child but mentions them (e.g. "Alex").
   * Such messages only notify parents when the result is urgent or check-in.
   */
  mentions?: string;
}

export async function publicBaseUrl(env: Env, cfg: Config): Promise<string> {
  const url = cfg.publicBaseUrl || env.PUBLIC_BASE_URL || (await getSetting(env, 'publicBaseUrl')) || '';
  return url.replace(/\/+$/, '');
}

/** Random id of this installation, stored once in D1. */
export async function instanceId(env: Env): Promise<string> {
  let id = await getSetting(env, 'instanceId');
  if (!id) {
    id = crypto.randomUUID();
    await putSetting(env, 'instanceId', id);
  }
  return id;
}

/** Does `baseUrl` really serve this SOS2me (and not another site, or nothing)? */
export async function checkPublicAddress(
  env: Env,
  baseUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!baseUrl.startsWith('https://')) return { ok: false, detail: 'not an https address' };
  try {
    const res = await fetch(`${baseUrl}/api/ping`, { signal: AbortSignal.timeout(8000) });
    const raw = await res.text();
    // Cloudflare may refuse a Worker fetching its own hostname (error 1042) — that means it *is* us.
    if (/error code: 1042/.test(raw)) return { ok: true, detail: 'this Worker (self-check not possible)' };
    let data: { app?: string; instance?: string } | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON → another site */
    }
    if (data?.app !== 'sos2me')
      return { ok: false, detail: `it serves a different site (HTTP ${res.status})` };
    if (data.instance !== (await instanceId(env)))
      return { ok: false, detail: 'it serves a different SOS2me installation' };
    return { ok: true, detail: 'reachable' };
  } catch (e) {
    return { ok: false, detail: `unreachable (${e instanceof Error ? e.message : String(e)})` };
  }
}

const HEADLINE: Record<Level, string> = { urgent: 'URGENT', concern: 'Please check in', normal: 'Message' };

export function smsText(cfg: Config, level: Level, subject: string, body: string, insight: string): string {
  return [`[SOS2me] ${HEADLINE[level]} — ${cfg.childName}:`, subject, body, insight && `(Note: ${insight})`]
    .filter(Boolean)
    .join('\n');
}

/** Classify a message from the child, store it, and notify parents according to the policy. */
export async function handleIncoming(
  env: Env,
  msg: Incoming,
): Promise<{ id: string; status: AlertStatus } | null> {
  const cfg = await loadConfig(env);
  const subject = (msg.subject ?? '').trim();
  const body = msg.body.trim();
  const text = [subject, body].filter(Boolean).join('\n');

  const id = (await sha256Hex(`${msg.source}\u001f${msg.externalId ?? crypto.randomUUID()}`)).slice(0, 24);
  const aiErrors: string[] = [];
  const cls = msg.forceUrgent
    ? { level: 'urgent' as const, reason: 'SOS button', insight: '' }
    : await classify(
        env,
        cfg,
        text,
        (model, e) => aiErrors.push(`${model}: ${String(e)}`),
        msg.mentions && msg.sender,
      );
  // Everyday emails that merely mention the child (newsletters, receipts…) are recorded, not phoned in.
  const quiet = !!msg.mentions && cls.level === 'normal';

  const tw = twilioCreds(env, cfg);
  const policy = cfg.policy[cls.level];
  const contacts = cfg.contacts.filter((c) => c.enabled && c.phone.trim());
  const emails = parentEmails(cfg);
  const canCall = policy.call && contacts.length > 0 && twilioConfigured(tw);
  const canSms = policy.sms && contacts.length > 0 && twilioConfigured(tw);
  const canEmail = policy.email && emails.length > 0;
  const status: AlertStatus =
    cfg.paused || quiet ? 'logged' : canCall ? 'calling' : canSms || canEmail ? 'texted' : 'logged';

  const inserted = await insertMessage(env, {
    id,
    source: msg.source,
    sender: msg.sender,
    subject,
    body,
    received_at: nowIso(),
    level: cls.level,
    reason: cls.reason,
    insight: cls.insight,
    status,
  });
  if (!inserted) return null; // duplicate

  const via = msg.mentions ? `${msg.source}, from ${msg.sender} mentioning "${msg.mentions}"` : msg.source;
  await logEvent(env, 'received', `${cls.level.toUpperCase()} via ${via} — ${cls.reason}`, id);
  for (const e of aiErrors) await logEvent(env, 'ai_error', e, id);
  if (quiet) {
    await logEvent(
      env,
      'recorded_only',
      'Everyday email from another sender — recorded, nobody notified.',
      id,
    );
    return { id, status };
  }

  if (cfg.paused) {
    await logEvent(env, 'paused', 'Alerts are paused; nobody was notified.', id);
    return { id, status };
  }
  if ((policy.call || policy.sms) && !contacts.length)
    await logEvent(env, 'no_contacts', 'No active parent phone numbers.', id);
  if ((policy.call || policy.sms) && !twilioConfigured(tw)) {
    await logEvent(
      env,
      'twilio_missing',
      'Twilio is not set up (Settings → Connections); cannot call or text.',
      id,
    );
  }

  const sideJobs: Promise<unknown>[] = [];
  if (canSms) {
    const sms = smsText(cfg, cls.level, subject, body, cls.insight);
    for (const c of contacts) {
      sideJobs.push(
        sendSms(tw, c.phone, sms).then(
          () => logEvent(env, 'sms_sent', `SMS to ${c.name || c.phone}`, id),
          (e) => logEvent(env, 'sms_error', `${c.name || c.phone}: ${String(e)}`, id),
        ),
      );
    }
  }
  if (canEmail) {
    const subj = `[SOS2me] ${HEADLINE[cls.level]} — ${cfg.childName}${subject ? `: ${subject}` : ''}`;
    const txt = [
      `${cfg.childName} sent a message via ${msg.source}:`,
      '',
      body,
      '',
      ...(cls.insight ? [`AI note: ${cls.insight}`] : []),
      `Why: ${cls.reason}`,
    ].join('\n');
    sideJobs.push(
      sendParentsMail(cfg, emails, subj, txt).then(
        () => logEvent(env, 'email_sent', `Email to ${emails.join(', ')}`, id),
        (e) => logEvent(env, 'email_error', String(e), id),
      ),
    );
  }

  if (canCall) {
    // The public address is optional: without it calls still ring and read the message.
    const baseUrl = await publicBaseUrl(env, cfg);
    const stub = env.ESCALATION.get(env.ESCALATION.idFromName(id));
    sideJobs.push(
      stub.start({
        messageId: id,
        level: cls.level,
        contacts: contacts.map((c) => ({ name: c.name, phone: c.phone.trim() })),
        rounds: policy.rounds,
        retryMinutes: policy.retryMinutes,
        requireConfirm: policy.requireConfirm,
        redialOnDecline: policy.redialOnDecline,
        baseUrl,
      }),
    );
  }
  await Promise.all(sideJobs);
  return { id, status };
}
