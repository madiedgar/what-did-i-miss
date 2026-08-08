---
name: testing-tool-endpoints
description: How to boot, seed, and curl-test the what-did-i-miss Hono /tools/* endpoints locally (no UI, no real API keys needed for chat tools).
---

# Testing `/tools/*` endpoints locally

This repo is a headless Hono + better-sqlite3 HTTP API. There is no UI and no test
framework — curl smokes are the intended harness (see README "Stack").

## Boot a server

```bash
cd <repo> && npm install   # if node_modules missing
PORT=3100 TOOL_SECRET=x SESSION_JWT_SECRET=y TELEGRAM_TOKEN=z \
  TELEGRAM_WEBHOOK_SECRET=s TELEGRAM_CHAT_ID=1 APP_URL=http://localhost:3100 \
  npm start > /tmp/server3100.log 2>&1 &
curl -s localhost:3100/health   # -> {"ok":true}
```

- Port 3000 is often already taken on the box; always set `PORT` to something free,
  otherwise `npm start` dies with `EADDRINUSE` (it exits, it does not retry).
- `DB_PATH` env var overrides the sqlite file (`data.db` by default) if you want an
  isolated DB instead of mutating the checked-in one.
- No real third-party API keys are needed for `search_chat` / `get_messages`; the
  Anthropic/ElevenLabs/Context.dev/Devin keys are only needed for Sessions 1/3/4 routes.

## Seed data

```bash
TELEGRAM_CHAT_ID=1 npm run seed   # transcript.json -> messages ids 1000+
```
Re-runnable (wipes ids 1000-1999 first). To create extra fixture rows (e.g. to test
LIMIT caps), insert directly with a small node script using `better-sqlite3` against
`data.db`, then delete them and re-run the seed to restore a clean state.

## Calling the tools

Every `/tools/*` POST needs `x-tool-secret: $TOOL_SECRET`; missing/wrong -> 401.
Unrouted `/tools/<name>` paths that were mounted as stubs answer 501 `{"stub":true}`;
truly unknown paths answer 404. When a session mounts a router at `/tools` itself,
re-check the stubs still 501 (a catch-all router at `/tools` would shadow them).

## Error-handling floor

Per README, after auth passes tool routes must answer HTTP 200 with
`{"error":"..."}` for any malformed input — never 4xx/5xx. Test with: missing fields,
wrong types, nulls, arrays/strings as the body, unparseable JSON, no content-type,
text/plain and form-encoded bodies.

## Gotchas found

- `searchMessages` in `src/db.ts` does NOT filter by `chat_id`, so `/tools/search_chat`
  can return rows from other chats (unlike `get_messages`, which is chat-scoped).
- LIKE wildcards in the query are not escaped, so `%` or `_` as a query matches every
  row; a multi-hundred-KB query makes SQLite raise "LIKE or GLOB pattern too complex"
  (surfaced as a 200 `error` string, which still satisfies the floor).
