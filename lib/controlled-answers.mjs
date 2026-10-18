// Answers whose value is determined by applicant facts, never by a model. The work-authorization policy wraps these
// helpers so every existing picker/fill/guard call site uses the same expectation → option/match contract.
import { normalize } from './answers.mjs';

const DECLINE = /\b(?:prefer not|decline|do not wish|don t wish|choose not|do not want|don t want|do not disclose)\b/;
const GENERIC_LABEL = /^(?:select|choose|please select|please choose|required|select one|choose one|select one required|choose one required|select an option|choose an option)(?: required)?$/;

const fact = (values, name) => String(values?.get?.(`facts.${name}`) ?? '').trim();
const aliases = (values, name) => [fact(values, name), ...[...values?.entries?.() ?? []]
  .filter(([key]) => key.startsWith(`facts.${name}.alias_`)).map(([, value]) => String(value))].filter(Boolean);

function semanticText(question, key) {
  const label = normalize(question);
  if (!GENERIC_LABEL.test(label)) return label;
  return `${label} ${normalize(String(key ?? '').replace(/^(?:qa|facts)\./, '').replace(/[_.]+/g, ' '))}`.trim();
}

function amount(number, k) {
  const value = Number(String(number).replace(/,/g, '')) * (k ? 1000 : 1);
  return Number.isFinite(value) ? value : null;
}

// Numeric ranges in both stored facts and site options. A single number is exact unless the words around it make it
// an open band ("up to", "or more"). "3.0 out of 4.0" is an exact GPA, not a range from 3.0 to 4.0.
function bandOf(input, { ratio = false } = {}) {
  let text = String(input ?? '').trim().replace(/^\s*\d{1,2}[.)]\s+/, '').replace(/[–—]/g, '-');
  text = text.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
  const amounts = [...text.matchAll(/\$?\s*(\d+(?:\.\d+)?)\s*(k\b)?/gi)]
    .map(match => amount(match[1], match[2])).filter(value => value !== null);
  if (!amounts.length) return null;
  const normalized = normalize(text);
  if (ratio && amounts.length === 2 && !/\b(?:between|from|to)\b|[-+]\s*/.test(text) && /\bout of\b|\//.test(text)) {
    return { low: amounts[0], high: amounts[0], lowInclusive: true, highInclusive: true };
  }
  if (amounts.length >= 2) {
    return { low: Math.min(amounts[0], amounts[1]), high: Math.max(amounts[0], amounts[1]), lowInclusive: true, highInclusive: true };
  }
  const value = amounts[0];
  if (/\b(?:up to|or under|or less|at most|maximum|max|less than|below|under)\b|^[<≤]/.test(normalized)) {
    return { low: -Infinity, high: value, lowInclusive: true, highInclusive: !/\b(?:less than|below|under)\b|^[<]/.test(normalized) || /\bor under|or less|up to|at most/.test(normalized) };
  }
  if (/\b(?:or more|and above|or above|at least|minimum|min|above)\b|\+\s*$|^[>≥]/.test(normalized)) {
    return { low: value, high: Infinity, lowInclusive: !/\b(?:above)\b|^[>]/.test(normalized) || /\bor more|and above|or above|at least/.test(normalized) };
  }
  return { low: value, high: value, lowInclusive: true, highInclusive: true };
}

const contains = (band, value) => band
  && (band.low < value || (band.lowInclusive && band.low === value))
  && (value < band.high || (band.highInclusive && band.high === value));
const below = (band, floor) => !band || band.high < floor || (band.high === floor && !band.highInclusive);

function salaryUnit(text) {
  const value = normalize(text);
  if (/\b(?:per hour|hourly|an hour|each hour|hr|hour|hrly)\b/.test(value)) return 'hourly';
  if (/\b(?:annual|annualized|annually|per year|yearly|a year)\b/.test(value)) return 'annual';
  return null;
}

function payFacts(values, key, existing) {
  const stored = fact(values, 'pay_expectation') || (/^facts\.pay_expectation\b/.test(key) ? String(existing ?? '') : '');
  const result = {};
  const pattern = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?(?:\s*(?:-|–|—|to)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?)?/gi;
  for (const match of stored.matchAll(pattern)) {
    const unit = salaryUnit(stored.slice(match.index + match[0].length, match.index + match[0].length + 24));
    if (!unit || result[unit]) continue;
    const low = amount(match[1], match[2]);
    const high = match[3] ? amount(match[3], match[4]) : low;
    if (low === null || high === null) continue;
    const range = match[0].trim().replace(/\s+/g, ' ');
    result[unit] = { floor: Math.min(low, high), answer: `${range} ${unit === 'hourly' ? 'per hour' : 'per year'}` };
  }
  return result;
}

function salaryExpectation(text, values, key, existing, options) {
  if (!/\b(?:salary|compensation|wages?|pay|rate)\b/.test(text)
    || !/\b(?:expect(?:ed|ing|ations?)?|desired|target(?:ed)?|seek(?:ing)?|require(?:d|ment)?|range|minimum|base|cash)\b/.test(text)
    || /\b(?:negotiable|currency|previous|past|history|severance|repayment|paying attention|agree or disagree)\b/.test(text)
    || (/\bcurrent\b/.test(text) && !/\b(?:expect(?:ed|ing|ations?)?|desired|target(?:ed)?|seek(?:ing)?|require(?:d|ment)?)\b/.test(text))) return null;
  const unit = salaryUnit(text) || salaryUnit(options.join(' ')) || 'annual';
  const stored = payFacts(values, key, existing)[unit];
  return { family: 'salary', kind: 'salary', unit, floor: stored?.floor ?? null, answer: stored?.answer ?? null };
}

function gpaExpectation(text, values, key, existing, options) {
  if (!/\b(?:gpa|grade point average)\b/.test(text)
    || /\b(?:grading system|grading scale|high school|major gpa)\b/.test(text)
    || (/\b(?:graduate|doctorate|masters|phd)\b/.test(text) && !/\bundergraduate\b/.test(text))) return null;
  const raw = fact(values, 'gpa') || (/^facts\.gpa\b/.test(key) ? String(existing ?? '') : '');
  const match = raw.match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/);
  const gpa = match ? Number(match[1]) : null;
  const scale = match?.[2] ? Number(match[2]) : Number(fact(values, 'gpa_scale') || 4);
  const percent = /\b(?:percent|percentage)\b|%/.test(`${text} ${options.join(' ')}`);
  const target = percent && gpa !== null && scale > 0 ? Math.round((gpa / scale) * 1000) / 10 : gpa;
  return { family: 'gpa', kind: 'gpa', percent, target, answer: target === null ? null : percent ? `${target}%` : String(target) };
}

function nameKind(question) {
  const text = normalize(question);
  if (!text || /\b(?:user name|username|login|employer|school|company|referr|publication|job board|pronounce|business|project|file|document|position|role|other names|former name|previous name|name used)\b/.test(text)) return null;
  if (/\bpreferred\b/.test(text) && /\bfirst name\b/.test(text)) return 'preferred_first';
  if (/\bpreferred\b/.test(text) && /\blast name\b/.test(text)) return 'preferred_last';
  if (/\bpreferred\b/.test(text) && /\bfull name\b/.test(text)) return 'preferred_full';
  if (/\b(?:prefer|chosen|goes by|known as|nickname|call you)\b/.test(text) && /\bname\b/.test(text) && !/\bfull name\b/.test(text)) return 'preferred_first';
  if (/\blegal\b/.test(text) && (/\bfirst (?:and|&) last name\b/.test(text) || /\bfirst name\b[\s\S]*\blast name\b/.test(text))) return 'legal_full';
  if (/\blegal\b/.test(text) && /\bfirst name\b/.test(text)) return 'legal_first';
  if (/\blegal\b/.test(text) && /\blast name\b/.test(text)) return 'legal_last';
  if (/\blegal\b/.test(text) && /\bmiddle name\b/.test(text)) return 'legal_middle';
  if (/\bfirst (?:and|&) last name\b/.test(text) || /\bfull legal name\b/.test(text) || (/\blegal\b/.test(text) && /\b(?:full name|legal name)\b/.test(text))) return 'legal_full';
  if (/\bmiddle name\b/.test(text)) return 'middle';
  if (/\bfull name\b/.test(text) || /^(?:your )?name(?: required)?$/.test(text)) return 'legal_full';
  if (/\bfirst name\b/.test(text)) return 'first';
  if (/\blast name\b/.test(text)) return 'last';
  if (/\bpreferred name\b/.test(text)) return 'preferred_first';
  if (/\blegal name\b/.test(text)) return 'legal_full';
  return null;
}

export function isControlledNameQuestion(question) {
  return Boolean(nameKind(question));
}

function nameAnswer(kind, values) {
  const first = kind === 'legal_first' || kind === 'legal_full' ? fact(values, 'legal_first_name') : fact(values, 'preferred_first_name') || fact(values, 'first_name');
  const last = kind === 'legal_last' || kind === 'legal_full' ? fact(values, 'legal_last_name') : fact(values, 'preferred_last_name') || fact(values, 'last_name') || fact(values, 'legal_last_name');
  if (kind === 'legal_first') return fact(values, 'legal_first_name');
  if (kind === 'legal_last') return fact(values, 'legal_last_name');
  if (kind === 'preferred_first') return fact(values, 'preferred_first_name') || fact(values, 'first_name');
  if (kind === 'preferred_last') return fact(values, 'preferred_last_name') || fact(values, 'last_name') || fact(values, 'legal_last_name');
  if (kind === 'legal_middle') return fact(values, 'legal_middle_name') || fact(values, 'middle_name');
  if (kind === 'middle') return fact(values, 'middle_name') || fact(values, 'legal_middle_name');
  if (kind === 'first') return fact(values, 'first_name') || fact(values, 'preferred_first_name');
  if (kind === 'last') return fact(values, 'last_name') || fact(values, 'legal_last_name');
  if (kind === 'preferred_full') return fact(values, 'preferred_full_name') || [first, last].filter(Boolean).join(' ');
  if (kind === 'legal_full') {
    const middle = fact(values, 'legal_middle_name') || fact(values, 'middle_name');
    return fact(values, 'legal_full_name') || [first, middle, last].filter(Boolean).join(' ');
  }
  return '';
}

function eeoExpectation(text, values, options = []) {
  const optionText = normalize(options.join(' '));
  let kind;
  let factName;
  if (/\b(?:veteran|military service|military status|armed forces|served in the military)\b/.test(text)
    || /\b(?:protected veteran|active duty|reservist|disabled veteran|recently separated)\b/.test(optionText)) {
    kind = 'veteran';
    factName = /\b(?:military service|armed forces|served)\b/.test(text) && !/\bveteran\b/.test(text) ? 'military_service' : 'veteran_status';
  } else if (/\b(?:disability|disabled)\b/.test(text)) {
    kind = 'disability';
    factName = 'disability';
  } else if (/\b(?:race|ethnicity|hispanic|latino)\b/.test(text)
    || /\b(?:asian|white|black|african american|hispanic|latino|native american|pacific islander|two or more races)\b/.test(optionText)) {
    kind = 'eeo';
    factName = 'race_ethnicity';
  } else if (/\bgender\b/.test(text) || /\b(?:male|female|nonbinary|non binary|man|woman)\b/.test(optionText)) {
    kind = 'eeo';
    factName = 'gender';
  } else return null;
  return { family: kind, kind: factName, answer: fact(values, factName) || null, detail: fact(values, 'race_detail'), aliases: aliases(values, factName) };
}

function majorExpectation(text, values) {
  if (!/\bmajor\b/.test(text) || !/\b(?:pursuing|majoring|declared)\b/.test(text)
    || !/\b(?:one of|following disciplines|listed disciplines)\b/.test(text)
    || /\b(?:related|similar) fields?\b/.test(text)) return null;
  const major = fact(values, 'major');
  if (!major) return { family: 'major', kind: 'major', answer: null };
  return { family: 'major', kind: 'major', answer: text.includes(normalize(major)) ? 'Yes' : 'No' };
}

function citizenshipExpectation(text, values) {
  if (!/\b(?:citizen|citizenship|nationality|national of)\b/.test(text)
    || /\b(?:authorized|authorised|eligible|permitted|right to work|sponsor|visa)\b/.test(text)) return null;
  const stored = fact(values, 'us_citizen');
  if (!stored) return null;
  const citizen = /^(?:yes|true|y)\b/i.test(stored) || /\b(?:u\.?s\.?|united states)\b/i.test(stored);
  const canonical = citizen ? 'Yes' : 'No';
  return { family: 'eeo', kind: 'citizenship', answer: canonical, detail: fact(values, 'country'), aliases: aliases(values, 'us_citizen') };
}

export function controlledExpectation(question, values, key = '', existing = '', options = []) {
  if (!values) return null;
  const text = semanticText(question, key);
  const kind = nameKind(question);
  if (kind) return { family: 'name', kind, answer: nameAnswer(kind, values) || null };
  return citizenshipExpectation(text, values)
    ?? salaryExpectation(text, values, key, existing, options)
    ?? gpaExpectation(text, values, key, existing, options)
    ?? eeoExpectation(text, values, GENERIC_LABEL.test(normalize(question)) ? options : [])
    ?? majorExpectation(text, values);
}

function eeoMatches(expectation, value) {
  const text = normalize(value);
  if (!text) return null;
  if (DECLINE.test(text)) return true;
  const canonical = normalize(expectation.answer);
  if (expectation.kind === 'citizenship') {
    const us = /\b(?:u\.?s\.?|united states)\b/.test(text) && /\b(?:citizen|national)\b/.test(text);
    if (/^yes\b/.test(canonical)) return /^yes\b/.test(text) || us;
    if (/^no\b/.test(canonical)) return /^no\b/.test(text) && !us;
  }
  if (expectation.kind === 'veteran_status' || expectation.kind === 'military_service') {
    if (/\b(?:identify as a veteran|am a veteran|other protected veteran|active duty|reservist|armed forces)\b/.test(text)) return false;
    if (/\b(?:not a protected veteran|not a veteran|do not identify as a veteran|never served|no military service)\b|^(?:no|non veteran)$/.test(text)) return true;
    if (/\b(?:protected veteran|yes)\b/.test(text)) return false;
  }
  if (expectation.kind === 'disability') {
    if (/\bno\b[^.]{0,40}\bdisability\b|\bdo not have\b[^.]{0,30}\bdisability\b|\bdon t have\b[^.]{0,30}\bdisability\b|^no$/.test(text)) return true;
    if (/\b(?:yes|i have a disability|disabled)\b/.test(text)) return false;
  }
  if (expectation.aliases?.some(alias => normalize(alias) === text)) return true;
  if (expectation.kind === 'race_ethnicity' && text.length >= 3 && !/\b(?:select|choose|other|unknown)\b/.test(text)) {
    if (/\b(?:hispanic|latino)\b/.test(text) && /\bnot hispanic\b/.test(canonical) && !/\bnot\b/.test(text)) return false;
    const acceptable = [canonical, normalize(expectation.detail), ...(expectation.aliases ?? []).map(normalize)];
    if (acceptable.some(alias => ` ${alias} `.includes(` ${text} `))) return true;
  }
  return canonical && (canonical === text || (text.length >= 4 && ` ${canonical} `.includes(` ${text} `))) ? true : false;
}

export function controlledAnswerMatches(expectation, value) {
  if (!expectation) return null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (expectation.family === 'salary') {
    if (expectation.floor === null) return null;
    const unit = salaryUnit(text);
    if (unit && unit !== expectation.unit) return false;
    const band = bandOf(text);
    return band ? !below(band, expectation.floor) : null;
  }
  if (expectation.family === 'gpa') {
    if (expectation.target === null) return null;
    const band = bandOf(text, { ratio: true });
    return band ? contains(band, expectation.target) : null;
  }
  if (expectation.family === 'name') {
    return expectation.answer !== null && normalize(text) === normalize(expectation.answer);
  }
  if (['veteran', 'disability', 'eeo'].includes(expectation.family)) return eeoMatches(expectation, text);
  if (expectation.family === 'major') {
    if (/^yes\b/.test(normalize(text))) return expectation.answer === 'Yes';
    if (/^no\b/.test(normalize(text))) return expectation.answer === 'No';
    return null;
  }
  return null;
}

export function controlledOption(expectation, options) {
  if (!expectation || expectation.answer === null) return null;
  const listed = options.map(String).filter(option => option.trim() && !/^(?:select|choose|please select|please choose|--)/i.test(option.trim()));
  if (expectation.family === 'salary') {
    const bands = listed.map(option => ({ option, band: bandOf(option), unit: salaryUnit(option) }))
      .filter(item => item.band && (!item.unit || item.unit === expectation.unit));
    const containing = bands.filter(item => contains(item.band, expectation.floor))
      .sort((a, b) => b.band.low - a.band.low || a.band.high - b.band.high || a.option.localeCompare(b.option));
    if (containing.length) return containing[0].option;
    return bands.filter(item => !below(item.band, expectation.floor) && item.band.low >= expectation.floor)
      .sort((a, b) => a.band.low - b.band.low || a.band.high - b.band.high || a.option.localeCompare(b.option))[0]?.option ?? null;
  }
  if (expectation.family === 'gpa') {
    return listed.map(option => ({ option, band: bandOf(option, { ratio: true }) }))
      .filter(item => contains(item.band, expectation.target))
      .sort((a, b) => (a.band.high - a.band.low) - (b.band.high - b.band.low) || a.option.localeCompare(b.option))[0]?.option ?? null;
  }
  if (expectation.family === 'name') {
    return listed.find(option => normalize(option) === normalize(expectation.answer)) ?? null;
  }
  if (['veteran', 'disability', 'eeo'].includes(expectation.family)) {
    const match = listed.filter(option => !DECLINE.test(normalize(option)) && eeoMatches(expectation, option) === true)
      .sort((a, b) => {
        const score = option => (normalize(option) === normalize(expectation.answer) ? 20 : 0)
          + (new RegExp(`\\b${expectation.kind === 'race_ethnicity' ? 'asian|hispanic|latino' : expectation.kind === 'disability' ? 'disability' : 'veteran'}\\b`).test(normalize(option)) ? 5 : 0);
        return score(b) - score(a) || a.localeCompare(b);
      })[0];
    return match ?? listed.find(option => DECLINE.test(normalize(option))) ?? null;
  }
  if (expectation.family === 'major') return listed.find(option => controlledAnswerMatches(expectation, option) === true) ?? null;
  return null;
}
