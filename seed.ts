import { readFileSync } from 'node:fs';
import { db, insertMessage } from './src/db.js';

type TranscriptEntry = { sender: string; text: string; minutes_ago: number };

const SEED_ID_START = 1000;
const SEED_ID_END = 1999;

const chatId = process.env.TELEGRAM_CHAT_ID;
if (!chatId) {
  console.error('TELEGRAM_CHAT_ID must be set to seed.');
  process.exit(1);
}

const entries = JSON.parse(readFileSync('transcript.json', 'utf8')) as TranscriptEntry[];

db.prepare(`DELETE FROM messages WHERE message_id BETWEEN ? AND ?`).run(SEED_ID_START, SEED_ID_END);

const now = Math.floor(Date.now() / 1000);
let messageId = SEED_ID_START;
for (const e of entries) {
  insertMessage({
    chat_id: chatId,
    message_id: messageId++,
    sender: e.sender,
    text: e.text,
    sent_at: now - e.minutes_ago * 60,
  });
}

console.log(`Seeded ${entries.length} messages into chat ${chatId}.`);
