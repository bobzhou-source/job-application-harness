// lib/snapshot/labels.mjs — accessible-name computation: the legacy label chain (labelOf), group questions, radio/checkbox option naming.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
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

}
