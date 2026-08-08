import { Hono } from 'hono';

export const verify = new Hono();

const CONTEXT_ROOT = 'https://api.context.dev';
const CONTEXT_API = `${CONTEXT_ROOT}/v1`;
const BUDGET_MS = 15_000;
const MAX_MARKDOWN_CHARS = 4000;

type Unavailable = { context_markdown: string; sources: string[] };

function unavailable(reason: string): Unavailable {
  return { context_markdown: `VERIFICATION_UNAVAILABLE: ${reason}`, sources: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncate(markdown: string): string {
  return markdown.length > MAX_MARKDOWN_CHARS ? markdown.slice(0, MAX_MARKDOWN_CHARS) : markdown;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Context.dev error bodies carry `message` / `error_code`. */
type Failure = { reason: string; isApiError: boolean };

async function describeFailure(res: Response): Promise<Failure> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parts = isRecord(body)
    ? [body.error_code, body.message].filter((p): p is string => typeof p === 'string')
    : [];
  const detail = parts.join(': ');
  return {
    reason: `Context.dev responded ${res.status}${detail ? ` (${detail})` : ''}`,
    isApiError: isRecord(body) && typeof body.error_code === 'string',
  };
}

async function scrapeMarkdown(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  remainingMs: number,
): Promise<{ markdown: string; url: string }> {
  const options = {
    url,
    useMainContentOnly: true,
    includeImages: false,
    timeoutMS: Math.max(1, remainingMs),
  };
  const query = new URLSearchParams(
    Object.entries(options).map(([k, v]) => [k, String(v)]),
  );
  let res = await fetch(`${CONTEXT_API}/web/scrape/markdown?${query.toString()}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (res.status === 404) {
    // A 404 carrying error_code is Context.dev reporting the target page missing; a bare
    // 404 means the route itself is wrong, so retry the unversioned POST form the
    // quickstart documents instead of the versioned GET the API reference documents.
    const failure = await describeFailure(res);
    if (failure.isApiError) throw new Error(failure.reason);
    res = await fetch(`${CONTEXT_ROOT}/web/scrape/markdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(options),
      signal,
    });
  }
  if (!res.ok) throw new Error((await describeFailure(res)).reason);

  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body.markdown !== 'string' || body.markdown.trim() === '') {
    throw new Error('Context.dev returned no page content');
  }
  return { markdown: body.markdown, url: typeof body.url === 'string' ? body.url : url };
}

type SearchHit = { url: string; markdown: string | null };

async function searchWeb(
  claim: string,
  apiKey: string,
  signal: AbortSignal,
  remainingMs: number,
): Promise<SearchHit[]> {
  const res = await fetch(`${CONTEXT_API}/web/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: claim.slice(0, 500),
      numResults: 10,
      markdownOptions: { enabled: true, useMainContentOnly: true, timeoutMS: Math.max(1, remainingMs) },
      timeoutMS: Math.max(1, remainingMs),
    }),
    signal,
  });
  if (!res.ok) throw new Error((await describeFailure(res)).reason);

  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error('Context.dev returned no search results');
  }

  const hits: SearchHit[] = [];
  for (const result of body.results) {
    if (!isRecord(result) || typeof result.url !== 'string') continue;
    const scrape = isRecord(result.markdown) ? result.markdown : undefined;
    const markdown =
      scrape && scrape.code === 'SUCCESS' && typeof scrape.markdown === 'string' && scrape.markdown.trim() !== ''
        ? scrape.markdown
        : null;
    hits.push({ url: result.url, markdown });
  }
  if (hits.length === 0) throw new Error('no web results for that claim');
  return hits;
}

verify.post('/verify_information', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(unavailable('request body must be JSON'));
  }
  if (!isRecord(body)) return c.json(unavailable('request body must be a JSON object'));

  const { claim, url } = body;
  if (typeof claim !== 'string' || claim.trim() === '') {
    return c.json(unavailable('claim must be a non-empty string'));
  }
  if (url !== undefined && (typeof url !== 'string' || !isHttpUrl(url))) {
    return c.json(unavailable('url must be an http(s) URL'));
  }

  const apiKey = process.env.CONTEXT_DEV_KEY;
  if (!apiKey) return c.json(unavailable('CONTEXT_DEV_KEY is not configured'));

  const startedAt = Date.now();
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), BUDGET_MS);
  const remaining = () => BUDGET_MS - (Date.now() - startedAt);

  try {
    if (typeof url === 'string') {
      const scraped = await scrapeMarkdown(url, apiKey, controller.signal, remaining());
      return c.json({ context_markdown: truncate(scraped.markdown), sources: [scraped.url] });
    }

    // No URL: let Context.dev find the page, preferring a hit it already scraped for us.
    const hits = await searchWeb(claim, apiKey, controller.signal, remaining());
    const prescraped = hits.find((h) => h.markdown !== null);
    if (prescraped?.markdown) {
      return c.json({ context_markdown: truncate(prescraped.markdown), sources: [prescraped.url] });
    }
    const [bestHit] = hits;
    if (!bestHit) throw new Error('no web results for that claim');
    const scraped = await scrapeMarkdown(bestHit.url, apiKey, controller.signal, remaining());
    return c.json({ context_markdown: truncate(scraped.markdown), sources: [scraped.url] });
  } catch (e) {
    const reason =
      controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')
        ? 'Context.dev did not respond within 15s'
        : e instanceof Error
          ? e.message
          : 'unknown Context.dev failure';
    console.error('verify_information failed:', e);
    return c.json(unavailable(reason));
  } finally {
    clearTimeout(budget);
  }
});
