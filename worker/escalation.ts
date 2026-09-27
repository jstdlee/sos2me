import { DurableObject } from 'cloudflare:workers';
import type { AlertStatus, Level } from '../shared/types';
import { getMessage, loadConfig, logEvent, setMessageStatus } from './db';
import type { Env } from './env';
import { endCall, fetchCall, placeCall, twilioCreds, type TwilioCreds } from './twilio';
import { checkPublicAddress } from './pipeline';
import { twimlDocument, voiceTwiml } from './voice';

export interface EscalationPlan {
  messageId: string;
  level: Level;
  contacts: { name: string; phone: string }[];
  rounds: number;
  retryMinutes: number;
  requireConfirm: boolean;
  /** Immediate re-calls to the same person when they decline (busy). Optional for older alerts. */
  redialOnDecline?: number;
  baseUrl: string;
}

interface State extends EscalationPlan {
  round: number; // 0-based round currently in progress
  index: number; // next contact to call in this round
  currentCallSid: string | null;
  currentName: string | null;
  /** When the current call was placed (ms). */
  callStartedAt?: number;
  /** false when our public address doesn't reach us, so "press 1" can't arrive. */
  canConfirm?: boolean;
  /** Immediate redials already made to the current contact. */
  redials: number;
  anyCallPlaced: boolean;
  done: boolean;
}

/** Longest a single call attempt may take before we move on (ring 30s + message + gather). */
const CALL_WATCHDOG_MS = 3 * 60_000;
/** While a call is active we also ask Twilio for its status, in case callbacks can't reach us. */
const POLL_MS = 15_000;
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

/**
 * One instance per alert (named by message id). Calls contacts one at a time, in order,
 * round after round, until someone confirms (presses 1) — or the rounds run out.
 * Twilio status callbacks move it forward immediately; an alarm is the safety net.
 */
export class Escalation extends DurableObject<Env> {
  private async load(): Promise<State | undefined> {
    return this.ctx.storage.get<State>('state');
  }
  private async save(s: State): Promise<void> {
    await this.ctx.storage.put('state', s);
  }
  private async creds(): Promise<TwilioCreds> {
    return twilioCreds(this.env, await loadConfig(this.env));
  }

  async start(plan: EscalationPlan): Promise<void> {
    if (await this.load()) return; // idempotent
    const s: State = {
      ...plan,
      round: 0,
      index: 0,
      currentCallSid: null,
      currentName: null,
      redials: 0,
      anyCallPlaced: false,
      done: false,
    };
    await this.save(s);
    await this.advance(s);
  }

  async status(): Promise<State | undefined> {
    return this.load();
  }

  /** From the Twilio status callback (or from polling Twilio when callbacks can't reach us). */
  async callStatus(callSid: string, callStatus: string, duration = 0): Promise<void> {
    const s = await this.load();
    if (!s || s.done || callSid !== s.currentCallSid) return;

    if (!s.requireConfirm && (callStatus === 'in-progress' || (callStatus === 'completed' && duration > 0))) {
      await this.finish(s, 'answered', s.currentName, /* hangUp */ false);
      return;
    }
    if (!TERMINAL.has(callStatus)) return;

    // "Press 1" can't reach us: a pickup where the parent listened ≥ 15 s is the best signal we have.
    if (callStatus === 'completed' && s.requireConfirm && s.canConfirm === false && duration >= 15) {
      await logEvent(
        this.env,
        'call_listened',
        `${s.currentName} picked up and listened ${duration}s (pressing 1 isn't possible: public address unreachable)`,
        s.messageId,
      );
      await this.finish(s, 'answered', s.currentName, /* hangUp */ false);
      return;
    }

    s.currentCallSid = null;
    // Declined ("busy"): ring the same person again right away — they may be in a meeting, and on
    // iPhone a repeated call within 3 minutes rings through Do Not Disturb. No answer: next contact.
    if (callStatus === 'busy' && (s.redials ?? 0) < (s.redialOnDecline ?? 1)) {
      s.redials = (s.redials ?? 0) + 1;
      s.index -= 1; // advance() will call the same contact again
      await logEvent(this.env, 'call_declined', `${s.currentName} declined — calling again now`, s.messageId);
    } else {
      s.redials = 0;
      const why =
        callStatus === 'busy'
          ? 'declined again'
          : callStatus === 'completed' && duration > 0
            ? `picked up (${duration}s) but did not press 1`
            : callStatus;
      await logEvent(this.env, 'call_ended', `${s.currentName}: ${why} — next contact`, s.messageId);
    }
    await this.save(s);
    await this.ctx.storage.setAlarm(Date.now() + 2_000);
  }

  /** From the keypad <Gather>: pressing 1 confirms. */
  async confirm(callSid: string): Promise<boolean> {
    const s = await this.load();
    if (!s || s.done) return false;
    const who = callSid === s.currentCallSid ? s.currentName : null;
    await this.finish(s, 'confirmed', who, /* hangUp */ false);
    return true;
  }

  async stop(): Promise<void> {
    const s = await this.load();
    if (!s || s.done) return;
    await this.finish(s, 'stopped', null);
  }

  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s || s.done) return;
    if (s.currentCallSid) {
      const sid = s.currentCallSid;
      try {
        const call = await fetchCall(await this.creds(), sid);
        if (call.status === 'in-progress' || TERMINAL.has(call.status)) {
          await this.callStatus(sid, call.status, call.duration);
          const after = await this.load();
          if (!after || after.done || after.currentCallSid !== sid) return; // handled
        }
      } catch {
        /* polling is best-effort; the watchdog below still applies */
      }
      if (Date.now() - (s.callStartedAt ?? 0) < CALL_WATCHDOG_MS) {
        await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
        return;
      }
      // Watchdog: no final status at all. Hang up and move on.
      await logEvent(this.env, 'call_timeout', `${s.currentName}: no final status from Twilio`, s.messageId);
      await endCall(await this.creds(), sid);
      s.currentCallSid = null;
    }
    await this.advance(s);
  }

  private async advance(s: State): Promise<void> {
    if (s.done) return;

    if (s.index >= s.contacts.length) {
      s.round += 1;
      s.index = 0;
      if (s.round >= s.rounds) {
        await this.finish(s, s.anyCallPlaced ? 'unanswered' : 'failed', null);
        return;
      }
      await this.save(s);
      await logEvent(
        this.env,
        'round_wait',
        `Nobody confirmed. Round ${s.round + 1} of ${s.rounds} in ${s.retryMinutes} min.`,
        s.messageId,
      );
      await this.ctx.storage.setAlarm(Date.now() + s.retryMinutes * 60_000);
      return;
    }
    if (s.redials === undefined) s.redials = 0;

    const contact = s.contacts[s.index]!;
    s.index += 1;
    const q = `m=${encodeURIComponent(s.messageId)}`;
    try {
      const [cfg, msg] = await Promise.all([loadConfig(this.env), getMessage(this.env, s.messageId)]);
      if (s.canConfirm === undefined) {
        const reach = s.baseUrl
          ? await checkPublicAddress(this.env, s.baseUrl)
          : { ok: false, detail: 'no public address set' };
        s.canConfirm = reach.ok;
        if (!reach.ok) {
          await logEvent(
            this.env,
            'no_keypad',
            `${s.baseUrl || 'Public address'}: ${reach.detail}. Calling anyway — the message is read out and a pickup of 15 s+ counts as answered.`,
            s.messageId,
          );
        }
      }
      if (!msg) throw new Error('message not found');
      const sid = await placeCall(twilioCreds(this.env, cfg), {
        to: contact.phone,
        statusUrl: s.canConfirm ? `${s.baseUrl}/twilio/status?${q}` : undefined,
        twiml: twimlDocument(voiceTwiml(cfg, msg, s.requireConfirm, s.baseUrl, s.canConfirm)),
      });
      s.currentCallSid = sid;
      s.callStartedAt = Date.now();
      s.currentName = contact.name || contact.phone;
      s.anyCallPlaced = true;
      await this.save(s);
      await logEvent(
        this.env,
        'call_placed',
        `${s.redials ? 'Calling again' : 'Calling'} ${s.currentName} (round ${s.round + 1}/${s.rounds})`,
        s.messageId,
      );
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
    } catch (e) {
      s.currentCallSid = null;
      await this.save(s);
      await logEvent(this.env, 'call_error', `${contact.name || contact.phone}: ${String(e)}`, s.messageId);
      await this.ctx.storage.setAlarm(Date.now() + 2_000);
    }
  }

  private async finish(s: State, status: AlertStatus, who: string | null, hangUp = true): Promise<void> {
    const sid = s.currentCallSid;
    s.done = true;
    s.currentCallSid = null;
    await this.save(s);
    await this.ctx.storage.deleteAlarm();
    if (hangUp && sid) await endCall(await this.creds(), sid);
    await setMessageStatus(this.env, s.messageId, status, who);
    const text: Record<string, string> = {
      confirmed: `${who ?? 'A parent'} confirmed on the phone.`,
      answered: `${who ?? 'A parent'} answered.`,
      unanswered: `Nobody confirmed after ${s.rounds} round(s).`,
      failed: 'No call could be placed. Check Twilio settings.',
      stopped: 'Calling stopped from the dashboard.',
    };
    await logEvent(this.env, `alert_${status}`, text[status] ?? status, s.messageId);
  }
}
