# Set up Twilio (phone calls + SMS)

SOS2me uses Twilio to phone parents, read the child's message aloud, and send SMS.
Setup takes about 15 minutes.

## 1. Create an account

1. Sign up at <https://www.twilio.com/try-twilio>.
2. Verify your email address and your own mobile number.

**Trial accounts** work for testing, with three limits:

- Calls and SMS can only go to **verified numbers**. Add each parent under
  _Phone Numbers → Manage → Verified Caller IDs_.
- Every call starts with a short Twilio trial announcement and asks you to press a key before
  SOS2me speaks.
- SMS messages are prefixed with "Sent from your Twilio trial account".

For real family use, **upgrade** (add a card under _Admin → Billing_). You only pay for usage:
roughly one to a few dollars a month for the number, plus a few cents per call or SMS. Check
[Twilio pricing](https://www.twilio.com/en-us/pricing) for your country.

## 2. Get a phone number

_Phone Numbers → Manage → Buy a number._ Pick a number with **Voice** capability, and **SMS**
if you want text messages too.

- A local number in your country is best, because parents recognise it and it's cheaper.
- If Twilio doesn't sell local numbers where you live (some countries require a regulatory
  bundle), a US number can still call abroad. See step 3.
- **Save the number as a contact** on each parent's phone (e.g. "SOS2me – Alex"). Name it in a
  way that you would never ignore, and let it bypass Do Not Disturb:
  - **iPhone:** Settings → Focus → Do Not Disturb → People → add it.
  - **Android:** Contact → Settings → set it as a starred / priority contact.

## 3. Allow calls to your parents' country

Twilio blocks international calls by default.

1. _Voice → Settings → Geo permissions_: tick the country of every parent's phone (e.g.
   Singapore, China).
2. If you use SMS: _Messaging → Settings → Geo permissions_: tick the same countries.

## 4. Copy your credentials

On the Twilio Console home page, find **Account Info**:

| Twilio field                      | Secret name          |
| --------------------------------- | -------------------- |
| Account SID (starts with `AC`)    | `TWILIO_ACCOUNT_SID` |
| Auth Token                        | `TWILIO_AUTH_TOKEN`  |
| Your Twilio number, in `+` format | `TWILIO_FROM_NUMBER` |

> **Why the Auth Token and not only an API key?** SOS2me uses the Auth Token to check that
> webhook requests ("the call ended", "someone pressed 1") really come from Twilio. Without it,
> anyone who knew your URL could fake a "confirmed" and stop the calls.
>
> You can also set `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` (_Admin → API keys_). They are
> then used for the REST calls, and the Auth Token is only used to verify webhooks.

### Where to put them

Either of these works, and they end up in the same place (your private D1 database):

- **In the dashboard:** Settings → **Connections** → Twilio. Secret fields are write-only: they
  show `••••••••` once saved, and typing replaces the value.
- **In `config.json`** (git-ignored), applied by `pnpm dev` / `pnpm run deploy`:

  ```jsonc
  "twilio": {
    "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "authToken": "your LIVE auth token",
    "fromNumber": "+15550001111",
  },
  ```

> **Test vs Live credentials:** the Console also shows _Test Credentials_. Those only work with
> Twilio's magic test numbers and **cannot place real calls**; SOS2me reports them as
> "Test Account Credentials" in the daily check. Use the **Live** Account SID and Auth Token.

## 5. Nothing to configure on the Twilio number

You **don't** need to set a webhook on the Twilio number. SOS2me places outgoing calls through the API
and passes its own callback URLs on each call, e.g. `https://sos2me.example.workers.dev/twilio/voice`.

It only needs to know its own public `https://` address. It learns this automatically the first
time you open the dashboard on that address. To pin it explicitly, fill in **Settings → Connections →
Public address** (or `publicBaseUrl` in `config.json`).

## 6. Test it

1. Open the dashboard and go to **Settings → Family**. Add a parent in international format
   (e.g. `+6581234567`), then press **Save**.
2. Press **Test call** next to that parent. Your phone should ring within a few seconds. You'll
   hear the test message, then "Press 1 to confirm".
3. Press 1. The message page should change to **Confirmed**.
4. Try a full run with **Settings → Urgent words → Try it → Send as a real test**.

## Choosing the voice

Under **Settings → Voice**, pick the language the call should speak. You can optionally enter a
specific Twilio voice for a more natural sound:

| Language     | Example voice                                    |
| ------------ | ------------------------------------------------ |
| English (US) | `Polly.Joanna-Neural`, `Google.en-US-Neural2-F`  |
| English (UK) | `Polly.Amy-Neural`                               |
| Mandarin     | `Polly.Zhiyu-Neural`, `Google.cmn-CN-Standard-A` |
| Cantonese    | `Google.yue-HK-Standard-A`                       |

See Twilio's [full voice list](https://www.twilio.com/docs/voice/twiml/say/text-speech#available-voices-and-languages).
Neural voices cost slightly more per character.

## Troubleshooting

Check **Activity** in the dashboard first. Every call attempt and error is logged there.

| Symptom                                                       | Likely cause                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Twilio 401`                                                  | Wrong SID or token, or a trailing space when pasting. Re-enter it in Settings → Connections.                                                |
| `Twilio 400: ... not a valid phone number` / `... unverified` | The number isn't in `+` format, or the account is on trial and the number isn't verified.                                                   |
| `Twilio 403 ... geo permissions`                              | Enable the parent's country (step 3).                                                                                                       |
| Phone rings but the call hangs up immediately                 | Twilio can't reach `/twilio/voice`. Check the public address in **Settings → Connections**.                                                 |
| Calls continue after pressing 1                               | Webhooks are being rejected. Check that `TWILIO_AUTH_TOKEN` matches the account that owns `TWILIO_FROM_NUMBER`.                             |
| Call never happens, activity shows `call_timeout`             | Twilio never reported the call status. Check [Twilio Monitor → Logs → Errors](https://console.twilio.com/us1/monitor/logs/debugger/errors). |
| Daily check says "Test Account Credentials"                   | You entered the Test SID/token. Use the Live ones (Console → Account → API keys & tokens).                                                  |
