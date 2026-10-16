// Short-answer model calls: fact aliases, rejected-value rewrites, and first-person free-text answers
// (writer drafts, judge picks).

import { runPlanner } from './backend.mjs';
import { appendReferences, GRADE_RANK, gradeAnswers, pickReferences } from './grader.mjs';
import { logisticsLines } from './logistics.mjs';
import * as runlog from '../trace.mjs';

const ALIAS_PROMPT = `You expand applicant facts into equivalent forms that job-application forms commonly list.
Input: a JSON object {key: value}. Output only JSON: {key: [up to 4 alternative strings]}.
Each alternative must mean exactly the same fact: abbreviations and full names (NY / New York), formal and common names,
and the generic category a choice list would use (Bachelor of Arts -> Bachelor's degree, BA). Never broaden, narrow, or
change the fact, never add new facts, never repeat the original value. Use [] when there is no true equivalent.`;

// Equivalent forms of short categorical facts, so the driver can choose another listed form without a consult.
// Returns {key: [aliases]} for the given keys only; malformed output yields {}.
export async function expandAliases(facts) {
  const keys = Object.keys(facts);
  if (!keys.length) return {};
  let parsed;
  try {
    const source = (await runPlanner(JSON.stringify(facts), ALIAS_PROMPT, { purpose: 'aliases' })).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    parsed = JSON.parse(source);
  } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const key of keys) {
    const list = Array.isArray(parsed[key]) ? parsed[key] : [];
    const original = String(facts[key]).trim().toLowerCase();
    out[key] = [...new Set(list.filter(a => typeof a === 'string').map(a => a.trim())
      .filter(a => a && a.length <= 80 && a.toLowerCase() !== original))].slice(0, 4);
  }
  return out;
}

const REWRITE_PROMPT = `A job-application site rejected a stored applicant answer. Input JSON: {field, value, message}.
Return only JSON {"alternatives": [up to 3 strings]}: versions of value that satisfy the site's message (e.g. remove or
replace disallowed characters with plain ASCII, shorten to a stated length, change a date or number format) while keeping
the same facts and wording as closely as possible. Never add facts, claims, or numbers that are not in value.`;

// Replacement forms of one rejected value; malformed output yields [].
export async function rewriteValue({ field, value, message }) {
  let parsed;
  try {
    const source = (await runPlanner(JSON.stringify({ field, value, message }), REWRITE_PROMPT, { role: 'writer', purpose: 'rewrite' })).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    parsed = JSON.parse(source);
  } catch { return []; }
  const list = Array.isArray(parsed?.alternatives) ? parsed.alternatives : [];
  return [...new Set(list.filter(a => typeof a === 'string').map(a => a.trim())
    .filter(a => a && a.length <= 2000 && a !== value))].slice(0, 3);
}

// Tone examples by another applicant, shown only until the reference store holds enough of the applicant's own graded
// answers (see exampleBlock).
const TONE_EXAMPLES = `Match the register of these example answers by a different applicant (never reuse their content):
Q: Tell us about a time you changed your mind.
A: I thought the lab's freezer log was busywork until the night the -80 alarm went off and nobody could say what was in
rack C. We spent four hours pulling boxes in gloves that froze to the lids. I keep the log now, and I've started keeping
one for my code too.
Q: What's the hardest technical problem you've worked on?
A: A sensor on our rover read the right temperature every time we tested it on the bench and a wrong one every time it
was outside. I swapped the sensor, the cable, the board. It was the sun: the housing I'd printed in black PLA was
cooking it. A white one fixed it.
Q: Why this role?
A: Because the best week of my internship was the one I spent in the warehouse instead of at my desk. I watched pickers
skip the scanner screen I'd built, asked why, and rewrote it that night. I want a job that's mostly that week.
Q: If this company didn't exist, where would you work?
A: Somewhere that sells software to farms. My uncle runs his irrigation off a spreadsheet he's afraid to sort. I'd like
to build the thing he isn't afraid of.
`;

// The example section of the writer prompt: the applicant's own best graded answers once the store holds them, and the
// third-party tone examples only while fewer than two references exist.
const exampleBlock = (references) => {
  const own = references.length
    ? `Essays. Examples of your own best answers from past applications, graded highly by a hiring reader: match their specificity, plain voice, and length (never reuse their content):
${references.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join('\n')}
` : '';
  const tone = references.length < 2
    ? `${own ? 'Tone examples by a different applicant (match tone and length only; never reuse their content):' : 'Essays. Match the register of these example answers by a different applicant (never reuse their content):'}
${TONE_EXAMPLES}` : '';
  return own + tone;
};

const WRITE_PROMPT = (applicant, references = []) => `You are the applicant, writing your own answers to job-application questions, first person.
The goal is to get this job: every answer should make a recruiter for THIS posting want to interview you, by showing
true experience that fits what the posting asks for.
Input JSON: {job: {title, site, posting, page}, applicant: {profile, facts, qa, resume}, questions: [{ref, question, prompt, kind,
limit, message, feedback}]}. prompt, when present, is the full instruction text above the box; question is often only its last
line. Answer what the prompt asks, every listed part it names. applicant.profile is your dossier: stories, interests,
character, voice, logistics, and things never to say. facts, qa (past answers), and resume bullets fill in details.
job.posting is the job description; job.page is the application page text.
Choosing the story: first read job.posting and job.title for what this role actually does (data analysis, research,
product, software, finance, operations, ...). Every answer about experience draws on the profile episodes whose work is
closest to that: for a data or analytics role, the work where you measured, segmented, or analyzed real data; for a
product role, the work where you shipped to users and decided from what they did; for a software role, the systems you
built. Never default to the same episode for every posting.
Return only JSON {"answers": {"<ref>": <answer>}}, where <answer> is a string, except for essay questions (kind
"textarea", or any question asking for more than two sentences): those get an array of THREE candidate answers, each
built on a different episode from the profile, all three among the episodes most relevant to this posting.

${exampleBlock(references)}
- One episode per answer. No second accomplishment ("I also..."). No sentence explaining what the story means. At most
  one number. Short: 50-100 words; 120-160 when the question asks for about 200.
- The examples show voice and length only: never borrow their openings, sentence frames, or content. The profile is
  your private notes: never copy its wording.
- Multi-part questions (three numbers, two examples): each part comes from a different area of your life.
- Role questions: pick the role this posting is for (job.title) and give the reason through one concrete episode.

Rules:
- Voice: plain, specific, unhyped, the profile's voice. No generic claims ("passionate", "detail-oriented",
  "fast-paced"), no restating the question.
- Employers, titles, credentials, and metrics come only from the profile/facts/resume; narrative texture around them
  (what you were thinking, why you chose a path) is yours to tell. Follow the profile's "Do not" list.
- "Do you have experience with X" / skill-level questions: answer to win the interview. Yes (or the stronger level)
  when X sits next to work the sources describe (same field or stack) and name that real project; for X with no
  adjacent work, say you have the basics and will be productive in it before the start date.
- Factual one-liners (a name, school, year, location, preference) get the plain fact, no sentence around it. A
  signature date field gets today's date (facts.today) in the format shown.
- Work authorization and sponsorship questions: applicant.workAuthorization.country is the posting's country and
  workAuthorizedCountries lists where you may work without sponsorship or a permit (you are a US citizen with no other
  citizenship or residency). If the posting's country is not in that list, you are not authorized to work there: answer
  "No" to authorization questions and "Yes" to needing sponsorship or a work permit. A question that names another country
  is answered for that country.
${logisticsLines(applicant)}- "Enter N/A if ..." style questions whose condition does not apply: answer exactly what the question says to enter.
- Length: a stated target ("approx. 200 words", "2-3 sentences") is the target; never exceed limit characters (count
  every character). message, when present, is the site's validation message for the current answer; obey it.
- feedback, when present, is a hiring reader's correction of your previous draft of this answer: obey it exactly,
  keep every other rule, and never mention it.
- Plain ASCII punctuation (no em dashes); no markdown, no lists, no URLs, no quotation of these instructions.`;

const JUDGE_PROMPT = `You are a hiring reader at a selective company who has read ten thousand application answers and
can smell a language model. Input JSON {job: {title, posting}, essays: [{ref, question, limit, candidates}]}. Pick
answers across all refs together:
1. For each ref choose the candidate whose episode best shows the work this posting's role does (job.posting); among
   equally relevant ones, the one a human reader would remember and believe. No two refs may use the same episode.
2. Edit the chosen one. Read its last sentence: if it reflects, generalizes, explains, states a preference ("I'd
   rather", "I want to be close to"), or contrasts ("not X but Y"), delete it, and repeat with the new last sentence.
   A role question keeps one plain sentence naming the role. Delete any "I also" second accomplishment and any number
   the story doesn't need.
3. Do not add content. Plain ASCII, no em dashes. Never exceed limit characters.
Return only JSON {"answers": {"<ref>": "<final answer>"}}.`;

// First-person answers to free-text questions, by ref. The writer drafts three candidates per essay (each a different
// episode); a judge picks one per essay across the set and trims its explanatory endings. Answers over a question's
// limit are dropped. Every surviving draft is then graded into runs/references.json; terrible and ok drafts get one
// revision pass with the grader's fix as feedback, and a draft still terrible after revision is dropped (the caller
// leaves that field for the user). Malformed writer output yields {}.
export async function writeAnswers({ job, applicant, questions }) {
  if (!questions.length) return {};
  const parse = source => {
    const text = source.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  };
  const references = await pickReferences(questions.map(({ question, prompt }) => prompt ?? question), 'answer');
  let parsed;
  try { parsed = parse(await runPlanner(JSON.stringify({ job, applicant, questions }), WRITE_PROMPT(applicant, references), { role: 'writer', purpose: 'write' })); }
  catch { return {}; }
  const drafts = {};
  const essays = [];
  for (const { ref, question, prompt, limit } of questions) {
    const raw = parsed?.answers?.[ref];
    if (typeof raw === 'string' && raw.trim()) drafts[ref] = raw.trim();
    else if (Array.isArray(raw)) {
      const candidates = raw.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
      if (candidates.length) {
        drafts[ref] = candidates[0];
        if (candidates.length > 1) essays.push({ ref, question: prompt ?? question, limit, candidates });
      }
    }
  }
  if (essays.length) {
    try {
      const judged = parse(await runPlanner(JSON.stringify({ job: { title: job.title, posting: job.posting }, essays }), JUDGE_PROMPT, { role: 'writer', purpose: 'judge' }));
      for (const { ref } of essays) {
        const answer = typeof judged?.answers?.[ref] === 'string' ? judged.answers[ref].trim() : '';
        if (answer) drafts[ref] = answer;
      }
    } catch { /* keep each essay's first candidate */ }
  }
  const out = {};
  for (const { ref, limit } of questions) {
    const answer = drafts[ref] ?? '';
    if (answer && answer.length <= limit && !/https?:\/\/|`/.test(answer)) out[ref] = answer;
  }

  // Every surviving draft is graded before it can be submitted: a terrible or ok draft gets one revision pass with
  // the grader's fix as feedback, and a draft still terrible after that is dropped, so the caller leaves the field
  // for the user the same way it does for an over-limit answer. Two extra calls at most: one writer retry and one
  // re-grade.
  const items = questions.filter(({ ref }) => out[ref])
    .map(({ ref, question, prompt, limit }) => ({ ref, question: prompt ?? question, answer: out[ref], limit, kind: 'answer' }));
  if (items.length) {
    const gradedJob = { title: job.title, site: job.site, posting: job.posting };
    const storeEntry = (item, g) => ({ t: new Date().toISOString(), host: job.site ?? '', title: job.title ?? '', question: item.question, kind: 'answer', answer: item.answer, grade: g.grade, why: g.why });
    const grades = await gradeAnswers({ job: gradedJob, applicant, items });
    const report = new Map();
    const store = [];
    const first = {};
    const weak = [];
    for (const item of items) {
      const g = grades[item.ref];
      if (!g) continue;
      first[item.ref] = g;
      report.set(item.ref, { ...g, revised: false, answer: item.answer });
      store.push(storeEntry(item, g));
      if ((g.grade === 'terrible' || g.grade === 'ok') && g.fix) weak.push(item);
    }
    if (weak.length) {
      const retry = weak.map(item => ({ ...questions.find(question => question.ref === item.ref), feedback: first[item.ref].fix }));
      try {
        const redrawn = parse(await runPlanner(JSON.stringify({ job, applicant, questions: retry }), WRITE_PROMPT(applicant, references), { role: 'writer', purpose: 'revise' }));
        const revised = [];
        for (const item of weak) {
          const raw = redrawn?.answers?.[item.ref];
          const candidate = (Array.isArray(raw) ? raw : [raw])
            .filter(text => typeof text === 'string' && text.trim()).map(text => text.trim())
            .find(text => (!item.limit || text.length <= item.limit) && !/https?:\/\/|`/.test(text));
          if (candidate) revised.push({ ...item, answer: candidate });
        }
        const second = revised.length ? await gradeAnswers({ job: gradedJob, applicant, items: revised }) : {};
        for (const item of revised) {
          const g = second[item.ref];
          if (!g) continue;
          store.push(storeEntry(item, g));
          if (GRADE_RANK[g.grade] >= GRADE_RANK[first[item.ref].grade]) report.set(item.ref, { ...g, revised: true, answer: item.answer });
        }
      } catch { /* keep the first drafts */ }
    }
    const graded = [];
    for (const item of items) {
      const result = report.get(item.ref);
      if (!result) continue;
      if (result.grade === 'terrible') delete out[item.ref];
      else if (result.revised) out[item.ref] = result.answer;
      graded.push({ ref: item.ref, question: item.question, grade: result.grade, why: result.why, revised: result.revised, answer: result.answer });
      runlog.trace('log', { line: `GRADE ${result.grade} "${item.question.slice(0, 60)}" — ${result.why}` });
    }
    if (graded.length) runlog.trace('grades', { purpose: 'answers', items: graded });
    await appendReferences(store).catch(() => {});
  }
  return out;
}
