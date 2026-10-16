// Cost views for report.mjs. Every model call is metered into a run's summary row (lib/trace.mjs `meter`) under
// its role bucket: `jev` (driver), `deepseek` (planner), `writer`. An HTTP backend's call carries a bill — the
// provider's own `usage.cost`, or DeepSeek's list price from its token counts; an omp call is a subscription call
// with no bill and, from 2026-10-16, estimated token counts. The views below separate the two: what the API keys
// pay per day and per purpose, what the subscription calls would cost at the list price OpenRouter publishes for
// the same model, and what the providers themselves say they billed.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireSecret } from '../config.mjs';
import { traceEvents } from './traces.mjs';

const BILLING = fileURLToPath(new URL('../../runs/billing.jsonl', import.meta.url));
const ROLES = { jev: 'driver', deepseek: 'planner', writer: 'writer' };
const money = n => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '–');
const k = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const sum = (list, f) => list.reduce((total, item) => total + f(item), 0);
const median = list => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0);
const model = (row, name) => row.models?.[name] ?? { calls: 0, failed: 0, ms: 0, cost: 0, input: 0, output: 0 };

// The configured model behind each meter bucket and how it is paid. A planner call the DeepSeek key could not pay
// for (an unpaid balance, a timeout) was served by the fallback omp model under the same bucket; the summary row
// cannot tell them apart, so a planner call with no cost and no tokens is counted as a fallback call.
export function buckets() {
  const { driver, planner, fallback, writer } = loadConfig().models;
  const paid = spec => (spec.backend === 'omp' ? 'subscription' : 'api');
  return {
    jev: { role: 'driver', model: driver.model, paid: paid(driver) },
    deepseek: { role: 'planner', model: planner.model, paid: paid(planner), fallback: fallback.model },
    writer: { role: 'writer', model: writer.model, paid: paid(writer) },
  };
}

// OpenRouter's published per-token prices for the configured models (its ids write "claude-sonnet-5.5" where the
// config writes "claude-sonnet-5-5"). Empty when offline; the caller then prints token counts without a price.
export async function listPrices(ids) {
  const variants = id => [id, id.replace(/-(\d+)-(\d+)$/, '-$1.$2')];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    const { data } = await response.json();
    const prices = {};
    for (const id of ids) {
      const hit = data.find(entry => variants(id).includes(entry.id));
      if (hit && Number(hit.pricing?.prompt) >= 0) prices[id] = { prompt: Number(hit.pricing.prompt), completion: Number(hit.pricing.completion) };
    }
    return prices;
  } catch {
    return {};
  }
}

// What a subscription bucket's calls would cost at the list price, from the estimated token counts; null before
// tokens were metered or without a price.
const equivalent = (totals, price) => (price && (totals.input || totals.output)
  ? totals.input * price.prompt + totals.output * price.completion : null);

// Per UTC day: runs, submits, what the API keys paid (driver + planner), the per-submit price, and the
// subscription calls' size and list-price equivalent.
export async function days(rows) {
  const info = buckets();
  const prices = await listPrices([...new Set(Object.values(info).map(bucket => bucket.model))]);
  const byDay = new Map();
  for (const row of rows) (byDay.get(row.t.slice(0, 10)) ?? byDay.set(row.t.slice(0, 10), []).get(row.t.slice(0, 10))).push(row);
  const apiCost = row => sum(Object.entries(info).filter(([, bucket]) => bucket.paid === 'api'), ([name]) => model(row, name).cost);
  console.log(['day'.padEnd(10), 'runs'.padStart(5), 'subm'.padStart(5), 'rate'.padStart(5), 'api $'.padStart(8), '$/subm'.padStart(8),
    'driver'.padStart(8), 'planner'.padStart(8), 'median'.padStart(7), 'sub.calls'.padStart(10), 'sub.tokens'.padStart(11), 'sub.list$'.padStart(10)].join(' '));
  for (const [day, list] of [...byDay].sort()) {
    const submitted = list.filter(row => row.outcome === 'submitted').length;
    const api = sum(list, apiCost);
    const sub = { calls: 0, input: 0, output: 0, list: 0, priced: false };
    for (const [name, bucket] of Object.entries(info)) {
      if (bucket.paid !== 'subscription') continue;
      const totals = { calls: sum(list, row => model(row, name).calls), input: sum(list, row => model(row, name).input), output: sum(list, row => model(row, name).output) };
      sub.calls += totals.calls; sub.input += totals.input; sub.output += totals.output;
      const price = equivalent(totals, prices[bucket.model]);
      if (price !== null) { sub.list += price; sub.priced = true; }
    }
    console.log([day.padEnd(10), String(list.length).padStart(5), String(submitted).padStart(5), pct(submitted, list.length).padStart(5),
      money(api).padStart(8), (submitted ? money(api / submitted) : '–').padStart(8),
      money(sum(list, row => model(row, 'jev').cost)).padStart(8), money(sum(list, row => model(row, 'deepseek').cost)).padStart(8),
      `${Math.round(median(list.map(row => row.secs ?? 0)))}s`.padStart(7),
      String(sub.calls).padStart(10), (sub.input || sub.output ? `${k(sub.input)}/${k(sub.output)}` : '–').padStart(11),
      (sub.priced ? money(sub.list) : '–').padStart(10)].join(' '));
  }
  const paid = Object.entries(info).map(([name, bucket]) => `${bucket.role} ${bucket.model} (${bucket.paid === 'api' ? 'API key' : 'omp subscription'})`);
  console.log(`\n  ${paid.join('; ')}.`);
  console.log('  api $ is what the keys were billed (driver as reported by OpenRouter; planner at DeepSeek list price from its token counts).');
  console.log('  sub.* are the subscription calls: count, estimated input/output tokens (metered from 2026-10-16), and their price at the');
  console.log(`  model's OpenRouter list rate${Object.keys(prices).length ? '' : ' (price lookup failed: offline)'} — what they would cost on an API key, not a bill.`);
}

// Per role and purpose over the selected rows' traces: calls, tokens, billed cost, and the subscription calls'
// list-price equivalent. Reads one trace per row.
export async function purposes(rows) {
  const info = buckets();
  const prices = await listPrices([...new Set(Object.values(info).map(bucket => bucket.model))]);
  const totals = new Map();
  let traced = 0;
  for (const { events } of traceEvents(rows, ['call'])) {
    traced++;
    for (const event of events) {
      const key = `${event.model}|${event.purpose ?? '?'}`;
      const t = totals.get(key) ?? totals.set(key, { calls: 0, failed: 0, ms: 0, cost: 0, input: 0, output: 0 }).get(key);
      t.calls++; if (!event.ok) t.failed++; t.ms += event.ms ?? 0; t.cost += event.cost ?? 0; t.input += event.input ?? 0; t.output += event.output ?? 0;
    }
  }
  const billed = sum([...totals.values()], t => t.cost);
  console.log(`${traced} of ${rows.length} runs have a trace on disk.\n`);
  console.log(['role'.padEnd(8), 'purpose'.padEnd(10), 'paid by'.padEnd(13), 'calls'.padStart(6), 'fail'.padStart(5), 'avg s'.padStart(6),
    'in tok'.padStart(8), 'out tok'.padStart(8), 'billed'.padStart(9), 'share'.padStart(6), 'list $'.padStart(9)].join(' '));
  for (const [key, t] of [...totals].sort((a, b) => b[1].cost - a[1].cost || b[1].calls - a[1].calls)) {
    const [name, purpose] = key.split('|');
    const bucket = info[name] ?? { role: name, paid: '?', model: '' };
    // A planner call with neither bill nor tokens was served by the omp fallback (see buckets()).
    const paid = bucket.paid === 'api' && name === 'deepseek' && !t.cost && !t.input ? `omp (fallback)` : bucket.paid === 'api' ? 'API key' : 'subscription';
    const list = bucket.paid === 'subscription' ? equivalent(t, prices[bucket.model]) : null;
    console.log([(ROLES[name] ?? name).padEnd(8), purpose.padEnd(10), paid.padEnd(13), String(t.calls).padStart(6), String(t.failed).padStart(5),
      (t.ms / t.calls / 1000).toFixed(1).padStart(6), k(t.input).padStart(8), k(t.output).padStart(8),
      money(t.cost).padStart(9), pct(t.cost, billed).padStart(6), (list === null ? '–' : money(list)).padStart(9)].join(' '));
  }
  console.log(`\n  billed ${money(billed)} across the selected runs; list $ prices the subscription calls at OpenRouter's rate for ${info.writer.model} (estimate, no bill).`);
}

// What the providers say: OpenRouter's counters for the driver key (today, this week, this month, all time — the
// key may serve other tools too) and DeepSeek's balances, next to the metered spend over the same calendar windows
// (UTC). Each call appends a snapshot to runs/billing.jsonl; the delta since the previous snapshot is the spend the
// providers actually billed between two reports.
export async function billing(allRows) {
  const { driver, planner } = loadConfig().models;
  const now = new Date();
  const dayStart = now.toISOString().slice(0, 10);
  const monday = new Date(now); monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7)); monday.setUTCHours(0, 0, 0, 0);
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const metered = (name, from) => sum(allRows.filter(row => row.t >= from), row => model(row, name).cost);
  const snapshot = { t: now.toISOString() };
  const get = async (url, key) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      return await response.json();
    } finally { clearTimeout(timer); }
  };
  if (driver.backend === 'openrouter-decisions' || /openrouter\.ai/.test(driver.endpoint ?? '')) {
    try {
      const key = requireSecret(driver.apiKeyEnv);
      const [info, credits] = await Promise.all([get('https://openrouter.ai/api/v1/key', key), get('https://openrouter.ai/api/v1/credits', key)]);
      const d = info?.data ?? {}; const c = credits?.data ?? {};
      snapshot.openrouter = { usage: d.usage, daily: d.usage_daily, weekly: d.usage_weekly, monthly: d.usage_monthly, credits: c.total_credits, remaining: c.total_credits - c.total_usage };
      console.log(`OpenRouter (driver key, ${driver.model}) — billed vs metered driver spend, UTC calendar windows`);
      console.log(`  today      billed ${money(d.usage_daily ?? 0)}   metered ${money(metered('jev', dayStart))}`);
      console.log(`  this week  billed ${money(d.usage_weekly ?? 0)}   metered ${money(metered('jev', monday.toISOString()))}   (since Monday)`);
      console.log(`  this month billed ${money(d.usage_monthly ?? 0)}   metered ${money(metered('jev', monthStart))}`);
      console.log(`  all time   billed ${money(d.usage ?? 0)}   metered ${money(metered('jev', ''))}   (the key predates this ledger and may serve other tools)`);
      console.log(`  credits ${money(c.total_credits ?? 0)}, remaining ${money(snapshot.openrouter.remaining ?? 0)}; OpenRouter's daily counter lags live usage by up to a day.`);
    } catch (error) {
      console.log(`OpenRouter: ${error.message}`);
    }
  }
  if (/deepseek\.com/.test(planner.endpoint ?? '')) {
    try {
      const body = await get('https://api.deepseek.com/user/balance', requireSecret(planner.apiKeyEnv));
      const balances = Object.fromEntries((body?.balance_infos ?? []).map(b => [b.currency, Number(b.total_balance)]));
      snapshot.deepseek = { available: body?.is_available, ...balances };
      console.log(`\nDeepSeek (planner key, ${planner.model}) — balance ${Object.entries(balances).map(([cur, v]) => `${cur} ${v.toFixed(2)}`).join(', ')}${body?.is_available ? '' : ' (NOT available: calls fall back to the omp model)'}`);
      console.log(`  metered planner spend: today ${money(metered('deepseek', dayStart))}, this week ${money(metered('deepseek', monday.toISOString()))}, this month ${money(metered('deepseek', monthStart))} (list price from token counts; DeepSeek publishes no usage counter).`);
    } catch (error) {
      console.log(`DeepSeek: ${error.message}`);
    }
  }
  let previous = null;
  try {
    const lines = readFileSync(BILLING, 'utf8').trim().split('\n').filter(Boolean);
    previous = JSON.parse(lines[lines.length - 1]);
  } catch { /* first snapshot */ }
  if (previous?.openrouter && snapshot.openrouter) {
    const billedDelta = (snapshot.openrouter.usage ?? 0) - (previous.openrouter.usage ?? 0);
    const meteredDelta = sum(allRows.filter(row => row.t >= previous.t && row.t < snapshot.t), row => model(row, 'jev').cost);
    console.log(`\nSince the last snapshot (${previous.t.slice(0, 16).replace('T', ' ')} UTC): OpenRouter billed ${money(billedDelta)}, metered driver ${money(meteredDelta)}` +
      (previous.deepseek?.CNY !== undefined && snapshot.deepseek?.CNY !== undefined ? `; DeepSeek balance moved CNY ${(snapshot.deepseek.CNY - previous.deepseek.CNY).toFixed(2)}` : '') + '.');
  }
  appendFileSync(BILLING, `${JSON.stringify(snapshot)}\n`);
}
