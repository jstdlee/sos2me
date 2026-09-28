// Types shared by the Vue app and the Worker.

/**
 * urgent  — the child may be in danger or needs a parent right now
 * concern — not an emergency, but a parent should gently check in (sad, bullied, unwell…)
 * normal  — everyday updates
 */
export type Level = 'urgent' | 'concern' | 'normal';
export const LEVELS: Level[] = ['urgent', 'concern', 'normal'];

export type Source = 'kid-page' | 'email' | 'mailbox' | 'ntfy' | 'test';

/** Where an alert is in its lifecycle. */
export type AlertStatus =
  | 'calling' // escalation in progress
  | 'confirmed' // a parent pressed 1 on the call
  | 'answered' // a parent answered (only used when confirmation is off)
  | 'unanswered' // gave up after all rounds
  | 'stopped' // stopped from the dashboard
  | 'texted' // SMS / email only, no call
  | 'logged' // recorded only (paused / no contacts / notify = none)
  | 'failed'; // could not place any call

/** Secret values are never sent to the browser; this placeholder stands in for "unchanged". */
export const SECRET_MASK = '••••••••';

export interface Contact {
  id: string;
  name: string;
  /** E.164, e.g. +6581234567 */
  phone: string;
  /** Optional: receives alert emails and the daily system check. */
  email: string;
  enabled: boolean;
}

export interface LevelPolicy {
  /** Place phone calls for this level. */
  call: boolean;
  /** Also send an SMS with the message text. */
  sms: boolean;
  /** Also send an email (via AgentMail) to contacts with an email address. */
  email: boolean;
  /** How many times to go through the whole contact list. */
  rounds: number;
  /** Minutes to wait between rounds. */
  retryMinutes: number;
  /** Keep calling until someone presses 1 (otherwise a pickup is enough). */
  requireConfirm: boolean;
  /** If a contact declines the call, ring them again immediately this many times (0–3). */
  redialOnDecline: number;
}

export type AiProvider = 'workers-ai' | 'openrouter' | 'openai';

export interface AiModel {
  id: string;
  provider: AiProvider;
  model: string;
  enabled: boolean;
}

export interface Mailbox {
  id: string;
  name: string;
  enabled: boolean;
  type: 'agentmail' | 'imap';
  /** AgentMail inbox address, or the IMAP username. */
  address: string;
  /** AgentMail only: leave empty to use the global AgentMail key. */
  apiKey: string;
  /** IMAP only */
  host: string;
  port: number;
  password: string;
  folder: string;
}

export interface NtfySource {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  topic: string;
  /** Optional username for protected topics (then `token` is the password). */
  username: string;
  /** Optional: access token (tk_…), or the password when `username` is set. */
  token: string;
}

export interface Config {
  childName: string;
  /** Helps the AI read the message, e.g. "11". */
  childAge: string;
  paused: boolean;
  /** Dashboard password. Stored hashed; overrides the ADMIN_PASSWORD secret when set. */
  adminPassword: string;
  /** Public https address of this app, used for Twilio callbacks. Empty = auto-detect. */
  publicBaseUrl: string;

  contacts: Contact[];
  policy: Record<Level, LevelPolicy>;

  rules: {
    urgentKeywords: string[];
    /** Treat keyboard-mash / symbol-heavy text as urgent. */
    gibberishIsUrgent: boolean;
    /**
     * If a keyword matched but the AI is sure it's harmless ("lol help me with maths"),
     * use "concern" instead of "urgent". Never goes lower than "concern".
     */
    aiCanSoften: boolean;
  };

  ai: {
    enabled: boolean;
    /** Tried in order; the first model that answers wins. */
    models: AiModel[];
    timeoutSeconds: number;
  };

  voice: {
    /** Twilio <Say> language, e.g. en-US, en-GB, cmn-CN. */
    language: string;
    /** Twilio voice, e.g. Polly.Joanna-Neural. Empty = Twilio default. */
    voice: string;
    /** Read the child's actual message aloud on the call. */
    readMessage: boolean;
    /** Also read the AI's one-line note ("Alex sounds scared…"). */
    readAiSummary: boolean;
    /** Read the AI prediction of what is happening (from recent messages) and where the child is. */
    readSituation: boolean;
  };

  /** AI prediction of what is happening, built from the child's recent messages. */
  situation: {
    enabled: boolean;
    /** How far back to look. */
    windowHours: number;
    /** At most this many recent messages. */
    maxMessages: number;
    /** Email the prediction to parents after each message, even for levels without alert emails. */
    email: boolean;
  };

  twilio: {
    accountSid: string;
    authToken: string;
    apiKeySid: string;
    apiKeySecret: string;
    fromNumber: string;
  };

  services: {
    agentmailApiKey: string;
    /** AgentMail inbox that sends alert and system-check emails. */
    agentmailFrom: string;
    openrouterApiKey: string;
    openaiBaseUrl: string;
    openaiApiKey: string;
    /** Default model id for "OpenAI-compatible" entries in the model chain. */
    openaiModel: string;
    /** Only needed for Workers AI outside Cloudflare (local dev). */
    cloudflareAccountId: string;
    cloudflareApiToken: string;
  };

  channels: {
    kidPage: {
      enabled: boolean;
      /** Serve the kid page at the site root ("/") instead of only the secret /k/<token> link. Needs a PIN. */
      homeAtRoot: boolean;
      token: string;
      pin: string;
      quickReplies: string[];
      /** Send GPS (if the child allows it), battery and network type with each message. */
      shareLocation: boolean;
    };
    /**
     * Reply straight away to urgent / check-in emails from the child, asking where they are and
     * what they can see and hear. Subject "Delete me after reading", safety reminder first.
     */
    askForDetails: boolean;

    /** Senders accepted by every email channel (addresses or @domains). */
    allowedSenders: string[];
    /**
     * Also analyse email from anyone else if it clearly mentions one of these names
     * (e.g. a teacher writing about Alex). Only urgent / check-in results notify you.
     */
    acceptMentions: boolean;
    watchNames: string[];
    /** Cloudflare Email Routing → this Worker. */
    emailRouting: { enabled: boolean; forwardTo: string };
    mailboxes: Mailbox[];
    ntfy: NtfySource[];
  };

  health: {
    enabled: boolean;
    /** Local time HH:MM to run the daily check. */
    time: string;
    timezone: string;
    /** Extra addresses; contacts with an email always get it. */
    extraEmails: string[];
    /** Email even when everything works. */
    emailWhenOk: boolean;
    /** Also text parents when something is broken (if Twilio still works). */
    smsOnFailure: boolean;
  };
}

// Deliberately phrases, not single ambiguous words ("lost" alone fires on "I lost my pencil").
// The AI helper catches everything subtler. Matching is case-insensitive and whole-word.
export const DEFAULT_URGENT_KEYWORDS = [
  // English — direct
  'help',
  'help me',
  'sos',
  'emergency',
  '911',
  '999',
  '995',
  '112',
  'call police',
  'call the police',
  'police',
  'ambulance',
  'hospital',
  'come now',
  'come quickly',
  'come fast',
  'hurry',
  'pick me up now',
  'please come',
  'need you now',
  'call me now',
  'code red',
  // English — danger
  'following me',
  'someone is following',
  'being followed',
  'stranger',
  'kidnap',
  'kidnapped',
  'taken me',
  'trapped',
  'locked in',
  "can't get out",
  'cant get out',
  'stuck',
  'attacked',
  'hit me',
  'hurting me',
  'he touched me',
  'she touched me',
  'touched me',
  'grabbed me',
  'threatened',
  'threatening me',
  'has a knife',
  'knife',
  'gun',
  'weapon',
  'fire',
  'accident',
  'crash',
  'robbed',
  'mugged',
  "i'm lost",
  'im lost',
  'i am lost',
  'got lost',
  'dont know where i am',
  "don't know where i am",
  'scared',
  'terrified',
  'afraid',
  'in danger',
  'not safe',
  'unsafe',
  'danger',
  // English — health
  'hurt',
  'injured',
  'bleeding',
  'blood',
  "can't breathe",
  'cant breathe',
  'fainted',
  'fell down',
  'broke my',
  'broken arm',
  'broken leg',
  'allergic',
  'allergy',
  'asthma',
  'seizure',
  'unconscious',
  'overdose',
  'poison',
  'chest pain',
  'very sick',
  'vomiting blood',
  // English — self-harm (always call)
  'kill myself',
  'want to die',
  'wanna die',
  'end my life',
  'suicide',
  'hurt myself',
  'cut myself',
  'self harm',
  'self-harm',
  "don't want to live",
  'dont want to live',
  'better off without me',
  // English — online safety
  'send pics',
  'send nudes',
  'nudes',
  'meet me alone',
  "don't tell your parents",
  'dont tell your parents',
  'our secret',
  'blackmail',
  // Chinese (simplified + traditional)
  '救命',
  '救我',
  '帮帮我',
  '幫幫我',
  '紧急',
  '緊急',
  '报警',
  '報警',
  '警察',
  '快来',
  '快來',
  '马上来',
  '馬上來',
  '有人跟踪',
  '有人跟蹤',
  '跟着我',
  '跟著我',
  '陌生人',
  '绑架',
  '綁架',
  '被困',
  '出不去',
  '迷路',
  '走丢',
  '走丟',
  '找不到你',
  '害怕',
  '好怕',
  '危险',
  '危險',
  '受伤',
  '受傷',
  '流血',
  '医院',
  '醫院',
  '救护车',
  '救護車',
  '晕倒',
  '暈倒',
  '喘不过气',
  '喘不過氣',
  '车祸',
  '車禍',
  '着火',
  '著火',
  '打我',
  '摸我',
  '想死',
  '不想活',
  '自杀',
  '自殺',
  '割腕',
  // Malay
  'tolong',
  'bahaya',
  'kecemasan',
  'sesat',
  'takut',
  'polis',
  'hospital segera',
];

export const DEFAULT_CONFIG: Config = {
  childName: 'your child',
  childAge: '',
  paused: false,
  adminPassword: '',
  publicBaseUrl: '',
  contacts: [],
  policy: {
    urgent: {
      call: true,
      sms: true,
      email: true,
      rounds: 5,
      retryMinutes: 2,
      requireConfirm: true,
      redialOnDecline: 1,
    },
    concern: {
      call: true,
      sms: true,
      email: true,
      rounds: 2,
      retryMinutes: 10,
      requireConfirm: false,
      redialOnDecline: 1,
    },
    normal: {
      call: true,
      sms: false,
      email: false,
      rounds: 1,
      retryMinutes: 2,
      requireConfirm: false,
      redialOnDecline: 1,
    },
  },
  rules: { urgentKeywords: DEFAULT_URGENT_KEYWORDS, gibberishIsUrgent: true, aiCanSoften: true },
  ai: {
    enabled: true,
    timeoutSeconds: 12,
    models: [
      {
        id: 'cf-llama',
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        enabled: true,
      },
      {
        id: 'cf-sealion',
        provider: 'workers-ai',
        model: '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
        enabled: true,
      },
      { id: 'or-free', provider: 'openrouter', model: 'openrouter/free', enabled: true },
    ],
  },
  voice: { language: 'en-US', voice: '', readMessage: true, readAiSummary: true, readSituation: true },
  situation: { enabled: true, windowHours: 6, maxMessages: 8, email: true },
  twilio: { accountSid: '', authToken: '', apiKeySid: '', apiKeySecret: '', fromNumber: '' },
  services: {
    agentmailApiKey: '',
    agentmailFrom: '',
    openrouterApiKey: '',
    openaiBaseUrl: '',
    openaiApiKey: '',
    openaiModel: '',
    cloudflareAccountId: '',
    cloudflareApiToken: '',
  },
  channels: {
    kidPage: {
      enabled: true,
      homeAtRoot: false,
      token: '',
      pin: '',
      quickReplies: ["I'm OK", 'Please call me', 'Pick me up', "I'll be late", "I'm home"],
      shareLocation: true,
    },
    askForDetails: true,
    allowedSenders: [],
    acceptMentions: true,
    watchNames: [],
    emailRouting: { enabled: false, forwardTo: '' },
    mailboxes: [],
    ntfy: [],
  },
  health: {
    enabled: true,
    time: '09:00',
    timezone: 'Asia/Singapore',
    extraEmails: [],
    emailWhenOk: false,
    smsOnFailure: true,
  },
};

export const EMPTY_MAILBOX: Omit<Mailbox, 'id'> = {
  name: '',
  enabled: true,
  type: 'agentmail',
  address: '',
  apiKey: '',
  host: 'imap.gmail.com',
  port: 993,
  password: '',
  folder: 'INBOX',
};

export const EMPTY_NTFY: Omit<NtfySource, 'id'> = {
  name: '',
  enabled: true,
  baseUrl: 'https://ntfy.sh',
  topic: '',
  username: '',
  token: '',
};

export interface MessageRow {
  id: string;
  source: Source;
  sender: string;
  subject: string;
  body: string;
  received_at: string;
  level: Level;
  reason: string;
  /** AI note for parents, e.g. "Alex sounds scared — someone is following him." */
  insight: string;
  status: AlertStatus;
  acknowledged_by: string | null;
  updated_at: string;
  /** JSON MessageContext, or '' */
  context: string;
  /** JSON Situation, or '' */
  situation: string;
}

/** Where the child was when sending, and anything they added afterwards. All fields optional. */
export interface MessageContext {
  /** From the phone's GPS, if the child allowed it. */
  gps?: { lat: number; lon: number; accuracy: number; at: string };
  /** Street address near the GPS fix (OpenStreetMap). */
  place?: string;
  /** Named places within ~200 m: parks, shops, stations, buildings. */
  nearby?: string[];
  /** From the connection, as seen by Cloudflare. City-level at best. */
  ip?: string;
  hostname?: string;
  isp?: string;
  ipLocation?: { city?: string; region?: string; country?: string; lat?: number; lon?: number };
  /** Reported by the kid page's browser. Web pages can't read the Wi-Fi name or device name. */
  device?: {
    network?: string;
    effectiveType?: string;
    battery?: number;
    charging?: boolean;
    timezone?: string;
    language?: string;
    platform?: string;
    userAgent?: string;
  };
  /** Extra details the child added after sending ("I can see a 7-Eleven"). */
  details?: { at: string; text: string }[];
}

/** The AI's short prediction of what is most likely happening, from the recent messages. */
export interface Situation {
  /** What is most likely happening right now. */
  now: string;
  /** The most likely explanation / what happens next / what the child needs. */
  likely: string;
  confidence: 'low' | 'medium' | 'high';
  model: string;
  at: string;
  /** Number of messages it was based on. */
  basedOn: number;
}

export function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface EventRow {
  id: number;
  ts: string;
  message_id: string | null;
  kind: string;
  detail: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** Works, but something should be improved (does not trigger the failure email). */
  warn?: boolean;
  detail: string;
}

export interface HealthReport {
  ranAt: string;
  ok: boolean;
  checks: CheckResult[];
  emailed: string[];
}

export interface StatusInfo {
  twilio: boolean;
  twilioSignatureCheck: boolean;
  publicBaseUrl: string;
  agentmail: boolean;
  lastHealth: HealthReport | null;
}
