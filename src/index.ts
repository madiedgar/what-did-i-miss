import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import './db.js';
import { init } from './init.js';
import { telegram } from './telegram.js';
import { chat } from './tools/chat.js';
import { devinTools } from './tools/devin.js';
import { verify } from './tools/verify.js';

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

app.route('/api/conversation-init', init);
app.get('/session', serveStatic({ path: './public/session.html' }));
app.use('/public/*', serveStatic({ root: './' }));

// [Session 2]
app.route('/tools', chat);
// [Session 3]
app.route('/tools', verify);
// [Session 4] dispatch_to_devin, check_devin_sessions, mark_caught_up
app.route('/tools', devinTools);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`what-did-i-miss listening on :${port}`);

export default app;
