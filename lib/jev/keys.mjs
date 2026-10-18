// lib/jev/keys.mjs — which stored answers the driver is shown.
//
// The stored answers run to hundreds of keys (some 70 facts, hundreds of qa questions), and a verdict request lists
// each offered key with its value once in the state and again as a criterion of every field question (about 20
// tokens per key per listing). Offering the first 80 keys in storage order showed Jev every fact and seven qa
// answers: of the 365 keys DeepSeek consults filled with on one day, 284 were qa keys Jev had never been shown, so
// Jev judged "none", the planner was consulted, and the planner found the answer. So:
//   - facts are offered except the work-history entries (facts.work.N.*): lib/apply/workhistory.mjs keys those by
//     label, and Jev chose none of them in 18.8k calls;
//   - qa keys are offered by relevance: a key whose question shares content words with the label it is offered for.

const STOP = new Set(("the a an of to in for you your are is do does did have has had any this that these those with or and "
  + "please select one if be will would what which who how when where were was been being on at by from as it its into "
  + "our we i my me can could should may might not no yes also etc than then there their they them so such only own per "
  + "required optional enter provide indicate following applicable question answer choose").split(" "));

const words = text => {
  const seen = new Set();
  for (const word of String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) {
    if (word && !STOP.has(word) && (word.length >= 2 || /^\d$/.test(word))) seen.add(word);
  }
  return seen;
};

const isFact = key => key.startsWith("facts.");
const ownedFact = key => /^facts\.work\.\d+\./.test(key);

// The qa keys relevant to one label, best first: those sharing at least two content words with it (one when either
// side has no more than two), scored by shared words over the key's own length so a tight question outranks a long
// one that merely contains the same words.
export function relevantQa(keys, label, limit = 8) {
  const want = words(label);
  if (!want.size) return [];
  const scored = [];
  for (const key of keys) {
    if (isFact(key)) continue;
    const have = words(key.replace(/^qa\./, ""));
    let shared = 0;
    for (const word of have) if (want.has(word)) shared += 1;
    if (shared < 2 && !(shared === 1 && Math.min(want.size, have.size) <= 2)) continue;
    scored.push({ key, score: shared / Math.sqrt(have.size), length: key.length });
  }
  return scored.sort((a, b) => b.score - a.score || a.length - b.length).slice(0, limit).map(entry => entry.key);
}

export const offeredFacts = keys => keys.filter(key => isFact(key) && !ownedFact(key));

// A fact's family: its key without a derived format suffix (date parts, phone digits, a stored alias). Selecting the
// fact selects every form the executor already derived from it, so Jev can match the field's requested format.
const FACT_SUFFIX = /\.(?:alias_\d+|us|year|month|mm_yyyy|yyyy_mm|digits)$/;
const baseFact = key => {
  let base = key;
  while (FACT_SUFFIX.test(base)) base = base.replace(FACT_SUFFIX, '');
  return base;
};
const SPECIAL_FACTS = [
  [/\b(?:signature|signed by|typed name|type your full name|initials)\b/, ['facts.legal_full_name', 'facts.legal_initials']],
  [/\bbirth\b/, ['facts.date_of_birth']],
  [/\b(?:today|current date|signature date)\b/, ['facts.today']],
  [/\bcitizen(?:ship)?\b/, ['facts.us_citizen']],
  [/\b(?:salary|pay|compensation|hourly|annual)\b/, ['facts.pay_expectation']],
  [/\b(?:zip|postal)\b/, ['facts.zip']],
  [/\b(?:mobile|phone|telephone)\b/, ['facts.phone']],
  [/\b(?:website|portfolio|profile url)\b/, ['facts.website', 'facts.linkedin']],
  [/\b(?:sponsor(?:ship)?|visa)\b/, ['facts.sponsorship']],
  [/\b(?:authorization|authorized|work permit)\b/, ['facts.work_authorization']],
];

const stem = word => word
  .replace(/(?:izations?|isations?)$/u, 'ize')
  .replace(/(?:izing|ized|izes)$/u, 'ize')
  .replace(/(?:ments?|ing|ed|es|s)$/u, '');

// The facts and their format aliases relevant to one visible question: keys sharing a content word with the label
// (after a light plural/tense stem), the shortest such key first; signature, birth-date, and today's-date questions
// take their known facts even when the wording shares no word. Work-history facts stay local to workhistory.mjs.
export function relevantFacts(keys, label, limit = 12) {
  const want = words(label);
  if (!want.size) return [];
  const wantedStems = new Set([...want].map(stem));
  const families = new Map();
  for (const key of offeredFacts(keys)) {
    const base = baseFact(key);
    if (!families.has(base)) families.set(base, []);
    families.get(base).push(key);
  }
  const scored = [];
  for (const [base, family] of families) {
    const have = words(base.slice('facts.'.length).replaceAll('_', ' '));
    let shared = 0;
    for (const word of have) if (wantedStems.has(stem(word))) shared += 1;
    const phrase = ` ${[...have].join(' ')} `;
    const exact = phrase.trim() && ` ${[...want].join(' ')} `.includes(phrase) ? 1 : 0;
    if (!shared && !exact) continue;
    scored.push({ family, score: exact * 10 + shared / Math.sqrt(have.size || 1), length: base.length });
  }
  scored.sort((a, b) => b.score - a.score || a.length - b.length || (a.family[0] < b.family[0] ? -1 : 1));
  const out = [];
  const seen = new Set();
  const add = key => { if (!seen.has(key)) { seen.add(key); out.push(key); } };
  for (const entry of scored.slice(0, limit)) entry.family.forEach(add);
  for (const [pattern, wanted] of SPECIAL_FACTS) {
    if (!pattern.test(label)) continue;
    for (const base of wanted) for (const key of families.get(base) ?? []) add(key);
  }
  return out;
}

// The keys the state lists: the facts relevant to the visible questions, then the qa keys relevant to any label on
// the screen, interleaved by rank so every label's best match is listed before any label's second, capped.
export function offeredKeys(keys, labels, { perLabel = 8, cap = 40, factCap = 60 } = {}) {
  const facts = [];
  const seenFacts = new Set();
  for (const label of labels) {
    for (const key of relevantFacts(keys, label)) {
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      facts.push(key);
      if (facts.length >= factCap) break;
    }
    if (facts.length >= factCap) break;
  }
  const ranked = labels.map(label => relevantQa(keys, label, perLabel));
  const qa = [];
  const seen = new Set();
  for (let rank = 0; rank < perLabel && qa.length < cap; rank += 1) {
    for (const list of ranked) {
      const key = list[rank];
      if (key && !seen.has(key)) { seen.add(key); qa.push(key); }
      if (qa.length >= cap) break;
    }
  }
  return [...facts, ...qa];
}
