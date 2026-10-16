// Text completion for outreach prose: the omp subscription CLI (drafter/reviewer/light roles) and one direct
// HTTP chat endpoint (DeepSeek v4 Flash). Backends arrive as arguments, so nothing personal or model-specific
// lives here; the CLI supplies them from the ignored config.json.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-shot calls must not load or grow the CLI's long-term memory: recall per call is slow and grows with the bank.
const OMP_OVERLAY = fileURLToPath(new URL('./omp-overlay.yml', import.meta.url));

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_MAX_TIME = '120s';

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

// `--max-time` accepts omp's duration syntax (e.g. "300s", "45s", "2m"); a raw number is read as seconds.
function durationSeconds(value, fallback) {
  const text = String(value ?? fallback).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(text);
  if (!match) throw new Error(`invalid maxTime: ${text}`);
  const n = Number(match[1]);
  switch ((match[2] ?? 's').toLowerCase()) {
    case 'ms': return n / 1_000;
    case 'm': return n * 60;
    case 'h': return n * 3_600;
    default: return n;
  }
}

function checkText(value, what) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${what} must be a non-empty string`);
  return value;
}

function checkBackend(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('backend spec must be an object');
  if (spec.backend === 'omp') {
    checkText(spec.model, 'backends[role].model');
    return { backend: 'omp', model: spec.model, thinking: spec.thinking ?? 'minimal', maxTime: spec.maxTime ?? DEFAULT_MAX_TIME };
  }
  if (spec.backend === 'deepseek' || spec.backend === 'openai-compatible') {
    checkText(spec.model, 'backends[role].model');
    checkText(spec.endpoint, 'backends[role].endpoint');
    checkText(spec.apiKeyEnv, 'backends[role].apiKeyEnv');
    return { backend: 'deepseek', model: spec.model, endpoint: spec.endpoint, apiKeyEnv: spec.apiKeyEnv };
  }
  throw new TypeError(`backends[role].backend must be "omp" or "deepseek", got ${JSON.stringify(spec.backend)}`);
}

// The DeepSeek v4 Flash native pairing is the one request shape whose reasoning level this module sets, matching
// how the planner transport calls it (lowest reasoning effort); any other endpoint gets a standard chat request.
function isDeepseekV4Flash(spec) {
  return spec.backend === 'deepseek' && spec.endpoint === DEEPSEEK_ENDPOINT && spec.model === DEEPSEEK_MODEL;
}

async function runHttp(spec, system, prompt) {
  const apiKey = process.env[spec.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${spec.apiKeyEnv}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let response;
  let body;
  try {
    response = await fetch(spec.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: spec.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        ...(isDeepseekV4Flash(spec) ? { reasoning_effort: 'low' } : {}),
      }),
      signal: controller.signal,
    });
    body = await response.json().catch(() => undefined);
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'LLM request timed out.' : `LLM request failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`LLM request failed (${detail}).`);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM output could not be read.');
  if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('LLM output exceeded the safe limit.');
  return text;
}

// Mirrors the planner transport's spawn flags: one-shot omp, no session, text mode, memory-free overlay.
function runOmp(spec, system, prompt) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('omp', [
        '-p', '--no-session', '--mode', 'text', '--config', OMP_OVERLAY,
        '--model', spec.model,
        '--thinking', spec.thinking, '--hide-thinking', '--no-tools',
        '--no-extensions', '--no-skills', '--no-rules', '--max-time', spec.maxTime,
        '--system-prompt', system, prompt,
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('LLM process could not start.'));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];
    const timer = setTimeout(() => fail('LLM process timed out.'), durationSeconds(spec.maxTime, DEFAULT_MAX_TIME) * 1_000 + 5_000);

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

    child.on('error', () => fail('LLM process could not run.'));
    child.stdout.on('error', () => fail('LLM output could not be read.'));
    child.stderr.on('error', () => fail('LLM output could not be read.'));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        fail('LLM output exceeded the safe limit.');
        return;
      }
      chunks.push(chunk);
    });
    // Count and discard stderr: it is never retained, logged, or echoed.
    child.stderr.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ERROR_BYTES) fail('LLM error output exceeded the safe limit.');
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        fail('LLM process failed.');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, stdoutBytes).toString('utf8'));
    });
  });
}

/**
 * One model call for an outreach role.
 *
 * @param {{role:string, system:string, prompt:string}} call
 * @param {Record<string, object>} backends role -> backend spec ({backend:'omp', model, thinking, maxTime}
 *   or {backend:'deepseek', model, endpoint, apiKeyEnv})
 * @returns {Promise<string>} the model's raw text output
 */
export async function complete({ role, system, prompt }, backends) {
  checkText(role, 'role');
  checkText(system, 'system');
  checkText(prompt, 'prompt');
  if (!backends || typeof backends !== 'object') throw new TypeError('backends must be an object');
  if (!(role in backends)) throw new Error(`no backend configured for role "${role}"`);
  const spec = checkBackend(backends[role]);
  return spec.backend === 'omp' ? runOmp(spec, system, prompt) : runHttp(spec, system, prompt);
}
