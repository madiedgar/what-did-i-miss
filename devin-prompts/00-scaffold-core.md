# Devin Session 0 — Scaffold + core spine (MUST RUN FIRST, others wait for this merge)

Work in repo: <REPO_URL>. Read `README.md` in full first — it is the frozen contract.

## Your scope (only these files)
`package.json`, `tsconfig.json`, `src/index.ts`, `src/db.ts`, `src/telegram.ts`, `seed.ts`, `.gitignore`

## Build
1. Node 20 + TypeScript project: deps `hono`, `@hono/node-server`, `better-sqlite3`,
   `jsonwebtoken`, `tsx` (dev). Scripts: `start` = `tsx src/index.ts`, `seed` = `tsx seed.ts`.
2. `src/db.ts`: open `data.db`, create the three tables exactly per README schema, export
   typed helpers: `insertMessage`, `getMessagesSince(chatId, sinceTs, limit)`,
   `searchMessages(q, sinceTs?)`, `getMessagesRange(fromId, toId)`, `getMarker(userId)`,
   `setMarker(userId, chatId, ts)`, `insertDevinSession`, `listDevinSessions`, `updateDevinStatus`.
3. `src/index.ts`: Hono app on `process.env.PORT ?? 3000`. Mount `/telegram/webhook`.
   Serve `public/` statically at `/session` → `public/session.html` (create a placeholder
   `public/session.html` saying "voice page coming" — Session 1 replaces it).
   Add middleware: any path starting `/tools/` requires header `x-tool-secret === process.env.TOOL_SECRET`
   else 401. Create STUB routes for all six `/tools/*` endpoints and `/api/conversation-init`
   from the README, each returning `501 {"stub": true}` — other sessions replace the stubs
   by mounting their own routers; structure `index.ts` so each stub is one
   `app.route(...)` line that's trivially replaceable.
4. `src/telegram.ts`: implement `POST /telegram/webhook` exactly per README contract
   (secret header check, ingest group text messages idempotently, `/catchup` → JWT link reply
   via Telegram `sendMessage`).
5. `seed.ts` per README contract. Include a sample `transcript.json` with 8 placeholder
   messages (the demo owner will replace it).

## Acceptance (prove each with a command in your PR description)
- `npm install && npm start` boots clean with only `TOOL_SECRET=x SESSION_JWT_SECRET=y TELEGRAM_TOKEN=z TELEGRAM_WEBHOOK_SECRET=s TELEGRAM_CHAT_ID=1 APP_URL=http://localhost:3000` set.
- `npm run seed` then `sqlite3 data.db 'select count(*) from messages'` ≥ 8.
- Posting a fake Telegram update to `/telegram/webhook` with the right secret header
  inserts a row; wrong header → 401; same update twice → still one row.
- `curl -X POST localhost:3000/tools/search_chat -H 'x-tool-secret: x'` → 501 stub json.

## Constraints
- Branch `devin/session-0`, open a PR, do not merge.
- No extra dependencies beyond those listed. No test framework. Keep it small.
