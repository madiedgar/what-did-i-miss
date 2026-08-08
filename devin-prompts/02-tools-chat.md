# Devin Session 2 — Chat tools (search + quote)

Work in repo: <REPO_URL>, branch from main AFTER Session 0's PR is merged.
Read `README.md` in full first — it is the frozen contract.

## Your scope (only these files)
`src/tools/chat.ts` (+ one route-mount line in `src/index.ts` replacing the two stubs)

## Build
Implement per README, using `db.ts` helpers only (no raw SQL here):
- `POST /tools/search_chat` — case-insensitive LIKE, optional `since_ts`, newest first, cap 20.
- `POST /tools/get_messages` — id range, cap 50.
Both already sit behind the `x-tool-secret` middleware from Session 0 — do not add your own auth.
Malformed body → 200 with `{ "error": "bad request: <what>" }` (the voice agent must be
able to narrate failures; never 4xx/5xx on these two routes after auth passes).

## Acceptance (prove in PR description)
- Seed the DB, then: `curl -X POST localhost:3000/tools/search_chat -H 'x-tool-secret: x' -H 'content-type: application/json' -d '{"query":"deploy"}'` returns matching seeded rows in the exact README shape.
- `get_messages` with a range covering seeds returns them ordered by message_id.
- Empty results → `{ "results": [] }` (not an error).

## Constraints
- Branch `devin/session-2`, open a PR, do not merge. No new dependencies.
