import type { Config } from '../shared/types';
import { sendMail } from './agentmail';

/** The AgentMail inbox used to send alert / system-check emails. */
export function mailFrom(cfg: Config): { inbox: string; key: string } | null {
  const box = cfg.channels.mailboxes.find((b) => b.type === 'agentmail' && b.address);
  const inbox = cfg.services.agentmailFrom || box?.address || '';
  const key = cfg.services.agentmailApiKey || box?.apiKey || '';
  return inbox && key ? { inbox, key } : null;
}

export const parentEmails = (cfg: Config) => [
  ...new Set(cfg.contacts.filter((c) => c.enabled && c.email).map((c) => c.email)),
];

export async function sendParentsMail(
  cfg: Config,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const from = mailFrom(cfg);
  if (!from) throw new Error('No AgentMail sender configured (Settings → Connections)');
  if (!to.length) throw new Error('No parent email addresses');
  await sendMail(from.key, from.inbox, { to, subject, text });
}
