// lib/act/resolve.mjs — snapshot-ref resolution: ref → fresh ElementHandle, scrolling, hidden-page fronting.

import { front } from '../browser.mjs';

const REF_ATTR = 'data-omp-ref';
// "f<encodeURIComponent(stableFrameId)>:<localRef>" — the encoded ID can
// never contain a literal ":", so the first ":" is always the separator.
const FRAME_PREFIX = /^f([^:]+):(.+)$/;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the element whose data-omp-ref equals `localRef`, searching the
// document light DOM and every open shadow root recursively. Serialized into
// the target frame/page by evaluateHandle, so cross-origin frames resolve
// the same way. Returns the element or null.
function findElementByRef(attr, localRef) {
  const stack = [document];
  while (stack.length) {
    const root = stack.pop();
    const found = root.querySelector(`[${attr}="${localRef}"]`);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return null;
}

// Resolve a ref to a fresh ElementHandle on every call. Throws a clear
// error when the ref no longer resolves so the caller can re-snapshot.
export async function resolveHandle(page, ref) {
  const m = FRAME_PREFIX.exec(ref);
  let scope = page;
  let localRef = ref;
  if (m) {
    let decodedId;
    try {
      decodedId = decodeURIComponent(m[1]);
    } catch {
      throw new Error(`ref ${ref} no longer resolves: malformed frame id — re-snapshot`);
    }
    localRef = m[2];
    // Exact stable-frame-ID match only; a page.frames() array position would
    // silently retarget the wrong frame as frames attach/detach.
    const frame = page.frames().find(
      (f) => String(f._id ?? f._frameId) === decodedId
    );
    if (!frame) {
      throw new Error(`ref ${ref} no longer resolves: frame gone — re-snapshot`);
    }
    scope = frame;
  }
  const handle = await scope.evaluateHandle(findElementByRef, REF_ATTR, localRef);
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    throw new Error(`ref ${ref} no longer resolves: element gone — re-snapshot`);
  }
  return el;
}

export async function scrollIntoView(el) {
  try {
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch {
    // Detached between resolve and scroll; the action itself will throw.
  }
}

// Chrome renders no frames for a hidden page (window minimized or occluded, screen locked), and CDP mouse input
// waits for one, so a trusted click would hang until the protocol timeout. Bring the tab forward with focus
// emulation (it then renders); if it stays hidden, the element's own click() delivers the same activation.
export async function pageHidden(page) {
  try {
    if (await page.evaluate(() => document.visibilityState) !== 'hidden') return false;
    await front(page);
    return await page.evaluate(() => document.visibilityState) === 'hidden';
  } catch {
    return false;
  }
}
