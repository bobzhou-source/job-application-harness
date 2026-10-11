// Verification-code picking from emails: deterministic stated-code scan first, planner fallback.

import { runPlanner } from './backend.mjs';

const CODE_PROMPT = `A job-application site is asking for the verification code it just emailed. Input JSON:
{site, page, messages: [{from, subject, date, body}]} with the newest message first. Return only JSON {"code": "<code>"}
with the code exactly as written in the newest message that the site sent for this verification, or {"code": null} when
no message is that verification email. Never guess or construct a code.`;

// The verification code from the given emails (newest first), or null. When the mails stating a code
// ("…code…: 284187") all come from one sender whose domain names the site (notify@dayforce.com for
// jobs.dayforcehcm.com, greenhouse-mail.io for job-boards.greenhouse.io), the newest one's code is used without a
// model call; any other case goes to the planner to pick the site's own code.
const STATED_CODE = /\b(?:code|passcode|pin|one[- ]time password)\b[^\d\n]{0,60}?\b(\d{4,8})\b/i;
const hostWords = host => String(host).toLowerCase().split(/[.-]/).filter(word => word.length >= 4 && !/^(mail|email|noreply|reply|notify|jobs|careers|apply|www|com|net|org)$/.test(word));
// Verification mail carries token-bearing links (account-verification and reset URLs). The model only needs the
// message text to recognise the code, so URL spans are replaced before any body leaves for a provider. The
// deterministic STATED_CODE scan runs on the raw bodies and is unaffected.
const BODY_LINK = /https?:\/\/[^\s<>"']+/gi;
const withoutLinks = (body) => String(body).replace(BODY_LINK, '[link removed]');
export async function pickCode({ site, page, messages }) {
  const stated = messages.flatMap(m => {
    const code = STATED_CODE.exec(`${m.subject}\n${m.body}`)?.[1];
    return code ? [{ code, sender: m.from.match(/@([\w.-]+)/)?.[1]?.toLowerCase() ?? '' }] : [];
  });
  const siteWords = hostWords(site);
  const namesSite = sender => hostWords(sender).some(word => siteWords.some(other => word.slice(0, 6) === other.slice(0, 6)));
  if (stated.length && stated.every(s => s.sender === stated[0].sender) && namesSite(stated[0].sender)) return stated[0].code;
  let parsed;
  try {
    const input = { site, page: page.slice(0, 1500), messages: messages.map(({ from, subject, date, body }) => ({ from, subject, date: new Date(date).toISOString(), body: withoutLinks(body) })) };
    const source = (await runPlanner(JSON.stringify(input), CODE_PROMPT, { purpose: 'email-code' })).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    parsed = JSON.parse(source);
  } catch { return null; }
  const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
  // The code must appear verbatim in one of the messages.
  return /^[A-Za-z0-9-]{4,12}$/.test(code) && messages.some(m => m.body.includes(code)) ? code : null;
}
