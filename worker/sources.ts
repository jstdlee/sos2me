// Polled channels: mailboxes (AgentMail / IMAP) and ntfy topics. Run by the per-minute cron.
import PostalMime from 'postal-mime';
import type { Config, Mailbox, NtfySource } from '../shared/types';
import { addressOf, getMessage, listReceived } from './agentmail';
import { getSetting, logEvent, putSetting } from './db';
import type { Env } from './env';
import { pollImap } from './imap';
import { handleIncoming } from './pipeline';
import { emailDecision, htmlToText, stripQuotedReply } from './senders';

const cursorKey = (kind: string, id: string) => `cursor:${kind}:${id}`;

async function readCursor<T>(env: Env, key: string): Promise<T | null> {
  const raw = await getSetting(env, key);
  return raw ? (JSON.parse(raw) as T) : null;
}

// ── AgentMail ───────────────────────────────────────────

async function pollAgentMail(env: Env, cfg: Config, box: Mailbox): Promise<void> {
  const key = box.apiKey || cfg.services.agentmailApiKey;
  const ck = cursorKey('agentmail', box.id);
  const cur = await readCursor<{ after: string; address: string }>(env, ck);
  if (!cur || cur.address !== box.address) {
    // First run: start from now instead of replaying the inbox.
    await putSetting(env, ck, JSON.stringify({ after: new Date().toISOString(), address: box.address }));
    return;
  }
  const items = await listReceived(key, box.address, cur.after);
  let after = cur.after;
  for (const it of items) {
    after = it.timestamp > after ? it.timestamp : after;
    const from = addressOf(it.from);
    const full = await getMessage(key, box.address, it.message_id);
    const body = stripQuotedReply(
      full.extracted_text || full.text || htmlToText(full.html ?? '') || it.preview || '',
    );
    const decision = emailDecision(cfg, from, `${it.subject ?? ''}\n${body}`);
    if (decision.kind === 'ignore') {
      await logEvent(
        env,
        'email_ignored',
        `${box.name || box.address}: email from ${from} ignored — not an allowed sender, no watched name.`,
      );
      continue;
    }
    await handleIncoming(env, {
      source: 'mailbox',
      sender: from,
      subject: it.subject ?? '',
      body: body.slice(0, 4000),
      externalId: `agentmail:${it.message_id}`,
      mentions: decision.kind === 'mentions' ? decision.name : undefined,
      replyTo: { address: from, inbox: { key, address: box.address } },
    });
  }
  // `after` is inclusive on some servers; duplicates are ignored by message id anyway.
  if (after !== cur.after) await putSetting(env, ck, JSON.stringify({ after, address: box.address }));
}

// ── IMAP ────────────────────────────────────────────────

async function pollImapBox(env: Env, cfg: Config, box: Mailbox): Promise<void> {
  const ck = cursorKey('imap', box.id);
  const cur = await readCursor<{ lastUid: number; uidValidity: string; user: string }>(env, ck);
  const same = cur && cur.user === `${box.address}@${box.host}`;
  const res = await pollImap(
    { host: box.host, port: box.port, user: box.address, password: box.password, folder: box.folder },
    same ? cur.lastUid : null,
    same ? cur.uidValidity : null,
  );
  for (const mail of res.mails) {
    const parsed = await PostalMime.parse(mail.raw);
    const from = (parsed.from?.address ?? '').toLowerCase();
    const body = stripQuotedReply(parsed.text || htmlToText(parsed.html ?? '')).slice(0, 4000);
    const decision = emailDecision(cfg, from, `${parsed.subject ?? ''}\n${body}`);
    if (decision.kind === 'ignore') continue; // a normal inbox has lots of other mail — skip quietly
    await handleIncoming(env, {
      source: 'mailbox',
      sender: from,
      subject: parsed.subject ?? '',
      body,
      externalId: parsed.messageId || `imap:${box.id}:${res.uidValidity}:${mail.uid}`,
      mentions: decision.kind === 'mentions' ? decision.name : undefined,
      replyTo: { address: from },
    });
  }
  await putSetting(
    env,
    ck,
    JSON.stringify({
      lastUid: res.lastUid,
      uidValidity: res.uidValidity,
      user: `${box.address}@${box.host}`,
    }),
  );
}

// ── ntfy ────────────────────────────────────────────────

interface NtfyEvent {
  id: string;
  event: string;
  title?: string;
  message?: string;
}

/** ntfy accepts username + password (Basic), an access token (Bearer), or "user:password" in the token field. */
export function ntfyAuth(src: Pick<NtfySource, 'username' | 'token'>): string | null {
  if (src.username) return `Basic ${btoa(`${src.username}:${src.token}`)}`;
  if (!src.token) return null;
  return src.token.includes(':') && !src.token.startsWith('tk_')
    ? `Basic ${btoa(src.token)}`
    : `Bearer ${src.token}`;
}

export async function fetchNtfy(src: NtfySource, since: string): Promise<NtfyEvent[]> {
  const url = new URL(`${src.baseUrl}/${encodeURIComponent(src.topic)}/json`);
  url.searchParams.set('poll', '1');
  url.searchParams.set('since', since);
  const res = await fetch(url, {
    headers: ntfyAuth(src) ? { Authorization: ntfyAuth(src)! } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as NtfyEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is NtfyEvent => !!e && e.event === 'message' && !!e.id);
}

async function pollNtfySource(env: Env, src: NtfySource): Promise<void> {
  const ck = cursorKey('ntfy', src.id);
  const cur = await readCursor<{ since: string; topic: string }>(env, ck);
  const topicKey = `${src.baseUrl}/${src.topic}`;
  if (!cur || cur.topic !== topicKey) {
    await putSetting(
      env,
      ck,
      JSON.stringify({ since: String(Math.floor(Date.now() / 1000)), topic: topicKey }),
    );
    return;
  }
  const events = await fetchNtfy(src, cur.since);
  for (const ev of events) {
    await handleIncoming(env, {
      source: 'ntfy',
      sender: src.name || src.topic,
      subject: ev.title ?? '',
      body: ev.message ?? '',
      externalId: `ntfy:${src.baseUrl}:${ev.id}`,
    });
  }
  const last = events.at(-1)?.id;
  if (last) await putSetting(env, ck, JSON.stringify({ since: last, topic: topicKey }));
}

// ── Entry point ─────────────────────────────────────────

export async function pollAllSources(env: Env, cfg: Config): Promise<void> {
  const jobs: [string, () => Promise<void>][] = [
    ...cfg.channels.mailboxes
      .filter((b) => b.enabled && b.address)
      .map((b): [string, () => Promise<void>] => [
        `mailbox "${b.name || b.address}"`,
        () => (b.type === 'imap' ? pollImapBox(env, cfg, b) : pollAgentMail(env, cfg, b)),
      ]),
    ...cfg.channels.ntfy
      .filter((n) => n.enabled && n.topic)
      .map((n): [string, () => Promise<void>] => [
        `ntfy "${n.name || n.topic}"`,
        () => pollNtfySource(env, n),
      ]),
  ];
  await Promise.all(
    jobs.map(async ([name, run]) => {
      try {
        await run();
      } catch (e) {
        // Log each failing source at most once an hour so the activity log stays readable.
        const k = `pollerr:${name}`;
        const last = Number((await getSetting(env, k)) ?? 0);
        if (Date.now() - last > 3600_000) {
          await logEvent(env, 'source_error', `${name}: ${String(e instanceof Error ? e.message : e)}`);
          await putSetting(env, k, String(Date.now()));
        }
      }
    }),
  );
}
