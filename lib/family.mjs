// ATS-family detection and stable snapshot locator keys.
import { normalize } from './answers.mjs';

// Generated-looking ids, Workday's click_filter (one id on every sign-in/registration submit) and its date segments
// (dateSectionMonth-input on every date box, a graduation date as much as a job's start): the label keys those.
const generated = /^(input|select|textarea|field|react|mui|radix|id|r|:)[-_:]?\d+$|\d{4,}|[0-9a-f]{8,}|^:|^click_filter$|^dateSection\w+-(input|display)$/i;

export function familyOf(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }

  if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com')) return 'workday';
  if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') return 'greenhouse';
  if (host === 'jobs.ashbyhq.com') return 'ashby';
  if (host === 'jobs.lever.co') return 'lever';
  if (host.endsWith('.icims.com')) return 'icims';
  if (host.endsWith('.oraclecloud.com')) return 'oracle';
  if (host === 'jobs.smartrecruiters.com') return 'smartrecruiters';
  if (host === 'apply.workable.com') return 'workable';
  if (host.endsWith('.successfactors.com') || host === 'jobs.sap.com') return 'successfactors';
  if (host === 'ats.rippling.com') return 'rippling';
  if (host === 'recruiting.paylocity.com') return 'paylocity';
  if (host.endsWith('.taleo.net')) return 'taleo';
  if (host.endsWith('.brassring.com')) return 'brassring';
  if (host.endsWith('.ultipro.com') || host.endsWith('.ukg.com')) return 'ukg';
  return null;
}

export function locatorKey(item) {
  if (!item || item.kind === 'option') return null;
  const locator = item.locator || {};
  const stable = (value) => {
    const text = String(value ?? '').trim();
    return text && !generated.test(text) ? text : '';
  };
  const name = stable(locator.name);
  if ((item.type === 'radio' || item.type === 'checkbox') && Array.isArray(item.options) && name) {
    return `name:${name}`;
  }
  // A Workday questionnaire wraps each custom question in a formField-<guid> div: that id is the tenant's, so the
  // question's label keys it instead.
  const aid = stable(locator.aid);
  if (aid) return `aid:${aid}`;
  if (name) return `name:${name}`;
  const id = stable(locator.id);
  if (id) return `id:${id}`;
  const label = normalize(item.label ?? '');
  return label ? `label:${label}` : null;
}
