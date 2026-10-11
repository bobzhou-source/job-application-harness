// lib/act/press.mjs — element activation: settle timer and on-top-or-DOM press.

import { front } from '../browser.mjs';

export const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A real mouse click only when the element is on top at its centre; otherwise (covered by an overlay or hidden)
// its own click() reaches the handler. A blind real click would land on the overlay and close a list. A background
// tab renders no frames, and a real click waits for one forever: the tab is fronted first, as click() does.
export async function pressElement(handle) {
  await front(handle.frame.page());
  await handle.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const onTop = await handle.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = r.width && r.height ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return Boolean(hit && (hit === node || node.contains(hit)));
  });
  if (onTop) await handle.click();
  else await handle.evaluate((node) => node.click());
}
