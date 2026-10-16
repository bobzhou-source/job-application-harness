/**
 * exa.mjs — minimal client for the hosted keyless Exa MCP server (streamable HTTP).
 *
 * Used for web discovery: finding a person's lab/faculty page, and org directory or
 * team pages that OpenAlex does not index. Fetched page text is only ever used to
 * read addresses that appear in it verbatim, so nothing here invents a contact.
 *
 * Protocol: POST JSON-RPC `initialize`, keep the returned `Mcp-Session-Id`, send
 * `notifications/initialized`, then `tools/call` on a reused session. Responses may
 * be `text/event-stream` or plain JSON, and tool payloads are either JSON or Exa's
 * rendered `Title/URL/Published/Author/Highlights` blocks, so both shapes are parsed.
 * HTTP 429/5xx back off; the keyless server also reports its free-tier rate limit as
 * a 200 with a short notice instead of an error, which backs off the same way.
 */

const MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa';
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const TIMEOUT_MS = 60_000;
const SEARCH_TOOL = 'web_search_exa';
const ADVANCED_SEARCH_TOOL = 'web_search_advanced_exa';
const FETCH_TOOL = 'web_fetch_exa';
const RATE_LIMIT_RE = /free MCP rate limit|dashboard\.exa\.ai\/api-keys/i;

let sessionId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drop the cached MCP session so the next call re-initializes. */
export function exaReset() {
  sessionId = null;
}

async function post(body, { retry = true, attempt = 0 } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const nextSession = response.headers.get('mcp-session-id');
  if (nextSession) sessionId = nextSession;

  if ((response.status === 429 || response.status >= 500) && retry && attempt < BACKOFF_MS.length) {
    await sleep(BACKOFF_MS[attempt]);
    return post(body, { retry, attempt: attempt + 1 });
  }
  if (!response.ok) throw new Error(`exa HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!text.trim()) return null;
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.startsWith('data:')) {
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        messages.push(JSON.parse(payload));
      } catch { /* partial or non-JSON frame */ }
    }
    return messages.find((message) => message.id === body.id) ?? messages[messages.length - 1] ?? null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function rpc(method, params) {
  const message = await post({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params });
  if (!message) throw new Error(`exa ${method}: empty response`);
  if (message.error) throw new Error(`exa ${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
  return message.result;
}

async function ensureSession() {
  if (sessionId) return;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'outreach', version: '1.0' },
  });
  try {
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { retry: false });
  } catch { /* notification failure is harmless */ }
}

async function callToolOnce(name, args) {
  await ensureSession();
  let result;
  try {
    result = await rpc('tools/call', { name, arguments: args });
  } catch (err) {
    // A stale session is the one recoverable case: drop it and try once more.
    if (!/session/i.test(String(err?.message ?? ''))) throw err;
    sessionId = null;
    await ensureSession();
    result = await rpc('tools/call', { name, arguments: args });
  }
  if (result?.isError) {
    throw new Error(`exa ${name} failed: ${String(result.content?.[0]?.text ?? '').slice(0, 200)}`);
  }
  return (result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** The keyless server answers its free-tier limit with a 200 notice, not an error. */
async function callTool(name, args) {
  for (let attempt = 0; ; attempt += 1) {
    const text = await callToolOnce(name, args);
    if (!RATE_LIMIT_RE.test(text)) return text;
    if (attempt >= BACKOFF_MS.length) {
      throw new Error('exa rate limited: hosted free MCP quota is exhausted, retry later or configure an Exa API key');
    }
    await sleep(BACKOFF_MS[attempt]);
  }
}

/** Exa's rendered blocks: `Title: … / URL: … / Published: … / Author: … / Highlights: …`. */
function parseRendered(text) {
  const out = [];
  for (const block of String(text ?? '').split(/^Title:\s*/m).slice(1)) {
    const lines = block.split('\n');
    const title = lines[0].trim();
    let url = '';
    const body = [];
    for (const line of lines.slice(1)) {
      const match = /^URL:\s*(\S+)\s*$/.exec(line);
      if (match && !url) {
        url = match[1];
        continue;
      }
      if (/^(Published|Author|Highlights):/.test(line)) continue;
      body.push(line);
    }
    out.push({ title, url, text: body.join('\n').trim() });
  }
  return out.filter((row) => /^https?:\/\//i.test(row.url));
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((value) => value.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 200 ? line.slice(0, 200) : line;
}

/** Tool text -> an array of {title,url,text}. Handles JSON payloads and rendered text. */
function exaResults(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (list) {
    return list
      .map((row) => {
        const body = String(row?.text ?? row?.summary ?? row?.highlights?.join?.(' ') ?? '').trim();
        return {
          title: String(row?.title ?? row?.name ?? '').trim() || firstLine(body),
          url: String(row?.url ?? row?.link ?? '').trim(),
          text: body,
        };
      })
      .filter((row) => /^https?:\/\//i.test(row.url));
  }
  const rendered = parseRendered(text);
  if (rendered.length) return rendered;

  // Last resort: scrape URLs (and any adjacent title) out of a rendered answer.
  const out = [];
  for (const match of String(text ?? '').matchAll(/^([^\n]{0,160}?)\n?\s*(https?:\/\/[^\s)"'<>]+)/gm)) {
    out.push({ title: match[1].replace(/^[-*\d.[\]\s]+/, '').trim(), url: match[2], text: '' });
  }
  if (!out.length) {
    for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s)"'<>]+/g)) {
      out.push({ title: '', url: match[0], text: '' });
    }
  }
  const seen = new Set();
  return out.filter((row) => !seen.has(row.url) && seen.add(row.url));
}

export async function exaSearch(query, { numResults = 5, includeDomains } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('exa search query is required');
  const domains = (Array.isArray(includeDomains) ? includeDomains : []).map((value) => String(value).trim()).filter(Boolean);
  const args = { query: trimmed, numResults };
  if (domains.length) args.includeDomains = domains;
  const text = await callTool(domains.length ? ADVANCED_SEARCH_TOOL : SEARCH_TOOL, args);
  return exaResults(text);
}

export async function exaFetch(url) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error(`exa fetch needs an http(s) url: ${url}`);
  const text = await callTool(FETCH_TOOL, { urls: [target] });
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed?.results?.[0] ?? parsed;
  const body = String(first?.text ?? first?.content ?? text ?? '');
  const resolved = first?.url ?? (Array.isArray(first?.urls) ? first.urls[0] : null);
  const title = String(first?.title ?? '').trim()
    || parseRendered(body)[0]?.title
    || (/^Title:\s*(.+)$/m.exec(body)?.[1] ?? '').trim()
    || firstLine(body);
  return { url: String(resolved ?? target), title, text: body };
}
