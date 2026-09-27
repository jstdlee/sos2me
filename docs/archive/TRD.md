---
title: Emergency Notifier (Email/Web → SMS/Call)
doc_type: TRD
status: draft
owner: ""
created_at: 2026-05-30
---

# 1. System Overview
A VPS-hosted Python service with:
- Background poller(s) to ingest messages (email + ntfy required).
- A hybrid classifier (keywords + heuristics + AI when ambiguous).
- A notification engine (SMS, email, repeated voice calls until pickup).
- A responsive admin web UI for configuration and review.
- Text-file persistence for state, messages, alerts, and logs.

# 2. Constraints
- Single-tenant.
- Strict sender allowlist.
- Retry voice calls every 2 minutes until pickup.
- Pre-generated audio playback for voice calls.
- Text-file storage (json/jsonl/log/txt).
- Demo-friendly, minimal operational complexity.

# 3. Technology Choices (Recommended)
- Python 3.11+
- Web framework: Flask
- Templates: Jinja2 + simple CSS (responsive)
- Background scheduling:
  - simplest: a single long-running process with an internal loop (poll every 2 minutes)
  - alternatively: cron hitting an endpoint/CLI command
- Email ingestion: IMAP polling
- ntfy ingestion: HTTP polling (or SSE later)
- SMS + Voice: Twilio
- Email outbound (to parents): Gmail SMTP (app password)
- Email inbound: Gmail IMAP (app password)
- AI: OpenAI-compatible Chat Completions over OpenCode Go with model `deepseek-v4-pro`; failures fall back to keyword + unknown heuristics

# 4. High-Level Architecture
## 4.1 Modules
- `config/`
  - `config.json`: runtime config (contacts, allowlist, rules)
  - `.env`: credentials and connection settings via env vars
- `storage/` (text files)
  - `state.json`
  - `messages.jsonl`
  - `alerts.jsonl`
  - `events.log`
- `ingest/`
  - `email_imap.py`
  - `ntfy.py`
- `classify/`
  - `keywords.py`
  - `unknown_heuristics.py`
  - `ai_classifier.py`
  - `pipeline.py`
- `notify/`
  - `sms.py`
  - `email.py`
  - `voice.py`
  - `escalation.py`
- `web/`
  - routes + templates for admin UI
- `runner.py`
  - background loop orchestrator

## 4.2 Runtime Processes
Option A (smallest):
- One process runs:
  - Flask app (admin UI)
  - Background thread/task loop polling email + ntfy every 2 minutes

Option B (cleaner separation):
- One Flask app for admin UI
- One worker process for polling + escalation scheduling

# 5. Data Storage (Text Files)
## 5.1 state.json
Tracks last processed identifiers:
- `email_last_uid` or `email_last_seen_ts`
- `ntfy_last_event_id` or `ntfy_last_seen_ts`

## 5.2 messages.jsonl
Append-only JSON lines:
- `id`, `source`, `external_id`, `sender`, `subject`, `body`, `received_at`, `ingested_at`

## 5.3 alerts.jsonl
Append-only JSON lines:
- `id`, `message_id`, `classification`, `created_at`
- `sms`: recipients + provider ids
- `email`: recipients + provider ids
- `calls`: attempt list + statuses
- `answered_by` (if answered)

## 5.4 events.log
Append-only text log with structured-ish lines (timestamp, level, event_type, metadata).

# 6. Ingestion Design
## 6.1 Email (Gmail IMAP polling)
Behavior:
- Connect to Gmail IMAP using an app password.
- Search for messages newer than last seen (UID).
- For each message:
  - extract sender email address
  - enforce strict allowlist (exact match or domain match)
  - extract subject + body
  - normalize to internal schema
  - append to `messages.jsonl`
  - enqueue for classification

Edge handling:
- If IMAP connection fails: log + retry next cycle.
- Idempotency: external_id uses Message-ID (or UID fallback); internal id is derived from it.

## 6.2 ntfy.sh/qqq Channel
Behavior:
- Poll a configured ntfy topic (default server `https://ntfy.sh`) every 2 minutes.
- Fetch posts since the last seen event id/timestamp.
- Normalize each post into the internal message schema:
  - source = `ntfy`
  - external_id = event id
  - sender = topic name (or provided title if present)
  - subject/body = post title/body (as available)
- Deduplicate to prevent double alerts.

# 7. Classification Design
Classifier contract:
- Input: normalized message
- Output: `{ classification: normal|emergency|unknown, reasons: [...], confidence: 0..1 }`

Pipeline:
1. Keyword/code match:
   - configurable list
   - case-insensitive, supports phrase match
2. Unknown heuristics:
   - non-alnum ratio threshold
   - repeated pattern checks
   - max token length
   - word-like token ratio
3. AI classification:
   - runs only if steps 1–2 do not decide
   - response must be mapped to `normal|emergency|unknown`
   - if AI errors/timeouts: return `unknown` when ambiguous

Unknown → emergency policy:
- In notification policy, treat unknown as emergency for escalation.

# 8. Notification & Escalation Design
## 8.1 SMS
Normal:
- send once to all enabled parent numbers.

Emergency/Unknown:
- send immediately to all enabled parent numbers.

## 8.2 Email Outbound
Emergency/Unknown:
- send immediately to all configured parent emails with message summary and admin-panel link.

## 8.3 Voice Call Escalation
Provider: Twilio Voice

Call loop behavior:
- Call numbers in configured order.
- For each attempt:
  - place call
  - wait for terminal status (answered/no-answer/busy/failed)
  - if answered: stop and mark alert resolved
  - else: continue
- If nobody answered in a full round:
  - sleep 2 minutes
  - start next round

Implementation mechanics:
- Store `alert_id` as the escalation key.
- Persist call attempts into `alerts.jsonl` (or in-memory + append updates).
- Use provider callbacks (webhook) to update call status if available; otherwise poll provider API for call status.

Audio playback:
- Serve `emergency` and `unknown` audio files at stable URLs:
  - `/audio/emergency.mp3`
  - `/audio/unknown.mp3`
- On call answer, TwiML returns `<Play>` pointing to the appropriate URL.

Audio management:
- Admin updates audio via the Rules page upload form.
- Server writes uploaded files to disk and serves them through the stable URLs above.

Stop conditions:
- call answered by any contact
- admin manually stops escalation (admin UI button)

Recommended safety defaults (configurable):
- optional max duration (e.g., 12 hours) to prevent infinite loops due to misconfig

# 9. Admin Web UI (Routes)
Suggested routes:
- `GET /` landing
- `GET /intro` introduction
- `GET /admin/login` login
- `POST /admin/login`
- `POST /admin/logout`
- `GET /admin` dashboard
- `GET /admin/messages`
- `GET /admin/messages/<id>`
- `GET /admin/alerts`
- `GET /admin/alerts/<id>`
- `POST /admin/alerts/<id>/stop`
- `GET /admin/contacts`
- `POST /admin/contacts` create/update
- `GET /admin/allowlist`
- `POST /admin/allowlist` create/update
- `GET /admin/rules`
- `POST /admin/rules` update
- `GET /admin/logs`
- `POST /twilio/voice/status` provider callback

# 10. Configuration
## 10.1 Config fields (config.json)
- contacts:
  - phone_numbers: ordered list with enabled flags
  - emails: list with enabled flags
- allowlist:
  - exact_emails: list
  - domains: list (optional)
- sources:
  - ntfy:
    - base_url: string
    - topic: string
- audio:
  - emergency_file: string
  - unknown_file: string
- rules:
  - emergency_keywords: list
  - unknown_thresholds: object
- polling:
  - email_interval_seconds: 120
  - ntfy_interval_seconds: 120
- escalation:
  - retry_interval_seconds: 120
  - round_robin: true

## 10.2 Secrets (env vars)
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS`, `IMAP_SSL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_TLS`, `SMTP_FROM_EMAIL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `ADMIN_PASSWORD_HASH` (or similar)
- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`

# 11. Deployment on VPS
- Run behind a reverse proxy (nginx) to expose:
  - admin UI
  - audio URLs
  - provider callbacks
- Process manager:
  - systemd service for the Python app
- Logging:
  - stdout/stderr to journald + also append to `events.log`

# 12. Testing Plan (Demo)
- Simulate inbound email:
  - send allowlisted emergency keyword email and verify:
    - alert record created
    - SMS sent
    - email sent
    - voice calling loop starts and stops on answer
- Simulate inbound ntfy:
  - publish an emergency keyword post and verify end-to-end escalation
- Simulate unknown:
  - send gibberish email and verify unknown→emergency policy
- Simulate normal:
  - send normal email and verify only one SMS
- Admin panel:
  - update keywords and verify behavior changes next poll
  - verify audio URLs are reachable and used in voice calls

# 13. Evaluation Alignment (Guide Part 2 & 3)
- Part 2 (App/Web): responsive admin, end-to-end integration (ingest → classify → notify → review).
- Part 3 (Workflow): small modular architecture, repeatable config, logs/state files that make iteration fast.
