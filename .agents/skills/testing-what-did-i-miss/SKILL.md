---
name: testing-what-did-i-miss
description: How to run and end-to-end test the what-did-i-miss app locally (voice session page, /api/conversation-init) when the Anthropic/ElevenLabs credentials are missing.
---

# Testing what-did-i-miss locally

There is no test framework (by design — see README "curl smokes only"). `npm run typecheck`
(`tsc --noEmit`) is the only build check.

## Boot

```bash
cd <repo>
TELEGRAM_CHAT_ID=-1002222 npm run seed          # transcript.json -> data.db (8 rows, message_id 1000-1999)
TELEGRAM_CHAT_ID=-1002222 SESSION_JWT_SECRET=devsecret TOOL_SECRET=x TELEGRAM_TOKEN=z \
  TELEGRAM_WEBHOOK_SECRET=s APP_URL=http://localhost:3000 PORT=3000 npm start
```

`DB_PATH=/tmp/test.db` isolates SQLite from the checked-in `data.db`. Port 3000 is often already
taken on the box and `npm start` exits on EADDRINUSE — `curl /health` to confirm boot.

Gotcha: backgrounding the server from a one-shot shell call (`nohup ... &`) gets it killed when the
call times out. Start it in a persistent shell session, or wrap in `( ... & )` and verify `/health`.

## Testing without ANTHROPIC_API_KEY / ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID

If those secrets are absent, stub the two outbound calls instead of skipping the happy path: write a
small entry file that patches `globalThis.fetch` (match on `api.anthropic.com` / `api.elevenlabs.io`)
and then `await import('src/index.ts')`, and run it with `npx tsx`. The ElevenLabs URL is hardcoded,
so only a fetch patch intercepts it (`ANTHROPIC_BASE_URL` alone is not enough). Reading the stub's
behaviour from a control file (e.g. `/tmp/stub_mode`) per request lets you flip failure modes
(bad JSON digest, upstream 500/503, non-string digest entries) without restarting the server.

**A stubbed conversation token cannot complete a real WebRTC handshake.** The page will reach
`Connecting…`, then fail at `Conversation.startSession` with
`could not establish signal connection: invalid authorization token`. That is the expected boundary,
not a bug — but it means `listening` / `speaking` / the End-call button / the "Call ended" state are
NOT testable without real ElevenLabs credentials. Say so explicitly rather than implying coverage.

## Browser setup

- Mint links with the bundled `jsonwebtoken`: sign `{user_id,user_name,chat_id,since}` (HS256,
  `SESSION_JWT_SECRET`) and open `http://localhost:3000/session?t=<jwt>`.
- Do NOT type long JWT URLs into the omnibox — a single mistyped character silently becomes a
  401 "Link expired" and looks like a real failure. Write a scratch `file:///tmp/links.html` with
  anchors for each case (valid / garbage / expired / wrong-secret / no `?t=`) and click them.
- The box has **no audio device** (`/dev/snd` missing), so `getUserMedia` fails with
  `NotFoundError: Requested device not found` and the page never gets past the mic probe. Relaunch
  Chrome with `--use-fake-device-for-media-stream` appended to its existing argv
  (`tr '\0' '\n' < /proc/<pid>/cmdline`), keeping `--remote-debugging-port` so tooling reattaches.
- Mic permission states are best exercised through the padlock menu in the address bar
  (Microphone toggle) rather than devtools — that also gives the recording a legible user action.
- To probe the "SDK CDN unreachable" branch, temporarily point the page's `SDK_URL` at a
  non-existent esm.sh version, reload, then restore the file.

## Devin Secrets Needed

- `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` — required for a real voice
  conversation (listening/speaking/End-call states). Everything else is testable with stubs.
- `TELEGRAM_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` — only needed to test the `/catchup` link delivery.
