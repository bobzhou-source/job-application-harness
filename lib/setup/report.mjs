// lib/setup/report.mjs — doctor reporter, public placeholders, and small value helpers.

import { homedir } from "node:os";
import { resolve } from "node:path";

const PUBLIC_PLACEHOLDERS = {
  handshakeBaseUrl: "https://your-school.joinhandshake.com",
  displayName: "Alex Example",
  resumeDirectory: "~/Documents/resumes",
  answersEmail: "alex.doe@example.com",
  answersResume: "/absolute/path/to/your/resume.pdf",
};

export function makeReporter() {
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

export function publicPlaceholderFields(config) {
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

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { PUBLIC_PLACEHOLDERS };
