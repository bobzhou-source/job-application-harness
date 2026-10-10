# Job Application Harness

A Bun CLI that completes browser-based job applications in a dedicated Chrome profile. It observes the current form, chooses actions with configured language models, resolves applicant facts locally, and executes every browser mutation through deterministic safety checks.

The harness can work one posting at a time, process a queue, discover postings from a configured Handshake site, and produce application reports. It keeps resumable local state, but it is not a hosted service: Chrome, credentials, answers, traces, and generated documents remain on your machine.

See [Architecture](docs/ARCHITECTURE.md) for the runtime design and trust boundaries.

## Safety model

The executor—not a model—has final authority over every click, fill, upload, and navigation. Actions are checked against a fresh page snapshot, and stale or unsafe actions are refused.

By default, the harness fills and advances through an application but stops before the final submission. Passing `--submit` authorizes only the steps required to complete the application:

- clicking the final application submit control;
- accepting required application attestations such as “I certify” or “I acknowledge”;
- confirming that the site moved to a submitted state.

Separately from submission, and only when read-only email automation is enabled, the harness may read a relevant verification code or link from the configured inbox and use it to continue the same application.

Even with `--submit`, the harness never:

- selects marketing, SMS, newsletter, job-alert, talent-pool, or future-contact opt-ins;
- uses social or third-party sign-in, cloud document pickers, or passkeys;
- withdraws an application, deletes an account or existing application, or follows unrelated posting/navigation controls;
- sends, replies to, deletes, archives, labels, or otherwise changes email;
- supplies payment information;
- exposes passwords to models, logs, snapshots, or reports.

Some steps always belong to the user:

- CAPTCHA and human-verification challenges;
- SMS codes, authenticator codes, and other MFA/OTP challenges (an emailed code is the only exception when read-only email automation is configured);
- date of birth entry and date-picker interaction;
- unsupported required documents or unknown applicant facts.

The harness waits or stops safely at these gates and leaves the application tab open. `--submit` is authorization to submit an application, not permission to bypass these boundaries.

## Prerequisites

Required:

- [Bun](https://bun.sh/) and the repository dependencies (`bun install`);
- Google Chrome or Chromium with a configured executable path;
- an OpenRouter API key for the Decisions driver and for the default writer/fallback backends;
- a DeepSeek API key when the example native DeepSeek planner configuration is retained;
- a resume PDF readable at the path selected by `resumes.filePattern`.

Additional tools and platform limits:

- `pdftotext` is **required**: doctor checks it, and the writer uses it to extract resume material for written answers.
- `pdflatex`, `resumes.factsFile`, and `resumes.latexPreamble` are conditional: needed only when document generation (cover letters, instructed documents) is configured.
- Employer password storage currently supports only macOS Keychain. Selecting `credentials.backend: "macos-keychain"` on another platform produces an actionable error.
- `notifications.backend: "macos-osascript"` is macOS-only. The public example uses portable console notifications.
- Read-only Gmail verification is optional and disabled in the public example. Enabling it requires a compatible local multi-Gmail MCP server and its credential files.
- `omp` is optional. It is used only when a model backend is explicitly set to `"omp"` in your local configuration; there is no implicit credential or model fallback to it.

## Quick start

```sh
bun install
bun setup.mjs
```

Setup creates the following ignored local files only when they do not already exist:

- `config.json` from `config.example.json`;
- `answers.json` from `answers.example.json`;
- `.env` from `.env.example`.

It never replaces an existing local file or a nonempty value, and it never prints a secret. If `.env` already exists, setup may append a missing key found by the one-time legacy migration and enforces `0600` permissions on it. Edit the generated files, then run the read-only doctor again:

```sh
bun setup.mjs --doctor
```

Add API keys to `.env` (never commit it):

```dotenv
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

Fill `answers.json` with your real applicant facts, update the resume and browser paths in `config.json`, and keep all placeholders out of your local configuration. Doctor exits successfully with:

```text
OK: harness is ready
```

On first use, Chrome may require remote-debugging approval. Follow the diagnostic prompt, approve it at `chrome://inspect/#remote-debugging`, and rerun the command. The harness uses its configured dedicated Chrome profile so application tabs can be resumed.

## Usage

### Apply to one posting

```sh
bun apply.mjs <job-url> [--resume /path/to/resume.pdf] [--answer "Question=Answer"]... [--submit]
```

- `--resume` overrides `facts.resume` for that run.
- `--answer` adds or updates a reusable answer in the local `qa` registry.
- Without `--submit`, the final submit is refused and legal attestations remain for the user.
- With `--submit`, the final submit and required attestations are allowed within the safety limits above.

A stopped run keeps its application page open. A confirmed submitted run closes the tabs it used. The posting URL is associated with its tab in the ignored `tabs.json`, allowing a later run to resume after site navigation.

### Discover postings

```sh
bun discover.mjs [--query "software engineer intern"]... [--pages 2] [--max 40] [--dry-run]
```

Discovery uses the configured sources (Handshake searches and/or a public listings feed), title filters, resume lanes, and season rules. It appends new rows to the ignored `queue.tsv` as:

```text
url<TAB>lane<TAB>name
```

Use `--dry-run` to inspect matches without changing the queue.

### Process the queue

```sh
bun queue.mjs [--discover] [--limit N]
```

The queue runs one application at a time with `--submit`, using the configured timeout and gate wait. `--discover` refills an empty queue. Results and per-job logs are written beneath the ignored `runs/` directory.

Review `queue.tsv` and your local answers before running the queue: queued execution includes final-submit authorization.

### Report results

```sh
bun report.mjs
bun report.mjs --apps [--since ISO]
```

The default report summarizes per-run telemetry. `--apps` folds all attempts for each posting into an application tracker and writes `runs/applications.csv`, including status, next actor, attempts, time, model cost, and submitted document information.

## Configuration reference

`config.json` is JSON without comments. Unknown keys are errors so misspellings cannot silently change behavior. Paths may be absolute, start with `~`, or be relative to the repository root; environment-variable interpolation inside paths is not supported.

The complete schema is:

```json
{
  "browser": {
    "executable": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "profileDir": "~/.job-app-chrome",
    "debugHost": "127.0.0.1",
    "debugPort": 0,
    "maxTabs": 4
  },
  "resumes": {
    "directory": "~/Documents/resumes",
    "filePattern": "resume_{lane}.pdf",
    "fallbackLane": "general",
    "factsFile": "MASTER-FACTS.md",
    "latexPreamble": "_preamble.tex"
  },
  "discovery": {
    "handshakeBaseUrl": "https://your-school.joinhandshake.com",
    "queries": ["software engineer intern"],
    "includeTitlePattern": "software|developer|data",
    "excludeTitlePattern": "full[- ]time|senior|manager",
    "lanes": [
      { "name": "general", "titlePattern": ".*" }
    ],
    "specialLane": {
      "name": "general",
      "employerPattern": "(?!)"
    },
    "season": {
      "primaryStartMonths": ["May", "Jun", "Jul"],
      "shortTermStartMonth": "Jan",
      "shortTermEndMonths": ["Jan", "Feb"]
    }
  },
  "models": {
    "driver": {
      "backend": "openrouter-decisions",
      "model": "typesafe/jev-1.13",
      "endpoint": "https://openrouter.ai/api/alpha/decisions",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "planner": {
      "backend": "openai-compatible",
      "model": "deepseek-v4-flash",
      "endpoint": "https://api.deepseek.com/chat/completions",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    },
    "fallback": {
      "backend": "openrouter",
      "model": "anthropic/claude-haiku-4-5",
      "endpoint": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "writer": {
      "backend": "openrouter",
      "model": "anthropic/claude-sonnet-5-5",
      "endpoint": "https://openrouter.ai/api/v1/chat/completions",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  },
  "applicant": {
    "displayName": "Alex Example",
    "coverLetterHeading": "",
    "relocateAnywhere": false,
    "workInPerson": false,
    "summerAvailability": ""
  },
  "email": {
    "enabled": false,
    "accountLabel": "",
    "mcpServer": "~/.local/share/multi-gmail-mcp/gmail-mcp.js",
    "tokenDatabase": "~/.gmail-mcp-tokens.db",
    "oauthCredentials": "~/.gmail-mcp-oauth.json"
  },
  "credentials": {
    "backend": "macos-keychain",
    "servicePrefix": "job-app:"
  },
  "notifications": {
    "backend": "console",
    "title": "Job harness",
    "sound": "Glass"
  },
  "queue": {
    "runTimeoutSeconds": 900,
    "gateWaitSeconds": 300
  },
  "runtime": {
    "debug": false
  }
}
```

### Browser

- `executable`: Chrome/Chromium executable.
- `profileDir`: dedicated automation profile.
- `debugHost`: must remain a loopback address.
- `debugPort`: integer from `0` through `65535`; `0` uses Chrome’s dynamic port file.
- `maxTabs`: maximum tabs retained by the automation browser; default `4`. Each tab is a Chrome renderer (roughly 150–300 MB), so keep this low on 8–16 GB machines.

### Resumes and documents

- `directory`: base directory for resumes and document-generation inputs.
- `filePattern`: basename containing `{lane}` exactly once.
- `fallbackLane`: must equal one configured discovery lane name.
- `factsFile` and `latexPreamble`: basenames resolved beneath `resumes.directory`.

For a lane named `general`, the example pattern resolves to `resume_general.pdf`. Queue construction and report validation use this same pattern.

When a lane variant has a LaTeX source beside it (`resume_general.tex` next to `resume_general.pdf`) and document generation is available, each run asks the writer to tailor that variant to the posting: reorder and reword bullets toward what the posting asks for, using only the variant, the other variants, and the facts file. The result must keep the letterhead line, the Education section, every role heading, date, and number from the sources, and compile to one page; otherwise the run uploads the untailored variant. Tailored PDFs keep the variant's file name and are cached per posting under `resumes.directory/tailored/<hash>/`, so you can review exactly what was sent.

### Discovery

- `handshakeBaseUrl`: HTTPS origin with no credentials, query, or fragment.
- `queries`: default search terms used when no CLI query is supplied.
- `includeTitlePattern` and `excludeTitlePattern`: regular-expression strings applied to titles.
- `excludeEmployerPattern` (optional): regular-expression string applied to employer names; matching postings are never queued (employers you apply to by hand or have paused).
- `lanes`: ordered lane names and title patterns; the first matching lane wins.
- `specialLane`: an employer pattern checked before title lanes.
- `season`: primary start months plus an optional short-term start/end window.
- `sources` (optional, default `["handshake"]`): `handshake` searches the configured Handshake site; `listings` reads a public internship listings feed and queues the employer's own posting URLs.
- `listings` (required with the `listings` source): `url` of a JSON array in the SimplifyJobs `listings.json` format (`company_name`, `title`, `url`, `active`, `is_visible`, `terms`, `locations`, optional `degrees`), the `terms` to accept (`["Summer 2027"]`), and a `locationPattern` regular expression one listed location must match. Listings are queued newest first; postings an earlier Handshake run already applied through are skipped.

Lane names must be unique, nonempty, and safe for both `queue.tsv` and filename substitution. All configured regular expressions must compile.

### Models

The driver backend is exactly `openrouter-decisions`. Planner, fallback, and writer backends may be:

- `openai-compatible`: configured HTTPS endpoint, model, and API-key environment name;
- `openrouter`: configured HTTPS endpoint, model, and API-key environment name;
- `omp`: explicit local backend with a model; endpoint and API-key fields are not used.

The public configuration uses OpenRouter for writer and fallback. `omp` is never selected implicitly, and runtime code does not read private credential databases. Missing secrets are reported by environment-variable name without revealing values.

### Applicant preferences

- `displayName`: signature name for generated documents.
- `coverLetterHeading`: optional local letterhead text.
- `relocateAnywhere` and `workInPerson`: factual preferences included only when true.
- `summerAvailability`: included only when nonempty.

False or empty values mean “do not make this claim”; they are not converted to a negative claim. `displayName` and `coverLetterHeading` must be appropriate when document generation is used.

### Email, credentials, notifications, queue, and runtime

- `email.enabled`: enables read-only verification automation. When false, email verification stops for manual completion. When true, `accountLabel`, `mcpServer`, `tokenDatabase`, and `oauthCredentials` must identify readable local resources.
- `credentials.backend`: currently `macos-keychain` only. `servicePrefix` defaults to `job-app:`.
- `notifications.backend`: `console` or macOS-only `macos-osascript`; `title` and `sound` configure notifications.
- `queue.runTimeoutSeconds`: per-application timeout; default `900`.
- `queue.gateWaitSeconds`: time allowed for a user gate; default `300`.
- `runtime.debug`: enables debug output.

API keys are the only environment configuration. All other settings belong in `config.json`.

## Local answers and learning

`answers.json` has two top-level objects:

- `facts`: applicant data such as preferred and legal names, contact details, education, work authorization, sponsorship, and the default resume path. Month/year values produce common date forms, and phone values produce a digits-only form.
- `qa`: reusable answers keyed by normalized question text. The harness saves accepted categorical choices and generated free-text answers here. Edit or remove an entry to correct future behavior.

The example is intentionally fictional. Replace every value with your own facts, and never commit `answers.json`.

Other ignored local inputs and caches:

- `profile.md`: optional writing dossier containing stories, voice, themes, and “do not” guidance.
- `learned.json`: accepted field mappings, choice aliases, and per-host lessons from successful recoveries.
- `aliases.json`: equivalent forms and site-accepted alternatives for stored facts.
- `tabs.json`: posting-to-tab resume state.
- `queue.tsv` and `runs/`: queued work, traces, logs, and reports.

### What leaves your machine

Runs call the model providers you configure, so some local data is sent to them. The planner and writer backends receive your applicant facts, `qa` answers, resume-derived material, the optional `profile.md` dossier, and the relevant visible page text; the driver receives bounded screen data plus answer key names and their current non-secret values. Passwords and Keychain-stored credential values, the resume file path, and raw HTML are never sent, and browser URL query strings/fragments are stripped from the structured URL metadata. Visible page text and verification-email text are sent as untrusted input and may themselves display URLs. One exception: when deterministic email matching cannot safely choose a verification code, the configured planner may receive bounded verification-email sender/subject/body excerpts and candidate emailed codes, with http/https links stripped first.

Because stored facts and `qa` answers are shared with third-party providers, keep any value you would not send to a model provider out of `answers.json`, and review your providers’ data policies before running. See [Architecture](docs/ARCHITECTURE.md) for the full boundary.

## Costs

Model usage varies by site and by how much recovery or free-text writing is needed. As a practical planning figure:

- about **$0.04 per typical submitted application**;
- about **$0.11 per submission on average when hard sites are included**.

These are estimates, not spending caps. Review each run’s telemetry with `bun report.mjs`; costs can change with provider pricing, model selection, retries, long forms, and generated writing.

## Troubleshooting

### `Configuration not found`

Run `bun setup.mjs`, then edit `config.json`. Setup does not overwrite your existing `config.json`, and it preserves nonempty values in the other local files.

### Doctor reports a missing key

Add the named variable to `.env` and rerun `bun setup.mjs --doctor`. Do not put API keys in `config.json`.

### Chrome cannot connect

Confirm `browser.executable` exists, the parent of `browser.profileDir` is writable, and Chrome’s remote-debugging approval has been granted at `chrome://inspect/#remote-debugging`. A missing or stale `DevToolsActivePort` before launch is only a warning; the harness can launch its configured Chrome.

### A resume or lane is missing

Ensure `resumes.directory` exists, `filePattern` contains `{lane}` exactly once, `fallbackLane` names a configured lane, and the resulting PDF is readable. Doctor reports each lane separately.

### Document generation is unavailable

Install `pdftotext` for resume extraction. Install `pdflatex` and provide the configured facts and preamble files for generated letters or instructed documents.

### A field is unknown or rejected

Add the fact or normalized question to `answers.json`, or rerun with `--answer "Question=Answer"`. Correct stale entries in `answers.json`, `learned.json`, or `aliases.json` rather than forcing an unsafe click.

### The run stops at CAPTCHA, MFA, DOB, or a document request

Complete the user-only step in the retained browser tab, add the missing document/fact if applicable, and rerun. The stop is intentional.

### Email verification says automation is disabled

Complete verification manually, or enable `email.enabled` and configure all required local Gmail MCP paths and the account label. Email access remains read-only.

### Keychain or notification backend is unsupported

The Keychain credential backend and `macos-osascript` notifications require macOS. On other platforms use console notifications; employer credential automation is unavailable until another credential backend is implemented.

### A run stops before submit

This is expected without `--submit`. Review the completed form and submit manually, or rerun the posting with `--submit` after reviewing the safety model.

## License

MIT. See [LICENSE](LICENSE).
