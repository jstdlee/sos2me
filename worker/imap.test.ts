import { describe, expect, it } from 'vite-plus/test';
import { ImapReader } from './imap-reader';

function readerOf(...chunks: string[]) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => enc.encode(c));
  return new ImapReader(async () => queue.shift() ?? null);
}

describe('ImapReader', () => {
  it('reads the greeting and tagged responses split across chunks', async () => {
    const r = readerOf('* OK Gimap ready\r\n', 'a1 OK LOG', 'GED IN\r\n');
    expect((await r.response('*')).status).toBe('OK');
    const res = await r.response('a1');
    expect(res.status).toBe('OK');
    expect(res.text).toBe('LOGGED IN');
  });

  it('extracts literals (message bodies) byte-exactly', async () => {
    const body = 'Subject: hi\r\n\r\nhelp me\r\n';
    const r = readerOf(`* 1 FETCH (UID 7 BODY[]<0> {${body.length}}\r\n${body})\r\n`, 'a2 OK FETCH done\r\n');
    const res = await r.response('a2');
    expect(new TextDecoder().decode(res.literals[0])).toBe(body);
    expect(res.status).toBe('OK');
  });

  it('reports NO responses', async () => {
    const r = readerOf('a3 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
    const res = await r.response('a3');
    expect(res.status).toBe('NO');
  });
});
