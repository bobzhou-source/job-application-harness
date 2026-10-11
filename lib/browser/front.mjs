// lib/browser/front.mjs — bring the driven tab forward and keep it rendering.

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
