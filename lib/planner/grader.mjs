// Answer grading and the graded-references store. One writer-role call grades a batch of drafted answers (and cover
// letters) on a four-level scale, so weak drafts can be revised before submission; every graded item is appended to
// runs/references.json (gitignored), and the writer prompt draws its own-best examples from the great/good entries.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlanner } from './backend.mjs';

export const GRADE_RANK = { terrible: 0, ok: 1, good: 2, great: 3 };

const GRADE_PROMPT = `You are a hiring reader at a selective company who has read ten thousand application answers and can smell a
language model. You grade an applicant's drafted answers before they are submitted.
Input JSON: {job: {title, site, posting}, applicant: {profile, facts, qa, resume}, items: [{ref, question, answer,
limit, kind}]}. kind is "answer" (an application-form answer) or "cover-letter". job.posting is the job description;
applicant.profile/facts/qa/resume are the only approved source of the applicant's history. A claim is supported when
the sources state it, or state it of a system the claim credits to that system's component or to the work as a whole
(a figure recorded for a platform covers its diffing engine and vice versa); a claim is unsupported only when the
sources never state it or state otherwise, or when the sources mark it interview-only or never-to-cite. Grade each
item on exactly this scale:
- terrible: any claim not supported by applicant.facts/profile/qa/resume; names a different employer, city, or role
  than job; does not answer the question; over limit characters; boilerplate ("passionate", "fast-paced",
  "detail-oriented"); restates the question; obvious model tells (em dashes, lists, "I also", an explanatory closing
  sentence); or a placeholder or N/A where a real answer was required.
- ok: correct and on-topic but generic, no concrete episode, or flat.
- good: one concrete episode from the applicant's profile, plain first-person voice, directly answers the question,
  right length.
- great: good, plus specific to what THIS posting's role actually does; memorable and believable; at most one
  number; nothing to cut.
Cover letters (kind "cover-letter") use the same scale, plus these rules: the first sentence names the role and the
company; the letter quotes one distinctive phrase from the posting and answers it with the applicant's experience;
320-420 words; no salutation ("Dear ...") and no sign-off ("Sincerely," or the applicant's name) — the closing
paragraph "Thank you for your time and consideration." is required, so it is not a sign-off and must not be held
against the letter; at most two em dashes; no invented facts. A letter breaking any of these is at most ok; invented
facts or the wrong company or role is terrible. Boilerplate ("passionate", "fast-paced", "detail-oriented") and
restating the question count against a letter exactly as they do against an answer.
Return only JSON {"grades": {"<ref>": {"grade": "terrible"|"ok"|"good"|"great", "why": "<one sentence>", "fix":
"<one sentence instruction>"}}}. why names the decisive reason in plain terms. fix is the single change that would
most raise the grade, as an instruction to the writer (empty string for great). Judge against THIS posting; never
invent facts the applicant does not have.`;

// Grades for a batch of drafted answers, by ref: {ref: {grade, why, fix}}. One writer call per batch; malformed
// output yields {}.
export async function gradeAnswers({ job, applicant, items }) {
  if (!Array.isArray(items) || !items.length) return {};
  const payload = {
    job: { title: job?.title ?? '', site: job?.site ?? '', posting: String(job?.posting ?? '').slice(0, 4000) },
    applicant,
    items: items.map(({ ref, question, answer, limit, kind }) => ({ ref, question, answer, ...(limit ? { limit } : {}), kind: kind ?? 'answer' })),
  };
  let parsed;
  try {
    const source = (await runPlanner(JSON.stringify(payload), GRADE_PROMPT, { role: 'writer', purpose: 'grade' })).trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    parsed = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
  } catch { return {}; }
  const grades = parsed?.grades;
  if (!grades || typeof grades !== 'object' || Array.isArray(grades)) return {};
  const out = {};
  for (const { ref } of items) {
    const g = grades[ref];
    if (!g || typeof g !== 'object' || !(g.grade in GRADE_RANK)) continue;
    out[ref] = { grade: g.grade, why: String(g.why ?? '').trim(), fix: String(g.fix ?? '').trim() };
  }
  return out;
}

// Graded answers and cover letters, newest last: [{t, host, title, question, kind, answer, grade, why}].
const REFERENCES_PATH = fileURLToPath(new URL('../../runs/references.json', import.meta.url));
let referencesCache = null;

// The stored references; a missing or corrupt file reads as empty.
export async function loadReferences() {
  if (referencesCache) return referencesCache;
  try {
    const parsed = JSON.parse(await readFile(REFERENCES_PATH, 'utf8'));
    referencesCache = Array.isArray(parsed) ? parsed : [];
  } catch { referencesCache = []; }
  return referencesCache;
}

// Appends graded items to the store, rewriting the whole file (grading is rare and the file stays small).
export async function appendReferences(entries) {
  if (!entries.length) return;
  const merged = [...await loadReferences(), ...entries];
  await mkdir(dirname(REFERENCES_PATH), { recursive: true });
  await writeFile(REFERENCES_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  referencesCache = merged;
}

const REF_STOP = new Set(['the', 'and', 'for', 'are', 'you', 'your', 'with', 'this', 'that', 'have', 'what', 'why', 'how', 'when', 'where', 'which', 'was', 'were', 'will', 'would', 'could', 'should', 'about', 'from', 'tell', 'describe', 'explain', 'please', 'any', 'our', 'us', 'its', 'not']);
const refTokens = text => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(token => token.length > 2 && !REF_STOP.has(token)));

// Up to `max` of the applicant's own best graded answers for the writer prompt: great entries when the store holds
// any, else good ones, same kind only, ranked by token overlap with the current questions (ties: most recent first).
// Answers are clipped so the prompt stays bounded.
export async function pickReferences(questions, kind, { max = 4, clip = 700 } = {}) {
  const store = await loadReferences();
  const usable = store.filter(entry => entry && entry.kind === kind && typeof entry.answer === 'string' && typeof entry.question === 'string'
    && (entry.grade === 'great' || entry.grade === 'good'));
  if (!usable.length) return [];
  const best = usable.some(entry => entry.grade === 'great') ? 'great' : 'good';
  const pool = usable.filter(entry => entry.grade === best);
  const queries = (Array.isArray(questions) ? questions : [questions]).map(refTokens);
  const scored = pool.map((entry, index) => {
    const against = refTokens(entry.question);
    let score = 0;
    for (const query of queries) {
      let overlap = 0;
      for (const token of query) if (against.has(token)) overlap += 1;
      score = Math.max(score, overlap);
    }
    return { entry, score, index };
  });
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  return scored.slice(0, max).map(({ entry }) => ({ question: entry.question, answer: entry.answer.slice(0, clip) }));
}
