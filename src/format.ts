import type { AlertStatus, Level, Source } from '../shared/types';

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const fullTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const statusText: Record<AlertStatus, string> = {
  calling: 'Calling now',
  confirmed: 'Confirmed',
  answered: 'Answered',
  unanswered: 'No one confirmed',
  stopped: 'Stopped',
  texted: 'Texted',
  logged: 'Recorded',
  failed: 'Call failed',
};

export const sourceText: Record<Source, string> = {
  'kid-page': 'Kid page',
  email: 'Email',
  mailbox: 'Mailbox',
  ntfy: 'ntfy',
  test: 'Test',
};

export const levelText: Record<Level, string> = { urgent: 'Urgent', concern: 'Check in', normal: 'Everyday' };
export const levelDot: Record<Level, string> = {
  urgent: 'bg-rose-500',
  concern: 'bg-lav-500',
  normal: 'bg-sage-500',
};
export const levelBadge: Record<Level, string> = {
  urgent: 'bg-rose-100 text-rose-600',
  concern: 'bg-lav-100 text-lav-600',
  normal: 'bg-sage-100 text-sage-700',
};
