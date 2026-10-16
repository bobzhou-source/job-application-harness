// Run-wide helpers apply.mjs used to define at module scope: the say/notify pair, the email guard, and
// the constants that gate account creation, hold-open stops, unwritable questions, and the local resume
// path.

import { execFile } from 'node:child_process';

// Controls that open account creation on a sign-in screen.
export const RE_CREATE_ACCOUNT = /^(create (an )?account|register|sign ?up|new user\??|don['’]t have an account(?: yet)?\??)$/i;

// Stops only the user can finish in the page itself (a captcha, an MFA prompt): the run's tab stays open for them.
export const USER_GATE = /^(captcha-rejected|gate (captcha|captcha-challenge|mfa)\b)/i;

// login name (the account's own address, entered with the credentials). A site's chat assistant box ("ask another
// recruiting question") is not an application question: nothing is ever typed into it.
export const NEVER_WRITE = /\b(password|passcode|ssn|social security|date of birth|birth ?date|dob|signature|sign here|initials|(verification|security|one time|access|sign in|login|enter( the| your)?) code)\b|^code\b|^(login|log in|login id|login name|user ?name|user id)$|\bask (another |a |us a |your )?(recruiting |general )?question|\b(type|send) (a |your |us a )?message\b|\bchat ?bot\b|\bchat with\b/;

// A field that wants a recording the applicant has to make (a video introduction, a Loom link): no stored fact or
// written prose can answer it, so a required one stops the run for the user and an optional one stays empty.
export const USER_MEDIA = /\b(record|recording|video|loom|vidyard|audio clip)\b.*\b(link|url|introduc|yourself|upload|response)|\b(link|url) to (a |your )?(video|recording)|\bvideo (link|url|response|introduction|interview)\b/;

// A field that wants a web address or account handle (a LinkedIn/GitHub/portfolio URL, a Facebook profile, a Twitter
// handle) is a fact, never prose: the writer never composes it ("N/A" is an invalid URL and a wrong answer), and an
// optional one no fact answers stays empty without asking the driver. The label's platform word names the fact:
// LinkedIn → facts.linkedin; GitHub/portfolio/website → facts.website or facts.github; anything else has none.
export const LINK_FIELD = /\b(linkedin|github|gitlab|bitbucket|stack ?overflow|kaggle|portfolio|personal (web)?site|website|web ?page|blog|facebook|twitter|instagram|tiktok|youtube|x\.com|(x|social media) handle|profile (url|link)|url|hyperlink)\b/;
export function linkFact(label, values) {
  const text = String(label ?? '').toLowerCase();
  const has = key => values.has(key) && String(values.get(key) ?? '').trim();
  if (/linkedin/.test(text)) return has('facts.linkedin') ? 'facts.linkedin' : null;
  if (/github|gitlab|bitbucket|portfolio|website|web ?page|web ?site|url|hyperlink/.test(text)) {
    for (const key of ['facts.github', 'facts.portfolio', 'facts.website']) if (has(key)) return key;
  }
  return null;
}

// The resume's file path is local-only: uploads read it directly from `values`, and it is never placed in a model
// payload (writer applicant, planner/Jev context keys or values). The `resume.<role>_<n>` bullet keys are the
// resume's text and do travel to the models.
export const RESUME_PATH_KEY = 'facts.resume';

export function createRuntime({ config, runlog, Stop }) {
  // Every user-visible line also goes to the run trace.
  function say(line) {
    console.log(line);
    runlog.trace('log', { line });
  }

  // Alert the user about a condition only they can clear (an open captcha). The configured notification backend decides
  // delivery: "console" prints the line, "macos-osascript" posts a desktop notification and fails clearly when selected
  // off macOS. Both backends share config.notifications with the queue's own notify. Nothing runs merely by importing
  // this module.
  function notify(message) {
    const { backend, title, sound } = config.notifications;
    if (backend !== 'macos-osascript') { say(`[notification] ${message}`); return; }
    if (process.platform !== 'darwin') {
      throw new Stop(`notifications-unavailable: notifications.backend "${backend}" requires macOS; set notifications.backend to "console"`);
    }
    execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name ${JSON.stringify(sound)}`], () => {});
  }

  function requireEmail() {
    if (!config.email.enabled) throw new Stop('email automation disabled; complete verification manually');
  }

  return { say, notify, requireEmail, EMAIL_LABEL: config.email.accountLabel };
}
