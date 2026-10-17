// Shared mail sync: read-only inbox index plus to-do/report state. The CLI (`mail.mjs`) and the watcher both use
// this, so a scheduled sync follows exactly the same matching, classification, cache, and state rules.
import { loadConfig } from '../config.mjs';
import { accountAddress } from '../email.mjs';
import { loadPostings } from './postings.mjs';
import { indexJobMail, syncOutreach } from './inbox.mjs';
import { buildItems, statusByJob } from './todos.mjs';
import { loadMail, saveMail, loadDone, runsPath, MAIL_FILE } from './store.mjs';
import { printTodo, printReport } from './print.mjs';

// Index job mail and write runs/mail.json. Returns { mail, postings, previous } where `previous` is the last sync's
// state before this one (the watcher diffs its own event ids, but the previous byJob view remains useful).
export async function syncMail({ since, followUpDays = 7, quiet = false } = {}) {
  const config = loadConfig();
  if (!config.email.enabled) throw new Error('email.enabled is false in config.json; mail tracking needs read-only inbox access.');
  const account = config.email.accountLabel;
  const postings = loadPostings({ exclude: [config.applicant.displayName] });
  const applications = [...postings.values()];
  const first = applications.map(posting => posting.t).sort()[0] ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const after = Math.floor(Date.parse(since ?? first) / 1000);
  const now = Date.now();
  const me = await accountAddress(account);
  // Message text and links are cached per message, not their classification, so a classifier change applies to
  // every message on the next sync.
  const previous = loadMail() ?? {};
  const cache = { bodies: previous.bodies ?? {}, links: previous.links ?? {} };
  const events = await indexJobMail(account, { applications, after, me, cache });
  const outreach = await syncOutreach(account, { after, me, now, followUpDays, filePattern: config.resumes.filePattern });
  const mail = {
    syncedAt: new Date(now).toISOString(), since: since ?? first, followUpDays,
    items: buildItems(events, cache, loadDone()), byJob: statusByJob(events),
    events, outreach, ...cache,
  };
  saveMail(mail);
  if (!quiet) {
    printTodo(mail, now);
    printReport(mail, postings);
    console.log(`\nwritten ${runsPath(MAIL_FILE)}`);
  }
  return { mail, postings, previous };
}
