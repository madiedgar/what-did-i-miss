import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { getMessagesSince, type Message } from './db.js';

const MESSAGE_CAP = 500;
/** Dynamic variables ride in the agent's prompt; keep the transcript from crowding it out. */
const TRANSCRIPT_CHAR_CAP = 6000;

type SessionClaims = {
  user_id: string;
  user_name: string;
  chat_id: string;
  since: number;
};

function claims(token: string): SessionClaims {
  return jwt.verify(token, process.env.SESSION_JWT_SECRET as string, {
    algorithms: ['HS256'],
  }) as SessionClaims;
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

/**
 * The missed messages as one speakable block for the agent to summarize itself.
 * Oldest first so the story reads forwards; when capped, the newest are kept.
 */
export function missedTranscript(messages: Message[], now = Date.now()): string {
  if (messages.length === 0) return '(nothing new since they last caught up)';

  const lines = messages.map((m) => `${humanizeSince(m.sent_at, now)} — ${m.sender}: ${m.text}`);

  let out = lines.join('\n');
  while (out.length > TRANSCRIPT_CHAR_CAP && lines.length > 1) {
    lines.shift();
    out = `(earlier messages omitted)\n${lines.join('\n')}`;
  }
  return out.slice(0, TRANSCRIPT_CHAR_CAP);
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
    const token = await conversationToken();
    return c.json({
      conversation_token: token,
      dynamic_variables: {
        user_id: session.user_id,
        user_name: session.user_name,
        missed_count: messages.length,
        since_human: humanizeSince(session.since),
        missed_transcript: missedTranscript(messages),
      },
    });
  } catch (err) {
    // Upstream messages can carry provider diagnostics — log them, don't ship them.
    console.error('conversation-init failed', err);
    return c.json({ error: 'could not start the conversation' }, 502);
  }
});
