---
title: Emergency Notifier (Email/Web → SMS/Call)
doc_type: PRD
status: draft
owner: ""
created_at: 2026-05-30
---

# 1. Overview
Emergency Notifier is a single-tenant VPS-hosted service that monitors a child’s inbound communications (email + ntfy.sh/qqq Channel) and escalates to parents via SMS, email, and automated voice calls.

Core promise: if the child’s message looks like an emergency (or is unclear/unknown), the system will keep calling every 2 minutes until a parent picks up.

# 2. Problem Statement
In some situations a child cannot place a phone call, but can still send an email or post a short message on a web channel. Parents need a reliable way to be notified and reached immediately when those messages indicate an emergency or when the message is abnormal/unclear enough to be treated as an emergency.

# 3. Target Users
- Parent/guardian (receiver): wants immediate, persistent escalation for emergencies.
- Child/sender: can only send email or web message; cannot reliably call.

# 4. Goals
- Detect emergency/unknown messages from a strict allowlist of senders.
- For emergency/unknown: send SMS + email immediately and keep calling every 2 minutes until pickup.
- For normal: send SMS once.
- Provide a responsive web admin panel for managing parents, allowlist senders, rules, and reviewing message/alert history.
- Keep the implementation small, demo-ready, and VPS-friendly (text-file storage, minimal moving parts).

# 5. Non-Goals
- Multi-tenant SaaS, sign-up, billing, team workspaces.
- Complex privacy features, encryption, compliance workflows.
- Sophisticated NLP training pipelines.

# 6. Scope
## 6.1 In-Scope (MVP)
- Email ingestion (required).
- Strict sender allowlist (required).
- ntfy.sh/qqq channel, configurable (required).
- Hybrid classifier:
  - Keyword/code matching
  - Unknown/gibberish detection (heuristics)
  - AI classification (required, used when ambiguous)
- Notifications:
  - SMS
  - Email notification
  - Voice call escalation with pre-generated audio playback
- Admin panel (responsive):
  - Contacts (parents), call order
  - Allowlist senders
  - Keyword/code list
  - Unknown detection thresholds
  - View messages, alerts, logs
- Observability:
  - Append-only event log and alert history

## 6.2 Out-of-Scope (MVP)
- Push notifications
- Mobile app
- Real-time email via push/IDLE requirements (polling is sufficient for demo)
- Advanced email authenticity checks (SPF/DKIM/DMARC verification)

# 7. User Experience
## 7.1 User Journeys
### Journey A: Emergency email triggers escalation
1. Child sends email to the monitored mailbox.
2. System polls and ingests it.
3. System classifies as `emergency` or `unknown`.
4. Parents receive:
   - Immediate SMS
   - Immediate email summary
   - Repeated calls every 2 minutes until pickup
5. Admin panel shows the message, classification, and call attempts.

### Journey B: Normal email triggers SMS only
1. Child sends an email that is not emergency/unknown.
2. System classifies as `normal`.
3. Parents receive one SMS and no calls.
4. Admin panel shows the message and classification.

## 7.2 Admin Panel Pages
- Landing / Intro (public): explain what it is, how it works, demo-safe CTA (no registration).
- Admin Login (single account).
- Dashboard: current status, last alerts.
- Messages: list + details (raw content + normalized view).
- Alerts: list + details (classification + notification outcomes).
- Contacts: phone numbers + email addresses + call order.
- Allowlist: allowed sender addresses and/or domains.
- Rules:
  - emergency keywords/codes list (predefined as much as possible)
  - unknown thresholds
  - announcement audio files (emergency/unknown)
- Logs: event log viewer.

# 8. Functional Requirements
## 8.1 Ingestion
- FR-ING-1: Poll the mailbox every 2 minutes and ingest new messages.
- FR-ING-2: Only accept emails from allowlisted senders (strict mode).
- FR-ING-3: Normalize messages into a single internal schema (source, sender, subject, body, received_at, external_id).
- FR-ING-4: Deduplicate by external message id (or a stable hash) to prevent double alerts.
- FR-ING-5: Poll ntfy.sh/qqq channel every 2 minutes and ingest new posts.

## 8.2 Classification
- FR-CLS-1: Classify each message as one of:
  - `normal`
  - `emergency`
  - `unknown`
- FR-CLS-2: If message matches configured emergency keywords/codes, return `emergency`.
- FR-CLS-3: If message is detected as gibberish/unknown by heuristics, return `unknown`.
- FR-CLS-4: If not matched by FR-CLS-2/3 and AI is enabled, call AI to classify.
- FR-CLS-4: If not matched by FR-CLS-2/3, call AI to classify.
- FR-CLS-5: AI must be conservative: if uncertain, output `unknown`.
- FR-CLS-6: Any `unknown` is treated as `emergency` for escalation policy.

## 8.3 Notification Policy
- FR-NOT-1: For `normal`, send one SMS to all active parent contacts.
- FR-NOT-2: For `emergency` or `unknown`, send:
  - SMS to all active parent contacts
  - Email to all active parent email addresses
  - Voice call escalation until pickup
- FR-NOT-3: Voice calls retry every 2 minutes after a failed attempt.
- FR-NOT-4: Stop all further calls immediately once any call is answered.
- FR-NOT-5: Play pre-generated audio based on status (`emergency` vs `unknown`).

## 8.4 Admin Panel
- FR-ADM-1: Admin can manage parent contacts: phone numbers + emails + call order + enabled flag.
- FR-ADM-2: Admin can manage allowlist senders.
- FR-ADM-3: Admin can edit emergency keywords/codes.
- FR-ADM-4: Admin can enable/disable AI classifier and configure the AI prompt parameters (within safe bounds).
- FR-ADM-5: Admin can upload/replace announcement audio files and verify they are reachable for playback.
- FR-ADM-6: Admin can review messages, alerts, and call/SMS/email outcomes.

## 8.5 Logging
- FR-LOG-1: Append operational events (poll runs, ingested count, classification decisions, notification attempts, provider callbacks) to a text log.
- FR-LOG-2: Persist a minimal alert record per classified message including notification outcomes.

# 9. Non-Functional Requirements
- NFR-1: Runs on a single VPS with Python.
- NFR-2: Admin panel must be responsive on mobile and desktop.
- NFR-3: The system must continue operating if AI classification is unavailable (fallback to keywords + unknown heuristics).
- NFR-4: Notification actions should be idempotent per message to prevent duplicate call storms.

# 10. Data Model (Conceptual)
## 10.1 Message
- id (internal)
- source (`email` | `ntfy`)
- external_id (email message-id or ntfy message id)
- sender
- subject
- body
- received_at
- ingested_at

## 10.2 Alert
- id (internal)
- message_id
- classification (`normal` | `emergency` | `unknown`)
- created_at
- sms_sent_to: list
- email_sent_to: list
- call_attempts: list (number, attempt_at, status)
- answered_by: number (optional)
- resolved_at (optional)

# 11. Provider Choices (Demo)
## 11.1 SMS + Voice
Recommendation: Twilio (SMS + Voice + status callbacks + play audio by URL).

## 11.2 Email Outbound
Use Gmail SMTP for sending notification emails to parents (app password in `.env`).

## 11.3 Email Inbound
Use Gmail IMAP for mailbox polling.

## 11.4 AI Provider
Use OpenAI-compatible Chat Completions over OpenCode Go with model `deepseek-v4-pro`.

## 11.5 Configuration Location
- IMAP settings, SMTP settings, AI API key, and provider credentials live in a `.env` file on the VPS.

# 12. Acceptance Criteria
- AC-1: With a message from an allowlisted sender containing an emergency keyword, the system triggers SMS + email + call escalation with 2-minute retries until pickup.
- AC-2: With gibberish input from allowlisted sender, the system classifies `unknown` and behaves as emergency.
- AC-3: With normal content from allowlisted sender, the system sends one SMS only.
- AC-4: Admin can update contacts, allowlist, keywords, and audio files through a responsive UI.
- AC-5: Messages, alerts, and event logs are viewable in the admin panel.

# 13. Evaluation Alignment (Guide Part 2 & 3)
This PRD intentionally excludes “Part 1” and focuses on:
- Part 2: App/Web completeness, UX, and integration (working demo, clear flow, responsive admin, practical notification functionality).
- Part 3: Workflow depth and efficiency (repeatable setup, clear operational flow, logs/state files, straightforward iteration on rules and thresholds).
