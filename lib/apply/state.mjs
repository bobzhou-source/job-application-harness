// Per-run mutable state for apply.mjs: one `ctx` object carries what the run-scope `let`s used to hold,
// so helpers moved into lib/apply/*.mjs read and write it explicitly instead of through module globals.

// The run starts on one fixed goal; DeepSeek is consulted only when Jev stays stuck on a screen,
// and its guidance (or goal list) refines that goal. Finished planner goals fall back to it.
export const BASE_GOAL = {
  goal: 'Complete this job application',
  done_when: 'The application has been submitted or the final review/submit step is reached',
  guidance: 'Open the application if it is not open yet, sign in or create the employer account when asked, fill every field and answer every question (required and optional) from the stored answers, add any required entries (education, work experience), upload the resume when asked, then continue to the next step. A repeatable section whose entry takes one choice (Skills, Languages) gets one entry per item of the stored list answer (fill the entry field from the list key; the executor enters the next unentered item), until every listed item the site offers is entered. Optional questions about the applicant, the role, or preferences are answered too (they help the application); only optional marketing/notification opt-ins and optional demographic fields without a stored answer stay empty.',
};

export function createState(seed) {
  return {
    answerPath: seed.answerPath,
    // Set once the run has typed an emailed verification code on that URL; the remaining code field is then expected.
    emailCodeUrl: null,
    // The application form an emailed-code sign-in was taken over (see the main loop's RETURN).
    signInReturn: null,
    codeRetried: false,
    // The posting's role title ("Software Development Intern - Breakthrough"), from the posting page's title: an apply
    // entry naming another role opens a different posting.
    targetRole: '',
    // Per-run facts for the application report (runs/summary.jsonl): posting title, resume, documents at submit.
    runInfo: {},
    // --submit lets the final submit control be clicked; it is then the run's last action.
    allowSubmit: false,
    // The requested posting's host and id (the 5+ digit number in its URL path), when it has one.
    posting: { host: '', id: '' },
    connection: undefined,
    // Closes the tabs this run opened, keeping the one it ended on (set once the tab watcher exists).
    closeRunTabs: null,
    // Why the run stopped (null when it submitted); a stop the user must finish keeps its tab held for them.
    stopReason: null,
    phase: 'arguments',
    // Label of the final-submit control clicked; the run ends once a later screen confirms the submission. A stop
    // after that click re-checks the page, so a model error on the confirmation screen does not hide a submission.
    submittedVia: null,
    // Answered fields at the last final-submit click, and how many submits came back as an emptied form.
    submitFilled: null,
    submitResets: 0,
    submitUrl: null,
    submitAt: null,
    postSubmitEmail: null,
    submitted: false,
    confirmSubmitted: null,
    runUrl: null,
    accountEmail: undefined,
    // Follow only an account-verification link for this site in fresh mail. A link already in the inbox (sent at
    // sign-up, or by an earlier run's resend) is used first; Resend is clicked only when none is there, once per run.
    verificationRequested: new Set(),
    // A site-required password reset ("you need to reset your password", or Jev chose Forgot Password for an account
    // whose stored password is rejected): after the reset request is clicked, the emailed reset link for this site is
    // opened in the application tab, and the next credentials fill there sets a fresh Keychain password (rotate).
    // One reset request per host per run, so a failing run cannot flood the inbox.
    resetRequested: new Set(),
    resetPasswords: new Map(),
    goals: [{ ...BASE_GOAL }],
    completed: [],
    targetNote: '',
    // The first screen's text (the posting itself): the cover-letter writer's description of the role.
    postingText: '',
    // The resume rewritten for this posting, started as soon as the posting text is read so the writer works while the
    // form is filled; null when it could not be built (the lane resume is uploaded instead).
    tailoredPending: null,
    // Resume uploads per page URL and file-field label (see the upload_resume check).
    uploads: new Map(),
    // Registry keys of essays the writer composed this run: they name this employer and posting, so they are never
    // saved to answers.json nor learned as the key for that label on later applications.
    essayKeys: new Set(),
    // Hosts whose password was generated this run for an account still being created (cleared by a later login).
    registering: new Set(),
    // URLs whose nearly empty screen already got one long wait before a planner stop.
    blankWaits: new Set(),
    consults: 0,
    reloads: new Map(),
    retyped: new Set(),
    // When a clicked Continue started waiting on the page captcha, per URL (see the disabled-Continue check).
    captchaPending: new Map(),
    lastMark: null,
    stalls: 0,
    lookedAgain: null,
    consultScreen: null,
    screenConsults: 0,
    // Jev's own planning pass (jevPlan) per screen: the actions it chose there, so a pick that made no progress is
    // never chosen again; DeepSeek is consulted only once Jev has planned twice on one screen, or has nothing left.
    jevPlanScreen: null,
    jevPlanTried: new Set(),
    jevPlans: 0,
    // DeepSeek's actions for one screen, run in order before Jev is asked again; dropped once the screen changes.
    queued: [],
    queuedUrl: null,
    // A consult's note becomes a lesson for that host once its actions got Jev moving again.
    pendingLesson: null,
    // Fields the executor already filled from learned.json on this run (by ref), so a rejected one is not retried.
    learnedTried: new Set(),
    // Free-text fields the writer already answered on this run (url|label), so it writes each question once.
    writeTried: new Set(),
    // Screens whose advance click was refused once for unanswered required questions (url|advance|questions).
    advanceRefused: new Set(),
    // Learn label for each filled field label (fields are learned under label or name, never a ref).
    learnAs: {},
    // Deterministic steps, tried before any model on a screen where the next move has no decision in it. Each rule
    // fires at most once per screen fingerprint: a screen that does not change after it goes to Jev as before.
    // Cheapest first: resume upload into an empty resume slot; the posting's single Apply entry when no application
    // fields are showing; then, on a screen with nothing left to fill (no empty field except optional ticks and
    // extra-document slots, no placeholder dropdown, no invalid field, no error message), its single forward step
    // (Next/Continue/Save and Continue), or with --submit and no step left, its single final submit.
    ruleTried: new Set(),
    entriesUsed: new Set(),
    ruleRepeats: new Map(),
    // Last <=6 executed action log lines for the active goal (labels only, no values).
    recent: [],
    // Executor safety refusals (pre-dispatch) exclude that action on the same screen; Jev then picks again.
    refused: { screen: null, actions: new Set() },
    // Per screen fingerprint: actions Jev's ranking picked there (no leading verdict). Kept across revisits.
    plannedTaken: new Map(),
    // Per `${screen}\0${action}`: how many times Jev chose that step there (see the stall brake).
    screenRepeats: new Map(),
    // Attempt history for Jev: executed actions plus their observed outcome on the next screen.
    history: [],
    // A site's alert/confirm blocks the page's JS thread: every later evaluate hangs to the protocol timeout and the
    // tab is later closed as frozen. Alerts (and beforeunload prompts) are accepted, confirms dismissed (they ask to
    // leave or discard); the text goes to the trace and to the driver's history.
    dialogWatched: new WeakSet(),
    removedFiles: new Set(),
    // Back steps taken toward the resume a review step reported missing; set once that report is seen.
    resumeWalk: 0,
    resumeRejected: false,
    pickerTried: new Set(),
    uploadRetries: new Map(),
    attempt: null,
    typed: {},
    // Answer key last typed into each field label; rejected values get planner-written alternatives once per key,
    // and an alternative the site then stops rejecting is saved to aliases.json for later runs.
    filledKeys: {},
    rewritten: new Set(),
    // Ref churn must not reset failed fills. Only observed, accepted mutations count toward recovery.
    fillProgress: new Map(),
    // A list answer ("Python, C#, SQL"; "English, Spanish") in a single-choice field takes one item per entry:
    // a repeatable section (Skills, Languages) has one such field per added entry. Items already entered this run (or
    // shown in a sibling entry) are skipped, an unlisted item gives way to the next, and the history tells the planner
    // which items still need their own entry. A multi-select list takes the whole answer as before.
    listPicks: new Map(),
    // Required comboboxes the executor opened to reveal their choices (once per field).
    opened: new Set(),
    // Label of the control whose click opened the current unowned option list.
    openedBy: null,
    // Each Jev plan is one semantic action; fill batches and password pairs stay together. Long applications run
    // dozens of questions per section; stalls and consult limits bound unproductive loops, this caps the whole run.
    // Any pre-dispatch refusal (invalid-plan: nothing was sent) anywhere in a pass re-observes instead of ending the
    // run; a run with this many refusals is not progressing and stops.
    redrives: 0,
    // Times the run landed on a social/review site (a badge or share link) and went back; a few at most.
    offsite: 0,
    // Reloads of a Chrome error page (the page failed to load).
    errorReloads: 0,

    // Derived per-pass values, declared where the flow computes them.
    url: null,
    values: null,
    resume: null,
    resumeAvailable: null,
    // Tabs opened after this point (e.g. an "Apply externally" link) become the working tab on the next pass.
    tabs: null,
    // A tab whose CDP session times out while attaching (Chrome busy) gets one more attempt after a pause.
    page: null,
    learned: null,
    runStarted: Date.now(),
    iteration: 0,
    current: null,
    resetHint: null,
    // A registration the site rejects because the email already has an account ("This email address is already in
    // use. Please login") is a returning candidate: the account's password is the one stored in Keychain.
    loginHint: null,
    // Ambiguous account forms only block a credentials action (which re-derives
    // identity and stops); observing/planning/clicking on such a screen is fine.
    identity: null,
    accountStatus: null,
    screen: null,
    host: null,
    plan: null,
    source: null,
    confidence: 0,
    outcome: null,
    context: null,
  };
}
