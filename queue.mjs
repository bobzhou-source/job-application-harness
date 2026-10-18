// queue.mjs — apply to every posting in queue.tsv, each submitted (or given up) before its worker takes the next.
//   bun queue.mjs [--discover] [--limit N] [--queue <tsv>] [--workers N] [--headless]
// --workers N runs N postings at once, each with its own Chrome profile (~/.job-app-chrome-w<i>); --headless runs
// those Chromes without windows. Only this process writes the queue file; refill runs only when nothing is in flight.
// --discover refills queue.tsv from the configured discovery sources (discover.mjs) whenever it runs dry.
// Per posting: a run that stops for a transient reason (model budget, planner/driver error) is retried once; a
// CAPTCHA or MFA gate posts a notification and its tab stays open for the user to finish whenever they can; a site
// outage (site-down) moves the posting to the queue's end, at most twice (never during a platform outage: >=4 ATS
// hosts down in 10 min halt the queue with "platform-outage <family>" and every row stays queued, no deferral
// spent); a network-outage gets the transient retry,
// then also returns to the queue's end without counting toward the host breaker; any other stop (a field or
// document only the user has, closed posting) moves on. Postings on a domain where at least 3 runs hit a CAPTCHA and
// none submitted are set aside for manual application without a run; a host that submits but starts challenging rests
// 3 h after two captchas in 2 h, its gated rows deferred to the queue's end; 3 postings in a row failing in the model
// provider (out of credits) halt the queue. A host on the owner's brake list (runs/blocked-hosts.tsv) is skipped and
// its row dropped; a host whose own 3 runs in a pool did not submit is skipped for the rest of that pool, its rows
// left in the queue for the next one. Rows leave queue.tsv once
// handled; results append to runs/queue-results.txt and each run's console output to runs/queue-logs/<name>.log.
import { appendFileSync, mkdirSync, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { readQueue, writeQueue, jobKey, jobHistory } from './discover.mjs';
import { loadConfig } from './lib/config.mjs';
import { blockedHosts } from './lib/blocked-hosts.mjs';

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
const TRANSIENT = /^(consult-limit|iteration-limit|planner-error|driver-error|implementation-error|action-outcome-unknown|network-outage|Could not start or attach)/;
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
    else if (isCaptcha(row.reason)) count.captcha += 1;
    tally.set(key, count);
  };
  for (const row of summaryRows()) {
    bump(siteOf(row.job), row);
    if (hostOf(row.job) !== siteOf(row.job)) bump(hostOf(row.job), row);
  }
  return new Set([...tally].filter(([key, count]) => count.submitted === 0 && count.captcha >= (key.split('.').length > 2 ? 2 : 3)).map(([key]) => key));
}
const setAsideFor = (setAside, url) => [hostOf(url), siteOf(url)].find(key => setAside.has(key));
const isCaptcha = reason => GATE.test(reason ?? '') && !/\bmfa\b/i.test(reason ?? '');
// Every summary row that names a posting, oldest first.
function summaryRows() {
  const rows = [];
  for (const line of readFileSync(`${HERE}runs/summary.jsonl`, 'utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.job) rows.push(row);
  }
  return rows;
}
// A host that normally submits but has started challenging (Ashby's hCaptcha appears on submit once the IP has sent
// enough applications in a short span; 24/25 Ashby runs submitted on 10-15, then 6 captchas on 10-16) is rested:
// after COOLDOWN_HITS captcha stops within COOLDOWN_WINDOW_MS with no submit since the last one, its rows are skipped
// until COOLDOWN_MS after that last captcha and left in the queue. host → ISO time the rest ends.
const COOLDOWN_HITS = 2;
const COOLDOWN_WINDOW_MS = 2 * 3600_000;
const COOLDOWN_MS = 3 * 3600_000;
function captchaCooldowns(now = Date.now()) {
  const perHost = new Map();
  for (const row of summaryRows()) {
    const t = Date.parse(row.t);
    if (!(t >= now - COOLDOWN_WINDOW_MS)) continue;
    const host = hostOf(row.job);
    const state = perHost.get(host) ?? { captchas: 0, last: 0, submittedSince: false };
    if (row.outcome === 'submitted') state.submittedSince = true;
    else if (isCaptcha(row.reason)) { state.captchas += 1; state.last = Math.max(state.last, t); state.submittedSince = false; }
    perHost.set(host, state);
  }
  const resting = new Map();
  for (const [host, state] of perHost) {
    if (state.captchas >= COOLDOWN_HITS && !state.submittedSince && now < state.last + COOLDOWN_MS) resting.set(host, new Date(state.last + COOLDOWN_MS).toISOString().slice(11, 16) + 'Z');
  }
  return resting;
}
// Whether `host` submitted at least once in the last 24 h: a captcha there is a rate check worth retrying later, not
// the site's standing policy.
function submitsRecently(host, now = Date.now()) {
  return summaryRows().some(row => hostOf(row.job) === host && row.outcome === 'submitted' && Date.parse(row.t) >= now - 24 * 3600_000);
}

function notify(text) {
  if (NOTIFICATIONS.backend === 'console') {
    console.log(`[notification] ${text}`);
    return;
  }
  spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(NOTIFICATIONS.title)} sound name ${JSON.stringify(NOTIFICATIONS.sound)}`]);
}

// Billing brakes, checked after every run against runs/summary.jsonl (whose `cost` is the run's metered spend):
//  - spend per submit over the last COST_WINDOW runs versus the median of the last COST_DAYS days' spend per submit
//    (factor from config.queue.costGuard.perSubmitFactor, default 5): a provider reprice or a loop that burns calls
//    on every posting shows here long before the credits run out;
//  - the day's total against config.queue.costGuard.dailyCapUsd (default 25).
// A halt keeps every remaining row queued and stops dispatch; runs/overnight*.sh end the night on it instead of
// retrying, because spending is what the guard is stopping.
const COST_WINDOW = 30;
const COST_DAYS = 7;
function costGuard(now = Date.now()) {
  const rows = summaryRows().filter(row => Number.isFinite(row.cost) && Number.isFinite(Date.parse(row.t)));
  if (!rows.length) return null;
  const dayOf = t => new Date(t).toISOString().slice(0, 10);
  const perSubmitOf = rs => {
    const submits = rs.filter(row => row.outcome === 'submitted').length;
    return submits ? rs.reduce((sum, row) => sum + row.cost, 0) / submits : null;
  };
  const recent = rows.slice(-COST_WINDOW);
  const recentPerSubmit = perSubmitOf(recent);
  const days = new Map();
  for (const row of rows) {
    const day = dayOf(Date.parse(row.t));
    if (day >= dayOf(now - (COST_DAYS - 1) * 86400_000)) days.set(day, [...(days.get(day) ?? []), row]);
  }
  const baseline = [...days.entries()].filter(([day]) => day !== dayOf(now))
    .map(([, rs]) => perSubmitOf(rs)).filter(value => value !== null).sort((a, b) => a - b);
  const median = baseline.length ? baseline[Math.floor(baseline.length / 2)] : null;
  const today = rows.filter(row => dayOf(Date.parse(row.t)) === dayOf(now));
  const todaySpend = today.reduce((sum, row) => sum + row.cost, 0);
  const { dailyCapUsd, perSubmitFactor } = CONFIG.queue.costGuard;
  if (todaySpend > dailyCapUsd) {
    return { halt: 'cost-guard daily-cap', text: `$${todaySpend.toFixed(2)} spent today, cap $${dailyCapUsd.toFixed(2)}` };
  }
  if (median !== null && median > 0 && recentPerSubmit !== null
    && recent.some(row => row.outcome === 'submitted') && recentPerSubmit > perSubmitFactor * median) {
    return {
      halt: 'cost-guard per-submit',
      text: `$${recentPerSubmit.toFixed(2)} per submit over the last ${COST_WINDOW} runs, ${perSubmitFactor}x the ${COST_DAYS}-day median $${median.toFixed(2)}`,
    };
  }
  return null;
}

// The billing brake applied to one finished run: the reason goes into its lines and the posting stays queued; null
// when spend is in bounds. A submitted run is counted like any other (its summary row is already on disk).
function costHalt(lines) {
  const guard = costGuard();
  if (!guard) return null;
  lines.push(`QUEUE_HALTED ${guard.halt} (${guard.text}; every row kept queued)`);
  notify(`Job queue halted: ${guard.halt} — ${guard.text}`);
  return { lines, deferred: null, halt: guard.halt };
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
let networkOutages = 0;
let halt = null;
// Site-down and captcha-on-a-submitting-host deferrals per posting this queue run.
const sitedown = new Map();
const captchaDeferrals = new Map();
// Consecutive postings whose runs all failed in the model provider (out of credits, provider outage): every later
// posting would fail the same way, so the queue halts keeping the posting queued.
let providerFailures = 0;
// A host whose own runs keep stopping is taken out of this pool's rotation: after STOP_LIMIT consecutive runs that
// did not submit on one employer host (network-outage runs excepted), its remaining rows are skipped (SKIPPED host-breaker) and left in the queue for
// the next pool, which starts with a clean slate. In-memory only; a run that submits clears its host's count.
const STOP_LIMIT = 3;
const hostStops = new Map();
const breakerHosts = new Set();
const breakerSkipped = new Set();
// Platform outage breaker: site-down stops (or the ATS's own hosts failing to load at all) on >=4 distinct employer
// hosts of one ATS family inside 10 minutes mean the platform is down (Workday's 2026-10-17 maintenance stopped
// 917 runs and churned 15 postings out of the queue). Dispatch halts with "platform-outage <family>": every row
// stays queued, the halted posting's deferrals are not spent, and while the outage is on no site-down row is
// dropped. runs/overnight*.sh sleep 20 min on this halt and retry instead of counting a 0-submit pool.
const OUTAGE_WINDOW_MS = 10 * 60 * 1000;
const OUTAGE_HOSTS = 4;
const OUTAGE_STOP = /^(site-down|external-site-failed-to-load)(?:\s|\()/;
const outageHits = [];
// The ATS family a hostname belongs to: the shared platform domain, so aig.wd1 and gfs.wd5 count together while two
// employers on their own domains never do.
function atsFamily(host) {
  const match = host.match(/(?:^|\.)(myworkdayjobs\.com|myworkday\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|icims\.com|taleo\.net|oraclecloud\.com|successfactors\.com|workable\.com|jobvite\.com|ultipro\.com|recruitee\.com|pinpointhq\.com|breezy\.hr|yello\.co)$/);
  return match ? match[1] : host;
}
// The family currently in outage (>=OUTAGE_HOSTS distinct hosts down inside the window), else null.
function outageFamily() {
  const now = Date.now();
  while (outageHits.length && now - outageHits[0].t > OUTAGE_WINDOW_MS) outageHits.shift();
  const byFamily = new Map();
  for (const hit of outageHits) {
    const hosts = byFamily.get(hit.family) ?? new Set();
    hosts.add(hit.host);
    byFamily.set(hit.family, hosts);
  }
  for (const [family, hosts] of byFamily) if (hosts.size >= OUTAGE_HOSTS) return family;
  return null;
}
function hostOutcome(host, submitted) {
  if (submitted) {
    hostStops.delete(host);
    breakerHosts.delete(host);
    return;
  }
  const stops = (hostStops.get(host) ?? 0) + 1;
  hostStops.set(host, stops);
  if (stops >= STOP_LIMIT) breakerHosts.add(host);
}
// Postings in flight by key, and the worker slots free for the next one.
const inflight = new Map();
const free = Array.from({ length: WORKERS }, (_, i) => i);
const keyOf = row => jobKey(row.url) ?? row.url;
// Removes every copy of this posting from the queue; a site-down or network-outage deferral goes to the end.
const leave = (row, next = null) => writeQueue([...readQueue(QUEUE).filter(other => keyOf(other) !== keyOf(row)), ...(next ? [next] : [])], QUEUE);

// The next posting to dispatch, or null. Postings already settled (skipped or set aside) are handled as they are reached.
// Two postings on one employer hostname never run at once: they share the employer account (two registrations racing,
// two sessions on one Workday candidate profile), and the per-host brakes in summary.jsonl read one run at a time.
// The ATS domain is no such bound: aig.wd1 and gfs.wd5.myworkdayjobs.com are different employers.
const hostOf = url => new URL(url).hostname.toLowerCase();
function pick() {
  const setAside = captchaSites();
  const resting = captchaCooldowns();
  const blocked = blockedHosts();
  const busyHosts = new Set([...inflight.values()].map(entry => entry.host));
  for (const row of readQueue(QUEUE)) {
    if (handled >= limit) return null;
    if (inflight.has(keyOf(row)) || busyHosts.has(hostOf(row.url))) continue;
    const head = `=== ${row.name} (${row.lane}) ${row.url}`;
    // A host this pool has already broken, or one resting after captchas: no run. Its rows stay in the queue (not
    // handled, so they do not eat --limit) for a later pool to try; each is reported once.
    if (breakerHosts.has(hostOf(row.url)) || resting.has(hostOf(row.url))) {
      if (!breakerSkipped.has(keyOf(row))) {
        breakerSkipped.add(keyOf(row));
        record(resting.has(hostOf(row.url))
          ? `${head}\nSKIPPED captcha-cooldown (${hostOf(row.url)} is challenging; left for a pool after ${resting.get(hostOf(row.url))})`
          : `${head}\nSKIPPED host-breaker (${STOP_LIMIT} stops on ${hostOf(row.url)}; left for the next pool)`);
      }
      continue;
    }
    const history = jobHistory().get(jobKey(row.url));
    handled += 1;
    if (blocked.has(hostOf(row.url))) {
      record(`${head}\nSKIPPED blocked-host ${blocked.get(hostOf(row.url))}`);
      leave(row);
    } else if (history?.done && !(RETRY && !history.terminal)) {
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
    const networkOutage = /^network-outage(?:\s|$)/.test(reason);
    if (networkOutage) networkOutages += 1;
    // A local/network outage is not evidence about this employer host; every other non-submit counts toward its breaker.
    if (!networkOutage) hostOutcome(hostOf(row.url), run?.outcome === 'submitted');
    const providerDown = run?.outcome !== 'submitted' && /^(driver-error|planner-error)/.test(reason);
    if (!providerDown) providerFailures = 0;
    if (run?.outcome === 'submitted') {
      lines.push(`SUBMITTED secs=${secs} cost=${run.cost?.toFixed(4)}`);
      return costHalt(lines) ?? { lines, deferred, halt: null };
    }
    // A blocked job-board account fails every remaining posting the same way and more traffic prolongs the block:
    // the queue stops here, keeping this posting queued.
    if (/^account-blocked/.test(reason)) {
      lines.push(`STOPPED (${reason.slice(0, 200)}) secs=${secs}`, 'QUEUE_HALTED account-blocked');
      notify(`Job board account blocked: ${reason.slice(0, 80)} — queue halted`);
      return { lines, deferred: null, halt: 'account-blocked' };
    }
    lines.push(`STOPPED (${reason.slice(0, 200)}) secs=${secs}`);
    const overBudget = costHalt(lines);
    if (overBudget) return overBudget;
    // An ATS-wide outage halts dispatch with the posting kept queued: the platform, not this posting, is down.
    if (OUTAGE_STOP.test(reason)) {
      const host = hostOf(row.url);
      const family = atsFamily(host);
      outageHits.push({ t: Date.now(), family, host });
      if (outageFamily() === family) {
        lines.push(`QUEUE_HALTED platform-outage ${family} (site-down on >=${OUTAGE_HOSTS} hosts in 10 min; every row kept queued)`);
        notify(`Platform outage (${family}): queue halted, rows kept queued for a retry after the outage`);
        return { lines, deferred: null, halt: `platform-outage ${family}` };
      }
    }
    if (retried) {
      // Outages never consume the posting: after the transient retry, put its row back at the queue's end.
      if (networkOutage) deferred = row;
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
    // in the visible Chrome (the queue would skip it: a gate stop marks the posting as waiting on the user). A captcha
    // on a host that submitted within 24 h is a rate check instead: the row goes back to the queue's end (at most
    // twice) for a pool after the host's cooldown.
    if (GATE.test(reason) || /^captcha-rejected/.test(reason)) {
      if (HEADLESS && isCaptcha(reason) && submitsRecently(hostOf(row.url)) && (captchaDeferrals.get(jobKey(row.url)) ?? 0) < 2) {
        captchaDeferrals.set(jobKey(row.url), (captchaDeferrals.get(jobKey(row.url)) ?? 0) + 1);
        lines.push(`DEFERRED captcha on a host that submits (${hostOf(row.url)}); back to the queue's end for a later pool`);
        deferred = row;
      } else if (HEADLESS) {
        lines.push('GATED (headless; row saved to runs/handoff-gated.tsv for the visible Chrome)');
        appendFileSync(path.join(HERE, 'runs', 'handoff-gated.tsv'), `${row.url}\t${row.lane}\t${row.name}\n`);
      } else {
        notify(`${row.name}: ${reason.slice(0, 80)} — left open in the automation Chrome for you`);
      }
      return { lines, deferred, halt: null };
    }
    if (!(TRANSIENT.test(reason) || !run)) {
      // An outage outlasts an immediate retry: try again after the rest of the queue (at most twice per posting).
      // While the posting's platform is out, the row goes back without spending a deferral: an outage never drops it.
      if (/^site-down/.test(reason)) {
        if (outageFamily() === atsFamily(hostOf(row.url))) {
          deferred = row;
        } else if (sitedown.get(jobKey(row.url)) !== 2) {
          sitedown.set(jobKey(row.url), (sitedown.get(jobKey(row.url)) ?? 0) + 1);
          deferred = row;
        }
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
record(`QUEUE_DONE network-outage=${networkOutages}`);
process.exit(0);
