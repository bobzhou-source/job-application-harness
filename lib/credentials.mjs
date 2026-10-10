// lib/credentials.mjs — macOS Keychain backing store for employer account passwords.
// Secret values never appear in logs, thrown errors, or stack traces.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.mjs';

const execFile = promisify(execFileCb);

// The ignored config.json names the backend and the Keychain service prefix; the loader caches and freezes it.
let configCache;
function config() {
  return (configCache ??= loadConfig());
}

const SECURITY = '/usr/bin/security';
const PASSWORD_LENGTH = 20;

const CLASS_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CLASS_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const CLASS_DIGIT = '0123456789';
// Symbols kept to the widely accepted set so generated passwords survive
// arbitrary employer form validation; execFile passes them as a literal argv
// entry (no shell), so none need escaping.
const CLASS_SYMBOL = '!@#$%^&*-_=+';
const ALL_CLASSES = [CLASS_UPPER, CLASS_LOWER, CLASS_DIGIT, CLASS_SYMBOL];
const ALPHABET = ALL_CLASSES.join('');

// The one implemented backend is macOS Keychain. Fail with an actionable message on any other platform or backend
// instead of surfacing a confusing missing-binary error.
function keychainPrefix() {
  const { backend, servicePrefix } = config().credentials;
  if (backend !== 'macos-keychain') {
    throw new Error(`Unsupported credentials backend "${backend}"; this build stores employer passwords in macOS Keychain.`);
  }
  if (process.platform !== 'darwin') {
    throw new Error('Employer password storage requires macOS (credentials.backend=macos-keychain); run the harness on macOS or keep employer passwords yourself.');
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

// Look up the stored password for a host/username pair.
// Returns the password, or null ONLY when Keychain reports item-not-found
// (exit 44 errSecItemNotFound). Any other failure (permission, locked
// keychain, missing binary, execution fault) throws the sanitized error from
// runSecurity — never masquerades as missing credentials, so ensure() will
// not generate/overwrite after a failed lookup.
export async function get(host, username) {
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

export async function status(host, username) {
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

async function store(host, username, password, accountStatus) {
  await runSecurity([
    'add-generic-password',
    '-U',
    '-s', serviceFor(host),
    '-a', username,
    '-j', statusFor(accountStatus),
    '-w', password,
  ], 'store');
}

// One shared password per applicant email for every new employer account (job-application accounts only; one
// password to know beats per-site isolation here). Kept in Keychain under the configured service prefix as
// `<prefix>shared`, generated on first use; replace it there to choose your own. Existing per-site items keep the
// password their account was created with.
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
  if (password === null) throw new Error('keychain mark-created failed (no item)');
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

// Account-recovery secrets (security-question answers): one Keychain item per
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
  await runSecurity([
    'add-generic-password',
    '-U',
    '-s', serviceFor(host),
    '-a', account,
    '-w', secret,
  ], 'store');
  return secret;
}

// Extract the lowercased hostname from a URL.
export function hostFromUrl(url) {
  return new URL(url).hostname.toLowerCase();
}
