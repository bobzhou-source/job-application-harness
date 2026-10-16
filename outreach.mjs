// Research-lab cold outreach: `bun outreach.mjs <command> [org] [flags]`. Drafts only — nothing is ever sent.
// Stages stop for a human decision in between (the chat agent shows ranked.md, the user picks):
//   scope <org> [--dept "A;B"] [--institution I123] how many recent papers match each profile topic's search terms
//                                                  (and departments) — cheap; use it to set the filter first.
//   research <org> [--dept "A;B"] [--institution I123] [--n 10]
//                                                  resolve org (OpenAlex) → per-topic relevance search of recent
//                                                  works (optionally only from the named departments) →
//                                                  EmbeddingGemma ranking against outreach.profileQueries →
//                                                  published emails only → runs/outreach/<org>/ranked.{json,md};
//                                                  ambiguous calls listed under needsDecision.
//   pick <org> <person> <email|none>               settle a needsDecision email; only a candidate already found
//                                                  on a public page (with its source URL) is accepted.
//   draft <org> --only a,b [--note a="..."]        write drafts/<person>.md (drafter + fact-check reviewer).
//   redraft <org> --only a --note "..."            regenerate one draft with steering.
//   push <org> --only a,b [--dry-run]              Gmail draft (+ resume attachment) and a Calendar "Send:" reminder
//                                                  in the recipient's morning; idempotent per person.
//   show <org> [person] | list
// Every command takes --json for machine-readable output. Run with the harness .env loaded.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { searchInstitutions, fetchWorks, countWorks, institutionTimeZone } from './lib/outreach/openalex.mjs';
import { exaSearch, exaFetch } from './lib/outreach/exa.mjs';
import { createEmbedder } from './lib/outreach/embed.mjs';
import { rankAuthors } from './lib/outreach/rank.mjs';
import { decide } from './lib/outreach/jev.mjs';
import { draftEmail, chooseResume } from './lib/outreach/write.mjs';
import { findContact, exclusionEmails } from './lib/outreach/contacts.mjs';
import { createGmailDraft, listDrafts } from './lib/outreach/gmail.mjs';
import { planSlots, createReminder, findReminders } from './lib/outreach/calendar.mjs';
import { runDir as orgRunDir, readJson, writeJson, slugify, personSlug, ledger } from './lib/outreach/state.mjs';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const RUNS = path.join(ROOT, 'runs', 'outreach');

// ---------------------------------------------------------------- args / output

function parseArgs(argv) {
  const positional = [];
  const flags = { note: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    const takesValue = ['institution', 'n', 'only', 'note', 'dept'].includes(key);
    const value = inline ?? (takesValue ? argv[++i] : true);
    if (key === 'note') {
      const m = /^([a-z0-9-]+)=(.*)$/s.exec(value);
      if (m) flags.note[m[1]] = m[2]; else flags.note['*'] = value;
    } else flags[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  return { positional, flags };
}

let JSON_MODE = false;
const log = (...a) => { if (!JSON_MODE) console.error(...a); };
function emit(result, text) {
  if (JSON_MODE) console.log(JSON.stringify(result, null, 2));
  else console.log(text);
}

const onlyList = (flags) => (typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : null);
const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? '');

// ---------------------------------------------------------------- run state

function loadRun(org) {
  const dir = orgRunDir(RUNS, slugify(org));
  const ranked = readJson(path.join(dir, 'ranked.json'), null);
  if (!ranked) throw new Error(`no research run for "${org}" — run: bun outreach.mjs research "${org}"`);
  return { dir, ranked };
}

function saveRanked(dir, ranked) {
  writeJson(path.join(dir, 'ranked.json'), ranked);
  writeFileSync(path.join(dir, 'ranked.md'), rankedMarkdown(ranked));
}

function needsDecision(ranked) {
  const list = [];
  if (ranked.institution.needsDecision) list.push({ kind: 'institution', options: ranked.institution.alternatives });
  for (const p of ranked.people) {
    if (p.contact?.needsDecision && !p.contact.email) list.push({ kind: 'email', person: p.slug, name: p.name, candidates: p.contact.candidates });
  }
  return list;
}

function rankedMarkdown(r) {
  const rows = r.people.map((p, i) => {
    const paper = p.top[0] ?? {};
    const contact = p.contact?.email ? `\`${p.contact.email}\` ([src](${p.contact.sourceUrl}))`
      : p.contact?.needsDecision ? `needs decision (${p.contact.candidates.length} candidates)`
        : p.skip ?? 'no published email';
    const drafted = p.draft ? ` ✎${p.draft.words}w` : '';
    const pushed = p.push?.draftId ? ' ✉' : '';
    return `| ${i + 1} | \`${p.slug}\` | ${p.name}${p.isPILikely ? ' (PI)' : ''} | ${p.score.toFixed(3)} | ${p.nWorks} | ${paper.year ?? ''} ${short(paper.title, 70)} · _${paper.query ?? ''}_ | ${contact}${drafted}${pushed} |`;
  });
  const nd = needsDecision(r);
  return `# ${r.institution.name} — outreach ranking

- Resolved: **${r.institution.name}** (\`${r.institution.id}\`, ${r.institution.type ?? '?'}, ${[r.institution.city, r.institution.country].filter(Boolean).join(', ')}) · tz ${r.timeZone}
- Papers: ${r.meta.works} with abstracts since ${r.meta.since}, from topic searches (${Object.entries(r.meta.perTopic ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')})${r.meta.departments?.length ? ` · departments: ${r.meta.departments.join('; ')}` : ''}
- Authors ranked: ${r.meta.authorsRanked} · shown: ${r.people.length} · embeddings ${r.meta.embedding}
- Generated ${r.meta.generatedAt}

| # | slug | name | score (z) | works | best paper · profile match | email |
|---|---|---|---|---|---|---|
${rows.join('\n')}
${nd.length ? `\n## Needs decision\n\n${nd.map((d) => d.kind === 'institution'
    ? `- institution: ${d.options.map((o) => `\`${o.id}\` ${o.name} (${o.country ?? '?'}) p=${o.p?.toFixed(2) ?? '?'}`).join(' · ')} — rerun with \`--institution <id>\``
    : `- \`${d.person}\` ${d.name}: ${d.candidates.map((c) => `\`${c.email}\` (${c.method}, ${c.sourceUrl})`).join(' · ') || 'no candidates'} — \`bun outreach.mjs pick "${r.org}" ${d.person} <email|none>\``).join('\n')}\n` : ''}
## Detail

${r.people.map((p, i) => `### ${i + 1}. ${p.name} — ${p.score.toFixed(3)}
- OpenAlex https://openalex.org/${p.authorId}${p.orcid ? ` · ORCID ${p.orcid}` : ''} · ${p.nWorks} works here${p.isPILikely ? ' · last/corresponding author' : ''}
${p.top.map((t) => `- ${t.year ?? ''} — ${t.title}${t.venue ? ` — _${t.venue}_` : ''}${t.doi ? ` — ${t.doi}` : ''} — z ${t.score.toFixed(2)}, cos ${t.cos?.toFixed(3) ?? '?'} (${t.query})`).join('\n')}
- Contact: ${p.contact?.email ? `\`${p.contact.email}\` via ${p.contact.method} — ${p.contact.sourceUrl}` : p.skip ?? 'none published'}${p.draft ? `\n- Draft: \`drafts/${p.slug}.md\` (${p.draft.words}w, resume ${p.draft.resumeLane})` : ''}${p.push?.draftId ? `\n- Pushed: draft ${p.push.draftId}, reminder ${p.push.eventStart}` : ''}
`).join('\n')}`;
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.text()).slice(0, 3_000_000);
}

const decideWith = (threshold) => (args) => decide({ threshold, ...args });

// ---------------------------------------------------------------- research

async function resolveInstitution(o, org, override) {
  const found = await searchInstitutions(override ?? org, { mailto: o.openalex.mailto });
  if (!found.length) throw new Error(`OpenAlex has no institution matching "${override ?? org}"`);
  if (override) {
    const exact = found.find((i) => i.id === override) ?? found[0];
    return { ...exact, decidedBy: 'flag' };
  }
  const options = found.slice(0, 6);
  if (options.length === 1) return { ...options[0], decidedBy: 'only-match' };
  const d = await decide({
    threshold: o.decisionThreshold,
    question: `Which OpenAlex institution is the organization "${org}" (the research org whose scientists we want to contact)?`,
    context: options.map((i) => `${i.id}: ${i.name} — ${i.type}, ${[i.city, i.country].filter(Boolean).join(', ')}, ${i.worksCount} works`).join('\n'),
    options: options.map((i) => ({ id: i.id, label: `${i.name} (${i.type}, ${i.country ?? '?'})` })),
  });
  const chosen = options.find((i) => i.id === d.choice) ?? options[0];
  return {
    ...chosen,
    decidedBy: 'jev',
    needsDecision: !d.confident,
    alternatives: options.map((i) => ({ id: i.id, name: i.name, country: i.country, p: d.probs[i.id] ?? 0 })),
  };
}

const departmentsOf = (flags) => (typeof flags.dept === 'string' ? flags.dept.split(';').map((s) => s.trim()).filter(Boolean) : []);
const sinceDate = (o) => new Date(Date.now() - o.openalex.lookbackYears * 365.25 * 864e5).toISOString().slice(0, 10);

async function cmdScope(cfg, org, flags) {
  const o = cfg.outreach;
  const institution = await resolveInstitution(o, org, flags.institution);
  const departments = departmentsOf(flags);
  const since = sinceDate(o);
  const base = { sinceDate: since, mailto: o.openalex.mailto, departments };
  const total = await countWorks(institution.id, base);
  const topics = [];
  for (const q of o.profileQueries) topics.push({ id: q.id, terms: q.terms, count: await countWorks(institution.id, { ...base, search: q.terms }) });
  const result = { org, institution: { id: institution.id, name: institution.name, needsDecision: Boolean(institution.needsDecision), alternatives: institution.alternatives }, since, departments, total, perTopicCap: o.openalex.perTopic, topics };
  return [result, `${institution.name} (${institution.id})${institution.needsDecision ? ' [low confidence — check alternatives]' : ''}
papers since ${since}${departments.length ? ` in ${departments.join('; ')}` : ''}: ${total}
${topics.map((t) => `  ${String(t.count).padStart(6)}  ${t.id.padEnd(22)} "${t.terms}"`).join('\n')}
research takes the top ${o.openalex.perTopic} per topic (relevance-sorted), then embeds and ranks them.`];
}

async function cmdResearch(cfg, org, flags) {
  const o = cfg.outreach;
  const n = Number(flags.n ?? o.ranking.n);
  const dir = orgRunDir(RUNS, slugify(org));
  mkdirSync(dir, { recursive: true });

  log(`resolving "${org}"…`);
  const institution = await resolveInstitution(o, org, flags.institution);
  const timeZone = institutionTimeZone(institution);
  log(`  → ${institution.name} (${institution.id})${institution.needsDecision ? ' [low confidence]' : ''}`);

  const since = sinceDate(o);
  const departments = departmentsOf(flags);
  const byId = new Map();
  const perTopic = {};
  for (const q of o.profileQueries) {
    const found = await fetchWorks(institution.id, { sinceDate: since, cap: o.openalex.perTopic, mailto: o.openalex.mailto, search: q.terms, departments });
    perTopic[q.id] = found.length;
    for (const w of found) if (w.abstract && !byId.has(w.id)) byId.set(w.id, w);
  }
  const works = [...byId.values()];
  if (!works.length) throw new Error(`no recent works with abstracts for ${institution.name}`);
  log(`  ${works.length} works with abstracts since ${since}`);

  const embedder = await createEmbedder({ cacheDir: path.join(RUNS, '.embed-cache') });
  let queryVecs, workVecs;
  try {
    queryVecs = await embedder.embedQueries(o.profileQueries.map((q) => q.query));
    workVecs = await embedder.embedDocs(works.map((w) => ({ id: w.id, title: w.title ?? '', text: w.abstract })));
  } finally {
    await embedder.close();
  }

  const ranked = rankAuthors({
    works, queries: o.profileQueries, queryVecs, workVecs,
    minWorks: o.ranking.minWorks, topK: o.ranking.topK, piBonus: o.ranking.piBonus, recencyHalfLifeYears: o.ranking.recencyHalfLifeYears,
  });
  log(`  ${ranked.length} authors ranked`);

  const book = ledger(RUNS);
  const earlier = await exclusionEmails(o.exclusionDirs);
  const people = [];
  for (const r of ranked) {
    if (people.length >= n) break;
    if (book.has(r.authorId)) { log(`  skip ${r.name}: already contacted`); continue; }
    people.push({ ...r, slug: personSlug(r.name, r.authorId) });
  }

  const decider = decideWith(o.decisionThreshold);
  for (const p of people) {
    log(`  contact: ${p.name}`);
    const authored = works.filter((w) => w.authors.some((a) => a.id === p.authorId));
    try {
      p.contact = await findContact({ person: p, institution, works: authored }, { exaSearch, exaFetch, decide: decider, fetchText });
    } catch (err) {
      p.contact = { email: null, sourceUrl: null, method: 'error', confidence: 0, candidates: [], needsDecision: false, error: err.message };
    }
    const email = p.contact.email?.toLowerCase();
    if (email && (earlier.has(email) || book.has(email))) {
      p.skip = `already contacted (${email})`;
      p.contact.email = null;
    }
  }

  const result = {
    org, institution, timeZone,
    meta: { works: works.length, since, perTopic, departments, authorsRanked: ranked.length, embedding: 'google/embeddinggemma-2', generatedAt: new Date().toISOString() },
    people,
  };
  saveRanked(dir, result);
  return summarize(result, dir);
}

function summarize(r, dir) {
  const out = {
    org: r.org, runDir: dir, rankedMd: path.join(dir, 'ranked.md'), institution: { id: r.institution.id, name: r.institution.name },
    people: r.people.map((p, i) => ({
      rank: i + 1, slug: p.slug, name: p.name, score: Number(p.score.toFixed(4)), pi: p.isPILikely,
      bestPaper: p.top[0]?.title, match: p.top[0]?.query, email: p.contact?.email ?? null, emailSource: p.contact?.sourceUrl ?? null,
      skip: p.skip ?? null, drafted: Boolean(p.draft), pushed: Boolean(p.push?.draftId),
    })),
    needsDecision: needsDecision(r),
  };
  return [out, `${readFileSync(out.rankedMd, 'utf8')}\nwritten: ${out.rankedMd}`];
}

// ---------------------------------------------------------------- pick

async function cmdPick(cfg, org, slug, choice) {
  const { dir, ranked } = loadRun(org);
  const p = ranked.people.find((x) => x.slug === slug);
  if (!p) throw new Error(`no person "${slug}" in ${org}`);
  if (!choice) throw new Error('pick needs <email|none>');
  if (choice === 'none') {
    p.contact = { ...p.contact, email: null, sourceUrl: null, needsDecision: false, method: 'human:none' };
  } else {
    const c = (p.contact?.candidates ?? []).find((x) => x.email.toLowerCase() === choice.toLowerCase());
    if (!c) throw new Error(`"${choice}" is not a published candidate for ${p.name}; candidates: ${(p.contact?.candidates ?? []).map((x) => x.email).join(', ') || 'none'}`);
    p.contact = { ...p.contact, email: c.email, sourceUrl: c.sourceUrl, method: `${c.method}+human`, needsDecision: false };
  }
  saveRanked(dir, ranked);
  return [{ slug, contact: p.contact }, `${p.name}: ${p.contact.email ?? 'no email'}${p.contact.sourceUrl ? ` (${p.contact.sourceUrl})` : ''}`];
}

// ---------------------------------------------------------------- draft

async function cmdDraft(cfg, org, flags, { requireOnly }) {
  const o = cfg.outreach;
  const { dir, ranked } = loadRun(org);
  const only = onlyList(flags);
  if (requireOnly && !only) throw new Error('--only <slug[,slug]> is required');
  const targets = ranked.people.filter((p) => (only ? only.includes(p.slug) : p.contact?.email));
  for (const s of only ?? []) if (!ranked.people.some((p) => p.slug === s)) throw new Error(`no person "${s}" in ${org}`);
  const facts = readFileSync(o.factsPath, 'utf8');
  const lanes = [...new Set(o.profileQueries.map((q) => q.resumeLane))].filter((l) => existsSync(o.resumePath(l)));
  const decider = decideWith(o.decisionThreshold);
  mkdirSync(path.join(dir, 'drafts'), { recursive: true });

  const done = [];
  for (const p of targets) {
    if (!p.contact?.email) { done.push({ slug: p.slug, error: 'no published email (pick one first)' }); continue; }
    if (p.push?.draftId) { done.push({ slug: p.slug, error: `already pushed as Gmail draft ${p.push.draftId}; edit it in Gmail` }); continue; }
    const note = flags.note[p.slug] ?? flags.note['*'] ?? '';
    log(`  drafting ${p.name}…`);
    const matchLane = o.profileQueries.find((q) => q.label === p.top[0]?.query || q.id === p.top[0]?.query)?.resumeLane;
    const resume = lanes.length > 1
      ? await chooseResume({ person: p, options: lanes.map((l) => ({ id: l, label: `${l} resume${l === matchLane ? ' (best-matching profile topic)' : ''}` })) }, decider)
      : { id: lanes[0] ?? matchLane, confident: true };
    const d = await draftEmail({
      person: p, papers: p.top, facts, institution: ranked.institution, note,
      signoff: o.draft.signoff, ask: o.draft.ask, fundingLine: o.draft.fundingLine, wordRange: [o.draft.minWords, o.draft.maxWords],
    }, o.backends);
    writeFileSync(path.join(dir, 'drafts', `${p.slug}.md`), `To: ${p.contact.email}\nSubject: ${d.subject}\n\n${d.body}\n`);
    p.draft = { subject: d.subject, words: d.words, review: d.review, resumeLane: resume.id, resumeConfident: resume.confident, note, at: new Date().toISOString() };
    done.push({ slug: p.slug, name: p.name, to: p.contact.email, subject: d.subject, words: d.words, resume: resume.id, reviewIssues: d.review.issues, body: d.body });
    saveRanked(dir, ranked);
  }
  return [{ org, drafts: done }, done.map((x) => x.error ? `✗ ${x.slug}: ${x.error}`
    : `── ${x.name} <${x.to}> · ${x.words}w · resume ${x.resume}\nSubject: ${x.subject}\n\n${x.body}\n${x.reviewIssues.length ? `\nreviewer fixed: ${x.reviewIssues.join('; ')}\n` : ''}`).join('\n')];
}

// ---------------------------------------------------------------- push

function readDraftFile(dir, slug) {
  const text = readFileSync(path.join(dir, 'drafts', `${slug}.md`), 'utf8');
  const subject = /^Subject:\s*(.*)$/m.exec(text)?.[1]?.trim();
  const body = text.split(/\n\n/).slice(1).join('\n\n').trim();
  if (!subject || !body) throw new Error(`drafts/${slug}.md must start with "To:" and "Subject:" lines, a blank line, then the body`);
  return { subject, body };
}

async function cmdPush(cfg, org, flags) {
  const o = cfg.outreach;
  const { dir, ranked } = loadRun(org);
  const only = onlyList(flags);
  if (!only) throw new Error('--only <slug[,slug]> is required for push');
  const targets = only.map((s) => {
    const p = ranked.people.find((x) => x.slug === s);
    if (!p) throw new Error(`no person "${s}" in ${org}`);
    if (!p.contact?.email || !p.draft) throw new Error(`${s}: needs a published email and a draft first`);
    return p;
  });

  // Count reminders already on the calendar per local date so new ones respect perDay across orgs and reruns.
  const horizon = new Date(Date.now() + 60 * 864e5).toISOString();
  const existing = await findReminders({ appPath: o.calendar.bridgeApp, calendarId: o.calendar.calendarId, titlePrefix: 'Send: ', from: new Date().toISOString(), to: horizon });
  const used = {};
  const dateIn = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: ranked.timeZone }).format(new Date(iso));
  for (const e of existing) used[dateIn(e.start)] = (used[dateIn(e.start)] ?? 0) + 1;
  const need = targets.filter((p) => !p.push?.eventId).length;
  const slots = planSlots({
    timeZone: ranked.timeZone, count: need, days: o.scheduling.days, window: o.scheduling.window,
    perDay: o.scheduling.perDay, gapMinutes: o.scheduling.gapMinutes, used, existing: existing.map((e) => e.start),
  });
  if (slots.length < need) throw new Error(`only ${slots.length} free slots for ${need} reminders`);

  const book = ledger(RUNS);
  const out = [];
  let si = 0;
  for (const p of targets) {
    const { subject, body } = readDraftFile(dir, p.slug);
    const resumePath = o.resumePath(p.draft.resumeLane);
    const title = `Send: ${p.name} (${ranked.institution.name})`;
    const slot = p.push?.eventId ? null : slots[si++];
    const row = { slug: p.slug, name: p.name, to: p.contact.email, subject, resume: path.basename(resumePath) };
    if (flags.dryRun) {
      out.push({ ...row, draft: p.push?.draftId ? `exists ${p.push.draftId}` : 'would create', reminder: p.push?.eventId ? `exists ${p.push.eventStart}` : `would create ${slot.start}` });
      continue;
    }
    p.push ??= {};
    if (!p.push.draftId) {
      // Guard against a lost state write: an identical draft already in Gmail counts as pushed.
      const dupes = await listDrafts({ clientPath: o.gmail.clientModule, account: o.gmail.account, query: `to:${p.contact.email} subject:"${subject}"` });
      p.push.draftId = dupes[0]?.id ?? (await createGmailDraft({ clientPath: o.gmail.clientModule, account: o.gmail.account, to: p.contact.email, subject, body, attachmentPath: resumePath })).draftId;
      p.push.draftedAt = new Date().toISOString();
      saveRanked(dir, ranked);
      book.add({ email: p.contact.email, authorId: p.authorId, name: p.name, org: ranked.org, institutionId: ranked.institution.id, draftId: p.push.draftId, at: p.push.draftedAt });
    }
    if (!p.push.eventId) {
      const r = await createReminder({
        appPath: o.calendar.bridgeApp, calendarId: o.calendar.calendarId, title, start: slot.start, end: slot.end, alarmMinutes: o.calendar.alarmMinutes,
        notes: `Recipient: ${p.name} <${p.contact.email}>\nSubject: ${subject}\nGmail draft: ${p.push.draftId}\nEmail source: ${p.contact.sourceUrl}\nOpen Gmail → Drafts and press Send.`,
      });
      p.push.eventId = r.eventId;
      p.push.eventStart = slot.start;
      saveRanked(dir, ranked);
    }
    out.push({ ...row, draftId: p.push.draftId, eventId: p.push.eventId, sendAt: p.push.eventStart });
  }
  return [{ org, dryRun: Boolean(flags.dryRun), pushed: out }, `${flags.dryRun ? 'DRY RUN — nothing created\n' : ''}${out.map((x) =>
    `${x.name} <${x.to}> — "${x.subject}" · ${x.resume}\n   draft: ${x.draftId ?? x.draft} · reminder: ${x.sendAt ?? x.reminder}`).join('\n')}`];
}

// ---------------------------------------------------------------- show / list

function cmdShow(org, slug) {
  const { dir, ranked } = loadRun(org);
  if (!slug) return summarize(ranked, dir);
  const p = ranked.people.find((x) => x.slug === slug);
  if (!p) throw new Error(`no person "${slug}" in ${org}`);
  const draftFile = path.join(dir, 'drafts', `${slug}.md`);
  const draftText = existsSync(draftFile) ? readFileSync(draftFile, 'utf8') : null;
  return [{ ...p, draftText }, `${p.name} — ${p.score.toFixed(3)}\n${p.top.map((t) => `  ${t.year} ${t.title} (${t.query})`).join('\n')}\ncontact: ${p.contact?.email ?? 'none'} ${p.contact?.sourceUrl ?? ''}\n\n${draftText ?? '(no draft)'}`];
}

function cmdList() {
  const rows = existsSync(RUNS) ? readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => {
    const r = readJson(path.join(RUNS, d.name, 'ranked.json'), null);
    if (!r) return { slug: d.name, status: 'incomplete' };
    return {
      slug: d.name, org: r.org, institution: r.institution.name, people: r.people.length,
      withEmail: r.people.filter((p) => p.contact?.email).length, drafted: r.people.filter((p) => p.draft).length,
      pushed: r.people.filter((p) => p.push?.draftId).length, needsDecision: needsDecision(r).length, at: r.meta.generatedAt,
    };
  }) : [];
  return [{ runs: rows }, rows.length ? rows.map((r) => `${r.slug.padEnd(30)} ${r.institution ?? r.status} · ${r.people ?? 0} people · ${r.withEmail ?? 0} email · ${r.drafted ?? 0} drafted · ${r.pushed ?? 0} pushed${r.needsDecision ? ` · ${r.needsDecision} need decision` : ''}`).join('\n') : 'no outreach runs yet'];
}

// ---------------------------------------------------------------- main

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  JSON_MODE = Boolean(flags.json);
  const [cmd, org, ...rest] = positional;
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^\/\/ ?/gm, ''));
    return;
  }
  const cfg = loadConfig();
  if (!cfg.outreach) throw new Error('config.json has no "outreach" section (see config.example.json)');
  if (cmd !== 'list' && !org) throw new Error(`${cmd} needs an organization name`);
  const commands = {
    scope: () => cmdScope(cfg, org, flags),
    research: () => cmdResearch(cfg, org, flags),
    pick: () => cmdPick(cfg, org, rest[0], rest[1]),
    draft: () => cmdDraft(cfg, org, flags, { requireOnly: true }),
    redraft: () => cmdDraft(cfg, org, flags, { requireOnly: true }),
    push: () => cmdPush(cfg, org, flags),
    show: () => cmdShow(org, rest[0]),
    list: () => cmdList(),
  };
  if (!commands[cmd]) throw new Error(`unknown command "${cmd}"`);
  const [result, text] = await commands[cmd]();
  emit(result, text);
}

main().catch((err) => {
  if (JSON_MODE) console.log(JSON.stringify({ error: err.message }));
  else console.error(`outreach: ${err.message}`);
  process.exit(1);
});
