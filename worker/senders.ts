import type { Config } from '../shared/types';
import { matchKeyword } from './classify';

export type EmailDecision = { kind: 'trusted' } | { kind: 'mentions'; name: string } | { kind: 'ignore' };

/** The names to look for: the configured list, or the child's name if none is set. */
export const watchNames = (cfg: Config) =>
  cfg.channels.watchNames.length
    ? cfg.channels.watchNames
    : cfg.childName !== 'your child'
      ? [cfg.childName]
      : [];

/**
 * Trusted senders are always processed. Anyone else is processed only when "accept mentions" is on
 * and the email clearly names someone on the watch list (whole word, case-insensitive).
 */
export function emailDecision(cfg: Config, from: string, text: string): EmailDecision {
  if (senderAllowed(from, cfg.channels.allowedSenders)) return { kind: 'trusted' };
  if (cfg.channels.acceptMentions) {
    const name = matchKeyword(text, watchNames(cfg));
    if (name) return { kind: 'mentions', name };
  }
  return { kind: 'ignore' };
}

/** Allowed entries are full addresses ("kid@gmail.com") or domains ("@school.edu" / "school.edu"). */
export function senderAllowed(from: string, allowed: string[]): boolean {
  const addr = from.toLowerCase().trim();
  if (!addr) return false;
  return allowed.some((a) => {
    const x = a.toLowerCase().trim();
    return x.includes('@') && !x.startsWith('@') ? addr === x : addr.endsWith('@' + x.replace(/^@/, ''));
  });
}

/** Drop the quoted thread below "On <date>, <x> wrote:" so the call reads only the new text. */
export function stripQuotedReply(text: string): string {
  const cut = text.search(/^\s*(On .+wrote:|-{2,}\s*Original Message|>|在.+写道[:：])/im);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
