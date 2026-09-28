import {
  parseJson,
  type Config,
  type MessageContext,
  type MessageRow,
  type Situation,
} from '../shared/types';
import { spokenSituation } from './situation';
import { gather, say } from './twilio';

const INTRO = {
  urgent: (name: string) => `Urgent. This is S O S to me with an urgent message from ${name}.`,
  concern: (name: string) =>
    `Hello. This is S O S to me. ${name} sent a message that may need your attention.`,
  normal: (name: string) => `Hello. This is S O S to me with a new message from ${name}.`,
};

/**
 * The TwiML spoken on a call (without the outer <Response>). Sent inline with the call itself, so the
 * message is read out even if Twilio cannot reach our public address; "press 1" posts to /twilio/gather.
 */
export function voiceTwiml(
  cfg: Config,
  msg: MessageRow,
  needConfirm: boolean,
  baseUrl: string,
  canConfirm = true,
): string {
  const v = cfg.voice;
  const intro =
    msg.reason === 'test call'
      ? 'Hello. This is a test call from S O S to me.'
      : INTRO[msg.level](cfg.childName);
  const content = v.readMessage
    ? ` The message says: ${[msg.subject, msg.body].filter(Boolean).join('. ').slice(0, 600)}.`
    : ' Please check your messages.';
  // The prediction (from all recent messages) replaces the per-message note, to keep the call short.
  const prediction = v.readSituation ? spokenSituation(parseJson<Situation>(msg.situation)) : '';
  const ctx = v.readSituation ? parseJson<MessageContext>(msg.context) : null;
  const where = ctx?.place ? ` ${cfg.childName}'s phone is near ${ctx.place}.` : '';
  const note = prediction
    ? prediction + where
    : (v.readAiSummary && msg.insight ? ` Assistant's note: ${msg.insight}` : '') + where;
  if (!baseUrl || !canConfirm) {
    // Keypad replies can't reach us: read it twice; staying on the line counts as confirmation.
    const once = intro + content + note;
    return `${say(once, v)}<Pause length="1"/>${say(`Again. ${once}`, v)}${say('Goodbye.', v)}`;
  }
  const prompt = needConfirm
    ? ' Press 1 to confirm you got this. Press 2 to hear it again.'
    : ' Press 2 to hear it again, or hang up.';
  const action = `${baseUrl}/twilio/gather?m=${encodeURIComponent(msg.id)}`;
  const text = intro + content + note + prompt;
  // Say it twice inside the Gather so a parent who picks up mid-sentence still hears everything.
  const fallback = needConfirm
    ? say('We did not get a confirmation, so we will keep trying. Goodbye.', v)
    : say('Goodbye.', v);
  return gather(action, say(text, v) + '<Pause length="1"/>' + say(text, v)) + fallback;
}

export const twimlDocument = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
