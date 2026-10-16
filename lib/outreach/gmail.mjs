// lib/outreach/gmail.mjs — Gmail DRAFTS ONLY.
//
// `createDraft`/`listDrafts` are the only client functions this module ever
// reaches for; `sendEmail` and `sendDraft` are deliberately never imported or
// called. Outreach emails are always left as drafts for a human to send.
//
// The client lives outside this repo and is loaded from the path the caller
// passes, so no personal path or address is baked in here.
//
// The client is a Node program: its token store is `node:sqlite`, which Bun
// (the harness's runtime) does not implement. So under Node the client is
// imported in-process, and under Bun the same dynamic import runs inside a
// short-lived `node` child. Callers see one behaviour either way.

import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHILD_TIMEOUT_MS = 120_000;

// Runs under `node --input-type=module -e`: reads one JSON request on stdin,
// dynamically imports the client, and answers with one JSON line.
const NODE_CHILD = `
import { pathToFileURL } from 'node:url';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const client = await import(pathToFileURL(request.clientPath).href);
  if (request.operation === 'createDraft') {
    const data = await client.createDraft(request.account, request.fields);
    console.log(JSON.stringify({ ok: true, result: { id: data?.id, messageId: data?.message?.id, threadId: data?.message?.threadId } }));
  } else if (request.operation === 'listDrafts') {
    const drafts = await client.listDrafts(request.account, request.query ?? '');
    console.log(JSON.stringify({ ok: true, result: (drafts ?? []).map((d) => ({ id: d.id, to: d.to ?? '', subject: d.subject ?? '' })) }));
  } else {
    throw new Error('unsupported operation ' + request.operation);
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exit(1);
}
`;

const runningOnBun = () => typeof globalThis.Bun !== 'undefined';

async function loadClient(clientPath) {
  if (!clientPath) throw new TypeError('gmail: clientPath is required');
  const resolved = resolve(clientPath);
  const mod = await import(pathToFileURL(resolved).href);
  if (typeof mod.createDraft !== 'function' || typeof mod.listDrafts !== 'function') {
    throw new Error(`gmail: ${resolved} does not export createDraft()/listDrafts()`);
  }
  return mod;
}

/** Dispatches one operation to the client, in-process or through a node child. */
async function callClient(clientPath, request) {
  if (!clientPath) throw new TypeError('gmail: clientPath is required');

  if (!runningOnBun()) {
    const client = await loadClient(clientPath);
    if (request.operation === 'createDraft') {
      const data = await client.createDraft(request.account, request.fields);
      return { id: data?.id, messageId: data?.message?.id, threadId: data?.message?.threadId };
    }
    return (await client.listDrafts(request.account, request.query ?? '')).map((d) => ({
      id: d.id,
      to: d.to ?? '',
      subject: d.subject ?? '',
    }));
  }

  const child = spawnSync('node', ['--input-type=module', '-e', NODE_CHILD], {
    input: JSON.stringify({ ...request, clientPath: resolve(clientPath) }),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const line = (child.stdout ?? '').trim().split('\n').filter(Boolean).pop();
  if (!line) {
    throw new Error(
      `gmail: node child produced no output for ${request.operation} (status ${child.status}${child.error ? `, ${child.error.message}` : ''}): ${(child.stderr ?? '').trim().slice(0, 300)}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`gmail: node child returned malformed output for ${request.operation}: ${line.slice(0, 300)}`);
  }
  if (!parsed.ok) throw new Error(`gmail ${request.operation} failed: ${parsed.error}`);
  return parsed.result;
}

/**
 * Creates a draft addressed to `to`. `attachmentPath` is a single file that is
 * attached verbatim; the client requires absolute paths, so relative ones are
 * resolved against the caller's cwd.
 */
export async function createGmailDraft({ clientPath, account, to, subject, body, attachmentPath }) {
  if (!account) throw new TypeError('createGmailDraft: account is required');
  if (!to) throw new TypeError('createGmailDraft: to is required');
  if (!subject) throw new TypeError('createGmailDraft: subject is required');

  const attachments = attachmentPath
    ? [isAbsolute(attachmentPath) ? attachmentPath : resolve(attachmentPath)]
    : [];

  const data = await callClient(clientPath, {
    operation: 'createDraft',
    account,
    fields: { to, subject, body, attachments },
  });
  if (!data?.id) throw new Error(`createGmailDraft: Gmail returned no draft id (${JSON.stringify(data)})`);
  return { draftId: data.id, messageId: data.messageId ?? null, threadId: data.threadId ?? null };
}

/** Drafts matching `query` (Gmail search syntax, e.g. `to:a@b subject:"x"`). */
export async function listDrafts({ clientPath, account, query }) {
  if (!account) throw new TypeError('listDrafts: account is required');
  const drafts = await callClient(clientPath, { operation: 'listDrafts', account, query });
  return (drafts ?? []).map((draft) => ({ id: draft.id, to: draft.to ?? '', subject: draft.subject ?? '' }));
}
