import PostalMime from 'postal-mime';
import { loadConfig, logEvent } from './db';
import type { Env } from './env';
import { handleIncoming } from './pipeline';
import { emailDecision, htmlToText, stripQuotedReply } from './senders';

/** Cloudflare Email Routing handler: mail to e.g. sos@your-domain.com arrives here instantly. */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const cfg = await loadConfig(env);
  const routing = cfg.channels.emailRouting;

  if (routing.forwardTo) {
    await message.forward(routing.forwardTo).catch((e) => logEvent(env, 'email_forward_error', String(e)));
  }
  if (!routing.enabled) return;

  const parsed = await PostalMime.parse(message.raw);
  const from = (parsed.from?.address || message.from || '').toLowerCase();
  const body = stripQuotedReply(parsed.text || htmlToText(parsed.html ?? '')).slice(0, 4000);
  const decision = emailDecision(cfg, from, `${parsed.subject ?? ''}\n${body}`);
  if (decision.kind === 'ignore') {
    await logEvent(
      env,
      'email_ignored',
      `Email from ${from} ignored — not an allowed sender and no watched name.`,
    );
    return;
  }
  await handleIncoming(env, {
    source: 'email',
    sender: from,
    subject: parsed.subject ?? '',
    body,
    externalId: parsed.messageId || message.headers.get('message-id') || undefined,
    mentions: decision.kind === 'mentions' ? decision.name : undefined,
  });
}
