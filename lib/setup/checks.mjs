// lib/setup/checks.mjs — the doctor's read-only checks: runtime, config, Chrome, documents, lanes, models, platform, email.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ROOT } from "./paths.mjs";
import { exists, isReadable, isExecutable, isWritable, commandPath } from "./fsutil.mjs";
import { PUBLIC_PLACEHOLDERS, publicPlaceholderFields, isPlainObject } from "./report.mjs";

const require = createRequire(import.meta.url);

export async function checkRuntimeAndDependencies(report) {
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

export async function loadValidatedConfig(report) {
  try {
    const configModule = await import("../config.mjs");
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

export async function checkAnswers(report) {
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

export async function checkChrome(config, report) {
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

export async function checkDocuments(config, report, documentsConfigured) {
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

export async function checkResumes(config, report, isPublicConfig) {
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

export function checkModels(config, configModule, report) {
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

export async function checkPlatformFeatures(config, report) {
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

export async function checkEmail(config, report) {
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
