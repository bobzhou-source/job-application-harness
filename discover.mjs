// discover.mjs — find new Handshake postings and append them to queue.tsv (url<TAB>lane<TAB>name) for queue.mjs.
// Sources: job postings the user left open in the automation Chrome (each is queued, then its tab closes), and
// Handshake job searches (one reused tab, closed at the end). Postings any earlier run submitted, found closed or
// already applied, or tried twice are never queued again (runs/summary.jsonl is the record).
//   bun discover.mjs [--query "software engineer intern"]... [--pages N] [--max N] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as browser from './lib/browser.mjs';
import { loadConfig } from './lib/config.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const QUEUE_FILE = `${HERE}queue.tsv`;
const SUMMARY_FILE = `${HERE}runs/summary.jsonl`;
const CONFIG = loadConfig();
const HANDSHAKE = CONFIG.discovery.handshakeBaseUrl.replace(/\/+$/, '');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HANDSHAKE_HOST = escapeRegex(new URL(HANDSHAKE).host);
const JOB_ID = new RegExp(`${HANDSHAKE_HOST}/(?:jobs|job-search)/(\\d+)`);

// Configured regexes are compiled once, here, as strings so bad patterns fail with the field name.
function compile(pattern, field) {
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw new Error(`Configuration error: discovery.${field} is not a valid regular expression (${error.message}).`);
  }
}

const RELEVANT = compile(CONFIG.discovery.includeTitlePattern, 'includeTitlePattern');
const UNFIT = compile(CONFIG.discovery.excludeTitlePattern, 'excludeTitlePattern');
const EXCLUDED_EMPLOYER = CONFIG.discovery.excludeEmployerPattern ? compile(CONFIG.discovery.excludeEmployerPattern, 'excludeEmployerPattern') : null;

// Resume variant by the role's title (first match wins); the configured special employer lane wins over titles.
const LANES = CONFIG.discovery.lanes.map(({ name, titlePattern }) => [name, compile(titlePattern, `lanes.${name}.titlePattern`)]);
const SPECIAL = CONFIG.discovery.specialLane;
const SPECIAL_EMPLOYER = compile(SPECIAL.employerPattern, 'specialLane.employerPattern');
export function laneFor(title, employer = '') {
  if (SPECIAL_EMPLOYER.test(employer)) return SPECIAL.name;
  return LANES.find(([, re]) => re.test(title))?.[0] ?? CONFIG.resumes.fallbackLane;
}

// A posting starting in a configured primary month, a configured short-term start/end pair, or undated.
const MONTH = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const SEASON_DATES = new RegExp(`\\b(${MONTH})[a-z]* \\d+\\s*[—–-]\\s*(${MONTH})`);
function inSeason(meta) {
  const dates = meta.match(SEASON_DATES);
  if (!dates) return true;
  const season = CONFIG.discovery.season;
  return season.primaryStartMonths.includes(dates[1])
    || (dates[1] === season.shortTermStartMonth && season.shortTermEndMonths.includes(dates[2]));
}

export function jobId(url) {
  return String(url).match(JOB_ID)?.[1] ?? null;
}
// A posting's identity across runs: its Handshake id, else its URL without scheme, query, fragment, or an
// /apply… suffix (an employer's posting and its application form are one posting).
export function jobKey(url) {
  return jobId(url) ?? (url ? String(url).replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/apply(\/.*)?$/i, '').replace(/\/+$/, '').toLowerCase() : null);
}

// Per posting, from every recorded run: done (submitted, closed, or already applied) and how many runs stopped.
const TERMINAL = /already (applied|submitted|shows|records|been applied)|previously submitted|submitted successfully|application was submitted|applied on|not accepting|no longer|is closed|registration is closed|unable to apply|cannot be applied|not currently applicable|not open for applications|must wait|posting-unavailable|SUBMITTED earlier/i;
export function jobHistory() {
  const runs = new Map();
  if (!existsSync(SUMMARY_FILE)) return runs;
  for (const line of readFileSync(SUMMARY_FILE, 'utf8').split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const key = jobKey(row.job);
    if (!key) continue;
    const entry = runs.get(key) ?? { stopped: 0, done: false, submitted: false };
    if (row.outcome === 'submitted') entry.submitted = true;
    if (row.outcome === 'submitted' || TERMINAL.test(row.reason ?? '')) entry.done = true;
    else entry.stopped += 1;
    runs.set(key, entry);
    // The employer posting a Handshake run applied through is the same posting when a listings feed links to it.
    const employerKey = row.employerPosting && jobKey(row.employerPosting);
    if (employerKey && employerKey !== key && entry.done) {
      runs.set(employerKey, { stopped: runs.get(employerKey)?.stopped ?? 0, done: true, submitted: entry.submitted || !!runs.get(employerKey)?.submitted });
    }
  }
  return runs;
}
// Postings discovery never queues again: done, or already tried twice.
function spentJobs() {
  return new Set([...jobHistory()].filter(([, entry]) => entry.done || entry.stopped >= 2).map(([key]) => key));
}

export function readQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  return readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    const [url, lane, name] = line.split('\t');
    return { url, lane, name };
  });
}
export function writeQueue(rows) {
  writeFileSync(QUEUE_FILE, rows.map(row => `${row.url}\t${row.lane}\t${row.name}\n`).join(''));
}

async function main() {
  const args = process.argv.slice(2);
  const values = name => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : []);
  const queries = values('--query').length ? values('--query') : CONFIG.discovery.queries;
  const pages = Number(values('--pages')[0] ?? 2);
  const max = Number(values('--max')[0] ?? 40);
  const dryRun = args.includes('--dry-run');

  const spent = spentJobs();
  const queue = readQueue();
  const queued = new Set(queue.map(row => jobKey(row.url)).filter(Boolean));
  const found = [];
  const take = (key, lane, name, source, url = `${HANDSHAKE}/jobs/${key}`) => {
    if (!key || spent.has(key) || queued.has(key) || found.length >= max) return;
    queued.add(key);
    found.push({ url, lane, name: name.replace(/\s+/g, ' ').replace(/\t/g, ' ').trim().slice(0, 90), source });
  };
  const fits = (title, employer) => RELEVANT.test(title) && !UNFIT.test(title) && !(EXCLUDED_EMPLOYER && EXCLUDED_EMPLOYER.test(employer));

  if (CONFIG.discovery.sources.includes('listings')) await fromListings({ take, fits, max, found });
  if (CONFIG.discovery.sources.includes('handshake') && found.length < max) {
    await fromHandshake({ take, fits, spent, queued, queries, pages, max, found, dryRun });
  }

  for (const row of found) console.log(`${row.lane}\t${row.name}\t${row.url}\t(${row.source})`);
  console.log(`${found.length} new posting(s)${dryRun ? ' (dry run, queue unchanged)' : ` queued in ${QUEUE_FILE}`}`);
  if (!dryRun) writeQueue([...queue, ...found]);
  process.exit(0);
}

// A public listings feed: open postings in a configured term and location, newest first, linking straight to the
// employer's own application.
async function fromListings({ take, fits, max, found }) {
  const { url, terms, locationPattern } = CONFIG.discovery.listings;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`listings feed ${url} answered HTTP ${response.status}`);
  const listings = await response.json();
  const located = new RegExp(locationPattern, 'i');
  const open = listings.filter(listing => listing.active && listing.is_visible !== false && typeof listing.url === 'string'
    && /^https:/.test(listing.url) && (listing.terms ?? []).some(term => terms.includes(term))
    && (listing.locations ?? []).some(location => located.test(location))
    && (!Array.isArray(listing.degrees) || !listing.degrees.length || listing.degrees.some(degree => /bachelor/i.test(degree)))
    && fits(String(listing.title ?? ''), String(listing.company_name ?? '')));
  open.sort((a, b) => (b.date_posted ?? 0) - (a.date_posted ?? 0));
  for (const listing of open) {
    if (found.length >= max) break;
    take(jobKey(listing.url), laneFor(listing.title, listing.company_name), `${listing.company_name} — ${listing.title}`, 'listings', listing.url);
  }
}

async function fromHandshake({ take, fits, spent, queued, queries, pages, max, found, dryRun }) {
  const connection = await browser.connect();
  try {
    // Postings the user opened: queued whatever their role (the user picked them), then closed.
    for (const page of await connection.pages()) {
      const id = jobId(page.url());
      if (!id) continue;
      const title = (await page.title().catch(() => '')).replace(/\s*\|\s*Handshake\s*$/, '');
      if (!spent.has(id) && !queued.has(id)) {
        if (!title || /^handshake$/i.test(title)) continue; // a search-result pane without its posting loaded
        const parts = title.split(' | ');
        take(id, laneFor(parts.slice(0, -1).join(' | ') || title, parts.at(-1) ?? ''), parts.length > 1 ? `${parts.at(-1)} — ${parts.slice(0, -1).join(' | ')}` : title, 'tab');
      }
      if (!dryRun && (spent.has(id) || queued.has(id)) && (await connection.pages()).length > 1) await page.close().catch(() => undefined);
    }
    // Searches: internships only, in season, in the applicant's fields.
    await browser.trimTabs(connection, [], browser.MAX_TABS - 1);
    const page = await connection.newPage();
    try {
      // Each search gets an equal share of --max so one broad query can't crowd out the others.
      const share = Math.ceil(max / queries.length);
      for (const query of queries) {
        const quota = Math.min(max, found.length + share);
        for (let n = 1; n <= pages && found.length < quota; n++) {
          const url = `${HANDSHAKE}/job-search?query=${encodeURIComponent(query)}&per_page=50&sort=relevance&page=${n}`;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
          await page.waitForSelector('a[href*="/job-search/"]', { timeout: 15000 }).catch(() => undefined);
          const cards = await page.evaluate(() => [...document.querySelectorAll('a[href*="/job-search/"]')].map(a => {
            let card = a;
            for (let i = 0; i < 4 && card.parentElement && !card.innerText.includes('\n'); i++) card = card.parentElement;
            const lines = card.innerText.split('\n').map(line => line.trim()).filter(Boolean);
            return { href: a.getAttribute('href'), employer: lines[0] ?? '', title: lines[1] ?? '', meta: lines[2] ?? '' };
          }));
          if (!cards.length) break;
          for (const card of cards) {
            if (!/\binternship\b/i.test(card.meta) || !inSeason(card.meta) || !fits(card.title, card.employer)) continue;
            if (found.length >= quota) break;
            take(jobId(`${HANDSHAKE}${card.href}`), laneFor(card.title, card.employer), `${card.employer} — ${card.title}`, query);
          }
        }
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    connection.disconnect();
  }
}

if (import.meta.main) await main();
