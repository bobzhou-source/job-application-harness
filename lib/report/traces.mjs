// Trace access for report.mjs: the events of the runs a summary row set names, read one file at a time. A trace
// (runs/<ts>.jsonl) holds every event of one run; the report wants a few kinds (`call`, `grades`, `log`), so lines
// are prefiltered by a substring before they are parsed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNS = fileURLToPath(new URL('../../runs/', import.meta.url));

// Events of the named kinds, per row: `{ row, events }` for every row whose trace is on disk (a rotated or
// deleted trace is skipped, not an error).
export function* traceEvents(rows, kinds) {
  const needles = kinds.map(kind => `"event":"${kind}"`);
  for (const row of rows) {
    if (!row.trace) continue;
    let text;
    try { text = readFileSync(`${RUNS}${row.trace}`, 'utf8'); } catch { continue; }
    const events = [];
    for (const line of text.split('\n')) {
      if (!needles.some(needle => line.includes(needle))) continue;
      try { events.push(JSON.parse(line)); } catch { /* a line cut by a kill */ }
    }
    yield { row, events };
  }
}
