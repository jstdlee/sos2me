// Daily self-test: is every piece that has to work in an emergency actually working?
import type { CheckResult, Config, HealthReport } from '../shared/types';
import { checkInbox } from './agentmail';
import { askModel } from './classify';
import { getSetting, logEvent, nowIso, putSetting } from './db';
import type { Env } from './env';
import { checkImap } from './imap';
import { mailFrom, parentEmails, sendParentsMail } from './mailer';
import { checkPublicAddress, publicBaseUrl } from './pipeline';
import { fetchNtfy } from './sources';
import { accountHealth, sendSms, twilioConfigured, twilioCreds } from './twilio';

const SAMPLE = "hi mum, practice finished early, can you pick me up at 5? i'm fine";

/** Throw this for "works, but could be better" — shown as a warning, not a failure. */
class Warning extends Error {}

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (e) {
    if (e instanceof Warning) return { name, ok: true, warn: true, detail: e.message };
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function runHealthCheck(
  env: Env,
  cfg: Config,
  opts: { notify: boolean },
): Promise<HealthReport> {
  const checks: Promise<CheckResult>[] = [];
  let ai: Promise<CheckResult[]> = Promise.resolve([]);

  // AI models — each one separately, so a dead fallback is noticed before it's needed.
  // One working model is enough to classify, so if any answers, the others only warn
  // (free models are often briefly rate-limited).
  if (cfg.ai.enabled) {
    ai = Promise.all(
      cfg.ai.models
        .filter((x) => x.enabled)
        .map((m) =>
          check(`AI · ${m.model}`, async () => {
            const t = Date.now();
            const v = await askModel(env, cfg, m, SAMPLE);
            return `answered "${v.level}" in ${((Date.now() - t) / 1000).toFixed(1)}s`;
          }),
        ),
    ).then((rs) =>
      rs.some((r) => r.ok)
        ? rs.map((r) =>
            r.ok ? r : { ...r, ok: true, warn: true, detail: `${r.detail} (another AI model works)` },
          )
        : rs,
    );
  }

  const tw = twilioCreds(env, cfg);
  checks.push(
    check('Twilio phone service', async () => {
      if (!twilioConfigured(tw)) throw new Error('not set up');
      return accountHealth(tw);
    }),
  );
  checks.push(
    check('Public address (for calls)', async () => {
      const url = await publicBaseUrl(env, cfg);
      const reach = url ? await checkPublicAddress(env, url) : { ok: false, detail: 'not set yet' };
      if (!reach.ok) {
        throw new Warning(
          `${url || 'Public address'}: ${reach.detail}. Calls still work; "press 1" needs it.`,
        );
      }
      return `${url} reaches this SOS2me`;
    }),
  );

  for (const b of cfg.channels.mailboxes.filter((x) => x.enabled && x.address)) {
    checks.push(
      check(`Mailbox · ${b.name || b.address}`, async () => {
        if (b.type === 'imap') {
          return checkImap({
            host: b.host,
            port: b.port,
            user: b.address,
            password: b.password,
            folder: b.folder,
          });
        }
        await checkInbox(b.apiKey || cfg.services.agentmailApiKey, b.address);
        return 'AgentMail inbox reachable';
      }),
    );
  }
  for (const n of cfg.channels.ntfy.filter((x) => x.enabled && x.topic)) {
    checks.push(
      check(`ntfy · ${n.name || n.topic}`, async () => {
        await fetchNtfy(n, String(Math.floor(Date.now() / 1000)));
        return `${n.baseUrl} reachable`;
      }),
    );
  }
  checks.push(
    check('Alert email sender (AgentMail)', async () => {
      const from = mailFrom(cfg);
      if (!from) throw new Error('no AgentMail sender configured');
      await checkInbox(from.key, from.inbox);
      return from.inbox;
    }),
  );
  checks.push(
    check('Parents set up', async () => {
      const phones = cfg.contacts.filter((c) => c.enabled && c.phone).length;
      if (!phones) throw new Error('no active parent phone numbers');
      return `${phones} phone number(s), ${parentEmails(cfg).length} email(s)`;
    }),
  );

  const results = [...(await ai), ...(await Promise.all(checks))];
  const ok = results.every((r) => r.ok);
  const report: HealthReport = { ranAt: nowIso(), ok, checks: results, emailed: [] };

  if (opts.notify && (!ok || cfg.health.emailWhenOk)) {
    const to = [...new Set([...parentEmails(cfg), ...cfg.health.extraEmails])];
    const lines = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
    const subject = ok
      ? '[SOS2me] Daily check: all good'
      : '[SOS2me] Action needed: something is not working';
    const intro = ok
      ? 'Everything SOS2me needs in an emergency is working.'
      : 'SOS2me found a problem. Until it is fixed, you might not get a call when your child needs you.';
    try {
      await sendParentsMail(
        cfg,
        to,
        subject,
        [intro, '', ...lines, '', 'Open the dashboard → Home → System check.'].join('\n'),
      );
      report.emailed = to;
    } catch (e) {
      await logEvent(env, 'health_email_error', String(e));
    }
    if (!ok && cfg.health.smsOnFailure && twilioConfigured(tw)) {
      const failed = results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(', ');
      for (const c of cfg.contacts.filter((x) => x.enabled && x.phone)) {
        await sendSms(
          tw,
          c.phone,
          `[SOS2me] Daily check failed: ${failed}. Please check the dashboard.`,
        ).catch(() => undefined);
      }
    }
  }

  await putSetting(env, 'health:last', JSON.stringify(report));
  await logEvent(
    env,
    ok ? 'health_ok' : 'health_failed',
    ok
      ? 'Daily check passed.'
      : `Daily check failed: ${results
          .filter((r) => !r.ok)
          .map((r) => r.name)
          .join(', ')}`,
  );
  return report;
}

export async function lastHealth(env: Env): Promise<HealthReport | null> {
  const raw = await getSetting(env, 'health:last');
  return raw ? (JSON.parse(raw) as HealthReport) : null;
}

/** Called every minute by cron; runs once a day at the configured local time. */
export async function maybeRunDailyCheck(env: Env, cfg: Config, now = new Date()): Promise<void> {
  if (!cfg.health.enabled) return;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.health.timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (`${parts.hour}:${parts.minute}` < cfg.health.time) return;
  if ((await getSetting(env, 'health:lastDay')) === today) return;
  await putSetting(env, 'health:lastDay', today);
  await runHealthCheck(env, cfg, { notify: true });
}
