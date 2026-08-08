import { Hono } from 'hono';
import { insertDevinSession, listDevinSessions, setMarker, updateDevinStatus } from '../db.js';
import { sendMessage } from '../telegram.js';

const DEVIN_API_BASE = (process.env.DEVIN_API_BASE_URL ?? 'https://api.devin.ai').replace(/\/$/, '');

type CreateSessionResponse = {
  session_id?: string;
  url?: string;
};

type GetSessionResponse = {
  session_id?: string;
  status?: string;
  status_enum?: string | null;
  url?: string;
};

function reason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function devinFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = process.env.DEVIN_API_KEY;
  if (!key) throw new Error('DEVIN_API_KEY is not configured');
  return fetch(`${DEVIN_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

export const devinTools = new Hono();

devinTools.post('/dispatch_to_devin', async (c) => {
  let title = '';
  let details = '';
  try {
    const body = await c.req.json<{ title?: string; details?: string }>();
    title = (body.title ?? '').trim();
    details = (body.details ?? '').trim();
  } catch {
    return c.json({ error: 'invalid JSON body' });
  }
  if (!title) return c.json({ error: 'title is required' });

  const prompt = `${title}\n\n${details}\n\n(Task dispatched from a Telegram chat catch-up session.)`;

  let created: CreateSessionResponse;
  try {
    const res = await devinFetch('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ prompt, title }),
    });
    if (!res.ok) {
      // Upstream bodies can echo request/internal details: log them, don't return them.
      console.warn(`dispatch_to_devin: Devin API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return c.json({ error: `the Devin API rejected the request (HTTP ${res.status})` });
    }
    created = (await res.json()) as CreateSessionResponse;
  } catch (err) {
    return c.json({ error: `could not reach the Devin API: ${reason(err)}` });
  }

  if (!created.session_id) return c.json({ error: 'Devin API response had no session_id' });

  const url = created.url ?? null;
  insertDevinSession({
    devin_session_id: created.session_id,
    title,
    status: 'running',
    url,
    created_at: Math.floor(Date.now() / 1000),
  });

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    // sendMessage never throws; a failed group post must not fail the dispatch.
    await sendMessage(chatId, `🤖 Dispatched to Devin: ${title} — ${url ?? ''}`);
  } else {
    console.warn('dispatch_to_devin: TELEGRAM_CHAT_ID not set, skipped group post');
  }

  return c.json({ devin_session_id: created.session_id, url });
});

devinTools.post('/check_devin_sessions', async (c) => {
  const stored = listDevinSessions();

  const sessions = await Promise.all(
    stored.map(async (s) => {
      try {
        const res = await devinFetch(`/v1/sessions/${encodeURIComponent(s.devin_session_id)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as GetSessionResponse;
        const status = body.status_enum ?? body.status;
        if (!status) throw new Error('no status in response');
        if (status !== s.status) updateDevinStatus(s.devin_session_id, status);
        return { title: s.title, status, url: body.url ?? s.url };
      } catch (err) {
        console.warn(`check_devin_sessions: ${s.devin_session_id}: ${reason(err)}`);
        return { title: s.title, status: 'unknown', url: s.url };
      }
    }),
  );

  return c.json({ sessions });
});

devinTools.post('/mark_caught_up', async (c) => {
  let userId = '';
  try {
    const body = await c.req.json<{ user_id?: string }>();
    userId = String(body.user_id ?? '').trim();
  } catch {
    return c.json({ error: 'invalid JSON body' });
  }
  if (!userId) return c.json({ error: 'user_id is required' });

  setMarker(userId, process.env.TELEGRAM_CHAT_ID ?? '', Math.floor(Date.now() / 1000));
  return c.json({ ok: true });
});
