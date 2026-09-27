// Minimal AgentMail REST client — https://docs.agentmail.to/api-reference

const BASE = 'https://api.agentmail.to/v0';

export interface AgentMailItem {
  message_id: string;
  thread_id: string;
  timestamp: string;
  from: string;
  subject?: string;
  preview?: string;
  labels: string[];
}

async function call<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!apiKey) throw new Error('AgentMail API key not set');
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`AgentMail ${res.status}: ${data.message ?? res.statusText}`);
  return data;
}

const inboxPath = (inbox: string) => `/inboxes/${encodeURIComponent(inbox)}`;

/** Received messages newer than `after` (ISO), oldest first. */
export async function listReceived(apiKey: string, inbox: string, after?: string): Promise<AgentMailItem[]> {
  // Note: the API's `labels=` filter returned nothing in testing, so filter locally instead.
  const q = new URLSearchParams({ limit: '50' });
  if (after) q.set('after', after);
  const data = await call<{ messages: AgentMailItem[] }>(apiKey, `${inboxPath(inbox)}/messages?${q}`);
  return data.messages.filter((m) => m.labels.includes('received') && !m.labels.includes('sent')).reverse();
}

export async function getMessage(
  apiKey: string,
  inbox: string,
  messageId: string,
): Promise<AgentMailItem & { text?: string; html?: string; extracted_text?: string }> {
  return call(apiKey, `${inboxPath(inbox)}/messages/${encodeURIComponent(messageId)}`);
}

export async function sendMail(
  apiKey: string,
  inbox: string,
  msg: { to: string[]; subject: string; text: string; html?: string },
): Promise<void> {
  await call(apiKey, `${inboxPath(inbox)}/messages/send`, { method: 'POST', body: JSON.stringify(msg) });
}

export async function checkInbox(apiKey: string, inbox: string): Promise<void> {
  await call(apiKey, inboxPath(inbox));
}

/** "Alex <alex@x.com>" → "alex@x.com" */
export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
