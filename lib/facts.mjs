// Deterministic fact selection for the resume and cover-letter writers.
// Reads the machine tags in MASTER-FACTS.md (see its "Machine tags" note).
// No model calls, no embeddings. Contains no personal data.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANES = ['swe', 'quant', 'crypto', 'intel', 'federal', 'startup', 'consumer', 'ai', 'biosecurity'];
export const STATUSES = ['verified', 'unverified', 'interview-only', 'never-print'];
export const DEFAULT_BUDGET_CHARS = 12_000;

const LANE_BOOST = 3;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'has', 'have', 'not', 'but',
  'its', 'into', 'over', 'per', 'via', 'your', 'you', 'our', 'their', 'they', 'will', 'can', 'all',
  'any', 'one', 'job', 'role', 'team', 'work', 'years', 'year', 'new', 'use', 'using', 'build',
  'built', 'ability', 'skills', 'looking', 'intern', 'internship', 'summer', 'position', 'who',
  'what', 'when', 'where', 'how', 'why', 'about', 'more', 'than', 'also', 'such', 'each', 'other',
]);

const SECTION_RE = /^<!--\s*section:\s*(.*?)\s*-->\s*$/;
const TRAILER_RE = /\s*<!--\s*((?:lanes|tags|status)=[^>]*?)\s*-->\s*$/;
const SEPARATOR_RE = /^\|[\s:|-]+\|\s*$/;

function parseKv(body) {
  const out = {};
  for (const m of body.matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

function parseLaneList(value, problems, where) {
  if (value === undefined) return undefined;
  if (value === 'all') return 'all';
  const lanes = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const lane of lanes) {
    if (!LANES.includes(lane)) problems.push(`${where}: unknown lane "${lane}"`);
  }
  return lanes.filter((lane) => LANES.includes(lane));
}

function checkStatus(value, problems, where) {
  if (value === undefined) return undefined;
  if (!STATUSES.includes(value)) problems.push(`${where}: unknown status "${value}"`);
  return STATUSES.includes(value) ? value : undefined;
}

function tokenize(text) {
  const out = new Set();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#]*/g)) {
    const t = m[0];
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function splitTrailer(line) {
  const m = line.match(TRAILER_RE);
  if (!m) return { text: line, kv: null };
  return { text: line.slice(0, m.index).replace(/\s+$/, ''), kv: parseKv(m[1]) };
}

/**
 * Parse MASTER-FACTS.md into sections and units.
 * A unit is a column-zero bullet (with its indented continuations), a data table row,
 * or a paragraph block. Units inherit lanes/tags/status/always from their `###` sub-heading
 * when it carries a `<!-- section: -->` trailer, else from their `##` section. Headings are
 * never units, so a heading's wording cannot leak into a selection on its own.
 */
export function parseFacts(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  const units = [];
  const problems = [];
  let section = null;
  let scope = null;
  let subheading = null;
  let tableHeader = null;
  let i = 0;

  const newUnit = (kind, startLine, rawLines, extraHeader) => {
    const first = splitTrailer(rawLines[0]);
    let trailer = first.kv;
    if (!trailer) {
      for (const l of rawLines.slice(1)) {
        const t = splitTrailer(l);
        if (t.kv) { trailer = t.kv; break; }
      }
    }
    const where = `line ${startLine}`;
    const own = trailer !== null;
    const lanes = own && trailer.lanes !== undefined
      ? parseLaneList(trailer.lanes, problems, where)
      : scope.lanes;
    const tags = own && trailer.tags !== undefined
      ? trailer.tags.split(',').filter(Boolean)
      : scope.tags;
    const status = own && trailer.status !== undefined
      ? checkStatus(trailer.status, problems, where)
      : scope.status;
    const text = rawLines.map((l, idx) => (idx === 0 ? first.text : splitTrailer(l).text)).join('\n');
    units.push({
      id: units.length + 1,
      line: startLine,
      kind,
      section: section.heading,
      sectionIndex: section.index,
      subheading,
      header: extraHeader ?? null,
      text,
      lanes,
      tags,
      status,
      always: scope.always,
      own,
      tokens: tokenize(`${text} ${tags.join(' ').replace(/-/g, ' ')}`),
    });
  };

  // A `<!-- section: -->` trailer on the line after a heading, applied over `base`; otherwise `base` unchanged.
  const readScope = (base, where) => {
    if (i >= lines.length || !SECTION_RE.test(lines[i].trim())) return null;
    const kv = parseKv(lines[i].trim().match(SECTION_RE)[1]);
    i += 1;
    return {
      lanes: parseLaneList(kv.lanes, problems, where) ?? base.lanes,
      tags: kv.tags !== undefined ? kv.tags.split(',').filter(Boolean) : base.tags,
      status: checkStatus(kv.status, problems, where) ?? base.status,
      always: kv.always !== undefined ? kv.always === 'true' : base.always,
    };
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      section = { heading: line, index: sections.length, lanes: 'all', tags: [], status: null, always: false };
      sections.push(section);
      subheading = null;
      tableHeader = null;
      i += 1;
      const read = readScope(section, `${section.heading.slice(0, 40)} (section)`);
      if (read) Object.assign(section, read);
      else problems.push(`line ${i}: section "${line.slice(0, 40)}" has no <!-- section: --> trailer`);
      scope = section;
      continue;
    }
    if (!section) { i += 1; continue; }
    if (line.startsWith('### ')) {
      subheading = line;
      tableHeader = null;
      i += 1;
      scope = readScope(section, `${line.slice(0, 40)} (sub-section)`) ?? section;
      continue;
    }
    if (line.trim() === '' || line.startsWith('---') || SECTION_RE.test(line.trim())) {
      if (line.trim() === '') tableHeader = null;
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      if (SEPARATOR_RE.test(line)) { i += 1; continue; }
      const next = lines[i + 1] ?? '';
      if (SEPARATOR_RE.test(next)) {
        tableHeader = `${line}\n${next}`;
        i += 2;
        continue;
      }
      newUnit('row', i + 1, [line], tableHeader);
      i += 1;
      continue;
    }
    if (line.startsWith('- ')) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('  ') && lines[j].trim() !== '') {
        block.push(lines[j]);
        j += 1;
      }
      newUnit('bullet', i + 1, block, null);
      i = j;
      continue;
    }
    // Paragraph block: consecutive non-blank lines that are not structural.
    const block = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !lines[j].startsWith('## ') && !lines[j].startsWith('### ')
      && !lines[j].startsWith('- ') && !lines[j].startsWith('|') && !lines[j].startsWith('---')) {
      block.push(lines[j]);
      j += 1;
    }
    newUnit('paragraph', i + 1, block, null);
    i = j;
  }
  return { sections, units, problems };
}

/** Lint: every bullet and table row must carry its own trailer; every field must be valid. */
export function lintFacts(markdown) {
  const { sections, units, problems } = parseFacts(markdown);
  const untagged = units
    .filter((u) => (u.kind === 'bullet' || u.kind === 'row') && !u.own)
    .map((u) => `line ${u.line} (${u.kind}): ${u.text.slice(0, 80)}`);
  const byStatus = {};
  const byLane = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const u of units) {
    byStatus[u.status ?? 'untagged'] = (byStatus[u.status ?? 'untagged'] ?? 0) + 1;
    if (u.lanes === 'all') {
      byLane.all = (byLane.all ?? 0) + 1;
    } else {
      for (const lane of u.lanes) byLane[lane] = (byLane[lane] ?? 0) + 1;
    }
  }
  return {
    ok: problems.length === 0 && untagged.length === 0,
    sections: sections.length,
    units: units.length,
    untagged,
    problems,
    byStatus,
    byLane,
  };
}

function scoreUnit(unit, lane, pageTokens) {
  let overlap = 0;
  for (const t of unit.tokens) if (pageTokens.has(t)) overlap += 1;
  const explicit = unit.lanes !== 'all' && lane !== null && unit.lanes.includes(lane);
  return { overlap, explicit, score: overlap + (explicit ? LANE_BOOST : 0) };
}

// Picked units of one section in file order, with each `###` sub-heading and table header emitted once, only above
// a unit that was picked.
function renderUnits(units) {
  const out = [];
  let lastKind = null;
  let lastSub = null;
  const headerEmitted = new Set();
  for (const u of units) {
    if (u.subheading !== lastSub) {
      if (out.length) out.push('');
      if (u.subheading) out.push(u.subheading);
      lastSub = u.subheading;
      lastKind = null;
    }
    if (u.kind === 'row') {
      const key = `${u.subheading}|${u.header}`;
      if (!headerEmitted.has(key)) {
        if (out.length && lastKind !== null) out.push('');
        out.push(u.header);
        headerEmitted.add(key);
      }
      out.push(u.text);
      lastKind = 'row';
      continue;
    }
    if (out.length && lastKind !== null) {
      const sep = lastKind === 'bullet' && u.kind === 'bullet' ? 0 : 1;
      for (let k = 0; k < sep; k += 1) out.push('');
    }
    out.push(u.text);
    lastKind = u.kind;
  }
  return out.join('\n');
}

/**
 * Select the facts a writer should see for one lane and one posting.
 * Only status "verified" units are eligible, filtered to the lane (or lanes "all"); a null lane keeps only "all" units.
 * Units with always=true (section or sub-section level) are included first. The rest are ranked by
 * token overlap with the posting text, plus a boost for an explicit lane match, and filled greedily into the
 * character budget; ties and zero-overlap units fill in file order, so the budget is used rather than left empty.
 * Output keeps MASTER-FACTS file order.
 */
export function selectFacts(markdown, { lane, pageText = '', budgetChars = DEFAULT_BUDGET_CHARS } = {}) {
  if (lane !== null && !LANES.includes(lane)) throw new Error(`selectFacts: unknown lane "${lane}"`);
  const { sections, units } = parseFacts(markdown);
  const eligible = units.filter((u) => u.status === 'verified'
    && (u.lanes === 'all' || (lane !== null && u.lanes.includes(lane))));
  const pageTokens = tokenize(pageText);
  const chosen = new Set();
  let used = 0;
  const overflow = [];
  const take = (u) => {
    const cost = u.text.length + 2;
    if (used + cost > budgetChars) return false;
    chosen.add(u);
    used += cost;
    return true;
  };
  for (const u of eligible) {
    if (u.always && !take(u)) overflow.push(u.id);
  }
  const ranked = eligible
    .filter((u) => !u.always)
    .map((u) => ({ u, ...scoreUnit(u, lane, pageTokens) }))
    .sort((a, b) => b.score - a.score || a.u.id - b.u.id);
  for (const r of ranked) take(r.u);

  const picked = [...chosen].sort((a, b) => a.id - b.id);
  const body = [];
  for (const section of sections) {
    const inSection = picked.filter((u) => u.sectionIndex === section.index);
    if (!inSection.length) continue;
    body.push(section.heading, '', renderUnits(inSection), '');
  }
  return {
    text: body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
    chars: used,
    budgetChars,
    selected: picked.map((u) => ({ id: u.id, line: u.line, section: u.section, status: u.status, lanes: u.lanes, text: u.text.slice(0, 60) })),
    overflow,
  };
}

/**
 * Derive the lane from a resume filename, e.g. "zhou_resume_swe.pdf" with pattern
 * "zhou_resume_{lane}.pdf". Falls back when the filename does not match or the lane is unknown.
 */
export function laneFromFilename(filename, pattern, fallbackLane) {
  const parts = String(pattern).split('{lane}');
  if (parts.length !== 2) throw new Error('laneFromFilename: pattern must contain exactly one {lane}');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(parts[0])}([a-z]+)${esc(parts[1])}$`);
  const m = basename(String(filename)).match(re);
  if (m && LANES.includes(m[1])) return m[1];
  return fallbackLane;
}

async function cli(argv) {
  const { loadConfig } = await import('./config.mjs');
  const CONFIG = loadConfig();
  const factsPath = CONFIG.resumes.factsPath;
  const [cmd, ...rest] = argv;
  const markdown = readFileSync(factsPath, 'utf8');
  if (cmd === 'lint') {
    const r = lintFacts(markdown);
    console.log(JSON.stringify({ ok: r.ok, sections: r.sections, units: r.units, byStatus: r.byStatus, byLane: r.byLane }, null, 2));
    for (const p of r.problems) console.log(`PROBLEM ${p}`);
    for (const u of r.untagged) console.log(`UNTAGGED ${u}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'select') {
    const [lane, pageFile, budget] = rest;
    const pageText = pageFile ? readFileSync(pageFile, 'utf8') : '';
    const r = selectFacts(markdown, { lane, pageText, budgetChars: budget ? Number(budget) : DEFAULT_BUDGET_CHARS });
    console.error(`lane=${lane} chars=${r.chars}/${r.budgetChars} units=${r.selected.length} overflow=${r.overflow.length}`);
    process.stdout.write(r.text);
    return;
  }
  console.error('usage: bun lib/facts.mjs lint | select <lane> [pageTextFile] [budgetChars]');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli(process.argv.slice(2));
}
