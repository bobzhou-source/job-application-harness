// Backend transport for planner/writer calls: direct HTTP chat (with DeepSeek v4 Flash list-price
// accounting), the omp subscription subprocess, and the unpaid-role fallback for the rest of the run.

import { spawn } from 'node:child_process';
import * as runlog from '../trace.mjs';
import { loadConfig, requireSecret } from '../config.mjs';
import { TIMEOUT_MS, MAX_STDOUT_BYTES, MAX_STDERR_BYTES } from './limits.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';

// The ignored config.json is the single source of non-secret settings; the loader caches and freezes it.
let configCache;
export function config() {
  return (configCache ??= loadConfig());
}

// Roles whose configured HTTP backend answered 401/402 (or reported an insufficient balance) stay unusable for the
// rest of the run: their calls go to the configured fallback backend instead, so a lapsed balance never stops a run.
const unpaidRoles = new Set();

// DeepSeek list prices (USD per million tokens, from omp's model catalog for deepseek-v4-flash): cache-miss input,
// cache-hit input, output; half price outside the weekday UTC peak windows 01:00-04:00 and 06:00-10:00.
const DEEPSEEK_PRICE = { input: 0.3, cacheRead: 0.006, output: 1.2 };
function deepseekCost(usage, at = new Date()) {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5;
  const peak = weekday && ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600));
  const hit = Number(usage?.prompt_cache_hit_tokens) || 0;
  const miss = Number(usage?.prompt_cache_miss_tokens ?? (Number(usage?.prompt_tokens) || 0) - hit) || 0;
  const out = Number(usage?.completion_tokens) || 0;
  return (miss * DEEPSEEK_PRICE.input + hit * DEEPSEEK_PRICE.cacheRead + out * DEEPSEEK_PRICE.output) / 1e6 * (peak ? 1 : 0.5);
}

// HTTP chat backends are called directly: an omp subprocess adds ~47k tokens of its own context and tens of seconds
// per call. The DeepSeek v4 Flash native pairing is the one endpoint whose request shape and list-price accounting
// this module knows (lowest reasoning level, as the omp call ran it with --thinking minimal); every other endpoint or
// model gets a standard chat request and its provider-reported cost.
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

function isDeepseekV4Flash(spec) {
  return spec.backend === 'openai-compatible' && spec.endpoint === DEEPSEEK_ENDPOINT && spec.model === DEEPSEEK_MODEL;
}

async function runHttp(spec, prompt, systemPrompt, purpose, meterName) {
  const native = isDeepseekV4Flash(spec);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(spec.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${requireSecret(spec.apiKeyEnv)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: spec.model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        ...(native ? { reasoning_effort: 'low' } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    runlog.meter(meterName, { purpose, ms: Date.now() - started, ok: false });
    throw new Error(error?.name === 'AbortError' ? 'Planner process timed out.' : 'Planner process failed.');
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  const usage = body?.usage ?? {};
  // Only the known DeepSeek v4 Flash pairing is priced from list prices; anything else uses the provider's own
  // reported cost when it supplies one.
  const cost = Math.round((native ? deepseekCost(usage) : Number(usage.cost) || 0) * 1e7) / 1e7;
  runlog.meter(meterName, {
    purpose, ms: Date.now() - started, ok: response.ok, estimated: native, cost,
    input: Number(usage.prompt_tokens) || 0, cached: Number(usage.prompt_cache_hit_tokens) || 0, output: Number(usage.completion_tokens) || 0,
  });
  if (!response.ok) {
    const error = new Error(`Planner process failed (HTTP ${response.status}).`);
    error.unpaid = response.status === 401 || response.status === 402 || /insufficient balance/i.test(body?.error?.message ?? '');
    throw error;
  }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Planner output could not be read.');
  if (Buffer.byteLength(text, 'utf8') > MAX_STDOUT_BYTES) throw new Error('Planner output exceeded the safe limit.');
  return text;
}

// One model call for a configured role: 'planner' (escalations, plans, email codes) or 'writer' (applicant prose,
// which gets the long deadline). A role whose HTTP backend answers 401/402, or reports an insufficient balance,
// switches to the configured fallback backend for the rest of the run. A subscription role runs through omp instead:
// latency only, no per-call bill. Telemetry buckets by logical role (planner → 'deepseek', writer → 'writer')
// whichever backend or fallback served the call, so the author's cost accounting is unchanged.
export async function runPlanner(prompt, systemPrompt = SYSTEM_PROMPT, { role = 'planner', purpose = 'consult' } = {}) {
  const kind = unpaidRoles.has(role) ? 'fallback' : role;
  const spec = config().models[kind];
  const meterName = role === 'writer' ? 'writer' : 'deepseek';
  if (spec.backend !== 'omp') {
    try {
      return await runHttp(spec, prompt, systemPrompt, purpose, meterName);
    } catch (error) {
      if (!error.unpaid || kind !== role) throw error;
      unpaidRoles.add(role);
      runlog.trace('deepseek-unpaid', { message: error.message });
      return runPlanner(prompt, systemPrompt, { role, purpose });
    }
  }
  const started = Date.now();
  try {
    const text = await runOmp(prompt, systemPrompt, spec.model, role === 'writer');
    runlog.meter(meterName, { purpose, ms: Date.now() - started });
    return text;
  } catch (error) {
    runlog.meter(meterName, { purpose, ms: Date.now() - started, ok: false });
    throw error;
  }
}

function runOmp(prompt, systemPrompt, model, long) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('omp', [
        '-p', '--no-session', '--mode', 'text',
        '--model', model,
        '--thinking', long ? 'medium' : 'minimal', '--hide-thinking', '--no-tools',
        '--no-extensions', '--no-skills', '--no-rules', '--max-time', long ? '300s' : '45s',
        '--system-prompt', systemPrompt, prompt,
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('Planner process could not start.'));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];
    const timer = setTimeout(() => fail('Planner process timed out.'), long ? 305000 : TIMEOUT_MS);

    function fail(message) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      // SIGKILL bounds shutdown too; never wait for a cooperative CLI exit.
      try { child.kill('SIGKILL'); } catch { /* Already gone or unavailable. */ }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error(message));
    }

    child.on('error', () => fail('Planner process could not run.'));
    child.stdout.on('error', () => fail('Planner output could not be read.'));
    child.stderr.on('error', () => fail('Planner output could not be read.'));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('Planner output exceeded the safe limit.');
        return;
      }
      chunks.push(chunk);
    });
    // Count and discard stderr: it is never retained, logged, or echoed.
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) fail('Planner output exceeded the safe limit.');
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        fail('Planner process failed.');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, stdoutBytes).toString('utf8'));
    });
  });
}
