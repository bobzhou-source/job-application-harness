import { access, stat, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDomain } from 'tldts';

const USAGE = 'usage: bun apply.mjs <https-job-url> [--resume <path>] [--answer "Question=Answer"]... [--submit]';
// `--help` prints usage and exits before configuration, answers, Chrome, or any harness module below is loaded, so a
// fresh clone with no config can still read it. No-argument behavior is unchanged (it reports the same usage with a
// nonzero exit).
if (process.argv.slice(2).includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

// The harness modules load config.json and build their own module constants at import time, so they are imported only
// after the help branch (a static import would evaluate them before `--help` could exit). Bindings match the former
// static imports.
const { loadConfig } = await import('./lib/config.mjs');
const browser = await import('./lib/browser.mjs');
const { snapshot } = await import('./lib/snapshot.mjs');
const act = await import('./lib/act.mjs');
const rules = await import('./lib/rules.mjs');
const { planGoals, expandAliases, rewriteValue, pickCode, pickPreference, writeAnswers } = await import('./lib/planner.mjs');
const email = await import('./lib/email.mjs');
const { drive, pickOption, plan: jevPlan } = await import('./lib/jev.mjs');
const { coverLetter, coverLetterText, instructedDocument, tailoredResume } = await import('./lib/coverletter.mjs');
const answers = await import('./lib/answers.mjs');
const { withFileLockSync } = await import('./lib/lockfile.mjs');
const credentials = await import('./lib/credentials.mjs');
const runlog = await import('./lib/trace.mjs');
const { Stop } = await import('./lib/apply/stop.mjs');
const { isConfirmed, evidenceOf } = await import('./lib/apply/confirm.mjs');
const { createState } = await import('./lib/apply/state.mjs');
const { createRuntime } = await import('./lib/apply/runtime.mjs');
const { installObserver } = await import('./lib/apply/observer.mjs');
const { installAccounts } = await import('./lib/apply/accounts.mjs');
const { installEmailcode } = await import('./lib/apply/emailcode.mjs');
const { installWriter } = await import('./lib/apply/writer.mjs');
const { installSteprules } = await import('./lib/apply/steprules.mjs');
const { installPick } = await import('./lib/apply/pick.mjs');
const { installPicker } = await import('./lib/apply/picker.mjs');
const { installPass } = await import('./lib/apply/pass.mjs');
const { installSession } = await import('./lib/apply/session.mjs');
const { installTemplate } = await import('./lib/apply/template.mjs');

// Non-secret machine and user settings (config.json), read once at startup. A missing or invalid config fails here
// with the loader's actionable message, before any run state exists.
const config = loadConfig();

const answerPath = fileURLToPath(new URL('./answers.json', import.meta.url));

async function options(argv) {
  if (!argv.length) throw new Stop(USAGE, 1);
  let url;
  try { url = new URL(argv[0]); } catch { throw new Stop('invalid-url', 1); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Stop('invalid-url', 1);
  let resume;
  let submit = false;
  const qa = [];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--submit') { submit = true; continue; }
    if (!['--resume', '--answer'].includes(flag) || i + 1 >= argv.length) {
      throw new Stop('invalid-arguments', 1);
    }
    const value = argv[++i];
    if (flag === '--resume') {
      resume = resolve(value);
    } else {
      const separator = value.indexOf('=');
      const question = answers.normalize(value.slice(0, separator));
      if (separator < 1 || !question) throw new Stop('invalid-answer', 1);
      qa.push([question, value.slice(separator + 1)]);
    }
  }
  if (resume) {
    try {
      await access(resume, constants.R_OK);
      if (!(await stat(resume)).isFile()) throw new Error('not a file');
    } catch { throw new Stop('resume-not-readable', 1); }
  }
  const data = answers.load(answerPath);
  if (qa.length) {
    // Merge into the latest answers.json under the lock: parallel workers share the file.
    withFileLockSync(answerPath, () => {
      const stored = answers.load(answerPath);
      stored.qa = { ...stored.qa, ...Object.fromEntries(qa) };
      answers.save(answerPath, stored);
    });
    data.qa = { ...data.qa, ...Object.fromEntries(qa) };
  }
  // The explicit override is deliberately applied only after persistent Q&A storage.
  if (resume) data.facts = { ...data.facts, resume };
  return { url: url.href, data, submit };
}

// The run itself lives in lib/apply/session.mjs: this file keeps the CLI and the wiring, so the whole
// run-loop state (one ctx object) is handed to the moved helpers explicitly instead of through module globals.
async function run() {
  const ctx = createState({ answerPath });
  const shared = { ...createRuntime({ config, runlog, Stop }), config, options, isConfirmed, evidenceOf };
  for (const install of [installObserver, installAccounts, installEmailcode, installWriter, installSteprules,
    installPick, installPicker, installPass, installSession, installTemplate]) {
    Object.assign(shared, install(ctx, shared));
  }
  await shared.runFlow(ctx);
}

await run();
