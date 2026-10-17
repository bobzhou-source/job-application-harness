// One-shot stdin importer for the file credential backend. Reads a JSON export and replaces the
// encrypted store; prints only the imported record count. Secret values are never printed.
import { importRecords } from '../lib/credentials.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const count = importRecords(payload);
console.log(JSON.stringify({ imported: count, backend: 'file' }));
