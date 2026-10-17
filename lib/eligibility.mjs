// Deterministic degree, class-year, and work-schedule eligibility for posting titles and descriptions.

const normalize = value => String(value ?? '')
  .replace(/[‘’]/g, `'`)
  .replace(/ph\.d\.?/gi, 'PhD')
  .replace(/m\.s\.?/gi, 'MS')
  .replace(/b\.s\.?/gi, 'BS')
  .replace(/[\t ]+/g, ' ');

const GRADUATE = String.raw`(?:master'?s?|ms|phd|mba|graduate|doctoral)`;
const BACHELOR = String.raw`(?:bachelor'?s?|bs|undergraduate)`;

// Program-audience titles: "Quantitative Masters Internship", "PhD Intern", "MBA Summer Associate".
// "Master" must name a degree (Master's/degree/program/intern/student/...): "Master Data Intern" is a data role.
const TITLE_GRADUATE = /\b(?:master'?s?\s+(?:degree|program|intern(?:ship)?|candidate|student|summer|associate|of|in)\b|mba\b|phd\b|doctoral\b|graduate\s+(?:student|intern(?:ship)?|program)\b)/i;
// Current or required graduate enrollment, including "candidates must be pursuing an MS".
const GRADUATE_ENROLLMENT = new RegExp(String.raw`\b(?:currently\s+)?(?:enrolled\s+in|pursuing)\s+(?:an?\s+)?${GRADUATE}\b`, 'i');
// Explicit degree requirements, including "must be enrolled" variants captured by the rule above.
const GRADUATE_REQUIRED = new RegExp(String.raw`\b${GRADUATE}(?:\s+degree)?\s+(?:is\s+|are\s+)?required\b`, 'i');
// "Requires a master's/PhD/MBA" is equivalent to "a master's/PhD/MBA is required". The ambiguous "MS" alone
// usually means Microsoft Office in prose ("requires MS Excel skills"), so it must name a degree here.
const REQUIRES_GRADUATE = new RegExp(String.raw`\brequires?\s+(?:an?\s+)?(?:master'?s?|phd|mba|doctoral|graduate|ms\s+(?:degree|program)|ms\s+in\b)`, 'i');
// Explicitly restricted graduate-student audiences.
const GRADUATE_ONLY = new RegExp(String.raw`\b${GRADUATE}\s+(?:students?|candidates?)\s+only\b`, 'i');
// Program-stage wording such as "rising second-year MBA".
const RISING_GRADUATE = /\brising\s+(?:second[- ]year\s+)?(mba|master'?s?)\b/i;
// A graduate degree named only as preferred is soft, never a hard rejection.
const GRADUATE_PREFERRED = new RegExp(String.raw`\b${GRADUATE}(?:\s+degree)?\s+(?:is\s+)?preferred\b`, 'i');
const PREFERRED_GRADUATE = new RegExp(String.raw`\bpreferred\s*:\s*${GRADUATE}\b`, 'i');

// Programs for high-school students are hard-disqualified even though they name no college degree.
// "graduated from high school" is an ordinary requirement, not a program audience, and must not match.
const HIGH_SCHOOL_AUDIENCE = /\b(?:high[- ]school\s+(?:intern(?:ship)?s?|students?|seniors?|programs?|candidates?|graduates?)|(?:for|rising)\s+high[- ]school|pre[- ]college)\b/i;
// A bare "high-school" in the title still marks the audience ("AI Prompt Engineer High-School Intern").
const HIGH_SCHOOL_TITLE = /\b(?:high[- ]school|pre[- ]college)\b/i;

// Explicit BS/bachelor/undergraduate alternatives make an otherwise graduate-looking posting eligible.
const BACHELOR_FIRST = new RegExp(String.raw`\b${BACHELOR}(?:\s+degree)?\s*(?:,|/|\bor\b)\s*(?:an?\s+)?${GRADUATE}\b`, 'i');
const GRADUATE_FIRST = new RegExp(String.raw`\b${GRADUATE}(?:\s+degree)?\s*(?:,|/|\bor\b)\s*(?:an?\s+)?${BACHELOR}\b`, 'i');
// Direct undergraduate enrollment is also an explicit bachelor's track.
const BACHELOR_TRACK = /\b(?:current(?:ly)?\s+)?(?:enrollment\s+in|enrolled\s+in|pursuing|working\s+towards)\s+(?:an?\s+)?(?:bachelor'?s?|undergraduate)(?:\s+degree)?\b/i;
// "graduate and undergraduate studies/students" accepts both audiences.
const DEGREE_PAIR = /\b(?:graduate|master'?s?|phd|mba)\s+(?:and|or)\s+(?:undergraduate|bachelor'?s?)\s+(?:studies|students?|programs?|candidates?)\b|\b(?:undergraduate|bachelor'?s?)\s+(?:and|or)\s+(?:graduate|master'?s?|phd|mba)\s+(?:studies|students?|programs?|candidates?)\b/i;

// "undergraduate ... or be enrolled in a graduate/master's program" is an explicit either-audience statement.
const BACHELOR_OR_GRADUATE = new RegExp(String.raw`\b${BACHELOR}\b[^.;!?]{0,80}?\bor\s+(?:be\s+)?(?:enrolled|pursuing|currently\s+enrolled|working\s+towards|completing)\s+(?:in\s+)?(?:an?\s+)?${GRADUATE}\b`, 'i');

// Explicit class-year restrictions only; no inference from undated or merely class-year-themed postings.
const CLASS_ONLY = /\b(?:rising\s+)?(?:seniors?|juniors?)\s+only\b/i;
// "completed at least three years of an undergraduate program (i.e., a rising senior)" excludes a sophomore.
const UNDERGRAD_YEARS = /\b(?:completed?|completing)\s+(?:at\s+least\s+)?(?:three|3)\s+years?\b[^.!?]{0,80}\bundergraduate\b|\bundergraduate\b[^.!?]{0,80}\b(?:completed?|completing)\s+(?:at\s+least\s+)?(?:three|3)\s+years?\b/i;
const GRADUATING = /\bgraduating\s+(?:in|by)\s+(?:december\s+2026|spring\s+2027|may\s+2027|2027|2028)\b/i;
const GRADUATE_WINDOW = /\bmust\s+graduate\s+(?:between|by)\b[^.!?]{0,120}?\b(?:2027|2028)\b/i;

function levelOf(text) {
  if (/\b(mba)\b/i.test(text)) return 'mba';
  if (/\b(phd|doctoral)\b/i.test(text)) return 'phd';
  if (/\b(master'?s?|ms|graduate)\b/i.test(text)) return 'master';
  return 'bachelor';
}

function evidenceOf(sentence, index = 0) {
  const text = sentence.replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  const start = Math.max(0, Math.min(index - 60, text.length - 158));
  let evidence = text.slice(start, start + 158).trim();
  if (start > 0) evidence = `…${evidence}`;
  if (start + 158 < text.length) evidence += '…';
  return evidence.slice(0, 160);
}

function result(level, sentence, match, hard) {
  return { level, evidence: evidenceOf(sentence, match?.index ?? 0), hard };
}

function bachelorIncluded(sentence) {
  return BACHELOR_FIRST.exec(sentence) || GRADUATE_FIRST.exec(sentence) || BACHELOR_TRACK.exec(sentence)
    || DEGREE_PAIR.exec(sentence) || BACHELOR_OR_GRADUATE.exec(sentence);
}

// A graduate mention is soft when the sentence introduces it as preferred ("Preferred Qualifications: ..." or
// "... are preferred") rather than required. A narrower preferred degree ("enrolled in a graduate program, PhD
// preferred") keeps the broader requirement hard.
function preferredContext(sentence, match) {
  if (/^\s*preferred(?:\s+[a-z]+){0,4}\s*:\s*/i.test(sentence.slice(0, match.index))) return true;
  const tail = sentence.slice(match.index + match[0].length).match(/^[^:;.!?]{0,80}\bpreferred\b/i);
  if (!tail) return false;
  const preferredDegree = tail[0].match(/\b(phd|doctoral|master'?s?|mba|graduate|ms)\b/i)?.[0];
  return !preferredDegree || levelOf(preferredDegree) === levelOf(match[0]);
}
// "graduating in 2028 or beyond" includes the applicant's 2029 window.
const openEndedWindow = sentence => /\b(?:or|and)\s+(?:later|beyond|after|sooner)\b/i.test(sentence);

export function degreeRequirement(text) {
  const normalized = normalize(text);
  const sentences = normalized.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(Boolean);
  if (!sentences.length) return { level: null, evidence: '', hard: false };

  for (const [index, sentence] of sentences.entries()) {
    const match = HIGH_SCHOOL_AUDIENCE.exec(sentence) || (index === 0 ? HIGH_SCHOOL_TITLE.exec(sentence) : null);
    if (match) return result('high-school', sentence, match, true);
  }

  // A bachelor's alternative anywhere in the posting can qualify a graduate-looking program title.
  let allowed = null;
  for (const sentence of sentences) {
    const match = bachelorIncluded(sentence);
    if (match && !allowed) allowed = result('bachelor', sentence, match, false);
  }

  if (!allowed) {
    const match = TITLE_GRADUATE.exec(sentences[0]);
    if (match) return result(levelOf(match[0]), sentences[0], match, true);
  }

  let preferred = null;
  const includes2029 = /\b2029\b/.test(normalized);
  const bachelorTrack = sentences.some(sentence => BACHELOR_TRACK.test(sentence));
  for (const sentence of sentences) {
    // Explicit class-year exclusions remain authoritative even on a bachelor's-inclusive posting.
    let match = CLASS_ONLY.exec(sentence) || UNDERGRAD_YEARS.exec(sentence);
    if (match) return result('bachelor', sentence, match, true);
    if (!includes2029 && !openEndedWindow(sentence)) {
      match = GRADUATING.exec(sentence) || GRADUATE_WINDOW.exec(sentence);
      if (match) return result('bachelor', sentence, match, true);
    }

    // Do not turn the graduate half of "BS or MS" / "bachelor's or master's" into a hard requirement.
    if (bachelorIncluded(sentence)) continue;
    for (const rule of [GRADUATE_ENROLLMENT, GRADUATE_REQUIRED, REQUIRES_GRADUATE, GRADUATE_ONLY, RISING_GRADUATE]) {
      match = rule.exec(sentence);
      if (!match) continue;
      if (preferredContext(sentence, match) || (rule === GRADUATE_ENROLLMENT && bachelorTrack)) {
        if (!preferred) preferred = result(levelOf(match[0]), sentence, match, false);
        continue;
      }
      return result(levelOf(match[0]), sentence, match, true);
    }
    match = GRADUATE_PREFERRED.exec(sentence) || PREFERRED_GRADUATE.exec(sentence);
    if (match && !preferred) preferred = result(levelOf(match[0]), sentence, match, false);
  }
  return allowed ?? preferred ?? { level: null, evidence: '', hard: false };
}

// A work schedule can disqualify an internship even when its degree audience is right: year-round roles, roles
// required during the academic year or a fall/spring/winter term, and school-year part-time commitments. A summer
// posting stays eligible, as does an academic-year piece that is explicitly remote/virtual or a summer-only track.
// "Optional" and extension language is never treated as a requirement.
const SCHEDULE_PROGRAM = /\b(?:intern(?:ship)?s?|co-?ops?|cooperative\s+education)\b/i;
const SCHEDULE_TERM = String.raw`(?:fall|autumn|spring|winter)`;
const YEAR_ROUND = /\byear[\s\-–—]round\b/i;
const OPTIONAL_YEAR_ROUND = new RegExp(String.raw`\byear[\s\-–—]round\b[^.!?]{0,40}\b(?:optional|option|opportunity)\b|\b(?:optional|option|opportunity)\b[^.!?]{0,40}\byear[\s\-–—]round\b`, 'i');
const ACADEMIC_YEAR_WORK = new RegExp(String.raw`\b(?:academic|school)[\s\-–—]year\s+(?:part[\s-]time\s+)?(?:intern(?:ship)?|co-?op|work|role|position|program)\b|\b(?:intern(?:ship)?|co-?op|role|position|program)\b[^.!?]{0,25}\b(?:runs|works?|working|takes\s+place|commitment|schedule)\b[^.!?]{0,20}\b(?:during|throughout|for)\s+(?:the\s+)?(?:academic|school)[\s\-–—]year\b|\b(?:work|working|part[\s-]time\s+work)\s+(?:during|throughout)\s+(?:the\s+)?(?:academic|school)[\s\-–—]year\b`, 'i');
const PART_TIME_ACADEMIC = new RegExp(String.raw`\bpart[\s-]time\b[^.!?]{0,60}\b(?:during|throughout|for|in|into)\s+(?:the\s+)?(?:school[\s\-–—]year|academic[\s\-–—]year|semester|(?:fall|autumn|spring|winter)\s+semester)\b|\b(?:during|throughout|for|in|into)\s+(?:the\s+)?(?:school[\s\-–—]year|academic[\s\-–—]year|semester|(?:fall|autumn|spring|winter)\s+semester)\b[^.!?]{0,60}\bpart[\s-]time\b|\bpart[\s-]time\s+(?:(?:fall|autumn|spring|winter)\s+)?semester\b[^.!?]{0,30}\b(?:intern(?:ship)?|co-?op|role|position)\b`, 'i');
const TERM_PROGRAM = new RegExp(String.raw`\b${SCHEDULE_TERM}(?:\s+\d{4})?\s+(?:intern(?:ship)?|co-?op)\b|\b\d{4}\s+${SCHEDULE_TERM}\s+(?:intern(?:ship)?|co-?op)\b|\b(?:intern(?:ship)?|co-?op)\s*(?:[-–—|:,(]\s*)+${SCHEDULE_TERM}(?:\s+\d{4})?\b|\b${SCHEDULE_TERM}[\s-]+only\s+(?:intern(?:ship)?|co-?op)\b`, 'i');
const TERM_LABELED = new RegExp(String.raw`\b(?:timeframe|time\s+frame|program\s+dates?|intern(?:ship)?\s+dates?|co-?op\s+dates?|term|duration)\s*:\s*${SCHEDULE_TERM}\b`, 'i');
const TERM_ACTIVE = new RegExp(String.raw`\b(?:intern(?:ship)?|co-?op)\b[^.!?]{0,50}\b(?:runs|starts?|begins?|is\s+scheduled|takes\s+place)\b[^.!?]{0,30}\b${SCHEDULE_TERM}\b`, 'i');
const MONTH_NAME = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const MONTH_RANGE = new RegExp(String.raw`\b${MONTH_NAME}(?:\s+\d{4})?\s*(?:[-–—]|\bto\b)\s*${MONTH_NAME}(?:\s+\d{4})?\b`, 'gi');
const SCHEDULE_DATES = /\b(?:timeframe|time\s+frame|program\s+dates?|intern(?:ship)?\s+dates?|co-?op\s+dates?|term|duration)\s*:/i;
const SUMMER_TRACK = /\bsummer[\s-]only\b|\bsummer\s+(?:track|option|session)\b|\b(?:track|option|session)\s+(?:for|in)\s+summer\b|\b(?:summer\s+(?:or|and)\s+year[\s-]round|year[\s-]round\s+(?:or|and)\s+summer)\b/i;
const SUMMER_TRACK_NEGATED = /\b(?:no|not|never|without)\b[^.!?]{0,30}\bsummer[\s-](?:only|track|option|session)\b|\bsummer[\s-](?:only|track|option|session)\b[^.!?]{0,30}\b(?:not\s+available|unavailable|isn't|is\s+not)\b/i;
const REMOTE_ACADEMIC = new RegExp(String.raw`\b(?:remote|virtual)\s+(?:year[\s-]round|academic[\s-]year|school[\s-]year)\b|\b(?:year[\s-]round|academic[\s-]year|school[\s-]year)\b[^.!?]{0,40}\b(?:remote|virtual)\b|\b(?:remote|virtual)\b[^.!?]{0,30}\b(?:during|for|throughout)\s+(?:the\s+)?(?:academic[\s-]year|school[\s-]year|${SCHEDULE_TERM}\s+(?:semester|term))\b`, 'i');
const REMOTE_NEGATED = /\b(?:not|never|no)\b(?:\s+\w+){0,2}\s+(?:remote|virtual)\b|\b(?:remote|virtual)\s+(?:work\s+)?(?:is\s+)?(?:not\s+(?:available|offered)|unavailable)\b|\bremote\s+type\s*:?\s*(?:hybrid|on-?site)\b|\bon[\s-]site\s+only\b/i;
const REMOTE_AVAILABLE = /\b(?:virtual|remote)\s*\/\s*(?:virtual|remote)\b|\b(?:remote|virtual)\b[^.!?]{0,20}(?:,|\/|\bor\b)\s*(?:on-?site|hybrid)\b|\b(?:on-?site|hybrid)\b[^.!?]{0,20}(?:,|\/|\bor\b)\s*(?:remote|virtual)\b/i;
const NON_WORK_RANGE = /\b(?:applications?|apply|applying|deadline|recruit(?:ing|ment)?|interviews?|hiring|posted|graduat(?:ion|ing)?|degree|education|enrolled|expected)\b/i;
const OPTIONAL_ACADEMIC_EXTENSION = /\b(?:opportunity|option|possibility|potential)\s+(?:to|for)\s+(?:extend|continue|work)|\b(?:may|might|can|could|eligible)\b[^.!?]{0,30}\b(?:extend|continue|work|part[\s-]time)\b|\b(?:extend|continue)\b[^.!?]{0,40}\b(?:optional|option|opportunity)\b/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIndex = name => MONTHS.indexOf(name.slice(0, 3).toLowerCase());
const nonWorkRange = (sentence, match) => NON_WORK_RANGE.test(
  `${sentence.slice(Math.max(0, match.index - 80), match.index)} ${sentence.slice(match.index + match[0].length, match.index + match[0].length + 50)}`,
);
// A range wholly inside May–September is a summer range, even when an eight-month co-op crosses into September.
// Any other range touches the academic year or a fall/spring/winter term.
const summerRange = match => {
  const start = monthIndex(match[1]);
  const end = monthIndex(match[2]);
  return start >= 4 && start <= 6 && end >= 4 && end <= 8 && end >= start;
};

export function scheduleRequirement(text) {
  const normalized = normalize(text).replace(/\s*\n+\s*/g, ' ');
  const sentences = normalized.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  if (!sentences.length) return { level: null, evidence: '', hard: false };

  const summerTrack = sentences.some(sentence => SUMMER_TRACK.test(sentence) && !SUMMER_TRACK_NEGATED.test(sentence));
  const remoteAcademic = sentences.some(sentence => (REMOTE_ACADEMIC.test(sentence) || REMOTE_AVAILABLE.test(sentence)) && !REMOTE_NEGATED.test(sentence));
  if (summerTrack || remoteAcademic) return { level: null, evidence: '', hard: false };

  for (const sentence of sentences) {
    let match = YEAR_ROUND.exec(sentence);
    if (match && !OPTIONAL_YEAR_ROUND.test(sentence)) return result('year-round', sentence, match, true);

    match = ACADEMIC_YEAR_WORK.exec(sentence);
    if (match) return result('academic-year', sentence, match, true);

    match = PART_TIME_ACADEMIC.exec(sentence);
    if (match && !OPTIONAL_ACADEMIC_EXTENSION.test(sentence)) return result('academic-year', sentence, match, true);

    for (const rule of [TERM_PROGRAM, TERM_LABELED, TERM_ACTIVE]) {
      match = rule.exec(sentence);
      if (match) return result('term', sentence, match, true);
    }

    const ranges = [...sentence.matchAll(MONTH_RANGE)];
    // A date-only line under an internship title is still a schedule ("January–June 2027"); prose around a range
    // ("fiscal year January–June") is not.
    const bareRange = ranges.length === 1
      && sentence.replace(MONTH_RANGE, '').replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[^a-z]/gi, '').length <= 8;
    if (SCHEDULE_PROGRAM.test(sentence) || SCHEDULE_DATES.test(sentence) || bareRange) {
      for (const range of ranges) {
        if (!nonWorkRange(sentence, range) && !summerRange(range)) return result('term', sentence, range, true);
      }
    }
  }
  return { level: null, evidence: '', hard: false };
}
