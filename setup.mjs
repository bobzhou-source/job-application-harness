#!/usr/bin/env bun

import { copyMissingExamples } from "./lib/setup/scaffold.mjs";
import { migrateLegacyKeys } from "./lib/setup/dotenv.mjs";
import { makeReporter } from "./lib/setup/report.mjs";
import {
  checkRuntimeAndDependencies,
  loadValidatedConfig,
  checkAnswers,
  checkChrome,
  checkDocuments,
  checkResumes,
  checkModels,
  checkPlatformFeatures,
  checkEmail,
} from "./lib/setup/checks.mjs";

const HELP = `Usage: bun setup.mjs [--doctor] [--help]

Prepare and diagnose the job-application harness.

Options:
  --help    Show this help and exit without changing anything
  --doctor  Run read-only diagnostics; never copy files, launch Chrome, or call a model

With no options, setup copies the missing example files (config.json,
answers.json, .env), migrates legacy API keys without printing them, sets
.env permissions to 0600, and then runs the doctor.`;

function printHelp() {
  console.log(HELP);
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
