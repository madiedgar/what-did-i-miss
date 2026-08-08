# What Did I Miss — Tech Spec

Exact interface shapes live in [`CONTRACTS.md`](CONTRACTS.md); this page is the reasoning.

## 01 · Problem

People in busy group chats — a team, a project, a friend group — pay a re-entry tax after any
time away: hundreds of messages where the three things that matter are buried in logistics and
banter. Scrolling is slow; a text summary is static — it can't answer "wait, what did Dana
actually say?" and it can't *do* anything about what it found.

Voice, specifically, because catching up is a hands-free moment (walking, driving, making
coffee) and because the right interface for a summary is one you can interrupt. A voice agent
turns catch-up from reading into a conversation: summary first, then drill-down, fact-checking,
and delegation, all without a screen.

## 02 · Architecture

A single Hono server (Node 20 / TypeScript) with SQLite (`better-sqlite3`, one file) as the
only state. Data flows:

- **Ingest:** Telegram webhook → secret-header check → `INSERT OR IGNORE` into `messages`
  (idempotent; Telegram redelivers). `/catchup` messages instead mint a 15-minute HS256 JWT
  and reply with a session link.
- **Session start:** the voice page posts the JWT to `/api/conversation-init`. The server
  pulls messages since the user's `caught_up_at` marker (cap 500), formats them into one
  `missed_transcript` string (6000-char cap, newest kept), fetches an ElevenLabs conversation
  token, and returns both. The page opens a WebRTC session with the transcript passed as a
  dynamic variable. **There is no second LLM** — the agent's own model summarizes.
- **Mid-conversation:** the ElevenLabs agent calls six webhook tools back into the server
  (shared-secret header): `search_chat` / `get_messages` (SQLite), `verify_information`
  (Context.dev scrape → raw markdown, agent judges), `dispatch_to_devin` /
  `check_devin_sessions` (Devin API; dispatch also posts 🤖 back to the group),
  `mark_caught_up` (moves the marker). Tools never 5xx — failures come back as HTTP 200 with
  a narratable `error` field, because a thrown error is dead air in a voice call.
- **Deploy:** the server runs on a laptop behind a free Cloudflare quick tunnel.
  `npm run set-app-url` re-points Telegram's webhook and all six ElevenLabs tool URLs at the
  current tunnel URL in one command, so the ephemeral URL is config, not infrastructure.

(Diagram in [`README.md`](README.md).)

## 03 · Tool rationale

- **ElevenLabs Agents** — the entire realtime voice stack (STT, turn-taking, TTS, WebRTC) plus
  server-side tool calling and dynamic variables, hosted. We ship webhooks and one HTML page;
  the agent's prompt lives in their dashboard, editable without a redeploy — the fastest fix
  path in a timeboxed build. Building even a fragile voice loop ourselves would have consumed
  the whole window.
- **Context.dev** — the verify moment needs *live web* ground truth, not model memory, and it
  needs it as text an LLM can quote. One call turns a public URL into LLM-ready markdown (with
  search-or-crawl when no URL is given). We deliberately return the raw markdown and let the
  agent render the verdict — the tool stays dumb and debuggable.
- **Devin** — group chats are full of "someone should fix X" that evaporates. Devin is an API
  call away from turning that sentence into a running coding session with a URL — and the 🤖
  confirmation it posts back into the group is the demo's visible side effect: the agent
  didn't just talk, it did something everyone can see. (Devin also built most of this repo,
  from the prompts in `devin-prompts/`.)

## 04 · Feasibility

Scoped to the six-hour window by deciding everything up front and building nothing twice:

- **Contracts before code.** Every route, schema, and payload was frozen in `CONTRACTS.md`
  first. Five Devin sessions then built against disjoint file sets in parallel (the only
  overlap: one route-mount line each), while humans did only what Devin can't — accounts,
  dashboards, PR review, and the demo script.
- **Aggressive cuts.** Single group chat, single server instance, SQLite as the only state, no
  ORM, no migrations, no queues, no retries, no test framework (curl smokes + an integration
  checklist), `LIKE` search instead of embeddings. Mid-build we cut the planned Anthropic
  digest call entirely — shipping the raw transcript to the agent removed an API key, a
  latency hop, and a JSON-parsing failure mode.
- **Zero infrastructure.** No hosting to configure or pay for: a quick tunnel plus the
  `set-app-url` script makes a laptop the production environment, and "deploy" is
  `git pull` + process restart.

What this costs, knowingly: sessions are pull-only (the agent reports Devin progress when
asked — nothing streams status back), search is keyword-only, and state dies with the laptop.

## 05 · Extensibility

The seams for v2 are already in the schema and the tool boundary:

- **Semantic search** — swap `search_chat`'s `LIKE` for embeddings over `messages` (the tool's
  request/response contract doesn't change, so the agent config is untouched).
- **Multi-group** — `chat_id` is already on every row and in the JWT; v2 is lifting the single
  `TELEGRAM_CHAT_ID` scope into per-group config and link routing.
- **Proactive loop** — a poller that watches `devin_sessions` and posts status changes back to
  the group unprompted, closing the dispatch loop without being asked.
- **Standing catch-up** — rolling digests per topic and a "catch me up on just #infra" marker
  per thread, instead of one marker per user.
- **Production posture** — a named tunnel or small VPS for a stable URL, conversation tokens
  bound to the JWT holder, media (images/voice notes) in ingest, and a real DB when state
  must outlive the laptop.
