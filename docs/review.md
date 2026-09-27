# Code review and design notes (v1 Python → v2 Cloudflare)

The goal is simple: **a parent hears the child's latest message on a phone call, and urgent
messages don't get missed.** This document reviews the original Python/Flask version against
that goal and explains what v2 changes. The v1 code is preserved in the first git commit.

## What v1 got wrong, by impact

### Could miss a real emergency

| #   | Issue                                                                                                                                                                                    | v2 fix                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Voicemail counted as "answered".** A call with `status=completed` and `duration>0` stopped the escalation. If the call went to voicemail, the loop ended and nobody heard the message. | For urgent messages the call only counts when someone **presses 1** (`<Gather>`). Voicemail can't press 1.                                                                                      |
| 2   | **The call never said what the child wrote.** It played a fixed MP3 or "Emergency alert, check the latest message". A parent driving can't check a dashboard.                            | The call **reads the message aloud** in your chosen language and voice. Press 2 to repeat it.                                                                                                   |
| 3   | **Everyday messages were SMS-only.** The product's purpose is "let parents know via phone call", but normal messages only sent an SMS.                                                   | Each level (urgent / everyday) has its own policy: call, SMS, rounds, retry interval, and whether pressing 1 is required. By default everyday messages get **one call** that reads the message. |
| 4   | **Escalation lived in a Python thread.** A VPS restart or crash mid-escalation silently dropped it.                                                                                      | Each alert is a **Durable Object with alarms**. It survives deploys and restarts, and a watchdog alarm moves on if Twilio never reports back.                                                   |
| 5   | **`retry_interval_seconds` was ignored** (`run.py` hard-coded 120) and **there was no retry limit**. The loop could run forever.                                                         | Rounds and wait time are editable in the GUI, clamped to 1–20 rounds and 1–60 min. After the last round the alert is marked **No one confirmed**, and the home page shows **Needs attention**.  |

### False alarms (which make parents ignore the calls)

| #   | Issue                                                                                                                                                                   | v2 fix                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | **Any message under 10 characters was "unknown", which v1 treated as an emergency.** "ok", "omw" and "home!" all triggered SMS, email and endless calls.                | Short messages are normal. The gibberish check only fires on strong signals: mostly symbols, 8+ repeated characters, or a long Latin "word" with almost no vowels. |
| 7   | **Chinese (and other non-Latin) messages were always "unknown".** The word check used `[A-Za-z]{2,}`, so "我到家了" scored 0% word-like.                                | The checks are Unicode-aware, and non-Latin text is never flagged as gibberish. Chinese urgent words (救命, 紧急) are included by default.                         |
| 8   | **Keywords matched inside words**: "help" fired on "helpful", "sos" on "sosig".                                                                                         | ASCII keywords match whole words but tolerate a stretched last letter ("helppp"). CJK keywords match as substrings.                                                |
| 9   | **The AI was called for every message that wasn't a keyword**, so it ran on every "ok", adding cost and latency. On error it returned "unknown", which meant emergency. | AI is optional and off by default. When the AI fails, the fallback is keywords plus gibberish detection, and neither needs the network.                            |

### Security (the repo is public)

| #   | Issue                                                                                                                                        | v2 fix                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **`config.json` with real phone numbers and emails was in the project root**, one `git add` away from being public.                          | `config.json` is git-ignored and was never committed. All family data now lives in D1.                                                                    |
| 11  | **Twilio webhooks were not verified.** Anyone could `POST /twilio/voice/status` to mark an alert answered and silence the calls.             | `X-Twilio-Signature` is checked with HMAC-SHA1 on every webhook (`worker/twilio.ts`, with tests).                                                         |
| 12  | **A public ntfy topic was the main web channel.** Anyone who guesses the topic can trigger calls or read the child's messages.               | The new **kid page** uses a secret 24-character link that can be rotated from the GUI. ntfy is still supported, off by default, with optional token auth. |
| 13  | The admin password was compared with `==`, the Flask secret was random per restart (logging everyone out), and there was no CSRF protection. | Timing-safe comparison, HMAC-signed 30-day cookie, `SameSite=Strict`, mutating calls must be JSON, and a small delay on a wrong password.                 |
| 14  | The email allowlist trusts the `From` header, which can be spoofed.                                                                          | Still a limitation. Cloudflare Email Routing applies some sender checks, but see suggestion 6 below.                                                      |

### Maintainability

- Dead code was removed: the Outlook Graph/MSAL path (never configured in `.env.example`),
  the `test_resend` stub, and the `skills-lock.json` for an unrelated video tool.
- The config was split between `.env`, `config.json` and hard-coded values. It is now in two
  places: **secrets** (Cloudflare secrets) and **everything else** (one JSON document in D1,
  edited in the GUI, merged with defaults on load so new fields appear automatically).
- Append-only JSONL files that were re-read in full on every page load are now indexed D1 tables.

## Architecture (v2)

```
Kid page ─┐                                         ┌─► SMS to every enabled parent (parallel)
Email  ───┼─► handleIncoming ─► classify ─► D1 row ─┤
ntfy ─────┘   (dedupe by id)   urgent/normal         └─► Escalation DO (one per alert)
                                                           │ call parent[i]
                                                           │   ├─ status callback: busy/no-answer → next parent
                                                           │   ├─ keypad "1" → confirmed, stop
                                                           │   └─ watchdog alarm (3 min) → next parent
                                                           │ end of list → wait N min → next round
                                                           └ after last round → "No one confirmed"
```

Files to read first: `worker/pipeline.ts` (policy), `worker/escalation.ts` (calling loop), `worker/classify.ts`.

## Why Cloudflare + Vite+ + Vue

- **Cheaper and less to run.** No VPS to patch, no systemd, no nginx/TLS. Everything is on the free tier.
- **Durable Objects fit escalation well:** they give durable per-alert state, alarms instead of
  sleeping threads, and serialized handling of Twilio callbacks.
- **Email Routing replaces IMAP polling.** Email arrives in about a second instead of up to 2
  minutes, and there's no Gmail app password to leak.
- **Vite+** (`vp`) wraps Vite, Vitest, Oxlint and Oxfmt in one tool. It is in beta (1.0 RC at
  the time of writing), so the project pins exact versions. If it causes trouble, swap
  `vite-plus` for plain `vite` + `vitest`; the config is standard.
- **Tailwind CSS v4** with a small token set (`src/style.css`) instead of a component
  framework. The UI is simple, and this keeps the bundle small and the look calm.

## Further suggestions (not implemented yet)

In rough priority order for family use:

1. **Share location with SOS.** The kid page could attach `navigator.geolocation` to the SOS
   message: a map link in the SMS, and a spoken "location sent by text" on the call.
2. **Daily heartbeat.** A cron job could text parents once a week, "SOS2me is working. Last
   message: 3 days ago", so a broken Twilio card or expired secret gets noticed before an emergency.
3. **"Call both at once" for urgent messages.** Ring every parent simultaneously and hang up
   the others when one confirms. This is faster, costs more, and the current code already hangs up the active call.
4. **Tell the child it was heard.** Show "Mum confirmed ✓" on the kid page by polling message status.
5. **Quiet hours for everyday messages**, e.g. 23:00–07:00: send an SMS only, while urgent messages still call.
6. **Stricter email authentication.** Parse the `Authentication-Results` header and reject
   anything without `dmarc=pass`.
7. **Cheaper channels.** Telegram or WhatsApp bots for everyday messages, keeping phone calls
   for urgent ones.
8. **Audit alerts.** If an urgent alert ends as "No one confirmed", text a backup contact (grandparent, neighbour).

---

## Round 2 (2026-09-27): configuration, AI, mailboxes, health check

### AI prompt evaluation

The prompt in `worker/classify.ts` (`SYSTEM_PROMPT`) was tuned against 16 realistic messages:

- **Everyday:** "can u pick me up at 5", "this homework is killing me lol", "lol help me with maths", "I got 95!!", "ok".
- **Urgent:** being followed; indirect suicidal thoughts; "mum can u come now. please"; injury; online grooming;
  lost in a mall (Chinese); a prompt-injection attempt "ignore previous instructions… im locked in a car".
- **Check in:** excluded at lunch; bullied (Chinese); feeling sick; publicly scolded (Singlish).

| Model                                      | Correct   | Avg latency | Notes                                       |
| ------------------------------------------ | --------- | ----------- | ------------------------------------------- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | **16/16** | 1.7 s       | default main model                          |
| `@cf/aisingapore/gemma-sea-lion-v4-27b-it` | **16/16** | 1.4 s       | strong on Singlish/Chinese, default backup  |
| `@cf/openai/gpt-oss-120b`                  | 13/16     | 3.7 s       | twice returned no JSON; not in the defaults |
| OpenRouter `openrouter/free`               | works     | ~2–4 s      | picks any free model; availability varies   |

Design decisions:

- **Three levels, not two.** "Concern" (sad, bullied, unwell) gets a gentle call plus SMS by default, instead
  of a five-round alarm or nothing.
- **Keywords still force "urgent", but the AI may soften an obvious joke to "concern" — never lower.**
  Example: "lol help me with maths" becomes check-in, and parents still hear it.
- **The AI's one-line note** ("Alex feels threatened by a follower") is shown in the dashboard,
  added to SMS and email, and optionally read on the call.
- **The child's text is wrapped in `<message>` tags** and the model is told to treat it as data.
  The injection test above passed on both Cloudflare models.

### OpenRouter free models

Free endpoints can be **blocked by your OpenRouter privacy settings** (the allowed-providers list and the
"free endpoints may log/train on prompts" policy), and individual free models are often rate-limited (HTTP 429).
`openrouter/free` routes to whichever free model is available.

Enabling them is a privacy decision, because a child's messages could be used for training. The
chain therefore starts with Cloudflare models, and the daily check reports each OpenRouter model
separately.

### AgentMail

- **Polling:** every minute via `GET /v0/inboxes/{inbox}/messages?after=…`. The API's
  `labels=received` filter returned nothing in testing, so incoming mail is filtered by label in code
  (`received` and not `sent`).
- **Message body:** `extracted_text` is used, which is the new text without quoted replies.
- **Sending:** alert and daily-check emails go out through `POST …/messages/send`.
- **Not yet verified end to end:** reading a real incoming email from an allowed sender. See the to-do list.

### Security notes

- **Public ntfy topics** (e.g. `ntfy.sh/999`) can be read and posted to by anyone who guesses the name,
  and every post can trigger calls. Use a long random topic, or a protected server with a token.
- **Credentials** belong only in the git-ignored `config.json` (or Cloudflare secrets), never in chat
  logs, issues or commits. Rotate any key that was shared in plain text.
- **Twilio Test credentials** only work with magic test numbers; real calls need the Live account SID
  and an API key or Live Auth Token.
- **Password and PIN hashing.** The dashboard password and kid PIN are hashed with a salt derived
  from the value itself. This is deliberate: re-applying `config.json` then doesn't sign everyone out.
  A 4-digit PIN can't be protected by salting anyway; the real protections are that D1 is private and
  guesses are rate-limited.
- **Rotating the kid link** or changing the PIN signs out every kid device.

---

## Round 3 (2026-09-27): emails about the child, Twilio API key, settings layout

- **Emails from other senders.** They are processed when they clearly mention a watched name
  (whole word; "Alexandra" doesn't match "Alex").
  - The AI is told the email is _about_ the child, not _from_ the child.
  - Key-mashing detection is skipped, since other people's typing tells you nothing about your child.
  - An urgent keyword alone isn't enough ("help needed for the school fair"): the AI must agree.
  - Only urgent or check-in results notify parents; everyday mail is recorded quietly.
  - Tested: teacher reports an injury → check in; extortion threat → urgent; newsletter → recorded only;
    an unrelated sender → ignored.
- **Twilio API keys** can't read the Account resource (error 70004). The daily check now uses Balance
  and verifies that the "from" number belongs to the account. If an API key is set, it also checks
  that the Auth Token belongs to the same account: a Test token would reject every callback, so
  calls could never be confirmed.
- **OpenRouter keys** pasted without the `sk-or-v1-` prefix are fixed up automatically.
- **Stable list IDs.** Mailbox, ntfy, model and contact entries seeded from `config.json` get stable
  IDs on first load, so write-only secrets in those entries survive dashboard saves.
- **ntfy** supports a username + password (Basic auth) as well as access tokens.
