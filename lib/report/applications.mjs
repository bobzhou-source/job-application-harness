// Deterministic breakdown of unique submitted postings. Reads the run traces and queue/discovery history,
// never a model or the browser. Location precedence is Workday URL, then early posting text, then queued metadata.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = `${ROOT}runs/`;
const COLUMNS = ['t', 'company', 'title', 'ats', 'city', 'state', 'country', 'remote', 'lane', 'pay_hr', 'resume', 'host', 'url'];
const GENERIC_WORKDAY = new Set(['globalhr', 'jobs', 'careers']);
const WORKDAY_COUNTRIES = new Map([
  ['US', 'United States'], ['USA', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['UK', 'United Kingdom'],
  ['IE', 'Ireland'], ['IN', 'India'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['ES', 'Spain'],
  ['SG', 'Singapore'], ['JP', 'Japan'], ['AU', 'Australia'], ['CN', 'China'], ['PL', 'Poland'], ['MX', 'Mexico'],
  ['BR', 'Brazil'], ['IT', 'Italy'], ['CH', 'Switzerland'], ['SE', 'Sweden'], ['KR', 'South Korea'], ['TW', 'Taiwan'],
]);

// Public tenant aliases for common Workday submissions. Brand-shaped tenants not listed here remain verbatim.
const WORKDAY_TENANTS = {
  bah: 'Booz Allen', baird: 'Baird', ceritypartners: 'Cerity Partners', axos: 'Axos',
  generalmotors: 'General Motors', theocc: 'OCC', abglobal: 'AllianceBernstein', avav: 'AeroVironment',
  amfam: 'American Family Insurance', gdit: 'GDIT', guardianlife: 'Guardian Life', icf: 'ICF',
  stryker: 'Stryker', rb: 'Federal Reserve', rbc: 'RBC', americancentury: 'American Century',
  capgroup: 'Capital Group', kla: 'KLA', motorolasolutions: 'Motorola Solutions', ankura: 'Ankura',
  brunswick: 'Brunswick', elkay: 'Elkay', pimco: 'PIMCO', plantemoran: 'Plante Moran',
  vanguard: 'Vanguard', abb: 'ABB', accenture: 'Accenture', otis: 'Otis', xcelenergy: 'Xcel Energy',
  amgen: 'Amgen', boeing: 'Boeing', caci: 'CACI', freddiemac: 'Freddie Mac',
  globalfoundries: 'GlobalFoundries', jainglobal: 'Jain Global', mufgub: 'MUFG Union Bank',
  rockwellautomation: 'Rockwell Automation', dowjones: 'Dow Jones', commercebank: 'Commerce Bank',
  ngc: 'Northrop Grumman', aoins: 'Aon',
};

const US_REGIONS = `AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming|PR:Puerto Rico`;
const CA_REGIONS = `AB:Alberta|BC:British Columbia|MB:Manitoba|NB:New Brunswick|NL:Newfoundland and Labrador|NS:Nova Scotia|NT:Northwest Territories|NU:Nunavut|ON:Ontario|PE:Prince Edward Island|QC:Quebec|SK:Saskatchewan|YT:Yukon`;
const REGIONS = [];
const regionRows = (text, country) => text.split('|').forEach(row => {
  const [code, name] = row.split(':');
  REGIONS.push({ code, name, country });
});
regionRows(US_REGIONS, 'United States');
regionRows(CA_REGIONS, 'Canada');
const REGION_BY_CODE = new Map(REGIONS.map(region => [region.code, region]));
const REGION_BY_NAME = new Map(REGIONS.flatMap(region => [[region.name.toLowerCase(), region], [region.code.toLowerCase(), region]]));
const REGION_NAMES = [...new Set(REGIONS.map(region => region.name))].sort((a, b) => b.length - a.length);
const COUNTRIES = [
  'United States', 'United States of America', 'USA', 'US', 'Canada', 'United Kingdom', 'UK', 'England',
  'India', 'Germany', 'France', 'Netherlands', 'Spain', 'Ireland', 'Switzerland', 'Singapore', 'Japan',
  'Australia', 'China', 'Hong Kong', 'Poland', 'Czechia', 'Czech Republic', 'Romania', 'Portugal',
  'Israel', 'United Arab Emirates', 'Mexico', 'Brazil', 'Argentina', 'Philippines', 'Sweden', 'Norway',
  'Denmark', 'Finland', 'Austria', 'Belgium', 'Italy', 'South Korea', 'Taiwan', 'New Zealand',
].sort((a, b) => b.length - a.length);
const COUNTRY_ALIAS = new Map([
  ['us', 'United States'], ['usa', 'United States'], ['u.s.', 'United States'], ['u.s.a.', 'United States'],
  ['united states', 'United States'], ['united states of america', 'United States'],
  ['uk', 'United Kingdom'], ['u.k.', 'United Kingdom'], ['england', 'United Kingdom'],
  ['great britain', 'United Kingdom'], ['united kingdom', 'United Kingdom'],
]);
const COUNTRY_BY_NAME = new Map(COUNTRIES.map(country => [country.toLowerCase(), COUNTRY_ALIAS.get(country.toLowerCase()) ?? country]));
const REMOTE = /\b(?:remote|hybrid[- ]remote)\b/i;
const FORM_PAGE = /\b(?:My Information|My Experience|Candidate Home|Resume upload|current step \d+ of \d+|Application Questions|Voluntary Disclosures)\b/;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const hasLocation = location => Boolean(location && (location.city || location.state || location.country || location.remote));
const emptyLocation = remote => ({ city: '', state: '', country: '', remote: Boolean(remote) });

export function jobKey(value) {
  try {
    const raw = String(value ?? '').trim();
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^boards\.greenhouse\.io$/, 'job-boards.greenhouse.io');
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:application|apply)$/i, '') || '/';
    return `${url.origin}${url.pathname}`;
  } catch { return String(value ?? '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
}

function readLines(path) {
  try { return readFileSync(path, 'utf8').split('\n'); } catch { return []; }
}

function payHour(value) {
  const text = String(value ?? '');
  if (!text || /^(?:unstated|n\/?a|unknown|\?)$/i.test(text.trim())) return '';
  const hourly = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)(?:\s*[-–—]\s*\$?\s*(\d[\d,]*(?:\.\d+)?))?\s*\/\s*(?:hr|hour)\b/i);
  const column = text.trim().match(/^\$?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*[-–—]\s*\$?\s*(\d[\d,]*(?:\.\d+)?))?(?:\s*\/\s*(?:hr|hour))?$/i);
  const match = hourly ?? column;
  if (!match) return '';
  const amounts = match.slice(1).filter(Boolean).map(number => Number(number.replace(/,/g, ''))).filter(number => number > 0 && number < 1000);
  if (!amounts.length) return '';
  // Discovery's pay gate compares the floor of an hourly range; retain the same meaning in this report.
  return String(Math.round(Math.min(...amounts) * 100) / 100);
}

function queueIndex() {
  const index = new Map();
  const add = (url, patch) => {
    const key = jobKey(url);
    if (!key || !/^https?:\/\//.test(key)) return;
    const current = index.get(key) ?? {};
    for (const [field, value] of Object.entries(patch)) {
      if (current[field] == null && value != null && String(value).trim()) current[field] = String(value).trim();
    }
    index.set(key, current);
  };
  const richTable = (path, pack = '') => {
    for (const line of readLines(path)) {
      const cells = line.split('\t');
      if (!/^https?:\/\//i.test(cells[0] ?? '')) continue;
      add(cells[0], { lane: cells[1], name: cells[2], ats: cells[3], location: cells[4], pay: cells[5], sourcePack: pack || undefined });
    }
  };
  richTable(`${RUNS}manual-apply.tsv`);
  const sources = `${RUNS}sources/`;
  if (existsSync(sources)) {
    for (const name of readdirSync(sources).filter(name => name.endsWith('.tsv')).sort()) {
      richTable(`${sources}${name}`, name.replace(/\.tsv$/, ''));
    }
  }
  for (const line of readLines(`${RUNS}queue-results.txt`)) {
    const match = line.match(/^=== (.*) \(([^()\t\r\n]+)\) (\S+)/);
    if (match) add(match[3], { name: match[1], lane: match[2] });
  }
  for (const path of [`${ROOT}queue.tsv`, `${RUNS}workday-queue.tsv`]) {
    for (const line of readLines(path)) {
      const cells = line.split('\t');
      if (/^https?:\/\//i.test(cells[0] ?? '')) add(cells[0], { lane: cells[1], name: cells[2] });
    }
  }
  // Discovery keeps the source board only in this log: queue.tsv itself is url/lane/name.
  for (const line of readLines(`${RUNS}pay-live-discovery.log`)) {
    const match = line.match(/^(\S+)\t(.+?)\t(https?:\/\/\S+)\t\(([^)\r\n]+)\)\s*$/)
      ?? line.match(/^(\S+)\s+(.+?)\s+(https?:\/\/\S+)\s+\(([^)\r\n]+)\)\s*$/);
    if (match) add(match[3], { lane: match[1], name: match[2], sourceBoard: match[4] });
  }
  return index;
}

function titlePlace(value) {
  return clean(String(value ?? '').replace(/[-_]+/g, ' ')).split(' ')
    .map(word => {
      const lower = word.toLowerCase();
      if (lower === 'mclean') return 'McLean';
      if (lower === 'ft') return 'Ft';
      if (lower === 'st') return 'St';
      return word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : '';
    }).join(' ');
}

function countryName(value) {
  const key = clean(value).replace(/\.$/, '').toLowerCase();
  return COUNTRY_ALIAS.get(key) ?? COUNTRY_BY_NAME.get(key) ?? '';
}

function region(value) {
  return REGION_BY_NAME.get(clean(value).replace(/\.$/, '').toLowerCase()) ?? null;
}

function workdayLocation(value) {
  let slug;
  try { slug = decodeURIComponent(String(value ?? '')); } catch { slug = String(value ?? ''); }
  slug = slug.replace(/\+/g, ' ').replace(/-{2,}/g, '-').trim();
  const remote = REMOTE.test(slug);
  const result = emptyLocation(remote);
  if (!slug) return result;
  const cityFrom = parts => {
    const words = [];
    for (const part of parts) {
      if (!part || /^(?:HQ|US|USA|UNITED|STATES)$/i.test(part)) continue;
      if (/^\d/.test(part) || /^BLDG/i.test(part)) break;
      words.push(part);
    }
    while (words.length && /^(?:Campus|Office|HQ|Building|Site|Corporate)$/i.test(words.at(-1))) words.pop();
    return titlePlace(words.join(' '));
  };

  // RTX-style segments carry country/state, city, then a numeric site code and street address.
  const prefixed = slug.match(/^([A-Za-z]{2,3})-([A-Za-z]{2})-(.+)$/);
  if (prefixed) {
    const country = WORKDAY_COUNTRIES.get(prefixed[1].toUpperCase());
    const state = REGION_BY_CODE.get(prefixed[2].toUpperCase());
    if (country && state) return { city: cityFrom(prefixed[3].split('-')), state: state.code, country: state.country, remote };
  }

  let base = slug;
  for (const country of COUNTRIES) {
    const suffix = country.replace(/ /g, '-');
    if (base.length > suffix.length + 1 && base.toLowerCase().endsWith(`-${suffix.toLowerCase()}`)) {
      result.country = countryName(country);
      base = base.slice(0, -(suffix.length + 1));
      break;
    }
  }
  for (const name of REGION_NAMES) {
    const suffix = name.replace(/ /g, '-');
    if (base.length > suffix.length + 1 && base.toLowerCase().endsWith(`-${suffix.toLowerCase()}`)) {
      const found = REGION_BY_NAME.get(name.toLowerCase());
      result.state = found.code;
      result.country ||= found.country;
      base = base.slice(0, -(suffix.length + 1));
      break;
    }
  }
  const tokenized = base.split('-');
  for (let index = 0; index < tokenized.length; index += 1) {
    if (tokenized[index].length !== 2) continue;
    const code = tokenized[index].toUpperCase();
    const found = REGION_BY_CODE.get(code);
    if (!found || ['IN', 'ON', 'OR', 'TO', 'OF', 'AT', 'US'].includes(code)) continue;
    const before = tokenized.slice(0, index);
    const after = tokenized.slice(index + 1);
    if (!before.length && !after.length) continue;
    result.state = found.code;
    result.country ||= found.country;
    result.city = cityFrom(before.length ? before : after);
    return result;
  }
  if (!result.state) {
    const match = base.match(/^(.+)-([A-Z]{2})$/);
    const found = match && REGION_BY_CODE.get(match[2].toUpperCase());
    if (found) {
      result.state = found.code;
      result.country ||= found.country;
      base = match[1];
    }
  }
  if (!result.state && base.length > 2 && !base.includes('-')) {
    const found = region(base);
    if (found) { result.state = found.code; result.country ||= found.country; base = ''; }
  }
  if (!result.state) {
    const match = base.match(/^([A-Za-z]{2})-(.+)$/);
    const found = match && REGION_BY_CODE.get(match[1].toUpperCase());
    if (found) { result.state = found.code; result.country ||= found.country; base = match[2]; }
  }
  if (!remote && base && !/^(?:united|us|usa)$/i.test(base)) result.city = cityFrom(base.split('-'));
  return result;
}

function parseLocation(value, { workday = false, page = false } = {}) {
  const text = String(value ?? '').slice(0, page ? 3200 : 1000);
  if (workday) return workdayLocation(text);
  const remote = REMOTE.test(text);
  const fallback = emptyLocation(remote);
  if (!text.trim()) return fallback;

  const candidates = [];
  for (let line of text.split('\n').slice(0, page ? 60 : 20)) {
    line = line.trim();
    if (!line || line.length > 220 || /^https?:\/\//i.test(line)) continue;
    line = line.replace(/^(?:locations?|office locations?|job locations?)\s*[:\-]?\s*/i, '');
    line = line.replace(/^.*?\b(?:based|located)\s+(?:in|out of)\s+/i, '');
    candidates.push(...line.split(/\s*(?:;|\||\/)\s*/));
    for (const match of line.matchAll(/\(([^()]+)\)/g)) candidates.push(match[1]);
  }
  const countryPattern = COUNTRIES.join('|').replace(/[.]/g, '\\.');
  const regionNamePattern = REGION_NAMES.join('|').replace(/[.]/g, '\\.');
  for (let candidate of candidates) {
    candidate = clean(candidate).replace(/^(?:in|at|option)\s+/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!candidate) continue;
    if (/^[A-Za-z]{2,3}-[A-Za-z]{2}-/.test(candidate)) {
      const located = workdayLocation(candidate.split(/\s*[~]/)[0]);
      if (hasLocation(located)) return { ...located, remote: located.remote || remote };
    }
    let match = candidate.match(/^([A-Za-z][A-Za-z.'’ -]{0,70}?),\s*([A-Z]{2})(?:,\s*(.+))?$/);
    if (match) {
      const found = REGION_BY_CODE.get(match[2]);
      if (found) {
        const statedCountry = countryName(match[3]?.split(/[,;/]/)[0] ?? '');
        return { city: titlePlace(match[1]), state: found.code, country: statedCountry || found.country, remote };
      }
    }
    match = candidate.match(new RegExp(`^([A-Za-z][A-Za-z.'’ -]{0,70}?),\\s*(${regionNamePattern})(?:,\\s*(.+))?$`, 'i'));
    if (match) {
      const found = region(match[2]);
      const statedCountry = countryName(match[3]?.split(/[,;/]/)[0] ?? '');
      return { city: titlePlace(match[1]), state: found.code, country: statedCountry || found.country, remote };
    }
    match = candidate.match(new RegExp(`^([A-Za-z][A-Za-z.'’ -]{0,70}?),\\s*(${countryPattern})$`, 'i'));
    if (match) return { city: titlePlace(match[1]), state: '', country: countryName(match[2]), remote };
    const onlyCountry = countryName(candidate.replace(/^(?:remote|hybrid[- ]remote)(?:\s+in)?\s*,?\s*/i, ''));
    if (remote && onlyCountry) return { city: '', state: '', country: onlyCountry, remote };
    const onlyRegion = region(candidate);
    if (onlyRegion && (candidate.includes(' ') || candidate.length > 3)) return { city: '', state: onlyRegion.code, country: onlyRegion.country, remote };
  }
  return fallback;
}

function description(value) {
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? '' : value;
  if (!value || typeof value !== 'object') return '';
  return [value.pageText, value.postingText, value.description, value.text].find(text => typeof text === 'string' && text) ?? '';
}

function traceInfo(row) {
  const info = { titles: [], texts: [], location: null, remote: false };
  if (!row.trace) return info;
  const lines = readLines(`${RUNS}${row.trace}`);
  let seen = 0;
  for (const line of lines) {
    if (!line.includes('"pageText"') && !line.includes('"posting"') && !line.includes('"job"') && !line.includes('"event":"snapshot"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const title = event.state?.title ?? event.state?.url?.title ?? event.snapshot?.title ?? event.snapshot?.url?.title ?? event.url?.title ?? event.title;
    if (title && !info.titles.includes(title)) info.titles.push(title);
    const texts = [event.state?.pageText, event.snapshot?.pageText, event.pageText, description(event.posting), description(event.job)]
      .filter(text => typeof text === 'string' && text.trim());
    if (!texts.length) continue;
    seen += 1;
    for (const text of texts) {
      const sample = text.slice(0, 5000);
      if (info.texts.length < 5 && !info.texts.includes(sample)) info.texts.push(sample);
      info.remote ||= REMOTE.test(sample.slice(0, 1800));
      if (!info.location && !FORM_PAGE.test(sample.slice(0, 500))) {
        const located = parseLocation(sample, { page: true });
        if (hasLocation(located)) info.location = located;
      }
    }
    if ((info.location && info.texts.length >= 2) || seen >= 8) break;
  }
  return info;
}

function mergeTrace(target, source) {
  for (const title of source.titles) if (!target.titles.includes(title)) target.titles.push(title);
  for (const text of source.texts) if (target.texts.length < 8 && !target.texts.includes(text)) target.texts.push(text);
  target.location ||= source.location;
  target.remote ||= source.remote;
  return target;
}

function handshakeCompany(title) {
  const parts = String(title ?? '').split('|').map(part => part.trim());
  return parts.length >= 3 && parts.at(-1) === 'Handshake' ? parts.at(-2) : '';
}

function companyFromTitleOrText(title, texts) {
  const titleText = String(title ?? '').trim();
  let match = titleText.match(/\s+(?:at|@)\s+([^|@]+?)\s*$/i);
  if (match) return clean(match[1]);
  match = titleText.match(/^(.{2,60}?)\s+—\s+.+$/);
  if (match) return clean(match[1]);
  for (const text of texts) {
    match = text.match(/\bAt\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4}),\s+(?:our|we|the)\b/);
    if (match) return clean(match[1]);
    match = text.match(/\bAbout\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4})\s*(?:\n|,)/);
    if (match) return clean(match[1]);
  }
  return '';
}

function registrableDomain(host) {
  const labels = String(host ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  const suffix2 = labels.slice(-2).join('.');
  const suffix3 = ['co.uk', 'org.uk', 'ac.uk', 'com.au', 'com.br', 'co.jp', 'co.in', 'com.sg', 'com.hk'];
  return labels.length >= 3 && suffix3.includes(suffix2) ? labels.slice(-3).join('.') : suffix2;
}

export function atsFor(host) {
  host = String(host ?? '').toLowerCase();
  if (host.includes('joinhandshake.com')) return 'handshake';
  if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com')) return 'workday';
  if (host.includes('greenhouse.io')) return 'greenhouse';
  if (host.includes('ashbyhq.com')) return 'ashby';
  if (host.includes('lever.co')) return 'lever';
  if (host.includes('icims.com')) return 'icims';
  if (host.includes('dayforcehcm.com')) return 'dayforce';
  if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (host.includes('brassring.com')) return 'brassring';
  return 'other';
}

function boardSlug(row) {
  try {
    return new URL(row.job).pathname.split('/').filter(Boolean)[0] ?? '';
  } catch { return ''; }
}

function meaningfulTitle(row, related) {
  const titles = [row, ...related].map(item => String(item.title ?? '').trim())
    .filter(title => title && title !== 'Handshake' && title !== 'Jobs | Handshake');
  return titles[0] ?? '';
}

function resumeFor(row) {
  return row.resume ?? row.submittedWith?.find(file => /resume|cv/i.test(file)) ?? row.uploaded?.find(file => /resume|cv/i.test(file)) ?? '';
}

function tally(rows, key, { limit = Infinity, blank = false, chronological = false } = {}) {
  const counts = new Map();
  for (const row of rows) {
    const name = String(key(row) || (blank ? '?' : ''));
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const list = [...counts];
  list.sort(chronological ? (a, b) => a[0].localeCompare(b[0]) : (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return list.slice(0, limit);
}

function printTally(title, entries) {
  console.log(`\n${title}`);
  for (const [name, count] of entries) console.log(`  ${String(count).padStart(4)}  ${name}`);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const fraction = index - low;
  return sorted[low] + ((sorted[low + 1] ?? sorted[low]) - sorted[low]) * fraction;
}

function tsv(rows) {
  const cell = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return `${[COLUMNS.join('\t'), ...rows.map(row => COLUMNS.map(column => cell(row[column])).join('\t'))].join('\n')}\n`;
}

// One row per unique submitted job with posting metadata. Extra fields beyond COLUMNS are for the app ledger.
export function collectApplications(selectedRows, allRows) {
  const queue = queueIndex();
  const relatedByJob = new Map();
  for (const row of [...allRows].sort((a, b) => String(a.t).localeCompare(String(b.t)))) {
    if (!row.job) continue;
    const key = jobKey(row.job);
    const list = relatedByJob.get(key) ?? [];
    list.push(row);
    relatedByJob.set(key, list);
  }
  const submitted = selectedRows.filter(row => row.outcome === 'submitted' && row.job)
    .sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const firstByJob = new Map();
  for (const row of submitted) if (!firstByJob.has(jobKey(row.job))) firstByJob.set(jobKey(row.job), row);

  const rows = [];
  const locationSources = new Map();
  for (const [key, row] of firstByJob) {
    const related = relatedByJob.get(key) ?? [];
    const metadata = queue.get(key) ?? queue.get(jobKey(row.employerPosting)) ?? {};
    const host = String(row.host ?? '');
    const ats = atsFor(host);
    const tenant = host.split('.')[0];
    const workday = ats === 'workday';
    const genericWorkday = workday && GENERIC_WORKDAY.has(tenant);
    let title = meaningfulTitle(row, related) || String(metadata.name ?? '').replace(/\s*\(\$[^)]*\/hr\)\s*$/i, '');
    let located = null;
    let locationSource = '';
    if (workday) {
      const match = String(row.job).match(/\/job\/([^/]+)/i);
      if (match) {
        const fromUrl = workdayLocation(match[1]);
        if (hasLocation(fromUrl)) { located = fromUrl; locationSource = 'workday-url'; }
      }
    }

    // A resolved Workday URL needs no trace unless its generic tenant still needs an employer name.
    const needTrace = !located || genericWorkday || (ats === 'handshake' && !handshakeCompany(title));
    let trace = needTrace ? traceInfo(row) : { titles: [], texts: [], location: null, remote: false };
    if (!title && trace.titles.length) title = trace.titles.find(item => item && item !== 'Handshake') ?? title;
    if (ats === 'handshake' && !handshakeCompany(title)) {
      const tracedTitle = trace.titles.find(item => handshakeCompany(item));
      if (tracedTitle) title = tracedTitle;
    }
    if (ats === 'handshake' && (!handshakeCompany(title) || (!located && !trace.location && !metadata.location))) {
      for (const candidate of related) {
        if (candidate === row || !candidate.trace) continue;
        mergeTrace(trace, traceInfo(candidate));
        if (!handshakeCompany(title)) {
          const tracedTitle = trace.titles.find(item => handshakeCompany(item));
          if (tracedTitle) title = tracedTitle;
        }
        if (handshakeCompany(title) && (located || trace.location || metadata.location)) break;
      }
    }
    if (!located && hasLocation(trace.location)) { located = trace.location; locationSource = 'trace'; }
    const queuedLocation = parseLocation(metadata.location ?? '');
    if (!located && hasLocation(queuedLocation)) { located = queuedLocation; locationSource = 'queue'; }
    located ||= emptyLocation(false);
    if (locationSource) locationSources.set(locationSource, (locationSources.get(locationSource) ?? 0) + 1);

    let company = '';
    if (ats === 'handshake') company = handshakeCompany(title) || companyFromTitleOrText(title, trace.texts);
    else if (workday) company = genericWorkday ? companyFromTitleOrText(title, trace.texts) : WORKDAY_TENANTS[tenant] ?? tenant;
    else if (['greenhouse', 'ashby', 'lever'].includes(ats)) company = boardSlug(row);
    company ||= registrableDomain(host) || '?';

    const remote = Boolean(located.remote || queuedLocation.remote || trace.remote || REMOTE.test(title));
    const pay_hr = payHour(metadata.pay) || payHour(metadata.name);
    rows.push({
      t: row.t, company, title, ats, city: located.city, state: located.state, country: located.country,
      remote, lane: metadata.lane || '?', pay_hr, resume: resumeFor(row), host, url: row.job,
      jobKey: key, tenant, sourceBoard: metadata.sourceBoard || '', sourcePack: metadata.sourcePack || '',
      postedAt: metadata.postedAt || '', summary: row, related,
    });
  }
  return { rows, locationSources, submittedCount: submitted.length };
}

export function applicationBreakdown(selectedRows, allRows, { csv } = {}) {
  const { rows, locationSources, submittedCount } = collectApplications(selectedRows, allRows);
  const out = csv ? resolve(csv) : `${RUNS}applications.tsv`;
  writeFileSync(out, tsv(rows));
  const total = rows.length;
  console.log(`Applications: ${total} unique submitted jobs (${submittedCount} submitted runs, ${submittedCount - total} duplicates folded)`);
  printTally('Top companies (30)', tally(rows, row => row.company, { limit: 30 }));
  printTally('By state', tally(rows, row => row.state, { blank: true }));
  printTally('Top cities (25)', tally(rows, row => row.city, { limit: 25 }));
  console.log(`\nRemote\n  ${rows.filter(row => row.remote).length}`);
  printTally('By lane', tally(rows, row => row.lane, { blank: true }));
  printTally('By ATS', tally(rows, row => row.ats, { blank: true }));
  printTally('By day', tally(rows, row => row.t.slice(0, 10), { chronological: true }));

  const pay = rows.map(row => row.pay_hr).filter(value => value !== '').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const money = value => `$${value.toFixed(2)}`;
  console.log('\nPay distribution (USD/hour, range floors)');
  console.log(pay.length
    ? `  with pay ${pay.length}; median ${money(percentile(pay, 0.5))}; quartiles ${money(percentile(pay, 0.25))} / ${money(percentile(pay, 0.5))} / ${money(percentile(pay, 0.75))}; >=$26 ${pay.filter(value => value >= 26).length}`
    : '  with pay 0; median n/a; quartiles n/a; >=$26 0');
  // The source tally is authoritative for coverage: a title alone can mark remote without resolving a location.
  const resolved = [...locationSources.values()].reduce((sum, count) => sum + count, 0);
  const laneCount = rows.filter(row => row.lane !== '?').length;
  console.log(`\nCoverage: location resolved ${resolved}/${total}, lane ${laneCount}/${total}, pay ${pay.length}/${total}`);
  console.log(`Location sources: ${['workday-url', 'trace', 'queue'].map(source => `${source} ${locationSources.get(source) ?? 0}`).join(', ')}`);
  console.log(`Wrote ${out}`);
  return { rows, locationSources };
}
