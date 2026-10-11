# Architecture

This document describes how the harness is put together: the roles, the trust boundaries, the per-screen loop, and the local state it keeps. It is written for someone reading or changing the code, not for first-time setup (see [README](../README.md)).

## Design principles

- **One process, one browser connection.** A single CLI process owns one Chrome CDP connection for an entire application. There is no broker, worker pool, or journal service.
- **Deterministic code is authoritative on safety.** Models choose among offered options; the executor validates every action against a fresh snapshot, resolves answer keys to local values, and refuses anything unsafe or unknown.
- **Models never see secrets.** Passwords and Keychain-stored credential values, the resume file path, and raw HTML are never sent to any model, and browser URL query strings and fragments are stripped from the structured URL metadata. Visible page text and verification-email text are sent as untrusted input and may themselves display URLs. One role-specific exception: when deterministic email matching cannot safely choose a verification code, the configured planner may receive bounded verification-email sender/subject/body excerpts and candidate emailed codes (with http/https links stripped). Everything else a model receives is bounded and role-specific (see [Trust boundaries](#trust-boundaries)).
- **No applicant-specific branches.** Personal paths, facts, institutions, and model choices come from `config.json` and `answers.json`, never from hard-coded values. Vendor-specific adaptations (for example, generic handling of Workday/iCIMS/Handshake page behavior) may remain where they implement that behavior generically rather than encoding one applicant’s data.

## Roles

| Role | Who | Does | Never |
|---|---|---|---|
| **Planner** | Configured planner backend (default: native DeepSeek) | Consulted only when the driver stays stuck on a screen. Returns concrete actions on current refs, revised guidance/goals, or a stop. A note that unstuck the driver becomes a per-host lesson in `learned.json`. | See passwords; execute anything itself |
| **Writer** | Configured writer backend (default: OpenRouter model) | Composes first-person free-text answers from local facts/qa/resume within each field’s limit, and rewrites rejected ones. Accepted answers are saved to the `qa` registry. | Answer passwords/SSN/birth date/signatures; see passwords |
| **Driver** | Configured driver backend (OpenRouter Decisions) | Every screen: one typed request — a choice over current refs for the active goal, a goal-done probability, and field→answer-key choices. Also matches a stored answer to a dropdown option once. | Generate text/code, see passwords |
| **Executor** | Deterministic code (`apply.mjs`, `lib/*`) | Snapshot, hard gates, ref validation, local answer resolution, learned replay, Keychain access, trusted actions, submission confirmation. | Delegate safety to any model |

Model backends are selected in `config.json`. The public example uses OpenRouter for writer and fallback and a native DeepSeek planner. `omp` is an explicitly configured local option, never an implicit fallback; runtime code does not read private credential databases.

## File map

| File | Responsibility |
|---|---|
| `lib/config.mjs` | Load/validate/normalize `config.json`; expand paths; read API-key environment names (`loadConfig`, `expandConfigPath`, `requireSecret`). |
| `lib/browser.mjs` + `lib/browser/` | Chrome CDP connect (`endpoint`: DevToolsActivePort discovery and launch; `transport`: websocket attach-or-launch), `tabs` (the `tabs.json` registry), `manage` (tab open/reuse, trimming, popup adoption), `front`. |
| `lib/snapshot.mjs` + `lib/snapshot/` | In-page DOM snapshot with stable refs and gate detection. The in-page program is assembled from ordered fragments (`core`, `text`, `labels`, `discovery`, `scan`, `groups`, `options`, `output`) that share one scope in the page; part order matters. |
| `lib/act.mjs` + `lib/act/` | Trusted click/type/select/upload/press by ref; `resolve` (ref → element handle), `press`, `select-helpers` (ARIA/custom dropdowns and search companions). |
| `lib/rules.mjs` | Deterministic control classification, answer matching, and final-submit safety. |
| `lib/planner.mjs` + `lib/planner/` | Planner backend: tool-free call returning an ordered goal list or guidance. `backend` (HTTP/omp transport, pricing), `input` (bounded prompt data), `plan-output` (plan parsing/validation), `answers`, `documents`, `codes`, `system-prompt`, `logistics`, `limits`. |
| `lib/jev.mjs` + `lib/jev/` | Driver backend: one request per screen returning a local action and confidence. `transport` (metered Decisions call), `state` (bounded screen state), `questions`, `fields`, `constants`. |
| `lib/answers.mjs` | `answers.json` load/save and question normalization. |
| `lib/credentials.mjs` | Keychain generate/store/fill for employer accounts. |
| `lib/email.mjs` | Read-only Gmail access: verification codes and links, and message/thread reads for reply tracking. |
| `lib/mail/` | Deterministic mail tracking, used by `mail.mjs`: `postings` (attempted postings as match candidates), `inbox` (read-only job-mail indexing and outreach threads), `match` (employer keys and sender/subject matching), `classify` (reply kind, stated deadline, action link), `todos` (posting status and to-do items), `store` (`runs/mail*.json`), `print` (console views). |
| `apply.mjs` + `lib/apply/` | CLI entry; `session` owns the Chrome session and the observe → drive → validate → act loop over one per-run `state` (ctx) object. Each pass (`pass`) runs `preflight` (gates, sign-in, stops) → `prepare` (screen context, uploads) → `choose` (rule plan, then model consult) → `execute` (fills, clicks, advance). Helpers: `observer`, `observe`, `screen`, `controls`, `plan`, `steprules`, `pick`/`picker`, `accounts`, `emailcode`, `writer`, `values`, `fields`, `confirm`, `stop`, `runtime`. |
| `queue.mjs`, `discover.mjs`, `report.mjs`, `mail.mjs` | Queue execution, posting discovery, run/application reporting, and employer-reply/outreach sync. |
| `setup.mjs` + `lib/setup/` | Idempotent local setup and read-only doctor: `scaffold`, `dotenv`, `checks`, `report`, `fsutil`, `paths`. |

## Trust boundaries

- **Each model receives bounded, role-specific data.** The **planner** receives bounded screen data, the applicant’s facts and `qa` values, resume-derived material, and visible page text; the **writer** receives the applicant’s facts, `qa`, resume bullets, the optional `profile.md` dossier, and the field/question text, and its prose becomes the free-text answers and drafted documents; the **driver** receives bounded screen data (labels, types, options, and the current non-secret field values on the active form) plus answer key names and their current non-secret values. Passwords and Keychain-stored credential values, the resume file path, and raw HTML are excluded from every request, and browser URL query strings/fragments are stripped from the structured URL metadata. Visible page text and verification-email text are sent as untrusted data and may themselves display URLs or query strings. When deterministic email matching cannot safely choose a verification code, the planner additionally receives bounded verification-email sender/subject/body excerpts and candidate emailed codes (http/https links are stripped before that prompt).
- **Structured fills are resolved locally by key.** For a structured `fill`, a model only names a key (`facts.email`, `qa.<normalized question>`); the executor looks up the value from `answers.json`. Only the writer supplies raw text (free-text answers and drafted documents); model output can never supply a raw value for a structured fill of a stored answer.
- **Uploads are restricted.** Only the configured resume, its posting-tailored rewrite (validated against the resume sources: same role headings, dates, and numbers; one page), or a writer-drafted document (cover letter, or an instructed “other documents” slot) is uploaded, and only into a current resume/document field.
- **Refs are revalidated.** Every action is checked against a fresh snapshot before it runs; a stale ref is rejected, and a queued action whose ref vanished drops the rest of that queue because the screen moved on.
- **Passwords are not a stop.** `lib/credentials.mjs` generates and fills employer-account passwords from the configured credential backend. Password values never appear in prompts, logs, snapshots, or reports.
- **Reply tracking is local and read-only.** `mail.mjs` only issues Gmail GETs; matching and classification are fixed patterns in `lib/mail/`, so no mail reaches a model.

## A run, step by step

The loop is bounded (max 300 actions) and exits `0` for a safe terminal state.

1. **Goal.** Each run starts on one fixed goal (“complete this application”) with built-in guidance; there is no up-front planner call.
2. **Observe.** `lib/snapshot.mjs` records visible, enabled controls and fields across every frame (including cross-origin embedded forms) and open shadow roots. CAPTCHA, payment, and MFA/OTP conditions are detected as gates before any model call.
3. **Drive.** Plan sources are tried cheapest-first: queued planner actions for this screen; then `learned.json` field replays and registry-answered dropdowns (no model call); then the writer for free-text questions; then deterministic rules (each at most once per screen), such as uploading the resume into an empty slot, clicking a posting’s only apply entry, ticking a required acknowledgement under `--submit`, and advancing with a Next/Continue step when nothing is left to fill.
4. **Write.** Empty free-text questions are answered up front by the writer from local facts, `qa`, resume bullets, and the optional `profile.md` dossier. Short factual questions get a plain answer; essays are drafted as candidates and one is selected. Text questions the `qa` registry already answers are filled from it first.
5. **Escalate.** When the driver’s choice is not confident enough, or it repeats on an unchanged screen, the executor opens any empty required combobox, re-asks the driver once, then consults the planner, whose concrete actions run through the same executor checks. Consult budgets bound the loop.
6. **Execute.** Each action is revalidated against a fresh snapshot. Refused actions (back/cancel/save-for-later/destructive/payment/stale/occupied/opt-in; attestation ticks without `--submit`) are skipped and the driver redrives. Choice fields are opened and re-observed before matching a stored answer against their own options. Accepted fills are verified by screen URL and field label, not transient refs.
7. **Trace.** Every run writes a JSONL trace under the ignored `runs/` directory.

Logging shows `PLAN <goals>` when the planner plans and `JEV <action> <label> conf=<c>` for each executed choice.

## Snapshot and refs

`lib/snapshot.mjs` returns `{ url, title, controls, fields, gates }`.

- **Controls** are `button | link | option`, each with a stable `ref`, an optional `formRef` (including external `form="<id>"` controls), a label, and a form-field count. Open custom dropdowns contribute `option` controls.
- **Fields** carry `ref`, optional `formRef`, tag/type, label, name, `required`, `occupied`, and options. Password values are always empty; file values are reported as `attached` when occupied.
- **Refs** are stable strings. Main-frame refs are `e<N>`; child-frame refs encode the frame’s CDP id (`f<frameId>:e<N>`), and shadow-root refs are resolved by traversing the open roots. Actions re-find the exact frame or reject the ref as stale.
- **Gates** detect captcha, payment, and MFA/OTP conditions. They are checked before filling.

## Final-submit safety

`lib/rules.mjs` classifies controls (`apply-entry`, `step`, `final-submit`, `login`, `other`). Form ownership wins: an apply-like control inside a nonempty form is a final submit regardless of its label. The executor:

- refuses any `final-submit` click unless `--submit` is set;
- clicks the final submit at most once, then confirms the submission on a later screen (no submit control and no empty required field) before reporting `SUBMITTED`;
- never ticks marketing/SMS/newsletter/job-alert/talent-pool/future-contact opt-ins;
- refuses social/third-party sign-in, cloud document pickers, passkeys, policy links that would abandon a filled form, and unrelated posting or navigation controls;
- hides date-of-birth pickers from model choice so no model picks a date.

Applications ran without `--submit` stop before the final submit and leave the page open for the user.

## Local state

All of the following are ignored by Git and stay on the machine:

- `config.json`, `.env` — local configuration and secrets.
- `answers.json` — `facts` and the reusable `qa` registry.
- `profile.md` — optional writing dossier.
- `learned.json` — accepted field mappings, choice aliases, per-host lessons, and `noAnswer` optional-field labels (skipped by the forward rule and by Jev's field questions).
- `aliases.json` — equivalent forms and site-accepted alternatives for facts.
- `tabs.json` — posting→tab resume state.
- `queue.tsv`, `runs/` — queued work, per-run traces, logs, and reports; `runs/mail.json` holds the last mail sync (indexed job email, to-dos, posting status, outreach threads, and the cached text and links of indexed mail) and `runs/mail-done.json` the to-dos you marked handled.

## Configuration flow

`lib/config.mjs` is the single source of configuration. It parses and validates `config.json`, rejects unknown keys, expands `~` and repo-relative paths, and exposes a cached, deeply frozen normalized object. Consumers call `loadConfig()` and `requireSecret(name)`; they do not read `config.json` or API-key environment variables directly, and there is no consumer-side defaulting or path expansion.
