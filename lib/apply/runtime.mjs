// Run-wide helpers apply.mjs used to define at module scope: the say/notify pair, the email guard, and
// the constants that gate account creation, hold-open stops, unwritable questions, and the local resume
// path.

import { execFile } from 'node:child_process';

// Controls that open account creation on a sign-in screen.
export const RE_CREATE_ACCOUNT = /^(create (an )?account|register|sign ?up|new user\??|don['’]t have an account(?: yet)?\??)$/i;

// Stops only the user can finish in the page itself (a captcha, an MFA prompt): the run's tab stays open for them.
export const USER_GATE = /^(captcha-rejected|gate (captcha|captcha-challenge|mfa)\b)/i;

// login name (the account's own address, entered with the credentials).
export const NEVER_WRITE = /\b(password|passcode|ssn|social security|date of birth|birth ?date|dob|signature|sign here|initials|(verification|security|one time|access|sign in|login|enter( the| your)?) code)\b|^code\b|^(login|log in|login id|login name|user ?name|user id)$/;

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
