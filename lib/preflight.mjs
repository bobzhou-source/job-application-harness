// Pre-run checks shared by queue.mjs: a cheap, model-free posting check and the recent host/tenant stop history
// that defers a row before Chrome opens. Nothing here imports the browser or a model client.

import { siteKey } from './answers.mjs';

// Queue retries these in-run; they are not evidence that the employer's posting is unusable.
const TRANSIENT_STOP = /^(?:driver-error|planner-error|implementation-error|action-outcome-unknown|network-outage|site-down|external-site-failed-to-load|no-summary)$/;
// Only reasons whose repeat says the employer's flow itself is blocked are deferred from history. A field, a closed
// posting, or an ineligible page is about one posting/harness path: counting it across a tenant would skip the next
// posting that works there (the 10-16/17 replay found false skips for those broad sets); a consult budget counts only
// after many repeats.
const DEFERRABLE_STOP = /^(?:captcha|gate:mfa|credential(?:-[a-z-]+)?|needs-user-(?:work-history|document|sensitive|email-verification)|iteration-limit|planner-refused-loop|consult-limit)$/;
// Replay-calibrated repeat counts: iteration-limit costs a full run each time and never submitted after two; consult-
// limit is a per-run budget, so only twelve repeats on one employer are evidence; planner-refused-loop needed six.
const DEFERRAL_LIMIT = new Map([['iteration-limit', 2], ['planner-refused-loop', 6], ['consult-limit', 12]]);
const KNOWN_CODE = /^(?:posting-unavailable|ineligible-(?:degree|schedule|title)|needs-user(?:-[a-z-]+)?|captcha|gate|credential(?:-[a-z-]+)?|account-blocked|site-down|external-site-failed-to-load|network-outage|driver-error|planner-error|implementation-error|action-outcome-unknown|consult-limit|iteration-limit|planner-refused-loop|invalid-plan|wrong-answer|false-submit|submit-rejected|already-applied)$/;
const CLOSED_TEXT = /(?:job|posting|position|requisition).{0,80}(?:no longer (?:available|accepting)|is closed|closed|has expired|has been filled|not found|could not be found)|not accepting applications|no longer accepting applications|page (?:you are looking for )?(?:doesn['’]t|does not) exist|requested (?:job|position|posting) could not be found|registration (?:is )?closed/i;

const words = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const labelKey = value => words(value).slice(0, 60);

// One stable key for the reason a run stopped. Detail that differs between two runs on the same blocker (a field's
// wording aside from case/punctuation) is folded; unrelated English prose keeps its own key instead of joining a
// generic bucket.
export function normalizeStopReason(reason) {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/^no summary\b/i.test(text)) return 'no-summary';
  const code = text.match(/^([a-z][a-z-]+)(?:\b|:)/i)?.[1]?.toLowerCase() ?? '';
  if (code === 'posting-unavailable') return 'posting-unavailable';
  if (/^ineligible-(?:degree|schedule|title)\b/i.test(text)) return `ineligible-${text.match(/^ineligible-([a-z]+)/i)[1].toLowerCase()}`;
  if (/^needs-user-field\b/i.test(text)) {
    const field = text.match(/^needs-user-field\s+"([^"]+)"/i)?.[1];
    return field ? `needs-user-field:${labelKey(field)}` : 'needs-user-field';
  }
  if (/^needs-user-(?:work-history|document|email-verification|sensitive)\b/i.test(text)) return text.match(/^needs-user-[a-z-]+/i)[0].toLowerCase();
  if (code === 'gate') {
    const kind = text.match(/^gate\s+([a-z-]+)/i)?.[1]?.toLowerCase();
    if (kind && /captcha|human|robot/.test(kind)) return 'captcha';
    return kind ? `gate:${kind}` : 'gate';
  }
  if (/captcha|human[- ]verification|anti-bot|robot/i.test(text)) return 'captcha';
  if (/^credential(?:-[a-z-]+)?\b/i.test(text)) return text.match(/^credential(?:-[a-z-]+)?/i)[0].toLowerCase();
  if (/already (?:applied|submitted)|application was already submitted|previously submitted/i.test(text)) return 'already-applied';
  if (/^account creation\b|sign.?in (?:was )?rejected|password (?:was )?rejected|account (?:is )?blocked/i.test(text)) return 'credential-account';
  if (/last 4 digits|social security number|\bSSN\b/i.test(text)) return 'needs-user-sensitive';
  if (CLOSED_TEXT.test(text)) return 'posting-unavailable';
  if (KNOWN_CODE.test(code)) return code;
  return `other:${words(text).slice(0, 80)}`;
}

export function isTransientStop(reason) {
  return TRANSIENT_STOP.test(normalizeStopReason(reason));
}

const DEFAULT_STOP_LIMIT = 3;
const DEFAULT_WINDOW_MS = 24 * 3600_000;

// The employer identity: the hostname when it names one employer, else the tenant slug on a shared ATS host. The
// shared Greenhouse/Lever/Ashby hostname itself is not an employer, so one tenant's plan loop cannot defer another
// employer's rows.
function scopesFor(url) {
  const host = new URL(url).hostname.toLowerCase();
  const tenant = siteKey(url).toLowerCase();
  return [tenant === host ? `host:${host}` : `tenant:${tenant}`];
}

// Recent stop counts by employer identity. Repeated employer gates (captcha/MFA, credentials, missing work-history/
// document/sensitive data), iteration/planner loops, and a repeatedly exhausted consult budget are about the flow;
// a field, closed posting, or ineligible page is per-posting and not counted. A submit clears every reason there: a
// site that starts accepting again is not held by its old stops. Rows older than windowMs do not count, so a
// deferral expires instead of stranding a host forever.
// Loop reasons (iteration-limit, planner-refused-loop, consult-limit) describe the driver, not the site: they count
// only on rows the running commit produced (`code`), so a fixed driver bug does not keep deferring its victims.
const LOOP_STOP = /^(?:iteration-limit|planner-refused-loop|consult-limit)$/;
export function historyDeferrals(rows, { limit = DEFAULT_STOP_LIMIT, now = Date.now(), windowMs = DEFAULT_WINDOW_MS, code = null } = {}) {
  const since = now - windowMs;
  const ordered = rows
    .filter(row => row?.job && Number.isFinite(Date.parse(row.t)))
    .map(row => ({ ...row, at: Date.parse(row.t) }))
    .filter(row => row.at >= since && row.at <= now)
    .sort((a, b) => a.at - b.at);
  const counts = new Map();
  for (const row of ordered) {
    let scopes;
    try { scopes = scopesFor(row.job); } catch { continue; }
    if (row.outcome === 'submitted') {
      for (const scope of scopes) {
        const prefix = `${scope}\0`;
        for (const key of [...counts.keys()]) if (key.startsWith(prefix)) counts.delete(key);
      }
      continue;
    }
    const reason = normalizeStopReason(row.reason);
    if (!reason || isTransientStop(reason) || !DEFERRABLE_STOP.test(reason)) continue;
    if (LOOP_STOP.test(reason) && (!code || row.code !== code)) continue;
    for (const scope of scopes) {
      const key = `${scope}\0${reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const found = new Map();
  for (const [key, count] of counts) {
    const split = key.indexOf('\0');
    const scope = key.slice(0, split);
    const reason = key.slice(split + 1);
    if (count < (DEFERRAL_LIMIT.get(reason) ?? limit)) continue;
    const prior = found.get(scope);
    if (!prior || count > prior.count || (count === prior.count && reason < prior.reason)) found.set(scope, { reason, count });
  }
  return found;
}

// The strongest deferral for this row's host or tenant, or null.
export function deferralFor(deferrals, url) {
  let scopes;
  try { scopes = scopesFor(url); } catch { return null; }
  let best = null;
  for (const scope of scopes) {
    const entry = deferrals.get(scope);
    if (!entry) continue;
    if (!best || entry.count > best.count || (entry.count === best.count && entry.reason < best.reason)) best = { key: scope, ...entry };
  }
  return best;
}

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' };
const MAX_BODY = 1_000_000;

async function readBounded(response, max = MAX_BODY) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function get(url, { method = 'GET', timeoutMs = 3500, json = false } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...UA, ...(json ? { accept: 'application/json' } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = json || method !== 'HEAD' ? await readBounded(response) : null;
  let body = null;
  if (json && text) { try { body = JSON.parse(text); } catch { /* an HTML interstitial is not a posting record */ } }
  return { response, body };
}

const closed = (source, detail) => ({ state: 'closed', source, detail });
const open = (source, detail) => ({ state: 'open', source, detail });
const unknown = (source, detail) => ({ state: 'unknown', source, detail });

// A definitive ATS record miss, or a 404/410 from the posting itself. Everything else is unknown, never closed:
// anti-bot 403s, timeouts, redirects to a careers home, and sites that serve a 200 page for a closed posting are
// all retried in Chrome, so a preflight error can never discard a live application.
export async function postingStatus(url, { timeoutMs = 3500 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return unknown('url', 'malformed URL'); }
  if (!/^https?:$/.test(parsed.protocol)) return unknown('url', 'not HTTP');
  const host = parsed.hostname.toLowerCase();

  try {
    let match;
    if ((match = host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i))) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0]) ? parts[1] : parts[0];
      const rest = parts.slice(parts.indexOf(site) + 1).join('/');
      if (!site || !rest) return unknown('workday', 'not a posting path');
      const endpoint = `https://${parsed.host}/wday/cxs/${match[1]}/${site}/${rest}`;
      const { response, body } = await get(endpoint, { json: true, timeoutMs });
      if (response.status === 404 || response.status === 410 || body?.errorCode === 'HTTP_404') return closed('workday', `HTTP ${response.status || body?.httpStatus || 404}`);
      if (response.ok && body?.jobPostingInfo) return open('workday', 'jobPostingInfo present');
      return unknown('workday', `HTTP ${response.status}${body?.message ? ` ${body.message}` : ''}`.slice(0, 120));
    }

    if (/greenhouse\.io$/i.test(host) && (match = parsed.pathname.match(/^\/(?:embed\/job_app\?for=)?([^/]+)\/jobs\/(\d+)/))) {
      const endpoint = `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}`;
      const { response } = await get(endpoint, { json: true, timeoutMs });
      if (response.status === 404 || response.status === 410) return closed('greenhouse', `HTTP ${response.status}`);
      if (response.ok) return open('greenhouse', 'job record present');
      return unknown('greenhouse', `HTTP ${response.status}`);
    }

    if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
      const [, company, id] = parsed.pathname.split('/');
      if (company && id) {
        const api = host === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co';
        const { response, body } = await get(`https://${api}/v0/postings/${company}/${id}`, { json: true, timeoutMs });
        if (response.status === 404 || response.status === 410 || body?.ok === false) return closed('lever', `HTTP ${response.status}${body?.ok === false ? ' ok=false' : ''}`);
        if (response.ok && body?.id) return open('lever', 'posting record present');
        return unknown('lever', `HTTP ${response.status}`);
      }
    }

    if (host === 'jobs.ashbyhq.com') {
      const [, company, id] = parsed.pathname.split('/');
      if (company && id) {
        const { response, body } = await get(`https://api.ashbyhq.com/posting-api/job-board/${company}`, { json: true, timeoutMs });
        if (response.ok && Array.isArray(body?.jobs)) {
          const live = body.jobs.some(job => job.id === id || job.jobUrl?.includes(id));
          return live ? open('ashby', 'job present on board') : closed('ashby', 'job absent from open board');
        }
        return unknown('ashby', `HTTP ${response.status}`);
      }
    }

    const head = await get(parsed.href, { method: 'HEAD', timeoutMs });
    if (head.response.status === 404 || head.response.status === 410) {
      // Some servers answer HEAD wrongly; confirm a miss with a body request before calling a posting closed.
      const confirmed = await get(parsed.href, { timeoutMs });
      if (confirmed.response.status === 404 || confirmed.response.status === 410) {
        return closed('http', `HTTP ${confirmed.response.status}`);
      }
      return unknown('http', `HEAD ${head.response.status}; GET ${confirmed.response.status}`);
    }
    return unknown('http', `HTTP ${head.response.status}`);
  } catch (error) {
    return unknown('network', String(error?.name || error).slice(0, 80));
  }
}
