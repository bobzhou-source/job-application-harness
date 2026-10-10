// Tailored cover-letter PDFs: the applicant-prose writer drafts a body from approved facts only, this module
// wraps it in the shared LaTeX template and compiles it in resumes/ with pdflatex. One PDF per posting URL,
// cached so a re-run reuses it without another writer call. Employer-requested attachments (answers to the items an
// upload's instructions list, plus a writing sample when asked) are built the same way, one per posting.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeCoverLetter, writeInstructedDocument } from './planner.mjs';
import { loadConfig } from './config.mjs';

const CONFIG = loadConfig();
const RESUMES_DIR = CONFIG.resumes.directory;
const FACTS_PATH = CONFIG.resumes.factsPath;
const PREAMBLE = CONFIG.resumes.latexPreamble;
const LETTERHEAD = CONFIG.applicant.coverLetterHeading;
const SIGNATURE = CONFIG.applicant.displayName;
const MAX_FACTS_CHARS = 12_000;
const MAX_PAGE_CHARS = 6_000;
const MAX_PRIOR_CHARS = 5_000;
const MAX_PRIOR_LETTERS = 3;
const MAX_PRIOR_CHARS_EACH = 1_600;
const COMPILE_TIMEOUT_MS = 60_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The cache key is the posting URL with its query and fragment stripped.
function urlHash(url) {
  return createHash('sha1').update(url.split(/[?#]/)[0]).digest('hex').slice(0, 8);
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

const LATEX_SPECIALS = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

function escapeLatex(value) {
  return String(value).replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_SPECIALS[ch]);
}

// One writer-text run: normalize unicode punctuation, pair straight double quotes as ``...'', escape LaTeX.
function texText(value) {
  let open = true;
  const normalized = String(value)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*\u2014\s*/g, '---')
    .replace(/\s*\u2013\s*/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/"/g, () => { const quote = open ? '``' : "''"; open = !open; return quote; });
  return escapeLatex(normalized);
}

function dateLine() {
  const now = new Date();
  return `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

// The employer for the recipient block: the caller's value, else inferred from the letter's own opening or the
// posting text. Null falls back to a plain "Hiring Team" line.
function deriveEmployer({ employer, pageText, body }) {
  const clean = (value) => (typeof value === 'string' ? value.trim().replace(/[.,;:]+$/, '') : '');
  if (clean(employer)) return clean(employer);
  const fromBody = String(body || '').match(/\bat\s+((?:[A-Z][A-Za-z0-9&.'+-]*)(?:\s+[A-Z][A-Za-z0-9&.'+-]*){0,3})/);
  if (fromBody) return clean(fromBody[1]);
  const fromPage = String(pageText || '').match(/\b(?:About|Join|at)\s+((?:[A-Z][A-Za-z0-9&.'+-]*)(?:\s+[A-Z][A-Za-z0-9&.'+-]*){0,2})/);
  return fromPage ? clean(fromPage[1]) : null;
}

function buildTex({ employer, body, title, hash }) {
  const org = typeof employer === 'string' && employer.trim() ? employer.trim() : null;
  const recipient = org ? `${texText(org)} Hiring Team` : 'Hiring Team';
  const salutation = org ? `Dear ${texText(org)} Hiring Team,` : 'Dear Hiring Team,';
  const paragraphs = body.split(/\n\s*\n/).map((part) => texText(part.trim())).filter(Boolean).join('\n\n');
  const heading = String(title || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return `% Auto-generated cover letter - ${heading} (${hash})
\\input{${PREAMBLE}}
\\pagestyle{empty}
\\begin{document}
\\namehead{${texText(LETTERHEAD)}}

\\vspace{6pt}
${dateLine()}

\\vspace{6pt}
${recipient}\\\\

\\vspace{8pt}
${salutation}

${paragraphs}

\\vspace{8pt}
Sincerely,\\\\[10pt]
${texText(SIGNATURE)}

\\end{document}
`;
}

function compileTex(texName) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', texName], {
        cwd: RESUMES_DIR, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ ok: false });
      return;
    }
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, COMPILE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 }); });
  });
}

// Pages from pdflatex's own log line; null when the log is missing or unreadable.
async function compiledPages(base) {
  try {
    // pdflatex hard-wraps its log at 79 columns, so a long file name splits "Output written on … (1 page": unwrap first.
    const log = (await readFile(path.join(RESUMES_DIR, `${base}.log`), 'utf8')).replace(/\r?\n/g, '');
    const match = log.match(/Output written on .*?\((\d+) page/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function cleanup(base, { removePdf = false } = {}) {
  const extensions = removePdf ? ['aux', 'log', 'out', 'pdf'] : ['aux', 'log', 'out'];
  await Promise.all(extensions.map((ext) => rm(path.join(RESUMES_DIR, `${base}.${ext}`), { force: true }).catch(() => {})));
}

// Source text of the accepted letters, for voice and facts; the LaTeX scaffold is stripped.
function texToPlain(source) {
  return source
    .split('\n').filter((line) => !/^\s*%/.test(line)).join('\n')
    .replace(/\\input\{[^}]*\}|\\pagestyle\{[^}]*\}|\\namehead(?:\[[^\]]*\])?\{[^}]*\}|\\vspace\*?\{[^}]*\}|\\begin\{document\}|\\end\{document\}|\\hfill|\\textbf|\\textit|\\ldots/g, ' ')
    .replace(/\\\\/g, '\n')
    .replace(/\\\$/g, '$').replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\#/g, '#')
    .replace(/\{,\}/g, ',').replace(/``|''/g, '"').replace(/---/g, ' - ')
    .replace(/[ \t]{2,}/g, ' ');
}

async function loadContext() {
  let facts = '';
  try { facts = (await readFile(FACTS_PATH, 'utf8')).slice(0, MAX_FACTS_CHARS); } catch { facts = ''; }
  let priorLetters = '';
  try {
    const names = (await readdir(RESUMES_DIR)).filter((name) => /^cover_letter_\d+_.*\.tex$/.test(name)).sort().slice(-MAX_PRIOR_LETTERS);
    const parts = [];
    for (const name of names) {
      const raw = await readFile(path.join(RESUMES_DIR, name), 'utf8');
      parts.push(`--- ${name} ---\n${texToPlain(raw).slice(0, MAX_PRIOR_CHARS_EACH)}`);
    }
    priorLetters = parts.join('\n\n').slice(0, MAX_PRIOR_CHARS);
  } catch { priorLetters = ''; }
  return { facts, priorLetters };
}

async function findCached(hash) {
  try {
    const names = await readdir(RESUMES_DIR);
    const hit = names.find((name) => name.startsWith('cover_letter_auto_') && name.endsWith(`_${hash}.pdf`));
    return hit ? path.join(RESUMES_DIR, hit) : null;
  } catch {
    return null;
  }
}

// Writes the .tex, compiles it, and returns the page count; byproducts (.aux/.log/.out) are always removed.
async function buildPdf(base, { employer, pageText, body, title, hash }) {
  const texName = `${base}.tex`;
  const org = deriveEmployer({ employer, pageText, body });
  await writeFile(path.join(RESUMES_DIR, texName), buildTex({ employer: org, body, title, hash }), 'utf8');
  try {
    const result = await compileTex(texName);
    const pages = await compiledPages(base);
    if (!result.ok || pages == null) throw new Error('Cover letter PDF compilation failed.');
    return pages;
  } finally {
    await cleanup(base);
  }
}

// Absolute path of a one-page PDF cover letter for this posting; cached per URL so a re-run reuses it.
export async function coverLetter({ url, title, employer, pageText } = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A posting URL is required to write a cover letter.');
  if (typeof title !== 'string' || !title.trim()) throw new Error('A posting title is required to write a cover letter.');
  const cleanUrl = url.trim();
  const cleanTitle = title.trim();
  const hash = urlHash(cleanUrl);

  const cached = await findCached(hash);
  if (cached) return cached;

  const { facts, priorLetters } = await loadContext();
  if (!facts) throw new Error('The applicant facts file could not be read.');
  const page = typeof pageText === 'string' ? pageText.slice(0, MAX_PAGE_CHARS) : '';
  const base = `cover_letter_auto_${slugify(employer || cleanTitle) || 'posting'}_${hash}`;
  const writerInput = { url: cleanUrl.split(/[?#]/)[0], title: cleanTitle, employer: employer ?? null, pageText: page, facts, priorLetters };

  let pages = 0;
  try {
    const body = await writeCoverLetter(writerInput);
    pages = await buildPdf(base, { employer, pageText: page, body, title: cleanTitle, hash });
    if (pages !== 1) {
      const shorter = await writeCoverLetter({ ...writerInput, request: 'Write the same cover letter about 20 percent shorter: keep every rule and the closing paragraph, cut roughly one fifth of the words.' });
      pages = await buildPdf(base, { employer, pageText: page, body: shorter, title: cleanTitle, hash });
    }
  } catch (error) {
    await cleanup(base, { removePdf: true });
    throw error instanceof Error ? error : new Error('Cover letter generation failed.');
  }
  if (pages !== 1) {
    await cleanup(base, { removePdf: true });
    throw new Error('Cover letter could not be made to fit on one page.');
  }
  return path.join(RESUMES_DIR, `${base}.pdf`);
}

// Absolute path of a PDF answering an upload slot's employer instructions for this posting; cached per URL.
export async function instructedDocument({ url, title, instructions, pageText, applicant } = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A posting URL is required to write a document.');
  if (typeof instructions !== 'string' || !instructions.trim()) throw new Error('Employer instructions are required to write a document.');
  const hash = urlHash(url.trim());
  const prefix = 'application_document_';
  try {
    const hit = (await readdir(RESUMES_DIR)).find((name) => name.startsWith(prefix) && name.endsWith(`_${hash}.pdf`));
    if (hit) return path.join(RESUMES_DIR, hit);
  } catch { /* no cache */ }
  const cleanTitle = String(title || '').trim();
  const doc = await writeInstructedDocument({
    job: { title: cleanTitle, page: String(pageText || '').slice(0, MAX_PAGE_CHARS) },
    instructions: instructions.trim(),
    applicant,
  });
  const base = `${prefix}${slugify(cleanTitle) || 'posting'}_${hash}`;
  const sections = doc.sections.map(({ heading, body }) => {
    const paragraphs = body.split(/\n\s*\n/).map((part) => texText(part.trim())).filter(Boolean).join('\n\n');
    // The writing sample starts on its own page.
    return `${/^writing sample/i.test(heading) ? '\\newpage\n' : ''}\\section*{${texText(heading)}}\n${paragraphs}`;
  }).join('\n\n');
  const tex = `% Auto-generated application document - ${cleanTitle.replace(/[\r\n]+/g, ' ').slice(0, 80)} (${hash})
\\input{${PREAMBLE}}
\\pagestyle{empty}
\\setlength{\\parskip}{6pt}
\\begin{document}
\\namehead{${texText(LETTERHEAD)}}

\\vspace{6pt}
{\\large\\textbf{${texText(doc.title)}}}\\\\
${dateLine()}

${sections}

\\end{document}
`;
  await writeFile(path.join(RESUMES_DIR, `${base}.tex`), tex, 'utf8');
  try {
    const result = await compileTex(`${base}.tex`);
    if (!result.ok || await compiledPages(base) == null) {
      await cleanup(base, { removePdf: true });
      throw new Error('Application document PDF compilation failed.');
    }
  } finally {
    await cleanup(base);
  }
  return path.join(RESUMES_DIR, `${base}.pdf`);
}
