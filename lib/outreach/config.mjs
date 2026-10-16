// Outreach settings live in the ignored config.json under "outreach". Everything personal (accounts, paths,
// profile queries, sign-off) arrives here; lib/outreach modules take it as arguments and hold no defaults of their own.
import os from 'node:os';
import path from 'node:path';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fail(field, reason) {
  throw new Error(`Invalid configuration field outreach.${field}: ${reason}.`);
}

function obj(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'expected an object');
  return value;
}

function str(value, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) fail(field, 'expected a non-empty string');
  return value;
}

function num(value, field, fallback, min, max) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(field, `expected a number in [${min}, ${max}]`);
  return v;
}

function filePath(value, field) {
  const v = str(value, field);
  return v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
}

function hhmm(value, field) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '')) fail(field, 'expected HH:MM');
  return value;
}

function backend(value, field) {
  const b = obj(value, field);
  const kind = str(b.backend, `${field}.backend`);
  if (kind === 'omp') {
    return { backend: 'omp', model: str(b.model, `${field}.model`), thinking: str(b.thinking, `${field}.thinking`, 'minimal'), maxTime: str(b.maxTime, `${field}.maxTime`, '120s') };
  }
  if (kind === 'deepseek' || kind === 'openai-compatible') {
    return { backend: 'deepseek', model: str(b.model, `${field}.model`), endpoint: str(b.endpoint, `${field}.endpoint`), apiKeyEnv: str(b.apiKeyEnv, `${field}.apiKeyEnv`) };
  }
  return fail(`${field}.backend`, 'expected omp or deepseek');
}

/** Validate and default the raw "outreach" object. `resumes` is the already-validated top-level resumes config. */
export function outreachConfig(raw, resumes) {
  const o = obj(raw, '');
  const gmail = obj(o.gmail, 'gmail');
  const calendar = obj(o.calendar, 'calendar');
  const openalex = obj(o.openalex, 'openalex');
  const ranking = obj(o.ranking, 'ranking');
  const scheduling = obj(o.scheduling, 'scheduling');
  const draft = obj(o.draft, 'draft');
  const backends = obj(o.backends, 'backends');

  if (!Array.isArray(o.profileQueries) || !o.profileQueries.length) fail('profileQueries', 'expected a non-empty array');
  const ids = new Set();
  const profileQueries = o.profileQueries.map((q, i) => {
    const f = `profileQueries[${i}]`;
    const entry = obj(q, f);
    const id = str(entry.id, `${f}.id`);
    if (ids.has(id)) fail(`${f}.id`, 'must be unique');
    ids.add(id);
    return { id, label: str(entry.label, `${f}.label`, id), query: str(entry.query, `${f}.query`), terms: str(entry.terms, `${f}.terms`, str(entry.label, `${f}.label`, id)), resumeLane: str(entry.resumeLane, `${f}.resumeLane`, resumes.fallbackLane) };
  });

  const days = scheduling.days ?? ['Tue', 'Wed', 'Thu'];
  if (!Array.isArray(days) || !days.length || days.some((d) => !WEEKDAYS.includes(d))) fail('scheduling.days', `expected weekday names from ${WEEKDAYS.join(',')}`);
  const window = scheduling.window ?? ['09:00', '10:30'];
  if (!Array.isArray(window) || window.length !== 2) fail('scheduling.window', 'expected [start, end]');

  return {
    gmail: { clientModule: filePath(gmail.clientModule, 'gmail.clientModule'), account: str(gmail.account, 'gmail.account') },
    calendar: {
      bridgeApp: filePath(calendar.bridgeApp, 'calendar.bridgeApp'),
      calendarId: str(calendar.calendarId, 'calendar.calendarId'),
      alarmMinutes: num(calendar.alarmMinutes, 'calendar.alarmMinutes', 10, 0, 1440),
    },
    profileQueries,
    resumePath: (lane) => path.join(resumes.directory, resumes.filePattern.replace('{lane}', lane)),
    factsPath: resumes.factsPath,
    draft: {
      signoff: str(draft.signoff, 'draft.signoff'),
      ask: str(draft.ask, 'draft.ask'),
      fundingLine: str(draft.fundingLine, 'draft.fundingLine', ''),
      minWords: num(draft.minWords, 'draft.minWords', 120, 40, 400),
      maxWords: num(draft.maxWords, 'draft.maxWords', 180, 60, 600),
    },
    openalex: {
      mailto: str(openalex.mailto, 'openalex.mailto'),
      lookbackYears: num(openalex.lookbackYears, 'openalex.lookbackYears', 3, 1, 15),
      // Topic-search mode: relevance-sorted works fetched per profile topic, then deduped (cap applies per topic).
      perTopic: num(openalex.perTopic, 'openalex.perTopic', 100, 10, 1000),
    },
    ranking: {
      n: num(ranking.n, 'ranking.n', 10, 1, 100),
      minWorks: num(ranking.minWorks, 'ranking.minWorks', 2, 1, 20),
      topK: num(ranking.topK, 'ranking.topK', 3, 1, 10),
      recencyHalfLifeYears: num(ranking.recencyHalfLifeYears, 'ranking.recencyHalfLifeYears', 1.5, 0.25, 20),
      piBonus: num(ranking.piBonus, 'ranking.piBonus', 0.25, 0, 2), // in per-topic z units
    },
    scheduling: {
      days,
      window: [hhmm(window[0], 'scheduling.window[0]'), hhmm(window[1], 'scheduling.window[1]')],
      perDay: num(scheduling.perDay, 'scheduling.perDay', 3, 1, 20),
      gapMinutes: num(scheduling.gapMinutes, 'scheduling.gapMinutes', 15, 1, 240),
    },
    decisionThreshold: num(o.decisionThreshold, 'decisionThreshold', 0.6, 0.34, 0.99),
    exclusionDirs: (o.exclusionDirs ?? []).map((d, i) => filePath(d, `exclusionDirs[${i}]`)),
    backends: {
      drafter: backend(backends.drafter ?? { backend: 'omp', model: 'anthropic/claude-sonnet-5-5', thinking: 'medium', maxTime: '300s' }, 'backends.drafter'),
      reviewer: backend(backends.reviewer ?? { backend: 'omp', model: 'anthropic/claude-sonnet-5-5', thinking: 'medium', maxTime: '300s' }, 'backends.reviewer'),
      light: backend(backends.light ?? { backend: 'omp', model: 'anthropic/claude-haiku-4-5', thinking: 'minimal', maxTime: '45s' }, 'backends.light'),
    },
  };
}
