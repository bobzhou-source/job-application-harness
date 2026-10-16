// Work-right answers for the posting's country. Stored answers describe the applicant's US status; for a posting in a
// country outside applicant.workAuthorizedCountries, authorization and sponsorship questions get the truthful answers
// before any stored value, learned mapping, model, or form fill sees them. US postings keep stored answers untouched.
import { normalize } from './answers.mjs';

const US = 'United States';
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
// Cities, provinces and states that name a country's territory: "authorized to work in New Jersey" is a US question.
const PLACE_COUNTRIES = [
  ['london', 'United Kingdom'], ['edinburgh', 'United Kingdom'], ['manchester', 'United Kingdom'], ['glasgow', 'United Kingdom'],
  ['toronto', 'Canada'], ['montreal', 'Canada'], ['ottawa', 'Canada'], ['calgary', 'Canada'], ['vancouver', 'Canada'], ['waterloo', 'Canada'],
  ['ontario', 'Canada'], ['quebec', 'Canada'], ['british columbia', 'Canada'], ['alberta', 'Canada'],
  ['sydney', 'Australia'], ['melbourne', 'Australia'],
  ['dublin', 'Ireland'], ['paris', 'France'], ['berlin', 'Germany'], ['munich', 'Germany'], ['amsterdam', 'Netherlands'], ['zurich', 'Switzerland'],
  ['tel aviv', 'Israel'], ['tokyo', 'Japan'], ['shanghai', 'China'], ['beijing', 'China'], ['shenzhen', 'China'], ['dubai', 'United Arab Emirates'],
  ['bangalore', 'India'], ['bengaluru', 'India'], ['hyderabad', 'India'], ['mumbai', 'India'], ['pune', 'India'], ['chennai', 'India'],
  ...['chicago', 'houston', 'boston', 'seattle', 'san francisco', 'los angeles', 'atlanta', 'dallas', 'austin', 'denver', 'miami',
    'philadelphia', 'phoenix', 'detroit', 'minneapolis', 'pittsburgh', 'san diego', 'san jose', 'washington dc', 'washington d c',
    'new york city', 'nyc', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'redmond', 'bellevue', 'raleigh', 'charlotte',
    'nashville', 'st louis', 'kansas city', 'salt lake city', 'baltimore', 'cincinnati', 'columbus', 'indianapolis', 'milwaukee',
    'tampa', 'orlando', 'las vegas', 'san antonio', 'sacramento', 'omaha', 'ann arbor', 'boulder', 'irvine', 'santa clara',
    'jersey city', 'hoboken', 'stamford', 'princeton', 'new haven', 'hartford', 'providence', 'buffalo', 'albany', 'plano',
    'dearborn', 'bentonville', 'cupertino', 'santa monica', 'el segundo', 'oakland', 'berkeley', 'pasadena', 'fort worth',
    'portland oregon', 'portland maine', 'jacksonville', 'louisville', 'richmond virginia', 'durham', 'chapel hill'].map(city => [city, 'United States']),
  ...['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'hawaii', 'idaho',
    'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
    'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
    'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'west virginia', 'wisconsin', 'wyoming'].map(state => [state, 'United States']),
];
const COUNTRY_NAMES = (() => {
  const names = new Map();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = REGION_NAMES.of(code);
      if (name && name !== code && name.length >= 4) names.set(normalize(name), name);
    }
  }
  names.set('united states of america', US);
  names.set('usa', US);
  names.set('u s a', US);
  names.set('u s', US);
  names.set('united kingdom', 'United Kingdom');
  names.set('u k', 'United Kingdom');
  names.set('uk', 'United Kingdom');
  for (const nation of ['England', 'Scotland', 'Wales', 'Northern Ireland']) names.set(normalize(nation), 'United Kingdom');
  names.set('south korea', 'South Korea');
  names.set('republic of korea', 'South Korea');
  names.set('czech republic', 'Czechia');
  for (const [place, country] of PLACE_COUNTRIES) names.set(place, country);
  return [...names].sort((a, b) => b[0].length - a[0].length);
})();

// Names that are also place names inside countries ("New Jersey", "Georgia, USA"): counted only for config values.
const AMBIGUOUS_COUNTRY_NAMES = new Set(['georgia', 'jordan', 'chad', 'guinea', 'turkey', 'jersey', 'guernsey']);
const LOCATION_WORDS = /\b(locations?|located|based|office|workplace|work location|job location|primary location|country|city|remote in|hybrid in|on site in)\b/;
// A phone form's "country code (e.g., +57 for Colombia)", a sensor's "ground-based" name and "the largest bank based
// on market capitalization" place no workplace.
const NOT_LOCATION = /\b(?:country|dial(?:ing)?|calling) code\b|\b(?:ground|cloud|web|browser|text|evidence|data|rule|skill|team|office) based\b|\bbased (?:on|upon)\b/g;
// A street address ("2225 Lawson Lane, 95054 Santa Clara, California, United States") places the job as surely as a
// location marker: a US ZIP, a Canadian or UK postal code beside the country name.
const POSTAL_CODE = /\b\d{5}(?: \d{4})?\b|\b[a-z]\d[a-z] ?\d[a-z]\d\b|\b[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}\b/;
// A region line ("Region: AMS - North America and Canada") groups territories; it is no location line.
const REGION_LINE = /\bregions?\b|\band\b|&/i;
// "Edina, MN" / "Lexington, MA, US" under the title: a city with a US state abbreviation.
const US_STATE_LINE = /\b[A-Z][A-Za-z.' ]{2,30}, ?(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b(?![A-Za-z])/;
const AUTHORIZATION = /\b(authori[sz](?:ed|ation)|lawfully|legally|legal right|right to work|eligible to work|work eligibility|proper work (?:authori[sz]ation|documents?))\b/;
const SPONSORSHIP = /\b(sponsor(?:ship|ed|ing)?|immigration benefit|employer support|company support|support (?:to|with|for) (?:obtain|secur|maintain|renew|extend|transfer)|assistance (?:to|with|for) (?:obtain|secur)|require[^.]{0,50}(?:work permit|employment visa)|need[^.]{0,50}(?:work permit|employment visa))\b/;
const PERMIT = /\b(?:currently |already |now )?(?:have|hold|possess)[^.]{0,40}\b(?:work permit|employment visa|valid visa)\b/;
// A question is about work rights only when it names work, employment, a visa, a permit, or immigration.
const WORK_OBJECT = /\b(work|employ|employment|visa|permit|immigration|hire|hiring)\b/;

// Every country named in the text, each with the offsets of its mentions in the normalized text. Longer place names
// shadow the shorter ones inside them ("New Mexico" is no mention of Mexico).
function countriesIn(text, { ambiguous = false } = {}) {
  let source = ` ${normalize(text)} `;
  const found = new Map();
  for (const [phrase, country] of COUNTRY_NAMES) {
    if (!ambiguous && AMBIGUOUS_COUNTRY_NAMES.has(phrase)) continue;
    const padded = ` ${phrase} `;
    for (let at = source.indexOf(padded); at >= 0; at = source.indexOf(padded, at + 1)) {
      found.set(country, [...(found.get(country) ?? []), { at, length: phrase.length }]);
      source = `${source.slice(0, at + 1)}${' '.repeat(phrase.length)}${source.slice(at + 1 + phrase.length)}`;
    }
  }
  return found;
}

function sameCountry(left, right) {
  const a = [...countriesIn(left, { ambiguous: true }).keys()][0] ?? String(left);
  const b = [...countriesIn(right, { ambiguous: true }).keys()][0] ?? String(right);
  return normalize(a) === normalize(b);
}

// A site's language picker ("English (Canada)", "Français (Canada)", "English (United Kingdom)") names the UI locale,
// not where the job is.
const LANGUAGE_LABEL = /\b(?:english|fran[cç]ais|french|espa[nñ]ol|spanish|deutsch|german|portugu[eê]s|italiano|nederlands|日本語|中文)\s*\([^)]{2,40}\)/giu;

// The posting page is authoritative. A country on the short location line under the title ("New York, NY") or
// beside a location marker beats incidental mentions (an office list "located in London, New York, Chicago" ties
// and the tie stays US); the posting URL's location slug (Workday's /job/Warren-Michigan-United-States-of-America/)
// and a country top-level domain are weaker hints. Unknown and tied postings stay US (the historical default).
// Observed page text is head-and-tail capped (lib/snapshot/output.mjs joins the two with "\n…\n"): the tail is the
// page footer ("About Us: Royal Bank of Canada…") and names no workplace, so only the head is read.
export function inferPostingCountry({ postingText = '', title = '', url = '' } = {}) {
  const primary = `${title}\n${String(postingText).split('\n…\n')[0]}`.replace(LANGUAGE_LABEL, ' ');
  const normalized = normalize(primary);
  const scores = new Map();
  const bump = (country, score) => scores.set(country, Math.max(scores.get(country) ?? 0, score));
  for (const [country, mentions] of countriesIn(primary)) {
    // Every mention counts; the best one scores the country.
    for (const { at, length } of mentions) {
      let score = 2;
      if (at < 600) score += 1;
      const around = normalized.slice(Math.max(0, at - 90), at + length + 90).replace(NOT_LOCATION, ' ');
      if (LOCATION_WORDS.test(around) || POSTAL_CODE.test(around)) score += 5;
      bump(country, score);
    }
  }
  // The short lines at the top of the page and the ones right under the title in the page (a cookie banner or a
  // long site header pushes the title, and the location line below it, past the first dozen lines).
  const lines = primary.split(/\n|•|\|/).map(line => line.trim());
  const titleHead = normalize(title).split(' ').slice(0, 4).join(' ');
  const titleAt = titleHead ? lines.findIndex((line, index) => index > 0 && normalize(line).startsWith(titleHead)) : -1;
  const window = [...lines.slice(0, 12), ...(titleAt > 0 ? lines.slice(titleAt + 1, titleAt + 11) : [])];
  for (const line of window.filter(line => line.length <= 60 && !REGION_LINE.test(line))) {
    for (const country of countriesIn(line).keys()) bump(country, 7);
    if (US_STATE_LINE.test(line)) bump(US, 7);
  }
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/[a-z]{2}-[A-Za-z]{2}(?=\/)/, '').replace(/[-_+]/g, ' ');
    for (const country of countriesIn(path).keys()) bump(country, 5);
  } catch { /* a missing or non-URL context has no country hint */ }
  try {
    const host = new URL(url).hostname.toLowerCase();
    const tldCountry = host.endsWith('.uk') ? 'United Kingdom'
      : host.endsWith('.ca') ? 'Canada'
        : host.endsWith('.au') ? 'Australia'
          : host.endsWith('.nz') ? 'New Zealand'
            : null;
    if (tldCountry) bump(tldCountry, 5);
  } catch { /* a missing or non-URL context has no country hint */ }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 3 || (ranked[1] && ranked[0][1] === ranked[1][1])) return US;
  return ranked[0][0];
}

// The per-run status: the posting's country and whether the applicant may work there without sponsorship or a permit.
export function workAuthorizationStatus(posting, applicant) {
  const country = inferPostingCountry(posting);
  const workAuthorizedCountries = applicant?.workAuthorizedCountries ?? [US];
  return {
    country,
    workAuthorizedCountries,
    authorized: workAuthorizedCountries.some(item => sameCountry(item, country)),
  };
}

// A question that names a country is answered for that country; otherwise for the posting's country.
function scopeCountry(text, postingCountry) {
  const explicit = [...countriesIn(text).keys()];
  if (explicit.includes(US)) return US;
  return explicit[0] ?? postingCountry;
}

function yesNoPreserving(existing, yes) {
  const value = String(existing ?? '').trim();
  const agrees = yes
    ? /^(yes\b|currently |legally |lawfully |authorized\b|authorised\b|will require\b|require sponsorship\b)/i.test(value)
    : /^(no\b|not\b|none\b|n\/a\b|not applicable\b|no existing\b)/i.test(value);
  return agrees ? value : (yes ? 'Yes' : 'No');
}

// Returns null when the stored answer stands: unrelated questions, and questions scoped to the US for a US posting.
// Otherwise returns {kind, country, answer}; the caller stores the answer under the question's own qa key.
export function resolveWorkAuthorizationAnswer(question, status, existing = '') {
  const text = normalize(question);
  const country = scopeCountry(text, status.country);
  if (country === US && status.country === US) return null;
  const authorized = status.workAuthorizedCountries.some(item => sameCountry(item, country));
  if (PERMIT.test(text)) return authorized ? null : { kind: 'permit', country, answer: yesNoPreserving(existing, false) };
  if (SPONSORSHIP.test(text) && WORK_OBJECT.test(text)) return { kind: 'sponsorship', country, answer: yesNoPreserving(existing, !authorized) };
  if (AUTHORIZATION.test(text) && WORK_OBJECT.test(text)) return { kind: 'authorization', country, answer: yesNoPreserving(existing, authorized) };
  return null;
}

// Rewrites the values map for a non-US posting: the generic facts and every stored qa answer that is a work-right
// question. A US posting changes nothing.
export function applyWorkAuthorization(values, status) {
  if (status.country === US) return;
  values.set('facts.work_authorization', status.authorized ? 'Yes' : 'No');
  values.set('facts.sponsorship', status.authorized ? 'No' : 'Yes');
  for (const key of [...values.keys()]) {
    if (!key.startsWith('qa.') || /\.(?:alt|alias)_\d+$/.test(key)) continue;
    const resolved = resolveWorkAuthorizationAnswer(key.slice(3), status, values.get(key));
    if (resolved) values.set(key, resolved.answer);
  }
}
