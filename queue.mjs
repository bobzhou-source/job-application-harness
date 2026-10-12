// queue.mjs — apply to every posting in queue.tsv, one at a time, each submitted (or given up) before the next.
//   bun queue.mjs [--discover] [--limit N]
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
const refill = args.includes('--discover');
const limit = Number(args[args.indexOf('--limit') + 1] || Infinity);
mkdirSync(LOGS, { recursive: true });
const record = line => { appendFileSync(RESULTS, `${line}\n`); console.log(line); };

// One apply.mjs run; resolves with the run's summary row (the last one recorded for this posting), or null.
function apply(row, logName) {
  const resume = resumePath(row.lane);
  const before = new Date().toISOString();
  return new Promise(resolve => {
    const log = createWriteStream(`${LOGS}/${logName}.log`, { flags: 'a' });
    const child = spawn('bun', ['apply.mjs', row.url, '--resume', existsSync(resume) ? resume : resumePath(CONFIG.resumes.fallbackLane), '--submit'], { cwd: HERE });
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
// Domains whose every run so far hit a CAPTCHA (at least 3, none submitted): more runs there only open more tabs
// for the user, so their postings are set aside for manual application. Recomputed per posting from summary.jsonl.
function captchaSites() {
  const tally = new Map();
  for (const line of readFileSync(`${HERE}runs/summary.jsonl`, 'utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.job) continue;
    const site = siteOf(row.job);
    const count = tally.get(site) ?? { captcha: 0, submitted: 0 };
    if (row.outcome === 'submitted') count.submitted += 1;
    else if (GATE.test(row.reason ?? '') && !/\bmfa\b/i.test(row.reason ?? '')) count.captcha += 1;
    tally.set(site, count);
  }
  return new Set([...tally].filter(([, count]) => count.captcha >= 3 && count.submitted === 0).map(([site]) => site));
}

function notify(text) {
  if (NOTIFICATIONS.backend === 'console') {
    console.log(`[notification] ${text}`);
    return;
  }
  spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(NOTIFICATIONS.title)} sound name ${JSON.stringify(NOTIFICATIONS.sound)}`]);
}

function discover() {
  return new Promise(resolve => {
    const child = spawn('bun', ['discover.mjs'], { cwd: HERE, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', () => { console.log(out.trim().split('\n').at(-1)); resolve(); });
  });
}

let handled = 0;
// Site-down deferrals per posting this queue run, and the posting the current pass moves to the queue's end.
const sitedown = new Map();
let deferred = null;
// Consecutive postings whose runs all failed in the model provider (out of credits, provider outage): every later
// posting would fail the same way, so the queue halts keeping the posting queued.
let providerFailures = 0;
while (handled < limit) {
  let queue = readQueue();
  if (!queue.length && refill) { await discover(); queue = readQueue(); }
  const row = queue[0];
  if (!row) break;
  const logName = row.name.replace(/[^\w]+/g, '_').slice(0, 60);
  const history = jobHistory().get(jobKey(row.url));
  deferred = null;
  if (history?.done) {
    record(`=== ${row.name} (${row.lane}) ${row.url}\nSKIPPED (${history.submitted ? 'already submitted' : 'closed, applied, or waiting on the user'})`);
  } else if (captchaSites().has(siteOf(row.url))) {
    record(`=== ${row.name} (${row.lane}) ${row.url}\nSET ASIDE (every run on ${siteOf(row.url)} hit a CAPTCHA; apply manually)`);
  } else {
    record(`=== ${row.name} (${row.lane}) ${row.url}`);
    let retried = false;
    for (;;) {
      const started = Date.now();
      const run = await apply(row, logName);
      const secs = Math.round((Date.now() - started) / 1000);
      const reason = run?.reason ?? `no summary (killed after ${RUN_SECONDS}s or crashed)`;
      const providerDown = run?.outcome !== 'submitted' && /^(driver-error|planner-error)/.test(reason);
      if (!providerDown) providerFailures = 0;
      if (run?.outcome === 'submitted') { record(`SUBMITTED secs=${secs} cost=$${run.cost?.toFixed(4)}`); break; }
      // A blocked job-board account fails every remaining posting the same way and more traffic prolongs the block:
      // the queue ends here, keeping this posting queued.
      if (/^account-blocked/.test(reason)) {
        record(`STOPPED (${reason.slice(0, 200)}) secs=${secs}\nQUEUE_HALTED account-blocked`);
        notify(`Job board account blocked: ${reason.slice(0, 80)} — queue halted`);
        record('QUEUE_DONE');
        process.exit(0);
      }
      record(`STOPPED (${reason.slice(0, 200)}) secs=${secs}`);
      if (retried) {
        if (providerDown) providerFailures += 1;
        if (providerFailures >= 3) {
          record('QUEUE_HALTED model-provider errors on 3 postings in a row (check provider credits)');
          notify('Job queue halted: model provider failing (check credits)');
          record('QUEUE_DONE');
          process.exit(0);
        }
        break;
      }
      // A captcha or MFA step is left open in its own tab for the user to finish whenever they can; the queue moves on.
      if (GATE.test(reason) || /^captcha-rejected/.test(reason)) {
        notify(`${row.name}: ${reason.slice(0, 80)} — left open in the automation Chrome for you`);
        break;
      }
      if (!(TRANSIENT.test(reason) || !run)) {
        // An outage outlasts an immediate retry: try again after the rest of the queue (at most twice per posting).
        if (/^site-down/.test(reason) && sitedown.get(jobKey(row.url)) !== 2) {
          sitedown.set(jobKey(row.url), (sitedown.get(jobKey(row.url)) ?? 0) + 1);
          deferred = row;
        }
        break;
      }
      retried = true;
    }
  }
  writeQueue([...readQueue().filter(other => jobKey(other.url) !== jobKey(row.url)), ...(deferred ? [deferred] : [])]);
  handled += 1;
}
record('QUEUE_DONE');
process.exit(0);
