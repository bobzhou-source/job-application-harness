import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// lib/discover/sources.mjs — posting sources beyond the Simplify listings feed, and pay verification for any posting.
// Every candidate's pay is read from the employer's own posting (ATS APIs where they expose it, else the page text),
// so discovery can keep only postings whose stated pay clears discovery.minHourly.

const HOURS_PER_YEAR = 2080;
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' };

const getJson = async (url) => {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
};
const getText = async (url) => {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.text();
};

const decode = (html) => String(html ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
export const plain = (html) => decode(decode(html)).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();

// USD per unit of each currency; postings in other currencies are left unverified.
const CURRENCY = { $: 'USD', US$: 'USD', USD: 'USD', '£': 'GBP', GBP: 'GBP', '€': 'EUR', EUR: 'EUR', CAD: 'CAD', C$: 'CAD', CA$: 'CAD', SGD: 'SGD', S$: 'SGD', HKD: 'HKD', HK$: 'HKD', AUD: 'AUD', A$: 'AUD', CHF: 'CHF', JPY: 'JPY', '¥': 'JPY' };
const PAY_UNIT = 'bi[- ]?weekly|bi[- ]?week|fortnightly|fortnight|every\\s+(?:two|2)\\s+weeks|hourly|hours?|hrs?|weekly|weeks?|wks?|monthly|months?|mo|annually|annual|annum|yearly|years?|yrs?|daily|days?';
const payUnit = text => [...text.matchAll(new RegExp(`\\b(${PAY_UNIT})\\b`, 'gi'))].at(-1)?.[1].toLowerCase() ?? '';
const toHourly = (amount, interval) => {
  if (/hour|hr/.test(interval)) return amount;
  if (/bi[- ]?week|fortnight|every\s+(two|2)\s+weeks/.test(interval)) return amount / 80;
  if (/week|wk/.test(interval)) return amount / 40;
  if (/month|mo\b/.test(interval)) return amount / 173.33;
  if (/year|annu|yr|salary/.test(interval)) return amount / HOURS_PER_YEAR;
  if (/daily|day/.test(interval)) return amount / 8;
  if (interval) return null;
  // Unitless salary ranges retain the established annual/hourly inference, but text must have a pay cue.
  if (amount >= 1000) return amount / HOURS_PER_YEAR;
  return amount >= 10 && amount <= 250 ? amount : null;
};

const statedWeeks = text => {
  const lengths = [...text.matchAll(/\b(\d{1,2})\s*(?:[-–]\s*)?weeks?\b/gi)].map(match => Number(match[1]));
  const unique = new Set(lengths.filter(weeks => weeks > 0 && weeks <= 52));
  return unique.size === 1 ? [...unique][0] : null;
};

// The lowest stated pay in posting text, in USD per hour: { hourly, evidence } or null. Both ends of a range
// are converted before taking its floor (an employer may pay anywhere in it). fx: USD per non-USD unit.
export function payFromText(text, fx = {}) {
  text = String(text ?? '');
  const symbols = '(?:US\\$|C\\$|CA\\$|S\\$|HK\\$|A\\$|\\$|£|€|¥|USD|GBP|EUR|CAD|SGD|HKD|AUD|CHF|JPY)';
  const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?\\s*k?\\b';
  const unit = name => `(?:\\s*(?:/\\s*|per\\s+|an?\\s+)?(?<${name}>${PAY_UNIT})\\b)?`;
  // Currency may lead/trail, or be shared by range endpoints. Units can precede the salary or follow either end.
  const re = new RegExp(`(?<![\\w.,])(?<c1>${symbols})?\\s*(?<n1>${number})\\+?${unit('u1')}(?:\\s*(?:-|–|—|to)\\s*(?<c2>${symbols})?\\s*(?<n2>${number})\\+?${unit('u2')})?(?:\\s*(?<ct>${symbols}))?${unit('ut')}`, 'gi');
  const amountOf = value => Number(value.replace(/[,\s]/g, '').replace(/k$/i, '')) * (/k\s*$/i.test(value) ? 1000 : 1);
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/);
  const programSentences = sentences.filter(sentence => /\b(internship|program(?:me)?|placement)\b/i.test(sentence) && !/\b(leave|vacation|parental)\b/i.test(sentence));
  const programWeeks = statedWeeks(programSentences.join(' '));
  let best = null;
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(re)) {
      const { c1, c2, ct, n1, n2, u1, u2, ut } = match.groups;
      const code = c1 ?? c2 ?? ct;
      if (!code) continue;
      const currency = CURRENCY[code.toUpperCase()] ?? CURRENCY[code];
      const rate = currency === 'USD' ? 1 : fx[currency];
      if (!rate || (c2 && CURRENCY[c2.toUpperCase()] !== currency)) continue;
      const before = sentence.slice(0, match.index);
      const after = sentence.slice(match.index + match[0].length);
      // Keep wage context separate from an additive benefit ("$30/hr + relocation", "... plus a bonus").
      const left = before.split(/[,;]|\b(?:plus|and|in addition to)\b/i).at(-1).slice(-100);
      const right = after.split(/[,;]|\+|\b(?:plus|and|in addition to)\b/i)[0].slice(0, 28);
      const near = `${left} ${right}`;
      if (/\b(bonus|relocation|housing|wellness|health insurance|revenue|funding|raised|aum|assets under management|valuation|billion|million|tuition|reimburse\w*|referr\w*)\b/i.test(near)
        || /^\s*(?:[mb](?:n)?\b|billion|million)/i.test(after)) continue;
      const prefix = left.match(/\b(?:bi[- ]?weekly|weekly|monthly|annual(?:ly)?|yearly|hourly|daily|fortnightly)\b[^$£€¥\d]{0,100}$/i)?.[0] ?? '';
      const interval = (u2 ?? ut ?? u1 ?? payUnit(prefix)).toLowerCase();
      // Neither a bare money figure nor a business metric is compensation. Unit suffixes also act as pay cues.
      if (!interval && !/\b(pay|paid|salary|compensation|rate|stipend|wages?|earn\w*|per)\b/i.test(sentence)) continue;
      const stipend = /\bstipend\b/i.test(near);
      const weeks = stipend && !interval ? statedWeeks(sentence) ?? programWeeks : null;
      if (stipend && !interval && !weeks) continue;
      let low = amountOf(n1);
      if (n2 && /k\s*$/i.test(n2) && !/k\s*$/i.test(n1) && low < 1000 && !u1) low *= 1000;
      const convert = (amount, ownUnit) => weeks ? amount / weeks / 40 : toHourly(amount, (ownUnit ?? interval).toLowerCase());
      const first = convert(low, u1);
      const second = n2 ? convert(amountOf(n2), u2 ?? ut) : first;
      if (!first || !second) continue;
      const hourly = Math.min(first, second);
      if (hourly < 8 || hourly > 300) continue;
      const usd = Math.round(hourly * rate * 100) / 100;
      if (!best || usd < best.hourly) best = { hourly: usd, evidence: `${match[0].trim()}${weeks ? ` / ${weeks} weeks` : interval && !u1 && !u2 && !ut ? ` (${interval})` : ''}`.slice(0, 80) };
    }
  }
  return best;
}

const structuredPay = (min, max, currency, interval, fx) => {
  const rate = (currency ?? 'USD') === 'USD' ? 1 : fx[currency];
  const amounts = [min, max].filter(value => value != null).map(value => toHourly(Number(value), String(interval ?? '').toLowerCase()));
  if (!rate || !amounts.length || amounts.some(value => !value || value < 0)) return null;
  const hourly = Math.min(...amounts);
  return { hourly: Math.round(hourly * rate * 100) / 100, evidence: `${currency ?? 'USD'} ${min}${max ? `-${max}` : ''} ${interval ?? ''}`.trim() };
};

// Posting text and pay for an employer posting URL, via the ATS's public API when it has one.
export async function postingDetails(url, fx = {}) {
  const u = new URL(url);
  let match;
  if (/greenhouse\.io$/.test(u.hostname) && (match = u.pathname.match(/^\/(?:embed\/job_app\?for=)?([^/]+)\/jobs\/(\d+)/))) {
    const job = await getJson(`https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs/${match[2]}?pay_transparency=true`);
    const text = plain(job.content);
    const range = job.pay_input_ranges?.[0];
    const interval = payUnit(range?.title ?? '');
    // Some boards reuse an "Annual Base Pay" heading for hourly ranges. Preserve the small-range heuristic
    // for that template, but never let it override an explicit weekly, monthly, biweekly or daily unit.
    const annualTemplate = /annu|year|yr/.test(interval) && range.max_cents < 100000;
    const pay = (range && interval && structuredPay(range.min_cents / 100, range.max_cents / 100, range.currency_type, annualTemplate ? 'hour' : interval, fx))
      || payFromText(text, fx)
      || (range && !/stipend/i.test(range.title) ? structuredPay(range.min_cents / 100, range.max_cents / 100, range.currency_type, range.max_cents < 100000 ? 'hour' : 'year', fx) : null);
    return { title: job.title, location: job.location?.name ?? '', text, pay };
  }
  if (u.hostname === 'jobs.lever.co' || u.hostname === 'jobs.eu.lever.co') {
    const [, company, id] = u.pathname.split('/');
    const api = u.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co';
    const job = await getJson(`https://${api}/v0/postings/${company}/${id}`);
    const text = [job.descriptionPlain, ...(job.lists ?? []).map(list => `${list.text} ${plain(list.content)}`), job.additionalPlain].join(' ');
    const range = job.salaryRange;
    const pay = (range && structuredPay(range.min, range.max, range.currency, range.interval, fx)) ?? payFromText(text, fx);
    return { title: job.text, location: job.categories?.location ?? '', text, pay };
  }
  if (u.hostname === 'jobs.ashbyhq.com') {
    const [, company, id] = u.pathname.split('/');
    const board = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${company}?includeCompensation=true`);
    const job = board.jobs?.find(candidate => candidate.id === id || candidate.jobUrl?.includes(id));
    if (!job) return null;
    const salary = job.compensation?.summaryComponents?.find(c => c.compensationType === 'Salary');
    const text = `${plain(job.descriptionHtml)} ${job.compensation?.compensationTierSummary ?? ''}`;
    const pay = (salary && structuredPay(salary.minValue, salary.maxValue, salary.currencyCode, salary.interval, fx)) ?? payFromText(text, fx);
    return { title: job.title, location: job.location ?? '', text, pay };
  }
  if ((match = u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/))) {
    // Workday renders client-side; its own JSON endpoint serves the same posting.
    const parts = u.pathname.split('/').filter(Boolean);
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0]) ? parts[1] : parts[0];
    const rest = parts.slice(parts.indexOf(site) + 1).join('/');
    const job = await getJson(`https://${u.hostname}/wday/cxs/${match[1]}/${site}/${rest}`);
    const info = job.jobPostingInfo ?? {};
    const text = plain(info.jobDescription);
    return { title: info.title ?? '', location: info.location ?? '', text, pay: payFromText(text, fx) };
  }
  const text = plain(await getText(url));
  return { title: '', location: '', text, pay: payFromText(text, fx) };
}

const WORKDAY_HOST = /^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i;
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;
// Non-US countries and cities that are not also US place names (no Vienna, Warsaw, Paris, Melbourne, Ontario, Mexico in New Mexico).
const NON_US_LOCATION = /(?<![a-z])(canada|british columbia|alberta|quebec|toronto|montreal|ottawa, (on|ontario)|vancouver, bc|calgary|united kingdom|great britain|england|scotland|wales|london|ireland|germany|france|netherlands|belgium|switzerland|austria|spain|portugal|italy|sweden|denmark|norway|finland|poland|czech|israel|singapore|hong kong|japan|korea|china|taiwan|india|australia|new zealand|(?<!new )mexico|brazil|argentina|united arab emirates|uae|emea|apac|bangalore|bengaluru|hyderabad|mumbai|tokyo|seoul|shanghai|beijing|tel aviv|dubai|munich|zurich|amsterdam|almaty|assago|uk|egypt|saudi arabia|qatar|turkey|türkiye|south africa|nigeria|kenya|morocco|philippines|malaysia|indonesia|thailand|vietnam|pakistan|bangladesh|sri lanka|colombia|chile|peru|costa rica|romania|hungary|bulgaria|greece|slovakia|lithuania|latvia|estonia|ukraine|serbia|croatia|luxembourg|milano|roma|lisbon|lisboa|prague|praha|madrid|barcelona|warszawa|bucharest|budapest|wien|krakow|kraków|taipei|manila|kuala lumpur|jakarta|bangkok|ho chi minh|hanoi|karachi|lahore|dhaka|nairobi|lagos|cairo|riyadh|doha|istanbul|s[aã]o paulo|bogot[aá]|buenos aires|sydney|chennai|pune|gurgaon|gurugram|noida|kolkata|shenzhen|guangzhou|osaka|mississauga|waterloo, on)(?![a-z])/i;
// Relevance (includeTitlePattern) is not enough: Workday's fuzzy "intern" search also returns full-time roles.
const INTERN_TITLE = /\b(intern|internship|co-?op|summer|student)\b/i;
// The US entry of the API's country facet (its facet parameter and value id), or null when the tenant exposes none.
// Some tenants (Accenture's wd103) group it: `locationMainGroup` holds sub-facets `locationCountry` and `locations`
// (cities), each with its own facetParameter and values, so groups are searched one level down.
const usCountryFacet = (facets) => {
  for (const facet of Array.isArray(facets) ? facets : []) {
    const nested = (facet.values ?? []).filter(value => Array.isArray(value.values) && value.facetParameter);
    if (nested.length) {
      const found = usCountryFacet(nested);
      if (found) return found;
    }
    if (!/country/i.test(facet.facetParameter ?? '')) continue;
    const us = (facet.values ?? []).find(value => /^united states/i.test(value.descriptor ?? ''));
    if (us?.id) return { parameter: facet.facetParameter, id: us.id };
  }
  return null;
};
const lowerFirst = text => text.charAt(0).toLowerCase() + text.slice(1);
// ISO alpha-3 country code (not USA) in a location string, e.g. SGP or IND; case-sensitive so ordinary words pass.
const ISO_CODE = /\b(?!USA\b)[A-Z]{3}\b/;
// Positive US evidence in a location string: the country, a state name, or a state abbreviation (upper case only:
// "in", "or", "me" are words in "Remote in Canada"). A location with neither this nor a non-US match (Moscow,
// Eindhoven, a city the regex never heard of) is settled by the posting's own record (`jobPostingInfo.country`).
const US_EVIDENCE = new RegExp(`\\b(united states|usa|u\\.s\\.a?|${[
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'puerto rico'].join('|')})\\b`, 'i');
const US_STATE_CODE = /(?<![A-Za-z])(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|US)(?![A-Za-z])/;
const US_COUNTRY = /^united states/i;
// The posting's country from its CXS record; null when the record is unreachable or names none.
async function postingCountry(seed, externalPath) {
  try {
    const job = await getJson(`https://${seed.host}/wday/cxs/${seed.tenant}/${seed.site}${externalPath}`);
    return job?.jobPostingInfo?.country?.descriptor ?? null;
  } catch {
    return null;
  }
}

const titleCaseTenant = tenant => tenant.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
const postedWithin = (value, days) => {
  const text = String(value ?? '').trim();
  if (!text || /\btoday\b/i.test(text)) return true;
  if (/\byesterday\b/i.test(text)) return days >= 1;
  const ago = text.match(/(\d+)\+?\s+(day|week|month|year)s?\s+ago/i);
  if (ago) {
    const units = { day: 1, week: 7, month: 30, year: 365 };
    return Number(ago[1]) * units[ago[2].toLowerCase()] <= days;
  }
  const date = Date.parse(text.replace(/^posted\s+/i, ''));
  return Number.isNaN(date) || Date.now() - date <= days * 86400000;
};

// Workday sites are derived from prior local posting URLs; no tenant registry or applicant data is needed.
const workdaySeeds = (root) => {
  const seeds = new Map();
  const namedHosts = new Map();
  const addUrl = (value, employer = '') => {
    let url;
    try { url = new URL(value); } catch { return; }
    const hostMatch = url.hostname.match(WORKDAY_HOST);
    if (!hostMatch) return;
    const parts = url.pathname.split('/').filter(Boolean);
    const locale = WORKDAY_LOCALE.test(parts[0] ?? '') ? parts.shift() : '';
    const site = parts[0];
    if (!site || /^(job|jobs)$/i.test(site)) return;
    const host = url.hostname.toLowerCase();
    const key = `${host}/${site.toLowerCase()}`;
    const prior = seeds.get(key);
    if (!prior) seeds.set(key, { host, tenant: hostMatch[1], site, locale });
    else if (locale && !prior.locale) prior.locale = locale;
    if (employer) namedHosts.set(host, employer);
  };
  const addTextUrls = text => {
    for (const match of String(text ?? '').matchAll(/https?:\/\/[^\s"',]+/gi)) addUrl(match[0]);
  };
  const summary = join(root, 'runs', 'summary.jsonl');
  if (existsSync(summary)) {
    for (const line of readFileSync(summary, 'utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.job === 'string') addUrl(row.job);
    }
  }
  const results = join(root, 'runs', 'queue-results.txt');
  if (existsSync(results)) {
    for (const line of readFileSync(results, 'utf8').split('\n')) {
      if (!line.startsWith('=== ')) continue;
      const match = line.match(/https?:\/\/[^\s"',]+/i);
      if (!match) continue;
      const separator = line.indexOf(' — ');
      addUrl(match[0], separator > 4 ? line.slice(4, separator).trim() : '');
    }
  }
  const applications = join(root, 'runs', 'applications.csv');
  if (existsSync(applications)) addTextUrls(readFileSync(applications, 'utf8'));
  const runsDir = join(root, 'runs');
  const rerunFiles = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^rerun-.*\.tsv$/i.test(entry.name)).map(entry => join(runsDir, entry.name))
    : [];
  for (const file of [join(root, 'queue.tsv'), ...rerunFiles]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) addUrl(line.split('\t', 1)[0]);
  }
  const extras = join(root, 'runs', 'workday-tenants.txt');
  if (existsSync(extras)) {
    for (const line of readFileSync(extras, 'utf8').split('\n')) {
      const value = line.trim();
      if (value && !value.startsWith('#')) addUrl(`https://${value}`);
    }
  }
  return [...seeds.values()].map(seed => ({ ...seed, employer: namedHosts.get(seed.host) ?? titleCaseTenant(seed.tenant) }));
};

// Search every locally seen Workday tenant/site through Workday's public jobs API. Tenant failures are isolated so
// one retired career site cannot stop discovery on the remaining sites.
export async function workdayPostings({
  root = process.cwd(),
  max = 60,
  includeTitlePattern,
  excludeTitlePattern,
  excludeEmployerPattern = null,
  spent = new Set(),
  queued = new Set(),
  keyFor = value => value,
  laneFor = () => '',
  log = console.log,
} = {}) {
  const seeds = workdaySeeds(root);
  const pages = Array(seeds.length);
  let cursor = 0;
  const fetchSeed = async (seed) => {
    const postings = [];
    let faceted = false;
    const search = async (appliedFacets, offset) => {
      const response = await fetch(`https://${seed.host}/wday/cxs/${seed.tenant}/${seed.site}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText: 'intern' }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return response.json();
    };
    try {
      // Prefer the API's own US country facet: text matching misses cities and codes. A 400 means the facet key is
      // spelled differently for this tenant, so try the next spelling before falling back to text filtering.
      let applied = {};
      let body = await search(applied, 0);
      const us = usCountryFacet(body.facets);
      for (const parameter of us ? [us.parameter, lowerFirst(us.parameter)] : []) {
        try {
          body = await search({ [parameter]: [us.id] }, 0);
          applied = { [parameter]: [us.id] };
          faceted = true;
          break;
        } catch (error) {
          if (error.status !== 400) throw error;
        }
      }
      for (let offset = 0; offset < max;) {
        const jobs = Array.isArray(body.jobPostings) ? body.jobPostings : [];
        if (!jobs.length) break;
        postings.push(...jobs.slice(0, max - postings.length));
        offset += jobs.length;
        if (postings.length >= max || offset >= Number(body.total ?? Infinity)) break;
        body = await search(applied, offset);
      }
      log(`WORKDAY ${seed.host}/${seed.site}: ${postings.length} intern postings${faceted ? ' (US facet)' : ''}`);
    } catch (error) {
      log(`WORKDAY ${seed.host}/${seed.site}: ${error.name === 'TimeoutError' ? 'timeout' : error.message}`);
    }
    return { postings, faceted };
  };
  const worker = async () => {
    while (cursor < seeds.length) {
      const index = cursor++;
      pages[index] = await fetchSeed(seeds[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, seeds.length) }, worker));

  const rows = [];
  const known = new Set(queued);
  let seen = 0;
  for (let index = 0; index < seeds.length; index++) {
    const seed = seeds[index];
    const faceted = Boolean(pages[index]?.faceted);
    for (const posting of pages[index]?.postings ?? []) {
      seen += 1;
      const title = String(posting.title ?? '').trim();
      // The location segment of the URL path (/job/<location>/...) is often the only place a non-US city appears.
      const location = [posting.locationsText, posting.externalPath?.split('/')[2]].filter(Boolean).join(' ').trim();
      if (!title || !includeTitlePattern.test(title) || !INTERN_TITLE.test(title) || excludeTitlePattern.test(title)
        || (excludeEmployerPattern && excludeEmployerPattern.test(`${seed.tenant} ${seed.employer}`))
        || (!faceted && (NON_US_LOCATION.test(location) || ISO_CODE.test(location))) || !postedWithin(posting.postedOn, 60)
        || !/^\/job\//.test(posting.externalPath ?? '')) continue;
      const prefix = seed.locale ? `${seed.locale}/${seed.site}` : seed.site;
      const url = `https://${seed.host}/${prefix}${posting.externalPath}`;
      const key = keyFor(url);
      if (!key || spent.has(key) || known.has(key)) continue;
      known.add(key);
      const cleanTitle = title.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ');
      const employer = seed.employer.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ');
      const slug = location.replace(/[-_]+/g, ' ');
      const unplaced = !faceted && !US_EVIDENCE.test(slug) && !US_STATE_CODE.test(slug);
      rows.push({ url, lane: laneFor(cleanTitle, employer), name: `${employer} — ${cleanTitle}`, ...(unplaced ? { seed, externalPath: posting.externalPath } : {}) });
    }
  }
  // A posting whose location names no US place is kept only when its own record places it in the US (P&G's
  // /job/Moscow/, Philips' /job/Eindhoven/ carry no country the regexes know); an unreachable record keeps it.
  const unplaced = rows.filter(row => row.seed);
  let cursorAt = 0, abroad = 0;
  const settle = async () => {
    while (cursorAt < unplaced.length) {
      const row = unplaced[cursorAt++];
      const country = await postingCountry(row.seed, row.externalPath);
      if (country && !US_COUNTRY.test(country)) { row.abroad = country; abroad += 1; log(`WORKDAY ${row.seed.host}: dropped "${row.name}" (${country})`); }
      delete row.seed; delete row.externalPath;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, unplaced.length) }, settle));
  return { rows: rows.filter(row => !row.abroad), seen, abroad, tenants: seeds.length, faceted: pages.filter(page => page?.faceted).length };
}

// Open internship postings on configured ATS boards: [{ url, title, company, location }].
export async function boardPostings(boards = {}) {
  const out = [];
  const settle = (promises) => Promise.allSettled(promises);
  await settle((boards.greenhouse ?? []).map(async (slug) => {
    const { jobs = [] } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    for (const job of jobs) out.push({ url: job.absolute_url, title: job.title, company: slug, location: job.location?.name ?? '' });
  }));
  await settle((boards.lever ?? []).map(async (slug) => {
    const jobs = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    for (const job of jobs) out.push({ url: job.hostedUrl, title: job.text, company: slug, location: job.categories?.location ?? '' });
  }));
  await settle((boards.ashby ?? []).map(async (slug) => {
    const { jobs = [] } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    for (const job of jobs) out.push({ url: job.jobUrl, title: job.title, company: slug, location: job.location ?? '' });
  }));
  return out.filter(posting => /^https:/.test(posting.url ?? '') && /\bintern(ship)?s?\b/i.test(posting.title ?? ''));
}

// Postings from community internship lists published as markdown tables (README.md of GitHub repos): every table row
// with a link to an employer posting. Rows a list marks closed (🔒) are skipped. A row whose company cell is "↳"
// continues the previous company.
export async function markdownPostings(urls = []) {
  const out = [];
  for (const url of urls) {
    let text;
    try { text = await getText(url); } catch { continue; }
    let company = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('|') || /🔒|closed/i.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      if (cells.length < 3) continue;
      const links = [...line.matchAll(/(?:href="|\]\()(https:\/\/[^")\s]+)/g)].map(m => decode(m[1]))
        .filter(link => !/github\.com|simplify\.jobs|imgur|shields\.io|linkedin\.com\/company/i.test(link));
      if (!links.length) continue;
      const name = plain(cells[0].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, ''));
      if (name && name !== '↳') company = name;
      const title = plain(cells[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
      out.push({ url: links[0].replace(/[?&]utm_[^&]+/g, '').replace(/[?&](ref|source)=Simplify[^&]*/gi, ''), title, company, location: plain(cells[2]) });
    }
  }
  return out;
}

// LinkedIn guest job search (no sign-in; experience level Internship, newest first) for each query × location.
// LinkedIn postings are only a pointer: a posting whose apply button leaves LinkedIn yields the employer's own URL;
// "Easy Apply" postings (no employer URL) are skipped, since the harness applies on employer sites.
export async function linkedinPostings({ queries = [], locations = [], pages = 2 } = {}) {
  const ids = new Map();
  for (const keywords of queries) {
    for (const location of locations.length ? locations : ['United States']) {
      for (let page = 0; page < pages; page += 1) {
        const search = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}`
          + `&location=${encodeURIComponent(location)}&f_E=1&sortBy=DD&start=${page * 25}`;
        let html;
        try { html = await getText(search); } catch { break; }
        // One card per job-posting URN, parsed on its own so a malformed card cannot break the rest.
        const chunks = html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1);
        if (!chunks.length) break;
        for (const chunk of chunks) {
          const id = chunk.match(/^(\d+)/)?.[1];
          const title = plain(chunk.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
          if (!id || !title) continue;
          ids.set(id, {
            title,
            company: plain(chunk.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? ''),
            location: plain(chunk.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''),
          });
        }
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }
  // LinkedIn's guest pages no longer carry the off-site apply link, so each intern card is matched to the employer's
  // own posting through freehire's ATS index (same company, same title); a card with no match is dropped.
  const norm = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out = [];
  for (const [, card] of ids) {
    if (!/\bintern(ship)?s?\b/i.test(card.title)) continue;
    const params = new URLSearchParams({ q: `${card.title} ${card.company}`, limit: '10', seniority: 'intern' });
    let body;
    try { body = await getJson(`https://freehire.me/api/v1/agent/jobs/search?${params}`); } catch { continue; }
    const company = norm(card.company);
    const hit = (body.data ?? []).find(job => !job.closed_at && /^https:/.test(job.url ?? '') && norm(job.title) === norm(card.title)
      && (norm(job.company).includes(company) || company.includes(norm(job.company))));
    if (hit) out.push({ ...card, url: hit.url.replace(/[?&]utm_source=freehire\.me/, ''), location: hit.location ?? card.location });
  }
  return out;
}

// freehire.me: an open aggregator of ~50 ATS platforms worldwide (public JSON API, no key). Internship-level postings
// for each query, newest first, with the posting text, so pay is read without fetching each employer page; the same
// requisition mirrored under several career sites (one Oracle job id on three site paths) is taken once.
export async function freehirePostings({ queries = [], postedWithinDays = 90, pages = 2 } = {}, fx = {}) {
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    for (let page = 0; page < pages; page += 1) {
      const params = new URLSearchParams({ q, limit: '50', offset: String(page * 50), seniority: 'intern', posted_within_days: String(postedWithinDays), include_description: 'true', description_format: 'text' });
      let body;
      try { body = await getJson(`https://freehire.me/api/v1/agent/jobs/search?${params}`); } catch { break; }
      const jobs = body.data ?? [];
      for (const job of jobs) {
        if (job.closed_at || !/^https:/.test(job.url ?? '')) continue;
        const url = job.url.replace(/[?&]utm_source=freehire\.me/, '');
        const requisition = `${new URL(url).host}|${job.title}|${url.match(/(\d{4,})(?!.*\d{4,})/)?.[1] ?? url}`;
        if (seen.has(requisition)) continue;
        seen.add(requisition);
        const text = plain(job.description);
        const salary = job.enrichment?.salary_min ? structuredPay(job.enrichment.salary_min, job.enrichment.salary_max, job.enrichment.salary_currency, job.enrichment.salary_period ?? '', fx) : null;
        out.push({ url, title: job.title, company: job.company, location: job.location ?? '', text, pay: salary ?? payFromText(text, fx) });
      }
      if (jobs.length < 50) break;
    }
  }
  return out;
}
