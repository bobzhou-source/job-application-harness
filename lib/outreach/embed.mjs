// lib/outreach/embed.mjs — EmbeddingGemma 2 text embeddings through a long-lived
// `uv run` Python worker (lib/outreach/py/embed.py) that speaks JSONL on stdin/stdout.
//
// The worker owns the model and an on-disk vector cache; this module owns the child
// process, request multiplexing, doc formatting, and the Float32Array conversions.
// Vectors are float32, L2-normalized, 768-d. Queries use the model's SearchQuery
// prompt (applied in Python); docs are formatted `title: X | text: Y` here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PY_DIR = fileURLToPath(new URL('./py', import.meta.url));
const READY_TIMEOUT_MS = Number(process.env.OUTREACH_EMBED_READY_TIMEOUT_MS ?? 900_000);
const REQUEST_CHUNK = 256;
const DIM = 768;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// The `title: X | text: Y` document format the model was trained to compare against
// a SearchQuery. Missing pieces collapse to an empty field rather than being dropped.
const docText = ({ title, text }) => `title: ${title ?? ''} | text: ${text ?? ''}`;

// Cache key: model (added by the worker) + doc id + text hash, so a re-run never
// re-embeds the same text and a changed abstract is never served from a stale row.
const docCacheKey = (id, text) => `${id}:sha256:${sha256(text)}`;

// This repo is public: never drop a multi-GB `.venv` (or any cache) inside it. The
// project environment lives beside the vector cache unless the caller says otherwise.
const DEFAULT_VENV = join(homedir(), '.cache', 'outreach-embeddings', 'venv');

/**
 * Start the embedding worker.
 *
 * @param {{cacheDir?: string, model?: string, device?: string, env?: Record<string,string>}} [opts]
 *   cacheDir is the on-disk vector cache directory (required in practice so the CLI
 *   keeps it under its own run/config dir, well away from this public repo).
 * @returns {Promise<{
 *   embedQueries(strings: string[]): Promise<Float32Array[]>,
 *   embedDocs(docs: Array<{id:string,title:string,text:string}>): Promise<Map<string,Float32Array>>,
 *   close(): Promise<void>,
 *   info: {model:string, device:string, dtype:string, dim:number, cacheDir:string},
 *   stats: {encodedDocs:number, encodedQueries:number, ms:number},
 * }>}
 */
export async function createEmbedder({ cacheDir, model, device, env = {} } = {}) {
  if (!cacheDir) throw new Error('createEmbedder needs a cacheDir (kept out of the public repo)');

  const childEnv = {
    ...process.env,
    ...env,
    PYTHONUNBUFFERED: '1',
    // Never leave __pycache__ beside the tracked sources.
    PYTHONDONTWRITEBYTECODE: '1',
    EMBED_CACHE_DIR: cacheDir,
    // Keep the uv environment out of this public repo; uv.lock (public package pins
    // only) is the sole file the worker may leave in lib/outreach/py.
    UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT || DEFAULT_VENV,
  };
  if (model) childEnv.EMBED_MODEL = model;
  if (device) childEnv.EMBED_DEVICE = device;

  const child = spawn('uv', ['run', '--project', PY_DIR, 'python', 'embed.py'], {
    cwd: PY_DIR,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });

  let stdoutBuf = '';
  let stderrTail = '';
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const failAll = (err) => {
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
    // A no-op once the ready promise has settled.
    readyReject(err);
  };

  child.on('error', (err) => {
    failAll(new Error(`embed worker could not start (uv): ${err.message}`));
  });

  // 'exit' fires as soon as the process is gone (even if a stdio pipe lingers), so a
  // dead worker is reported immediately instead of waiting out the ready timeout.
  child.on('exit', (code, signal) => {
    if (closed) return;
    closed = true;
    const reason = `embed worker exited (code ${code}, signal ${signal})`;
    failAll(new Error(stderrTail ? `${reason}: ${stderrTail.trim()}` : reason));
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON noise on stdout is ignored, never fatal
      }
      if (msg.id === 'ready') {
        readyResolve(msg);
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.ok === false) entry.reject(new Error(msg.error || 'embed worker error'));
      else entry.resolve(msg);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true;
    const reason = `embed worker exited (code ${code}, signal ${signal})`;
    failAll(new Error(stderrTail ? `${reason}: ${stderrTail.trim()}` : reason));
  });

  const timer = setTimeout(() => {
    if (closed) return;
    closed = true;
    failAll(new Error(`embed worker not ready after ${READY_TIMEOUT_MS}ms${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, READY_TIMEOUT_MS);
  timer.unref?.();

  const request = (payload) => {
    if (closed) return Promise.reject(new Error('embedder is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (err) => {
        if (!err) return;
        pending.delete(id);
        reject(err);
      });
    });
  };

  let info;
  try {
    const readyMsg = await ready;
    if (!readyMsg.ok) throw new Error(readyMsg.error || 'embed worker failed to load');
    info = {
      model: readyMsg.model,
      device: readyMsg.device,
      dtype: readyMsg.dtype ?? 'float32',
      dim: readyMsg.dim ?? DIM,
      cacheDir: readyMsg.cacheDir ?? cacheDir,
    };
  } catch (err) {
    clearTimeout(timer);
    if (!closed) {
      closed = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    throw err;
  }
  clearTimeout(timer);

  const stats = { encodedDocs: 0, encodedQueries: 0, ms: 0 };

  const toFloat32 = (row, what) => {
    if (!Array.isArray(row) || row.length !== info.dim) {
      throw new Error(`embed worker returned a malformed ${what} vector (len ${row?.length})`);
    }
    return Float32Array.from(row);
  };

  const encode = async (kind, texts, keys) => {
    const vectors = [];
    for (let start = 0; start < texts.length; start += REQUEST_CHUNK) {
      const slice = texts.slice(start, start + REQUEST_CHUNK);
      const res = await request({
        op: 'embed',
        kind,
        texts: slice,
        keys: keys.slice(start, start + REQUEST_CHUNK),
      });
      if (res.vectors.length !== slice.length) {
        throw new Error(`embed worker returned ${res.vectors.length} vectors for ${slice.length} ${kind} texts`);
      }
      vectors.push(...res.vectors);
      if (kind === 'doc') stats.encodedDocs += res.encoded ?? 0;
      else stats.encodedQueries += res.encoded ?? 0;
      stats.ms += res.ms ?? 0;
    }
    return vectors;
  };

  const embedQueries = async (queries) => {
    if (!Array.isArray(queries)) throw new Error('embedQueries takes an array of strings');
    if (!queries.length) return [];
    const texts = queries.map((q) => String(q ?? ''));
    // Query keys are content-addressed: identical queries reuse the cache.
    const keys = texts.map((t) => `query:sha256:${sha256(t)}`);
    const raw = await encode('query', texts, keys);
    return raw.map((row) => toFloat32(row, 'query'));
  };

  const embedDocs = async (docs) => {
    if (!Array.isArray(docs)) throw new Error('embedDocs takes an array of {id,title,text}');
    const out = new Map();
    if (!docs.length) return out;
    const texts = [];
    const keys = [];
    const ids = [];
    for (const doc of docs) {
      if (!doc || doc.id == null) throw new Error('every doc needs an id');
      const text = docText(doc);
      ids.push(String(doc.id));
      texts.push(text);
      keys.push(docCacheKey(String(doc.id), text));
    }
    const raw = await encode('doc', texts, keys);
    raw.forEach((row, i) => out.set(ids[i], toFloat32(row, 'doc')));
    return out;
  };

  const close = async () => {
    if (closed) {
      await sleep(0);
      return;
    }
    // Best effort graceful shutdown, then a hard kill: the model is disposable.
    try {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify({ id: nextId++, op: 'shutdown' })}\n`);
      }
      child.stdin.end();
    } catch { /* pipe already gone */ }
    await sleep(200);
    closed = true;
    failAll(new Error('embedder closed'));
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  };

  return { embedQueries, embedDocs, close, info, stats };
}
