// Mail tracking CLI. `bun mail.mjs [--since ISO] [--follow-up DAYS]` reads the configured inbox (read-only), indexes
// every job email, and writes runs/mail.json, which `bun report.mjs --apps` folds into its `reply` column.
// - Index: each job email since --since (default: the first attempted application) is classified (offer / rejected /
//   completed / assessment / interview / incomplete / confirmed / update) and matched to the posting it answers by
//   sender and subject; mail matching no posting is indexed under its sender's employer.
// - Watch: `bun mail.mjs watch [--once]` syncs, diffs against runs/mail-watch.json, and texts new actionable items and
//   a daily digest. Without --once it repeats every 15 minutes.
// - To-dos: offers, assessments, interview requests and incomplete-application notices, with the deadline the email
//   states and its action link; closed by a later email showing the step handled, or by `done`.
// - Outreach: emails you sent with your resume attached, tracked as replied / bounced / auto-reply / waiting, or
//   follow-up once --follow-up days (default 7) pass without a reply.
// Without a sync: `todo` lists open items, `open N` opens item N's link in the browser, `done N` / `undo N` mark it
// handled or not (N is the list number or the item id). No model sees any mail; links are never printed.
// Modules: lib/mail/{postings,inbox,match,classify,todos,store,print,sync,watch}.mjs.
import { spawnSync } from 'node:child_process';
import { syncMail } from './lib/mail/sync.mjs';
import { watch } from './lib/mail/watch.mjs';
import { findItem } from './lib/mail/todos.mjs';
import { loadMail, saveMail, loadDone, saveDone } from './lib/mail/store.mjs';
import { printTodo } from './lib/mail/print.mjs';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = message => { console.error(message); process.exit(1); };

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

if (args[0] === 'watch') {
  try {
    await watch({ once: args.includes('--once') });
  } catch (error) {
    fail(error.message);
  }
} else if (['todo', 'open', 'done', 'undo'].includes(args[0])) {
  itemCommand(args[0], args[1]);
} else {
  const followUpDays = Number(arg('--follow-up') ?? 7);
  try {
    await syncMail({ since: arg('--since'), followUpDays });
  } catch (error) {
    fail(error.message);
  }
}
