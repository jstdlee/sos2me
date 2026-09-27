import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { say, verifySignature } from './twilio';

const TOKEN = 'test-token';
const url = 'https://sos.example.com/twilio/status?m=abc';
const params = { CallSid: 'CA123', CallStatus: 'completed', To: '+6580000001' };

// Reference implementation straight from Twilio's docs: HMAC-SHA1(url + sorted key/value pairs).
const sign = (u: string, p: Record<string, string>) =>
  createHmac('sha1', 'test-token')
    .update(
      u +
        Object.keys(p)
          .sort()
          .map((k) => k + p[k])
          .join(''),
    )
    .digest('base64');

describe('verifySignature', () => {
  it('accepts a correctly signed request', async () => {
    const req = new Request(url, { method: 'POST', headers: { 'X-Twilio-Signature': sign(url, params) } });
    expect(await verifySignature(TOKEN, req, params)).toBe(true);
  });
  it('rejects tampered params or a missing header', async () => {
    const req = new Request(url, { method: 'POST', headers: { 'X-Twilio-Signature': sign(url, params) } });
    expect(await verifySignature(TOKEN, req, { ...params, CallStatus: 'in-progress' })).toBe(false);
    expect(await verifySignature(TOKEN, new Request(url, { method: 'POST' }), params)).toBe(false);
  });
});

describe('say', () => {
  it('escapes the child message for TwiML', () => {
    expect(say('<b>&"hi"', { language: 'en-US', voice: '' })).toBe(
      '<Say language="en-US">&lt;b&gt;&amp;&quot;hi&quot;</Say>',
    );
  });
});
