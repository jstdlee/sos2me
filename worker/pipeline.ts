import {
  parseJson,
  type AlertStatus,
  type Config,
  type Level,
  type MessageContext,
  type Situation,
  type Source,
} from '../shared/types';
import { sendMail } from './agentmail';
import { classify, matchKeyword, type Classification } from './classify';
import { contextLines, enrichContext, mapLink, mergeLate, whereText } from './context';
import {
  getMessage,
  getSetting,
  insertMessage,
  loadConfig,
  logEvent,
  nowIso,
  putSetting,
  setMessageContext,
  setMessageSituation,
  sha256Hex,
} from './db';
import type { Env } from './env';
import { mailFrom, parentEmails, sendParentsMail } from './mailer';
import { buildSituation, situationLines, timelineEmailLines, type Prediction } from './situation';
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
  /** Kid page: GPS, device and connection info. */
  context?: MessageContext;
  /** Email from the child: the address to reply to, and the AgentMail inbox it arrived in (if any). */
  replyTo?: ReplyTarget;
}

export interface ReplyTarget {
  address: string;
  inbox?: { key: string; address: string };
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

/** Resolves to undefined if `p` takes longer than `ms` (p keeps running). */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/** How long an alert may wait for the AI prediction and the address lookup before calling anyway. */
const PREDICTION_GRACE_MS = 4000;

export function smsText(
  cfg: Config,
  level: Level,
  subject: string,
  body: string,
  insight: string,
  situation: Situation | null = null,
  context: MessageContext | null = null,
): string {
  return [
    `[SOS2me] ${HEADLINE[level]} — ${cfg.childName}:`,
    subject,
    body,
    situation
      ? `(${situation.now}${situation.likely ? ` Likely: ${situation.likely}` : ''})`
      : insight && `(Note: ${insight})`,
    context?.gps
      ? `📍 ${mapLink(context.gps.lat, context.gps.lon)}`
      : whereText(context) && `📍 ${whereText(context)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const parentNames = (cfg: Config) => {
  const names = cfg.contacts.filter((c) => c.enabled && c.name).map((c) => c.name);
  return names.length ? names.slice(0, 3).join(' and ') : 'your parents';
};

export const ASK_DETAILS_SUBJECT = 'Delete me after reading';

/** Sent back to the child after an urgent / check-in email. Safety first; short; easy to delete. */
export function askDetailsText(cfg: Config, calling: boolean): string {
  return [
    '⚠️ SAFETY FIRST: if you are in danger right now, call 999 (police) or 995 (ambulance).',
    'Please delete this email after reading it.',
    '',
    `Hi ${cfg.childName}, we got your message${calling ? ` and are calling ${parentNames(cfg)} now` : ` and told ${parentNames(cfg)}`}.`,
    '',
    'If you can, reply with anything that helps them find and help you:',
    '• Where are you? A street, building, shop, bus stop, station or park you can see',
    '• What can you hear? Traffic, trains, music, announcements, people talking',
    "• If you're inside: what does the room look like?",
    '• Who is with you?',
    '',
    '— SOS2me',
  ].join('\n');
}

async function askForDetails(env: Env, cfg: Config, to: ReplyTarget, calling: boolean, id: string) {
  // Send from the inbox the child wrote to, so the reply comes from the address they know.
  const from = to.inbox ? { key: to.inbox.key, inbox: to.inbox.address } : mailFrom(cfg);
  if (!from) return;
  try {
    await sendMail(from.key, from.inbox, {
      to: [to.address],
      subject: ASK_DETAILS_SUBJECT,
      text: askDetailsText(cfg, calling),
    });
    await logEvent(
      env,
      'asked_details',
      `Replied to ${cfg.childName} asking where they are and what they see.`,
      id,
    );
  } catch (e) {
    await logEvent(env, 'email_error', `Reply to ${cfg.childName}: ${String(e)}`, id);
  }
}

const LEVEL_NAMES: Record<string, string> = { urgent: 'Urgent', concern: 'Check in', normal: 'Everyday' };

/** "Open in SOS2me: https://…/admin/messages/<id>", or nothing when the public address is unknown. */
async function adminLinkLines(env: Env, cfg: Config, id: string): Promise<string[]> {
  const base = await publicBaseUrl(env, cfg);
  return base ? ['', `Open in SOS2me: ${base}/admin/messages/${id}`] : [];
}

/** The prediction, then the original messages it is based on. */
const predictionBlock = (p: Prediction | null | undefined) =>
  p?.situation ? [...situationLines(p.situation), '', ...timelineEmailLines(p.event, LEVEL_NAMES), ''] : [];

const predictionEvent = (s: Situation) =>
  `Prediction: ${s.now}${s.likely ? ` Most likely: ${s.likely}` : ''}`;

/** The email with just the prediction (for levels whose alert email is off, or when the prediction came late). */
async function emailPrediction(
  env: Env,
  cfg: Config,
  id: string,
  p: Prediction,
  level: Level,
  context: MessageContext | null,
) {
  const emails = parentEmails(cfg);
  if (!emails.length || !mailFrom(cfg)) return;
  const subj = `[SOS2me] ${level === 'normal' ? "What's happening" : HEADLINE[level]} — ${cfg.childName}`;
  const txt = [...predictionBlock(p), ...contextLines(context), ...(await adminLinkLines(env, cfg, id))].join(
    '\n',
  );
  await sendParentsMail(cfg, emails, subj, txt).then(
    () => logEvent(env, 'email_sent', `Prediction emailed to ${emails.join(', ')}`, id),
    (e) => logEvent(env, 'email_error', String(e), id),
  );
}

/** Classify a message from the child, store it, and notify parents according to the policy. */
export async function handleIncoming(
  env: Env,
  msg: Incoming,
  /** e.g. ctx.waitUntil: lets slow extras (late prediction, nearby places) finish after we reply. */
  background?: (p: Promise<unknown>) => void,
): Promise<{ id: string; status: AlertStatus } | null> {
  const cfg = await loadConfig(env);
  const subject = (msg.subject ?? '').trim();
  const body = msg.body.trim();
  const text = [subject, body].filter(Boolean).join('\n');

  const id = (await sha256Hex(`${msg.source}\u001f${msg.externalId ?? crypto.randomUUID()}`)).slice(0, 24);
  const receivedAt = nowIso();
  const aiErrors: string[] = [];
  const clsJob: Promise<Classification> = msg.forceUrgent
    ? Promise.resolve({ level: 'urgent' as const, reason: 'SOS button', insight: '' })
    : classify(
        env,
        cfg,
        text,
        (model, e) => aiErrors.push(`${model}: ${String(e)}`),
        msg.mentions && msg.sender,
      );
  // Street address, nearby places and hostname: in parallel with the AI, never holding up the alert for long.
  const fullContext = msg.context ? enrichContext(msg.context) : null;
  const contextJob = fullContext
    ? within(fullContext, PREDICTION_GRACE_MS).then((c) => c ?? msg.context!)
    : Promise.resolve(null);
  // The prediction from recent messages. Emails that merely mention the child only get one if they matter.
  const situationJob: Promise<Prediction | null> = Promise.all([
    contextJob,
    msg.mentions ? clsJob : null,
  ]).then(([context, c]) =>
    c?.level === 'normal'
      ? null
      : buildSituation(
          env,
          cfg,
          {
            id,
            received_at: receivedAt,
            level: msg.forceUrgent ? 'urgent (SOS button)' : 'new',
            source: msg.source,
            subject,
            body,
            context,
          },
          (model, e) => aiErrors.push(`prediction, ${model}: ${String(e)}`),
        ).catch(() => null),
  );

  const cls = await clsJob;
  const context = await contextJob;
  // Wait a little for the prediction; if it's slow, calls start anyway and later calls read it.
  const early = await within(situationJob, PREDICTION_GRACE_MS);
  const earlySituation = early?.situation ?? null;
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
    received_at: receivedAt,
    level: cls.level,
    reason: cls.reason,
    insight: cls.insight,
    status,
    context: context ? JSON.stringify(context) : '',
    situation: earlySituation ? JSON.stringify(earlySituation) : '',
  });
  if (!inserted) return null; // duplicate

  const via = msg.mentions ? `${msg.source}, from ${msg.sender} mentioning "${msg.mentions}"` : msg.source;
  await logEvent(env, 'received', `${cls.level.toUpperCase()} via ${via} — ${cls.reason}`, id);
  if (context && whereText(context))
    await logEvent(env, 'location', `${cfg.childName}'s phone: ${whereText(context)}`, id);
  for (const e of aiErrors.splice(0)) await logEvent(env, 'ai_error', e, id);
  if (earlySituation) await logEvent(env, 'situation', predictionEvent(earlySituation), id);

  const notify = !cfg.paused && !quiet;
  // Email the prediction on its own unless the alert email already carries it.
  const predictionInAlert = canEmail && !!earlySituation;
  const wantPredictionEmail = notify && cfg.situation.email && !predictionInAlert;
  const lateJobList: Promise<unknown>[] = [];
  if (earlySituation && wantPredictionEmail)
    lateJobList.push(emailPrediction(env, cfg, id, early!, cls.level, context));
  if (early === undefined) {
    lateJobList.push(
      situationJob.then(async (p) => {
        if (!p?.situation) return;
        await setMessageSituation(env, id, p.situation);
        await logEvent(env, 'situation', predictionEvent(p.situation), id);
        if (wantPredictionEmail) await emailPrediction(env, cfg, id, p, cls.level, context);
      }),
    );
  }
  // Slow lookups (nearby landmarks can take several seconds) are saved when they arrive.
  if (fullContext && context) {
    lateJobList.push(
      fullContext.then(async (full) => {
        if (full === context) return;
        const stored = parseJson<MessageContext>((await getMessage(env, id))?.context) ?? context;
        await setMessageContext(env, id, mergeLate(stored, full));
      }),
    );
  }
  const lateJobs = async () => {
    await Promise.all(lateJobList);
    for (const e of aiErrors.splice(0)) await logEvent(env, 'ai_error', e, id);
  };
  const finish = () => (background ? background(lateJobs()) : lateJobs());

  if (quiet) {
    await logEvent(
      env,
      'recorded_only',
      'Everyday email from another sender — recorded, nobody notified.',
      id,
    );
    await finish();
    return { id, status };
  }

  if (cfg.paused) {
    await logEvent(env, 'paused', 'Alerts are paused; nobody was notified.', id);
    await finish();
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
  // First, before calls and texts: reply to the child straight away.
  if (msg.replyTo && !msg.mentions && cfg.channels.askForDetails && cls.level !== 'normal') {
    sideJobs.push(askForDetails(env, cfg, msg.replyTo, canCall, id));
  }
  if (canSms) {
    const sms = smsText(cfg, cls.level, subject, body, cls.insight, earlySituation, context);
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
      ...contextLines(context),
      ...(context ? [''] : []),
      ...(cls.insight ? [`AI note: ${cls.insight}`] : []),
      `Why: ${cls.reason}`,
      ...(earlySituation ? ['', ...predictionBlock(early)] : []),
      ...(await adminLinkLines(env, cfg, id)),
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
  await finish();
  return { id, status };
}

/**
 * The child adds to a message they already sent: a detail ("I can see a 7-Eleven") and/or a GPS fix.
 * It's attached to that alert — no new calls — the prediction is refreshed so the next call reads it,
 * and parents get an email. A detail that is itself an emergency starts a new alert instead.
 */
export async function addDetails(
  env: Env,
  id: string,
  add: { text?: string; gps?: MessageContext['gps'] },
  background?: (p: Promise<unknown>) => void,
): Promise<{ ok: boolean; newId?: string; error?: string }> {
  const cfg = await loadConfig(env);
  const msg = await getMessage(env, id);
  if (!msg) return { ok: false, error: 'not found' };
  const prev = parseJson<MessageContext>(msg.context) ?? {};
  const text = add.text?.trim().slice(0, 500);
  if (text && (prev.details?.length ?? 0) >= 20)
    return { ok: false, error: 'Too many details. Send a new message.' };

  if (text && msg.level !== 'urgent' && matchKeyword(text, cfg.rules.urgentKeywords)) {
    const { ip, hostname, isp, ipLocation, device } = prev;
    const gps = add.gps ?? prev.gps;
    const res = await handleIncoming(
      env,
      {
        source: msg.source,
        sender: msg.sender,
        body: text,
        context: { ip, hostname, isp, ipLocation, device, ...(gps && { gps }) },
      },
      background,
    );
    await logEvent(
      env,
      'details_escalated',
      `${cfg.childName} added an urgent detail — started a new alert.`,
      id,
    );
    return { ok: true, newId: res?.id };
  }

  let ctx: MessageContext = { ...prev };
  if (add.gps) ctx = await enrichContext({ ...ctx, gps: add.gps, place: undefined, nearby: undefined });
  if (text) ctx.details = [...(ctx.details ?? []), { at: nowIso(), text }];
  await setMessageContext(env, id, ctx);
  await logEvent(
    env,
    'details_added',
    [text && `${cfg.childName} added: "${text}"`, add.gps && `Location: ${whereText(ctx)}`]
      .filter(Boolean)
      .join(' · '),
    id,
  );

  const p = await buildSituation(env, cfg, { ...msg, context: ctx }, (model, e) =>
    logEvent(env, 'ai_error', `prediction, ${model}: ${String(e)}`, id),
  );
  const s = p?.situation ?? null;
  if (s) {
    await setMessageSituation(env, id, s);
    await logEvent(env, 'situation', predictionEvent(s), id);
  }
  const emails = parentEmails(cfg);
  if (!cfg.paused && emails.length && mailFrom(cfg) && (cfg.policy[msg.level].email || cfg.situation.email)) {
    const txt = [
      ...(text ? [`${cfg.childName} added: ${text}`, ''] : []),
      ...(add.gps ? [`Location shared: ${whereText(ctx)}`, ''] : []),
      ...(s
        ? predictionBlock(p)
        : [`Original message: ${[msg.subject, msg.body].filter(Boolean).join(' — ')}`, '']),
      ...contextLines(ctx),
      ...(await adminLinkLines(env, cfg, id)),
    ].join('\n');
    await sendParentsMail(cfg, emails, `[SOS2me] More from ${cfg.childName}`, txt).then(
      () => logEvent(env, 'email_sent', `Details emailed to ${emails.join(', ')}`, id),
      (e) => logEvent(env, 'email_error', String(e), id),
    );
  }
  return { ok: true };
}
