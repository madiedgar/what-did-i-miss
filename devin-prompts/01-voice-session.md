# Devin Session 1 — Voice page + conversation init

Work in repo: <REPO_URL>, branch from main AFTER Session 0's PR is merged.
Read `README.md` in full first — it is the frozen contract.

## Your scope (only these files)
`src/init.ts`, `public/session.html` (+ one route-mount line in `src/index.ts` replacing the stub)

## Build
1. `src/init.ts`: implement `POST /api/conversation-init` exactly per README:
   verify JWT from body → fetch missed messages via `db.ts` helpers → ONE Anthropic
   messages call (model `claude-sonnet-5`, `@anthropic-ai/sdk`, add this dependency)
   producing strict JSON `{overview, topics, action_items}` (prompt for JSON, parse
   defensively, fall back to using raw text as `overview`) → fetch ElevenLabs
   conversation token per README → respond with `conversation_token` +
   `dynamic_variables` exactly as specified (names are frozen — the agent's prompt
   references them).
2. `public/session.html`: single self-contained page, no build step. Load
   `@elevenlabs/client` from a CDN ESM import. On load: read `?t=` param → POST
   `/api/conversation-init` → `Conversation.startSession({ conversationToken, dynamicVariables })`
   (WebRTC). UI: big status indicator (connecting / listening / agent speaking, from SDK
   mode callbacks), an End button calling `endSession()`, an error state for 401
   ("Ask the bot for a fresh link"). Consult current ElevenLabs docs
   (elevenlabs.io/docs) for exact SDK call signatures — do not guess from memory.

## Acceptance (prove in PR description)
- With valid env keys, opening `/session?t=<jwt signed with SESSION_JWT_SECRET>` reaches
  "connecting" and the init endpoint returns 200 with all dynamic_variables fields
  populated from seeded DB data.
- Expired/garbage token → clean error UI, no console explosion.
- `curl` the init endpoint with a hand-signed JWT: response JSON matches the README shape exactly.

## Constraints
- Branch `devin/session-1`, open a PR, do not merge. Only touch your files.
- Allowed new dependency: `@anthropic-ai/sdk` only.
