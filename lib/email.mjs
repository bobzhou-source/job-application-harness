// lib/email.mjs — read-only Gmail access for emailed verification codes and account links, through the user's own
// multi-gmail MCP server (a configured one-shot stdio child; search_emails / get_email / list_accounts only).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getDomain } from 'tldts';
import { loadConfig } from './config.mjs';

// Mailbox server, token/OAuth paths, enablement, and account label all come from the ignored config.json.
let configCache;
function config() {
  return (configCache ??= loadConfig());
}

const READ_TOOLS = new Set(['search_emails', 'get_email', 'list_accounts']);
const CALL_TIMEOUT_MS = 30_000;
// Deterministic wait before each inbox check, from the moment the code was requested.
export const POLL_SCHEDULE_MS = [10_000, 30_000, 180_000, 300_000];

// Whether this machine is configured to read a mailbox at all.
export function enabled() {
  return config().email.enabled;
}

// The label of the mailbox every call targets.
export function accountLabel() {
  return config().email.accountLabel;
}

// Email automation is off by default: a clone stops cleanly and completes verification by hand instead of failing
// deep inside a mailbox read.
function requireEmail() {
  const email = config().email;
  if (!email.enabled) {
    throw new Error('Email automation disabled; complete verification manually (set email.enabled in config.json).');
  }
  return email;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function call(tool, args) {
  if (!READ_TOOLS.has(tool)) throw new Error(`gmail ${tool} is not read-only`);
  return new Promise((resolve, reject) => {
    const child = spawn('node', [config().email.mcpServer], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffered = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`gmail ${tool} timed out`)), CALL_TIMEOUT_MS);
    child.on('error', (error) => finish(error));
    child.on('exit', () => finish(new Error(`gmail child exited before answering ${tool}`)));
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id !== 2) continue;
        if (message.error) return finish(new Error(`gmail ${tool} failed: ${message.error.message ?? 'error'}`));
        const text = (message.result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        if (message.result?.isError) return finish(new Error(`gmail ${tool} failed: ${text}`));
        return finish(null, text);
      }
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'job-app', version: '1.0.0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
  });
}

// The Gmail account label whose address is `address`, or null when that inbox is not connected. A masked address
// ("a***e@example.com") matches the one connected inbox whose visible characters agree: same domain, the shown
// prefix and suffix of the local part, at least as long as the mask.
export async function accountFor(address) {
  requireEmail();
  const listed = await call('list_accounts', {});
  const target = String(address).trim().toLowerCase();
  const [local, domain] = target.split('@');
  const masked = /\*/.test(local ?? '') ? /^([^*]*)\*+([^*]*)$/.exec(local) : null;
  const hits = [];
  for (const match of listed.matchAll(/\[([^\]]+)\]\s*→\s*(\S+)/g)) {
    const known = match[2].toLowerCase();
    if (known === target) return match[1];
    const [knownLocal, knownDomain] = known.split('@');
    if (masked && knownDomain === domain && knownLocal.length >= masked[1].length + masked[2].length
      && knownLocal.startsWith(masked[1]) && knownLocal.endsWith(masked[2])) hits.push(match[1]);
  }
  return hits.length === 1 ? hits[0] : null;
}

// Messages received in `account` at or after `since` (ms epoch), newest first: [{id, from, subject, date, body}].
// Code mails are searched by their wording, so a busy inbox's newsletters do not push them out of the result page.
async function messagesSince(account, since, query = 'in:anywhere newer_than:1d (code OR verification OR verify OR passcode OR "one-time")') {
  const listing = await call('search_emails', { account, query, max_results: 10 });
  const found = [];
  for (const block of listing.split(/\n---\n/)) {
    const id = /^ID:\s*(\S+)/m.exec(block)?.[1];
    const date = Date.parse(/^Date:\s*(.+)$/m.exec(block)?.[1] ?? '');
    if (!id || !(date >= since)) continue;
    found.push({ id, date, from: /^From:\s*(.+)$/m.exec(block)?.[1] ?? '', subject: /^Subject:\s*(.+)$/m.exec(block)?.[1] ?? '' });
  }
  found.sort((a, b) => b.date - a.date);
  for (const message of found) {
    message.body = mailText(await call('get_email', { account, message_id: message.id })).slice(0, 4000);
  }
  return found;
}

// An HTML-only mail arrives as raw markup whose head and styles fill the first several KB, pushing the code out of
// any bounded excerpt: reduce it to its visible text first.
function mailText(raw) {
  if (!/<(html|body|table|div|p|br)\b/i.test(raw)) return raw;
  return raw
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

// Poll `account` on POLL_SCHEDULE_MS for mail received since `since`; `pick(messages)` (the planner)
// returns the code or null. Returns the code, or null once the schedule is exhausted.
export async function waitForCode(account, since, pick, onPoll = () => {}, schedule = POLL_SCHEDULE_MS) {
  requireEmail();
  for (const wait of schedule) {
    onPoll(wait);
    await delay(wait);
    // A failed inbox read (network blip, token refresh) is one missed poll; only the last poll's failure propagates.
    let messages;
    try { messages = await messagesSince(account, since); }
    catch (error) { if (wait === schedule.at(-1)) throw error; continue; }
    if (!messages.length) continue;
    const code = await pick(messages);
    if (code) return code;
  }
  return null;
}

// Links of a message's HTML part ([{href, context}]): button-only emails ("click here") carry the verify link only
// there. Read with the multi-gmail server's stored OAuth token (read-only GET; Bun lacks the node:sqlite it uses).
async function htmlLinks(account, id) {
  const { Database } = await import('bun:sqlite');
  const db = new Database(config().email.tokenDatabase, { readonly: true });
  const row = db.query('select email, refresh_token from accounts where label = ? or email = ?').get(account, account);
  db.close();
  if (!row?.refresh_token) return [];
  const creds = JSON.parse(readFileSync(config().email.oauthCredentials, 'utf8'));
  const { client_id, client_secret } = creds.installed ?? creds.web;
  const token = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id, client_secret, refresh_token: row.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).then(response => response.json());
  if (!token.access_token) return [];
  const message = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).then(response => response.json());
  const parts = [];
  const walk = part => { if (!part) return; parts.push(part); for (const child of part.parts ?? []) walk(child); };
  walk(message.payload);
  const html = parts.filter(part => part.mimeType === 'text/html' && part.body?.data)
    .map(part => Buffer.from(part.body.data, 'base64url').toString('utf8')).join('\n');
  const text = value => value.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
  const links = [];
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const before = text(html.slice(Math.max(0, match.index - 600), match.index)).slice(-150);
    const after = text(html.slice(match.index + match[0].length, match.index + match[0].length + 600)).slice(0, 150);
    links.push({ href: match[1].replace(/&amp;/gi, '&'), context: `${before} ${text(match[2])} ${after}` });
  }
  return links;
}

const FORBIDDEN_LINK = /unsubscribe|marketing|newsletter|preferences|opt.?out|privacy|support|help ?center|terms/i;
const RESET = /\breset\b[\s\S]{0,40}\bpassword\b|\bpassword\b[\s\S]{0,40}\breset\b/i;
// What each kind of account email looks like: Gmail query words, the message test, and the link test (link path
// words plus surrounding text).
const KINDS = {
  verify: {
    words: '{verify verification activate activation confirm confirmation}',
    message: text => /\b(?:verif(?:y|ication)|activat(?:e|ion)|confirm(?:ation)?)\b/i.test(text)
      && /\b(account|email|e-mail|registration)\b/i.test(text) && !RESET.test(text),
    link: /\b(?:verif(?:y|ication)|activat(?:e|ion)|confirm(?:ation)?)\b/i,
  },
  reset: {
    words: '{reset password}',
    message: text => RESET.test(text),
    link: /\breset\b|\bpassword\b|\bpasswordreset\b/i,
  },
};

// One inbox check for the single account link of `kind` ('verify' account/email verification, or 'reset' password
// reset) a site sent since `since`. A message is the site's when its sender is on the site's registrable domain
// (public-suffix parsing, not a last-two-label guess), or its link is on the site's exact host: multi-tenant
// platforms share a domain (every Workday tenant is on myworkdayjobs.com and mails from workday.com), so only the
// tenant's own host proves the link is this site's. A sender on the site's domain may link through a click-tracker
// (Roblox via sendgrid). Messages are checked newest first; returns null unless one message has exactly one
// qualifying link.
export async function findVerificationLink(account, since, site, kind = 'verify') {
  requireEmail();
  const spec = KINDS[kind];
  const host = new URL(site).hostname.toLowerCase();
  const domain = getDomain(host, { allowPrivateDomains: true });
  if (!domain || !spec) return null;
  const query = `in:anywhere after:${Math.floor(since / 1000)} ${spec.words}`;
  const messages = await messagesSince(account, since, query);
  for (const message of messages) {
    const sender = message.from.match(/[\w.!#$%&'*+/=?^`{|}~-]+@([a-z0-9.-]+)/i)?.[1];
    const senderOwned = !!sender && getDomain(sender, { allowPrivateDomains: true }) === domain;
    if (!spec.message(`${message.subject} ${message.body}`)) continue;
    const body = message.body.replace(/&amp;/gi, '&').replace(/&#(?:x26|38);/gi, '&');
    const links = [...body.matchAll(/https:\/\/[^\s<>"']+/gi)].map(match => ({
      href: match[0].replace(/[),.;]+$/, ''),
      context: body.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100),
    }));
    // The HTML part only when the text part names no qualifying link on the site's own domain.
    const plainOwned = links.some(({ href }) => { try { return new URL(href).hostname.toLowerCase() === host; } catch { return false; } });
    if (!plainOwned) links.push(...await htmlLinks(account, message.id).catch(() => []));
    const candidates = new Set();
    for (const { href, context } of links) {
      let link;
      try { link = new URL(href); } catch { continue; }
      const owned = link.hostname.toLowerCase() === host;
      if (link.protocol !== 'https:' || link.username || link.password || link.port || !(owned || senderOwned)
        || FORBIDDEN_LINK.test(`${link.pathname} ${link.search} ${context}`)
        || !spec.link.test(`${link.pathname.replace(/[^a-z]/gi, ' ')} ${context}`)) continue;
      candidates.add(link.href);
    }
    if (candidates.size === 1) return [...candidates][0];
  }
  return null;
}

// Poll on `schedule` (wait before each check) for findVerificationLink.
export async function waitForVerificationLink(account, since, site, onPoll = () => {}, schedule = [10_000, 30_000, 60_000], kind = 'verify') {
  requireEmail();
  for (const wait of schedule) {
    onPoll(wait);
    await delay(wait);
    const link = await findVerificationLink(account, since, site, kind);
    if (link) return link;
  }
  return null;
}
