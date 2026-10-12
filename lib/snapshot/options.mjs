// lib/snapshot/options.mjs — clickable option controls: role=option/menuitem/gridcell rows, autocomplete suggestion rows and owners, popup fallback, icon-only forward buttons.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
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
    const optionDialog = dialogIndex(el);
    if (optionDialog !== undefined) control.dialog = optionDialog;
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
        const rowDialog = dialogIndex(row);
        if (rowDialog !== undefined) control.dialog = rowDialog;
        controls.push(control);
      }
    }
  }

  // An icon-only pager button (a textless pointer div drawn by an icon font: ADP's legacy "appGo" arrow) has no
  // accessible name; its own class/id naming a forward step ("appGo", "btnNext") is the only name it has.
  const FORWARD_TOKEN = new Set(["next", "go", "continue", "forward", "proceed"]);
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("div[class],span[class],div[id],span[id],i[class]"))) {
      if (el.hasAttribute("data-omp-ref") && controls.some((c) => c.ref === el.getAttribute("data-omp-ref"))) continue;
      const tokens = `${el.getAttribute("class") || ""} ${el.id || ""}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/);
      if (!tokens.some((token) => FORWARD_TOKEN.has(token))) continue;
      if (clean(el.innerText || el.textContent) || el.getAttribute("aria-label") || el.title) continue;
      if (!isVisible(el) || isDisabled(el) || getComputedStyle(el).cursor !== "pointer" || el.querySelector("a,button,input,select,textarea")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) continue;
      const control = { ref: stamp(el), kind: "button", label: "Next (icon button)", formFieldCount: applicantFieldCount(el) };
      const iconFormRef = formRefFor(el);
      if (iconFormRef) control.formRef = iconFormRef;
      const iconDialog = dialogIndex(el);
      if (iconDialog !== undefined) control.dialog = iconDialog;
      controls.push(control);
    }
  }

  // A button drawn as a plain pointer div with its own short text ("Edit" on ADP's review page: a
  // div.eFormEditButton with a script click handler, no role, tabindex or href). Its class/id names a button; the
  // heading it sits in names what it acts on, so two "Edit" buttons stay apart ("Edit Personal Information").
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("div[class],span[class],div[id],span[id]"))) {
      if (el.hasAttribute("data-omp-ref") && controls.some((c) => c.ref === el.getAttribute("data-omp-ref"))) continue;
      const tokens = `${el.getAttribute("class") || ""} ${el.id || ""}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/);
      if (!tokens.some((token) => token === "button" || token === "btn")) continue;
      const text = clean(el.innerText || el.textContent);
      if (!text || text.length > 40 || el.closest("button,a[href],[role='button'],[role='link']")) continue;
      if (!isVisible(el) || isDisabled(el) || getComputedStyle(el).cursor !== "pointer" || el.querySelector("a,button,input,select,textarea")) continue;
      const heading = el.closest("h1,h2,h3,h4,h5,h6");
      const about = heading ? clean((heading.innerText || "").replace(el.innerText || "", "")) : "";
      const control = { ref: stamp(el), kind: "button", label: cut(about ? `${text} ${about}` : text, CAP_LABEL), formFieldCount: applicantFieldCount(el) };
      const buttonFormRef = formRefFor(el);
      if (buttonFormRef) control.formRef = buttonFormRef;
      const buttonDialog = dialogIndex(el);
      if (buttonDialog !== undefined) control.dialog = buttonDialog;
      controls.push(control);
    }
  }

}
