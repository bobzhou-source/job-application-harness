// Applicant logistics claims (relocation, in-person, dates) injected into writer prompts.

import { config } from './backend.mjs';

// Applicant logistics come from the local config, overridable by the caller's applicant.preferences. A false or
// empty value makes no claim at all (never a "No"), so clones do not inherit the author's relocation preferences.
export function logisticsClaims(applicant) {
  const fromInput = applicant && typeof applicant === 'object' ? applicant.preferences : null;
  const source = fromInput && typeof fromInput === 'object' ? fromInput : config().applicant;
  return {
    relocateAnywhere: source.relocateAnywhere === true,
    workInPerson: source.workInPerson === true,
    summerAvailability: typeof source.summerAvailability === 'string' ? source.summerAvailability.trim() : '',
  };
}

export function logisticsLines(applicant) {
  const { relocateAnywhere, workInPerson, summerAvailability } = logisticsClaims(applicant);
  const claims = [];
  if (relocateAnywhere) claims.push('you will relocate anywhere');
  if (workInPerson) claims.push('you will work in person');
  const lines = [];
  if (claims.length) lines.push(`- Logistics: ${claims.join(' and ')}; say so when asked about locations or preferences.`);
  lines.push(`- Dates: use the format the question names.${summerAvailability ? ` Internship terms: summer runs ${summerAvailability}.` : ''}`);
  return `${lines.join('\n')}\n`;
}
