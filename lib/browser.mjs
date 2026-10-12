// lib/browser.mjs — Chrome CDP connect, tab open, popup adoption.
// See docs/ARCHITECTURE.md. Plain ESM; dependencies: puppeteer-core, ws.

import puppeteer from "puppeteer-core";
import { CONNECT_ERROR } from "./browser/endpoint.mjs";
import { openTransport, unresponsivePages } from "./browser/transport.mjs";

const PROTOCOL_TIMEOUT_MS = 180000;
const CONNECT_TIMEOUT_MS = 5000;

// connect(): Promise<Browser> — attach to the dedicated automation Chrome,
// launching it on first use. Open the owned ws transport (HANDSHAKE_TIMEOUT_MS
// deadline), then hand it to a single puppeteer.connect whose CDP
// initialization is bounded by CONNECT_TIMEOUT_MS. Any failure terminates the
// transport, absorbs the losing promise and throws the one sanitized,
// actionable error. On success the returned Browser owns the transport:
// Browser.disconnect() closes it.
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

export { isWebmail, markTab, holdTab, postingTitle, applicationUrl, recordApplicationUrl } from "./browser/tabs.mjs";
export { front, backgroundPage } from "./browser/front.mjs";
export { MAX_TABS, trimTabs, openTab, watchTabs } from "./browser/manage.mjs";
