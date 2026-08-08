# What Did I Miss — Build Contracts

**This file is the source of truth for every interface shape in the codebase.** Every Devin
session and every human works to these contracts. Shapes below are frozen — do not renegotiate
them mid-build. If something is ambiguous, pick the simplest reading and keep moving.

> This document was the repo `README.md` during the build — wherever a `devin-prompts/*.md`
> file says "Read `README.md`, it is the frozen contract", it means this file. The root
> `README.md` is now the project readme; the engineering rationale is in `TECH-SPEC.md`.

## What we're building (one paragraph)

A Telegram group bot ingests every message into SQLite. A member who's been away sends
`/catchup` and gets a link to a web page hosting an ElevenLabs voice agent that already
knows what they missed (the transcript is handed to it at session start). Mid-conversation the
agent can search the chat, quote exact messages, verify claims against live public web
pages via Context.dev, and dispatch actionable dev work to Devin — posting a confirmation
back into the Telegram group.

## Stack (fixed)

- Node 20 + TypeScript, [Hono](https://hono.dev) web framework
- `better-sqlite3` for storage (single file `data.db`, no ORM)
- ElevenLabs Agents platform (agent lives in their dashboard; we host tool webhooks + the session page)
- No second LLM: the agent summarizes the missed messages itself. We ship it the raw transcript.
- Deploy: the Lead's laptop + a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:3000`); `npm start` runs `tsx src/index.ts`. No paid hosting.
- No other runtime dependencies without a very good reason. No test framework — curl smokes only.

## Repo layout & file ownership

```
src/
  index.ts        # Hono app, route mounting, auth middleware   [Session 0]
  db.ts           # SQLite init + schema + typed helpers        [Session 0]
  telegram.ts     # webhook handler, /catchup command           [Session 0]
  init.ts         # POST /api/conversation-init                 [Session 1]
  tools/
    chat.ts       # search_chat, get_messages                   [Session 2]
    verify.ts     # verify_information (Context.dev)            [Session 3]
    devin.ts      # dispatch_to_devin, check_devin_sessions,
                  # mark_caught_up                              [Session 4]
public/
  session.html    # voice page (ElevenLabs JS SDK)              [Session 1]
scripts/
  set-app-url.ts  # re-point Telegram + ElevenLabs at APP_URL   [Session 5]
seed.ts           # transcript.json -> DB                       [Session 0]
transcript.json   # authored by demo owner (human)              [human]
.env.example      # every env var, commented, no values         [Session 5]
```

**Devin sessions: only touch the files tagged with your session number.** Open a PR from
branch `devin/session-<n>`; never push to main.

## Environment variables (exact names)

Copy `.env.example` to `.env` and fill it in — `npm start`, `npm run seed`, and
`npm run set-app-url` load it via `--env-file-if-exists`. `.env` lives only on the
Lead's machine; there is no hosted environment.

```
TELEGRAM_TOKEN            # from BotFather
TELEGRAM_WEBHOOK_SECRET   # random string; set via setWebhook secret_token
TELEGRAM_CHAT_ID          # the demo group's chat id
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
CONTEXT_DEV_KEY
DEVIN_API_KEY
TOOL_SECRET               # shared secret for /tools/* auth
SESSION_JWT_SECRET        # signs /catchup links
APP_URL                   # public tunnel URL (https://….trycloudflare.com), no trailing slash
```

## Database schema (db.ts creates on boot)

```sql
CREATE TABLE IF NOT EXISTS messages (
  chat_id    TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender     TEXT NOT NULL,
  text       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,          -- unix seconds
  PRIMARY KEY (chat_id, message_id)     -- idempotent ingest
);
CREATE TABLE IF NOT EXISTS user_markers (
  user_id      TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  caught_up_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devin_sessions (
  devin_session_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  url        TEXT,
  created_at INTEGER NOT NULL
);
```

Normalized message shape everywhere in code:
`{ chat_id: string, message_id: number, sender: string, text: string, sent_at: number }`

## Auth (two rules, no exceptions)

1. `POST /telegram/webhook`: reject unless header
   `x-telegram-bot-api-secret-token === TELEGRAM_WEBHOOK_SECRET`. Always answer 200 fast
   once accepted (Telegram retries non-200s).
2. Every `POST /tools/*`: reject unless header `x-tool-secret === TOOL_SECRET`.
   (`/api/conversation-init` does NOT use this header — it's called by our public session
   page and is authenticated by the signed JWT in its body instead.)

## Route contracts (frozen)

### `POST /telegram/webhook` — [Session 0]
Handles Telegram `Update` objects. Two behaviors:
- Any group text message → insert into `messages` (sender = first_name or username).
- Message text starting with `/catchup` → compute the user's marker
  (`user_markers.caught_up_at`, default: earliest message in DB), sign a JWT
  `{ user_id, user_name, chat_id, since: marker }` (HS256, `SESSION_JWT_SECRET`,
  15 min expiry), reply in-chat via `sendMessage`:
  `"🎧 Catch up here: {APP_URL}/session?t={jwt}"`. Do NOT store the /catchup message.

### `GET /session` — [Session 1]
Serves `public/session.html`.

### `POST /api/conversation-init` — [Session 1]
Body: `{ token: string }` (the JWT from the link).
1. Verify JWT (401 on bad/expired).
2. Fetch messages where `sent_at > since`, cap 500.
3. Format them into one `missed_transcript` block, oldest first, one line per message
   (`"today 9:14am — Priya: Morning all…"`). No summarization here — the ElevenLabs agent
   already runs an LLM and does it in its opening turn. Capped at 6000 chars; when the cap
   bites, the newest messages are kept and an `(earlier messages omitted)` marker is
   prepended. Zero missed messages → `"(nothing new since they last caught up)"`.
4. `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id={ELEVENLABS_AGENT_ID}`
   with header `xi-api-key: {ELEVENLABS_API_KEY}` → conversation token.
5. Respond:
```json
{
  "conversation_token": "...",
  "dynamic_variables": {
    "user_id": "...", "user_name": "...",
    "missed_count": 42, "since_human": "yesterday 3pm",
    "missed_transcript": "today 9:14am — Priya: …\ntoday 9:21am — Marcus: …"
  }
}
```
`session.html` starts the conversation with `@elevenlabs/client`
`Conversation.startSession({ conversationToken, dynamicVariables })` (WebRTC), shows a
minimal status UI (connecting / listening / speaking, end-call button).

### `POST /tools/search_chat` — [Session 2]
Body: `{ query: string, since_ts?: number }` →
`{ results: [{ message_id, sender, text, sent_at }] }`
SQL `LIKE %query%` (case-insensitive), newest first, cap 20.

### `POST /tools/get_messages` — [Session 2]
Body: `{ from_id: number, to_id: number }` →
`{ messages: [{ message_id, sender, text, sent_at }] }` (cap 50, chat = TELEGRAM_CHAT_ID).

### `POST /tools/verify_information` — [Session 3]
Body: `{ claim: string, url?: string }` →
`{ context_markdown: string, sources: string[] }`
If `url` given: scrape it via Context.dev's scrape endpoint (LLM-ready markdown). If not,
use Context.dev's search-or-crawl capability on the claim's key terms, scrape the top hit.
Hard 15-second budget: on timeout/failure return
`{ context_markdown: "VERIFICATION_UNAVAILABLE: <reason>", sources: [] }` with HTTP 200
(the agent must be able to say "I couldn't verify that right now" instead of stalling).
Truncate `context_markdown` to 4000 chars. The tool returns raw source context; the
*agent* judges whether the chat's claim matches it.

### `POST /tools/dispatch_to_devin` — [Session 4]
Body: `{ title: string, details: string }`
1. `POST https://api.devin.ai/v1/sessions` (`Authorization: Bearer {DEVIN_API_KEY}`) with
   prompt: `"{title}\n\n{details}\n\n(Task dispatched from a Telegram chat catch-up session.)"`
2. Store in `devin_sessions` (status `running`).
3. Post to the group: Telegram `sendMessage` to `TELEGRAM_CHAT_ID`:
   `"🤖 Dispatched to Devin: {title} — {session url}"`.
4. → `{ devin_session_id, url }`. On Devin API failure → 200 with `{ error: "<human-readable reason>" }`.

### `POST /tools/check_devin_sessions` — [Session 4]
Body: `{}` → poll `GET https://api.devin.ai/v1/sessions/{id}` for each stored session,
update statuses → `{ sessions: [{ title, status, url }] }`.

### `POST /tools/mark_caught_up` — [Session 4]
Body: `{ user_id: string }` (the agent passes dynamic variable `{{user_id}}`) →
upsert `user_markers` with now → `{ ok: true }`.

### `npm run seed` — [Session 0]
`seed.ts`: read `transcript.json`
(`[{ sender, text, minutes_ago }]`), insert into `messages` with synthetic ascending
`message_id` starting at 1000, `chat_id = TELEGRAM_CHAT_ID`. Wipes existing seeded rows
(message_id 1000–1999) first so it's re-runnable.

### `npm run set-app-url` — [Session 5]
`scripts/set-app-url.ts`: one command that re-points the outside world at the current
`APP_URL` (the quick-tunnel URL changes every time cloudflared restarts):
1. Telegram: call `setWebhook` with url `{APP_URL}/telegram/webhook` and
   `secret_token = TELEGRAM_WEBHOOK_SECRET`; treat `ok: false` as failure.
2. ElevenLabs: fetch the agent's webhook tools and rewrite each tool URL whose path
   starts with `/tools/` so its origin becomes `APP_URL`, preserving the path.
Print every URL it changed; exit non-zero with a readable message on any failure.

## Error-handling floor (don't build more than this)

- Webhook: 200 fast, idempotent inserts (INSERT OR IGNORE).
- Tools: never throw a 5xx the agent can't narrate — catch, return 200 with an `error`
  or `VERIFICATION_UNAVAILABLE` field.
- Expired JWT: session page shows "Ask the bot for a fresh link."
