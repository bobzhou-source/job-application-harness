const OPENALEX = 'https://api.openalex.org';
const EUROPE_PMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

const COUNTRY_TIME_ZONES = {
  AE: 'Asia/Dubai', AR: 'America/Argentina/Buenos_Aires', AT: 'Europe/Vienna',
  AU: 'Australia/Sydney', BE: 'Europe/Brussels', BR: 'America/Sao_Paulo',
  CA: 'America/Toronto', CH: 'Europe/Zurich', CN: 'Asia/Shanghai',
  DE: 'Europe/Berlin', DK: 'Europe/Copenhagen', EG: 'Africa/Cairo',
  ES: 'Europe/Madrid', FI: 'Europe/Helsinki', FR: 'Europe/Paris',
  GB: 'Europe/London', HK: 'Asia/Hong_Kong', IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata', IT: 'Europe/Rome',
  JP: 'Asia/Tokyo', KE: 'Africa/Nairobi', KR: 'Asia/Seoul',
  MX: 'America/Mexico_City', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo',
  NZ: 'Pacific/Auckland', PL: 'Europe/Warsaw', PT: 'Europe/Lisbon',
  RU: 'Europe/Moscow', SE: 'Europe/Stockholm', SG: 'Asia/Singapore',
  TR: 'Europe/Istanbul', TW: 'Asia/Taipei', UK: 'Europe/London',
  US: 'America/New_York', ZA: 'Africa/Johannesburg',
};

const CITY_TIME_ZONES = {
  'bar harbor': 'America/New_York',
  boston: 'America/New_York',
  cambridge: 'America/New_York',
  chicago: 'America/Chicago',
  denver: 'America/Denver',
  houston: 'America/Chicago',
  'los angeles': 'America/Los_Angeles',
  'new york': 'America/New_York',
  philadelphia: 'America/New_York',
  portland: 'America/New_York',
  sacramento: 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  toronto: 'America/Toronto',
  austin: 'America/Chicago',
};

function canonicalId(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').split('/').pop() ?? '';
}

function requireMailto(mailto) {
  const value = String(mailto ?? '').trim();
  if (!value) throw new Error('OpenAlex requests require a mailto address');
  return value;
}

// Keyless OpenAlex calls share a small daily budget per IP; a free personal key (env OPENALEX_API_KEY) has its own.
async function getJson(url, { headers = {}, timeoutMs = 45_000 } = {}) {
  const key = process.env.OPENALEX_API_KEY;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...(key && url.startsWith(OPENALEX) ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429 && url.startsWith(OPENALEX)) {
    const hours = (Number(response.headers.get('retry-after')) / 3600).toFixed(1);
    throw new Error(`OpenAlex daily budget exhausted (resets in ${hours}h)${key ? '' : '; set OPENALEX_API_KEY in .env (free key: https://help.openalex.org/api/authentication/)'}`);
  }
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.json();
}

function rebuildAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isSafeInteger(position) && position >= 0) words[position] = word;
    }
  }
  return words.filter((word) => word !== undefined).join(' ');
}

function normalizeInstitution(raw) {
  const latitude = Number(raw?.geo?.latitude);
  const longitude = Number(raw?.geo?.longitude);
  return {
    id: canonicalId(raw?.id),
    name: String(raw?.display_name ?? '').trim(),
    type: raw?.type ?? null,
    country: raw?.country_code ?? null,
    city: raw?.geo?.city ?? null,
    geo: Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { lat: latitude, lng: longitude }
      : null,
    ror: raw?.ror ?? null,
    worksCount: Number.isFinite(raw?.works_count) ? raw.works_count : 0,
  };
}

function normalizeDoi(value) {
  const doi = String(value ?? '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return doi || null;
}

function normalizeOrcid(value) {
  const orcid = String(value ?? '').trim().replace(/^https?:\/\/orcid\.org\//i, '');
  return orcid || null;
}

/** Institutions matching a name, or exactly one institution when `query` is an OpenAlex id (I123…). */
export async function searchInstitutions(query, { mailto } = {}) {
  const needle = String(query ?? '').trim();
  if (!needle) throw new Error('institution query is required');
  if (/^I\d+$/i.test(needle)) {
    const one = await getJson(`${OPENALEX}/institutions/${needle.toUpperCase()}?${new URLSearchParams({ mailto: requireMailto(mailto) })}`);
    return one?.id ? [normalizeInstitution(one)] : [];
  }
  const params = new URLSearchParams({
    search: needle,
    'per-page': '8',
    mailto: requireMailto(mailto),
  });
  const data = await getJson(`${OPENALEX}/institutions?${params}`);
  return (data?.results ?? []).map(normalizeInstitution);
}

function worksFilter(instId, sinceDate, departments) {
  const targetId = canonicalId(instId);
  if (!/^I\d+$/i.test(targetId)) throw new Error(`invalid OpenAlex institution id: ${instId}`);
  const start = String(sinceDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) {
    throw new Error(`invalid sinceDate: ${sinceDate}`);
  }
  const depts = departments.map((d) => String(d).trim()).filter(Boolean);
  if (depts.some((d) => /[,|]/.test(d))) throw new Error('department phrases cannot contain "," or "|"');
  const filter = [
    `authorships.institutions.lineage:${targetId}`,
    `from_publication_date:${start}`,
    'has_abstract:true',
    ...(depts.length ? [`raw_affiliation_strings.search:${depts.join('|')}`] : []),
  ].join(',');
  const deptRe = depts.length ? new RegExp(depts.map((d) => d.replace(/[.*+?^${}()[\]\\]/g, '\\$&')).join('|'), 'i') : null;
  return { targetId, filter, deptRe };
}

/** Number of works matching the same filter/search fetchWorks would use (one cheap request). */
export async function countWorks(instId, { sinceDate, mailto, search, departments = [] } = {}) {
  const { filter } = worksFilter(instId, sinceDate, departments);
  const params = new URLSearchParams({ filter, 'per-page': '1', select: 'id', mailto: requireMailto(mailto), ...(search ? { search } : {}) });
  const page = await getJson(`${OPENALEX}/works?${params}`, { timeoutMs: 60_000 });
  return Number(page?.meta?.count ?? 0);
}

/**
 * Recent works with abstracts by authors at `instId` or any of its sub-units (OpenAlex lineage).
 * `search`: OpenAlex full-text relevance search over title/abstract; results come relevance-sorted.
 * `departments`: affiliation phrases (e.g. "Computer Science"); a work must carry one in some raw affiliation
 *   string, and an author only counts as `atInstitution` when their own affiliation names one of them.
 */
export async function fetchWorks(instId, { sinceDate, cap = 600, mailto, search, departments = [] } = {}) {
  const { targetId, filter, deptRe } = worksFilter(instId, sinceDate, departments);
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error(`invalid work cap: ${cap}`);
  if (cap === 0) return [];

  const politeEmail = requireMailto(mailto);
  const select = [
    'id', 'doi', 'display_name', 'publication_year', 'publication_date',
    'primary_location', 'authorships', 'abstract_inverted_index',
  ].join(',');
  const works = [];
  let cursor = '*';

  while (cursor && works.length < cap) {
    const params = new URLSearchParams({
      filter,
      select,
      'per-page': String(Math.min(200, cap - works.length)),
      cursor,
      mailto: politeEmail,
      ...(search ? { search } : {}),
    });
    const page = await getJson(`${OPENALEX}/works?${params}`, { timeoutMs: 60_000 });
    for (const raw of page?.results ?? []) {
      const authors = (raw?.authorships ?? []).map((authorship) => {
        const rawAffiliations = (authorship?.raw_affiliation_strings ?? [])
          .map((value) => String(value).trim())
          .filter(Boolean);
        const inLineage = (authorship?.institutions ?? []).some((institution) =>
          canonicalId(institution?.id) === targetId
          || (institution?.lineage ?? []).some((id) => canonicalId(id) === targetId));
        return {
          id: canonicalId(authorship?.author?.id),
          name: String(authorship?.author?.display_name ?? '').trim(),
          orcid: normalizeOrcid(authorship?.author?.orcid),
          position: ['first', 'middle', 'last'].includes(authorship?.author_position)
            ? authorship.author_position
            : 'middle',
          isCorresponding: Boolean(authorship?.is_corresponding),
          atInstitution: inLineage && (!deptRe || rawAffiliations.some((a) => deptRe.test(a))),
          rawAffiliations,
        };
      }).filter((author) => author.id);

      works.push({
        id: canonicalId(raw?.id),
        doi: normalizeDoi(raw?.doi),
        title: String(raw?.display_name ?? '').trim(),
        year: Number.isFinite(raw?.publication_year) ? raw.publication_year : null,
        date: raw?.publication_date ?? null,
        venue: raw?.primary_location?.source?.display_name ?? null,
        abstract: rebuildAbstract(raw?.abstract_inverted_index),
        authors,
      });
      if (works.length >= cap) break;
    }
    cursor = page?.meta?.next_cursor ?? null;
    if (!(page?.results?.length > 0)) break;
  }

  return works;
}

export async function epmcAffiliations(doi) {
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi) return null;
  const params = new URLSearchParams({
    query: `DOI:"${normalizedDoi}"`,
    resultType: 'core',
    format: 'json',
    pageSize: '1',
  });
  const data = await getJson(`${EUROPE_PMC}?${params}`, { timeoutMs: 25_000 });
  const hit = data?.resultList?.result?.[0];
  if (!hit) return null;
  const affiliations = (hit?.authorList?.author ?? []).map((author) => {
    const details = author?.authorAffiliationDetailsList?.authorAffiliation;
    const affiliation = (Array.isArray(details) ? details : [details])
      .map((entry) => String(entry?.affiliation ?? '').trim())
      .filter(Boolean)
      .join(' | ');
    return {
      name: String(author?.fullName ?? `${author?.firstName ?? ''} ${author?.lastName ?? ''}`.trim()).trim(),
      affiliation,
    };
  }).filter(({ affiliation }) => affiliation);
  return affiliations.length ? affiliations : null;
}

export function institutionTimeZone(inst) {
  const city = String(inst?.city ?? '').trim().toLowerCase();
  const country = String(inst?.country ?? inst?.country_code ?? '').trim().toUpperCase();
  return CITY_TIME_ZONES[city] ?? COUNTRY_TIME_ZONES[country] ?? 'America/New_York';
}
