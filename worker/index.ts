import { Hono, type Context } from 'hono';
import type { Config, StatusInfo } from '../shared/types';
import {
  LOCKOUT,
  checkPassword,
  endSession,
  hmac,
  isAuthed,
  passwordIsSet,
  recordAttempt,
  requireAuth,
  sessionSecret,
  startSession,
  tooManyAttempts,
} from './auth';
import { classify } from './classify';
import {
  finalizeConfig,
  getMessage,
  getSetting,
  insertMessage,
  listEvents,
  listMessages,
  loadConfig,
  logEvent,
  maskSecrets,
  normalizeConfig,
  nowIso,
  putSetting,
  randomToken,
  restoreSecrets,
  saveConfig,
  verifyHashed,
} from './db';
import { handleEmail } from './email';
import type { Env } from './env';
import { lastHealth, maybeRunDailyCheck, runHealthCheck } from './health';
import { mailFrom, parentEmails, sendParentsMail } from './mailer';
import { checkPublicAddress, handleIncoming, instanceId, publicBaseUrl } from './pipeline';
import { emailDecision } from './senders';
import { pollAllSources } from './sources';
import { voiceTwiml } from './voice';
import { say, twiml, twilioConfigured, twilioCreds, verifySignature } from './twilio';

export { Escalation } from './escalation';

type App = { Bindings: Env };
const app = new Hono<App>();

const escalation = (env: Env, messageId: string) => env.ESCALATION.get(env.ESCALATION.idFromName(messageId));

// Remember our public https origin so Twilio callbacks work without extra config.
app.use('/api/*', async (c, next) => {
  await next();
  if (c.res.status >= 400 || c.req.path.startsWith('/api/kid')) return;
  const origin = new URL(c.req.url).origin;
  if (!origin.startsWith('https://') || (await getSetting(c.env, 'publicBaseUrl')) === origin) return;
  if (await isAuthed(c).catch(() => false)) await putSetting(c.env, 'publicBaseUrl', origin);
});

// Lets SOS2me check that its public address really reaches *this* installation.
app.get('/api/ping', async (c) => c.json({ app: 'sos2me', instance: await instanceId(c.env) }));

// ── Session ─────────────────────────────────────────────

app.get('/api/session', async (c) => {
  const cfg = await loadConfig(c.env);
  return c.json({ authed: await isAuthed(c, cfg), passwordSet: passwordIsSet(c.env, cfg) });
});

app.post('/api/login', async (c) => {
  const cfg = await loadConfig(c.env);
  const wait = await tooManyAttempts(c.env, 'admin');
  if (wait) return c.json({ error: `Too many tries. Wait ${wait} min.` }, 429);
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: '' }));
  const ok = await checkPassword(c.env, cfg, password ?? '');
  await recordAttempt(c.env, 'admin', ok);
  if (ok) {
    await startSession(c, cfg);
    return c.json({ ok: true });
  }
  return c.json(
    {
      error: passwordIsSet(c.env, cfg)
        ? 'Wrong password'
        : 'No password set yet — add adminPassword to config.json',
    },
    401,
  );
});

app.post('/api/logout', (c) => {
  endSession(c);
  return c.json({ ok: true });
});

// ── Kid page (public: secret link + optional PIN) ───────
// Registered before the authed /api sub-app so its auth middleware never runs for these.

async function kidContext(c: Context<App>) {
  const cfg = await loadConfig(c.env);
  const kp = cfg.channels.kidPage;
  const token = c.req.param('token') ?? '';
  if (!kp.enabled) return null;
  // "home" = the kid page at the site root. The address is public, so it requires a PIN.
  if (token === 'home') return kp.homeAtRoot && kp.pin ? { cfg, kp } : null;
  if (token.length < 16 || kp.token !== token) return null;
  return { cfg, kp };
}
/** A device that entered the right PIN keeps this key; changing the PIN or link invalidates it. */
const deviceKey = async (env: Env, token: string, pinHash: string) =>
  hmac(await sessionSecret(env), `kid:${token}:${pinHash}`);

/** Unlocked by the device key from /unlock, or by the PIN itself (for iPhone Shortcuts). */
async function kidUnlocked(c: Context<App>, kp: Config['channels']['kidPage'], key?: string, pin?: string) {
  if (!kp.pin) return true;
  if (key && key === (await deviceKey(c.env, kp.token, kp.pin))) return true;
  if (!pin) return false;
  const lockKey = `kid:${kp.token}`;
  if (await tooManyAttempts(c.env, lockKey)) return false;
  const ok = await verifyHashed(kp.pin, String(pin));
  await recordAttempt(c.env, lockKey, ok, LOCKOUT.kid);
  return ok;
}

app.get('/api/kid/:token', async (c) => {
  const k = await kidContext(c);
  if (!k) return c.json({ error: 'This link is not active.' }, 404);
  return c.json({ pinRequired: !!k.kp.pin, quickReplies: k.kp.quickReplies });
});

app.post('/api/kid/:token/unlock', async (c) => {
  const k = await kidContext(c);
  if (!k) return c.json({ error: 'This link is not active.' }, 404);
  const lockKey = `kid:${k.kp.token}`;
  const wait = await tooManyAttempts(c.env, lockKey);
  if (wait) return c.json({ error: `Too many tries. Wait ${wait} min.` }, 429);
  const { pin } = await c.req.json<{ pin?: string }>().catch(() => ({ pin: '' }));
  const ok = !k.kp.pin || (await verifyHashed(k.kp.pin, String(pin ?? '')));
  await recordAttempt(c.env, lockKey, ok, LOCKOUT.kid);
  if (!ok) return c.json({ error: 'Wrong PIN' }, 401);
  return c.json({ key: await deviceKey(c.env, k.kp.token, k.kp.pin) });
});

app.post('/api/kid/:token/send', async (c) => {
  const k = await kidContext(c);
  if (!k) return c.json({ error: 'This link is not active.' }, 404);
  const { text, sos, key, pin } = await c.req
    .json<{ text?: string; sos?: boolean; key?: string; pin?: string }>()
    .catch(() => ({}) as never);
  if (!(await kidUnlocked(c, k.kp, key, pin))) return c.json({ error: 'locked' }, 401);
  const body = (text ?? '').trim().slice(0, 1000) || (sos ? 'SOS' : '');
  if (!body) return c.json({ error: 'Type a message first.' }, 400);
  const res = await handleIncoming(c.env, {
    source: 'kid-page',
    sender: 'Kid page',
    body,
    forceUrgent: !!sos,
  });
  return c.json({ ok: true, id: res?.id, status: res?.status });
});

/** Lets the kid page show "Mum heard your message ✓". */
app.post('/api/kid/:token/status', async (c) => {
  const k = await kidContext(c);
  if (!k) return c.json({ error: 'This link is not active.' }, 404);
  const { id, key } = await c.req.json<{ id?: string; key?: string }>().catch(() => ({}) as never);
  if (!(await kidUnlocked(c, k.kp, key))) return c.json({ error: 'locked' }, 401);
  const m = id ? await getMessage(c.env, id) : null;
  if (!m || m.source !== 'kid-page') return c.json({ error: 'not found' }, 404);
  return c.json({ status: m.status, by: m.acknowledged_by });
});

// ── Parent dashboard API ────────────────────────────────

const api = new Hono<App>();
api.use('*', requireAuth);

api.get('/status', async (c) => {
  const cfg = await loadConfig(c.env);
  const tw = twilioCreds(c.env, cfg);
  const info: StatusInfo = {
    twilio: twilioConfigured(tw),
    twilioSignatureCheck: Boolean(tw.authToken),
    publicBaseUrl: await publicBaseUrl(c.env, cfg),
    agentmail: !!mailFrom(cfg),
    lastHealth: await lastHealth(c.env),
  };
  return c.json(info);
});

api.get('/config', async (c) => c.json(maskSecrets(await loadConfig(c.env))));

api.put('/config', async (c) => {
  const current = await loadConfig(c.env);
  const cfg = normalizeConfig(await c.req.json());
  restoreSecrets(cfg, current);
  cfg.channels.kidPage.token = current.channels.kidPage.token; // only changed via /rotate
  const bad = cfg.contacts.find((x) => x.enabled && x.phone && !/^\+[1-9]\d{6,14}$/.test(x.phone));
  if (bad) return c.json({ error: `"${bad.phone}" is not in international format, e.g. +6581234567` }, 400);
  if (cfg.twilio.fromNumber && !/^\+[1-9]\d{6,14}$/.test(cfg.twilio.fromNumber)) {
    return c.json({ error: 'Twilio "from" number must be in international format, e.g. +15550001111' }, 400);
  }
  await finalizeConfig(cfg);
  await saveConfig(c.env, cfg);
  await logEvent(c.env, 'settings_saved', 'Settings updated from the dashboard.');
  return c.json(maskSecrets(cfg));
});

api.post('/config/kid-token/rotate', async (c) => {
  const cfg = await loadConfig(c.env);
  cfg.channels.kidPage.token = randomToken();
  await saveConfig(c.env, cfg);
  await logEvent(c.env, 'kid_link_rotated', 'A new kid page link was created; the old one stopped working.');
  return c.json({ token: cfg.channels.kidPage.token });
});

api.get('/messages', async (c) => {
  const limit = Math.min(100, Number(c.req.query('limit') ?? 30));
  return c.json(await listMessages(c.env, limit, c.req.query('before') || undefined));
});

api.get('/messages/:id', async (c) => {
  const id = c.req.param('id');
  const message = await getMessage(c.env, id);
  if (!message) return c.json({ error: 'not found' }, 404);
  return c.json({ message, events: await listEvents(c.env, { messageId: id, limit: 200 }) });
});

api.post('/messages/:id/stop', async (c) => {
  await escalation(c.env, c.req.param('id')).stop();
  return c.json({ ok: true });
});

api.get('/events', async (c) =>
  c.json(await listEvents(c.env, { limit: Math.min(300, Number(c.req.query('limit') ?? 100)) })),
);

/** Dry run: how would this text be classified? Nobody is called. */
api.post('/test/classify', async (c) => {
  const { text, from } = await c.req.json<{ text: string; from?: string }>();
  const cfg = await loadConfig(c.env);
  const aiErrors: string[] = [];
  // With `from`: an email from someone else — would it be picked up at all, and how urgent?
  const decision = from ? emailDecision(cfg, from.toLowerCase(), text ?? '') : null;
  if (decision?.kind === 'ignore') {
    return c.json({
      level: 'normal',
      reason: 'Ignored: not an allowed sender and no watched name',
      insight: '',
      aiErrors,
    });
  }
  const aboutFrom = decision?.kind === 'mentions' ? from : undefined;
  const result = await classify(
    c.env,
    cfg,
    text ?? '',
    (m, e) => aiErrors.push(`${m}: ${String(e)}`),
    aboutFrom,
  );
  if (aboutFrom && result.level === 'normal')
    result.reason += ' — everyday email from another sender: recorded only';
  return c.json({ ...result, aiErrors, policy: cfg.policy[result.level] });
});

/** Place one real call to one contact to check Twilio and the voice message. */
api.post('/test/call', async (c) => {
  const { contactId } = await c.req.json<{ contactId: string }>();
  const cfg = await loadConfig(c.env);
  const contact = cfg.contacts.find((x) => x.id === contactId);
  if (!contact?.phone) return c.json({ error: 'This person has no phone number' }, 404);
  if (!twilioConfigured(twilioCreds(c.env, cfg))) return c.json({ error: 'Twilio is not set up yet' }, 400);
  const baseUrl = await publicBaseUrl(c.env, cfg);
  const reach = baseUrl
    ? await checkPublicAddress(c.env, baseUrl)
    : { ok: false, detail: 'no public address set' };
  const warning = reach.ok
    ? undefined
    : `Calling anyway. ${baseUrl || 'Public address'}: ${reach.detail}, so "press 1" won't work — staying on the line for 15 s counts as answered.`;

  const id = `test-${randomToken(8)}`;
  await insertMessage(c.env, {
    id,
    source: 'test',
    sender: 'dashboard',
    subject: '',
    body: 'This is a test call. Everything is working.',
    received_at: nowIso(),
    level: 'normal',
    reason: 'test call',
    status: 'calling',
  });
  await logEvent(c.env, 'test_call', `Test call to ${contact.name || contact.phone}`, id);
  await escalation(c.env, id).start({
    messageId: id,
    level: 'normal',
    contacts: [{ name: contact.name, phone: contact.phone }],
    rounds: 1,
    retryMinutes: 1,
    requireConfirm: true,
    baseUrl,
  });
  return c.json({ id, warning });
});

api.post('/test/email', async (c) => {
  const cfg = await loadConfig(c.env);
  const to = parentEmails(cfg);
  try {
    await sendParentsMail(
      cfg,
      to,
      '[SOS2me] Test email',
      'This is a test email from SOS2me. Alerts will look like this.',
    );
    return c.json({ ok: true, to });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 400);
  }
});

/** Full pipeline with a fake message — will really call/text according to your settings. */
api.post('/test/message', async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: 'Empty message' }, 400);
  return c.json(await handleIncoming(c.env, { source: 'test', sender: 'dashboard', body: text }));
});

api.post('/health/run', async (c) => {
  const { notify } = await c.req.json<{ notify?: boolean }>().catch(() => ({ notify: false }));
  return c.json(await runHealthCheck(c.env, await loadConfig(c.env), { notify: !!notify }));
});

app.route('/api', api);

// ── Twilio webhooks ─────────────────────────────────────

async function twilioRequest(c: Context<App>) {
  const cfg = await loadConfig(c.env);
  const body = await c.req.parseBody();
  const params = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
  const ok = await verifySignature(twilioCreds(c.env, cfg).authToken, c.req.raw, params);
  return { cfg, params, ok };
}

app.post('/twilio/voice', async (c) => {
  const { ok, cfg } = await twilioRequest(c);
  if (!ok) return c.text('bad signature', 403);
  const id = c.req.query('m') ?? '';
  const msg = await getMessage(c.env, id);
  const v = cfg.voice;
  if (!msg) return twiml(say('Sorry, this alert could not be found. Goodbye.', v));

  const st = await escalation(c.env, id).status();
  return twiml(voiceTwiml(cfg, msg, st?.requireConfirm ?? true, await publicBaseUrl(c.env, cfg)));
});

app.post('/twilio/gather', async (c) => {
  const { ok, params, cfg } = await twilioRequest(c);
  if (!ok) return c.text('bad signature', 403);
  const id = c.req.query('m') ?? '';
  if (params.Digits === '1') {
    await escalation(c.env, id).confirm(params.CallSid ?? '');
    return twiml(say('Thank you. Confirmed. We will stop calling.', cfg.voice) + '<Hangup/>');
  }
  const base = await publicBaseUrl(c.env, cfg);
  return twiml(`<Redirect method="POST">${base}/twilio/voice?m=${encodeURIComponent(id)}</Redirect>`);
});

app.post('/twilio/status', async (c) => {
  const { ok, params } = await twilioRequest(c);
  if (!ok) return c.text('bad signature', 403);
  const id = c.req.query('m') ?? '';
  await escalation(c.env, id).callStatus(
    params.CallSid ?? '',
    (params.CallStatus ?? '').toLowerCase(),
    Number(params.CallDuration ?? 0),
  );
  return c.body(null, 204);
});

app.onError(async (err, c) => {
  console.error(err);
  await logEvent(c.env, 'server_error', `${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

export default {
  fetch: app.fetch,
  async email(message, env) {
    await handleEmail(message, env);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const cfg = await loadConfig(env);
        await Promise.all([pollAllSources(env, cfg), maybeRunDailyCheck(env, cfg)]);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
