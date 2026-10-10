// lib/snapshot.mjs — in-page DOM snapshot with stable refs.
//
// Ref format (resolved by lib/act.mjs):
//   main frame:   "e<N>"                           — data-omp-ref="e<N>" stamped in the top document
//   child frame:  "f<encodeURIComponent(id)>:e<N>" — id is the frame's stable CDP frame ID
//                                                  (frame._id ?? frame._frameId), NEVER its
//                                                  page.frames() array position, which shifts as
//                                                  frames attach/detach. A child frame without a
//                                                  stable ID is skipped entirely rather than
//                                                  emitting a ref act.mjs cannot resolve.
// The local id (the part after the first ":") is what is stamped as
// data-omp-ref inside that frame's document.
// The counter lives on each frame's window (window.__ompRefCounter), so a ref keeps
// naming the same node across snapshots while that node lives; a navigation replaces
// the document and mints fresh refs.
//
// Associated forms get the same DOM-lifetime treatment: each form element is
// stamped once with data-omp-form-ref="r<N>" (window.__ompFormRefCounter), and
// Control.formRef / Field.formRef name that form (a radio/checkbox group uses
// its first member's form). Child-frame formRefs carry the frame prefix above
// so they stay unique across documents; the main frame stays local.
//
// Label/visibility/ref-stamping ideas are adapted from the proven legacy in-page
// script (its domObserveFrame), rewritten compact: label chain aria-label →
// aria-labelledby → <label for>/wrapping label → button/link own text →
// fieldset legend → placeholder → title → name; group questions
// from fieldset legend or role=group/radiogroup aria labeling.

// Snapshot size caps. Kept well above real application forms (a long Workday
// page is ~60 fields) so a final-submit control is never dropped by the cap,
// while still bounding an anomalous page.
const CAP_CONTROLS = 400;
const CAP_FIELDS = 300;

// Runs inside one frame's document. Must be self-contained: serialized by evaluate.
function collectInFrame() {
  const CAP_LABEL = 120;
  const CAP_OPTION = 80;
  const CAP_OPTIONS = 40;
  const CAP_VALUE = 200;
  const CAP_HREF = 300;

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const stamp = (el) => {
    let ref = el.getAttribute("data-omp-ref");
    if (!ref) {
      window.__ompRefCounter = (window.__ompRefCounter || 0) + 1;
      ref = "e" + window.__ompRefCounter;
      try {
        el.setAttribute("data-omp-ref", ref);
      } catch {
        /* frozen node: ref stays page-local for this snapshot */
      }
    }
    return ref;
  };

  // Stable form ownership ref: one id per form element for the document's
  // lifetime (same window-counter pattern as data-omp-ref), so rules.mjs can
  // scope fields to the form that owns the active controls and ignore
  // newsletter/search forms. el.form covers controls associated through
  // form="<id>" that live outside the form element; closest() covers
  // non-form elements (links, role widgets). Only the ref is exposed —
  // never the form's text or contents.
  const formRefFor = (el) => {
    const form = el.form || (el.closest ? el.closest("form") : null);
    if (!form) return "";
    let ref = form.getAttribute("data-omp-form-ref");
    if (!ref) {
      window.__ompFormRefCounter = (window.__ompFormRefCounter || 0) + 1;
      ref = "r" + window.__ompFormRefCounter;
      try {
        form.setAttribute("data-omp-form-ref", ref);
      } catch {
        /* frozen node: ref stays page-local for this snapshot */
      }
    }
    return ref;
  };

  const isVisible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  // matches(":disabled") also catches fieldset-disabled descendants, which the
  // el.disabled IDL property alone does not reflect.
  const isDisabled = (el) => {
    try {
      if (el.matches(":disabled")) return true;
    } catch {
      /* non-form element */
    }
    return el.disabled === true || el.getAttribute("aria-disabled") === "true";
  };

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

  // Legacy label chain (cdp-service.js labelOf), order preserved. `own` stops before the placeholder/title/name
  // fallbacks, so a field with no real label can take the question shown before it instead.
  const labelOf = (el, own = false) => {
    // A generic aria-label ("Link opens in new tab") hides the element's real name: use its own text, adding the hint.
    const aria = clean(el.getAttribute("aria-label"));
    if (aria && /^(this )?link (opens|will open) in (a )?new (tab|window)\.?$|^opens? in (a )?new (tab|window)\.?$/i.test(aria)) {
      const own = clean(el.innerText || el.textContent);
      if (own) return `${own} (${aria.toLowerCase()})`;
    }
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelIdText(labelledBy);
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = Array.from(el.labels).map(labelText).filter(Boolean).join(" ").trim();
      // A file input whose own label is just the action ("Attach", "Upload") is named by its upload group
      // (Greenhouse: role=group aria-labelledby "Resume/CV" / "Cover Letter"); otherwise every slot reads "Attach".
      if (text && type0(el) === "file" && /^(attach|upload|browse|choose( a)? file|select( a)? file|add file)s?\b.{0,12}$/i.test(text)) {
        const group = el.closest("[role='group'][aria-labelledby], fieldset");
        const named = group && (group.getAttribute("aria-labelledby") ? byIdText(group.getAttribute("aria-labelledby")) : textOf(group.querySelector("legend")));
        if (named) return named;
      }
      if (text) return text;
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) {
      const text = labelText(wrapping);
      if (text) return text;
    }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    // role=button/link widgets (an account-chooser tile) are named by their own text, like native ones.
    const action =
      tag === "button" ||
      tag === "a" ||
      role === "button" ||
      role === "link" ||
      (tag === "input" && ["submit", "button", "reset", "image"].includes(type));
    if (action) {
      const own = textOf(el);
      if (own) return own;
      if (tag === "input" && el.value) return clean(el.value);
    }
    const fieldset = el.closest ? el.closest("fieldset") : null;
    if (fieldset && !action) {
      const text = textOf(fieldset.querySelector("legend"));
      if (text) return text;
    }
    if (own) return "";
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    const title = clean(el.getAttribute("title"));
    if (title) return title;
    return clean(el.getAttribute("name"));
  };

  // The question a grouped control answers (legacy questionOf): fieldset legend or
  // an enclosing role=group/radiogroup's aria labeling. A radio labelled "Yes"
  // inside "Are you authorized to work?" answers the latter.
  const questionOf = (el) => {
    const fieldset = el.closest ? el.closest("fieldset") : null;
    if (fieldset) {
      const text = textOf(fieldset.querySelector("legend"));
      if (text) return text;
    }
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (typeof node.getAttribute !== "function") break;
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (role !== "group" && role !== "radiogroup") continue;
      const labelledBy = node.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = byIdText(labelledBy);
        if (text) return text;
      }
      const aria = clean(node.getAttribute("aria-label"));
      if (aria) return aria;
    }
    return "";
  };

  // A radio or checkbox the site hides behind a styled label (custom Yes/No groups, language tiles): the label
  // is what the applicant clicks, so it becomes that option's own ref. A visible
  // input is its own ref. Null for anything else, so hidden state boxes
  // (display:none, no label) stay out of the snapshot as before.
  const optionElementFor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input") return null;
    if (!["radio", "checkbox"].includes((el.getAttribute("type") || "").toLowerCase())) return null;
    if (isVisible(el)) return el;
    const candidates = [];
    if (el.labels) candidates.push(...Array.from(el.labels));
    const id = el.getAttribute("id");
    if (id) {
      try {
        candidates.push(...Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`)));
      } catch {
        /* id not usable in a selector */
      }
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) candidates.push(wrapping);
    const sibling = el.nextElementSibling;
    if (sibling && sibling.tagName === "LABEL") candidates.push(sibling);
    const label = candidates.find((label) => label && isVisible(label));
    if (label) return label;
    // A twin widget the site shows instead (an <i role="checkbox" aria-label="I agree to …"> beside the hidden
    // input): same accessible name, within the input's nearby container.
    const name = clean(el.getAttribute("aria-label") || el.getAttribute("value") || "");
    if (!name) return null;
    for (let node = el.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
      const twin = Array.from(node.querySelectorAll(`[role='${el.type}']`))
        .find((other) => other !== el && isVisible(other) && clean(other.getAttribute("aria-label") || other.textContent || "") === name);
      if (twin) return twin;
    }
    return null;
  };
  // A hidden input's state, or its visible ARIA twin's when the site toggles only the twin.
  const isChecked = (el) => {
    if (el.checked) return true;
    const shown = optionElementFor(el);
    return Boolean(shown && shown !== el && shown.getAttribute("aria-checked") === "true");
  };
  // The visible words of a radio/checkbox option: its label chain, else its own text
  // (a styled widget's box) or value.
  const optionLabelOf = (el) =>
    clean(labelOf(el)) || (el.tagName.toLowerCase() === "input" ? clean(el.getAttribute("value")) : textOf(el));

  // Candidate elements across the document plus open shadow roots (legacy
  // collectRoots). Nested same-origin iframes are reached via page.frames(),
  // not here.
  const roots = [];
  const addRoots = (root) => {
    roots.push(root);
    for (const node of Array.from(root.querySelectorAll("*"))) {
      if (node.shadowRoot) addRoots(node.shadowRoot);
    }
  };
  addRoots(document);
  const seen = new Set();
  const elements = [];
  const SELECTOR =
    "input,textarea,select,button,a[href],[role='button'],[role='link'],[role='combobox']:not(input),[role='listbox'][aria-haspopup]:not([aria-haspopup='false']),[role='radio'],[contenteditable=''],[contenteditable='true']";
  // A <button role="option"> list row is a choice, collected with the options below, not a button.
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(SELECTOR))) {
      if (!seen.has(el) && !el.matches("[role='option']")) {
        seen.add(el);
        elements.push(el);
      }
    }
  }

  // Enabled applicant-fillable inputs owned by the control's nearest form (0 when
  // outside one). This is what distinguishes a listing page's bare "Apply" button
  // from an in-form final submit (see docs/ARCHITECTURE.md, Control.formFieldCount).
  const applicantFieldCount = (el) => {
    const form = el.form || (el.closest ? el.closest("form") : null);
    if (!form) return 0;
    let n = 0;
    // form.elements (not form.querySelectorAll) so controls associated through
    // form="<id>" — which live outside the form element — are counted.
    for (const node of Array.from(form.elements)) {
      const nodeTag = String(node.tagName || "").toLowerCase();
      if (nodeTag !== "input" && nodeTag !== "textarea" && nodeTag !== "select") continue;
      const nodeType = (node.getAttribute("type") || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(nodeType)) continue;
      if (node.disabled === true || node.getAttribute("aria-disabled") === "true") continue;
      try {
        if (node.matches(":disabled")) continue;
      } catch {
        /* non-form node */
      }
      n += 1;
    }
    return n;
  };

  // MFA/OTP gate: phrases matched on whitespace/punct-normalized label+name with
  // word boundaries, so generic "password" or security-question text never trips
  // it. autocomplete="one-time-code" matches as a case-insensitive token, since
  // the attribute may list several tokens. Only visible, enabled fields (the
  // loop below has already skipped hidden/disabled ones) arm the gate.
  const MFA_LABEL =
    /\b(verification code|one time code|one time password|otp|mfa|2fa|two factor|authenticator code)\b/;
  const mfaNorm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ");
  // A dropdown box's prompt text ("Select One", "Choose…", "— Please Specify —") is no choice.
  const PROMPT = /^[\s\-–—]*(please\s+)?(select|choose|specify)\b/i;
  let mfaSeen = false;

  const controls = [];
  const fields = [];
  // "radio|checkbox\n<formRef>\n<name>" -> { type, name, members }; the form ref
  // in the key keeps same-name inputs from different forms in separate groups.
  const groups = new Map();
  // Enhanced selects (Chosen, Select2, selectize): the native <select> is hidden and a visible widget inserted right
  // after it stands in for it. The native select (its own label and full option list) is the field; the widget's
  // inner search box is skipped, since its placeholder ("Select an option") is not the question.
  const replacements = new Set();
  for (const root of roots) {
    for (const select of Array.from(root.querySelectorAll("select"))) {
      const widget = select.nextElementSibling;
      if (!isVisible(select) && widget && isVisible(widget) && !widget.matches("select,input,textarea")) replacements.add(widget);
    }
  }
  const replacedSelect = (el) => el.tagName === "SELECT" && replacements.has(el.nextElementSibling);
  // Custom dropdowns with no ARIA at all: a named hidden input holds the choice, inside a one-line pointer-cursor box
  // (the trigger, marked data-omp-dropdown for act.select) whose parent also holds the choice rows (<li>, else the
  // outermost pointer-cursor elements outside the trigger). The hidden input is the field; the box's own search
  // input and rows are driven by act.select, not exposed separately.
  const customDropdowns = new Map();
  for (const root of roots) {
    for (const input of Array.from(root.querySelectorAll("input[type='hidden'][name]"))) {
      let trigger = null;
      for (let node = input.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
        if (getComputedStyle(node).cursor === "pointer" && node.getBoundingClientRect().height <= 64
            && !node.querySelector("input:not([type='hidden']),select,textarea,button,a[href]")) trigger = node;
        else if (trigger) break;
      }
      // The trigger itself may be hidden while its list is open; the dropdown's box stays visible.
      const box = trigger?.parentElement;
      if (!box || !isVisible(box)) continue;
      let rows = Array.from(box.querySelectorAll("li")).filter((li) => !li.querySelector("li") && !trigger.contains(li));
      if (!rows.length) {
        rows = Array.from(box.querySelectorAll("*")).filter((node) => !trigger.contains(node) && node.parentElement
          && getComputedStyle(node).cursor === "pointer" && getComputedStyle(node.parentElement).cursor !== "pointer");
      }
      rows = rows.filter((row) => clean(row.textContent));
      if (rows.length < 2) continue;
      trigger.setAttribute("data-omp-dropdown", "");
      customDropdowns.set(input, { trigger, box, rows });
    }
  }
  const insideDropdown = (el) => [...customDropdowns.entries()].some(([input, { box }]) => el !== input && box.contains(el));

  // Text-entry autocompletes do not always announce themselves with ARIA. Keep the
  // search inside the nearest single-field wrapper: a sibling suggestion-list
  // container (even while hidden), or a paired hidden selected*/...Id value, means
  // the visible text is only valid after a suggestion is chosen.
  // Widget libraries often omit ARIA autocomplete but identify choice inputs in
  // role/class/data-* metadata (multiselect, select-input, combobox, prompt).
  // Match bounded semantic tokens only; arbitrary label/body text is never used.
  const semanticWidgetText = (node) => {
    if (!node?.attributes) return "";
    const parts = [node.getAttribute("role") || "", node.getAttribute("class") || ""];
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith("data-")) parts.push(attr.name.slice(5), attr.value);
    }
    return parts.join(" ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  };
  const CHOICE_WIDGET_TOKEN =
    /(?:^| )(?:multi ?select|select ?input|combo ?box|prompt)(?: |$)/;
  const marksChoiceWidget = (node) => CHOICE_WIDGET_TOKEN.test(semanticWidgetText(node));

  const SUGGESTION_LIST_SELECTOR = [
    "[role='listbox']",
    "[class~='dropdown']",
    "[class~='typeahead']",
    "[class~='autocomplete']",
    "[class~='suggestions']",
    "[class~='results']",
    "[class*='dropdown-container' i]",
    "[class*='dropdown-menu' i]",
    "[class*='dropdown-list' i]",
    "[class*='dropdown-results' i]",
    "[class*='select__dropdown' i]",
    "[class*='select-dropdown' i]",
    "[class*='suggestion-container' i]",
    "[class*='suggestion-list' i]",
    "[class*='result-container' i]",
    "[class*='result-list' i]",
    "[class*='typeahead-menu' i]",
    "[class*='autocomplete-list' i]",
    "[class*='autocomplete-results' i]",
    "[class*='search-results' i]",
  ].join(",");
  const autocompleteWidgets = new Map();
  const autocompleteInputs = new Set();
  const structuralAutocompleteFor = (el) => {
    const visibleName = clean(el.getAttribute("name") || el.id).toLowerCase().replace(/[^a-z0-9]/g, "");
    const inputMarksChoiceWidget = marksChoiceWidget(el);
    // A wrapper marked as a choice widget (or holding its hidden value) may sit below the one holding the popup list
    // (a select's own selector box under the select that also renders its dropdown): climb on for the list.
    let marked = null;
    for (let wrapper = el.parentElement, depth = 0; wrapper && depth < 7; wrapper = wrapper.parentElement, depth += 1) {
      // Crossing into a wrapper with another fillable field would let one field
      // claim a neighboring field's dropdown, hidden backing value, or widget metadata.
      const editors = Array.from(wrapper.querySelectorAll(
        "input:not([type='hidden']),textarea,select,[contenteditable=''],[contenteditable='true']"
      ));
      if (editors.some((other) => other !== el)) break;
      const lists = Array.from(wrapper.querySelectorAll(SUGGESTION_LIST_SELECTOR))
        .filter((list) => !list.contains(el));
      if (lists.length) return { wrapper, lists };
      const paired = Array.from(wrapper.querySelectorAll("input[type='hidden'][name]")).find((hidden) => {
        const raw = clean(hidden.getAttribute("name"));
        const name = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (/^(selected|selection|chosen|choice)/i.test(raw)) return true;
        return Boolean(visibleName && name.includes(visibleName) && /(id|key|value)$/.test(name));
      });
      if (!marked && (paired || inputMarksChoiceWidget || marksChoiceWidget(wrapper))) marked = { wrapper, lists };
    }
    return marked;
  };


  for (const el of elements) {
    if (replacements.size && [...replacements].some((widget) => widget.contains(el))) continue;
    if (customDropdowns.size && insideDropdown(el)) continue;
    const tag = el.tagName.toLowerCase();
    const declared = (el.getAttribute("type") || (tag === "input" ? "text" : "")).toLowerCase();
    // A text input labeled as a password (a "show password" toggle, or a site masking a plain text box with CSS)
    // is a password: its value never enters a snapshot and it takes Keychain credentials. A one-time password is a code.
    const type = tag === "input" && declared === "text" && /\b(password|passwort|mot de passe)\b/i.test(labelOf(el))
      && !/\bone.?time\b|\botp\b/i.test(labelOf(el)) ? "password" : declared;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const isFile = tag === "input" && type === "file";
    // File inputs are routinely visually hidden behind a styled label; keep them
    // (legacy behavior) so the resume upload stays reachable. A radio hidden behind
    // its clickable label (custom Yes/No group) is kept the same way.
    if (!isVisible(el) && !isFile && !replacedSelect(el) && !customDropdowns.has(el)
        && !((type === "radio" || type === "checkbox") && optionElementFor(el))) continue;
    if (isDisabled(el)) continue;
    // Outside the accessibility tree (aria-hidden): a backing element for a custom widget (e.g. the native
    // <select> behind a select2 combobox), not what the applicant operates.
    if (!isFile && el.closest("[aria-hidden='true']")) continue;

    // A non-input combobox owning no text box is a select-only dropdown (ARIA listbox pattern): a choice field, with
    // options read from its listbox while open. One holding a text box is a popup trigger (clicked to open). A
    // collapsed listbox announcing a popup (ARIA 1.0 select, Dojo's dijit Select) is the same select-only dropdown;
    // its hidden/presentational inputs (the posted value, a focus sink) are no text box.
    const popupListbox = role === "listbox" && /^(true|listbox|menu)$/i.test(el.getAttribute("aria-haspopup") || "");
    const ariaSelect = (role === "combobox" || popupListbox) && tag !== "input"
      && !el.querySelector("input:not([type='hidden']):not([role='presentation']),textarea,[contenteditable='true']");
    const isAction =
      tag === "button" ||
      tag === "a" ||
      role === "button" ||
      role === "link" ||
      (role === "combobox" && tag !== "input" && !ariaSelect) ||
      (tag === "input" && ["submit", "button", "reset", "image"].includes(type));
    if (isAction) {
      const control = {
        ref: stamp(el),
        kind: tag === "a" || role === "link" ? "link" : "button",
        label: cut(labelOf(el), CAP_LABEL),
      };
      // Native control type: <button> defaults to "submit"; inputs report their own
      // type; role-only widgets (div[role=button]) have none.
      const controlType =
        tag === "button"
          ? el.getAttribute("type") || "submit"
          : tag === "input"
            ? el.getAttribute("type") || "text"
            : "";
      if (controlType) control.type = controlType;
      if (control.kind === "link" && el.href) control.href = cut(String(el.href), CAP_HREF);
      control.formFieldCount = applicantFieldCount(el);
      // Disclosure state (dropdown/menu buttons): lets the driver see a list is already open.
      const expanded = el.getAttribute("aria-expanded");
      if (expanded === "true" || expanded === "false") control.expanded = expanded === "true";
      // A popup trigger's own text is its current selection (custom selects show the chosen option).
      const haspopup = el.getAttribute("aria-haspopup");
      if (haspopup && haspopup !== "false") {
        control.current = cut(textOf(el), CAP_LABEL);
        // Labelled only by its own selection ("Select question"): prefix the nearest visible text
        // before it in the document (e.g. "Question 3"), as a reader of the form would.
        if (clean(control.label).toLowerCase() === clean(control.current).toLowerCase()) {
          const context = precedingText(el);
          if (context) control.label = cut(`${context} ${control.current}`, CAP_LABEL);
        }
      }
      // A remove/close button beside an already-attached document ("resume_general.pdf  ×"): the file it
      // removes and the document its section asks for, so a wrong pre-attached file can be swapped.
      if (/^(close|remove|delete|clear|x|×)\b/i.test(clean(control.label)) && clean(control.label).length <= 30) {
        for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
          const text = clean(node.innerText || node.textContent || "");
          if (text.length > 400) break;
          const file = text.match(/[\w() .,'-]+?\.(pdf|docx?|txt|rtf|odt)\b/i);
          const failed = /went wrong|try (uploading )?again|upload(ing)? failed|failed to upload|could not (be )?upload/i.test(text);
          if (file || failed) {
            if (file && !failed) control.attached = file[0].trim();
            else control.uploadError = true;
            // The slot is the nearest ancestor naming a document kind outside the chip's own text: the chip itself
            // ("resume_consumer.pdf Preview document") names none ("Preview document" is the chip's link).
            let section = node;
            for (let up = 0; section && up < 4 && !/\b(resume|résumé|cv|cover\s*letter|transcript|documents?)\b/i.test(clean(section.innerText || "").replace(text, "")); up += 1) section = section.parentElement;
            const context = clean(section?.innerText || "");
            if (context.length <= 600) control.context = cut(context, 160);
            break;
          }
        }
      }
      const controlFormRef = formRefFor(el);
      if (controlFormRef) control.formRef = controlFormRef;
      if (inSignup(el)) control.signup = true;
      controls.push(control);
      continue;
    }

    // A nameless checkbox/radio inside a labelled group container (role=group, fieldset) with several such inputs
    // belongs to that group: the container stands in for the shared name.
    const groupBox = tag === "input" && (type === "radio" || type === "checkbox") && !el.name
      ? el.closest("[role='group'],[role='radiogroup'],fieldset") : null;
    const groupName = el.name || (groupBox && groupBox.querySelectorAll(`input[type='${type}']`).length > 1 ? `group:${stamp(groupBox)}` : "");
    if (tag === "input" && (type === "radio" || type === "checkbox") && groupName) {
      // Same-name inputs merge only within one form (native radio-group
      // semantics): the owning form's ref in the key keeps identical names in
      // different forms from ever becoming one group. The tuple is carried in
      // the map value, so the key itself is never re-parsed.
      const groupForm = formRefFor(el);
      const key = type + "\n" + groupForm + "\n" + groupName;
      if (!groups.has(key)) groups.set(key, { type, name: el.name, members: [], box: groupBox });
      groups.get(key).members.push(el);
      stamp(el); // every member keeps its own ref so a specific option stays clickable
      continue;
    }

    if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable || ariaSelect) {
      let value = "";
      if (type === "password") {
        value = ""; // secrets never enter a snapshot
      } else if (isFile) {
        // Attachment state only — never the local filename or path. A file the site reports it failed to take
        // (its label/hint text says the upload errored) is not attached: the site holds nothing.
        const failed = /\b(error|failed|could ?n[o']t|unable to|try again)\b/i.test(labelOf(el));
        value = el.files && el.files.length > 0 && !failed ? "attached" : "";
      } else if (tag === "select") {
        // The chosen option's visible text (option values are often opaque ids); a placeholder
        // (<option value=""> or a blank-text option with an id value, "0"/"-1") stays empty and fillable; multi-select
        // joins with ", " as groups do.
        const chosen = Array.from(el.selectedOptions).filter((o) => o.value !== "" && clean(o.textContent));
        value = chosen.map((o) => clean(o.textContent)).join(", ");
      } else if (type === "checkbox" || type === "radio") {
        value = isChecked(el) ? "checked" : "";
      } else if (el.isContentEditable && !("value" in el)) {
        value = clean(el.innerText);
      } else if (ariaSelect) {
        // Its shown text minus its own label (floating labels sit inside the box) and placeholder text. Sites often
        // list the selection's own element after the label in aria-labelledby; only the first id is the label.
        const labelIds = new Set((el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).slice(0, 1));
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const parts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent || !isVisible(parent) || parent.closest("[class*='placeholder' i]")) continue;
          if ([...labelIds].some((id) => document.getElementById(id)?.contains(node))) continue;
          parts.push(clean(node.nodeValue));
        }
        value = parts.filter(Boolean).join(" ");
        const label = clean(labelIds.size ? document.getElementById([...labelIds][0])?.textContent : labelOf(el, true)).toLowerCase();
        if (value.toLowerCase() === label || PROMPT.test(value)) value = "";
      } else if ("value" in el && el.value != null) {
        value = String(el.value);
      }
      // A select-only combobox (custom dropdown) shows its chosen option as text in its widget box, not in the
      // input's value. That text is the field's value, and never the question. An ARIA-less custom dropdown keeps
      // its value in the hidden input; its trigger text is a placeholder or that same choice, never the question.
      const custom = customDropdowns.get(el);
      // A select-only combobox that is itself an empty sliver (react-select v1: a 1px focus div beside the shown
      // choice) shows its value in the surrounding widget box, like a combobox input.
      const widget = custom ? custom.trigger
        : (tag === "input" && el.getAttribute("role") === "combobox") || (ariaSelect && !value) ? widgetOf(el) : el;
      // True when the value is the widget's displayed choice (the input itself is empty): a committed pick.
      let shownChoice = false;
      if (widget !== el && !custom) {
        if (!value) {
          // Placeholder text ("Select…") is not a choice; dropdown libraries mark it with a placeholder class.
          const walker = document.createTreeWalker(widget, NodeFilter.SHOW_TEXT);
          const parts = [];
          // The widget's own popup list (every suggestion row) is not its value. A lone selected option outside any
          // list (react-select v1 renders the chosen value as role=option aria-selected) is the shown choice. A
          // validation message beside the box ("This field is required") is not its value either.
          const popup = "[role='listbox'],[role='grid'],[role='tree'],[role='menu'],[role='option'],[role='row'],[role='status'],[aria-live]";
          const message = "[role='alert'],[class*='invalid' i],[class*='error' i],[class*='feedback' i]";
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const inside = node.parentElement?.closest(popup);
            if (inside && !(inside.matches("[role='option'][aria-selected='true']") && !inside.parentElement?.closest(popup))) continue;
            const notice = node.parentElement?.closest(message);
            if (notice && notice !== widget && widget.contains(notice) && !notice.contains(el)) continue;
            if (!node.parentElement?.closest("[class*='placeholder' i]") && isVisible(node.parentElement)) parts.push(clean(node.nodeValue));
          }
          value = parts.filter(Boolean).join(" ");
          // The widget box repeating the field's own question ("How did you hear about us? *") or a prompt
          // ("Select One", "Choose…") is a placeholder.
          const own = clean(labelOf(el, true)).replace(/[\s*:]+$/, "").toLowerCase();
          if (own && value.replace(/[\s*:]+$/, "").toLowerCase() === own || PROMPT.test(value)) value = "";
          shownChoice = !!value;
        }
      }
      // A multi-select combobox keeps its input empty and shows each pick as a removable chip ("Remove Python") in
      // its own wrapper; those chips are its value. The wrapper must hold no other field, and a single-select
      // clear button ("Remove value for the … field") is not a chip. A prompt that names no ARIA role keeps its pick
      // as a pill announcing its own removal ("Handshake, press delete to clear value.").
      if (!value && tag === "input" && ["text", "search", ""].includes(type)) {
        const aria = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete");
        for (let node = el.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
          if (node.querySelectorAll("input:not([type='hidden']),select,textarea").length > 1) break;
          const chips = Array.from(node.querySelectorAll("button,[role='button'],[role='option'],a[aria-label],span[aria-label]"))
            .filter((chip) => isVisible(chip))
            .map((chip) => {
              const text = clean(chip.getAttribute("aria-label") || chip.getAttribute("title") || chip.textContent);
              return text.match(/^(.{1,80}?),?\s+press (?:delete|backspace) to (?:clear|remove)\b/i)?.[1]
                ?? (aria ? text.match(/^(?:remove|delete|deselect)\s+(?!(?:value|all|selection)\b)(.{1,80})$/i)?.[1] : undefined);
            })
            .filter(Boolean);
          if (chips.length) {
            value = [...new Set(chips)].join(", ");
            shownChoice = true;
            break;
          }
        }
      }
      // A phone field holding only a country-code prefix ("+1") has no number yet.
      if (type === "tel" && /^\s*\+?\d{0,3}\s*$/.test(value)) value = "";
      let label = cut(labelOf(el, true), CAP_LABEL);
      // A select-only combobox labelled "label selection": the label is its first aria-labelledby element alone.
      if (ariaSelect) {
        const first = document.getElementById((el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)[0] || "");
        if (first && clean(first.textContent)) label = cut(clean(first.textContent), CAP_LABEL);
      }
      // Some widgets announce the choice ahead of the name in aria-label ("United States, Location"): the label is the
      // name alone, so the field keeps one identity before and after the pick.
      if (value && label.toLowerCase().startsWith(`${value.toLowerCase()}, `)) label = label.slice(value.length + 2);
      // An unlabeled search box inside a custom dropdown names the same popup (aria-owns/aria-controls) as the
      // labelled trigger that opened it: give it that trigger's label.
      if (!label) {
        const popups = clean(`${el.getAttribute("aria-owns") || ""} ${el.getAttribute("aria-controls") || ""}`).split(" ").filter(Boolean);
        const trigger = popups.length && roots.flatMap((root) => Array.from(root.querySelectorAll("[aria-owns],[aria-controls]")))
          .find((other) => other !== el && clean(`${other.getAttribute("aria-owns") || ""} ${other.getAttribute("aria-controls") || ""}`)
            .split(" ").some((token) => popups.includes(token)) && clean(labelOf(other)));
        if (trigger) label = cut(`Search ${labelOf(trigger)}`, CAP_LABEL);
      }
      // Otherwise the question a reader sees just before the field, with its placeholder as a hint; a field with
      // neither keeps its placeholder, title, or name.
      if (!label) {
        const question = precedingText(el, CAP_LABEL, widget);
        const hint = labelOf(el);
        label = cut(question ? (hint && hint !== clean(el.getAttribute("name")) && !question.includes(hint) ? `${question} (${hint})` : question) : hint, CAP_LABEL);
      }
      const name = clean(el.getAttribute("name"));
      const autocomplete = (el.getAttribute("autocomplete") || "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      // Some ATSs (Phenom) put autocomplete="one-time-code" on every form field to suppress browser autofill; the
      // token arms the gate only on a short code box (maxlength ≤ 10) that is not an address/phone part. A short box
      // labelled or named just "(Enter) code" (Indeed's emailed sign-in code) is one too; "(Enter) passcode" is one at
      // any length (ADP's emailed passcode box declares no maxlength).
      const shortBox = el.maxLength > 0 && el.maxLength <= 10;
      if (
        (autocomplete.includes("one-time-code") && shortBox
          && !/\b(zip|postal|post code|phone|country|area|extension|ext)\b/i.test(label))
        || (shortBox && /^(enter |the |your |\d+ digit )*code( required)?$/.test(mfaNorm(label).trim()))
        || /^(enter |the |your |\d+ digit )*pass ?code( required)?$/.test(mfaNorm(label).trim()) || /^pass ?code$/i.test(name)
        || MFA_LABEL.test(mfaNorm(label + " " + name))
      ) {
        mfaSeen = true;
      }
      const field = {
        ref: stamp(el),
        tag,
        type: tag === "select" || custom || ariaSelect ? "select" : tag === "textarea" ? "textarea" : type,
        label,
        name,
        // Some ATSs mark required fields only by a class token ("iCIMS_Forms_RequiredField", "field-required"), or
        // only by a screen-reader suffix on the label ("Today's Date Required", "Phone (required)"), or by an
        // asterisk element beside the label text in the field's own wrapper (Formily "ud-formily-item-asterisk").
        required: el.required === true || el.getAttribute("aria-required") === "true"
          || /(^|[\s_-])(?<!(not|non)[_-])required(field)?($|[\s_-])/i.test(typeof el.className === "string" ? el.className : "")
          || (/(^|[^?])\s(required|\(required\))\s*$/i.test(label) || /\(required\)\s*$/i.test(label)) && !/\b(is|be|are|been)\s+required\s*$/i.test(label)
          || starred(el),
        value: cut(value, CAP_VALUE),
        // A select fed by a type-to-search companion widget (act.select types into its search box): its few options
        // are not the list, so it is not a select still waiting on an earlier choice.
        ...(tag === "select" && Array.from(el.options).filter((o) => o.value !== "").length <= 1
          && el.parentElement?.querySelectorAll("select").length === 1
          && Array.from(el.parentElement.children).some((n) => n !== el && n.getClientRects().length
            && (n.getAttribute("role") === "combobox" || n.hasAttribute("aria-expanded")))
          && el.parentElement.querySelector("input[aria-autocomplete],input[class*='search' i]") ? { searchable: true } : {}),
      };
      // The field's own length limit, so written answers fit it.
      if ((tag === "input" || tag === "textarea") && el.maxLength > 0) field.maxLength = el.maxLength;
      if (value.length > CAP_VALUE) field.valueLength = value.length;
      if (custom) field.options = custom.rows.map((row) => cut(clean(row.textContent), CAP_OPTION)).slice(0, CAP_OPTIONS);
      if (ariaSelect) {
        // Its listbox: the one it controls/owns, else the nearest one in its wrapper. Options exist only once the
        // site has rendered them (often on first open); act.selectOptions opens it to read them otherwise.
        const ids = `${el.getAttribute("aria-controls") || ""} ${el.getAttribute("aria-owns") || ""}`.split(/\s+/).filter(Boolean);
        let listbox = ids.map((id) => document.getElementById(id)).find((node) => node?.getAttribute("role") === "listbox") || null;
        for (let node = el.parentElement, depth = 0; !listbox && node && depth < 4; node = node.parentElement, depth += 1) {
          // An empty placeholder listbox can precede the real one: take the first that holds options.
          listbox = Array.from(node.querySelectorAll("[role='listbox']")).find((box) => box.querySelector("[role='option']")) || null;
        }
        const options = listbox ? Array.from(listbox.querySelectorAll("[role='option']")).map((o) => cut(clean(o.textContent), CAP_OPTION)).filter(Boolean) : [];
        if (options.length) field.options = options.slice(0, CAP_OPTIONS);
      }
      if (tag === "select") {
        field.options = Array.from(el.options)
          .map((o) => cut(clean(o.textContent), CAP_OPTION))
          .filter(Boolean)
          .slice(0, CAP_OPTIONS);
      }
      // Password occupancy only — the secret itself never enters a snapshot.
      if (type === "password") field.occupied = Boolean(el.value);
      const fieldFormRef = formRefFor(el);
      // Choice textboxes may announce a suggestion list through ARIA, or expose
      // the same relationship structurally inside their own single-field wrapper.
      // The structural list is remembered so its visible rows can be emitted below
      // as option controls owned by this field.
      const ariaAutocomplete = el.getAttribute("aria-autocomplete");
      const textAutocomplete = tag === "input"
        && !["hidden", "file", "checkbox", "radio", "submit", "button", "reset", "image"].includes(type);
      const structuralAutocomplete = textAutocomplete ? structuralAutocompleteFor(el) : null;
      if (structuralAutocomplete) autocompleteWidgets.set(el, structuralAutocomplete);
      // A combobox input whose popup is a dialog (a calendar date picker, aria-autocomplete="none") takes typed text;
      // it lists no options to pick from.
      const datePicker = el.getAttribute("aria-haspopup") === "dialog" && (!ariaAutocomplete || ariaAutocomplete === "none");
      const isAutocomplete = textAutocomplete && !datePicker && (ariaAutocomplete === "list" || ariaAutocomplete === "both"
        || el.getAttribute("role") === "combobox" || structuralAutocomplete);
      if (isAutocomplete) {
        field.autocomplete = true;
        autocompleteInputs.add(el);
      }
      // Site-reported invalid (aria-invalid) or a typed value the browser itself rejects.
      // A custom dropdown's hidden input (or a combobox whose widget shows the committed choice) keeps a stale
      // aria-invalid after its value is set: validators re-check only on input/blur, multi-selects only on submit.
      if ((el.getAttribute("aria-invalid") === "true" && !((custom || shownChoice) && value)) || (el.value && el.willValidate && !el.checkValidity())) field.invalid = true;
      // A segmented date (Month / Year boxes) carries its error on the group, not on each box ("Error: Must end after
      // start date"): a date box whose small wrapper (three inputs or fewer) shows error text is invalid. Other
      // inputs are left alone: a sign-in form's status alert ("An email has been sent") is not a field error.
      const segment = /\b(month|day|year|mm|dd|yyyy)\b/i.test(`${label} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`);
      if (!field.invalid && segment && tag === "input" && ["text", "number", "tel", ""].includes(type)) {
        for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
          if (node.querySelectorAll("input:not([type='hidden']),select,textarea").length > 3) break;
          const alert = Array.from(node.querySelectorAll("[role='alert'],[aria-live='assertive'],p,span,div"))
            .find((n) => !n.children.length && isVisible(n) && /^error\b|\b(invalid|must)\b/i.test(clean(n.textContent)));
          if (alert) {
            field.invalid = true;
            field.message = cut(clean(alert.textContent), 200);
            break;
          }
        }
      }
      // The field's own hint/validation text (describedby, errormessage, and labelledby ids after the first): length
      // limits and format rules a written answer must obey.
      const hintIds = [el.getAttribute("aria-describedby"), el.getAttribute("aria-errormessage"),
        clean(el.getAttribute("aria-labelledby")).split(/\s+/).slice(1).join(" ")].filter(Boolean).join(" ");
      const hint = byIdText(hintIds) || (el.validationMessage && field.invalid ? clean(el.validationMessage) : "");
      if (hint) field.message = cut(hint, 200);
      if (tag === "textarea") {
        const prompt = promptText(el);
        if (prompt.length > clean(label).length + 20) field.prompt = prompt;
      }
      // A file input's own label is often just "Upload" / "Upload new": its section text ("Cover letter (optional)",
      // "Transcript") says which document it wants. The nearest ancestor whose short text names a document is it.
      if (type === "file") {
        for (let node = el.parentElement, depth = 0; node && depth < 7; node = node.parentElement, depth += 1) {
          const text = clean(node.innerText || node.textContent || "");
          if (text.length > 400) break;
          if (/\b(resume|résumé|cv|cover\s*letter|letter of motivation|motivation letter|transcript|writing sample|portfolio|attachment|document)s?\b/i.test(text)) {
            field.context = cut(text, 160);
            // Employer instructions for the slot ("Instructions from employer: Include: …") are kept in full.
            if (/\binstructions?\b|\b(include|attach|provide|submit)\s*:/i.test(text)) field.instructions = cut(text, 1000);
            break;
          }
        }
      }
      if (fieldFormRef) field.formRef = fieldFormRef;
      if (type !== "file" && inSignup(el)) field.signup = true;
      fields.push(field);
    }
  }
  // Fields sharing a short label ("Month"/"Year" under both "Start Date" and "Expected Graduation Date") are told
  // apart by their group's caption: the first text line of the nearest ancestor that holds no other same-labelled
  // field and whose caption is neither the label itself nor another field's label (a repeated experience entry
  // opens with "Job title*"). Captions that leave the fields alike tell nothing apart and are dropped.
  const bare = (text) => clean(text).replace(/[*:]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const fieldLabels = new Set(fields.map((field) => bare(field.label)).filter(Boolean));
  // Live-region announcements ("Date picker opened. Selected date is 06/2030") change as the applicant types.
  for (const node of roots.flatMap((root) => Array.from(root.querySelectorAll("[aria-live],[role='status'],[role='log'],[role='alert']")))) {
    const text = bare(node.innerText || "");
    if (text) fieldLabels.add(text);
  }
  const byLabel = new Map();
  for (const field of fields) if (field.label) byLabel.set(field.label, [...(byLabel.get(field.label) ?? []), field]);
  for (const [label, same] of byLabel) {
    if (same.length < 2 || label.length > 40) continue;
    const nodes = same.map((field) => document.querySelector(`[data-omp-ref="${field.ref}"]`));
    const captioned = same.map((field, i) => {
      for (let node = nodes[i]?.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
        if (nodes.some((other, j) => j !== i && other && node.contains(other))) break;
        const caption = clean((node.innerText || "").split("\n").find((line) => clean(line)) || "");
        if (caption && caption.length <= 60 && !label.toLowerCase().includes(caption.toLowerCase()) && !fieldLabels.has(bare(caption))) {
          return cut(`${caption} ${label}`, CAP_LABEL);
        }
      }
      return label;
    });
    if (new Set(captioned).size < 2) continue;
    same.forEach((field, i) => { field.label = captioned[i]; });
  }

  // Radio/checkbox groups: one field per shared name within one form; options
  // carry each member's own label (fallback: value), value carries the checked
  // member(s).
  for (const { type, name, members, box } of groups.values()) {
    const first = members[0];
    const groupFormRef = formRefFor(first);
    const options = members.map((m) => cut(optionLabelOf(m), CAP_OPTION));
    // Parallel to options: each member's own ref, so selecting an answer clicks
    // the matching option element, never the group's first ref. A member whose
    // input is hidden uses its visible clickable label instead.
    const optionRefs = members.map((m) => stamp(optionElementFor(m) || m));
    const checked = members.filter(isChecked);
    const groupField = {
      ref: optionRefs[0],
      tag: "input",
      type,
      // The question: legend/group labeling, else the text shown before the group (option labels skipped). A lone
      // checkbox keeps its own label (an acknowledgement states itself) unless that is a bare choice word ("Yes").
      label: cut((() => {
        const asked = questionOf(first);
        if (asked) return asked;
        const own = clean(labelOf(first));
        const before = precedingText(first, CAP_LABEL);
        if (members.length > 1) return before || own;
        return before && own.split(/\s+/).length <= 4 ? `${before} ${own}` : own || before;
      })(), CAP_LABEL),
      name,
      // A container-grouped set marks required on the container or its label ("input-row__label--required").
      required: members.some(
        (m) => m.required === true || m.getAttribute("aria-required") === "true"
      ) || Boolean(box && (box.getAttribute("aria-required") === "true"
        || (box.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
          .some((id) => /\brequired\b|--required\b/i.test(document.getElementById(id)?.className || "")))),
      // Native groups report checked values; a container-grouped set's values are opaque ids, so its labels.
      value: cut(checked.map((m) => (box ? clean(optionLabelOf(m)) : clean(m.getAttribute("value"))) || "on").join(", "), CAP_VALUE),
      options,
      optionRefs,
      checkedRefs: checked.map((m) => stamp(optionElementFor(m) || m)),
    };
    if (groupFormRef) groupField.formRef = groupFormRef;
    fields.push(groupField);
  }

  // Custom radio widgets with no native input. A role=radiogroup container (or a
  // shared parent holding several role=radio children) is one question; each
  // member is one option whose own element is the clickable optionRef. A member
  // marked aria-checked is the current choice. Native input radios never reach
  // this pass, and members are taken once even under nested containers.
  const customRadioTaken = new Set();
  const customRadioGroups = [];
  const addCustomRadioGroup = (container, members) => {
    const usable = members.filter((m) => !customRadioTaken.has(m));
    if (usable.length < 2) return;
    for (const m of usable) customRadioTaken.add(m);
    customRadioGroups.push({ container, members: usable });
  };
  for (const root of roots) {
    for (const container of Array.from(root.querySelectorAll("[role='radiogroup']"))) {
      const members = Array.from(container.querySelectorAll("[role='radio'],[aria-pressed]")).filter((m) =>
        m.tagName.toLowerCase() !== "input"
        && m.closest("[role='radiogroup']") === container
        && !m.closest("[aria-hidden='true'],[role='listbox'],[role='menu']")
        && isVisible(m) && !isDisabled(m)
      );
      addCustomRadioGroup(container, members);
    }
  }
  // role=radio members that declare no radiogroup: their shared parent is the group.
  const looseRadios = new Map();
  for (const el of elements) {
    if (el.tagName.toLowerCase() === "input") continue;
    if ((el.getAttribute("role") || "").toLowerCase() !== "radio") continue;
    if (customRadioTaken.has(el) || !isVisible(el) || isDisabled(el)) continue;
    if (el.closest("[role='radiogroup'],[aria-hidden='true'],[role='listbox'],[role='menu']")) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    if (!looseRadios.has(parent)) looseRadios.set(parent, []);
    looseRadios.get(parent).push(el);
  }
  for (const [parent, members] of looseRadios) addCustomRadioGroup(parent, members);
  for (const { container, members } of customRadioGroups) {
    const first = members[0];
    const optionRefs = members.map((m) => stamp(m));
    const checked = members.filter((m) => m.getAttribute("aria-checked") === "true");
    const asked = (() => {
      const question = questionOf(first);
      if (question) return question;
      const labelledBy = container.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = byIdText(labelledBy);
        if (text) return text;
      }
      const aria = clean(container.getAttribute("aria-label"));
      if (aria) return aria;
      return precedingText(first, CAP_LABEL);
    })();
    const groupField = {
      ref: optionRefs[0],
      tag: "input",
      type: "radio",
      label: cut(asked, CAP_LABEL),
      name: clean(container.getAttribute("id") || container.getAttribute("name") || ""),
      required: container.getAttribute("aria-required") === "true"
        || members.some((m) => m.getAttribute("aria-required") === "true"),
      value: cut(checked.map((m) => optionLabelOf(m) || "on").join(", "), CAP_VALUE),
      options: members.map((m) => cut(optionLabelOf(m), CAP_OPTION)),
      optionRefs,
      checkedRefs: checked.map((m) => stamp(m)),
    };
    const groupFormRef = formRefFor(first);
    if (groupFormRef) groupField.formRef = groupFormRef;
    fields.push(groupField);
  }
  // Custom dropdown/listbox/menu options: visible, enabled
  // role=option/menuitem(/radio/checkbox) elements become clickable
  // kind:'option' controls so an open custom listbox is drivable like any
  // other control (CONTRACT Control.kind). Native <select> options stay field
  // options above; elements already captured as button/link controls (or
  // nested inside one, where they are that control's label) are not
  // duplicated. seen holds every element the primary SELECTOR matched.
  const OPTION_SELECTOR =
    "[role='option'],[role='menuitem'],[role='menuitemradio'],[role='menuitemcheckbox']";
  const optionElements = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(OPTION_SELECTOR))) {
      if (seen.has(el) || optionElements.includes(el)) continue;
      if (el.parentElement?.closest && el.parentElement.closest("a[href],button,[role='button'],[role='link']")) continue;
      optionElements.push(el);
    }
  }
  // A combobox whose popup is a grid (aria-haspopup="grid": address/ZIP lookups) lists each suggestion as a gridcell.
  for (const root of roots) {
    for (const input of Array.from(root.querySelectorAll("[role='combobox'][aria-haspopup='grid'][aria-controls]"))) {
      const grid = document.getElementById(input.getAttribute("aria-controls"));
      if (!grid || grid.getAttribute("role") !== "grid") continue;
      for (const cell of Array.from(grid.querySelectorAll("[role='gridcell']"))) {
        if (!seen.has(cell) && !optionElements.includes(cell)) optionElements.push(cell);
      }
    }
  }
  // ARIA-less suggestion rows inside a structurally recognized autocomplete list
  // use the same option-control contract. The list's own loading/no-results/status
  // placeholders are skipped, and only pointer-actionable rows become options.
  const autocompleteOwnerOf = (row) => {
    for (const [input, { lists }] of autocompleteWidgets) {
      if (lists.some((list) => list === row || list.contains(row))) return input;
    }
    return null;
  };
  const LIST_PLACEHOLDER =
    /(?:^|[-_\s])(no[-_\s]?results?|no[-_\s]?matches|loading|spinner|empty|status|message|error)(?:[-_\s]|$)/i;
  // A results container wrapping one chain of elements that render the same text
  // ("…results > #location-0") collapses to the row itself.
  // Children without visible text (a virtual list's scrollbar) are not rows.
  const rowChildren = (node) => Array.from(node.children).filter((child) => isVisible(child) && clean(child.textContent));
  const collapsedRow = (list) => {
    let node = list;
    for (let kids = rowChildren(node); kids.length === 1; kids = rowChildren(node)) {
      if (clean(kids[0].textContent) !== clean(node.textContent)) break;
      node = kids[0];
    }
    return node;
  };
  const usableSuggestionRow = (row, list) => {
    if (!isVisible(row) || isDisabled(row) || !clean(row.textContent)) return false;
    if (row.matches(SUGGESTION_LIST_SELECTOR) && row.children.length) return false;
    if (row.querySelector("input,select,textarea,button,a[href]")) return false;
    // Only the row's own chain up to (and including) the list marks it actionable:
    // headings, spinners and placeholders inside a results box stay out.
    let clickable = false;
    let semantic = false;
    for (let node = row; node; node = node.parentElement) {
      if (LIST_PLACEHOLDER.test(String(node.className || ""))) return false;
      if (getComputedStyle(node).pointerEvents === "none") return false;
      if (getComputedStyle(node).cursor === "pointer") clickable = true;
      const nodeRole = String(node.getAttribute?.("role") || "");
      if (node.tagName === "LI" || /^(option|menuitem|menuitemradio|menuitemcheckbox|treeitem)$/.test(nodeRole)) semantic = true;
      if (node === list) break;
    }
    return clickable || semantic;
  };
  for (const { lists } of autocompleteWidgets.values()) {
    for (const list of lists) {
      const node = collapsedRow(list);
      const rows = rowChildren(node).length ? rowChildren(node) : [node];
      // A virtual list wraps each item in a bare div: the row is the item itself.
      for (const row of rows.map(collapsedRow)) {
        if (!usableSuggestionRow(row, list)) continue;
        if (seen.has(row) || optionElements.includes(row)) continue;
        if (row.closest && row.closest("a[href],button,[role='button'],[role='link']")) continue;
        optionElements.push(row);
      }
    }
  }
  // The element driving an option's listbox/menu: the one whose aria-controls
  // or aria-owns token list names the container's id. Searched across every
  // root (document + open shadow roots) because controller and popup often
  // live in different roots.
  // Several elements may link the list (a wrapper's aria-owns and its input's aria-controls): the input/combobox the
  // applicant types into owns it, else the first link.
  const controllerOf = (container) => {
    const id = container && container.id;
    if (!id) return null;
    let first = null;
    for (const root of roots) {
      for (const cand of Array.from(root.querySelectorAll("[aria-controls],[aria-owns]"))) {
        const tokens = clean(
          (cand.getAttribute("aria-controls") || "") + " " + (cand.getAttribute("aria-owns") || "")
        ).split(/\s+/);
        if (!tokens.includes(id)) continue;
        if (cand.matches("input,select,textarea,[role='combobox']")) return cand;
        first = first || cand;
      }
    }
    return first;
  };
  // Portal popups keep the input association outside their own subtree: a data-*
  // attribute names the input's own element or widget id, or a floating panel is
  // anchored to the input's box. Both checks are bounded to the autocomplete inputs
  // and the one list, so an unrelated list is never claimed.
  const widgetIdOwners = [];
  for (const input of autocompleteInputs) {
    const ids = [clean(input.id)].filter(Boolean);
    for (let node = input.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
      if (clean(node.id)) ids.push(clean(node.id));
    }
    widgetIdOwners.push({ input, ids });
  }
  // The list's own data-* attributes (or a wrapper's) carrying a whole widget id
  // ("data-associated-widget" style references survive the portal move). Kept
  // focus-independent: a pick inside the popup moves focus off the input.
  const linkedAutocompleteOwner = (list) => {
    if (!list || !isVisible(list)) return null;
    for (let node = list, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      const values = Array.from(node.attributes || [])
        .filter((attr) => attr.name.startsWith("data-") && attr.value)
        .map((attr) => clean(attr.value));
      if (!values.length) continue;
      for (const { input, ids } of widgetIdOwners) {
        if (ids.some((id) => (id.length >= 8 ? values.some((value) => value.includes(id)) : values.includes(id)))) return input;
      }
    }
    return null;
  };
  // No data-* reference at all: the focused autocomplete input still owns the
  // floating panel anchored to its own box.
  const focusedAutocompleteOwner = (list) => {
    const focused = document.activeElement;
    if (!focused || !autocompleteInputs.has(focused)) return null;
    if (!list || !isVisible(list)) return null;
    let floating = false;
    for (let node = list, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      if (["absolute", "fixed"].includes(getComputedStyle(node).position)) { floating = true; break; }
    }
    if (!floating) return null;
    const box = widgetOf(focused).getBoundingClientRect();
    const rect = list.getBoundingClientRect();
    return rect.left < box.right && rect.right > box.left
      && (Math.abs(rect.top - box.bottom) <= 48 || Math.abs(rect.bottom - box.top) <= 48) ? focused : null;
  };
  for (const el of optionElements) {
    if (!isVisible(el)) continue;
    if (isDisabled(el)) continue;
    // A dropdown's shown choice rendered as a selected option beside its combobox (react-select v1), in no list,
    // is the field's value (read above), not a choice to click.
    if (el.getAttribute("aria-selected") === "true" && !el.closest("[role='listbox'],[role='menu'],[role='tree'],[role='grid']")
      && el.parentElement?.parentElement?.querySelector("[role='combobox']")) continue;
    const container = el.closest
      ? el.closest(
          "[role='listbox'],[role='menu'],[role='menubar'],[role='tree'],[role='grid'],[role='radiogroup'],[role='group']"
        )
      : null;
    // formRef: the controlling combobox/button's form when the listbox is
    // referenced by aria-controls/aria-owns; else the option's nearest form
    // (which also covers a listbox rendered inside the form); else none.
    let owner = null;
    let controller = null;
    if (container) {
      controller = controllerOf(container);
    }
    // A structural autocomplete is deliberately local to its field wrapper, so
    // it is a safe owner when the list has no aria-controls/aria-owns linkage.
    if (!controller) controller = autocompleteOwnerOf(el);
    // Portal popups keep the input association out of their own subtree: a data-*
    // reference names the input's widget, else the focused input owns the panel.
    if (!controller) controller = linkedAutocompleteOwner(container || el);
    if (!controller) controller = focusedAutocompleteOwner(container || el);
    if (controller && formRefFor(controller)) owner = controller;
    if (!owner) owner = el;
    const control = {
      ref: stamp(el),
      kind: "option",
      label: cut(textOf(el), CAP_LABEL),
    };
    control.formFieldCount = applicantFieldCount(owner);
    const optionFormRef = formRefFor(owner);
    if (optionFormRef) control.formRef = optionFormRef;
    if (controller) control.ownerRef = stamp(controller);
    // Selection state: a multi-select list toggles on click, so a chosen option must read as chosen. A list that
    // states each row's checked state (aria-checked, Workday's "… not checked" names, select2 4.1's data-selected) uses
    // that: its aria-selected only marks the keyboard-focused row.
    const checkedState = el.getAttribute("aria-checked")
      ?? (/\bnot checked$/i.test(el.getAttribute("aria-label") || "") ? "false" : /\bchecked$/i.test(el.getAttribute("aria-label") || "") ? "true" : null)
      ?? el.getAttribute("data-selected");
    if (checkedState !== null ? checkedState === "true" : el.getAttribute("aria-selected") === "true") control.selected = true;
    if (container?.getAttribute("aria-multiselectable") === "true") control.multi = true;
    controls.push(control);
  }
  // Popup lists without ARIA roles: while a combobox has focus and no ARIA option is visible, the positioned
  // (absolute/fixed) element within 48px of the combobox box's top or bottom edge, overlapping it horizontally and
  // holding no form controls, is its list; each outermost pointer-cursor row in it is an option owned by that combobox.
  const focused = document.activeElement;
  if (focused && !controls.some((c) => c.kind === "option") && isVisible(focused)
      && focused.matches("input[role='combobox'],input[aria-autocomplete='list'],input[aria-autocomplete='both']")) {
    const box = widgetOf(focused).getBoundingClientRect();
    const near = (r) => r.left < box.right && r.right > box.left
      && (Math.abs(r.top - box.bottom) <= 48 || Math.abs(r.bottom - box.top) <= 48);
    let popup = null;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const position = getComputedStyle(el).position;
      if ((position !== "absolute" && position !== "fixed") || el.contains(focused) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 10 || !near(r) || el.querySelector("input,select,textarea")) continue;
      if (!popup || el.contains(popup)) popup = el;
    }
    if (popup) {
      for (const row of Array.from(popup.querySelectorAll("*"))) {
        if (getComputedStyle(row).cursor !== "pointer" || getComputedStyle(row.parentElement).cursor === "pointer") continue;
        const label = cut(textOf(row), CAP_LABEL);
        if (!label || !isVisible(row) || isDisabled(row)) continue;
        const control = { ref: stamp(row), kind: "option", label, formFieldCount: applicantFieldCount(focused), ownerRef: stamp(focused) };
        const optionFormRef = formRefFor(focused);
        if (optionFormRef) control.formRef = optionFormRef;
        controls.push(control);
      }
    }
  }

  // Page messages: visible ARIA alert/status/live-region text (validation banners, errors).
  // Polite/status regions often wrap whole widgets, so those count only when they hold no
  // interactive elements, options, or headings.
  const messages = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("[role='alert'],[role='alertdialog'],[role='status'],[aria-live='assertive'],[aria-live='polite']"))) {
      if (!isVisible(el)) continue;
      const urgent = ["alert", "alertdialog"].includes(el.getAttribute("role")) || el.getAttribute("aria-live") === "assertive";
      if (!urgent && el.querySelector("a,button,input,select,textarea,[role='option'],[role='button'],h1,h2,h3,h4,h5,h6")) continue;
      // A combobox's own screen-reader announcer ("option X, selected.", "3 results available") sits beside it in
      // the widget: it narrates the widget's state, not a site message about the form.
      if (!urgent && el.parentElement?.querySelector("[role='combobox'],[aria-autocomplete]")) continue;
      const text = cut(clean(el.innerText || el.textContent), 300);
      if (text.length > 3 && !messages.includes(text)) messages.push(text);
    }
  }

  // Gates detected from this frame's own DOM.
  const gates = [];
  // Only a captcha a person can see is a gate: invisible/background captchas (hidden or off-screen frames) are
  // loaded by many forms and only challenge on suspicion. Invisible mode shows only a badge (size=invisible frame,
  // data-size="invisible") or binds the captcha class to the submit button itself; neither asks anything.
  const shownCaptcha = Array.from(document.querySelectorAll(
    "iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile'],.g-recaptcha,.h-captcha"
  )).some((el) => {
    if (!isVisible(el)) return false;
    if (el.matches("button,input,a") || el.getAttribute("data-size") === "invisible") return false;
    if (el.tagName === "IFRAME" && /[?&]size=invisible\b/.test(el.src)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 30 && rect.height > 30 && rect.bottom > 0 && rect.right > 0;
  });
  // A solved captcha (its response token filled in) no longer gates the page.
  const solvedCaptcha = Array.from(document.querySelectorAll(
    "[name='g-recaptcha-response'],[name='h-captcha-response'],[name='cf-turnstile-response']"
  )).some((el) => Boolean(el.value));
  // A home-grown human check ("I'm not a robot" / "I am human" checkbox) is a captcha too: ticking it is the user's.
  const robotCheck = fields.some((f) => /\b(i'?m|i am) not a robot\b|\bi am (a )?human\b|\bverify (that )?you('re| are) (a )?human\b/i.test(f.label ?? "")
    && !(Array.isArray(f.checkedRefs) && f.checkedRefs.length) && f.value !== true && f.value !== "true" && f.value !== "on");
  // An open challenge (a picture-puzzle frame, far larger than a checkbox widget) asks the person again even when a
  // stale response token from an earlier pass is still filled in, and even from an invisible-mode captcha (its
  // challenge frame keeps size=invisible in its URL once it escalates to a puzzle).
  const openChallenge = Array.from(document.querySelectorAll("iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile']"))
    .some((el) => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 250 && rect.height >= 250 && rect.bottom > 0 && rect.right > 0;
    });
  // An open puzzle covers the page and blocks every step, so it is its own gate (stops at once); a widget still to
  // be ticked ("captcha") waits until the form is filled and the final submit is next.
  if (openChallenge) gates.push("captcha-challenge");
  else if ((shownCaptcha && !solvedCaptcha) || robotCheck) gates.push("captcha");
  // "Security code" alone is also an emailed verification code (Greenhouse's 8 one-character boxes): only a card
  // field (number, CVV/CVC) or cc- autocomplete marks a payment form.
  const cardLabel = /\b(card number|cvv|cvc|credit card|debit card)\b/i;
  if (
    document.querySelector("[autocomplete^='cc-']") ||
    fields.some((f) => cardLabel.test(f.label))
  ) {
    gates.push("payment");
  }
  // Arms only from a visible, enabled field's own autocomplete/label/name (the
  // per-element filter above), so a hidden or cross-frame widget cannot trip it.
  // A code split into one-character boxes (4-8 visible maxlength=1 inputs sharing a parent) is a verification code too.
  if (!mfaSeen) {
    const boxes = new Map();
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll("input"))) {
        if (el.maxLength !== 1 || !isVisible(el) || !["text", "tel", "number", "password", ""].includes(el.type)) continue;
        const key = el.parentElement?.parentElement || el.parentElement;
        boxes.set(key, (boxes.get(key) || 0) + 1);
      }
    }
    if ([...boxes.values()].some((count) => count >= 4 && count <= 8)) mfaSeen = true;
  }
  if (mfaSeen) gates.push("mfa");

  // Visible page text in document order (headings, section notes such as "You have no education history.
  // Required"), so the models see structure that is not an interactive control. Line breaks are kept.
  const pageText = (document.body ? document.body.innerText : "")
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim().slice(0, 3000);

  return { controls, fields, gates, messages: messages.slice(0, 8), pageText };
}

export async function snapshot(page) {
  const frames = page.frames();
  const mainFrame = page.mainFrame();
  const url = page.url();
  const title = await page.title();

  const controls = [];
  const fields = [];
  const gates = new Set();
  const messages = [];
  const texts = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch {
      continue; // detached mid-snapshot
    }
    // Captcha frames are never read: whether one is a gate is decided by its parent frame (visible widget only).
    if (/recaptcha|hcaptcha|turnstile/i.test(frameUrl)) continue;

    // Refs are prefixed with the frame's stable CDP frame ID, never the
    // page.frames() array position (which shifts as frames attach/detach). The
    // main frame stays unprefixed; a child frame without a stable ID is skipped
    // outright rather than emitting a ref act.mjs could never resolve.
    let prefix = "";
    if (frame !== mainFrame) {
      const frameId = frame._id ?? frame._frameId;
      if (frameId == null || frameId === "") continue; // no stable ID: unsafe ref
      prefix = "f" + encodeURIComponent(String(frameId)) + ":";
    }

    let result;
    try {
      result = await frame.evaluate(collectInFrame);
    } catch {
      continue; // frame detached or unreadable mid-snapshot
    }
    for (const c of result.controls) {
      const control = c.ref ? { ...c, ref: prefix + c.ref } : { ...c };
      // formRef is document-local, so a child frame's form needs the same
      // stable frame prefix as its refs; the main frame's prefix is "".
      if (control.formRef) control.formRef = prefix + control.formRef;
      if (control.ownerRef) control.ownerRef = prefix + control.ownerRef;
      controls.push(control);
    }
    for (const f of result.fields) {
      const field = f.ref ? { ...f, ref: prefix + f.ref } : { ...f };
      if (f.optionRefs) field.optionRefs = f.optionRefs.map((r) => (r ? prefix + r : r));
      if (f.checkedRefs) field.checkedRefs = f.checkedRefs.map((r) => (r ? prefix + r : r));
      if (field.formRef) field.formRef = prefix + field.formRef;
      fields.push(field);
    }
    for (const g of result.gates) gates.add(g);
    for (const m of result.messages ?? []) if (!messages.includes(m)) messages.push(m);
    if (result.pageText) texts.push(frame === mainFrame ? result.pageText : `[frame]\n${result.pageText}`);
  }

  return {
    url,
    title,
    controls: controls.slice(0, CAP_CONTROLS),
    fields: fields.slice(0, CAP_FIELDS),
    gates: [...gates],
    messages: messages.slice(0, 8),
    pageText: texts.join("\n").slice(0, 4000),
  };
}
