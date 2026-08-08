import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import './db.js';
import { telegram } from './telegram.js';

const app = new Hono();

// Auth: every /tools/* call needs the shared secret. /api/* is authed by its own JWT.
app.use('/tools/*', async (c, next) => {
  if (c.req.header('x-tool-secret') !== process.env.TOOL_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// Returns a router whose every route answers 501 — replaced wholesale by later sessions.
function stub(): Hono {
  const r = new Hono();
  r.all('*', (c) => c.json({ stub: true }, 501));
  return r;
}

app.get('/health', (c) => c.json({ ok: true }));

app.route('/telegram/webhook', telegram);

// [Session 1] replaces these two lines with its own routers.
app.route('/api/conversation-init', stub());
app.get('/session', serveStatic({ path: './public/session.html' }));
app.use('/public/*', serveStatic({ root: './' }));

// [Session 2]
app.route('/tools/search_chat', stub());
app.route('/tools/get_messages', stub());
// [Session 3]
app.route('/tools/verify_information', stub());
// [Session 4]
app.route('/tools/dispatch_to_devin', stub());
app.route('/tools/check_devin_sessions', stub());
app.route('/tools/mark_caught_up', stub());

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`what-did-i-miss listening on :${port}`);

export default app;
