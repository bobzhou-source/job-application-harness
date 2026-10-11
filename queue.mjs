// queue.mjs — apply to every posting in queue.tsv, one at a time, each submitted (or given up) before the next.
//   bun queue.mjs [--discover] [--limit N]
// --discover refills queue.tsv from Handshake (discover.mjs) whenever it runs dry, so the run keeps finding new jobs.
// Per posting: a run that stops for a transient reason (model budget, planner/driver error) is retried once; a
// CAPTCHA or MFA gate posts a notification, waits the configured gate time (queue.gateWaitSeconds), and retries
// once; a site outage (site-down) moves the posting to the queue's end, at most twice; any other stop (a field or
// document only the user has, closed posting) moves on. Rows leave queue.tsv once
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
const GATE_WAIT_MS = CONFIG.queue.gateWaitSeconds * 1000;
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
  } else {
    record(`=== ${row.name} (${row.lane}) ${row.url}`);
    let retried = false;
    for (;;) {
      const started = Date.now();
      const run = await apply(row, logName);
      const secs = Math.round((Date.now() - started) / 1000);
      const reason = run?.reason ?? `no summary (killed after ${RUN_SECONDS}s or crashed)`;
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
      if (retried) break;
      if (GATE.test(reason)) {
        notify(`${row.name}: ${reason.slice(0, 80)} — solve it in the automation Chrome within ${Math.round(GATE_WAIT_MS / 60_000)} min`);
        await new Promise(r => setTimeout(r, GATE_WAIT_MS));
      } else if (!(TRANSIENT.test(reason) || !run)) {
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
