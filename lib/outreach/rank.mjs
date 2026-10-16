// lib/outreach/rank.mjs — rank an institution's authors by how well their recent
// publications match the applicant's profile queries.
//
// Pure and arg-driven: no network, no clock beyond Date.now() for recency decay, no
// files. Vectors come from lib/outreach/embed.mjs (float32, L2-normalized, 768-d):
// `queryVecs[i]` corresponds to `queries[i]`, and `workVecs` carries one vector per
// work. Comparable with the prototype's dot/rankAuthors (outreach.mjs lines 383-620).
//
// Only authorships whose `atInstitution` flag is true are counted; the Works fetched
// from OpenAlex are institution-scoped already, but middle authors from other labs can
// appear on multi-institution papers and must not be ranked.

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

// Queries may arrive as bare strings or as {id,label} objects. Keeping the id (not the
// label) in the output is lossless: the caller can always look the label back up.
const normalizeQueries = (queries) =>
  queries.map((q, i) => {
    if (q && typeof q === 'object') {
      const id = q.id ?? q.label ?? i;
      return { id: String(id), label: String(q.label ?? id) };
    }
    return { id: String(q ?? i), label: String(q ?? '') };
  });

// workVecs may be an array parallel to `works`, a Map keyed by work id, or a plain
// object keyed by work id. Missing vectors are treated as unscorable, not as zeros.
const makeWorkVecLookup = (workVecs) => {
  if (workVecs instanceof Map) return (work) => workVecs.get(work.id) ?? workVecs.get(String(work.id)) ?? null;
  if (Array.isArray(workVecs)) return (work, i) => workVecs[i] ?? null;
  if (workVecs && typeof workVecs === 'object') return (work) => workVecs[work.id] ?? null;
  throw new Error('workVecs must be an array, a Map, or an object keyed by work id');
};

const workDate = (w) => w.date || (w.year ? `${w.year}-01-01` : null);

/**
 * @param {object} args
 * @param {Array} args.works          OpenAlex-shaped works (see lib/outreach/openalex.mjs)
 * @param {Array} args.queries        [{id,label}] or bare strings, matching queryVecs
 * @param {Array} args.queryVecs      one normalized vector per query
 * @param {Array|Map|object} args.workVecs  one normalized vector per work (see above)
 * @param {number} [args.minWorks=2]  authors with fewer matched works are dropped
 * @param {number} [args.topK=3]      how many works define the author's best match
 * @param {number} [args.piBonus=0.02] added when the author reads as a PI
 * @param {number} [args.recencyHalfLifeYears=1.5] decay for the newest work
 * @returns {Array<{authorId,name,orcid,score,isPILikely,nWorks,top}>
 *   }> sorted best first
 */
export function rankAuthors({
  works,
  queries,
  queryVecs,
  workVecs,
  minWorks = 2,
  topK = 3,
  piBonus = 0.02,
  recencyHalfLifeYears = 1.5,
} = {}) {
  if (!Array.isArray(works)) throw new Error('rankAuthors needs works');
  const normalizedQueries = normalizeQueries(Array.isArray(queries) ? queries : []);
  if (!Array.isArray(queryVecs) || queryVecs.length !== normalizedQueries.length) {
    throw new Error('queryVecs must hold one vector per query');
  }
  const workVec = makeWorkVecLookup(workVecs);

  const byAuthor = new Map();
  works.forEach((w, wi) => {
    if (!w) return;
    const seen = new Set();
    for (const a of w.authors ?? []) {
      if (!a || a.atInstitution !== true) continue;
      const id = a.id == null ? null : String(a.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let entry = byAuthor.get(id);
      if (!entry) {
        entry = {
          authorId: id,
          name: a.name ?? 'Unknown',
          orcid: a.orcid ?? null,
          works: [],
          lastAuthor: [],
          corresponding: 0,
        };
        byAuthor.set(id, entry);
      }
      entry.works.push(wi);
      entry.lastAuthor.push(a.position === 'last');
      if (a.isCorresponding) entry.corresponding += 1;
    }
  });

  // Raw cosines are not comparable across queries: a generic query (e.g. broad genomics) sits closer to every
  // abstract and became the best match for most works. Each query's scores are standardized over this works set
  // (z = (cos - mean_q) / sd_q), so a paper's score means "how unusually close to this topic, here".
  const stats = queryVecs.map(() => ({ n: 0, sum: 0, sq: 0 }));
  works.forEach((w, wi) => {
    const vec = w && workVec(w, wi);
    if (!vec) return;
    queryVecs.forEach((q, qi) => { const s = dot(vec, q); stats[qi].n += 1; stats[qi].sum += s; stats[qi].sq += s * s; });
  });
  const norm = stats.map(({ n, sum, sq }) => {
    const mean = n ? sum / n : 0;
    const sd = n > 1 ? Math.sqrt(Math.max(sq / n - mean * mean, 0)) : 0;
    return { mean, sd: sd > 1e-6 ? sd : 1 };
  });

  const scored = [];
  for (const entry of byAuthor.values()) {
    // Score each of the author's works against every query (standardized) and keep the best match.
    const papers = [];
    entry.works.forEach((wi, k) => {
      const w = works[wi];
      const vec = workVec(w, wi);
      if (!vec) return; // unscorable without a vector
      let best = -Infinity;
      let bestIdx = 0;
      let bestCos = 0;
      for (let qi = 0; qi < normalizedQueries.length; qi += 1) {
        const cos = dot(vec, queryVecs[qi]);
        const z = (cos - norm[qi].mean) / norm[qi].sd;
        if (z > best) { best = z; bestIdx = qi; bestCos = cos; }
      }
      papers.push({
        workId: w.id == null ? null : String(w.id),
        title: w.title ?? null,
        year: w.year ?? null,
        date: w.date ?? null,
        venue: w.venue ?? null,
        doi: w.doi ?? null,
        abstract: w.abstract ?? '',
        score: best,
        cos: bestCos,
        query: normalizedQueries[bestIdx].id,
        isLastAuthor: entry.lastAuthor[k],
      });
    });
    if (papers.length < minWorks) continue;

    papers.sort((a, b) => b.score - a.score);
    const top = papers.slice(0, topK);
    const meanTop = top.reduce((s, p) => s + p.score, 0) / top.length;

    const latest = papers.map((p) => workDate(p) ?? `${p.year ?? 1970}-01-01`).sort().pop();
    const ageYears = Math.max(0, (Date.now() - Date.parse(latest)) / (365.25 * 86_400_000));
    const recencyWeight = 0.85 + 0.15 * 0.5 ** (ageYears / recencyHalfLifeYears);

    const isPILikely = top.some((p) => p.isLastAuthor) || entry.corresponding > 0;
    const score = meanTop * recencyWeight + (isPILikely ? piBonus : 0);

    scored.push({
      authorId: entry.authorId,
      name: entry.name,
      orcid: entry.orcid,
      score,
      isPILikely,
      nWorks: papers.length,
      // Internal ranking fields (date, isLastAuthor) stay out of the public shape.
      top: top.map(({ isLastAuthor, date, ...rest }) => rest),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.nWorks - a.nWorks ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.authorId < b.authorId ? -1 : a.authorId > b.authorId ? 1 : 0),
  );
  return scored;
}
