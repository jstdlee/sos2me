# Deploy to Cloudflare

SOS2me is a single Cloudflare Worker. It serves the Vue app and API, handles Twilio webhooks,
receives email, and runs the calling loop. Everything it uses fits in Cloudflare's **free plan**:

| Product                  | Used for                                      | Free allowance (at time of writing) |
| ------------------------ | --------------------------------------------- | ----------------------------------- |
| Workers                  | App + API                                     | 100k requests/day                   |
| D1                       | Settings, messages, activity                  | 5 GB                                |
| Durable Objects (SQLite) | One per alert, drives retries                 | Included on Free                    |
| Cron Triggers            | Mailbox/ntfy polling each minute, daily check | Included                            |
| Email Routing            | Child emails → Worker                         | Free, needs a domain on Cloudflare  |
| Workers AI (optional)    | AI classification                             | Daily free neurons                  |

## Prerequisites

- A Cloudflare account: <https://dash.cloudflare.com/sign-up>
- Node.js 22+ and pnpm (`corepack enable`)
- Optionally, a domain on Cloudflare. You only need one for the email channel or a custom URL.

## 1. Install and log in

```bash
pnpm install
pnpm wrangler login
```

## 2. Create the database

```bash
pnpm wrangler d1 create sos2me
```

Copy `wrangler.jsonc` to **`wrangler.local.jsonc`** (git-ignored) and put the printed `database_id` there.
Your own hostname, if you use one, also goes in that file. `wrangler.jsonc` stays a clean template for the public repo:

```bash
cp wrangler.jsonc wrangler.local.jsonc
```

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "sos2me", "database_id": "<paste here>", "migrations_dir": "migrations" }
]
```

Then create the tables:

```bash
pnpm db:migrate:remote   # uses wrangler.local.jsonc
```

## 3. Fill in `config.json`

```bash
cp config.example.json config.json
```

Every field is commented. At minimum set:

- `adminPassword`
- `childName`
- `contacts`
- the `twilio` block (see [twilio-setup.md](twilio-setup.md))

For alert emails and the daily check, also set `services.agentmailApiKey` + `agentmailFrom`.

`config.json` is git-ignored. `pnpm run deploy` copies it into your D1 database. After that,
edit settings in the dashboard: `config.json` is only re-applied when the file itself changes,
and then it overwrites the dashboard's settings (the kid page link is kept).

> Prefer Cloudflare secrets? `pnpm wrangler secret put TWILIO_AUTH_TOKEN` (and `ADMIN_PASSWORD`,
> `TWILIO_ACCOUNT_SID`, `TWILIO_FROM_NUMBER`) still work as fallbacks when the dashboard fields are empty.

## 4. Deploy

```bash
pnpm run deploy
```

This builds the app, applies database migrations, applies `config.json` (if changed) and deploys.

> Use `pnpm run deploy`, not `pnpm deploy`: the latter is a built-in pnpm command.

Wrangler prints your URL, e.g. `https://sos.<your-subdomain>.workers.dev`. The Worker is named `sos`:

- **Kid page:** `https://sos.<your-subdomain>.workers.dev/`
- **Dashboard:** `https://sos.<your-subdomain>.workers.dev/admin`

No DNS changes are needed.

## 5. First login

1. Open the URL and log in with your `adminPassword`. This also records the public address that
   Twilio will call back to. Check it under **Settings → Connections**.
2. Work through the **Finish setting up** checklist on the home page:
   - child's name
   - parent numbers
   - press **Test call**
3. Copy the **kid page link** and open it on your child's phone. Then add it to the home screen:
   - **iPhone:** Share → Add to Home Screen.
   - **Android:** ⋮ → Add to Home screen.

## 6. (Optional) Mailboxes: AgentMail or Gmail

No domain needed. In **Settings → Kid channels → Mailboxes** (or `channels.mailboxes` in `config.json`):

- **AgentMail:** create an inbox at [agentmail.to](https://agentmail.to), e.g. `sos-alex@agentmail.to`,
  and give your child that address. Put the API key under Connections.
- **Gmail / Outlook / iCloud (IMAP):**
  1. Turn on 2-step verification and create an **app password**.
  2. Make sure IMAP is enabled in the mail account.
  3. Enter host, user and app password.

  SOS2me opens the mailbox read-only (`EXAMINE`), so it never marks your mail as read.

Only senders listed in **Accept email only from** are processed.

## 7. (Optional) Email Routing channel

Your domain must use Cloudflare DNS.

1. Dashboard → your domain → **Email → Email Routing → Enable**. Accept the DNS records it adds.
2. **Routing rules → Create address**, e.g. `sos@your-domain.com`.
   - **Action:** _Send to a Worker_
   - **Destination:** `sos2me`
3. In SOS2me → **Settings → Kid channels**, turn on **Cloudflare Email Routing** and add your child's
   address to **Accept email only from**.
4. Save `sos@your-domain.com` as a contact on your child's phone.

To keep a copy of every email, enter a parent's address in _Also forward every email to_. That
address must first be added and verified under **Email Routing → Destination addresses**.

## 8. Your own address (e.g. `sos.example.com`)

Optional: the workers.dev address above works on its own. To use your own hostname as well,
uncomment this in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "sos.example.com", "custom_domain": true }],
```

With this, the kid page is at `https://sos.example.com/` (turn on **Settings → Kid channels → Kid page at the
main address** and set a PIN) and the dashboard at `https://sos.example.com/admin`. Change the hostname for your own domain.

A custom domain only works if two things are true:

- **The zone is on the same Cloudflare account** as the Worker.
- **The hostname has no DNS record yet.** If something already runs there, move it first.

### Moving an existing site from `sos.example.com` to `relay.example.com`

1. Find out what serves it now: Cloudflare dashboard → `example.com` → **DNS → Records**, look at `sos`.
   - **A / AAAA / CNAME record** pointing at a server: create the same record for `relay`, pointing at the
     same target and proxied. On that server, add `relay.example.com` to the site's config (nginx
     `server_name`, Caddy host, etc.) and reload it.
   - **Worker or Pages custom domain** (Workers & Pages → that project → Settings → Domains): add
     `relay.example.com` as a custom domain there.
2. Check that `https://relay.example.com` works.
3. Delete the old `sos` record, or remove `sos.example.com` from that project's custom domains.
4. Run `pnpm run deploy`. Wrangler attaches `sos.example.com` to SOS2me and creates its DNS record and certificate.
5. Open `https://sos.example.com/admin` once, and check **Settings → Connections → Public address**.

## 9. Workers AI

Works out of the box once deployed: the `AI` binding is in `wrangler.jsonc`, and the default model chain
starts with Cloudflare models (Settings → Urgent words & AI). For local development, put a Cloudflare
account ID and an API token with _Workers AI_ permission in `services.cloudflareAccountId` /
`cloudflareApiToken`; the Worker then calls Workers AI over REST.

## Where your settings live (and how edits flow back)

|                                 | Local (`pnpm dev`)               | Online (deployed)                                    |
| ------------------------------- | -------------------------------- | ---------------------------------------------------- |
| Stored in                       | local D1 file under `.wrangler/` | Cloudflare D1 (encrypted at rest)                    |
| Seeded from                     | `config.json` (git-ignored)      | `config.json`, via `pnpm run deploy`                 |
| Dashboard edits → `config.json` | automatic while `pnpm dev` runs  | `pnpm config:pull:remote`                            |
| Protection                      | —                                | deploy refuses to overwrite unpulled dashboard edits |

Nothing from `config.json` is compiled into the Worker bundle or committed to git.

**Why D1 and not Worker secrets for online edits:**

- A running Worker can't change its own secrets. To do so it would need a Cloudflare API token that
  can also **replace the Worker's code**, so a compromised dashboard could take over the whole app.
- Secrets are also limited to 5 KB each, and changing one redeploys the Worker.

D1 is private to your account and is what the Worker reads anyway. The environment secrets
(`TWILIO_AUTH_TOKEN`, `ADMIN_PASSWORD`, …) still work as fallbacks if you prefer to set them by hand.

## Updating

```bash
git pull
pnpm install
pnpm db:migrate:remote   # safe to run every time; applies only new migrations
pnpm run deploy
```

### Auto-deploy from GitHub (optional)

Workers & Pages → `sos2me` → **Settings → Build → Connect** your GitHub repo:

- **Build command:** `pnpm install && pnpm run build`
- **Deploy command:** `pnpm wrangler deploy`

Secrets stay in Cloudflare and are never read from the repo.

## Logs

- **Inside the app:** the **Activity** page.
- **Live Worker logs:**

  ```bash
  pnpm wrangler tail
  ```

- **Stored logs:** Workers & Pages → `sos2me` → **Observability**.

## Is the public repo safe?

Yes, as long as secrets stay out of git:

- `config.json`, `config.legacy.json`, `.dev.vars` and `.env*` are in `.gitignore`.
- Phone numbers and other family settings live in D1, not in the repo.
- The `database_id` in `wrangler.jsonc` is not a secret: nobody can use it without your
  Cloudflare credentials.
