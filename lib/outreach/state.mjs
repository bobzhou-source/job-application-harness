import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function slugify(value, max = 60) {
  const limit = Number.isInteger(max) && max > 0 ? max : 60;
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit) || 'unknown';
}

export function personSlug(name, id) {
  const tail = String(id ?? '')
    .split('/')
    .pop()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-6)
    .toLowerCase();
  const base = slugify(name, 40);
  return tail ? `${base}-${tail}` : base;
}

/**
 * Run directory for one organization. `root` is the outreach runs directory
 * (`runs/outreach`), so this returns `<root>/<orgSlug>`.
 */
export function runDir(root, orgSlug) {
  if (!root) throw new TypeError('root is required');
  return join(root, slugify(orgSlug));
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

export function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written final line must not hide the valid ledger history.
    }
  }
  return rows;
}

function keysFor(value) {
  if (value && typeof value === 'object') {
    return [value.email, value.authorId].filter(Boolean).flatMap(keysFor);
  }
  const key = String(value ?? '').trim();
  if (!key) return [];
  return key.includes('@') ? [`email:${key.toLowerCase()}`] : [`author:${key}`];
}

/**
 * The global contacted ledger at `<root>/contacted.jsonl` (`root` being the
 * outreach runs directory, i.e. `runs/outreach/contacted.jsonl` in this repo).
 * `has`/`add` are keyed by published email and by OpenAlex author id.
 */
export function ledger(root) {
  if (!root) throw new TypeError('root is required');
  const path = join(root, 'contacted.jsonl');
  const seen = new Set(readJsonl(path).flatMap(keysFor));

  return {
    has(emailOrAuthorId) {
      return keysFor(emailOrAuthorId).some((key) => seen.has(key));
    },
    add(entry) {
      if (!entry || typeof entry !== 'object') throw new TypeError('ledger entry must be an object');
      const keys = keysFor(entry);
      if (keys.length === 0) throw new TypeError('ledger entry needs an email or authorId');
      if (keys.some((key) => seen.has(key))) return false;
      appendJsonl(path, entry);
      for (const key of keys) seen.add(key);
      return true;
    },
  };
}
