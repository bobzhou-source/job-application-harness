// lib/browser/front.mjs — bring the driven tab forward and keep it rendering.

// front(page): keep the driven tab rendering. With the screen locked (or the window occluded) a tab can go hidden,
// and Chrome then runs no requestAnimationFrame: widgets that search or commit a choice on the next frame (Workday
// prompts) silently do nothing. Focus emulation makes the page visible to itself. Chrome runs with occluded-window
// backgrounding off (endpoint.mjs), so the driven tab normally stays visible behind other apps; only a page that is
// actually hidden (another tab active in its window) is brought forward, which raises Chrome over the user's app.
const rendering = new WeakSet();
export async function front(page) {
  const hidden = await page.evaluate(() => document.visibilityState === "hidden").catch(() => true);
  if (hidden) await page.bringToFront().catch(() => undefined);
  if (rendering.has(page)) return;
  try {
    const session = await page.createCDPSession();
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    rendering.add(page);
  } catch {
    // A closing page: the next front() retries.
  }
}

// backgroundPage(browser): a new page in its own background window. browser.newPage() activates Chrome over the
// user's app; a background window does not, and as the only tab in its window the page stays visible and rendering.
export async function backgroundPage(browser) {
  const session = await browser.target().createCDPSession();
  try {
    const { targetId } = await session.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
    const target = await browser.waitForTarget((candidate) => candidate._targetId === targetId, { timeout: 15000 });
    return await target.page();
  } finally {
    await session.detach().catch(() => undefined);
  }
}
