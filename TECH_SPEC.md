# What Did I Miss — Technical Specification

**Status:** As-built (updated for the two post-plan pivots: digest → raw transcript, Railway → local tunnel) · **Owner:** Lead (repo & deploy) · **Companions:** `README.md` (contracts, source of truth), `PLAN.md` (roles, timeline), `devin-prompts/` (per-session task prompts)

This document is the engineering view: what each component does, how data moves through the
system, and what "done" looks like per surface. Where this document and `README.md` disagree
on a shape, **`README.md` wins** — it is the frozen contract file.

---

## 1. Problem & product summary

A member of a busy Telegram group goes away for a day. Scrolling back is expensive; reading a
text summary is boring and doesn't answer follow-ups. Instead they type `/catchup`, get a link,
and talk to a voice agent that already knows what they missed and can dig into the actual
transcript on demand.

Three demo-critical moments define the scope:

| # | Moment | What it proves |
|---|--------|----------------|
| 1 | **Catch-up** — agent greets by name and summarizes the missed transcript in 2–3 spoken sentences | The agent has real, personalized state before the first word |
| 2 | **Verify** — agent checks a factual claim made in chat against a live public web page | The agent reasons over the outside world, not just the transcript |
| 3 | **Dispatch** — agent scopes a dev task out loud, gets a yes, fires it to Devin, posts back to the group | The agent takes real action with a visible side effect |

Everything else in this spec exists to serve those three moments.

## 2. Scope

**In scope:** Telegram ingestion, `/catchup` link issuance, missed-transcript packaging,
ElevenLabs voice session hosting, six agent tool webhooks, Devin dispatch + status polling,
per-user caught-up markers, seeding from an authored transcript, and the free local deploy
(quick tunnel + `set-app-url` re-pointing).

**Out of scope (explicitly, do not build):** multi-group support beyond a single
`TELEGRAM_CHAT_ID`, user accounts or login, message editing/deletion handling, media
(photos, voice notes, files), retries/queues, migrations, a test framework, observability
beyond stdout logs, rate limiting, any ORM, and any paid hosting.

## 3. Architecture

### 3.1 Component map

```
┌──────────────┐   webhook    ┌──────────────────────────────────────┐
│   Telegram   │ ───────────► │  Hono app (Node 20 / TS)             │
│  demo group  │ ◄─────────── │  on the Lead's laptop, public via    │
└──────────────┘  sendMessage │  a cloudflared quick tunnel          │
                              │                                      │
┌──────────────┐   fetch      │  /telegram/webhook   [S0]            │
│   Browser    │ ───────────► │  /session            [S1]            │
│ session.html │              │  /api/conversation-init [S1]         │
└──────┬───────┘              │  /tools/*            [S2,S3,S4]      │
       │ WebRTC               │  /health             [S0]            │
       ▼                      │            │ better-sqlite3          │
┌──────────────┐              └────────────┼─────────────────────────┘
│  ElevenLabs  │ ── tool calls ────────────▼───────┐
│    Agent     │    (back to        ┌────────────┐ │
└──────────────┘     /tools/*)      │  data.db   │◄┘
                                    └────────────┘
                                    external: Context.dev · Devin
```

### 3.2 Runtime & dependencies (fixed)

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node 20 | On the Lead's laptop; no container, no build step |
| Language | TypeScript, run via `tsx` | `npm start` → `tsx --env-file-if-exists=.env src/index.ts`; `npm run dev` adds watch mode |
| Web framework | Hono | Single app instance, routes mounted in `src/index.ts` |
| Storage | `better-sqlite3`, single file `data.db` | Synchronous API, no ORM, no migrations |
| Summarization | The ElevenLabs agent itself | **No second LLM.** We ship the raw transcript as a dynamic variable; the agent summarizes in its opening turn |
| Voice | ElevenLabs Agents platform + `@elevenlabs/client` | Agent config lives in their dashboard, not in repo |
| Verification | Context.dev scrape / search | HTTP, no SDK required |
| Agentic dev | Devin API v1 | HTTP, bearer auth |
| Deploy | Local + Cloudflare quick tunnel | `cloudflared tunnel --url http://localhost:3000` → free public HTTPS URL; `npm run set-app-url` re-points Telegram + ElevenLabs whenever it changes |

Adding a runtime dependency requires a very good reason. Testing is curl smokes only.

### 3.3 Design decisions worth stating

- **SQLite as the only state.** Sessions are short and the demo is single-instance. There is
  no cache layer and no session store — the JWT carries session state, the DB carries chat state.
- **No second LLM.** `/api/conversation-init` formats the missed messages into one transcript
  block; the agent's own LLM summarizes it in its opening turn. One less API key, one less
  latency hop at session start, and no JSON-parsing failure mode before the first word.
- **The public URL is config, not infrastructure.** The quick-tunnel URL is ephemeral by
  design; `APP_URL` lives in `.env` and `npm run set-app-url` re-points Telegram's webhook and
  every ElevenLabs tool URL at it in one command. Deploys cost nothing because there are none —
  `git pull` and a process restart.
- **Tools are dumb; the agent is smart.** `verify_information` returns raw source context and
  makes no judgement. `search_chat` does `LIKE`, not semantics. All interpretation happens in
  the agent's prompt, which is editable in the ElevenLabs dashboard without a redeploy — the
  fastest fix path during a timeboxed build.
- **Never 5xx at the agent.** A thrown error becomes dead air in a voice call. Every tool
  catches and returns HTTP 200 with an `error` (or `VERIFICATION_UNAVAILABLE`) field the agent
  can narrate.
- **Idempotent ingest.** Telegram retries non-200s and may redeliver; `INSERT OR IGNORE`
  against a composite primary key makes redelivery a no-op.

## 4. Data model

Created by `src/db.ts` on boot (`CREATE TABLE IF NOT EXISTS`). No migrations — schema changes
during the build mean deleting `data.db` and re-seeding.

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

**Normalized message shape, used everywhere in code and in every tool response:**

```ts
{ chat_id: string, message_id: number, sender: string, text: string, sent_at: number }
```

Notes:
- `sender` = Telegram `first_name`, falling back to `username`.
- `sent_at` is unix **seconds** (Telegram's native unit) — not milliseconds, anywhere.
- Seeded rows occupy `message_id` 1000–1999 so `npm run seed` can wipe and re-run cleanly.
- `user_markers` has no row until a user first calls `mark_caught_up`; absent marker means
  "since the earliest message in the DB".

## 5. Configuration

All secrets live in `.env` on the Lead's machine — `npm start`, `npm run seed`, and
`npm run set-app-url` load it via `--env-file-if-exists`. `.env.example` is the commented
catalog; `.env` itself is gitignored and exists nowhere else. Exact names, no aliases:

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

Optional, with sensible defaults: `DB_PATH` (default `./data.db`), `PORT` (default `3000`),
`DEVIN_API_BASE_URL` (default `https://api.devin.ai`).

`APP_URL` must have **no trailing slash** — it is string-concatenated into the `/catchup` link
and into every ElevenLabs tool URL. It changes every time cloudflared restarts; after updating
it in `.env`, run `npm run set-app-url`.

## 6. Security model

Three trust boundaries, three mechanisms. There are no other auth paths.

| Surface | Mechanism | Failure |
|---|---|---|
| `POST /telegram/webhook` | Header `x-telegram-bot-api-secret-token === TELEGRAM_WEBHOOK_SECRET` | Reject; do not process |
| `POST /tools/*` | Header `x-tool-secret === TOOL_SECRET` | Reject |
| `POST /api/conversation-init` | HS256 JWT in the request body, signed with `SESSION_JWT_SECRET` | 401 |

`/api/conversation-init` deliberately does **not** use `x-tool-secret` — it is called by the
public session page, where a shared secret would be visible in the browser. The signed,
15-minute JWT is its credential.

**JWT payload** (issued by `/catchup`, consumed by `/api/conversation-init`):

```ts
{ user_id: string, user_name: string, chat_id: string, since: number }  // HS256, 15 min expiry
```

Accepted residual risks for a demo: `TOOL_SECRET` is a single static shared secret; the
conversation token returned to the browser is not bound to the JWT holder; anyone with a live
link can start a session for that user during the 15-minute window.

## 7. Interface contracts

Contracts are frozen. Shapes below match `README.md` exactly; this section adds behavior notes
and failure modes.

### 7.1 `POST /telegram/webhook` — [Session 0]

Consumes Telegram `Update` objects. Answer **200 fast** once the secret header validates —
Telegram retries non-200s and slow handlers cause duplicate deliveries.

Two behaviors:

1. **Any group text message** → `INSERT OR IGNORE` into `messages`.
2. **Text starting with `/catchup`** →
   - resolve the user's marker from `user_markers.caught_up_at`; default to the earliest
     `sent_at` in the DB;
   - sign the JWT above;
   - reply in-chat via `sendMessage`: `🎧 Catch up here: {APP_URL}/session?t={jwt}`;
   - **do not store the `/catchup` message itself.**

Non-text updates (joins, edits, media, callbacks) are ignored silently with a 200.

### 7.2 `GET /session` — [Session 1]

Serves `public/session.html` as-is. The token travels as a query param (`?t=`) and is read
client-side.

### 7.3 `POST /api/conversation-init` — [Session 1]

Body: `{ token: string }`

1. Verify the JWT → 401 on bad or expired.
2. Fetch `messages` where `sent_at > since`, cap **500**, ascending.
3. Format them into one `missed_transcript` block, oldest first, one line per message
   (`"today 9:14am — Priya: Morning all…"`). **No summarization here** — the ElevenLabs agent
   already runs an LLM and does it in its opening turn. Capped at **6000 chars**; when the cap
   bites, the newest messages are kept and an `(earlier messages omitted)` marker is prepended.
   Zero missed messages → `"(nothing new since they last caught up)"`.
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

Every dynamic variable is flattened to a **string or number** — the ElevenLabs variable
substitution is textual. `since_human` is a human phrase ("yesterday 3pm"), derived from
`since`, because the agent will speak it aloud.

Client behavior: `session.html` calls this endpoint, then
`Conversation.startSession({ conversationToken, dynamicVariables })` from `@elevenlabs/client`
over WebRTC, and renders a minimal status UI — connecting / listening / speaking, plus an
end-call button. Expired JWT renders: *"Ask the bot for a fresh link."*

### 7.4 `POST /tools/search_chat` — [Session 2]

Body: `{ query: string, since_ts?: number }` → `{ results: [{ message_id, sender, text, sent_at }] }`

SQL `LIKE %query%`, case-insensitive, newest first, cap **20**, scoped to
`chat_id = TELEGRAM_CHAT_ID`. This is the agent's primary grounding tool — the system prompt
forbids inventing chat content, so an empty result set must come back as an empty array, not
an error.

### 7.5 `POST /tools/get_messages` — [Session 2]

Body: `{ from_id: number, to_id: number }` → `{ messages: [...] }`

Cap **50**, scoped to `chat_id = TELEGRAM_CHAT_ID`. Used to pull the surrounding thread after
`search_chat` finds an anchor message.

### 7.6 `POST /tools/verify_information` — [Session 3]

Body: `{ claim: string, url?: string }` → `{ context_markdown: string, sources: string[] }`

- `url` present → scrape it via Context.dev's scrape endpoint (LLM-ready markdown).
- `url` absent → use Context.dev's search-or-crawl on the claim's key terms, scrape the top hit.
- **Hard 15-second budget.** On timeout or failure, return HTTP **200** with
  `{ context_markdown: "VERIFICATION_UNAVAILABLE: <reason>", sources: [] }` so the agent can say
  "I couldn't verify that right now" instead of stalling mid-sentence.
- Truncate `context_markdown` to **4000 chars**.

The tool returns raw source context and renders no verdict. Comparing the chat's claim to the
source is the agent's job.

### 7.7 `POST /tools/dispatch_to_devin` — [Session 4]

Body: `{ title: string, details: string }`

1. `POST https://api.devin.ai/v1/sessions`, header `Authorization: Bearer {DEVIN_API_KEY}`, prompt:
   `"{title}\n\n{details}\n\n(Task dispatched from a Telegram chat catch-up session.)"`
2. Insert into `devin_sessions` with status `running`.
3. `sendMessage` to `TELEGRAM_CHAT_ID`: `🤖 Dispatched to Devin: {title} — {session url}`.
4. → `{ devin_session_id, url }`. On Devin API failure → **200** with `{ error: "<human-readable reason>" }`.

Step 3 is the visible demo payoff — the group chat is on screen when it fires. If the Telegram
post fails but the Devin session was created, still return success; log the failure.

### 7.8 `POST /tools/check_devin_sessions` — [Session 4]

Body: `{}` → for each stored session, `GET https://api.devin.ai/v1/sessions/{id}`, update
`status`, return `{ sessions: [{ title, status, url }] }`.

### 7.9 `POST /tools/mark_caught_up` — [Session 4]

Body: `{ user_id: string }` (agent passes the dynamic variable `{{user_id}}`, not an LLM guess)
→ upsert `user_markers` with now → `{ ok: true }`.

### 7.10 `npm run seed` — [Session 0]

`seed.ts` reads `transcript.json` (`[{ sender, text, minutes_ago }]`) and inserts into
`messages` with synthetic ascending `message_id` starting at **1000** and
`chat_id = TELEGRAM_CHAT_ID`. Wipes `message_id` 1000–1999 first so it is re-runnable.

`transcript.json` is authored by the demo owner (human) and **must** contain: one factual claim
verifiable at a public URL, one clearly-scoped dev task, and 2–3 discussion topics. Without all
three, the demo has nothing to verify or dispatch.

### 7.11 `npm run set-app-url` — [Session 5]

`scripts/set-app-url.ts`: one command that re-points the outside world at the current
`APP_URL` after a tunnel restart:

1. **Telegram**: `setWebhook` with url `{APP_URL}/telegram/webhook` and
   `secret_token = TELEGRAM_WEBHOOK_SECRET`; `ok: false` is a failure.
2. **ElevenLabs**: fetch the agent's webhook tools (agent `tool_ids` → workspace tools,
   falling back to all workspace tools, handling legacy inline agent tools) and rewrite each
   tool URL whose path starts with `/tools/` so its origin becomes `APP_URL`, preserving the
   path.

Prints every `old → new` rewrite; exits non-zero with a readable message on any failure.
Old `/catchup` links embed the previous origin — send a fresh `/catchup` after re-pointing.

## 8. Key flows

### 8.1 Ingest

```
group message → Telegram → POST /telegram/webhook (secret header)
              → INSERT OR IGNORE messages → 200
```

### 8.2 Catch-up session

```
/catchup → resolve marker (or earliest message) → sign JWT (15 min)
        → sendMessage with {APP_URL}/session?t={jwt}
user opens link → GET /session → session.html reads ?t
        → POST /api/conversation-init { token }
              ├─ verify JWT
              ├─ SELECT messages WHERE sent_at > since LIMIT 500
              ├─ format missed_transcript (6000-char cap, newest kept)
              └─ ElevenLabs → conversation_token
        → Conversation.startSession({ conversationToken, dynamicVariables })  [WebRTC]
        → agent greets by name, summarizes the transcript itself
```

### 8.3 Mid-conversation tool call

```
user speaks → ElevenLabs agent decides → POST {APP_URL}/tools/<name>
            with x-tool-secret, 20s timeout
            → our handler (SQLite / Context.dev / Devin) → 200 JSON
            → agent narrates result
```

### 8.4 Dispatch

```
agent states title + scope aloud → user says yes → dispatch_to_devin
   → Devin session created → row stored → 🤖 message posted to group → agent confirms
```

### 8.5 Tunnel restart (recovery)

```
cloudflared dies → new `cloudflared tunnel --url http://localhost:3000`
   → copy new https://….trycloudflare.com into .env APP_URL
   → npm run set-app-url   (Telegram webhook + all ElevenLabs tool URLs re-pointed)
   → send a fresh /catchup (old links embed the dead origin)
```

## 9. Agent configuration (ElevenLabs dashboard)

Not in the repo. Owned by the ElevenLabs owner; changeable without a deploy — the preferred
place to fix behavioral bugs under time pressure.

**System prompt** (verbatim, `{{...}}` are dynamic variables):

> You are Recap, a warm, brisk voice companion that catches people up on their Telegram group chat. The user is {{user_name}}. They have missed {{missed_count}} messages since {{since_human}}. Here is everything they missed, oldest first:
>
> {{missed_transcript}}
>
> Open by greeting them by name and summarizing that transcript in 2–3 spoken sentences — who said what about the things that matter, not a list. Then offer to go deeper on any topic.
> Rules:
> - When the user asks about a specific discussion, use search_chat and get_messages to quote what was actually said and by whom. Never invent chat content.
> - When the chat contains a factual claim about the outside world and the user asks about it (or accuracy matters), call verify_information and compare the chat's claim to the returned source context. Say clearly whether the source agrees, and cite it. If the tool returns VERIFICATION_UNAVAILABLE, say you couldn't verify right now.
> - When the chat contains actionable engineering work, offer to dispatch it to Devin. Before calling dispatch_to_devin, state the task title and scope out loud and get an explicit yes. After dispatch, tell them it was posted to the group. Use check_devin_sessions when asked about progress.
> - When the user says they're done or all caught up, call mark_caught_up with user_id {{user_id}}, then close warmly in one sentence.
> - Keep every turn short: this is voice. One idea per turn, no lists longer than three.

**Webhook tools** — all `POST`, URL `{APP_URL}/tools/<name>`, header `x-tool-secret: {TOOL_SECRET}`, timeout 20s:

| Tool | Params (LLM-provided unless noted) |
|---|---|
| `search_chat` | `query` (string, required), `since_ts` (number, optional) |
| `get_messages` | `from_id` (number), `to_id` (number) |
| `verify_information` | `claim` (string, required), `url` (string, optional) |
| `dispatch_to_devin` | `title` (string), `details` (string) |
| `check_devin_sessions` | none |
| `mark_caught_up` | `user_id` — bound to dynamic variable `{{user_id}}`, **not** LLM-chosen |

**Dynamic variables to declare:** `user_id, user_name, missed_count, since_human,
missed_transcript`.

Tools can be configured before the tunnel exists — use a placeholder origin
(`https://placeholder.local/tools/<name>`); `npm run set-app-url` rewrites every tool URL's
origin once `APP_URL` is live.

The 20s tool timeout is deliberately wider than `verify_information`'s 15s internal budget, so
our own timeout fires first and returns a narratable string rather than letting the agent hang.

## 10. Build plan & file ownership

Five Devin sessions ran against disjoint file sets (Session 5 was implemented directly
in-repo). **Only touch files tagged with your session number.** PR from branch
`devin/session-<n>`; never push to main.

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

**Dependency:** Session 0 must merge before 1–4 start — they all import `db.ts` helpers and
mount into `index.ts`. Sessions 1–4 then run fully in parallel; the only file overlap is one
route-mount line each in `index.ts`, which merges trivially.

**Human ownership:** Lead (repo, `.env`, local server + tunnel, `APP_URL`, `set-app-url` runs),
ElevenLabs owner (agent + tools + voice), Telegram owner (BotFather, **privacy mode off**,
chat id, webhook), Wrangler A (Sessions 0, 1, 2), Wrangler B (Sessions 3, 4), Demo owner
(`transcript.json`, script, rehearsal). Full timeline in `PLAN.md`.

## 11. Error-handling floor

Build to this line and no further.

| Surface | Behavior |
|---|---|
| Webhook | 200 fast; `INSERT OR IGNORE` for idempotency |
| Any `/tools/*` | Never a 5xx the agent can't narrate — catch and return 200 with `error` |
| `verify_information` | 15s budget → `VERIFICATION_UNAVAILABLE: <reason>` at HTTP 200 |
| `dispatch_to_devin` | Devin API failure → 200 `{ error }` |
| Expired JWT | Session page shows "Ask the bot for a fresh link." |

No retries, no backoff, no dead-letter handling, no structured logging.

## 12. Verification

No test framework. Verification is curl smokes plus the integration checklist.

**Smokes** (against `APP_URL`, with `x-tool-secret`):

```bash
curl -s $APP_URL/health   # tunnel + server up

curl -s -XPOST $APP_URL/tools/search_chat \
  -H "x-tool-secret: $TOOL_SECRET" -H 'content-type: application/json' \
  -d '{"query":"deploy"}'

curl -s -XPOST $APP_URL/tools/verify_information \
  -H "x-tool-secret: $TOOL_SECRET" -H 'content-type: application/json' \
  -d '{"claim":"<claim from transcript>","url":"<public url>"}'

curl -s -XPOST $APP_URL/tools/check_devin_sessions \
  -H "x-tool-secret: $TOOL_SECRET" -H 'content-type: application/json' -d '{}'
```

Also verify: a missing/incorrect `x-tool-secret` is rejected, and `/api/conversation-init`
returns 401 for a tampered token.

**Integration checklist (gate before rehearsal):**

- [ ] Group message → row in `messages`
- [ ] `/catchup` → link arrives, page connects, agent greets by name and summarizes the transcript
- [ ] "What did people say about &lt;topic&gt;?" → quotes real seeded messages
- [ ] "Is it true that &lt;claim&gt;?" → verification moment cites the source
- [ ] "Have Devin do it" → confirm-out-loud → 🤖 message in group → Devin session visible
- [ ] "I'm all caught up" → `user_markers` row updated, clean goodbye

**Demo (5 beats, ~3 min):** show the seeded group → `/catchup` and hands-free catch-up → topic
question with verbatim quotes → claim verification with citation → dispatch, 🤖 message on
screen, goodbye and marker set.

## 13. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Telegram privacy mode on** — bot silently receives no group messages | Total ingest failure, looks like a code bug | Disable via `/setprivacy` in minute one; verify a real message reaches the DB before anything else is trusted |
| **Quick-tunnel URL is ephemeral** — changes every cloudflared restart | Webhook and every tool URL go dead | Start the tunnel once and leave it running; on restart, update `.env` and run `npm run set-app-url`, then send a fresh `/catchup`. Keep the laptop awake (`caffeinate -i npm start`) and on reliable wifi |
| **Verification claim not refutable from scraped *text*** | Agent confirms a false claim on stage | Context.dev returns markdown — anything a page conveys only via colour, layout, or chart images is invisible. The transcript's Node LTS claim points at `github.com/nodejs/Release`, whose README states the LTS split in literal table text; `nodejs.org/en/about/previous-releases` is a trap (the split is drawn in an SVG). Re-check any replacement page's scraped text |
| **ElevenLabs SDK signatures drift** | Session 1 burns time on a broken client | Session 1's prompt instructs Devin to read current docs; ElevenLabs owner independently validates the agent in the dashboard playground |
| **Session 1 (voice page) runs long** | No demo surface | Fallback: drive the agent from the ElevenLabs dashboard playground with dynamic variables pasted manually — every tool still fires |
| **Devin PR quality varies under time pressure** | Merged code violates a contract | Wranglers review diffs against `README.md` contracts, not vibes; small fixes by hand beat follow-up prompts |
| **Context.dev slow or the target page is JS-heavy** | Dead air on the verify beat | 15s budget → `VERIFICATION_UNAVAILABLE`, agent narrates the failure; demo owner picks a static, scrape-friendly URL |
| **`APP_URL` with a trailing slash** | Broken links and 404s on every tool call | `set-app-url` validates and refuses it; it is concatenated in ~8 places |

## 14. Open items — resolved during the build

- ~~Exact Context.dev scrape and search endpoint paths~~ — confirmed from current docs in
  Session 3 (`src/tools/verify.ts`).
- ~~Devin API response field names for session id and URL~~ — confirmed in Session 4; status
  polling uses `GET /v1/sessions/{id}`.
- ~~ElevenLabs conversation-token endpoint params~~ — `agent_id` alone is sufficient for
  WebRTC sessions (Session 1).
- ~~ElevenLabs webhook-tool storage shape~~ — tools are workspace-level, referenced from the
  agent via `tool_ids`; `set-app-url` handles both that and the legacy inline shape (Session 5).
