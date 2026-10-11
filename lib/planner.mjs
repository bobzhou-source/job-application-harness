// DeepSeek PLANNER/CONSULTANT: tool-free goal planning and escalation consults.
// Values and browser authority stay in the caller; the driver (Jev) picks refs.

import { promptData } from './planner/input.mjs';
import { config, runPlanner } from './planner/backend.mjs';
import { PlanRejected, parsePlan } from './planner/plan-output.mjs';

export { expandAliases, rewriteValue, writeAnswers } from './planner/answers.mjs';
export { pickCode } from './planner/codes.mjs';
export { pickPreference, writeCoverLetter, writeInstructedDocument, writeTailoredResume } from './planner/documents.mjs';

// One corrective retry: the planner is told which fixed rule its output broke.
// Any failure after that is the sanitized planner error.
export async function planGoals(snapshot, context) {
  const { data, prompt } = promptData(snapshot, context);
  let feedback = '';
  const rejected = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await runPlanner(prompt + feedback);
    try {
      return parsePlan(output, data);
    } catch (error) {
      // Opt-in diagnostics: the model never receives secrets, so its raw output is safe to show locally.
      if (config().runtime.debug) process.stderr.write(`planner rejected output (${error.message}):\n${output.slice(0, 4000)}\n`);
      if (!(error instanceof PlanRejected)) throw error;
      rejected.push(error.message);
      feedback = `\n\nYour previous output was rejected because it contained ${error.message}. Return corrected JSON only.`;
    }
  }
  throw new Error(`Planner returned an invalid plan: ${rejected.join('; ').slice(0, 400)}`);
}
