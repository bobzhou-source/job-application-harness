// lib/browser/manage.mjs — tab lifecycle: trim, open/resume by posting URL, and popup adoption.

import { BROWSER_CONFIG, delay } from "./endpoint.mjs";
import { readTabs, normalizeUrl, isWebmail, markTab } from "./tabs.mjs";
import { front, backgroundPage } from "./front.mjs";

// The automation Chrome keeps at most MAX_TABS tabs so it never bloats the Mac's memory. trimTabs closes the
// least useful tabs first, oldest first within each rank: blank and browser pages, Handshake search lists and
// stray CAPTCHA/challenge windows; then tabs no run recorded; then other postings' recorded tabs (a stopped
// run's page, kept only for resuming). `keep` (the tab being opened or resumed) is never closed, nor is a held tab
// (left for the user), which also does not count toward the limit. A headless worker keeps two: nobody can look at
// a stopped run's page there, and eight idle Workday tabs per worker were a gigabyte of renderers.
export const MAX_TABS = process.env.JOB_APP_HEADLESS === "1" ? Math.min(BROWSER_CONFIG.maxTabs, 2) : BROWSER_CONFIG.maxTabs;
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
  const tabs = readTabs();
  const recorded = target === null ? undefined : tabs[target]?.id;
  // A recorded tab that now shows a non-web page (an extension popout took it over), a privacy/terms page, the
  // user's mailbox, a third-party identity provider (an abandoned "Sign in with Google"), or a tab another posting
  // also records (a concurrent run adopted it) is not the posting's tab.
  const shared = recorded && Object.entries(tabs).some(([key, entry]) => key !== target && entry.id === recorded);
  let page = pages.find((candidate) => recorded && !shared && candidate.target()._targetId === recorded
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
  page = await backgroundPage(browser);
  // Recorded before it loads: a concurrent run watching for new tabs must see this one is another posting's, not a
  // popup of its own (watchTabs skips tabs recorded under other postings).
  await markTab(page, url);
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

// watchTabs(browser, url) — records every page tab Chrome creates for the rest of the run (CDP targetcreated),
// whatever its opener (noopener/_blank links report none) and however late it appears.
// Several runs can share one Chrome (the queue plus a one-off apply.mjs): a tab another run opened for its own posting
// (recorded in tabs.json under another URL) or opened from a page that is not this run's is never adopted or closed.
// Adopting one once read another employer's "you applied" text and recorded this posting as submitted.
// take(): the newest web (http/https) tab of this run created since the previous take(), brought to front once it
// has loaded; else null. Extension and browser-internal pages (an extension's welcome tab, devtools) are never adopted.
export function watchTabs(browser, url, ownPage) {
  let created = [];
  const all = [];
  const key = normalizeUrl(url);
  const own = new Set(ownPage ? [ownPage.target()._targetId] : []);
  const foreign = (target) => {
    const id = target._targetId;
    if (Object.entries(readTabs()).some(([posting, entry]) => posting !== key && entry.id === id)) return true;
    const opener = target.opener()?._targetId;
    return Boolean(opener) && !own.has(opener);
  };
  browser.on("targetcreated", (target) => {
    if (target.type() === "page") { created.push(target); all.push(target); }
  });
  return {
    // closeOthers(keep): close every tab this run caused to open except `keep` (the page the run ended on), so
    // policy pages, sign-in popups, and abandoned steps do not pile up across runs.
    async closeOthers(keep) {
      for (const target of all) {
        if (foreign(target)) continue;
        const page = await target.page().catch(() => null);
        if (page && page !== keep && !page.isClosed()) await page.close().catch(() => undefined);
      }
    },
    // A tab of this run still open (the newest the run caused to open, else the one it started on), for when the
    // working tab closed under the run; null when none is left. Never another run's tab: reading one recorded a
    // false "already applied" from that run's confirmation page.
    async fallback() {
      for (const target of [...all].reverse()) {
        if (!own.has(target._targetId) && foreign(target)) continue;
        const page = await target.page().catch(() => null);
        if (page && !page.isClosed() && /^https?:/.test(page.url())) return page;
      }
      return ownPage && !ownPage.isClosed() ? ownPage : null;
    },
    async take() {
      const fresh = created;
      created = [];
      for (const target of fresh.reverse()) {
        const page = await target.page().catch(() => null);
        if (!page || page.isClosed()) continue;
        const loaded = new Promise((resolve) => page.once("load", resolve));
        await Promise.race([loaded, delay(1500)]).catch(() => undefined);
        if (foreign(target)) continue;
        own.add(target._targetId);
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
