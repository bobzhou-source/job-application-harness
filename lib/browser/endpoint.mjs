// lib/browser/endpoint.mjs — DevToolsActivePort discovery and detached Chrome launch.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.mjs";

const BROWSER_CONFIG = loadConfig().browser;
const HOST = BROWSER_CONFIG.debugHost;
// Canonical bracketed host: URL parsing turns "0:0:0:0:0:0:0:1" into "[::1]", so comparisons and URLs agree.
const HOSTNAME = new URL(`http://${HOST.includes(":") ? `[${HOST}]` : HOST}:1/`).hostname;
const DEBUG_PORT = BROWSER_CONFIG.debugPort;
const LAUNCH_TIMEOUT_MS = 30000;
const DEVTOOLS_BROWSER_PATH = "/devtools/browser/";

// Dedicated automation profile: a separate Chrome instance started with
// --remote-debugging-port on a non-default --user-data-dir. Chrome never shows
// the per-connection "Allow remote debugging?" prompt for it, so runs are
// unattended. The user's main Chrome profile is never attached. Port 0 lets
// Chrome pick a free port and publish it in the profile's DevToolsActivePort,
// so other local listeners can never collide with it.
const PROFILE_DIR = BROWSER_CONFIG.profileDir;
const CHROME_BIN = BROWSER_CONFIG.executable;

function activePortFilePath() {
  return path.join(PROFILE_DIR, "DevToolsActivePort");
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DevToolsActivePort holds two lines: the debugging port, then the browser
// websocket path (/devtools/browser/<id>); together they give the exact
// endpoint. Some builds write a full ws:// URL on line two instead, so accept
// one only when it is exactly loopback on the same port with a
// /devtools/browser/ path. Mirrors legacy driver/cdp-service.js
// readChromeEndpoint.
export async function readChromeEndpoint() {
  const file = activePortFilePath();
  let contents;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `Chrome DevToolsActivePort not found at ${file} — Chrome must be running with --remote-debugging-port`,
      );
    }
    throw error;
  }
  const [portLine, pathLine] = contents.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DevToolsActivePort contents at ${file}`);
  }
  const rawPath = (pathLine ?? "").trim();
  if (rawPath.startsWith("ws://") || rawPath.startsWith("wss://")) {
    const parsed = new URL(rawPath);
    if (
      parsed.protocol !== "ws:" ||
      parsed.hostname !== HOSTNAME ||
      Number(parsed.port) !== port ||
      !parsed.pathname.startsWith(DEVTOOLS_BROWSER_PATH)
    ) {
      throw new Error(`Invalid DevToolsActivePort contents at ${file}`);
    }
    return rawPath;
  }
  if (!rawPath.startsWith(DEVTOOLS_BROWSER_PATH)) {
    throw new Error(`Invalid DevToolsActivePort contents at ${file}`);
  }
  return `ws://${HOSTNAME}:${port}${rawPath}`;
}

export const CONNECT_ERROR =
  `Could not start or attach the automation Chrome (profile ${PROFILE_DIR}). If that profile is already open without remote debugging, quit that Chrome window and retry.`;

// Start the dedicated Chrome detached so it outlives this process; the harness
// never closes it. A stale DevToolsActivePort is removed first so the wait below
// only accepts the new instance's endpoint.
export async function launchChrome() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  await fs.rm(activePortFilePath(), { force: true });
  // AutomationControlled off: otherwise navigator.webdriver is true under remote debugging, and bot checks
  // (hCaptcha/reCAPTCHA scoring) reject the application server-side even after a solved challenge.
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--restore-last-session",
  ], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  const end = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      return await readChromeEndpoint();
    } catch {
      await delay(250);
    }
  }
  throw new Error("automation Chrome did not publish DevToolsActivePort");
}

// The live browser websocket of the Chrome answering on the endpoint's port, or null. After a restart the port file
// can name a previous session's browser id while the same port is served by the new Chrome; /json/version gives the
// current id.
export async function liveEndpoint(url) {
  try {
    const { port } = new URL(url);
    const response = await fetch(`http://${HOSTNAME}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const { webSocketDebuggerUrl } = await response.json();
    return typeof webSocketDebuggerUrl === "string" ? webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${HOSTNAME}:${port}`) : null;
  } catch {
    return null;
  }
}

export { BROWSER_CONFIG };
