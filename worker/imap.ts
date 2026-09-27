// A deliberately small IMAP client (LOGIN, SELECT, UID SEARCH, UID FETCH) over Cloudflare TCP sockets.
// Enough to poll Gmail / Outlook / iCloud with an app password.
import { connect } from 'cloudflare:sockets';
import { ImapReader } from './imap-reader';

const enc = new TextEncoder();

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  folder: string;
}

export interface FetchedMail {
  uid: number;
  raw: Uint8Array;
}

/**
 * Returns messages with UID > lastUid (max 20 per run) plus the new high-water mark.
 * First run (lastUid = null) only records the current position — no history replay.
 */
export async function pollImap(
  conf: ImapConfig,
  lastUid: number | null,
  uidValidity: string | null,
): Promise<{ mails: FetchedMail[]; lastUid: number; uidValidity: string }> {
  const socket = connect(
    { hostname: conf.host, port: conf.port },
    { secureTransport: 'on', allowHalfOpen: false },
  );
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const r = new ImapReader(async () => {
    const { value, done } = await reader.read();
    return done ? null : value;
  });
  let n = 0;
  const cmd = async (text: string) => {
    const tag = `a${++n}`;
    await writer.write(enc.encode(`${tag} ${text}\r\n`));
    const res = await r.response(tag);
    if (res.status !== 'OK') throw new Error(`IMAP ${text.split(' ')[0]} failed: ${res.text}`);
    return res;
  };

  try {
    const hello = await r.response('*');
    if (hello.status !== 'OK') throw new Error(`IMAP greeting: ${hello.text}`);
    await cmd(`LOGIN ${quote(conf.user)} ${quote(conf.password)}`);
    const sel = await cmd(`EXAMINE ${quote(conf.folder || 'INBOX')}`); // read-only: never marks mail as read
    const validity = sel.lines.join('\n').match(/UIDVALIDITY (\d+)/)?.[1] ?? '';
    const uidNext = Number(sel.lines.join('\n').match(/UIDNEXT (\d+)/)?.[1] ?? 0);

    if (lastUid === null || validity !== uidValidity) {
      // First run, or the mailbox was rebuilt: start from "now".
      let high = uidNext - 1;
      if (!uidNext) {
        const s = await cmd('UID SEARCH ALL');
        high = Math.max(
          0,
          ...(s.lines
            .find((l) => l.startsWith('* SEARCH'))
            ?.split(' ')
            .slice(2)
            .map(Number) ?? []),
        );
      }
      return { mails: [], lastUid: high, uidValidity: validity };
    }

    const search = await cmd(`UID SEARCH UID ${lastUid + 1}:*`);
    const uids = (
      search.lines
        .find((l) => l.startsWith('* SEARCH'))
        ?.split(' ')
        .slice(2) ?? []
    )
      .map(Number)
      .filter((u) => u > lastUid)
      .sort((a, b) => a - b)
      .slice(0, 20);

    const mails: FetchedMail[] = [];
    for (const uid of uids) {
      const f = await cmd(`UID FETCH ${uid} (BODY.PEEK[]<0.200000>)`);
      if (f.literals[0]) mails.push({ uid, raw: f.literals[0] });
    }
    await writer.write(enc.encode(`a${++n} LOGOUT\r\n`)).catch(() => undefined);
    return { mails, lastUid: uids.at(-1) ?? lastUid, uidValidity: validity };
  } finally {
    await socket.close().catch(() => undefined);
  }
}

/** Login + open folder, for the daily check. */
export async function checkImap(conf: ImapConfig): Promise<string> {
  const res = await pollImap(conf, null, null);
  return `logged in, ${conf.folder || 'INBOX'} open (uid ${res.lastUid})`;
}
