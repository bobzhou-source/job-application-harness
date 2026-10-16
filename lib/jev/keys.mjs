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

// The keys the state lists: the offered facts, then the qa keys relevant to any label on the screen, interleaved by
// rank so every label's best match is listed before any label's second, capped.
export function offeredKeys(keys, labels, { perLabel = 8, cap = 40 } = {}) {
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
  return [...offeredFacts(keys), ...qa];
}
