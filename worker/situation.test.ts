import { describe, expect, it } from 'vite-plus/test';
import { cleanDevice, cleanGps, reverseName, whereText } from './context';
import { ASK_DETAILS_SUBJECT, askDetailsText, smsText } from './pipeline';
import { normalizeConfig } from './db';
import { parseSituation, routineLines, spokenSituation, timeline, timelineEmailLines } from './situation';

describe('parseSituation', () => {
  it('reads the JSON reply and clips it', () => {
    const s = parseSituation(
      'Sure: {"now":"Alex is at the bus stop and feels followed","likely":"He wants a lift now","confidence":"high"}',
      'm',
      3,
    );
    expect(s).toMatchObject({
      now: 'Alex is at the bus stop and feels followed',
      confidence: 'high',
      basedOn: 3,
    });
  });
  it('rejects an empty picture and defaults unknown confidence to low', () => {
    expect(() => parseSituation('{"now":""}', 'm', 1)).toThrow();
    expect(parseSituation('{"now":"x","confidence":"sure"}', 'm', 1).confidence).toBe('low');
  });
});

describe('spokenSituation', () => {
  it('adds full stops for the call', () => {
    const s = parseSituation('{"now":"At school","likely":"Wants a call"}', 'm', 1);
    expect(spokenSituation(s)).toBe(
      ' Here is what seems to be happening: At school. Most likely: Wants a call.',
    );
    expect(spokenSituation(null)).toBe('');
  });
});

describe('timeline', () => {
  it('lists messages with age, level, place and added details', () => {
    const now = Date.parse('2026-09-28T10:00:00Z');
    const t = timeline(
      [
        {
          received_at: '2026-09-28T09:50:00Z',
          level: 'concern',
          source: 'kid-page',
          subject: '',
          body: 'someone is behind me',
          context: {
            gps: { lat: 1, lon: 2, accuracy: 20, at: '' },
            place: 'Bishan Park',
            device: { battery: 12, network: 'cellular', timezone: 'Asia/Singapore' },
            details: [{ at: '', text: 'I can see a 7-Eleven' }],
          },
        },
      ],
      now,
    );
    expect(t).toContain('10 min ago (Mon 17:50) [concern] via kid-page, near Bishan Park (GPS ±20 m)');
    expect(t).toContain('phone battery 12%, on cellular');
    expect(t).toContain('added later: "I can see a 7-Eleven"');
  });
});

describe('context helpers', () => {
  it('builds PTR names for IPv4 and IPv6', () => {
    expect(reverseName('1.2.3.4')).toBe('4.3.2.1.in-addr.arpa');
    expect(reverseName('2001:db8::1')).toMatch(/^1\.0\.0\.0\.(0\.){20}8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa$/);
    expect(reverseName('nonsense')).toBeNull();
  });
  it('rejects bad GPS and trims device info', () => {
    expect(cleanGps({ lat: 91, lon: 0 })).toBeUndefined();
    expect(cleanGps({ lat: 1.3521234567, lon: 103.8198, accuracy: 12.4 })).toMatchObject({
      lat: 1.352123,
      accuracy: 12,
    });
    expect(cleanDevice({ battery: 150, network: 'wifi' })).toEqual({ network: 'wifi' });
    expect(cleanDevice({})).toBeUndefined();
  });
  it('falls back to the IP city when there is no GPS', () => {
    expect(whereText({ ipLocation: { city: 'Singapore', country: 'SG' } })).toMatch(/around Singapore, SG/);
    expect(whereText(null)).toBe('');
  });
});

describe('smsText', () => {
  it('uses the picture and a map link when available', () => {
    const cfg = normalizeConfig({ childName: 'Alex' });
    const s = parseSituation('{"now":"At the park","likely":"Wants pickup"}', 'm', 1);
    const sms = smsText(cfg, 'urgent', '', 'come now', 'note', s, {
      gps: { lat: 1.3, lon: 103.8, accuracy: 5, at: '' },
    });
    expect(sms).toContain('(At the park Likely: Wants pickup)');
    expect(sms).toContain('https://maps.google.com/?q=1.3,103.8');
    expect(sms).not.toContain('note');
  });
});

describe('askDetailsText', () => {
  it('puts the safety reminder first and asks what the child sees and hears', () => {
    const cfg = normalizeConfig({
      childName: 'Alex',
      contacts: [
        { name: 'Mum', phone: '+6581234567' },
        { name: 'Dad', phone: '+6581234568' },
      ],
    });
    const t = askDetailsText(cfg, true);
    expect(t.split('\n')[0]).toMatch(/^⚠️ SAFETY FIRST.*999.*995/);
    expect(t).toContain('delete this email');
    expect(t).toContain('calling Mum and Dad now');
    expect(t).toMatch(/What can you hear/);
    expect(ASK_DETAILS_SUBJECT).toBe('Delete me after reading');
  });
});

describe('routineLines', () => {
  const at = (day: number, hhmm: string) => `2026-09-${String(day).padStart(2, '0')}T${hhmm}:00Z`;
  const msg = (received_at: string, body: string, place?: string) => ({
    received_at,
    level: 'normal',
    source: 'kid-page',
    subject: '',
    body,
    context: place ? { place } : null,
  });
  it('keeps patterns seen at least twice, in local time', () => {
    // 08:05 UTC = 16:05 in Singapore; 21–23 Sep 2026 are Mon–Wed.
    const lines = routineLines(
      [
        msg(at(21, '08:05'), "I'm home", 'Block 123, Bishan, Singapore'),
        msg(at(22, '08:10'), "I'm home!", 'Block 123, Bishan, Singapore'),
        msg(at(23, '08:20'), 'home now', 'Block 123, Bishan, Singapore'),
        msg(at(23, '01:00'), 'at the library'),
      ],
      'Asia/Singapore',
    );
    expect(lines).toEqual([`- weekdays around 16:00: "I'm home" near Block 123, Bishan (3 times)`]);
  });
});

describe('timelineEmailLines', () => {
  it('lists the original messages with added details', () => {
    const lines = timelineEmailLines(
      {
        timezone: 'Asia/Singapore',
        routine: [],
        items: [
          {
            received_at: '2026-09-28T09:50:00Z',
            level: 'concern',
            source: 'kid-page',
            subject: '',
            body: 'someone is behind me',
            context: { details: [{ at: '', text: 'I can see a 7-Eleven' }] },
          },
        ],
      },
      { concern: 'Check in' },
    );
    expect(lines).toEqual([
      'Messages this is based on (oldest first):',
      '• Mon 17:50 · Check in · kid-page',
      '  "someone is behind me"',
      '  + added: "I can see a 7-Eleven"',
    ]);
  });
});
