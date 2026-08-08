import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { getMessagesSince, type Message } from './db.js';

const MODEL = 'claude-sonnet-5';
const MESSAGE_CAP = 500;

type SessionClaims = {
  user_id: string;
  user_name: string;
  chat_id: string;
  since: number;
};

type Digest = {
  overview: string;
  topics: string[];
  action_items: string[];
};

const DIGEST_PROMPT = `You are briefing someone who has been away from a group chat.
Read the transcript and reply with ONLY a JSON object, no prose and no code fences:
{"overview": string, "topics": string[], "action_items": string[]}
- overview: 3-5 sentences, spoken-word friendly, naming who said what about the important things.
- topics: 3-6 short topic labels.
- action_items: things someone needs to do or decide, phrased as imperatives. Empty array if none.`;

function claims(token: string): SessionClaims {
  return jwt.verify(token, process.env.SESSION_JWT_SECRET as string, {
    algorithms: ['HS256'],
  }) as SessionClaims;
}

function transcript(messages: Message[]): string {
  return messages
    .map((m) => `[${new Date(m.sent_at * 1000).toISOString()}] ${m.sender}: ${m.text}`)
    .join('\n');
}

/** "yesterday 3pm", "today 9am", "Tuesday 4pm", or "12 Mar 4pm" for anything older than a week. */
export function humanizeSince(sinceTs: number, now = Date.now()): string {
  const then = new Date(sinceTs * 1000);
  const hour12 = ((then.getHours() + 11) % 12) + 1;
  const minutes = then.getMinutes();
  const clock = `${hour12}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}${
    then.getHours() < 12 ? 'am' : 'pm'
  }`;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThen = new Date(then);
  startOfThen.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86_400_000);

  if (daysAgo <= 0) return `today ${clock}`;
  if (daysAgo === 1) return `yesterday ${clock}`;
  if (daysAgo < 7) return `${then.toLocaleDateString('en-US', { weekday: 'long' })} ${clock}`;
  return `${then.getDate()} ${then.toLocaleDateString('en-US', { month: 'short' })} ${clock}`;
}

function parseDigest(raw: string): Digest {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stripped.slice(start, end + 1)) as Partial<Digest>;
      const overview = typeof parsed.overview === 'string' ? parsed.overview.trim() : '';
      if (overview) {
        return {
          overview,
          topics: (Array.isArray(parsed.topics) ? parsed.topics : []).map(String),
          action_items: (Array.isArray(parsed.action_items) ? parsed.action_items : []).map(String),
        };
      }
    } catch {
      // fall through to raw text
    }
  }
  return { overview: raw.trim(), topics: [], action_items: [] };
}

async function digestOf(messages: Message[]): Promise<Digest> {
  if (messages.length === 0) {
    return { overview: "Nothing new since you last caught up — you're all clear.", topics: [], action_items: [] };
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: DIGEST_PROMPT,
    messages: [{ role: 'user', content: `Transcript of ${messages.length} missed messages:\n\n${transcript(messages)}` }],
  });

  const text = res.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return parseDigest(text);
}

async function conversationToken(): Promise<string> {
  const agentId = process.env.ELEVENLABS_AGENT_ID ?? '';
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '' } },
  );
  if (!res.ok) throw new Error(`ElevenLabs token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('ElevenLabs token request returned no token');
  return body.token;
}

export const init = new Hono();

init.post('/', async (c) => {
  let session: SessionClaims;
  try {
    const { token } = await c.req.json<{ token?: string }>();
    if (!token) return c.json({ error: 'missing token' }, 401);
    session = claims(token);
  } catch {
    return c.json({ error: 'invalid or expired token' }, 401);
  }

  const messages = getMessagesSince(session.chat_id, session.since, MESSAGE_CAP);

  try {
    const digest = await digestOf(messages);
    const token = await conversationToken();
    return c.json({
      conversation_token: token,
      dynamic_variables: {
        user_id: session.user_id,
        user_name: session.user_name,
        missed_count: messages.length,
        since_human: humanizeSince(session.since),
        digest_overview: digest.overview,
        digest_topics: digest.topics.join(', '),
        digest_action_items: digest.action_items.map((a, i) => `${i + 1}. ${a}`).join(' '),
      },
    });
  } catch (err) {
    // Upstream messages can carry provider diagnostics — log them, don't ship them.
    console.error('conversation-init failed', err);
    return c.json({ error: 'could not start the conversation' }, 502);
  }
});
