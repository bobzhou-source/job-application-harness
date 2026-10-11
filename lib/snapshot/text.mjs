// lib/snapshot/text.mjs — visible-text extraction: label text, required markers, preceding/prompt text, widget box, signup blocks, aria-labelledby text.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
  const textOf = (el) => (el ? clean(el.innerText || el.textContent || "") : "");
  // A label's own visible words, text pieces joined by spaces ("Full name" + "✱", "Attach" + hidden status text):
  // the text of embedded controls (a hidden <select>'s options, a widget's chips or search box) and hidden
  // status text are not part of the question.
  const labelText = (el) => {
    if (!el) return "";
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent) continue;
      // Only controls/lists embedded inside the label are excluded; a list the label itself sits in (checkbox
      // options in a <ul>) is not.
      const embedded = parent.closest("select,option,textarea,[role='listbox'],[role='option'],ul");
      if (embedded && embedded !== el && el.contains(embedded)) continue;
      if (parent !== el && !el.contains(parent)) continue;
      const style = window.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!parent.getClientRects().length) continue;
      const text = clean(node.textContent);
      // A lone required marker ("✱", "*") is not part of the question.
      if (text && !/^[*✱✳＊•]+$/.test(text)) parts.push(text);
    }
    return clean(parts.join(" "));
  };
  // A lone required marker ("*") or an asterisk/mandatory-classed element in the field's own wrapper (the nearest
  // ancestors that hold no other field) marks it required when the label text itself dropped the marker.
  const starred = (el) => {
    for (let node = el.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
      if (node.querySelectorAll("input:not([type='hidden']),select,textarea").length > 1) return false;
      const marker = Array.from(node.querySelectorAll("span,abbr,sup,i,b,strong,em,div,label"))
        .find((n) => !n.children.length && (/^[*✱✳＊]$/.test(clean(n.textContent))
          || (/asterisk|mandatory/i.test(typeof n.className === "string" ? n.className : "") && clean(n.textContent))));
      if (marker) return isVisible(marker);
    }
    return false;
  };
  // Nearest visible text before `el` in document order (outside `el`), skipping
  // punctuation-only text such as required-field asterisks. Bounded walk.
  const precedingText = (el, cap = 60, skip = el) => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    for (let steps = 0; steps < 40; steps += 1) {
      const node = walker.previousNode();
      if (!node) return "";
      if (el.contains(node) || skip.contains(node)) continue;
      const text = clean(node.nodeValue);
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;
      // Choice lists (a <select>'s options, a rendered listbox) and the option labels of radios/checkboxes are
      // answers, not the question.
      if (parent.closest("select,option,[role='listbox'],[role='option'],[role='tree'],[role='treeitem']")) continue;
      const optionLabel = parent.closest("label");
      if (optionLabel && optionLabel.querySelector("input[type='radio'],input[type='checkbox']")) continue;
      // Bare required/optional markers are not the question either.
      if (/^(required|optional|\(required\)|\(optional\))$/i.test(text)) continue;
      return cut(text, cap);
    }
    return "";
  };
  // The whole instruction block above a free-text box: preceding visible text back to the previous form control
  // (or cap chars), in reading order. A long prompt ("We don't need a cover letter, but… Things like: …") often
  // ends in a bullet that the label alone captures; a written answer must answer the block.
  const promptText = (el, cap = 1200) => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    const parts = [];
    let length = 0;
    for (let node = walker.previousNode(); node && length < cap; node = walker.previousNode()) {
      if (node.nodeType === 1) {
        if (node.matches("input:not([type='hidden']),select,textarea,button,[data-omp-dropdown]") && !node.contains(el) && isVisible(node.parentElement)) break;
        continue;
      }
      const text = clean(node.nodeValue);
      if (node.parentElement?.closest("[data-omp-dropdown]")) break;
      if (!/[\p{L}\p{N}]/u.test(text) || !node.parentElement || !isVisible(node.parentElement)) continue;
      parts.unshift(text);
      length += text.length + 1;
    }
    return cut(parts.join(" "), cap);
  };
  // A select-only combobox input's visible box: the outermost ancestor (up to 4 levels) that is one line tall and
  // holds no other form control. Custom dropdowns show the chosen option as text in it, and anchor their list to it.
  const widgetOf = (el) => {
    let widget = el;
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
      if (node.getBoundingClientRect().height > 64 || node.querySelectorAll("input,select,textarea").length > 1) break;
      widget = node;
    }
    return widget;
  };
  const byIdText = (ids) =>
    clean(ids)
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(document.getElementById(id)))
      .filter(Boolean)
      .join(" ")
      .trim();
  // A newsletter/email-updates signup block ("Sign up for Email Updates" over an Email box and Submit): the nearest
  // short ancestor (at most 300 characters of text) names it. Marks fields and controls inside it as `signup`.
  const SIGNUP = /\b(subscribe|newsletter|mailing list|e-?mail updates|sign up for (our )?(e-?mails?|updates|news|insights)|stay (informed|connected|up to date|in touch)|job alerts?|talent (community|network))\b/i;
  const inSignup = (el) => {
    for (let node = el.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
      const text = clean(node.innerText || "");
      if (text.length > 300) return false;
      if (SIGNUP.test(text)) return true;
    }
    return false;
  };
  // A label never comes from a live region (react-datepicker labels its input by "Date picker opened. Selected date
  // is 06/2030"); error hints still may (they are often role=alert).
  const live = (node) => node && (node.getAttribute("aria-live") || /^(status|log|alert|timer|marquee)$/i.test(node.getAttribute("role") || ""));
  const labelIdText = (ids) =>
    clean(ids)
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter((node) => node && !live(node))
      .map(textOf)
      .filter(Boolean)
      .join(" ")
      .trim();
  const type0 = (el) => (el.getAttribute("type") || "").toLowerCase();

}
