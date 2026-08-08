# Devin Session 5 — local deploy: cloudflared tunnel + set-app-url script

> **Already implemented directly in-repo — do not dispatch.** Kept for reference as the
> spec this work was built to.

Work in repo: <REPO_URL>, branch from main AFTER Session 0's PR is merged.
Read `README.md` in full first — it is the frozen contract.

## Context
We dropped Railway. The app now runs on the Lead's laptop behind a Cloudflare quick
tunnel (`cloudflared tunnel --url http://localhost:3000`). `.env` loading already
exists (`--env-file-if-exists` in the npm scripts) and `.env.example` is committed.
What's missing: whenever the tunnel URL changes, Telegram's webhook and the ElevenLabs
agent's six webhook-tool URLs must be re-pointed at the new `APP_URL` in one command.

## Your scope (only these files)
`scripts/set-app-url.ts`, `package.json` (scripts only), `tsconfig.json` (include only),
`.env.example` (APP_URL comment). Nothing else.

## Build
1. **`npm run set-app-url`** — `scripts/set-app-url.ts`, run via
   `tsx --env-file-if-exists=.env`, per the README contract:
   - Validate `APP_URL` is https with no trailing slash; fail fast with a readable
     message if any required var is missing.
   - **Telegram**: call
     `https://api.telegram.org/bot{TELEGRAM_TOKEN}/setWebhook` with
     `url={APP_URL}/telegram/webhook` and `secret_token={TELEGRAM_WEBHOOK_SECRET}`.
     Treat `ok: false` in the response as failure and print Telegram's `description`.
   - **ElevenLabs**: consult the current API docs at
     https://elevenlabs.io/docs/api-reference — do not guess endpoints from memory.
     Webhook tools may be embedded in the agent's config or exist as standalone
     workspace tools referenced by the agent (`ELEVENLABS_AGENT_ID`); handle whichever
     shape the API actually returns. For every webhook tool whose URL path starts with
     `/tools/`, replace the URL's **origin** with `APP_URL` and keep the path exactly.
     Leave non-matching tools untouched. Auth header `xi-api-key: {ELEVENLABS_API_KEY}`.
   - Print each URL it changed (`old → new`) and a final ✅/❌ per step. Exit 0 only if
     both steps succeeded; otherwise exit 1. No stack-trace spam on expected failures.
   - Plain `fetch` only — no new dependencies.
2. **`npm run dev`** — add script `"dev": "tsx watch --env-file-if-exists=.env src/index.ts"`
   so the Lead's server auto-restarts after each `git pull`.
3. Add `scripts/**/*.ts` to the tsconfig `include` so `npm run typecheck` covers it.

## Acceptance (prove in PR description)
- `npm run typecheck` clean.
- `npm run set-app-url` with dummy creds exits 1 with a readable per-step error
  (show the Telegram step failing cleanly).
- Quote the code that rewrites a tool URL's origin while preserving its
  `/tools/<name>` path.

## Constraints
- Branch `devin/session-5`, open a PR, do not merge.
- Do not touch any other session's files.
