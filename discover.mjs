// discover.mjs — find new internship postings and append them to queue.tsv (url<TAB>lane<TAB>name) for queue.mjs.
// Sources (discovery.sources): Handshake searches, the SimplifyJobs listings feed, ATS boards (Greenhouse/Lever/Ashby
// APIs), markdown/JSON internship lists (GitHub READMEs and their data files), LinkedIn's guest job search (resolved
// to employer URLs), the freehire.me aggregator, the Levels.fyi internship JSON, and the northwesternfintech quant
// internship YAML directory.
// With discovery.minHourly set, a posting is queued only when its own page states pay above it. Postings any earlier
// run submitted, found closed or already applied, or tried twice are never queued again (runs/summary.jsonl).
//   bun discover.mjs [--query "software engineer intern"]... [--pages N] [--max N] [--dry-run]
//   bun discover.mjs --workday [--max N] [--dry-run]   (Workday tenants seen in runs/, appended to runs/workday-queue.tsv)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as browser from './lib/browser.mjs';
import { loadConfig } from './lib/config.mjs';
import { blockedHosts, hostOfUrl } from './lib/blocked-hosts.mjs';
import { postingDetails, boardPostings, markdownPostings, linkedinPostings, freehirePostings, workdayPostings, levelsPostings, quantYamlPostings } from './lib/discover/sources.mjs';
import { degreeRequirement } from './lib/eligibility.mjs';

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
// Postings closed to outside applicants by their title ("Returning Toll Technology Intern (For Current/Former HNTB
// Interns Only)", "Internal Candidates Only") are unfit for everyone discovery serves, whatever the configured pattern.
const RESTRICTED_TITLE = /\breturning\b|\b(current|former|previous|existing|past)\b[^)]{0,40}\b(interns?|employees?|students?|staff|members?)\s+only\b|\b(internal|employees?|interns?) only\b|\brehires?\b/i;
const CONFIGURED_UNFIT = compile(CONFIG.discovery.excludeTitlePattern, 'excludeTitlePattern');
const UNFIT = { test: title => RESTRICTED_TITLE.test(title) || CONFIGURED_UNFIT.test(title) };
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
// A posting's identity across runs: its Handshake id; a Workday posting's tenant and requisition (one requisition is
// linked under several site paths, each copy with its own "-1"/"-2" suffix; ids read JR2603638, R39407, JR-2604434,
// R26-5374 or 10079130-WD); else its URL without scheme, query, fragment, or an /apply… suffix (an employer's
// posting and its application form are one posting).
export function jobKey(url) {
  const handshake = jobId(url);
  if (handshake) return handshake;
  if (!url) return null;
  const workday = String(url).match(/^https?:\/\/([^./]+)\.wd\d+\.myworkday(?:jobs|site)\.com\/.*_((?=[A-Za-z]*-?\d)[A-Za-z0-9-]+?)(?:-\d{1,2})?(?:[/?#]|$)/i);
  if (workday) return `workday:${workday[1]}:${workday[2]}`.toLowerCase();
  return String(url).replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/apply(\/.*)?$/i, '').replace(/\/+$/, '').toLowerCase();
}

// Per posting, from every recorded run: done (submitted, closed, or already applied) and how many runs stopped.
const TERMINAL = /already (applied|submitted|shows|records|been applied)|previously submitted|submitted successfully|application was submitted|applied on|not accepting|no longer|is closed|registration is closed|unable to apply|cannot be applied|not currently applicable|not open for applications|must wait|posting-unavailable|SUBMITTED earlier|ineligible-degree/i;
// A stop that waits on the user (a captcha to solve by hand, an answer, a document, a mailbox link) ends the same way
// on every retry: the posting is the user's now and is never queued again.
const USER_WAIT = /^(captcha-rejected|needs-user|needs-document|gate (captcha|mfa))/i;
export function jobHistory() {
  const runs = new Map();
  if (!existsSync(SUMMARY_FILE)) return runs;
  for (const line of readFileSync(SUMMARY_FILE, 'utf8').split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const key = jobKey(row.job);
    if (!key) continue;
    const entry = runs.get(key) ?? { stopped: 0, done: false, submitted: false, terminal: false };
    if (row.outcome === 'submitted') entry.submitted = true;
    // terminal: submitted, closed, or already applied — never worth another run. done also covers a stop waiting on
    // the user (a field or document the run could not settle), which a later harness fix may clear (queue --retry).
    if (row.outcome === 'submitted' || TERMINAL.test(row.reason ?? '')) entry.terminal = true;
    if (entry.terminal || USER_WAIT.test(row.reason ?? '')) entry.done = true;
    else entry.stopped += 1;
    runs.set(key, entry);
    // The employer posting a Handshake run applied through is the same posting when a listings feed links to it.
    const employerKey = row.employerPosting && jobKey(row.employerPosting);
    if (employerKey && employerKey !== key && entry.done) {
      runs.set(employerKey, { stopped: runs.get(employerKey)?.stopped ?? 0, done: true, submitted: entry.submitted || !!runs.get(employerKey)?.submitted, terminal: entry.terminal || !!runs.get(employerKey)?.terminal });
    }
  }
  return runs;
}
// Postings discovery never queues again: done, or already tried twice.
function spentJobs() {
  return new Set([...jobHistory()].filter(([, entry]) => entry.done || entry.stopped >= 2).map(([key]) => key));
}

export function readQueue(path = QUEUE_FILE) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    const [url, lane, name] = line.split('\t');
    return { url, lane, name };
  });
}
export function writeQueue(rows, path = QUEUE_FILE) {
  writeFileSync(path, rows.map(row => `${row.url}\t${row.lane}\t${row.name}\n`).join(''));
}

async function main() {
  const args = process.argv.slice(2);
  const values = name => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : []);
  const queries = values('--query').length ? values('--query') : CONFIG.discovery.queries;
  const pages = Number(values('--pages')[0] ?? 2);
  const max = Number(values('--max')[0] ?? 40);
  const dryRun = args.includes('--dry-run');
  const queuePath = values('--queue')[0] ?? QUEUE_FILE;
  if (args.includes('--workday')) return workdayDiscovery({ max: Number(values('--max')[0] ?? 60), dryRun });

  const spent = spentJobs();
  const blocked = blockedHosts();
  const queue = readQueue(queuePath);
  const queued = new Set(queue.map(row => jobKey(row.url)).filter(Boolean));
  const found = [];
  // Candidates are gathered past max when pay is gated (many fail the gate), with a cap per source so the first
  // source cannot crowd out the rest.
  const gated = CONFIG.discovery.minHourly > 0;
  const limit = gated ? max * 8 : max;
  const perSource = new Map();
  const full = source => (perSource.get(source) ?? 0) >= limit;
  const take = (key, lane, name, source, url = `${HANDSHAKE}/jobs/${key}`, extra = {}) => {
    if (!key || spent.has(key) || queued.has(key) || full(source)) return;
    // A host on the owner's brake list (runs/blocked-hosts.tsv) is never emitted: discovery does not put back what
    // the queue was told to skip.
    if (blocked.has(hostOfUrl(url))) return;
    queued.add(key);
    perSource.set(source, (perSource.get(source) ?? 0) + 1);
    found.push({ url, lane, name: name.replace(/\s+/g, ' ').replace(/\t/g, ' ').trim().slice(0, 90), source, ...extra });
  };
  const fits = (title, employer) => RELEVANT.test(title) && !UNFIT.test(title) && !(EXCLUDED_EMPLOYER && EXCLUDED_EMPLOYER.test(employer));
  // Feeds of employer postings share one shape: { url, title, company, location, pay? } (pay when the feed carries
  // the text). A stated location must match discovery.listings.locationPattern when one is set.
  const locationPattern = CONFIG.discovery.listings?.locationPattern;
  const located = locationPattern ? new RegExp(locationPattern, 'i') : null;
  const takeAll = (postings, source) => {
    for (const posting of postings) {
      if (full(source)) break;
      if (!fits(posting.title, posting.company) || /\b(fall|spring|winter)\b|2026\b/i.test(posting.title)) continue;
      if (located && posting.location && !posting.location.split(/\s*[;|•]\s*|\s+or\s+/i).some(place => located.test(place))) continue;
      take(jobKey(posting.url), posting.lane ?? laneFor(posting.title, posting.company), `${posting.company} — ${posting.title}`, source, posting.url,
        { pay: posting.pay, text: posting.text, location: posting.location, title: posting.title });
    }
  };
  const { sources } = CONFIG.discovery;

  if (sources.includes('listings')) await fromListings({ take, fits, max: limit, found });
  if (sources.includes('lists')) takeAll(await markdownPostings(CONFIG.discovery.lists, CONFIG.discovery.fx), 'lists');
  if (sources.includes('boards')) takeAll(await boardPostings(CONFIG.discovery.boards), 'boards');
  if (sources.includes('freehire')) takeAll(await freehirePostings(CONFIG.discovery.freehire, CONFIG.discovery.fx), 'freehire');
  if (sources.includes('linkedin')) takeAll(await linkedinPostings(CONFIG.discovery.linkedin), 'linkedin');
  if (sources.includes('levelsfyi')) takeAll(await levelsPostings(CONFIG.discovery.fx), 'levelsfyi');
  if (sources.includes('quantlists')) takeAll(await quantYamlPostings({ laneFor }), 'quantlists');
  if (sources.includes('handshake') && found.length < limit) {
    await fromHandshake({ take, fits, spent, queued, queries, pages, max: limit, found, dryRun });
  }

  // The pay gate stops at max: alternate sources so every source gets its turn at the queue.
  const bySource = Map.groupBy(found, row => row.source);
  const mixed = Array.from({ length: Math.max(0, ...[...bySource.values()].map(rows => rows.length)) }, (_, i) => [...bySource.values()].map(rows => rows[i]).filter(Boolean)).flat();
  const paid = gated ? await payGate(mixed, max) : found;
  // After the pay gate, a posting whose title or description requires or targets graduate enrollment is dropped
  // before it reaches the queue (the same gate runs over --workday refills below).
  const { kept, dropped: droppedGraduate } = await degreeGate(paid);
  for (const row of kept) console.log(`${row.lane}\t${row.name}\t${row.url}\t(${row.source})`);
  const keptBySource = Map.groupBy(kept, row => row.source);
  for (const source of new Set(sources)) {
    console.log(`SOURCE ${source} ${perSource.get(source) ?? 0} candidates ${keptBySource.get(source)?.length ?? 0} kept`);
  }
  console.log(`${kept.length} new posting(s)${gated ? ` with stated pay above $${CONFIG.discovery.minHourly}/hr (of ${found.length} candidates)` : ''}; ${droppedGraduate} dropped (graduate-only)${dryRun ? ' (dry run, queue unchanged)' : ` queued in ${queuePath}`}`);
  if (!dryRun) writeQueue([...queue, ...kept], queuePath);
  process.exit(0);
}

// Workday postings for every tenant seen in local runs, filtered and deduped like the other sources, appended to
// runs/workday-queue.tsv (not queue.tsv: the Workday queue runs separately).
async function workdayDiscovery({ max, dryRun }) {
  const file = `${HERE}runs/workday-queue.tsv`;
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const priorRows = [...readQueue(), ...prior.split('\n').filter(Boolean).map(line => ({ url: line.split('\t')[0] }))];
  const { rows, seen, abroad, tenants, faceted } = await workdayPostings({
    root: HERE, max, includeTitlePattern: RELEVANT, excludeTitlePattern: UNFIT, excludeEmployerPattern: EXCLUDED_EMPLOYER,
    spent: spentJobs(), queued: new Set(priorRows.map(row => jobKey(row.url)).filter(Boolean)), keyFor: jobKey, laneFor,
  });
  // The owner's brake list (runs/blocked-hosts.tsv): a blocked tenant is never put back in the Workday queue.
  const blocked = blockedHosts();
  const unblocked = rows.filter(row => !blocked.has(hostOfUrl(row.url)));
  const { kept, dropped: droppedGraduate } = await degreeGate(unblocked);
  if (!dryRun && kept.length) {
    writeFileSync(file, prior + (prior && !prior.endsWith('\n') ? '\n' : '') + kept.map(row => `${row.url}\t${row.lane}\t${row.name}\n`).join(''));
  }
  console.log(`WORKDAY_DISCOVERED ${kept.length} new of ${seen} (tenants ${tenants}, US country facet ${faceted}, ${abroad} dropped by their record's country, ${rows.length - unblocked.length} blocked-host, ${droppedGraduate} dropped (graduate-only))${dryRun ? ' [dry run, not written]' : ''}`);
}

// Drop postings whose title or own page text requires or targets graduate enrollment. A feed row already carrying
// text is classified from it; one without text is read through the same postingDetails() the pay gate uses. A page
// that cannot be read, and a row with neither title nor text, is kept rather than guessed at.
async function degreeGate(rows) {
  const kept = [];
  let dropped = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const details = row.postingText || row.text ? null : await postingDetails(row.url, CONFIG.discovery.fx).catch(() => null);
      const title = row.title || details?.title || '';
      const text = row.postingText || row.text || details?.text || '';
      const verdict = degreeRequirement(`${title}\n${text}`);
      if (verdict.hard) {
        dropped += 1;
        console.error(`skip ${row.name}: graduate-only (${verdict.level}: ${verdict.evidence})`);
      } else {
        kept.push(row);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { kept, dropped };
}

// Rows whose employer posting states pay above discovery.minHourly (USD/hr, at the converted range floor), up to
// max. postingDetails normalizes pay periods and duration-qualified stipends before this strict > comparison;
// no readable pay, or pay at or under the bar, is dropped (logged). The hourly floor is appended to the queue name.
async function payGate(rows, max) {
  const kept = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length && kept.length < max) {
      const row = rows[next++];
      // A feed's own posting text with stated pay is the employer's posting; otherwise read the employer page.
      const details = row.pay ? { pay: row.pay, text: row.text, location: row.location } : await postingDetails(row.url, CONFIG.discovery.fx).catch(error => ({ error }));
      const pay = details?.pay;
      const location = details?.location || row.location || '';
      // Abroad, a posting that wants an existing local right to work (or offers no visa) is closed to the applicant.
      const abroad = ABROAD.test(location);
      const localOnly = abroad && LOCAL_WORK_RIGHT.test(details?.text ?? '');
      if (pay && pay.hourly > CONFIG.discovery.minHourly && !localOnly) {
        if (kept.length < max) kept.push({ url: row.url, lane: row.lane, source: row.source, name: `${row.name}${abroad ? ` [${location.slice(0, 30)}]` : ''} ($${pay.hourly}/hr)`.slice(0, 120), title: details?.title || row.title || '', postingText: details?.text || row.text || '' });
      } else {
        console.error(`skip ${row.name}: ${localOnly ? `needs local work rights (${location})` : details?.error ? `unreadable (${details.error.message})` : pay ? `pay $${pay.hourly}/hr (${pay.evidence})` : 'no stated pay'}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return kept;
}

// A location naming a place outside the US (US locations are too varied to list: "NYC - 1211 Ave", "Morrisville").
const ABROAD = /\b(canada|toronto|vancouver|montr[eé]al|ottawa|waterloo|calgary|british columbia|ontario|qu[eé]bec|uk|united kingdom|england|scotland|london|cambridge, (uk|united kingdom|england)|oxford, uk|manchester|edinburgh|leeds|ireland|dublin|germany|berlin|munich|frankfurt|france|paris|netherlands|amsterdam|belgium|switzerland|z[uü]rich|geneva|austria|vienna|spain|madrid|barcelona|portugal|lisbon|italy|milan|sweden|stockholm|denmark|copenhagen|norway|finland|poland|warsaw|czech|prague|israel|tel aviv|singapore|hong kong|japan|tokyo|korea|seoul|china|shanghai|beijing|taiwan|taipei|india|bangalore|bengaluru|hyderabad|mumbai|australia|sydney|melbourne|new zealand|mexico|brazil|s[aã]o paulo|uae|dubai|emea|apac)\b/i;
const LOCAL_WORK_RIGHT = /right to work in|(eligible|authori[sz]ed|permitted|entitled) to work in (?!the (us|u\.s\.|united states))|(existing|valid|current) (work|working) (permit|visa|rights?)|work permit (is )?required|(unable|not able|cannot|can't|do not|don't|will not|won't) (to )?(offer|provide|support|sponsor)\w* (any )?(visa|sponsorship|work permit)|no (visa )?sponsorship|citizens? or permanent residents? (of|in) (?!the (us|united states))/i;

// A public listings feed: open postings in a configured term and location, newest first, linking straight to the
// employer's own application.
async function fromListings({ take, fits, max, found }) {
  const { url, terms, locationPattern } = CONFIG.discovery.listings;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`listings feed ${url} answered HTTP ${response.status}`);
  const listings = await response.json();
  const located = locationPattern ? new RegExp(locationPattern, 'i') : null;
  const open = listings.filter(listing => listing.active && listing.is_visible !== false && typeof listing.url === 'string'
    && /^https:/.test(listing.url) && (listing.terms ?? []).some(term => terms.includes(term))
    && (!located || (listing.locations ?? []).some(location => located.test(location)))
    && (!Array.isArray(listing.degrees) || !listing.degrees.length || listing.degrees.some(degree => /bachelor/i.test(degree)))
    && fits(String(listing.title ?? ''), String(listing.company_name ?? '')));
  open.sort((a, b) => (b.date_posted ?? 0) - (a.date_posted ?? 0));
  for (const listing of open) {
    if (found.length >= max) break;
    take(jobKey(listing.url), laneFor(listing.title, listing.company_name), `${listing.company_name} — ${listing.title}`, 'listings', listing.url, { title: listing.title });
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
        take(id, laneFor(parts.slice(0, -1).join(' | ') || title, parts.at(-1) ?? ''), parts.length > 1 ? `${parts.at(-1)} — ${parts.slice(0, -1).join(' | ')}` : title, 'tab', undefined, { title });
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
            take(jobId(`${HANDSHAKE}${card.href}`), laneFor(card.title, card.employer), `${card.employer} — ${card.title}`, query, undefined, { title: card.title });
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
