// lib/act.mjs — trusted click/type/select/upload/press by snapshot ref.
// Refs come from lib/snapshot.mjs: "e12" in the main frame, or
// "f<encodeURIComponent(stableFrameId)>:e12" for a child frame — the stable
// CDP frame ID (frame._id ?? frame._frameId), never a page.frames() index.
// The local part is matched against [data-omp-ref] in that frame's document
// light DOM and every open shadow root.

import { resolveHandle, scrollIntoView, pageHidden, delay } from './act/resolve.mjs';
import { settle, pressElement } from './act/press.mjs';
import { ariaOptions, isAriaSelect, selectAria, selectCustom, searchCompanion, companionQueries, companionSearch, selectCompanion } from './act/select-helpers.mjs';

export async function click(page, ref) {
  const el = await resolveHandle(page, ref);
  await scrollIntoView(el);
  // A real click on a native <select> opens the OS popup menu, which blocks the page's scripts on macOS: focus it
  // instead (its options are already readable and chosen through select()).
  if (await el.evaluate((e) => e instanceof HTMLSelectElement)) {
    await el.focus();
    return page;
  }
  const hidden = await pageHidden(page);
  // Arm the navigation wait BEFORE dispatching the click so a same-tab
  // navigation that fires during the click is not missed.
  const nav = page.waitForNavigation({ timeout: 2000 }).catch(() => null);
  // The same event sequence a real click produces (many widgets open on mousedown, not click).
  // The events go to the element's own innermost node at its centre, as a real click's would: widgets that listen on
  // an inner row (Workday's prompt leaf nodes) ignore events dispatched on the outer option. That node is found
  // beneath anything covering the point (a password manager's injected bar), not just on top.
  const synthetic = () => el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const hit = r.width && r.height ? document.elementsFromPoint(at.clientX, at.clientY).find((candidate) => node.contains(candidate)) : null;
    const e = hit && typeof hit.click === 'function' ? hit : node;
    e.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
    e.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
    (node.focus ? node : e).focus?.();
    e.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
    e.dispatchEvent(new MouseEvent('mouseup', at));
    e.click();
  });
  // A real mouse click lands on whatever is on top at the element's centre: when another element covers it (a
  // sticky panel, an expanded description), the click would hit that instead, so dispatch to the element itself.
  // An element inside an embedded form frame can also be covered by the host page (its open nav menu, a sticky
  // header): the host page must show the frame itself at that point.
  let onTop = !hidden && await el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    const hit = r.width && r.height ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return Boolean(hit && (hit === node || node.contains(hit)));
  });
  const frame = el.frame ?? null;
  if (onTop && frame && frame !== page.mainFrame()) {
    const box = await el.boundingBox().catch(() => null);
    const owner = await frame.frameElement().catch(() => null);
    onTop = Boolean(box && owner && await page.mainFrame().evaluate((x, y, iframe) => {
      const hit = document.elementFromPoint(x, y);
      return hit === iframe;
    }, box.x + box.width / 2, box.y + box.height / 2, owner).catch(() => false));
  }
  if (!onTop) await synthetic();
  else {
    // Puppeteer refuses before dispatching when the element has no clickable box (zero-size, transformed, or
    // clipped by an overlay layer); nothing was sent, so the DOM event sequence is the click.
    try { await el.click(); } catch (error) {
      if (!/not clickable|not an Element|no box|not visible/i.test(String(error?.message))) throw error;
      await synthetic();
    }
  }
  // Wait for possible navigation, but never longer than the settle delay
  // once no navigation starts; navigation itself gets up to 2s.
  await Promise.race([nav, delay(250)]);
  return page;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// A human date ("September 2030", "05/2031", "May 15, 2031", "2031-05") in the wire format of a native
// <input type=month|date> ("2031-05" / "2031-05-15"), or null when it names no year.
export function dateWire(value, kind) {
  const text = String(value).trim().toLowerCase();
  let year, month, day;
  let m;
  if ((m = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) [, year, month, day] = m;
  else if ((m = text.match(/^(\d{1,2})\/(?:(\d{1,2})\/)?(\d{4})$/))) [, month, day, year] = m;
  else {
    year = text.match(/\b(\d{4})\b/)?.[1];
    const name = MONTHS.findIndex((abbr) => new RegExp(`\\b${abbr}`).test(text));
    if (name >= 0) month = name + 1;
    day = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\d)/)?.[1];
  }
  if (!year) return null;
  const pad = (n) => String(n ?? 1).padStart(2, "0");
  if (kind === "month") return `${year}-${pad(month)}`;
  if (kind === "date") return `${year}-${pad(month)}-${pad(day)}`;
  return null;
}

export async function type(page, ref, value, { secret = false } = {}) {
  const el = await resolveHandle(page, ref);
  await scrollIntoView(el);
  // Native month/date inputs accept only their wire format; typed words are dropped (the site "clears" the fill).
  const kind = await el.evaluate((e) => (e instanceof HTMLInputElement && ["month", "date"].includes(e.type) ? e.type : null));
  if (kind) {
    const wire = value === "" ? "" : dateWire(value, kind);
    if (wire !== null) {
      await el.evaluate((e, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, v);
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        e.dispatchEvent(new Event("blur", { bubbles: true }));
      }, wire);
      return page;
    }
  }
  // A text date box that spells its format in the placeholder ("YYYY-MM-DD", "MM/DD/YYYY", "MM/YYYY") takes the date
  // in that format; a human date ("May 2031") is otherwise rejected or cleared by its picker.
  const format = await el.evaluate((e) => (e instanceof HTMLInputElement && e.type === "text"
    && /^(yyyy|mm|dd)([-/.])(yyyy|mm|dd)(\2(yyyy|mm|dd))?$/i.test((e.placeholder || "").trim()) ? e.placeholder.trim() : null));
  if (format && value !== "" && !/^\d/.test(String(value).trim())) {
    const wire = dateWire(value, "date");
    if (wire) {
      const [year, month, day] = wire.split("-");
      value = format.replace(/yyyy/i, year).replace(/mm/i, month).replace(/dd/i, day);
    }
  }
  // A calendar combobox (aria-haspopup="dialog") with no format in its placeholder parses typed dates in the page's
  // locale ("05/24/2031" in en-US) and clears an ISO "2031-05-24".
  const iso = !format && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (iso) {
    const local = await el.evaluate((e, y, m, d) => e.getAttribute("aria-haspopup") === "dialog"
      ? new Intl.DateTimeFormat(document.documentElement.lang || navigator.language, { year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date(Number(y), Number(m) - 1, Number(d)))
      : null, iso[1], iso[2], iso[3]);
    if (local) value = local;
  }
  try {
    if (secret) {
      // Replace existing contents without ever reading them: focus, select
      // all, delete, then type. Puppeteer keyboard.press takes no modifier
      // combos, so hold Meta explicitly (macOS select-all).
      await el.focus();
      await page.keyboard.down('Meta');
      try {
        await page.keyboard.press('a');
      } finally {
        // Always release Meta, even if the press throws, so a failed fill
        // cannot leave the modifier held for later browser actions.
        await page.keyboard.up('Meta');
      }
      // Backspace in an EMPTY multi-select input deletes its last chosen chip: clear only when there is text.
      if (await el.evaluate((e) => String(e.value ?? e.textContent ?? '').length > 0)) await page.keyboard.press('Backspace');
    }
    await el.type(value);
    // Some widgets swallow or repeat individual keys (a space in a search box, a doubled key in a password
    // field), or move focus mid-typing so keys land elsewhere. If the field does not hold the value (input
    // masks that only add punctuation/spacing count as holding it), retype it as one insertText input, and
    // as a last resort set it through the native value setter with input/change events.
    // Secrets are compared inside the page; their contents are never returned.
    const holds = () => el.evaluate((e, v) => {
      if (!("value" in e)) return true;
      const bare = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      // A numeric box may drop a leading zero ("06" shows as "6"); a phone mask may drop or add the country code
      // ("+15555550123" shows as "(555) 555-0123", "5555550123" as "+1 555 555 0123"): 1–3 leading digits, 7+ remain.
      const numeric = /^\d+$/.test(e.value) && /^\d+$/.test(v) && Number(e.value) === Number(v);
      const [shown, typed] = [bare(e.value), bare(v)];
      const [long, short] = shown.length > typed.length ? [shown, typed] : [typed, shown];
      const local = /^\+?\d[\d\s().-]+$/.test(String(v).trim()) && /^\d{7,}$/.test(short) && /^\d+$/.test(long)
        && long.endsWith(short) && long.length - short.length <= 3;
      return e.value === v || shown === typed || numeric || local;
    }, value);
    if (!(await holds())) {
      await el.focus();
      await el.evaluate((e) => e.select?.());
      if (await el.evaluate((e) => String(e.value ?? e.textContent ?? '').length > 0)) await page.keyboard.press('Backspace');
      await page.keyboard.sendCharacter(value);
    }
    if (!(await holds())) {
      await el.evaluate((e, v) => {
        const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v);
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      if (secret && !(await holds())) throw new Error(UNHELD);
    }
  } catch (err) {
    // Never leak a secret value through an error message; "did not stick" names no value and is a known outcome
    // (the box rejected or reformatted it away), so callers may observe again instead of stopping.
    throw new Error(
      secret
        ? `type failed on ref ${ref} (secret)${err.message === UNHELD ? `: ${UNHELD}` : ''}`
        : `type failed on ref ${ref}: ${err.message}`
    );
  }
}
const UNHELD = 'value did not stick';

// Text comboboxes open with a cleared search and ArrowDown; select-only widgets open by activation.
export async function openList(page, ref) {
  const el = await resolveHandle(page, ref);
  await scrollIntoView(el);
  const text = await el.evaluate(e => (e instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio'].includes(e.type))
    || e instanceof HTMLTextAreaElement);
  if (!text) {
    // A native <select> lists its options in the DOM already; clicking it opens the OS popup menu, which on macOS
    // blocks the page's script runner until dismissed (every later evaluate times out).
    if (await el.evaluate((e) => e instanceof HTMLSelectElement)) return;
    const trigger = await el.evaluateHandle(e => e.closest('[data-omp-dropdown]') || e);
    await pressElement(trigger);
    // A focusable combobox whose own box is a sliver (react-select v1 non-searchable: a 1px div) ignores the click,
    // and a popup listbox that opens on mousedown closes again on the click (dijit Select): the keyboard opens either
    // like a user tabbing in.
    await settle(300);
    const closed = await el.evaluate((e) => e.getAttribute("aria-expanded") === "false"
      && (e.getAttribute("role") === "combobox" || (e.getAttribute("role") === "listbox" && Boolean(e.getAttribute("aria-haspopup")))));
    if (closed) {
      await el.focus();
      await page.keyboard.press("ArrowDown");
    }
    return;
  }
  await click(page, ref);
  await el.focus();
  await el.evaluate((e) => e.select?.());
  // Backspace in an EMPTY multi-select input deletes its last chosen chip: clear only leftover search text.
  if (await el.evaluate((e) => String(e.value ?? '').length > 0)) await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowDown');
}

export async function select(page, ref, value) {
  const el = await resolveHandle(page, ref);
  if (await el.evaluate((e) => e instanceof HTMLInputElement && e.type === "hidden" && Boolean(e.closest("[data-omp-dropdown]")))) {
    return selectCustom(page, el, ref, String(value));
  }
  if (await el.evaluate(isAriaSelect)) return selectAria(page, el, ref, String(value));
  await scrollIntoView(el);
  // Accept either an option value or its visible label: resolve the actual
  // option value, preferring an exact value match, then a trimmed
  // case-insensitive label match.
  const wanted = String(value);
  const resolved = await el.evaluate((e, wanted) => {
    if (!(e instanceof HTMLSelectElement)) return null;
    const needle = wanted.trim().toLowerCase();
    const options = Array.from(e.options);
    const byValue = options.find((o) => o.value === wanted);
    if (byValue) return byValue.value;
    const byLabel = options.find((o) => o.text.trim().toLowerCase() === needle);
    return byLabel ? byLabel.value : null;
  }, wanted);
  if (resolved === null) {
    if (await (await el.evaluateHandle(searchCompanion, "trigger")).evaluate((t) => t !== null).catch(() => false)) {
      return selectCompanion(page, el, ref, wanted);
    }
    throw new Error(`select failed on ref ${ref}: no option matching "${wanted}"`);
  }
  await el.select(resolved);
}

// A select's options most relevant to `value` (read-only): the whole list when it fits in cap, else options sharing
// a word with it plus catch-all choices ("Other", "Not listed", "Prefer not"), so long lists (thousands of schools)
// can still be matched. Covers native selects, ARIA-less custom dropdowns (rows under the data-omp-dropdown
// trigger's parent), and ARIA select-only comboboxes (opened to render their options, then closed). A select fed by
// a type-to-search companion lists what its lookup returns for `value` (else for its first word).
export async function selectOptions(page, ref, value, cap = 40) {
  const el = await resolveHandle(page, ref);
  if (await (await el.evaluateHandle(searchCompanion, "trigger")).evaluate((t) => t !== null).catch(() => false)) {
    const words = String(value).trim().split(/\s+/);
    let texts = [];
    for (const query of [...new Set([words.join(" "), words[0]])].filter(Boolean)) {
      texts = await companionSearch(page, el, query);
      await page.keyboard.press("Escape");
      await settle(200);
      if (texts.length) { companionQueries.set(ref, query); break; }
    }
    return texts.slice(0, Number.isFinite(cap) ? cap : texts.length);
  }
  let opened = false;
  // ariaOptions returns DOM nodes, which do not serialize: count them through a handle.
  if (await el.evaluate(isAriaSelect) && !(await (await el.evaluateHandle(ariaOptions)).evaluate((list) => list.length))) {
    await pressElement(el);
    await settle(500);
    opened = true;
  }
  const ariaTexts = await el.evaluate(isAriaSelect)
    ? await (await el.evaluateHandle(ariaOptions)).evaluate((list) => list.map((o) => o.textContent.replace(/\s+/g, " ").trim()))
    : [];
  const result = await el.evaluate((e, value, cap, ariaTexts) => {
    const trigger = e.closest("[data-omp-dropdown]");
    let texts;
    if (e instanceof HTMLSelectElement) texts = Array.from(e.options).map((o) => o.text.trim());
    else if (trigger) {
      texts = Array.from(trigger.parentElement.querySelectorAll("li")).filter((li) => !li.querySelector("li") && !trigger.contains(li))
        .map((li) => li.textContent.replace(/\s+/g, " ").trim());
    } else texts = ariaTexts;
    texts = texts.filter(Boolean);
    if (texts.length <= cap) return texts;
    const words = String(value).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    // Rank by shared words, each weighted by its rarity in the list, so a distinctive school name outranks the ubiquitous "College".
    const lower = texts.map((t) => t.toLowerCase());
    const weight = Object.fromEntries(words.map((w) => [w, 1 / Math.max(1, lower.filter((t) => t.includes(w)).length)]));
    const score = (t) => words.reduce((sum, w) => sum + (t.includes(w) ? weight[w] : 0), 0);
    const related = texts.map((t, i) => [t, score(lower[i])]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const catchAll = texts.filter((t) => /\b(other|not listed|none|prefer not|decline)\b/i.test(t));
    return [...new Set([...related.slice(0, cap - catchAll.length), ...catchAll])].slice(0, cap);
  }, String(value), cap, ariaTexts);
  if (opened) {
    await page.keyboard.press("Escape");
    await settle(200);
  }
  return result;
}

export async function upload(page, ref, filePath) {
  const el = await resolveHandle(page, ref);
  // Chrome fires no change event when the chosen file equals the one already held, so sites that act on change
  // (validators, upload timers) never see a re-upload. A user's click clears the input first; do the same.
  await el.evaluate((e) => { e.value = ""; });
  await el.uploadFile(filePath);
}

// uploadViaChooser(page, triggerRef, filePath): click the page's own upload button and answer the native file chooser
// it opens, for widgets that ignore a file set directly on their <input type=file>. The click is the element's own
// (DOM) click: a pointer click can land on an overlay and open nothing.
export async function uploadViaChooser(page, triggerRef, filePath) {
  const el = await resolveHandle(page, triggerRef);
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), el.evaluate((e) => e.click())]);
  await chooser.accept([filePath]);
}

export async function press(page, key) {
  await page.keyboard.press(key);
}

// Enter in a search box to run its lookup — never when the box sits in a <form> with its list closed: there the key
// is the browser's implicit submission and would send the whole application. Returns whether Enter was pressed.
export async function searchEnter(page, ref) {
  const el = await resolveHandle(page, ref);
  const submits = await el.evaluate((e) => Boolean(e.form) && e.getAttribute('aria-expanded') !== 'true');
  if (submits) return false;
  await el.focus();
  await page.keyboard.press('Enter');
  return true;
}
