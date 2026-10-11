// lib/mail/classify.mjs — what a job email says (its kind), the deadline it states, and the link that acts on it.
// Fixed patterns only: no model sees any mail.

// What a message says, first match wins: 'account' (verification/reset mail; not a response), 'offer', 'rejected',
// 'completed' (the employer acknowledges a finished assessment), 'assessment', 'interview', 'incomplete' (the employer
// says the application or profile is unfinished), 'confirmed', else 'update'. Offer, rejection, assessment and
// interview cues inside conditional sentences ("if selected, a recruiter will reach out to schedule an interview"; "if
// we choose not to move forward…") are confirmation boilerplate, not decisions; offer cues also skip negated sentences
// ("This email is not an offer of employment"), and "interview invitation" counts only in the subject, since product
// and newsletter copy uses the phrase too. Each entry: kind, pattern, scope (full text, definite sentences, definite
// non-negated sentences, or subject).
const KINDS = [
  ['account', /verify your (e-?mail|account|identity)|confirm your (e-?mail( address)?|account|identity)|verification code|one[- ]time (pass)?code|password reset|reset your password|activate your account|security code/i, 'full'],
  ['offer', /\b(pleased|happy|delighted|excited) to (extend|offer) you|offer of (employment|internship)|extend (you )?an offer|your offer letter\b/i, 'affirmed'],
  ['rejected', /unfortunately,? (we|after|at this time|this time|your application|the (position|role))|regret to inform|not (be )?mov(e|ing) forward|decided (not )?to (move forward|proceed|pursue) with (other|another)|other candidates (whose|who)|not (been )?selected|no longer (being )?(under )?consider|position has (now )?been filled|will not be (moving|proceeding|advancing|progressing)|move in a different direction|not able to offer|unable to offer/i, 'definite'],
  ['completed', /thank(s| you) for completing|(assessment|test|challenge|video interview) (has been |was )?(completed|submitted|received)|received your (completed )?(assessment|test|challenge|responses)|you have (successfully )?completed (the|your)/i, 'definite'],
  ['assessment', /\b(online assessment|coding (challenge|assessment|test)|technical assessment|interactive assessment|assessment (request|invitation|link)|hackerrank|codesignal|codility|hirevue|pymetrics|karat|take-?home|(complete|take) (the|your|this|an) (online |interactive )?(assessment|challenge|test)|game-?based assessment|aptitude test)\b/i, 'definite'],
  ['interview', /\binterview (invitation|request|invite)|invitation to interview|invited to (an? )?interview/i, 'subject'],
  ['interview', /\b(invite you to (an? )?(interview|phone|video|virtual)|schedule (your|an|a) (interview|phone screen|call)|(select|choose|book|pick) a (time|slot)|phone screen|first[- ]round interview|superday|would (like|love) to (speak|chat|meet|connect) with you|share your availability|let us know your availability)\b/i, 'definite'],
  ['incomplete', /complete your (job )?application|finish your application|(application|profile) (is )?(still )?incomplete|incomplete (job )?application|not yet (been )?submitted|complete the submittal|additional information (is )?(needed|required)/i, 'full'],
  ['confirmed', /thank(s| you) for (applying|your application|submitting|your interest|taking the time to apply)|application (has been |was |is )?(received|submitted|complete)|received your application|we (have )?received|successfully (applied|submitted)/i, 'full'],
];
const CONDITIONAL = /\b(if|should|may|might|once|whether|in the event)\b/i;
const NEGATED = /\bnot\b|n't\b|\bnever\b/i;

export function classify(subject, text) {
  const full = `${subject ?? ''}\n${String(text ?? '').slice(0, 6000)}`;
  const sentences = full.split(/(?<=[.!?\n])\s+/).filter(sentence => !CONDITIONAL.test(sentence));
  const scopes = {
    full, subject: String(subject ?? ''), definite: sentences.join(' '),
    affirmed: sentences.filter(sentence => !NEGATED.test(sentence)).join(' '),
  };
  for (const [kind, pattern, scope] of KINDS) if (pattern.test(scopes[scope])) return kind;
  return 'update';
}

// Kinds that ask the applicant to do something.
export const ACTION_KINDS = new Set(['offer', 'assessment', 'interview', 'incomplete']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const CUE = '(?:by|before|until|no later than|deadline(?: is|:)?|due(?: by| on|:)?|expires?(?: on)?|within|after|valid for|closes?(?: on)?)';
// The deadline a message states, as ms, or null: an absolute date after a cue word ("by October 15", "due 10/15/2026",
// "expires on 15 Oct") or a relative span ("within 5 days", "deleted after 30 days", "valid for 72 hours") counted
// from the message date. A month-day date without a year is the next such date on or after the message.
export function deadline(text, sentAt) {
  const body = String(text ?? '').replace(/\s+/g, ' ');
  const at = (year, month, day) => {
    let ms = Date.UTC(year ?? new Date(sentAt).getUTCFullYear(), month, day, 23, 59);
    if (year == null && ms < sentAt - 86_400_000) ms = Date.UTC(new Date(sentAt).getUTCFullYear() + 1, month, day, 23, 59);
    return Number.isNaN(ms) || month < 0 || month > 11 || day < 1 || day > 31 ? null : ms;
  };
  const year = y => (y == null ? null : Number(y) < 100 ? 2000 + Number(y) : Number(y));
  const patterns = [
    [new RegExp(`\\b${CUE}\\s+(?:\\w+day,?\\s+)?${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'), m => at(year(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), Number(m[2]))],
    [new RegExp(`\\b${CUE}\\s+(?:\\w+day,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?`, 'i'), m => at(year(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), Number(m[1]))],
    [new RegExp(`\\b${CUE}\\s+(?:\\w+day,?\\s+)?(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, 'i'), m => at(year(m[3]), Number(m[1]) - 1, Number(m[2]))],
    [new RegExp(`\\b${CUE}\\s+(?:the next\\s+)?(\\d{1,3}|one|two|three|five|seven|ten|fourteen|thirty)\\s+(business days?|days?|hours?|weeks?)\\b`, 'i'), m => {
      const words = { one: 1, two: 2, three: 3, five: 5, seven: 7, ten: 10, fourteen: 14, thirty: 30 };
      const n = Number(m[1]) || words[m[1].toLowerCase()];
      const unit = /hour/i.test(m[2]) ? 3_600_000 : /week/i.test(m[2]) ? 7 * 86_400_000 : /business/i.test(m[2]) ? 1.4 * 86_400_000 : 86_400_000;
      return sentAt + n * unit;
    }],
  ];
  const found = patterns.map(([pattern, toMs]) => { const m = body.match(pattern); return m ? { index: m.index, ms: toMs(m) } : null; })
    .filter(hit => hit?.ms);
  return found.length ? found.reduce((a, b) => (b.index < a.index ? b : a)).ms : null;
}

const LINK_NOISE = /unsubscribe|marketing|newsletter|preferences|opt.?out|privacy|help ?center|terms|facebook|linkedin|twitter|instagram|youtube|glassdoor|^mailto:|^tel:/i;
const LINK_WORDS = {
  assessment: /assessment|get started|begin|start|take|hackerrank|codesignal|hirevue|codility|pymetrics|karat|test|challenge/i,
  interview: /schedul|book|availability|calendly|select a time|pick a time|goodtime|interview|confirm/i,
  incomplete: /complete|continue|finish|log ?in|sign ?in|career (center|site)|click here|application/i,
  offer: /offer|accept|review|sign|view/i,
};
// The link that performs a message's action: the anchor whose text, surrounding words or URL best fit the kind,
// ignoring social, legal and unsubscribe links. Null when nothing fits.
export function actionLink(links, kind) {
  const words = LINK_WORDS[kind];
  if (!words) return null;
  let best = null;
  for (const link of links ?? []) {
    if (!/^https?:/i.test(link.href) || LINK_NOISE.test(link.href)) continue;
    const score = (words.test(link.context) ? 2 : 0) + (words.test(link.href) ? 1 : 0);
    if (score && (!best || score > best.score)) best = { href: link.href, score };
  }
  return best?.href ?? null;
}
