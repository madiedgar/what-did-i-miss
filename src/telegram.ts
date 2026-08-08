import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { getEarliestSentAt, getMarker, insertMessage } from './db.js';

type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number | string; type?: string };
  date: number;
  text?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.warn('sendMessage skipped: TELEGRAM_TOKEN not set');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.warn('sendMessage failed', res.status, await res.text());
  } catch (err) {
    console.warn('sendMessage error', err);
  }
}

function senderName(from: TelegramUser | undefined): string {
  return from?.first_name ?? from?.username ?? 'unknown';
}

function catchupLink(msg: TelegramMessage): string {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id ?? '');
  const marker = getMarker(userId)?.caught_up_at ?? getEarliestSentAt(chatId) ?? 0;
  const token = jwt.sign(
    { user_id: userId, user_name: senderName(msg.from), chat_id: chatId, since: marker },
    process.env.SESSION_JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '15m' },
  );
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  return `🎧 Catch up here: ${appUrl}/session?t=${token}`;
}

export const telegram = new Hono();

telegram.post('/', async (c) => {
  if (c.req.header('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: true });
  }

  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return c.json({ ok: true });

  if (text.startsWith('/catchup')) {
    await sendMessage(String(msg.chat.id), catchupLink(msg));
    return c.json({ ok: true });
  }

  insertMessage({
    chat_id: String(msg.chat.id),
    message_id: msg.message_id,
    sender: senderName(msg.from),
    text,
    sent_at: msg.date,
  });

  return c.json({ ok: true });
});
