import { describe, expect, it } from 'vite-plus/test';
import { looksLikeGibberish, matchKeyword } from './classify';
import { hashSecret, normalizeConfig, verifyHashed } from './db';
import { emailDecision, senderAllowed, stripQuotedReply } from './senders';

const KW = ['help', 'sos', '911', 'come now', '救命'];

describe('matchKeyword', () => {
  it('matches whole words case-insensitively', () => {
    expect(matchKeyword('HELP me please', KW)).toBe('help');
    expect(matchKeyword('call 911', KW)).toBe('911');
    expect(matchKeyword('mum come now!!', KW)).toBe('come now');
  });
  it('tolerates a stretched last letter', () => {
    expect(matchKeyword('helppppp', KW)).toBe('help');
  });
  it('does not fire inside other words', () => {
    expect(matchKeyword('the teacher was helpful today', KW)).toBeNull();
    expect(matchKeyword('sosig roll for lunch', KW)).toBeNull();
  });
  it('matches CJK keywords as substrings', () => {
    expect(matchKeyword('妈妈救命啊', KW)).toBe('救命');
  });
});

describe('looksLikeGibberish', () => {
  it('flags keyboard mash and symbol floods', () => {
    expect(looksLikeGibberish('asdkjhasdkjh')).toBeTruthy();
    expect(looksLikeGibberish('!!!@@@####')).toBeTruthy();
    expect(looksLikeGibberish('aaaaaaaaaaa')).toBeTruthy();
    expect(looksLikeGibberish('   ')).toBeTruthy();
  });
  it('leaves normal short and non-English messages alone', () => {
    for (const t of [
      'ok',
      'omw',
      "I'm OK",
      'pick me up at 5',
      '我到家了',
      'Strengths and weaknesses homework done :)',
    ]) {
      expect(looksLikeGibberish(t)).toBeNull();
    }
  });
});

describe('stripQuotedReply', () => {
  it('keeps only the new text of a reply', () => {
    expect(stripQuotedReply('Pick me up\n\nOn Mon, Mum wrote:\n> ok')).toBe('Pick me up');
  });
});

describe('senderAllowed', () => {
  it('matches addresses exactly and domains by suffix', () => {
    const allowed = ['kid@gmail.com', '@school.edu', 'club.org'];
    expect(senderAllowed('Kid@Gmail.com', allowed)).toBe(true);
    expect(senderAllowed('notkid@gmail.com', allowed)).toBe(false);
    expect(senderAllowed('teacher@school.edu', allowed)).toBe(true);
    expect(senderAllowed('a@club.org', allowed)).toBe(true);
    expect(senderAllowed('a@evilclub.org', allowed)).toBe(false);
  });
});

describe('hashSecret', () => {
  it('is stable for the same value (re-applying config keeps sessions) and verifies', async () => {
    const a = await hashSecret('2468');
    expect(await hashSecret('2468')).toBe(a);
    expect(await verifyHashed(a, '2468')).toBe(true);
    expect(await verifyHashed(a, '1357')).toBe(false);
  });
});

describe('emailDecision', () => {
  const cfg = normalizeConfig({
    childName: 'Alex',
    channels: { allowedSenders: ['kid@gmail.com'], acceptMentions: true, watchNames: ['Alex', '小明'] },
  });
  it('trusts allowed senders', () => {
    expect(emailDecision(cfg, 'kid@gmail.com', 'hi').kind).toBe('trusted');
  });
  it('accepts others only when a watched name is clearly mentioned', () => {
    expect(emailDecision(cfg, 'teacher@school.edu', 'Alex fell during PE today')).toEqual({
      kind: 'mentions',
      name: 'Alex',
    });
    expect(emailDecision(cfg, 'mum2@x.com', '小明在我家').kind).toBe('mentions');
    expect(emailDecision(cfg, 'shop@x.com', 'Alexandra ordered tickets').kind).toBe('ignore');
    expect(emailDecision(cfg, 'spam@x.com', 'Win a prize').kind).toBe('ignore');
  });
  it('ignores mentions when the option is off', () => {
    const off = normalizeConfig({ ...cfg, channels: { ...cfg.channels, acceptMentions: false } });
    expect(emailDecision(off, 'teacher@school.edu', 'Alex fell').kind).toBe('ignore');
  });
});

describe('normalizeConfig', () => {
  it('adds the sk-or-v1- prefix to a bare OpenRouter key', () => {
    const c = normalizeConfig({ services: { openrouterApiKey: 'a'.repeat(64) } });
    expect(c.services.openrouterApiKey).toBe(`sk-or-v1-${'a'.repeat(64)}`);
  });
});

describe('watched names are case-insensitive', () => {
  const cfg = normalizeConfig({
    childName: 'Alex',
    channels: { acceptMentions: true, watchNames: ['alex', 'Li Ming'] },
  });
  it.each(['ALEX is sick', 'alex is sick', 'Alex is sick', 'I saw aLeX', 'li ming called', 'LI MING'])(
    '%s',
    (t) => {
      expect(emailDecision(cfg, 'x@y.com', t).kind).toBe('mentions');
    },
  );
});
