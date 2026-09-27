// Incremental IMAP response parser (no I/O) — split out so it can be unit-tested in Node.

const dec = new TextDecoder();

export interface ImapResponse {
  /** Untagged + tagged text lines (literals removed). */
  lines: string[];
  /** Raw literal payloads ({n} blocks), e.g. message bodies. */
  literals: Uint8Array[];
  status: 'OK' | 'NO' | 'BAD';
  text: string;
}

/** Incremental parser for IMAP server output. Exported for tests. */
export class ImapReader {
  private buf = new Uint8Array(0);
  constructor(private next: () => Promise<Uint8Array | null>) {}

  private async fill(): Promise<boolean> {
    const chunk = await this.next();
    if (!chunk) return false;
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    this.buf = b;
    return true;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const line = dec.decode(this.buf.subarray(0, i)).replace(/\r$/, '');
        this.buf = this.buf.subarray(i + 1);
        return line;
      }
      if (!(await this.fill())) throw new Error('IMAP connection closed');
    }
  }

  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) if (!(await this.fill())) throw new Error('IMAP connection closed');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Read until the tagged completion line for `tag` (or the greeting when tag = '*'). */
  async response(tag: string): Promise<ImapResponse> {
    const lines: string[] = [];
    const literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      let m: RegExpMatchArray | null;
      while ((m = line.match(/\{(\d+)\}$/))) {
        literals.push(await this.readBytes(Number(m[1])));
        line = line.slice(0, -m[0].length) + '{literal}' + (await this.readLine());
      }
      lines.push(line);
      const done = tag === '*' ? line.startsWith('* ') : line.startsWith(`${tag} `);
      if (done) {
        const [, status = 'BAD', text = ''] =
          line.match(tag === '*' ? /^\* (OK|NO|BAD|PREAUTH|BYE)\s?(.*)$/ : /^\S+ (OK|NO|BAD)\s?(.*)$/) ?? [];
        return {
          lines,
          literals,
          status: status === 'PREAUTH' ? 'OK' : (status as ImapResponse['status']),
          text,
        };
      }
    }
  }
}
