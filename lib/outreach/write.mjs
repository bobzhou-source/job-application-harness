// Cold-email drafting for outreach: one drafter call, one independent reviewer call, then deterministic gates.
// Everything personal (the facts text, the sign-off, the ask) arrives as arguments; no defaults are baked in here.
import { complete } from './llm.mjs';

const MAX_ATTEMPTS = 3; // the first draft plus at most two regenerations

function wordCount(text) {
  return (String(text ?? '').match(/\S+/g) ?? []).length;
}

function truncate(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function extractJson(text) {
  if (typeof text !== 'string') throw new Error('model returned no text');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`no JSON object in model output: ${truncate(text, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

function institutionLine(institution) {
  if (typeof institution === 'string') return institution.trim();
  if (!institution || typeof institution !== 'object') return '';
  const name = institution.display_name ?? institution.name ?? '';
  const where = [institution.city, institution.country_code ?? institution.country].filter(Boolean).join(', ');
  return [name, where].filter(Boolean).join(', ');
}

function papersOf(papers) {
  if (!Array.isArray(papers) || papers.length === 0) throw new TypeError('papers must be a non-empty array');
  const list = papers.filter((p) => p && typeof p.title === 'string' && p.title.trim()).slice(0, 8);
  if (list.length === 0) throw new TypeError('papers must contain at least one paper with a title');
  return list;
}

function paperBlock(papers) {
  return papers
    .map((p, i) => [
      `${i + 1}. ${p.title}`,
      `   year: ${p.year ?? 'n.d.'}${p.venue ? ` | venue: ${p.venue}` : ''}`,
      p.doi ? `   doi: ${p.doi}` : null,
      p.abstract ? `   abstract: ${truncate(p.abstract, 1400)}` : null,
    ].filter(Boolean).join('\n'))
    .join('\n');
}

function checkRange(wordRange) {
  if (!Array.isArray(wordRange) || wordRange.length !== 2
    || !wordRange.every((n) => Number.isInteger(n) && n > 0) || wordRange[0] > wordRange[1]) {
    throw new TypeError('wordRange must be [min, max] positive integers');
  }
  return wordRange;
}

// The funding sentence is supplied by the caller (config `draft.fundingLine`); nothing is baked in here. An empty
// fundingLine still asks for the funding point generically, since the reviewer checks for it.
function fundingRule(fundingLine) {
  const line = String(fundingLine ?? '').trim();
  return line
    ? `- Include exactly one sentence conveying this, in your own words: "${line}". It must say that your college's funding can cover your travel and housing, so you could come in person. Do not dwell on the money.`
    : `- Include exactly one sentence saying that your college's funding can cover your travel and housing, so you could come in person. Do not dwell on the money.`;
}

function draftSystem(range, signoff, ask, fundingLine) {
  return `You write one cold email for an undergraduate researcher who is asking a scientist for a 15-minute call about a research position.

Return strict JSON only: {"subject": "...", "body": "..."}

Rules:
- The body is ${range[0]}-${range[1]} words. This is measured; stay inside it.
- Plain text: no markdown, no bullet points, no headings, no emoji, no placeholder brackets.
- Open by engaging with ONE specific paper of theirs named in the request: say concretely what it does or what result it reports and why that is hard or interesting. No flattery.
- Then connect to exactly ONE concrete piece of your own evidence, taken verbatim in substance from the FACTS block.
- ${ask}
${fundingRule(fundingLine)}
- Close plainly. No "I look forward to hearing from you" padding, no moralizing closer, no apology for reaching out.
- The subject line is at most 9 words and specific to their work.
- The final line of the body must be exactly: ${signoff}
- Use only facts in FACTS about you. Never invent a number, incident, or claim about their group.
- Never describe a non-public repository or internal system as "open-source", and never claim to have hit the same bug or otherwise worked with their internal infrastructure.`;
}

function reviewSystem(range, signoff, fundingLine, ask) {
  return `You audit a cold email before a human considers sending it.

Return strict JSON only: {"issues": ["..."], "corrected": {"subject": "...", "body": "..."}}

Check every one of these against the supplied FACTS and paper list:
- each claim about the applicant traceable to FACTS; flag invented numbers or incidents, and claims about the recipient's internal infrastructure or codebase;
- never call a non-public repository "open-source";
- the recipient's paper claims must be supported by the supplied title/abstract;
- the body is ${range[0]}-${range[1]} words; count the words;
- plain text, no markdown, no bullet lists;
- it makes this ask, and the ask's timing/format details are applicant-supplied facts (keep them, do not flag them): ${ask};
- the funding sentence: it contains one sentence about the applicant's college funding covering travel and housing${String(fundingLine ?? '').trim() ? `, conveying the meaning of: "${String(fundingLine).trim()}"` : ''};
- the final line is exactly: ${signoff};
- subject at most 9 words.

"issues" lists every problem found and every change you made (empty when the draft is already clean). "corrected" is the fixed email, or the input unchanged when it is already clean. Never add facts that are not in FACTS.`;
}

function buildDraftPrompt({ person, papers, facts, institution, note, signoff }) {
  const p = papers[0];
  const where = institutionLine(institution);
  return `# FACTS about the applicant
${facts}

# Recipient
Name: ${person.name}${person.title ? `\nTitle: ${person.title}` : ''}${where ? `\nInstitution: ${where}` : ''}
${person.orcid ? `ORCID: ${person.orcid}` : ''}
${note ? `\n# Note\n${note}` : ''}

# Their papers that match the applicant's background
${paperBlock(papers)}

# Task
Write the email, opening on paper 1. Return JSON: {"subject": "...", "body": "..."}
The final line of the body must be exactly: ${signoff}`;
}

function buildReviewPrompt({ draft, person, papers, facts, signoff }) {
  return `# FACTS (the only permitted source of claims about the applicant)
${facts}

# Recipient
${person.name}

# Their papers
${paperBlock(papers)}

# Draft to audit
Subject: ${draft.subject}

${draft.body}

# Task
Audit the draft, fix it, and return JSON as specified. The final line of the body must be exactly: ${signoff}`;
}

const FUNDING_RE = /(funding|fund|travel|housing|stipend|reimburse)/i;

/** Ensure the funding point and the sign-off survive; the funding sentence itself comes from the caller. */
function repair(draft, signoff, fundingLine) {
  let body = String(draft.body ?? '').trim();
  if (!body.includes(signoff)) body = `${body}\n\n${signoff}`;
  const line = String(fundingLine ?? '').trim();
  if (line && !FUNDING_RE.test(body)) {
    const at = body.indexOf(signoff);
    const head = (at === -1 ? body : body.slice(0, at)).trim();
    const sentence = /[.!?]$/.test(line) ? line : `${line}.`;
    body = `${head}\n${sentence}\n\n${signoff}`;
  }
  return { subject: String(draft.subject ?? '').trim(), body };
}

/**
 * Draft a personalized cold email, then have a separate reviewer audit it.
 *
 * @param {object} input
 * @param {{name:string, title?:string, orcid?:string}} input.person   the recipient
 * @param {Array<{title:string, year?:number, venue?:string, doi?:string, abstract?:string}>} input.papers
 * @param {string} input.facts            the applicant's facts text (only permitted claim source)
 * @param {string|object} input.institution  recipient institution (name / display_name + city + country_code)
 * @param {string} [input.note]           extra guidance (e.g. why this person matched)
 * @param {string} input.signoff          the exact final line of the body
 * @param {string} input.ask              the request sentence (e.g. a 15-minute call about a research position)
 * @param {string} [input.fundingLine='']  the caller's funding sentence (config `draft.fundingLine`); no funding text lives in this module
 * @param {[number,number]} [input.wordRange=[120,180]]
 * @param {Record<string, object>} backends  keys `drafter` and `reviewer`
 * @returns {Promise<{subject:string, body:string, words:number, review:{issues:string[], changed:boolean}}>}
 */
export async function draftEmail({ person, papers, facts, institution, note, signoff, ask, fundingLine = '', wordRange = [120, 180] }, backends) {
  if (!person || typeof person.name !== 'string' || !person.name.trim()) throw new TypeError('person.name is required');
  if (typeof facts !== 'string' || !facts.trim()) throw new TypeError('facts must be a non-empty string');
  if (typeof signoff !== 'string' || !signoff.trim()) throw new TypeError('signoff must be a non-empty string');
  if (typeof ask !== 'string' || !ask.trim()) throw new TypeError('ask must be a non-empty string');
  const list = papersOf(papers);
  const range = checkRange(wordRange);
  if (!backends?.drafter) throw new TypeError('backends.drafter is required');
  if (!backends?.reviewer) throw new TypeError('backends.reviewer is required');

  const draftPrompt = buildDraftPrompt({ person, papers: list, facts, institution, note, signoff });
  let draft;
  let attempts = 0;
  let lastReason = '';
  let beforeReview = null;
  let issues = [];
  let reviewed = false;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const prompt = attempts === 1
      ? draftPrompt
      : `${draftPrompt}\n\n# Your previous attempt was rejected\nReason: ${lastReason}\n` +
        `Previous subject: ${draft.subject}\nPrevious body:\n${draft.body}\n\n` +
        `Rewrite it fixing exactly that. Keep the required sign-off line, the funding sentence, and the request. ` +
        `Return the same JSON shape.`;
    draft = extractJson(await complete(
      { role: 'drafter', system: draftSystem(range, signoff, ask, fundingLine), prompt },
      backends,
    ));
    if (typeof draft?.subject !== 'string' || typeof draft?.body !== 'string') throw new Error('drafter returned the wrong shape');
    draft = repair(draft, signoff, fundingLine);

    // The reviewer audits the first draft once and hands back corrected text; only its issues are kept.
    if (!reviewed) {
      beforeReview = { subject: draft.subject, body: draft.body };
      const audit = extractJson(await complete(
        { role: 'reviewer', system: reviewSystem(range, signoff, fundingLine, ask), prompt: buildReviewPrompt({ draft, person, papers: list, facts, signoff }) },
        backends,
      ));
      reviewed = true;
      issues = Array.isArray(audit?.issues) ? audit.issues.filter((i) => typeof i === 'string' && i.trim()) : [];
      if (typeof audit?.corrected?.subject === 'string' && typeof audit?.corrected?.body === 'string') {
        draft = repair({ subject: audit.corrected.subject, body: audit.corrected.body }, signoff, fundingLine);
      }
    }

    const words = wordCount(draft.body);
    const subjectWords = wordCount(draft.subject);
    if (words >= range[0] && words <= range[1] && subjectWords <= 9) break;
    lastReason = words < range[0] || words > range[1]
      ? `body ${words} words outside ${range[0]}-${range[1]}`
      : `subject ${subjectWords} words over the 9-word limit`;
  }

  const subject = draft.subject.trim();
  const body = draft.body.trim();
  return {
    subject,
    body,
    words: wordCount(body),
    review: {
      issues,
      changed: Boolean(beforeReview) && (subject !== beforeReview.subject.trim() || body !== beforeReview.body.trim()),
    },
  };
}

/**
 * Let Jev pick which resume lane to attach, from the caller's options.
 *
 * @param {{person:{name:string, institution?:string, top?:Array<{title:string}>, topPapers?:Array<{title:string}>}, options:{id:string,label:string}[]}} input
 * @param {(args:{question:string, context:unknown, options:{id:string,label:string}[]}) => Promise<{choice:string, probs:Record<string,number>, confident:boolean}>} decide
 * @returns {Promise<{id:string, confident:boolean}>}
 */
export async function chooseResume({ person, options }, decide) {
  if (!person || typeof person.name !== 'string' || !person.name.trim()) throw new TypeError('person.name is required');
  if (!Array.isArray(options) || options.length < 2) throw new TypeError('options must list at least two resume lanes');
  for (const option of options) {
    if (!option || typeof option.id !== 'string' || !option.id.trim() || typeof option.label !== 'string' || !option.label.trim()) {
      throw new TypeError('each option requires a non-empty id and label');
    }
  }
  if (typeof decide !== 'function') throw new TypeError('decide must be a function');

  const recent = (person.top ?? person.topPapers ?? []).map((p) => p?.title).filter(Boolean).slice(0, 5);
  const question = `A cold email to this scientist needs one resume attached. Choose the resume lane that matches the work they actually do, guided by the papers listed in the context.`;
  const { choice, confident } = await decide({
    question,
    context: { recipient: person.name, institution: person.institution ?? null, theirRecentWork: recent },
    options,
  });
  return { id: choice, confident };
}
