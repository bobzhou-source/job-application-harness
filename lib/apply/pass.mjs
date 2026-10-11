// One pass over the current screen: pre-checks, screen preparation, plan choice and plan execution.
// Each step returns "again" to re-observe or "done" when the application was submitted.

import { preflight } from './preflight.mjs';
import { prepare } from './prepare.mjs';
import { choose } from './choose.mjs';
import { execute } from './execute.mjs';

export function installPass(ctx, shared) {
  // The four steps of one pass, in order; the first that returns a signal ends the pass.
  async function drivePass(ctx) {
    for (const step of [preflight, prepare, choose, execute]) {
      const signal = await step(ctx, shared);
      if (signal) return signal;
    }
    return 'again';
  }

  return { drivePass };
}
