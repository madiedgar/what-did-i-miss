# Devin Session 3 — verify_information (Context.dev)

Work in repo: <REPO_URL>, branch from main AFTER Session 0's PR is merged.
Read `README.md` in full first — it is the frozen contract.

## Your scope (only these files)
`src/tools/verify.ts` (+ one route-mount line in `src/index.ts` replacing the stub)

## Build
Implement `POST /tools/verify_information` per README. Consult the current Context.dev
API docs at https://docs.context.dev (auth via `CONTEXT_DEV_KEY`) — do not guess
endpoints from memory:
- `url` provided → scrape that URL to LLM-ready markdown.
- no `url` → use Context.dev's search/crawl capability on the claim's key terms and
  scrape the best hit.
- Wrap ALL Context.dev calls in a hard 15s `AbortController` budget. Any failure or
  timeout → HTTP 200 `{ "context_markdown": "VERIFICATION_UNAVAILABLE: <reason>", "sources": [] }`.
- Success → `{ "context_markdown": "<truncated to 4000 chars>", "sources": ["<urls used>"] }`.
- This tool returns raw source context only; it does NOT judge the claim — the voice
  agent does that. No Anthropic calls in this file.

## Acceptance (prove in PR description)
- `curl -X POST localhost:3000/tools/verify_information -H 'x-tool-secret: x' -H 'content-type: application/json' -d '{"claim":"ElevenLabs supports webhook tools","url":"https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools"}'`
  returns markdown containing recognizable page content, under 4000 chars, within 15s.
- With a garbage URL → 200 VERIFICATION_UNAVAILABLE response, not a crash.
- With no `url` → still produces a sourced result for a well-known claim.

## Constraints
- Branch `devin/session-3`, open a PR, do not merge.
- Prefer plain `fetch`; add the official Context.dev SDK only if fetch is genuinely painful.
