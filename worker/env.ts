import type { Escalation } from './escalation';

/**
 * Bindings plus optional secrets. Every credential can also be set in the dashboard
 * (Settings → Connections), which takes precedence; these env values are fallbacks.
 */
export interface Env {
  DB: D1Database;
  ESCALATION: DurableObjectNamespace<Escalation>;
  AI?: Ai;
  ASSETS: Fetcher;

  PUBLIC_BASE_URL?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_FROM_NUMBER?: string;
  /** Local testing only: point Twilio REST calls at a mock server. */
  TWILIO_API_BASE?: string;
}
