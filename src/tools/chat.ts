import { Hono } from 'hono';
import { getMessagesRange, searchMessages, type Message } from '../db.js';

export const chat = new Hono();

type ToolMessage = Omit<Message, 'chat_id'>;

function toToolMessage(m: Message): ToolMessage {
  return { message_id: m.message_id, sender: m.sender, text: m.text, sent_at: m.sent_at };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

chat.post('/search_chat', async (c) => {
  const body = await readBody(c);
  if (!isRecord(body)) return c.json({ error: 'bad request: body must be a JSON object' });

  const { query, since_ts } = body;
  if (typeof query !== 'string' || query.trim() === '') {
    return c.json({ error: 'bad request: query must be a non-empty string' });
  }
  if (since_ts !== undefined && (typeof since_ts !== 'number' || !Number.isFinite(since_ts))) {
    return c.json({ error: 'bad request: since_ts must be a number' });
  }

  try {
    const results = searchMessages(query, since_ts).map(toToolMessage);
    return c.json({ results });
  } catch (e) {
    console.error('search_chat failed:', e);
    return c.json({ error: 'bad request: search failed' });
  }
});

chat.post('/get_messages', async (c) => {
  const body = await readBody(c);
  if (!isRecord(body)) return c.json({ error: 'bad request: body must be a JSON object' });

  const { from_id, to_id } = body;
  for (const [name, value] of [
    ['from_id', from_id],
    ['to_id', to_id],
  ] as const) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return c.json({ error: `bad request: ${name} must be an integer` });
    }
  }

  try {
    const messages = getMessagesRange(from_id as number, to_id as number).map(toToolMessage);
    return c.json({ messages });
  } catch (e) {
    console.error('get_messages failed:', e);
    return c.json({ error: 'bad request: lookup failed' });
  }
});
