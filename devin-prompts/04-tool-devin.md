# Devin Session 4 — Devin dispatch/status + mark_caught_up

Work in repo: <REPO_URL>, branch from main AFTER Session 0's PR is merged.
Read `README.md` in full first — it is the frozen contract.

## Your scope (only these files)
`src/tools/devin.ts` (+ one route-mount line in `src/index.ts` replacing the three stubs)

## Build
Implement per README, consulting current Devin API docs at https://docs.devin.ai
(auth `Authorization: Bearer DEVIN_API_KEY`):
- `POST /tools/dispatch_to_devin`: create session via `POST https://api.devin.ai/v1/sessions`
  with the composed prompt from the README; store via `db.ts` `insertDevinSession`;
  post the "🤖 Dispatched to Devin: {title} — {url}" message into the group via Telegram
  `sendMessage` (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`); return `{ devin_session_id, url }`.
  Devin API failure → 200 `{ "error": "<reason>" }`; if only the Telegram post fails,
  still return success (log it).
- `POST /tools/check_devin_sessions`: poll each stored session's status endpoint, update
  DB, return `{ sessions: [{ title, status, url }] }`. Unreachable API → return last
  known statuses with `"status": "unknown"` rather than erroring.
- `POST /tools/mark_caught_up`: upsert `user_markers` for `body.user_id` with current
  unix time and `TELEGRAM_CHAT_ID` → `{ ok: true }`.

## Acceptance (prove in PR description)
- With a real `DEVIN_API_KEY`: dispatch curl creates a visible Devin session, the group
  gets the Telegram message, and the response matches the README shape. (If no key is
  available in your environment, mock the two Devin endpoints with a local stub server
  and show both curls against it — clearly say so in the PR.)
- `check_devin_sessions` reflects the stored session.
- `mark_caught_up` then re-running `/catchup` logic yields the new timestamp (show the DB row).

## Constraints
- Branch `devin/session-4`, open a PR, do not merge. No new dependencies (plain `fetch`).
