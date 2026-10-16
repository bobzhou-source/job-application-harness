// What went out: the free-text drafts the submitted runs shipped with the grade the grader gave them
// (lib/planner/grader.mjs; a terrible draft is dropped before submit, so a terrible grade here means the field went
// out empty or was answered another way), and a tally of the options they committed, so a wrong stored answer
// replayed across employers stands out by count. Reads the ledger (lib/report/ledger.mjs), never the traces.
const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const RANK = { terrible: 0, ok: 1, good: 2, great: 3 };
const shortSite = site => String(site ?? '?').replace(/\.(wd\d+\.)?myworkdayjobs\.com$/, '').replace(/^www\./, '');

export function quality(ledger, { all = false } = {}) {
  const rows = ledger.filter(row => row.outcome === 'submitted');
  const runs = new Set(rows.map(row => row.run)).size;
  const shipped = rows.filter(row => row.kind === 'written');
  const counts = purpose => Object.fromEntries(['great', 'good', 'ok', 'terrible'].map(grade => [grade, shipped.filter(item => (item.purpose === 'cover-letter') === (purpose === 'cover-letter') && item.grade === grade).length]));
  console.log(`${runs} submitted runs; ${shipped.length} graded drafts shipped (${shipped.filter(item => item.revised).length} after a revision pass).`);
  for (const kind of ['answer', 'cover-letter']) {
    const c = counts(kind);
    console.log(`  ${kind.padEnd(13)} great ${c.great}  good ${c.good}  ok ${c.ok}  terrible(dropped) ${c.terrible}`);
  }
  const weak = shipped.filter(item => RANK[item.grade] <= 1).sort((a, b) => RANK[a.grade] - RANK[b.grade]);
  if (weak.length) {
    console.log(`\nWeakest shipped drafts (ok = generic or thin, terrible = dropped before submit):`);
    for (const item of weak.slice(0, all ? weak.length : 25)) {
      console.log(`  [${item.grade}] ${shortSite(item.site)} — ${clip(item.label, 80)}`);
      console.log(`      ${clip(item.value, 160)}`);
      console.log(`      why: ${clip(item.why, 140)}`);
    }
    if (!all && weak.length > 25) console.log(`  … ${weak.length - 25} more (--all)`);
  }
  const picks = new Map();
  for (const row of rows) {
    if (row.kind !== 'choice' || row.value == null) continue;
    const key = `${clip(row.label, 70)} = ${clip(row.value, 50)}`;
    picks.set(key, (picks.get(key) ?? 0) + 1);
  }
  if (picks.size) {
    const sorted = [...picks].sort((a, b) => b[1] - a[1]);
    console.log(`\nOptions committed in submitted runs (count × label = value; --suspects flags the doubtful ones):`);
    for (const [key, count] of sorted.slice(0, all ? sorted.length : 40)) console.log(`  ${String(count).padStart(3)} × ${key}`);
    if (!all && sorted.length > 40) console.log(`  … ${sorted.length - 40} more (--all)`);
  }
}
