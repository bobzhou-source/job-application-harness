// lib/mail/store.mjs — mail tracking's local state under runs/: mail.json (the last sync) and mail-done.json (to-dos
// you marked handled, by item id, which survive resyncs).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const runsPath = name => fileURLToPath(new URL(`../../runs/${name}`, import.meta.url));
const readJson = (name, fallback) => (existsSync(runsPath(name)) ? JSON.parse(readFileSync(runsPath(name), 'utf8')) : fallback);
const writeJson = (name, value) => writeFileSync(runsPath(name), `${JSON.stringify(value, null, 1)}\n`);

export const MAIL_FILE = 'mail.json';
export const loadMail = () => readJson(MAIL_FILE, null);
export const saveMail = mail => writeJson(MAIL_FILE, mail);
export const loadDone = () => readJson('mail-done.json', {});
export const saveDone = done => writeJson('mail-done.json', done);
