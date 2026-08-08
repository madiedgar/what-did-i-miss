# Execution Plan — 3 hours, 6 humans, Devin builds the code

Architecture + contracts: see `README.md`. Devin task prompts: `devin-prompts/`.
Humans do only what Devin can't: accounts, keys, dashboards, PR review/merge, deploy, demo.

## Roles

| # | Role | Owns |
|---|------|------|
| 1 | **Lead / repo & deploy** | Push this repo to GitHub, connect Devin to it, create Railway project + set all env vars, deploy early and often, own `APP_URL` |
| 2 | **ElevenLabs owner** | Create the agent in the dashboard: system prompt + 6 webhook tools (below), pick voice, test in dashboard playground |
| 3 | **Telegram owner** | BotFather: create bot, **disable privacy mode** (`/setprivacy` → Disable), make demo group, get `TELEGRAM_CHAT_ID`, call `setWebhook` with `secret_token` once deployed |
| 4 | **Devin wrangler A** | Kick off Session 0 immediately; when merged, kick Sessions 1 & 2; steer, answer Devin's questions, review + merge those PRs |
| 5 | **Devin wrangler B** | When Session 0 merges, kick Sessions 3 & 4; steer, review + merge |
| 6 | **Demo owner** | Author `transcript.json` (must contain: one factual claim verifiable at a public URL, one clearly-scoped dev task, 2–3 discussion topics); write + run the demo script; rehearse |

## Timeline

- **0:00–0:15** — Lead pushes repo + connects Devin; Wrangler A starts Session 0 (paste `devin-prompts/00-scaffold-core.md` with real repo URL). Everyone else starts their dashboard/account work in parallel. All keys collected into Railway env.
- **0:15–0:50** — Session 0 runs. ElevenLabs agent + tools configured (they can be fully configured before the endpoints exist). Telegram bot created. Demo owner drafts transcript.
- **0:50–1:00** — Review + merge Session 0 PR. Lead deploys to Railway → `APP_URL` live → Telegram `setWebhook` → verify a group message lands in the DB.
- **1:00–1:50** — Sessions 1–4 run **in parallel** (disjoint files; the only overlap is one route-mount line each in `index.ts` — trivial merges). Wranglers review and merge as each finishes; Lead redeploys per merge.
- **1:50–2:20** — Integration: run `npm run seed` on Railway, `/catchup` in the group, full voice session — hit all three moments (digest, verify, dispatch). Fix small things directly; send Devin a follow-up message in the relevant session for anything bigger.
- **2:20–2:45** — Rehearse the demo twice end-to-end. **Freeze at 2:45.** No merges after freeze.
- **2:45–3:00** — Buffer / breathe.

## ElevenLabs dashboard config (person 2 — copy/paste)

**Agent system prompt:**

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

| Tool | Params (all from LLM unless noted) |
|---|---|
| `search_chat` | `query` (string, required), `since_ts` (number, optional) |
| `get_messages` | `from_id` (number), `to_id` (number) |
| `verify_information` | `claim` (string, required), `url` (string, optional) |
| `dispatch_to_devin` | `title` (string), `details` (string) |
| `check_devin_sessions` | none |
| `mark_caught_up` | `user_id` — set from dynamic variable `{{user_id}}`, not LLM-chosen |

Dynamic variables to declare: `user_id, user_name, missed_count, since_human, missed_transcript`.

## Integration checklist (1:50)

- [ ] Group message → row in `messages` (check Railway logs / sqlite)
- [ ] `/catchup` → link arrives, page connects, agent greets by name with real digest
- [ ] "What did people say about &lt;topic&gt;?" → quotes real seeded messages
- [ ] "Is it true that &lt;claim&gt;?" → verify moment cites the source
- [ ] "Have Devin do it" → confirm-out-loud → group gets the 🤖 message → Devin session visible
- [ ] "I'm all caught up" → marker row updated, clean goodbye

## Demo script (5 beats, ~3 min)

1. Show the live Telegram group + the seeded backstory chat.
2. `/catchup` → open link → agent greets and delivers the digest hands-free.
3. Ask about a topic → agent quotes teammates verbatim.
4. "Someone claimed X — is that still true?" → Context.dev verification with citation.
5. "Ship it — have Devin fix it" → spoken confirmation → 🤖 message pops into the group on screen, Devin session running. Say goodbye → agent marks you caught up.

## Known risks

- **Telegram privacy mode** silently hides group messages from the bot — disable it in minute one and verify ingestion before anything else.
- ElevenLabs SDK signatures drift — Session 1's prompt tells Devin to read current docs, and person 2 can sanity-test the agent in the dashboard playground independent of our page.
- Devin PR quality varies under time pressure — wranglers review diffs against README contracts, not vibes; small fixes are faster by hand than by follow-up prompt.
- If Session 1 (voice page) runs long, fallback demo: test the agent via the ElevenLabs dashboard playground with dynamic variables pasted manually — every tool still fires.
