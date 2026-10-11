// lib/snapshot/discovery.mjs — candidate element collection (document plus open shadow roots), enhanced-select replacement, custom dropdown and structural-autocomplete discovery.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
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


}
