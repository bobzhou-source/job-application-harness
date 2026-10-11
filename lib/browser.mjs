// lib/browser.mjs — Chrome CDP connect, tab open, popup adoption.
// See docs/ARCHITECTURE.md. Plain ESM; dependencies: puppeteer-core, ws.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import puppeteer from "puppeteer-core";
import { loadConfig } from "./config.mjs";

const BROWSER_CONFIG = loadConfig().browser;
const HOST = BROWSER_CONFIG.debugHost;
// Canonical bracketed host: URL parsing turns "0:0:0:0:0:0:0:1" into "[::1]", so comparisons and URLs agree.
const HOSTNAME = new URL(`http://${HOST.includes(":") ? `[${HOST}]` : HOST}:1/`).hostname;
const DEBUG_PORT = BROWSER_CONFIG.debugPort;
const PROTOCOL_TIMEOUT_MS = 180000;
const CONNECT_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 10000;
const LAUNCH_TIMEOUT_MS = 30000;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DevToolsActivePort holds two lines: the debugging port, then the browser
// websocket path (/devtools/browser/<id>); together they give the exact
// endpoint. Some builds write a full ws:// URL on line two instead, so accept
// one only when it is exactly loopback on the same port with a
// /devtools/browser/ path. Mirrors legacy driver/cdp-service.js
// readChromeEndpoint.
async function readChromeEndpoint() {
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

const CONNECT_ERROR =
  `Could not start or attach the automation Chrome (profile ${PROFILE_DIR}). If that profile is already open without remote debugging, quit that Chrome window and retry.`;

// Start the dedicated Chrome detached so it outlives this process; the harness
// never closes it. A stale DevToolsActivePort is removed first so the wait below
// only accepts the new instance's endpoint.
async function launchChrome() {
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
async function liveEndpoint(url) {
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

async function openTransport() {
  let endpoint = null;
  try {
    endpoint = await readChromeEndpoint();
    return await CDPTransport.create(endpoint);
  } catch (error) {
    // A live Chrome that missed one handshake (busy) is retried, never relaunched: a second launch on the same
    // profile hands off to it and exits, after the port file it still listens on was deleted.
    const live = endpoint && await liveEndpoint(endpoint);
    if (live) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await CDPTransport.create(live); } catch {}
        await delay(2000);
      }
      throw error;
    }
    return CDPTransport.create(await launchChrome());
  }
}

// CDPTransport — the minimal ConnectionTransport puppeteer needs, owning one ws
// socket to Chrome. Mirrors puppeteer's own NodeWebSocketTransport (handed over
// only once the socket is open, perMessageDeflate off, socket errors absorbed)
// plus the requirements here: a HANDSHAKE_TIMEOUT_MS handshake deadline — this
// raw connect is what makes Chrome ask the user to approve — and an idempotent
// close() that terminates instead of waiting, so a failure can never leave a
// socket or timer keeping the process alive.
class CDPTransport {
  static async create(url) {
    const socket = new WebSocket(url, [], {
      followRedirects: true,
      perMessageDeflate: false,
      allowSynchronousEvents: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    // Absorb socket errors for the transport's whole life — handshake failure,
    // handshake timeout, dropped connection. They surface through the 'close'
    // event and the CDP deadline, never as an unhandled 'error' event.
    socket.addEventListener("error", () => {});
    let timer;
    try {
      // Puppeteer starts sending CDP commands the moment it has the transport,
      // and ws.send() throws while CONNECTING, so only hand it over once open.
      // Own timer: Bun's built-in `ws` ignores handshakeTimeout, so without it a
      // pending Chrome approval prompt would hang this await forever.
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Chrome CDP handshake timed out")), HANDSHAKE_TIMEOUT_MS);
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Chrome CDP handshake failed")), { once: true });
        socket.addEventListener("close", () => reject(new Error("Chrome CDP socket closed during handshake")), { once: true });
      });
    } catch (error) {
      socket.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return new CDPTransport(socket);
  }

  onmessage = null;
  onclose = null;
  #socket;
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const handler = this.onmessage;
      if (handler) handler.call(null, event.data);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      const handler = this.onclose;
      if (handler) handler.call(null);
    });
  }

  send(message) {
    if (this.#closed) return;
    this.#socket.send(message);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    // terminate(), not close(): never wait on a close handshake we may hang on.
    this.#socket.terminate();
  }
}

// connect(): Promise<Browser> — attach to the dedicated automation Chrome,
// launching it on first use. Open the owned ws transport (HANDSHAKE_TIMEOUT_MS
// deadline), then hand it to a single puppeteer.connect whose CDP
// initialization is bounded by CONNECT_TIMEOUT_MS. Any failure terminates the
// transport, absorbs the losing promise and throws the one sanitized,
// actionable error. On success the returned Browser owns the transport:
// Browser.disconnect() closes it.
// unresponsivePages(): ids of page tabs whose renderer does not answer a trivial evaluate within PROBE_TIMEOUT_MS
// (a page stuck in a script loop). Puppeteer attaches to every tab, and one frozen tab stalls that attach for the
// whole protocol timeout, so such tabs are left out of the connection; a frozen tab this harness opened (recorded
// in tabs.json) is closed, so the run that owns it reopens its posting in a fresh tab.
const PROBE_TIMEOUT_MS = 4000;
async function unresponsivePages() {
  let base;
  try { base = new URL(await readChromeEndpoint()); } catch { return new Set(); }
  const http = `http://${base.host}`;
  let targets = [];
  try { targets = await (await fetch(`${http}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).json(); } catch { return new Set(); }
  const pages = targets.filter((target) => target.type === "page" && /^https?:/.test(target.url) && target.webSocketDebuggerUrl);
  const frozen = (await Promise.all(pages.map((target) => new Promise((resolve) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl, [], { perMessageDeflate: false, handshakeTimeout: PROBE_TIMEOUT_MS });
    const finish = (hung) => { clearTimeout(timer); socket.terminate(); resolve(hung ? target.id : null); };
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
    socket.addEventListener("error", () => finish(false));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" } })));
    socket.addEventListener("message", () => finish(false));
  })))).filter(Boolean);
  const owned = new Set(Object.values(readTabs()).map((entry) => entry.id));
  for (const id of frozen) {
    if (owned.has(id)) await fetch(`${http}/json/close/${id}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => undefined);
  }
  return new Set(frozen);
}

export async function connect() {
  const frozen = await unresponsivePages();
  let transport;
  try {
    transport = await openTransport();
  } catch {
    throw new Error(CONNECT_ERROR);
  }

  const attempt = puppeteer.connect({
    transport,
    defaultViewport: null,
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    targetFilter: (target) => !frozen.has(target.targetId),
  });

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Chrome CDP initialization timed out")),
      CONNECT_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([attempt, deadline]);
  } catch {
    // Failure or deadline: terminate the socket so no socket or timer keeps the
    // process alive, and absorb the losing promise's late outcome (a Browser
    // that arrives after the deadline is disconnected; a late rejection is
    // swallowed) so it never becomes an unhandled rejection.
    transport.close();
    attempt.then((browser) => browser.disconnect()).catch(() => {});
    throw new Error(CONNECT_ERROR);
  } finally {
    clearTimeout(timer);
  }
}

// Normalize a URL for reuse comparison: keep the fragment/hash intact (hash
// routes like #/jobs/123/apply are distinct resources), canonicalize only an
// insignificant trailing slash. Never loosens the match beyond "same resource".
function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// A run records its working tab's CDP target id (stable for the tab's whole life, across navigations to
// other sites) under the posting URL in tabs.json, so a later run for that posting resumes the same tab
// wherever the application has moved it, instead of opening another.
const TAB_FILE = fileURLToPath(new URL("../tabs.json", import.meta.url));

// tabs.json: posting URL → { id: CDP target id, title: the posting page's own title, held?: why the user needs it }.
// The title names the target role when a later run resumes the tab on the employer's site (a sign-in or password
// page has its own title). A held tab (a captcha or MFA step left for the user) is never closed by trimTabs.
function readTabs() {
  let tabs;
  try { tabs = JSON.parse(readFileSync(TAB_FILE, "utf8")); } catch { return {}; }
  for (const [key, value] of Object.entries(tabs)) if (typeof value === "string") tabs[key] = { id: value };
  return tabs;
}

// The user's own mailbox is never an application tab (emailed links and codes go through the Gmail API).
export const isWebmail = (url) => {
  try { return /^(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com)$/i.test(new URL(url).host); } catch { return false; }
};

export async function markTab(page, url, title) {
  if (isWebmail(page.url())) return;
  const tabs = readTabs();
  const id = page.target()._targetId;
  const key = normalizeUrl(url);
  if (!key) return;
  // The title names the posting, not the tab: it survives the posting moving to another tab.
  const entry = { ...tabs[key], id, title: title || tabs[key]?.title };
  if (tabs[key]?.id === entry.id && tabs[key]?.title === entry.title) return;
  tabs[key] = entry;
  writeFileSync(TAB_FILE, `${JSON.stringify(tabs, null, 2)}\n`);
}

// holdTab(page, url, reason): keep the run's tab open for the user (a captcha to solve whenever they can): trimTabs
// never closes it and it does not count against MAX_TABS. It is released when the user closes it.
export function holdTab(page, url, reason) {
  const key = normalizeUrl(url);
  if (!key || page.isClosed()) return;
  const tabs = readTabs();
  tabs[key] = { ...tabs[key], id: page.target()._targetId, held: String(reason).slice(0, 120) };
  writeFileSync(TAB_FILE, `${JSON.stringify(tabs, null, 2)}\n`);
}

// The posting title recorded for `url`'s tab, or null.
export function postingTitle(url) {
  const key = normalizeUrl(url);
  return (key && readTabs()[key]?.title) || null;
}

// The employer's application form URL recorded for `url`'s posting when a mid-form sign-in was taken over it
// (the sign-in may land the tab on a profile page; a later run returns to the form), or null.
export function applicationUrl(url) {
  const key = normalizeUrl(url);
  return (key && readTabs()[key]?.application) || null;
}
export function recordApplicationUrl(url, application) {
  const key = normalizeUrl(url);
  if (!key) return;
  const tabs = readTabs();
  tabs[key] = { ...tabs[key], application };
  writeFileSync(TAB_FILE, `${JSON.stringify(tabs, null, 2)}\n`);
}

// front(page): bring the driven tab forward and keep it rendering. With the screen locked (or the window occluded)
// every tab stays hidden, and Chrome then runs no requestAnimationFrame: widgets that search or commit a choice on
// the next frame (Workday prompts) silently do nothing. Focus emulation makes the page visible to itself.
const rendering = new WeakSet();
export async function front(page) {
  await page.bringToFront().catch(() => undefined);
  if (rendering.has(page)) return;
  try {
    const session = await page.createCDPSession();
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    rendering.add(page);
  } catch {
    // A closing page: the next front() retries.
  }
}

// The automation Chrome keeps at most MAX_TABS tabs so it never bloats the Mac's memory. trimTabs closes the
// least useful tabs first, oldest first within each rank: blank and browser pages, Handshake search lists and
// stray CAPTCHA/challenge windows; then tabs no run recorded; then other postings' recorded tabs (a stopped
// run's page, kept only for resuming). `keep` (the tab being opened or resumed) is never closed, nor is a held tab
// (left for the user), which also does not count toward the limit.
export const MAX_TABS = BROWSER_CONFIG.maxTabs;
export async function trimTabs(browser, keep = [], limit = MAX_TABS) {
  const entries = Object.values(readTabs());
  const held = new Set(entries.filter((entry) => entry.held).map((entry) => entry.id));
  const pages = (await browser.pages()).filter((page) => !held.has(page.target()._targetId));
  if (pages.length <= limit) return 0;
  const recorded = new Set(entries.map((entry) => entry.id));
  const rank = (page) => {
    const url = page.url();
    if (!/^https?:/.test(url) || /joinhandshake\.com\/(job-search|explore|stu\/postings)\b|hcaptcha\.com|recaptcha|challenges\.cloudflare\.com|\/captcha\b/i.test(url)) return 0;
    return recorded.has(page.target()._targetId) ? 2 : 1;
  };
  const candidates = pages
    .map((page, order) => ({ page, order, rank: rank(page) }))
    .filter(({ page }) => !keep.includes(page))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  let closed = 0;
  for (const { page } of candidates.slice(0, pages.length - limit)) {
    await page.close().catch(() => undefined);
    closed += 1;
  }
  return closed;
}

// openTab(browser, url): Promise<Page> — reuse the tab recorded for this posting while it is still open,
// else one whose normalized URL matches exactly (never a merely same-origin tab: it may hold another job's
// partial form). Otherwise open a new page. The chosen tab is recorded.
export async function openTab(browser, url) {
  const target = normalizeUrl(url);
  const pages = await browser.pages();
  const recorded = target === null ? undefined : readTabs()[target]?.id;
  // A recorded tab that now shows a non-web page (an extension popout took it over), a privacy/terms page, the
  // user's mailbox, or a third-party identity provider (an abandoned "Sign in with Google") is not the posting's tab.
  let page = pages.find((candidate) => recorded && candidate.target()._targetId === recorded
    && /^https?:/.test(candidate.url()) && !isWebmail(candidate.url())
    && !/^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|www\.linkedin\.com)$/i.test(new URL(candidate.url()).hostname)
    && !/privacy|terms|policy|cookie|legal|gdpr|disclaimer/i.test(new URL(candidate.url()).pathname)) ?? null;
  if (!page) page = pages.find((candidate) => target !== null && normalizeUrl(candidate.url()) === target) ?? null;
  if (page) {
    await trimTabs(browser, [page]);
    await front(page);
    // Still on the posting's own site but on another page (a search list, another job): it drifted away from the
    // posting, so load the posting again. A tab on another site holds the employer's application and is kept.
    if (new URL(page.url()).host === new URL(url).host && normalizeUrl(page.url()) !== target) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => {
        if (!error || error.name !== "TimeoutError") throw error;
      });
    }
    await markTab(page, url);
    return page;
  }
  await trimTabs(browser, [], MAX_TABS - 1);
  page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    if (!error || error.name !== "TimeoutError") throw error;
    // slow page — keep going with whatever has loaded
  }
  await front(page);
  await markTab(page, url);
  return page;
}

// watchTabs(browser) — records every page tab Chrome creates for the rest of the run (CDP targetcreated),
// whatever its opener (noopener/_blank links report none) and however late it appears.
// take(): the newest web (http/https) tab created since the previous take(), brought to front once it has loaded;
// else null. Extension and browser-internal pages (an extension's welcome tab, devtools) are never adopted.
export function watchTabs(browser) {
  let created = [];
  const all = [];
  browser.on("targetcreated", (target) => {
    if (target.type() === "page") { created.push(target); all.push(target); }
  });
  return {
    // closeOthers(keep): close every tab this run caused to open except `keep` (the page the run ended on), so
    // policy pages, sign-in popups, and abandoned steps do not pile up across runs.
    async closeOthers(keep) {
      for (const target of all) {
        const page = await target.page().catch(() => null);
        if (page && page !== keep && !page.isClosed()) await page.close().catch(() => undefined);
      }
    },
    async take() {
      const fresh = created;
      created = [];
      for (const target of fresh.reverse()) {
        const page = await target.page().catch(() => null);
        if (!page || page.isClosed()) continue;
        const loaded = new Promise((resolve) => page.once("load", resolve));
        await Promise.race([loaded, delay(1500)]).catch(() => undefined);
        if (page.isClosed() || !/^https?:/.test(page.url())) continue;
        // The user's own mailbox (a tab they opened, or one a "check your email" link opened) is left open, not driven.
        if (isWebmail(page.url())) continue;
        // A privacy/terms/cookie page opened from a consent link is reading matter, never the application: close it
        // and stay put.
        if (/privacy|terms|policy|cookie|legal|gdpr|disclaimer/i.test(new URL(page.url()).pathname)) {
          await page.close().catch(() => undefined);
          continue;
        }
        await front(page);
        return page;
      }
      return null;
    },
  };
}
