import { lstat, readdir, readFile } from 'node:fs/promises';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/g;

const JUNK_HOSTS = [
  'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain', 'sentry.io', 'sentry-next',
  'w3.org', 'schema.org', 'github.com', 'githubusercontent.com', 'google.com', 'googleapis.com',
  'gstatic.com', 'cloudflare.com', 'sentry.wixpress.com', 'wixpress.com', 'squarespace.com',
  'wordpress.org', 'gnu.org', 'apache.org', 'creativecommons.org', 'openalex.org', 'crossref.org',
  'orcid.org', 'doi.org', 'elsevier.com', 'springernature.com', 'nature.com', 'science.org',
  'pubmed.ncbi', 'ncbi.nlm.nih', 'europepmc.org', 'twitter.com', 'facebook.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'apple.com', 'microsoft.com', 'adobe.com', 'anthropic.com',
  'openai.com', 'npmjs.com', 'jsdelivr.net', 'unpkg.com',
];

const JUNK_LOCALS = [
  'noreply', 'no-reply', 'donotreply', 'postmaster', 'webmaster', 'abuse', 'privacy', 'dmca',
  'unsubscribe', 'bounce', 'mailer-daemon', 'example', 'yourname', 'youremail', 'someone',
  'first.last', 'firstname.lastname', 'name', 'email', 'sentry', 'wixpress', 'cdn-cgi',
];

function stripId(value) {
  return String(value ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
}

function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

function surnameOf(name) {
  return normalizeName(name).split(/\s+/).filter(Boolean).at(-1) ?? '';
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
}

function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2 !== 0) return '';
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let result = '';
  for (let index = 2; index < hex.length; index += 2) {
    result += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16) ^ key);
  }
  return result;
}

function cleanEmail(value) {
  let email = decodeEntities(value).trim().replace(/^mailto:/i, '');
  try {
    email = decodeURIComponent(email);
  } catch {
    // A malformed percent escape does not prevent validating the original text.
  }
  return email.split(/[?\s]/, 1)[0].replace(/^[.\-]+|[.\-,;:]+$/g, '').toLowerCase();
}

function junkReason(email) {
  const [local, host, extra] = email.split('@');
  if (!local || !host || extra) return 'not a valid email address';
  if (local.length > 64 || host.length > 253) return 'address component is implausibly long';
  if (JUNK_LOCALS.some((junk) => local === junk || local.startsWith(`${junk}+`))) {
    return 'generic or automated mailbox';
  }
  if (JUNK_HOSTS.some((junk) => host === junk || host.endsWith(`.${junk}`) || host.includes(junk))) {
    return 'non-contact or placeholder domain';
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || host.includes('..')) return 'invalid domain';
  if (/\.(png|jpe?g|gif|svg|webp|css|js|json|xml|ico)$/i.test(host)) return 'asset filename';
  if (/\d{3,}$/.test(host.split('.').pop())) return 'versioned asset host';
  return null;
}

function emailsIn(text) {
  const found = new Set();
  const decoded = decodeEntities(text);
  for (const match of decoded.matchAll(EMAIL_RE)) {
    const email = cleanEmail(match[0]);
    if (!junkReason(email)) found.add(email);
  }
  return [...found];
}

function mailtoAndCloudflareEmails(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    found.push(cleanEmail(match[1]));
  }
  for (const match of String(text ?? '').matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
    found.push(cleanEmail(decodeCfEmail(match[1])));
  }
  return found.filter(Boolean);
}

function belongsToPerson(email, name) {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  if (local.length < 3) return false;
  const tokens = normalizeName(name).split(/\s+/).filter((token) => token.length >= 3);
  if (tokens.length === 0) return false;
  const joined = tokens.join('');
  return tokens.some((token) => local.includes(token)) || local.includes(joined) || joined.includes(local);
}

function samePerson(author, person) {
  const expectedId = stripId(person.authorId ?? person.id);
  const actualId = stripId(author?.id ?? author?.authorId);
  if (expectedId && actualId) return expectedId === actualId;
  return normalizeName(author?.name) === normalizeName(person.name);
}

function openAlexSource(work) {
  const id = stripId(work.id);
  return id ? `https://api.openalex.org/works/${encodeURIComponent(id)}` : null;
}

function doiValue(doi) {
  return String(doi ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
}

async function textFrom(fetchText, url, options = {}) {
  const result = await fetchText(url, options);
  if (typeof result === 'string') return result;
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  if (result && typeof result.text === 'function') return result.text();
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.body === 'string') return result.body;
  return JSON.stringify(result ?? '');
}

function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

function epmcAuthors(hit) {
  return hit?.authorList?.author ?? hit?.authorList ?? [];
}

function authorText(author) {
  return JSON.stringify(author ?? {}).replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decisionConfidence(decision, choice) {
  const probability = Number(decision?.probs?.[choice]);
  return Number.isFinite(probability) ? probability : 0;
}

/**
 * Find a person's published email address. Dependencies are injected so the
 * source discovery and probabilistic choice can be exercised independently.
 */
export async function findContact({ person, institution, works = [] }, { exaSearch, exaFetch, decide, fetchText }) {
  if (!person?.name) throw new TypeError('person.name is required');
  if (typeof fetchText !== 'function') throw new TypeError('fetchText must be a function');

  const candidates = [];
  const seen = new Set();
  const add = (rawEmail, sourceUrl, method, { requireName = true } = {}) => {
    const email = cleanEmail(rawEmail);
    if (!sourceUrl || junkReason(email)) return;
    if (requireName && !belongsToPerson(email, person.name)) return;
    if (seen.has(email)) return;
    seen.add(email);
    candidates.push({ email, sourceUrl, method });
  };

  // OpenAlex raw affiliations are already present in the normalized works.
  for (const work of works) {
    const sourceUrl = openAlexSource(work);
    for (const author of work.authors ?? []) {
      if (!samePerson(author, person)) continue;
      for (const affiliation of author.rawAffiliations ?? author.raw_affiliation_strings ?? []) {
        for (const email of emailsIn(affiliation)) add(email, sourceUrl, 'openalex_affiliation');
      }
    }
  }

  // Europe PMC core records include richer author/affiliation metadata.
  const dois = [...new Set(works.map((work) => doiValue(work.doi)).filter(Boolean))].slice(0, 6);
  for (const doi of dois) {
    const sourceUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&resultType=core&format=json&pageSize=1`;
    try {
      const data = parseJson(await textFrom(fetchText, sourceUrl, {
        headers: { Accept: 'application/json' },
      }));
      const hit = data?.resultList?.result?.[0];
      const surname = surnameOf(person.name);
      for (const author of epmcAuthors(hit)) {
        const fullName = author?.fullName ?? `${author?.firstName ?? ''} ${author?.lastName ?? ''}`.trim();
        if (surname && !normalizeName(fullName).split(/\s+/).includes(surname)) continue;
        for (const email of emailsIn(authorText(author))) add(email, sourceUrl, 'europepmc');
      }
      // Some core records attach the corresponding address at article level.
      for (const email of emailsIn(JSON.stringify(hit ?? {}))) add(email, sourceUrl, 'europepmc');
    } catch {
      // A missing or malformed record should not suppress the later sources.
    }
  }

  // ORCID's public endpoint only returns addresses the owner made public.
  const orcid = stripId(person.orcid);
  if (orcid) {
    const sourceUrl = `https://pub.orcid.org/v3.0/${encodeURIComponent(orcid)}/email`;
    try {
      const data = parseJson(await textFrom(fetchText, sourceUrl, {
        headers: { Accept: 'application/json' },
      }));
      for (const record of data?.email ?? []) {
        if (record?.email) add(record.email, sourceUrl, 'orcid', { requireName: false });
      }
    } catch {
      // Most ORCID records have no public email; continue to public web pages.
    }
  }

  // Exa identifies likely person-specific pages; extraction remains local and deterministic.
  if (typeof exaSearch === 'function' && typeof exaFetch === 'function') {
    const institutionName = institution?.name ?? institution?.display_name ?? '';
    const paperHint = (person.top ?? person.topPapers ?? [])
      .slice(0, 2)
      .map((paper) => paper.title)
      .filter(Boolean)
      .join(' | ');
    const query = [`"${person.name}"`, institutionName && `"${institutionName}"`, 'email lab faculty', paperHint]
      .filter(Boolean)
      .join(' ');
    try {
      const results = await exaSearch(query, { numResults: 5 });
      for (const result of results ?? []) {
        if (!result?.url) continue;
        try {
          const page = await exaFetch(result.url);
          const sourceUrl = page?.url ?? result.url;
          const content = [page?.text, result.text].filter(Boolean).join('\n');
          const extracted = [...mailtoAndCloudflareEmails(content), ...emailsIn(content)];
          for (const email of extracted) add(email, sourceUrl, 'exa_webpage');
        } catch {
          // One inaccessible result does not invalidate other search results.
        }
      }
    } catch {
      // Search is the final optional source; return any earlier candidates.
    }
  }

  if (candidates.length === 0) {
    return { email: null, sourceUrl: null, method: 'not_found', confidence: 0, candidates, needsDecision: false };
  }
  if (typeof decide !== 'function') throw new TypeError('decide must be a function when candidates are found');

  const noneId = 'none';
  let decision;
  try {
    decision = await decide({
      question: `Which published email address belongs personally to ${person.name}?`,
      context: {
        person: person.name,
        institution: institution?.name ?? institution?.display_name ?? null,
        candidates,
      },
      options: [
        ...candidates.map((candidate, index) => ({
          id: `candidate_${index}`,
          label: `${candidate.email} — ${candidate.method} — ${candidate.sourceUrl}`,
        })),
        { id: noneId, label: 'None of these addresses plausibly belongs to this person.' },
      ],
      threshold: 0.6,
    });
  } catch {
    return {
      email: null,
      sourceUrl: null,
      method: 'decision_failed',
      confidence: 0,
      candidates,
      needsDecision: true,
    };
  }

  const choice = decision?.choice;
  const confidence = decisionConfidence(decision, choice);
  const confident = decision?.confident === true;
  if (choice === noneId || !/^candidate_\d+$/.test(String(choice))) {
    return {
      email: null,
      sourceUrl: null,
      method: choice === noneId ? 'jev_none' : 'decision_failed',
      confidence,
      candidates,
      needsDecision: !confident,
    };
  }

  const chosen = candidates[Number(choice.slice('candidate_'.length))];
  if (!chosen) {
    return { email: null, sourceUrl: null, method: 'decision_failed', confidence, candidates, needsDecision: true };
  }
  return { ...chosen, confidence, candidates, needsDecision: !confident };
}

/** Collect email addresses from prior batch directories without following symlinks. */
export async function exclusionEmails(dirs) {
  const emails = new Set();

  async function walk(path) {
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      let entries;
      try {
        entries = await readdir(path);
      } catch {
        return;
      }
      await Promise.all(entries.map((entry) => walk(`${path}/${entry}`)));
      return;
    }
    if (!info.isFile() || info.size >= 2_000_000) return;
    try {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(EMAIL_RE)) emails.add(cleanEmail(match[0]));
    } catch {
      // Ignore unreadable and non-text files in historical batch directories.
    }
  }

  await Promise.all((dirs ?? []).map(walk));
  return emails;
}
