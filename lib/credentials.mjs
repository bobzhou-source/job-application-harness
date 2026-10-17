// lib/credentials.mjs — employer account credential backends.
// `macos-keychain` backs the Mac with the login Keychain; `file` backs the Linux runner with an
// AES-256-GCM store at ~/.config/job-harness/credentials.json and a 600 key beside it.
// Secret values never appear in logs, thrown errors, or stack traces.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { withFileLockSync } from './lockfile.mjs';

const execFile = promisify(execFileCb);

// The ignored config.json names the backend and the Keychain service prefix; the loader caches and freezes it.
let configCache;
function config() {
  return (configCache ??= loadConfig());
}

const SECURITY = '/usr/bin/security';
const PASSWORD_LENGTH = 20;

const FILE_DIR = join(homedir(), '.config', 'job-harness');
const FILE_STORE = join(FILE_DIR, 'credentials.json');
const FILE_KEY = join(FILE_DIR, 'credentials.key');
const FILE_VERSION = 1;
const FILE_ALGORITHM = 'aes-256-gcm';

const CLASS_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CLASS_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const CLASS_DIGIT = '0123456789';
// Symbols kept to the widely accepted set so generated passwords survive
// arbitrary employer form validation; execFile passes them as a literal argv
// entry (no shell), so none need escaping.
const CLASS_SYMBOL = '!@#$%^&*-_=+';
const ALL_CLASSES = [CLASS_UPPER, CLASS_LOWER, CLASS_DIGIT, CLASS_SYMBOL];
const ALPHABET = ALL_CLASSES.join('');

function usingFile() {
  return config().credentials.backend === 'file';
}

// The Keychain backend is macOS-only. Fail with an actionable message on any other platform or backend
// instead of surfacing a confusing missing-binary error.
function keychainPrefix() {
  const { backend, servicePrefix } = config().credentials;
  if (backend !== 'macos-keychain') {
    throw new Error(`Unsupported credentials backend "${backend}"; expected macos-keychain or file.`);
  }
  if (process.platform !== 'darwin') {
    throw new Error('Employer password storage requires macOS (credentials.backend=macos-keychain); use credentials.backend=file on Linux.');
  }
  return servicePrefix;
}

function serviceFor(host) {
  return `${keychainPrefix()}${host}`;
}

// Draw one uniform random index in [0, bound) via rejection sampling (no modulo bias).
function randomIndex(bound) {
  const limit = 256 - (256 % bound);
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte < limit) return byte % bound;
  }
}

function randomChar(alphabet) {
  return alphabet[randomIndex(alphabet.length)];
}

function generatePassword(length = PASSWORD_LENGTH) {
  const chars = [];
  // Guarantee at least one character from each class.
  for (const cls of ALL_CLASSES) chars.push(randomChar(cls));
  while (chars.length < length) chars.push(randomChar(ALPHABET));
  // Fisher–Yates shuffle so class positions are not predictable.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Run /usr/bin/security. On failure, throw a fresh Error carrying ONLY the exit
// code — never the original err.message/err.stderr, which may embed argv
// (including `-w <password>` on the store path).
async function runSecurity(args, operation) {
  try {
    const { stdout } = await execFile(SECURITY, args);
    return stdout;
  } catch (err) {
    const code = typeof err?.code === 'number' ? err.code : -1;
    const wrapped = new Error(`keychain ${operation} failed (exit ${code})`);
    wrapped.code = code;
    throw wrapped;
  }
}

async function keychainGet(host, username) {
  try {
    const stdout = await runSecurity([
      'find-generic-password',
      '-s', serviceFor(host),
      '-a', username,
      '-w',
    ], 'lookup');
    return stdout.replace(/\r?\n$/, '');
  } catch (err) {
    if (err?.code === 44) return null;
    throw err;
  }
}

// Account status lives in the password item's Keychain comment, so it survives runs:
//   none    — no password item for host/username
//   pending — password generated for a registration not yet confirmed (also legacy items without a status)
//   created — the employer account is confirmed to exist
// The comment namespace derives from the service prefix with its trailing colon replaced by `-status:` — for the
// default prefix `job-app:` that is exactly the pre-packaging literal `job-app-status:`, so existing items stay
// recognised without any Keychain migration.
function statusFor(value) {
  const prefix = keychainPrefix();
  const base = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
  return `${base}-status:${value}`;
}

async function keychainStatus(host, username) {
  let stdout;
  try {
    stdout = await runSecurity(['find-generic-password', '-s', serviceFor(host), '-a', username], 'lookup');
  } catch (err) {
    if (err?.code === 44) return 'none';
    throw err;
  }
  // Attribute dump prints the comment as `"icmt"<blob>="<text>"`; the secret is not printed without -w.
  const match = /"icmt"<blob>="([^"]*)"/.exec(stdout);
  return match?.[1] === statusFor('created') ? 'created' : 'pending';
}

async function keychainStore(host, username, password, accountStatus) {
  await runSecurity([
    'add-generic-password',
    '-U',
    '-s', serviceFor(host),
    '-a', username,
    '-j', statusFor(accountStatus),
    '-w', password,
  ], 'store');
}

function ensureFileDir() {
  try {
    mkdirSync(FILE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(FILE_DIR, 0o700);
  } catch {
    throw new Error('file credential directory is not writable');
  }
}

function readFileKey() {
  let raw;
  try {
    raw = readFileSync(FILE_KEY, 'utf8');
  } catch {
    throw new Error('file credential key is missing');
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new Error('file credential key is invalid');
  return key;
}

function ensureFileKey() {
  try {
    return readFileKey();
  } catch {
    const key = randomBytes(32);
    try {
      writeFileSync(FILE_KEY, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
      chmodSync(FILE_KEY, 0o600);
      return key;
    } catch (err) {
      if (err?.code === 'EEXIST') return readFileKey();
      throw new Error('file credential key could not be written');
    }
  }
}

function readFileStore() {
  if (!existsSync(FILE_STORE)) return { version: FILE_VERSION, items: {} };
  try {
    const envelope = JSON.parse(readFileSync(FILE_STORE, 'utf8'));
    if (envelope?.version !== FILE_VERSION || envelope.algorithm !== FILE_ALGORITHM) throw new Error('bad envelope');
    const key = readFileKey();
    const decipher = createDecipheriv(FILE_ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (parsed?.version !== FILE_VERSION || !parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
      throw new Error('bad store');
    }
    return parsed;
  } catch {
    throw new Error('file credential store is unreadable or could not be decrypted');
  }
}

function writeFileStore(store) {
  let tmp = '';
  try {
    ensureFileDir();
    const key = ensureFileKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(FILE_ALGORITHM, key, iv);
    const plain = Buffer.from(JSON.stringify({ version: FILE_VERSION, items: store.items }), 'utf8');
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope = {
      version: FILE_VERSION,
      algorithm: FILE_ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    tmp = `${FILE_STORE}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    renameSync(tmp, FILE_STORE);
    chmodSync(FILE_STORE, 0o600);
    tmp = '';
  } catch {
    if (tmp) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    throw new Error('file credential store could not be written');
  }
}

function updateFileStore(change) {
  ensureFileDir();
  return withFileLockSync(FILE_STORE, () => {
    const store = readFileStore();
    const result = change(store);
    writeFileStore(store);
    return result;
  });
}

function fileGet(host, username) {
  const store = readFileStore();
  const record = store.items?.[host]?.[username];
  return typeof record?.secret === 'string' ? record.secret : null;
}

function fileStatus(host, username) {
  const store = readFileStore();
  const record = store.items?.[host]?.[username];
  if (!record) return 'none';
  return record.status === 'created' ? 'created' : 'pending';
}

function fileStore(host, username, password, accountStatus) {
  updateFileStore(store => {
    if (!store.items[host]) store.items[host] = {};
    store.items[host][username] = {
      secret: password,
      status: accountStatus,
      updatedAt: new Date().toISOString(),
    };
  });
}

// Look up the stored password for a host/username pair.
// Returns the password, or null when there is no item. Any other failure (permission, locked
// keychain, corrupt file store) throws, so ensure() will not generate/overwrite after a failed lookup.
export async function get(host, username) {
  if (usingFile()) return fileGet(host, username);
  return keychainGet(host, username);
}

export async function status(host, username) {
  if (usingFile()) return fileStatus(host, username);
  return keychainStatus(host, username);
}

async function store(host, username, password, accountStatus) {
  if (usingFile()) {
    fileStore(host, username, password, accountStatus);
    return;
  }
  await keychainStore(host, username, password, accountStatus);
}

// One shared password per applicant email for every new employer account (job-application accounts only; one
// password to know beats per-site isolation here). Kept under the configured storage as `shared`, generated on
// first use; replace it there to choose your own. Existing per-site items keep the password their account was
// created with.
const SHARED_HOST = 'shared';
async function shared(username) {
  const existing = await get(SHARED_HOST, username);
  if (existing !== null) return existing;
  const password = generatePassword();
  await store(SHARED_HOST, username, password, 'created');
  return password;
}

// Return the existing password for host/username, or store the shared password as `pending` (registration not
// yet confirmed) and return it. A site whose password takes fewer characters (`maxLength`, from the box or the site's
// stated rule) than the shared password gets its own password of that length instead, also replacing a `pending`
// one that is too long (that registration never went through).
export async function ensure(host, username, maxLength = 0) {
  const fits = password => !(maxLength > 0 && password.length > maxLength);
  const existing = await get(host, username);
  if (existing !== null && (fits(existing) || await status(host, username) === 'created')) return existing;
  const common = await shared(username);
  const password = fits(common) ? common : generatePassword(Math.max(maxLength, ALL_CLASSES.length));
  await store(host, username, password, 'pending');
  return password;
}

// Record that the employer account now exists. Keeps the same password.
export async function markCreated(host, username) {
  const password = await get(host, username);
  if (password === null) throw new Error('mark-created failed (no item)');
  await store(host, username, password, 'created');
}

// A site-required password reset: the account's new password is the shared one (a site that rejects reusing the
// current password gets a fresh one instead). Stored as `created`: the account exists; the reset form sets this value.
export async function rotate(host, username) {
  const common = await shared(username);
  const password = common === await get(host, username) ? generatePassword() : common;
  await store(host, username, password, 'created');
  return password;
}

// Account-recovery secrets (security-question answers): one item per
// form field, account `<username>#<normalized field label>`. Alphanumeric only
// so arbitrary answer-field validation accepts it. Returns the existing value
// when present, so re-runs and later recovery read the same answer.
const SECRET_LENGTH = 16;
const SECRET_ALPHABET = CLASS_UPPER + CLASS_LOWER + CLASS_DIGIT;

export async function ensureSecret(host, username, label) {
  const account = `${username}#${label}`;
  const existing = await get(host, account);
  if (existing !== null) return existing;
  let secret = '';
  while (secret.length < SECRET_LENGTH) secret += randomChar(SECRET_ALPHABET);
  await store(host, account, secret, 'created');
  return secret;
}

// File-backend inventory, without secret values. The Mac export script enumerates Keychain items separately.
export async function list() {
  if (!usingFile()) throw new Error('credential list is available only for the file backend');
  const store = readFileStore();
  return Object.entries(store.items).flatMap(([host, accounts]) => Object.entries(accounts).map(([account, record]) => ({
    host,
    account,
    status: record.status === 'created' ? 'created' : 'pending',
  })));
}

// Replace the file store from an export payload. Used only by tools/credentials-import.mjs.
export function importRecords(payload) {
  if (!usingFile()) throw new Error('credential import requires credentials.backend=file');
  const records = Array.isArray(payload) ? payload : payload?.items;
  if (!Array.isArray(records)) throw new Error('credential import payload has no items array');
  const items = {};
  for (const record of records) {
    const { host, account, secret, status } = record ?? {};
    if (typeof host !== 'string' || !host || /[\0\r\n]/.test(host)) throw new Error('credential import has an invalid host');
    if (typeof account !== 'string' || !account || /[\0\r\n]/.test(account)) throw new Error('credential import has an invalid account');
    if (typeof secret !== 'string' || !secret) throw new Error('credential import has an invalid secret');
    if (status !== 'created' && status !== 'pending') throw new Error('credential import has an invalid status');
    if (!items[host]) items[host] = {};
    items[host][account] = { secret, status, updatedAt: new Date().toISOString() };
  }
  updateFileStore(store => { store.items = items; });
  return Object.values(items).reduce((total, accounts) => total + Object.keys(accounts).length, 0);
}

// Extract the lowercased hostname from a URL.
export function hostFromUrl(url) {
  return new URL(url).hostname.toLowerCase();
}
