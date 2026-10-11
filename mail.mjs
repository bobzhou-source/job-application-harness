// Mail tracking CLI. `bun mail.mjs [--since ISO] [--follow-up DAYS]` reads the configured inbox (read-only), indexes
// every job email, and writes runs/mail.json, which `bun report.mjs --apps` folds into its `reply` column.
// - Index: each job email since --since (default: the first attempted application) is classified (offer / rejected /
//   completed / assessment / interview / incomplete / confirmed / update) and matched to the posting it answers by
//   sender and subject; mail matching no posting is indexed under its sender's employer.
// - To-dos: offers, assessments, interview requests and incomplete-application notices, with the deadline the email
//   states and its action link; closed by a later email showing the step handled, or by `done`.
// - Outreach: emails you sent with your resume attached, tracked as replied / bounced / auto-reply / waiting, or
//   follow-up once --follow-up days (default 7) pass without a reply.
// Without a sync: `todo` lists open items, `open N` opens item N's link in the browser, `done N` / `undo N` mark it
// handled or not (N is the list number or the item id). No model sees any mail; links are never printed.
// Modules: lib/mail/{postings,inbox,match,classify,todos,store,print}.mjs.
import { spawnSync } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';
import { accountAddress } from './lib/email.mjs';
import { loadPostings } from './lib/mail/postings.mjs';
import { indexJobMail, syncOutreach } from './lib/mail/inbox.mjs';
import { statusByJob, buildItems, findItem } from './lib/mail/todos.mjs';
import { loadMail, saveMail, loadDone, saveDone, runsPath, MAIL_FILE } from './lib/mail/store.mjs';
import { printTodo, printReport } from './lib/mail/print.mjs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = message => { console.error(message); process.exit(1); };

async function sync() {
  const config = loadConfig();
  if (!config.email.enabled) fail('email.enabled is false in config.json; mail tracking needs read-only inbox access.');
  const account = config.email.accountLabel;
  const postings = loadPostings({ exclude: [config.applicant.displayName] });
  const applications = [...postings.values()];
  const since = arg('--since') ?? applications.map(posting => posting.t).sort()[0] ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const after = Math.floor(Date.parse(since) / 1000);
  const followUpDays = Number(arg('--follow-up') ?? 7);
  const now = Date.now();
  const me = await accountAddress(account);
  // Message text and links are cached per message, not their classification, so a classifier change applies to
  // every message on the next sync.
  const previous = loadMail() ?? {};
  const cache = { bodies: previous.bodies ?? {}, links: previous.links ?? {} };
  const events = await indexJobMail(account, { applications, after, me, cache });
  const outreach = await syncOutreach(account, { after, me, now, followUpDays, filePattern: config.resumes.filePattern });
  const mail = {
    syncedAt: new Date(now).toISOString(), since, followUpDays,
    items: buildItems(events, cache, loadDone()), byJob: statusByJob(events), events, outreach, ...cache,
  };
  saveMail(mail);
  printTodo(mail, now);
  printReport(mail, postings);
  console.log(`\nwritten ${runsPath(MAIL_FILE)}`);
}

function itemCommand(command, ref) {
  const mail = loadMail();
  if (!mail?.items) fail('No synced mail yet; run `bun mail.mjs` first.');
  if (command === 'todo') return printTodo(mail);
  const item = findItem(mail.items, ref) ?? fail(`No item ${ref ?? ''}; run \`bun mail.mjs todo\` for the list.`);
  if (command === 'open') {
    if (!item.link) fail(`Item ${item.id.slice(-6)} has no action link; open the email "${item.subject}".`);
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [item.link], { stdio: 'ignore' });
    return console.log(`Opened ${new URL(item.link).host} for ${item.employer} (${item.kind}).`);
  }
  const done = loadDone();
  if (command === 'done') done[item.id] = new Date().toISOString(); else delete done[item.id];
  saveDone(done);
  item.state = command === 'done' ? 'done' : 'open';
  saveMail(mail);
  console.log(`${command === 'done' ? 'Done' : 'Reopened'}: ${item.employer} — ${item.kind}`);
}

if (['todo', 'open', 'done', 'undo'].includes(args[0])) itemCommand(args[0], args[1]);
else await sync();
