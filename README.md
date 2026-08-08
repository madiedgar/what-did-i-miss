# What Did I Miss

Come back from a day away and your Telegram group has 200 new messages. Instead of scrolling,
you type `/catchup` and the bot hands you a link. The link opens a voice session with **Recap**,
an agent that has already read everything you missed. It greets you by name, sums up the chat in
a couple of sentences, and then it's a conversation: ask what people said about a topic and it
quotes them verbatim; ask whether a claim someone made is actually true and it checks a live
web page and cites it; tell it to "ship it" and it dispatches the task to Devin, posting a 🤖
confirmation back into the group for everyone to see. Say you're caught up, and next time it
only tells you what's new since.

## Architecture

One small Hono server owns everything: it ingests every group message into SQLite via
Telegram's webhook, issues signed `/catchup` links, serves the voice page, and exposes six
webhook tools that the ElevenLabs agent calls back into mid-conversation. There is no second
LLM — at session start the server packages the missed messages into one transcript block and
hands it to the agent as a dynamic variable; the agent's own model does the summarizing.
Verification is Context.dev (live page → markdown), dispatch is the Devin API. The server runs
on a laptop; a free Cloudflare quick tunnel makes it publicly reachable, and one script
re-points Telegram + ElevenLabs whenever the tunnel URL changes.

```
┌──────────────┐   webhook    ┌──────────────────────────────────────┐
│   Telegram   │ ───────────► │  Hono app (Node 20 / TS)             │
│  demo group  │ ◄─────────── │  on a laptop, public via a           │
└──────────────┘  sendMessage │  cloudflared quick tunnel            │
                              │                                      │
┌──────────────┐   fetch      │  /telegram/webhook  → SQLite ingest  │
│   Browser    │ ───────────► │  /session           → voice page     │
│ session.html │              │  /api/conversation-init → transcript │
└──────┬───────┘              │  /tools/*           → 6 agent tools  │
       │ WebRTC               │            │ better-sqlite3          │
       ▼                      └────────────┼─────────────────────────┘
┌──────────────┐                           ▼
│  ElevenLabs  │ ── tool calls ──►  ┌────────────┐
│    Agent     │    (back into      │  data.db   │
└──────────────┘     /tools/*)      └────────────┘
                              external: Context.dev · Devin
```

Every interface shape (routes, schemas, auth, tool payloads) is frozen in
[`CONTRACTS.md`](CONTRACTS.md). The engineering reasoning is in [`TECH-SPEC.md`](TECH-SPEC.md).

## Setup (clean machine)

**Prerequisites:** Node 20+, npm, and [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
(`brew install cloudflared` on macOS).

**Accounts / keys you need** (all have free tiers or trials):

1. **Telegram bot** — create via [@BotFather](https://t.me/BotFather), then `/setprivacy` →
   **Disable** (otherwise the bot cannot see group messages at all). Add it to your group.
2. **ElevenLabs** — create an Agent in the dashboard; system prompt, the six webhook tools,
   and dynamic variables are listed verbatim in [`PLAN.md`](PLAN.md) (use a placeholder
   origin for the tool URLs — a script fixes them later). Grab an API key + the agent id.
3. **Context.dev** — API key (powers claim verification).
4. **Devin** — API key (powers task dispatch).

**Install and configure:**

```bash
git clone https://github.com/madiedgar/what-did-i-miss.git
cd what-did-i-miss
npm install
cp .env.example .env    # fill it in — every variable is documented inline
```

**Run:**

```bash
npm run dev                                      # terminal 1 — server on :3000
cloudflared tunnel --url http://localhost:3000   # terminal 2 — prints your public URL
```

Copy the printed `https://….trycloudflare.com` URL into `.env` as `APP_URL`, then:

```bash
npm run set-app-url   # points Telegram's webhook + all 6 ElevenLabs tool URLs at it
npm run seed          # optional: load transcript.json as demo chat history
```

That's the whole deploy. Post a message in the group and check it landed
(`curl localhost:3000/health` for the server; the message appears in `data.db`). Then type
`/catchup` in the group, open the link, and talk.

The tunnel URL is ephemeral — if cloudflared restarts, update `APP_URL` in `.env`, re-run
`npm run set-app-url`, and send a fresh `/catchup`.

## Repo map

| Path | What |
|---|---|
| `src/` | The server: webhook + `/catchup` (`telegram.ts`), session init (`init.ts`), agent tools (`tools/`), SQLite (`db.ts`) |
| `public/session.html` | The voice page (ElevenLabs WebRTC client) |
| `scripts/set-app-url.ts` | Re-points the outside world at the current tunnel URL |
| `seed.ts` + `transcript.json` | Demo chat history |
| `CONTRACTS.md` | Frozen interface contracts (the build's source of truth) |
| `TECH-SPEC.md` | Engineering reasoning: problem, architecture, tool rationale, scoping, v2 |
| `PLAN.md` | The build-day execution plan + the ElevenLabs dashboard config |
| `devin-prompts/` | The task prompts the Devin sessions were built from |
