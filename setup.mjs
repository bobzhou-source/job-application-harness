#!/usr/bin/env bun

import { access, chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const HELP = `Usage: bun setup.mjs [--doctor] [--help]

Prepare and diagnose the job-application harness.

Options:
  --help    Show this help and exit without changing anything
  --doctor  Run read-only diagnostics; never copy files, launch Chrome, or call a model

With no options, setup copies the missing example files (config.json,
answers.json, .env), migrates legacy API keys without printing them, sets
.env permissions to 0600, and then runs the doctor.`;

const FILE_COPIES = [
  ["config.example.json", "config.json"],
  ["answers.example.json", "answers.json"],
  [".env.example", ".env"],
];

const LEGACY_KEYS = [
  { envName: "OPENROUTER_API_KEY", provider: "openrouter" },
  { envName: "DEEPSEEK_API_KEY", provider: "deepseek" },
];

const PUBLIC_PLACEHOLDERS = {
  handshakeBaseUrl: "https://your-school.joinhandshake.com",
  displayName: "Alex Example",
  resumeDirectory: "~/Documents/resumes",
  answersEmail: "alex.doe@example.com",
  answersResume: "/absolute/path/to/your/resume.pdf",
};

function printHelp() {
  console.log(HELP);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(path) {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function parseDotenvValue(raw) {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return value.slice(1, -1).trim();
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).trim();
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function readDotenvEntries(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) entries.set(match[1], parseDotenvValue(match[2]));
  }
  return entries;
}

function setDotenvEntry(text, name, value) {
  const assignment = `${name}=${JSON.stringify(value)}`;
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => matcher.test(line));
  if (index >= 0) lines[index] = assignment;
  else {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(assignment);
  }
  const result = lines.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

async function queryLegacyKey(provider) {
  const database = join(homedir(), ".omp", "agent", "agent.db");
  if (!(await isReadable(database))) return "";

  const sql = `select json_extract(data, '$.key') from auth_credentials where provider = '${provider}' and credential_type = 'api_key' limit 1`;
  try {
    const proc = Bun.spawn(["sqlite3", database, sql], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, output] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return exitCode === 0 ? output.trim() : "";
  } catch {
    return "";
  }
}

async function copyMissingExamples() {
  for (const [sourceName, destinationName] of FILE_COPIES) {
    const source = join(ROOT, sourceName);
    const destination = join(ROOT, destinationName);
    if (await exists(destination)) {
      console.log(`[OK] ${destinationName} already exists; left unchanged`);
      continue;
    }
    if (!(await isReadable(source))) {
      throw new Error(`Cannot create ${destinationName}: missing ${sourceName}. Restore ${sourceName} and rerun: bun setup.mjs`);
    }
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    console.log(`[OK] Created ${destinationName} from ${sourceName}`);
  }
}

async function migrateLegacyKeys() {
  const envPath = join(ROOT, ".env");
  let text = await readFile(envPath, "utf8");
  let entries = readDotenvEntries(text);
  const missing = [];

  for (const { envName, provider } of LEGACY_KEYS) {
    if (entries.get(envName)?.trim()) {
      console.log(`[OK] ${envName} is present in .env`);
      continue;
    }

    const value = process.env[envName]?.trim() || await queryLegacyKey(provider);
    if (!value) {
      console.error(`[ERROR] Missing ${envName}. Add it to .env (see .env.example).`);
      missing.push(envName);
      continue;
    }

    text = setDotenvEntry(text, envName, value);
    entries = readDotenvEntries(text);
    process.env[envName] = value;
    console.log(`[OK] Migrated ${envName} into .env`);
  }

  await writeFile(envPath, text, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600);
  console.log("[OK] .env permissions are 0600");
  return missing;
}

function makeReporter() {
  let errorCount = 0;
  const fixes = new Set();
  return {
    ok(message) {
      console.log(`[OK] ${message}`);
    },
    warn(message, fix) {
      console.warn(`[WARN] ${message}`);
      if (fix) fixes.add(fix);
    },
    error(message, fix) {
      console.error(`[ERROR] ${message}`);
      errorCount += 1;
      if (fix) fixes.add(fix);
    },
    finish() {
      if (errorCount === 0) {
        console.log("OK: harness is ready");
        return true;
      }
      console.error("ERROR: harness is not ready");
      console.error("Fix the following, then run: bun setup.mjs --doctor");
      for (const fix of fixes) console.error(`- ${fix}`);
      return false;
    },
  };
}

async function checkRuntimeAndDependencies(report) {
  if (typeof Bun === "undefined") {
    report.error("Setup and the doctor must run under Bun", "Install Bun, then run `bun setup.mjs --doctor`.");
  } else {
    report.ok(`Bun ${Bun.version} is running`);
  }

  try {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const dependencies = Object.keys(manifest.dependencies ?? {});
    const missing = dependencies.filter((dependency) => {
      try {
        require.resolve(dependency);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length) {
      report.error(`Dependencies are not installed: ${missing.join(", ")}`, "Run `bun install`.");
    } else {
      report.ok(`Dependencies installed (${dependencies.length})`);
    }
  } catch (error) {
    report.error(`Cannot read package dependencies: ${error.message}`, "Restore package.json, then run `bun install`.");
  }
}

function publicPlaceholderFields(config) {
  const fields = [];
  if (config.discovery.handshakeBaseUrl === PUBLIC_PLACEHOLDERS.handshakeBaseUrl) {
    fields.push("discovery.handshakeBaseUrl");
  }
  if (config.applicant.displayName === PUBLIC_PLACEHOLDERS.displayName) {
    fields.push("applicant.displayName");
  }
  if (config.resumes.directory === resolve(PUBLIC_PLACEHOLDERS.resumeDirectory.replace("~", homedir()))) {
    fields.push("resumes.directory");
  }
  return fields;
}

async function loadValidatedConfig(report) {
  try {
    const configModule = await import("./lib/config.mjs");
    const config = configModule.loadConfig();
    report.ok("config.json parses and validates");

    const placeholders = publicPlaceholderFields(config);
    if (placeholders.length) {
      report.error(
        `config.json still contains public placeholders: ${placeholders.join(", ")}`,
        "Edit those fields in config.json for this machine and applicant.",
      );
    } else {
      report.ok("config.json has no public placeholder host, name, or resume path");
    }

    return { config, configModule, isPublicConfig: placeholders.length > 0 };
  } catch (error) {
    report.error(error.message, "Run `bun setup.mjs`, then correct the named field in config.json.");
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function checkAnswers(report) {
  try {
    const answers = JSON.parse(await readFile(join(ROOT, "answers.json"), "utf8"));
    if (!isPlainObject(answers.facts) || !isPlainObject(answers.qa)) {
      report.error("answers.json must contain object-valued facts and qa sections", "Fix answers.json using answers.example.json as the shape reference.");
      return;
    }
    report.ok("answers.json parses and contains facts and qa");

    const placeholders = [];
    if (answers.facts.email === PUBLIC_PLACEHOLDERS.answersEmail) placeholders.push("facts.email");
    if (answers.facts.resume === PUBLIC_PLACEHOLDERS.answersResume) placeholders.push("facts.resume");
    if (placeholders.length) {
      report.error(`answers.json still contains example placeholders: ${placeholders.join(", ")}`, "Replace the example email and resume path in answers.json.");
    } else {
      report.ok("answers.json has no example email or resume-path placeholders");
    }
  } catch (error) {
    const message = error?.code === "ENOENT" ? "answers.json is missing" : "answers.json is not valid JSON";
    report.error(message, "Run `bun setup.mjs`, then fill in answers.json.");
  }
}

async function checkChrome(config, report) {
  if (await isExecutable(config.browser.executable)) {
    report.ok("Chrome executable is present and executable");
  } else {
    report.error("The configured Chrome executable is missing or not executable", "Set browser.executable in config.json to an executable Chrome or Chromium binary.");
  }

  if (await exists(config.browser.profileDir)) {
    if (await isWritable(config.browser.profileDir)) {
      report.ok("Chrome profile directory is writable");
    } else {
      report.error("The Chrome profile directory is not writable", "Make browser.profileDir writable, or change browser.profileDir in config.json.");
    }
  } else if (await isWritable(dirname(config.browser.profileDir))) {
    report.ok("Chrome profile parent directory is writable");
  } else {
    report.error("The Chrome profile parent directory is missing or not writable", "Create the parent of browser.profileDir and make it writable, or change browser.profileDir in config.json.");
  }

  if (!config.browser.debugPort) {
    report.ok("Chrome uses a dynamic debug port");
  }

  const activePortPath = join(config.browser.profileDir, "DevToolsActivePort");
  if (await isReadable(activePortPath)) {
    report.ok("Chrome DevToolsActivePort is present");
  } else {
    report.warn("DevToolsActivePort is missing or stale; the harness can still launch Chrome", "Start the harness once to launch its configured Chrome profile.");
  }
}

async function checkDocuments(config, report, documentsConfigured) {
  if (commandPath("pdftotext")) {
    report.ok("pdftotext is available");
  } else {
    report.error("pdftotext is not available", "Install Poppler so that `pdftotext` is on PATH.");
  }

  if (commandPath("pdflatex")) {
    report.ok("pdflatex is available");
  } else if (documentsConfigured) {
    report.error("pdflatex is required by the configured document generation", "Install a TeX distribution providing `pdflatex`, or clear applicant.coverLetterHeading to disable document generation.");
  } else {
    report.warn("pdflatex is unavailable; document generation will be disabled", "Install a TeX distribution providing `pdflatex` to generate documents.");
  }

  for (const [label, path, fix] of [
    ["Resume facts file", config.resumes.factsPath, `Create ${config.resumes.factsFile} under resumes.directory`],
    ["LaTeX preamble", config.resumes.preamblePath, `Create ${config.resumes.latexPreamble} under resumes.directory`],
  ]) {
    if (await isReadable(path)) {
      report.ok(`${label} is readable`);
    } else if (documentsConfigured) {
      report.error(`${label} is missing or unreadable`, `${fix}, or clear applicant.coverLetterHeading to disable document generation.`);
    } else {
      report.warn(`${label} is unavailable; document generation will be disabled`, `${fix}.`);
    }
  }
}

async function checkResumes(config, report, isPublicConfig) {
  const laneNames = [...config.discovery.lanes.map((lane) => lane.name)];
  if (!laneNames.includes(config.discovery.specialLane.name)) {
    laneNames.push(config.discovery.specialLane.name);
  }
  const allLanesAreFallback = laneNames.every((name) => name === config.resumes.fallbackLane);

  for (const laneName of laneNames) {
    const resumePath = join(config.resumes.directory, config.resumes.filePattern.replace("{lane}", laneName));
    if (await isReadable(resumePath)) {
      report.ok(`Resume for lane ${laneName} is readable`);
    } else if (laneName === config.resumes.fallbackLane) {
      report.error(`The fallback resume for lane ${laneName} is missing or unreadable`, `Add the configured ${laneName} resume under resumes.directory.`);
    } else if (isPublicConfig || allLanesAreFallback) {
      report.warn(`Resume for lane ${laneName} is missing`, `Add the configured ${laneName} resume under resumes.directory to enable that lane.`);
    } else {
      report.error(`Resume for lane ${laneName} is missing or unreadable`, `Add the configured ${laneName} resume under resumes.directory.`);
    }
  }
}

function checkModels(config, configModule, report) {
  const rolesByKey = new Map();
  const ompRoles = [];
  for (const [role, model] of Object.entries(config.models)) {
    if (model.backend === "omp") {
      ompRoles.push(role);
      continue;
    }
    const roles = rolesByKey.get(model.apiKeyEnv) ?? [];
    roles.push(role);
    rolesByKey.set(model.apiKeyEnv, roles);
  }

  for (const [envName, roles] of rolesByKey) {
    try {
      configModule.requireSecret(envName);
      report.ok(`${envName} is present for model role(s): ${roles.join(", ")}`);
    } catch {
      report.error(`${envName} is missing for model role(s): ${roles.join(", ")}`, `Add ${envName} to .env (see .env.example).`);
    }
  }

  if (!ompRoles.length) return;
  if (commandPath("omp")) {
    report.ok(`omp is available for model role(s): ${ompRoles.join(", ")}`);
  } else {
    report.error(`omp is missing for model role(s): ${ompRoles.join(", ")}`, "Install `omp` or select an HTTP backend for those model roles in config.json.");
  }
}

async function checkPlatformFeatures(config, report) {
  if (config.credentials.backend !== "macos-keychain") {
    report.error(`Unsupported credential backend: ${config.credentials.backend}`, "Set credentials.backend to macos-keychain on a supported macOS system.");
  } else if (process.platform !== "darwin") {
    report.error("The macOS Keychain credential backend is unavailable on this platform", "Run on macOS, or select a supported credential backend once one is implemented.");
  } else if (await isExecutable("/usr/bin/security")) {
    report.ok("macOS Keychain tooling is available");
  } else {
    report.error("The macOS Keychain tool /usr/bin/security is unavailable", "Restore /usr/bin/security, or use a supported macOS installation.");
  }

  if (config.notifications.backend === "console") {
    report.ok("Console notifications are available");
  } else if (config.notifications.backend === "macos-osascript") {
    if (process.platform === "darwin" && await isExecutable("/usr/bin/osascript")) {
      report.ok("macOS osascript notifications are available");
    } else {
      report.error("The macOS osascript notification backend is unavailable", "Set notifications.backend to console, or run on macOS with /usr/bin/osascript available.");
    }
  } else {
    report.error(`Unsupported notification backend: ${config.notifications.backend}`, "Set notifications.backend to console or macos-osascript.");
  }
}

async function checkEmail(config, report) {
  if (!config.email.enabled) {
    report.ok("email automation disabled");
    return;
  }

  if (config.email.accountLabel?.trim()) {
    report.ok("Email account label is configured");
  } else {
    report.error("Email automation is enabled but email.accountLabel is empty", "Set email.accountLabel in config.json, or set email.enabled to false.");
  }

  for (const [field, label] of [
    ["mcpServer", "Email MCP server"],
    ["tokenDatabase", "Email token database"],
    ["oauthCredentials", "Email OAuth credentials"],
  ]) {
    if (await isReadable(config.email[field])) {
      report.ok(`${label} is readable`);
    } else {
      report.error(`${label} is missing or unreadable`, `Fix email.${field} in config.json, or set email.enabled to false.`);
    }
  }
}

async function runDoctor() {
  const report = makeReporter();
  await checkRuntimeAndDependencies(report);
  await checkAnswers(report);

  const loaded = await loadValidatedConfig(report);
  if (loaded) {
    const { config, configModule, isPublicConfig } = loaded;
    await checkChrome(config, report);
    await checkResumes(config, report, isPublicConfig);
    const documentsConfigured = Boolean(
      config.applicant.displayName?.trim() && config.applicant.coverLetterHeading?.trim(),
    );
    await checkDocuments(config, report, documentsConfigured);
    checkModels(config, configModule, report);
    await checkPlatformFeatures(config, report);
    await checkEmail(config, report);
  }

  return report.finish();
}

async function runSetup() {
  if (typeof Bun === "undefined") {
    console.error("[ERROR] Setup must run under Bun. Install Bun, then run: bun setup.mjs");
    return false;
  }

  try {
    await copyMissingExamples();
    const missingKeys = await migrateLegacyKeys();
    const ready = await runDoctor();
    return missingKeys.length === 0 && ready;
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    return false;
  }
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  printHelp();
} else if (args.length === 0) {
  if (!(await runSetup())) process.exitCode = 1;
} else if (args.length === 1 && args[0] === "--doctor") {
  if (!(await runDoctor())) process.exitCode = 1;
} else {
  console.error(`[ERROR] Unknown option: ${args.join(" ")}`);
  printHelp();
  process.exitCode = 2;
}
