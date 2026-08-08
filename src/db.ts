import Database from 'better-sqlite3';

export type Message = {
  chat_id: string;
  message_id: number;
  sender: string;
  text: string;
  sent_at: number;
};

export type UserMarker = {
  user_id: string;
  chat_id: string;
  caught_up_at: number;
};

export type DevinSession = {
  devin_session_id: string;
  title: string;
  status: string;
  url: string | null;
  created_at: number;
};

export const db = new Database(process.env.DB_PATH ?? 'data.db');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  chat_id    TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender     TEXT NOT NULL,
  text       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS user_markers (
  user_id      TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  caught_up_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devin_sessions (
  devin_session_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  url        TEXT,
  created_at INTEGER NOT NULL
);
`);

const insertMessageStmt = db.prepare<[string, number, string, string, number]>(
  `INSERT OR IGNORE INTO messages (chat_id, message_id, sender, text, sent_at)
   VALUES (?, ?, ?, ?, ?)`,
);

const messagesSinceStmt = db.prepare(
  `SELECT chat_id, message_id, sender, text, sent_at FROM messages
   WHERE chat_id = ? AND sent_at > ?
   ORDER BY sent_at ASC, message_id ASC
   LIMIT ?`,
);

const searchStmt = db.prepare(
  `SELECT chat_id, message_id, sender, text, sent_at FROM messages
   WHERE chat_id = ? AND text LIKE ? COLLATE NOCASE AND sent_at > ?
   ORDER BY sent_at DESC, message_id DESC
   LIMIT ?`,
);

const rangeStmt = db.prepare(
  `SELECT chat_id, message_id, sender, text, sent_at FROM messages
   WHERE chat_id = ? AND message_id BETWEEN ? AND ?
   ORDER BY message_id ASC
   LIMIT ?`,
);

const earliestSentAtStmt = db.prepare(`SELECT MIN(sent_at) AS ts FROM messages WHERE chat_id = ?`);

const getMarkerStmt = db.prepare(
  `SELECT user_id, chat_id, caught_up_at FROM user_markers WHERE user_id = ?`,
);

const setMarkerStmt = db.prepare<[string, string, number]>(
  `INSERT INTO user_markers (user_id, chat_id, caught_up_at) VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, caught_up_at = excluded.caught_up_at`,
);

const insertDevinSessionStmt = db.prepare<[string, string, string, string | null, number]>(
  `INSERT OR REPLACE INTO devin_sessions (devin_session_id, title, status, url, created_at)
   VALUES (?, ?, ?, ?, ?)`,
);

const listDevinSessionsStmt = db.prepare(
  `SELECT devin_session_id, title, status, url, created_at FROM devin_sessions
   ORDER BY created_at DESC`,
);

const updateDevinStatusStmt = db.prepare<[string, string]>(
  `UPDATE devin_sessions SET status = ? WHERE devin_session_id = ?`,
);

export function insertMessage(m: Message): boolean {
  const info = insertMessageStmt.run(m.chat_id, m.message_id, m.sender, m.text, m.sent_at);
  return info.changes > 0;
}

export function getMessagesSince(chatId: string, sinceTs: number, limit = 500): Message[] {
  return messagesSinceStmt.all(chatId, sinceTs, limit) as Message[];
}

export function searchMessages(
  q: string,
  sinceTs?: number,
  chatId = process.env.TELEGRAM_CHAT_ID ?? '',
  limit = 20,
): Message[] {
  return searchStmt.all(chatId, `%${q}%`, sinceTs ?? 0, limit) as Message[];
}

export function getMessagesRange(
  fromId: number,
  toId: number,
  chatId = process.env.TELEGRAM_CHAT_ID ?? '',
  limit = 50,
): Message[] {
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  return rangeStmt.all(chatId, lo, hi, limit) as Message[];
}

export function getEarliestSentAt(chatId: string): number | null {
  const row = earliestSentAtStmt.get(chatId) as { ts: number | null } | undefined;
  return row?.ts ?? null;
}

export function getMarker(userId: string): UserMarker | null {
  return (getMarkerStmt.get(userId) as UserMarker | undefined) ?? null;
}

export function setMarker(userId: string, chatId: string, ts: number): void {
  setMarkerStmt.run(userId, chatId, ts);
}

export function insertDevinSession(s: DevinSession): void {
  insertDevinSessionStmt.run(s.devin_session_id, s.title, s.status, s.url, s.created_at);
}

export function listDevinSessions(): DevinSession[] {
  return listDevinSessionsStmt.all() as DevinSession[];
}

export function updateDevinStatus(devinSessionId: string, status: string): void {
  updateDevinStatusStmt.run(status, devinSessionId);
}
