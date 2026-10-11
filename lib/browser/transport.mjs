// lib/browser/transport.mjs — CDP websocket transport, attach-or-launch, frozen-tab probing.

import WebSocket from "ws";
import { readChromeEndpoint, launchChrome, liveEndpoint, delay } from "./endpoint.mjs";
import { readTabs } from "./tabs.mjs";

const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export async function openTransport() {
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

// unresponsivePages(): ids of page tabs whose renderer does not answer a trivial evaluate within PROBE_TIMEOUT_MS
// (a page stuck in a script loop). Puppeteer attaches to every tab, and one frozen tab stalls that attach for the
// whole protocol timeout, so such tabs are left out of the connection; a frozen tab this harness opened (recorded
// in tabs.json) is closed, so the run that owns it reopens its posting in a fresh tab.
const PROBE_TIMEOUT_MS = 4000;
export async function unresponsivePages() {
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
