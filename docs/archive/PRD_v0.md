---
title: Emergency Notifier (Email/Web → SMS/Call)
status: draft
owner: ""
created_at: 2026-05-30
---

# 1) Summary
Build a single-tenant VPS-hosted Python service that monitors incoming messages (email and optionally a web channel), classifies them as `normal`, `emergency`, or `unknown`, and notifies parents.

- `emergency` / `unknown`: call repeatedly until a parent picks up + send SMS + send email summary
- `normal`: send SMS once (no calls)

The system includes a responsive admin panel (mobile + desktop browser) for managing parents/contacts, reviewing messages/alerts, and viewing event logs.

# 2) Target Users
- Primary: parent/guardian receiving escalations
- Secondary: child/sender who can only communicate via email/web (no phone access)

# 3) Goals
- Detect potentially urgent messages reliably enough for private family use
- Escalate emergencies via voice calls until a parent answers
- Keep implementation small and demo-ready (single VPS, minimal dependencies, text-file storage)

# 4) Non-Goals
- Multi-tenant SaaS, billing, user sign-up
- End-to-end encryption, advanced privacy controls
- Complex analytics and dashboards beyond basic logs

# 5) Message Sources (MVP)
## Email (required)
- Monitor one mailbox.
- Accept messages from an allowlist of senders (optional strict mode) or accept all senders (demo mode).
- Poll every 5 minutes.

## Web channel (optional)
- Accept inbound posts via a simple authenticated webhook endpoint (recommended for demo), OR monitor an ntfy topic if desired later.

# 6) Classification (Hybrid: Keywords + AI + Heuristics)
The classifier outputs:
- `normal`
- `emergency`
- `unknown` (treated as `emergency` for escalation)

## 6.1 Keyword / Code Matching (fast path)
Inputs:
- Subject + body text (email)
- Message text (web)

Rules:
- If any emergency code/keyword matches, classify as `emergency`.
- Keyword lists are configurable in admin panel (e.g., `HELP`, `911`, `CODE RED`, `HOSPITAL`, `POLICE`, `I AM LOST`, custom family codes).

## 6.2 Unknown Detection (gibberish / abnormal text)
Unknown implies possible distress, compromised sender, or inability to type clearly.

Heuristics (no external libraries required):
- Too many non-letter characters: `non_alnum_ratio > threshold`
- Repeated characters or repeated short patterns: e.g., `aaaaa`, `!!!!!!!`, `asdfasdfasdf`
- Very low whitespace usage or extremely long tokens: `max_token_len > threshold`
- High fraction of tokens not matching a simple word pattern `[a-zA-Z]{2,}` (configurable for multilingual needs)
- High entropy-like behavior approximated by high unique-character ratio combined with low vowel ratio (English-oriented)

If unknown heuristics exceed thresholds, classify as `unknown`.

## 6.3 AI Classifier (slow path)
If not matched by keywords and not clearly unknown by heuristics:
- Use an LLM classifier to return one of: `normal | emergency | unknown`
- Provide the LLM with:
  - family-specific context: “this is a child contacting parents; treat ambiguity conservatively”
  - the emergency code list (so model can map variants)
  - rules: “if uncertain, output unknown”

MVP requirement:
- AI is optional but supported; if AI fails (timeout/error), fall back to keyword + unknown heuristics.

# 7) Notification Policy
## 7.1 Normal
- Send SMS once to all configured parent numbers.
- No calling.

## 7.2 Emergency / Unknown
- Send SMS immediately to all parent numbers.
- Send email summary immediately (to configured parent email addresses).
- Start voice call escalation:
  - Call in configured order.
  - If no answer, retry in rounds until answered.
  - Stop all further calls immediately once one call is answered.
  - Configurable limits (recommended even for private usage):
    - max rounds (default: 10)
    - max total duration (default: 60 minutes)
    - retry interval (default: 2–5 minutes)

# 8) Voice Announcement (Pre-Generated Audio)
Audio files are pre-generated and selected by classification:
- `emergency`: short direct audio (“Emergency alert about your child. Please check the latest message now.”)
- `unknown`: short direct audio (“Urgent alert. Message is unclear. Please check immediately.”)

Implementation requirement:
- Host audio files on the VPS over HTTPS and provide publicly reachable URLs to the voice provider for playback.

# 9) Admin Panel (Responsive Web)
## 9.1 Authentication
- Single admin login (basic password or basic auth) suitable for demo.

## 9.2 Pages
- Dashboard: last 24h alerts, current escalation status (if any)
- Messages: list, view raw content, classification result, source, timestamps
- Contacts: parent phone numbers + parent emails; call order; enable/disable
- Rules: keyword/code list; enable/disable AI classifier; unknown thresholds
- Audio: upload/replace `emergency` and `unknown` audio files; preview links
- Logs: append-only event log viewer (filter by date/type)

# 10) Data & Storage (Text Files)
Single VPS, minimal moving parts.
- `config.json` (or `config.yaml`): contacts, keywords, thresholds, provider credentials pointers
- `state.json`: last processed message ids/timestamps per source
- `messages.jsonl`: append-only normalized message records
- `alerts.jsonl`: append-only alert records with classification + notification outcomes
- `events.log`: append-only operational logs (polling, classification, sms/call attempts, call answered)

# 11) Provider Choices (Demo-Friendly)
## SMS + Voice
Recommendation: Twilio
- SMS API + Voice calls with answer status callbacks
- Audio playback from URL

Alternative: Plivo
- Similar capabilities; evaluate pricing/region availability

## Email Ingestion
Fastest demo path: IMAP polling on a mailbox
Recommendation: Gmail mailbox via IMAP (demo)
- Minimal setup compared to webhook-based inbound parsing
- Works well with 5-minute polling

If you want webhook-first instead (more “app-like”):
- SendGrid Inbound Parse / Mailgun Routes / Postmark Inbound require domain + DNS/MX setup.

# 12) Observability
- Event log is mandatory (append-only)
- Each alert record includes notification results:
  - sms_sent: true/false + provider id
  - call_attempts: list of attempts with status
  - answered_by: phone number (if answered)

# 13) MVP Acceptance Criteria
- System polls inbox every 5 minutes and ingests messages into `messages.jsonl`.
- Keywords trigger `emergency` classification.
- Gibberish triggers `unknown` classification.
- `unknown` is treated as `emergency`.
- Normal messages send exactly one SMS per contact.
- Emergency/unknown sends SMS + email + starts call escalation, and stops once any call is answered.
- Admin panel works on mobile and desktop, can edit contacts and keywords, and can view messages/alerts/logs.

# 14) Open Decisions (Need Your Confirmation)
- Which email mailbox provider will you use for the demo (Gmail/Outlook/other)?
- Do you want strict sender allowlist, or accept any sender for demo?
- Call escalation limits: max rounds / max duration / retry interval.

