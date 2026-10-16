// answers.json load/save + question normalization. Schema: { facts: {...}, qa: { "<normalized question>": "<answer>" },
// written: { "<site key>": { "<normalized question>": [{ text, posting, title, t }, …] } } } — `qa` is
// applicant-universal, `written` holds the answers a model composed for one posting on one site (lib/apply/accounts.mjs
// rememberForSite): each entry names the posting id and title it was composed for, and overlaySiteAnswers replays it
// only on that posting or one with the same title. A bare string entry is a legacy answer whose posting is unknown; it
// replays nowhere until `report.mjs --site-answers --annotate` pins it from the ledger. The site key is the host, plus
// the employer's path segment on a multi-tenant ATS host (siteKey), so one employer's answers never reach another.
import { readFileSync, writeFileSync } from 'node:fs';

export function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function save(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// lowercase, collapse whitespace/punctuation
export function normalize(question) {
  return String(question ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hosts that serve many employers under one hostname: the employer (or, on Handshake, the posting) is the path
// segment at `index`. Everywhere else the hostname alone names the employer (Workday, Oracle, iCIMS tenants).
const MULTI_TENANT = [
  [/^(?:[\w-]+\.)?(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, 0],
  [/^jobs(?:\.eu)?\.lever\.co$/, 0],
  [/^jobs\.ashbyhq\.com$/, 0],
  [/^apply\.workable\.com$/, 0],
  [/^jobs\.jobvite\.com$/, 0],
  [/^jobs\.smartrecruiters\.com$/, 0],
  [/^app\.careerpuck\.com$/, 1],
  [/^[\w-]+\.joinhandshake\.com$/, 1],
  [/^[\w-]+\.myworkdaysite\.com$/, 1],
];
export function siteKey(url) {
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase();
  const rule = MULTI_TENANT.find(([pattern]) => pattern.test(host));
  if (!rule) return host;
  const segment = pathname.split('/').filter(Boolean)[rule[1]];
  return segment ? `${host}/${segment.toLowerCase()}` : host;
}
