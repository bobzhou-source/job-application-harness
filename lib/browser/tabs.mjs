// lib/browser/tabs.mjs — tabs.json registry: posting URL → CDP target id, title, held, application URL.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Normalize a URL for reuse comparison: keep the fragment/hash intact (hash
// routes like #/jobs/123/apply are distinct resources), canonicalize only an
// insignificant trailing slash. Never loosens the match beyond "same resource".
export function normalizeUrl(value) {
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
const TAB_FILE = fileURLToPath(new URL("../../tabs.json", import.meta.url));

// tabs.json: posting URL → { id: CDP target id, title: the posting page's own title, held?: why the user needs it }.
// The title names the target role when a later run resumes the tab on the employer's site (a sign-in or password
// page has its own title). A held tab (a captcha or MFA step left for the user) is never closed by trimTabs.
export function readTabs() {
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
