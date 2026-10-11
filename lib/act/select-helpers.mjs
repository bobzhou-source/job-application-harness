// lib/act/select-helpers.mjs — option discovery and picking for ARIA, custom, and companion-select dropdowns.

import { pressElement, settle } from './press.mjs';

// A select-only ARIA combobox (non-input role=combobox, as the snapshot exposes it): its listbox's option elements —
// the listbox it controls/owns, else the nearest one in its wrapper (same rule as the snapshot).
export const ariaOptions = (e) => {
  const ids = `${e.getAttribute("aria-controls") || ""} ${e.getAttribute("aria-owns") || ""}`.split(/\s+/).filter(Boolean);
  let listbox = ids.map((id) => document.getElementById(id)).find((node) => node?.getAttribute("role") === "listbox") || null;
  for (let node = e.parentElement, depth = 0; !listbox && node && depth < 4; node = node.parentElement, depth += 1) {
    // An empty placeholder listbox can precede the real one: take the first that holds options.
    listbox = Array.from(node.querySelectorAll("[role='listbox']")).find((box) => box.querySelector("[role='option']")) || null;
  }
  return listbox ? Array.from(listbox.querySelectorAll("[role='option']")) : [];
};
// A native <select> carrying role="combobox" (iCIMS) is still driven natively.
export const isAriaSelect = (e) => e.getAttribute("role") === "combobox" && !(e instanceof HTMLInputElement) && !(e instanceof HTMLSelectElement)
  && !e.querySelector("input,textarea,[contenteditable='true']");

export async function selectAria(page, el, ref, wanted) {
  await pressElement(el);
  await settle(500);
  // ariaOptions runs through evaluateHandle (CDP callFunctionOn), never page-side eval, so strict-CSP pages allow it.
  const options = await el.evaluateHandle(ariaOptions);
  const option = await options.evaluateHandle((list, wanted) => {
    const needle = wanted.replace(/\s+/g, " ").trim().toLowerCase();
    return list.find((o) => o.textContent.replace(/\s+/g, " ").trim().toLowerCase() === needle
      || o.getAttribute("data-value") === wanted) || null;
  }, wanted);
  if (await option.evaluate((o) => o === null)) {
    await page.keyboard.press("Escape");
    throw new Error(`select failed on ref ${ref}: no option matching "${wanted}"`);
  }
  await pressElement(option);
  await settle(400);
  const shown = await el.evaluate((e) => e.textContent.replace(/\s+/g, " ").trim().toLowerCase());
  if (!shown.includes(wanted.replace(/\s+/g, " ").trim().toLowerCase())) {
    throw new Error(`select failed on ref ${ref}: the dropdown kept no choice`);
  }
}

// An ARIA-less custom dropdown (snapshot marks its trigger data-omp-dropdown; the ref is its hidden input): open it,
// type the answer into its search box when one appears, then click the row whose text equals the answer.
export async function selectCustom(page, el, ref, wanted) {
  const trigger = await el.evaluateHandle((e) => e.closest("[data-omp-dropdown]"));
  await pressElement(trigger);
  await settle(400);
  const search = await trigger.evaluateHandle((t) => Array.from(t.parentElement.querySelectorAll("input:not([type='hidden'])"))
    .find((input) => input.offsetParent !== null) || null);
  if (await search.evaluate((s) => s !== null)) {
    // Focus directly: a mouse click can land on an overlapping element and close the list (blur-to-close widgets).
    await search.evaluate((s) => { s.focus(); s.value = ""; });
    await search.type(wanted);
    await settle(500);
  }
  const row = await trigger.evaluateHandle((t, wanted) => {
    const needle = wanted.replace(/\s+/g, " ").trim().toLowerCase();
    const text = (node) => node.textContent.replace(/\s+/g, " ").trim().toLowerCase();
    return Array.from(t.parentElement.querySelectorAll("*")).find((node) => !t.contains(node) && node.offsetParent !== null
      && text(node) === needle && !Array.from(node.children).some((child) => text(child) === needle)) || null;
  }, wanted);
  if (await row.evaluate((r) => r === null)) {
    await page.keyboard.press("Escape");
    throw new Error(`select failed on ref ${ref}: no option matching "${wanted}"`);
  }
  await pressElement(row);
  await settle(300);
  if (!await el.evaluate((e) => Boolean(e.value))) throw new Error(`select failed on ref ${ref}: the dropdown kept no choice`);
  // Widgets set the hidden input by script, which fires nothing; let the site's validator re-check it.
  await el.evaluate((e) => e.dispatchEvent(new Event("change", { bubbles: true })));
}

// A native select fed by a type-to-search companion widget (select2-style ajax dropdowns, iCIMS address/country
// pickers): the select holds at most its current choice; a sibling trigger opens a box whose search input loads the
// options as rows. `part` picks the trigger or the search input (null when the select has no such companion).
export const searchCompanion = (e, part) => {
  if (!(e instanceof HTMLSelectElement) || Array.from(e.options).filter((o) => o.value !== "").length > 1) return null;
  const parent = e.parentElement;
  if (!parent || parent.querySelectorAll("select").length !== 1) return null;
  const trigger = Array.from(parent.children).find((n) => n !== e && n.getClientRects().length
    && (n.getAttribute("role") === "combobox" || n.hasAttribute("aria-expanded"))) || null;
  const search = parent.querySelector("input[aria-autocomplete],input[class*='search' i]");
  if (!trigger || !search) return null;
  return part === "trigger" ? trigger : search;
};
// Last query typed per select ref: the pick re-types it, since a row's full text ("42 Oak St, Fairview …") is
// not always a query the lookup answers.
export const companionQueries = new Map();

// Opens the companion box, types `query`, and returns the result rows' texts once the lookup answers (≤4 s).
export async function companionSearch(page, el, query) {
  const trigger = await el.evaluateHandle(searchCompanion, "trigger");
  const search = await el.evaluateHandle(searchCompanion, "search");
  await pressElement(trigger);
  await settle(300);
  await search.evaluate((s) => { s.focus(); s.value = ""; });
  await search.type(query);
  const rows = () => search.evaluate((s) => {
    const list = document.getElementById(s.getAttribute("aria-controls") || "") || s.parentElement;
    return Array.from(list.querySelectorAll("li,[role='option']")).filter((row) => row.getClientRects().length && !row.querySelector("li"))
      .map((row) => row.textContent.replace(/\s+/g, " ").trim())
      .filter((text) => text && !/^(searching|loading|no (results|matches)|please enter|type to search)\b/i.test(text.replace(/^[—–-]\s*/, "")));
  });
  let texts = [];
  for (let waited = 0; waited < 4000 && !texts.length; waited += 400) {
    await settle(400);
    texts = await rows();
  }
  return texts;
}

export async function selectCompanion(page, el, ref, wanted) {
  const queries = [...new Set([wanted, companionQueries.get(ref)].filter(Boolean))];
  const needle = wanted.replace(/\s+/g, " ").trim().toLowerCase();
  for (const query of queries) {
    if (!(await companionSearch(page, el, query)).length) continue;
    const search = await el.evaluateHandle(searchCompanion, "search");
    const row = await search.evaluateHandle((s, needle) => {
      const list = document.getElementById(s.getAttribute("aria-controls") || "") || s.parentElement;
      return Array.from(list.querySelectorAll("li,[role='option']")).find((r) => r.getClientRects().length && !r.querySelector("li")
        && r.textContent.replace(/\s+/g, " ").trim().toLowerCase() === needle) || null;
    }, needle);
    if (await row.evaluate((r) => r === null)) continue;
    await pressElement(row);
    await settle(400);
    if (!await el.evaluate((e) => Boolean(e.value))) throw new Error(`select failed on ref ${ref}: the dropdown kept no choice`);
    return;
  }
  await page.keyboard.press("Escape");
  throw new Error(`select failed on ref ${ref}: no option matching "${wanted}"`);
}
