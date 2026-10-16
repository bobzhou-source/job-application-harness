// queue.mjs — apply to every posting in queue.tsv, each submitted (or given up) before its worker takes the next.
//   bun queue.mjs [--discover] [--limit N] [--queue <tsv>] [--workers N] [--headless]
// --workers N runs N postings at once, each with its own Chrome profile (~/.job-app-chrome-w<i>); --headless runs
// those Chromes without windows. Only this process writes the queue file; refill runs only when nothing is in flight.
// --discover refills queue.tsv from the configured discovery sources (discover.mjs) whenever it runs dry.
// Per posting: a run that stops for a transient reason (model budget, planner/driver error) is retried once; a
// CAPTCHA or MFA gate posts a notification and its tab stays open for the user to finish whenever they can; a site
// outage (site-down) moves the posting to the queue's end, at most twice; any other stop (a field or
// document only the user has, closed posting) moves on. Postings on a domain where at least 3 runs hit a CAPTCHA and
// none submitted are set aside for manual application without a run; 3 postings in a row failing in the model
// provider (out of credits) halt the queue. Rows leave queue.tsv once
// handled; results append to runs/queue-results.txt and each run's console output to runs/queue-logs/<name>.log.
import { appendFileSync, mkdirSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { readQueue, writeQueue, jobKey, jobHistory } from './discover.mjs';
import { loadConfig } from './lib/config.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CONFIG = loadConfig();
const RESUMES = CONFIG.resumes.directory;
const RESULTS = `${HERE}runs/queue-results.txt`;
const LOGS = `${HERE}runs/queue-logs`;
const RUN_SECONDS = CONFIG.queue.runTimeoutSeconds;
const NOTIFICATIONS = CONFIG.notifications;
if (NOTIFICATIONS.backend === 'macos-osascript' && process.platform !== 'darwin') {
  throw new Error('notifications.backend "macos-osascript" requires macOS; set notifications.backend to "console".');
}

// The configured resume filename for a lane, e.g. resumes.filePattern "resume_{lane}.pdf".
const resumePath = lane => path.join(RESUMES, CONFIG.resumes.filePattern.replace('{lane}', lane));
const TRANSIENT = /^(consult-limit|iteration-limit|planner-error|driver-error|implementation-error|action-outcome-unknown|Could not start or attach)/;
const GATE = /^(?!captcha-rejected)(?:.*?)(^gate (captcha|mfa)|captcha|human[- ]verification|robot)/i;

const args = process.argv.slice(2);
// The value after a flag, or null when the flag is absent.
const flag = name => (args.indexOf(name) === -1 ? null : args[args.indexOf(name) + 1] ?? null);
const refill = args.includes('--discover');
const limit = Number(flag('--limit') || Infinity);
// --queue selects the queue file (default queue.tsv); a refill writes the same file.
const QUEUE = flag('--queue') ?? undefined;
const WORKERS = Number(flag('--workers') ?? 1);
if (!Number.isInteger(WORKERS) || WORKERS < 1) throw new Error('--workers must be an integer of at least 1');
const HEADLESS = args.includes('--headless');
// --retry runs postings whose last stop waited on the user (needs-user-field, a missing document): the harness fix
// that clears such a stop otherwise strands the posting, since history marks it done. Submitted/closed stay skipped.
const RETRY = args.includes('--retry');
mkdirSync(LOGS, { recursive: true });
const record = line => { appendFileSync(RESULTS, `${line}\n`); console.log(line); };

// One apply.mjs run; resolves with the run's summary row (the last one recorded for this posting), or null.
function apply(row, logName, env) {
  const resume = resumePath(row.lane);
  const before = new Date().toISOString();
  return new Promise(resolve => {
    const log = createWriteStream(`${LOGS}/${logName}.log`, { flags: 'a' });
    const child = spawn('bun', ['apply.mjs', row.url, '--resume', existsSync(resume) ? resume : resumePath(CONFIG.resumes.fallbackLane), '--submit'], { cwd: HERE, env: { ...process.env, ...env } });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_SECONDS * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      log.end();
      resolve(lastRun(row.url, before));
    });
  });
}

function lastRun(url, since) {
  const key = jobKey(url);
  const rows = readFileSync(`${HERE}runs/summary.jsonl`, 'utf8').split('\n').flatMap(line => {
    try { const row = JSON.parse(line); return row.t >= since && jobKey(row.job) === key ? [row] : []; } catch { return []; }
  });
  return rows.at(-1) ?? null;
}

// A site's registrable domain ("careers-sas.icims.com" → "icims.com"): one ATS shares one CAPTCHA policy.
const siteOf = url => new URL(url).host.split('.').slice(-2).join('.');
// Sites whose runs so far hit a CAPTCHA and never submitted: more runs there only open more tabs for the user, so
// their postings are set aside for manual application. Tallied per registrable domain (at least 3: one ATS shares
// one policy) and per employer host (at least 2: a tenant's own human check on every application, FHLBank Chicago's
// "count the letters" question on a Workday domain where other employers submit). Recomputed per posting.
function captchaSites() {
  const tally = new Map();
  const bump = (key, row) => {
    const count = tally.get(key) ?? { captcha: 0, submitted: 0 };
    if (row.outcome === 'submitted') count.submitted += 1;
    else if (GATE.test(row.reason ?? '') && !/\bmfa\b/i.test(row.reason ?? '')) count.captcha += 1;
    tally.set(key, count);
  };
  for (const line of readFileSync(`${HERE}runs/summary.jsonl`, 'utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.job) continue;
    bump(siteOf(row.job), row);
    if (hostOf(row.job) !== siteOf(row.job)) bump(hostOf(row.job), row);
  }
  return new Set([...tally].filter(([key, count]) => count.submitted === 0 && count.captcha >= (key.split('.').length > 2 ? 2 : 3)).map(([key]) => key));
}
const setAsideFor = (setAside, url) => [hostOf(url), siteOf(url)].find(key => setAside.has(key));

function notify(text) {
  if (NOTIFICATIONS.backend === 'console') {
    console.log(`[notification] ${text}`);
    return;
  }
  spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(NOTIFICATIONS.title)} sound name ${JSON.stringify(NOTIFICATIONS.sound)}`]);
}

function discover() {
  return new Promise(resolve => {
    const child = spawn('bun', ['discover.mjs', ...(QUEUE ? ['--queue', QUEUE] : [])], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => { console.log(out.trim().split('\n').at(-1)); resolve(); });
  });
}

let handled = 0;
let halt = null;
// Site-down deferrals per posting this queue run.
const sitedown = new Map();
// Consecutive postings whose runs all failed in the model provider (out of credits, provider outage): every later
// posting would fail the same way, so the queue halts keeping the posting queued.
let providerFailures = 0;
// Postings in flight by key, and the worker slots free for the next one.
const inflight = new Map();
const free = Array.from({ length: WORKERS }, (_, i) => i);
const keyOf = row => jobKey(row.url) ?? row.url;
// Removes every copy of this posting from the queue; a site-down deferral goes to the end.
const leave = (row, next = null) => writeQueue([...readQueue(QUEUE).filter(other => keyOf(other) !== keyOf(row)), ...(next ? [next] : [])], QUEUE);

// The next posting to dispatch, or null. Postings already settled (skipped or set aside) are handled as they are reached.
// Two postings on one employer hostname never run at once: they share the employer account (two registrations racing,
// two sessions on one Workday candidate profile), and the per-host brakes in summary.jsonl read one run at a time.
// The ATS domain is no such bound: aig.wd1 and gfs.wd5.myworkdayjobs.com are different employers.
const hostOf = url => new URL(url).hostname.toLowerCase();
function pick() {
  const setAside = captchaSites();
  const busyHosts = new Set([...inflight.values()].map(entry => entry.host));
  for (const row of readQueue(QUEUE)) {
    if (handled >= limit) return null;
    if (inflight.has(keyOf(row)) || busyHosts.has(hostOf(row.url))) continue;
    const head = `=== ${row.name} (${row.lane}) ${row.url}`;
    const history = jobHistory().get(jobKey(row.url));
    handled += 1;
    if (history?.done && !(RETRY && !history.terminal)) {
      record(`${head}\nSKIPPED (${history.submitted ? 'already submitted' : history.terminal ? 'closed or applied' : 'waiting on the user'})`);
      leave(row);
    } else if (setAsideFor(setAside, row.url)) {
      record(`${head}\nSET ASIDE (every run on ${setAsideFor(setAside, row.url)} hit a CAPTCHA; apply manually)`);
      leave(row);
    } else {
      return row;
    }
  }
  return null;
}

// Each worker gets its own Chrome profile (and tabs.json) so postings never share a browser. A lone worker on the
// default profile keeps the configured browser.
function workerEnv(slot) {
  if (WORKERS === 1 && !HEADLESS) return {};
  return { JOB_APP_PROFILE: path.join(homedir(), `.job-app-chrome-w${slot + 1}`), ...(HEADLESS ? { JOB_APP_HEADLESS: '1' } : {}) };
}

// One posting, run until it submits, is set aside, or stops for good. Its lines come back for finish() to record in
// one piece, so parallel postings never interleave in the results file.
async function runPosting(row, slot) {
  const logName = row.name.replace(/[^\w]+/g, '_').slice(0, 60);
  const lines = [`=== ${row.name} (${row.lane}) ${row.url}`];
  let deferred = null;
  let retried = false;
  for (;;) {
    const started = Date.now();
    const run = await apply(row, logName, workerEnv(slot));
    const secs = Math.round((Date.now() - started) / 1000);
    const reason = run?.reason ?? `no summary (killed after ${RUN_SECONDS}s or crashed)`;
    const providerDown = run?.outcome !== 'submitted' && /^(driver-error|planner-error)/.test(reason);
    if (!providerDown) providerFailures = 0;
    if (run?.outcome === 'submitted') {
      lines.push(`SUBMITTED secs=${secs} cost=$${run.cost?.toFixed(4)}`);
      return { lines, deferred, halt: null };
    }
    // A blocked job-board account fails every remaining posting the same way and more traffic prolongs the block:
    // the queue stops here, keeping this posting queued.
    if (/^account-blocked/.test(reason)) {
      lines.push(`STOPPED (${reason.slice(0, 200)}) secs=${secs}`, 'QUEUE_HALTED account-blocked');
      notify(`Job board account blocked: ${reason.slice(0, 80)} — queue halted`);
      return { lines, deferred: null, halt: 'account-blocked' };
    }
    lines.push(`STOPPED (${reason.slice(0, 200)}) secs=${secs}`);
    if (retried) {
      if (providerDown) providerFailures += 1;
      if (providerFailures >= 3) {
        lines.push('QUEUE_HALTED model-provider errors on 3 postings in a row (check provider credits)');
        notify('Job queue halted: model provider failing (check credits)');
        return { lines, deferred: null, halt: 'model-provider' };
      }
      return { lines, deferred, halt: null };
    }
    // A captcha or MFA step is left open in its own tab for the user to finish whenever they can; the queue moves on.
    // A headless worker has no tab the user can reach: its gated posting is saved to runs/handoff-gated.tsv for a run
    // in the visible Chrome (the queue would skip it: a gate stop marks the posting as waiting on the user).
    if (GATE.test(reason) || /^captcha-rejected/.test(reason)) {
      if (HEADLESS) {
        lines.push('GATED (headless; row saved to runs/handoff-gated.tsv for the visible Chrome)');
        appendFileSync(path.join(HERE, 'runs', 'handoff-gated.tsv'), `${row.url}\t${row.lane}\t${row.name}\n`);
      } else {
        notify(`${row.name}: ${reason.slice(0, 80)} — left open in the automation Chrome for you`);
      }
      return { lines, deferred, halt: null };
    }
    if (!(TRANSIENT.test(reason) || !run)) {
      // An outage outlasts an immediate retry: try again after the rest of the queue (at most twice per posting).
      if (/^site-down/.test(reason) && sitedown.get(jobKey(row.url)) !== 2) {
        sitedown.set(jobKey(row.url), (sitedown.get(jobKey(row.url)) ?? 0) + 1);
        deferred = row;
      }
      return { lines, deferred, halt: null };
    }
    retried = true;
  }
}

function finish(row, key, slot, done) {
  inflight.delete(key);
  free.push(slot);
  record(done.lines.join('\n'));
  // A halt keeps this posting queued and stops dispatch; postings already running still finish.
  if (done.halt) halt = done.halt;
  else leave(row, done.deferred);
}

function start(row) {
  const key = keyOf(row);
  const slot = free.shift();
  inflight.set(key, { host: hostOf(row.url), done: runPosting(row, slot).then(done => finish(row, key, slot, done)) });
}

for (;;) {
  while (!halt && inflight.size < WORKERS) {
    const row = pick();
    if (!row) break;
    start(row);
  }
  if (inflight.size) {
    await Promise.race([...inflight.values()].map(entry => entry.done));
    continue;
  }
  if (halt || handled >= limit || !refill) break;
  await discover();
  if (!readQueue(QUEUE).length) break;
}
record('QUEUE_DONE');
process.exit(0);
