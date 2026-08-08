// Re-point the outside world at the current APP_URL (see README "npm run set-app-url").
// The quick-tunnel URL changes whenever cloudflared restarts; run this after each change.
// Env comes from .env via the npm script's --env-file-if-exists flag.

const missing = [
  'APP_URL',
  'TELEGRAM_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(', ')} — set them in .env`);
  process.exit(1);
}

const APP_URL = process.env.APP_URL!;
const XI_KEY = process.env.ELEVENLABS_API_KEY!;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID!;

if (!APP_URL.startsWith('https://') || APP_URL.endsWith('/')) {
  console.error(`❌ APP_URL must start with https:// and have no trailing slash (got "${APP_URL}")`);
  process.exit(1);
}

// Webhook tool URLs keep their /tools/<name> path; only the origin moves to APP_URL.
function rewriteOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.pathname.startsWith('/tools/')) return null;
  const next = `${APP_URL}${parsed.pathname}${parsed.search}`;
  return next === url ? null : next;
}

async function setTelegramWebhook(): Promise<boolean> {
  const target = `${APP_URL}/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: target, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET }),
    });
    const body = (await res.json()) as { ok?: boolean; description?: string };
    if (!body.ok) {
      console.error(`❌ Telegram setWebhook failed: ${body.description ?? `HTTP ${res.status}`}`);
      return false;
    }
    console.log(`✅ Telegram webhook → ${target}`);
    return true;
  } catch (err) {
    console.error(`❌ Telegram setWebhook failed: ${(err as Error).message}`);
    return false;
  }
}

async function xi(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: { 'xi-api-key': XI_KEY, 'content-type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function updateElevenLabsTools(): Promise<boolean> {
  let seen = 0;
  let changed = 0;
  try {
    const agent = await xi(`/v1/convai/agents/${AGENT_ID}`);
    const prompt = agent?.conversation_config?.agent?.prompt ?? {};

    // Standalone workspace tools referenced by the agent via tool_ids. If the agent
    // doesn't expose tool_ids, fall back to every workspace tool — this demo
    // workspace only contains ours, and rewriteOrigin skips non-/tools/ URLs anyway.
    let toolIds: string[] = Array.isArray(prompt.tool_ids) ? prompt.tool_ids : [];
    if (toolIds.length === 0) {
      const list = await xi('/v1/convai/tools');
      toolIds = (list.tools ?? []).map((t: any) => t.id);
    }
    for (const id of toolIds) {
      const tool = await xi(`/v1/convai/tools/${id}`);
      const config = tool.tool_config;
      const url = config?.api_schema?.url;
      if (config?.type !== 'webhook' || typeof url !== 'string') continue;
      seen++;
      const next = rewriteOrigin(url);
      if (!next) continue;
      config.api_schema.url = next;
      await xi(`/v1/convai/tools/${id}`, { method: 'PATCH', body: JSON.stringify({ tool_config: config }) });
      console.log(`   ${config.name ?? id}: ${url} → ${next}`);
      changed++;
    }

    // Legacy shape: webhook tools embedded inline in the agent's prompt config.
    const inline = Array.isArray(prompt.tools) ? prompt.tools : [];
    const inlineLogs: string[] = [];
    for (const tool of inline) {
      const url = tool?.api_schema?.url;
      if (tool?.type !== 'webhook' || typeof url !== 'string') continue;
      seen++;
      const next = rewriteOrigin(url);
      if (!next) continue;
      inlineLogs.push(`   ${tool.name ?? 'webhook tool'}: ${url} → ${next}`);
      tool.api_schema.url = next;
    }
    if (inlineLogs.length > 0) {
      await xi(`/v1/convai/agents/${AGENT_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ conversation_config: { agent: { prompt: { tools: inline } } } }),
      });
      inlineLogs.forEach((line) => console.log(line));
      changed += inlineLogs.length;
    }

    if (seen === 0) {
      console.error('❌ ElevenLabs: no webhook tools found on the agent or in the workspace — configure them in the dashboard first');
      return false;
    }
    console.log(`✅ ElevenLabs: ${changed} tool URL(s) rewritten, ${seen - changed} already current`);
    return true;
  } catch (err) {
    console.error(`❌ ElevenLabs update failed: ${(err as Error).message}`);
    return false;
  }
}

const telegramOk = await setTelegramWebhook();
const elevenLabsOk = await updateElevenLabsTools();
process.exit(telegramOk && elevenLabsOk ? 0 : 1);

export {};
