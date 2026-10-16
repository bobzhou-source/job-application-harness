// lib/snapshot/groups.mjs — post passes: duplicate-label disambiguation by group caption; native and custom radio/checkbox groups as single fields.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
  // Fields sharing a short label ("Month"/"Year" under both "Start Date" and "Expected Graduation Date") are told
  // apart by their group's caption: a fieldset's legend, else the first visible text line of the nearest ancestor that
  // holds no other same-labelled field and whose caption is neither the label itself nor another field's label (a
  // repeated experience entry opens with "Job title*"). A line with no letters (a date part's own "08", "2026") or a
  // screen-reader-only announcement ("current value is 8/2026", a 1px box) is no caption: both change as the
  // applicant types, and a field renamed by its own value cannot be found again. Captions that leave the fields
  // alike tell nothing apart and are dropped.
  const bare = (text) => clean(text).replace(/[*:]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const fieldLabels = new Set(fields.map((field) => bare(field.label)).filter(Boolean));
  // Live-region announcements ("Date picker opened. Selected date is 06/2030") change as the applicant types.
  for (const node of roots.flatMap((root) => Array.from(root.querySelectorAll("[aria-live],[role='status'],[role='log'],[role='alert']")))) {
    const text = bare(node.innerText || "");
    if (text) fieldLabels.add(text);
  }
  // A group container's declared name (its own aria-labelledby/aria-label) is the question its fields answer, however
  // long: Workday's date group names "Please provide the graduation date …" on the wrapper, not in a legend.
  const declaredGroupName = (node) => {
    const role = (node.getAttribute("role") || "").toLowerCase();
    if (node.tagName !== "FIELDSET" && role !== "group" && role !== "radiogroup") return "";
    const ids = clean(node.getAttribute("aria-labelledby")).split(/\s+/).filter(Boolean);
    const named = clean(ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" "))
      || clean(node.getAttribute("aria-label"));
    return named.replace(/[\s*:]+$/, "");
  };
  // A date part's own placeholder ("MM", "YYYY") and a dropdown's prompt ("Select...", "Choose one") are no captions.
  // A caption is a short line, unless it is a fieldset's own legend or a group's declared name: that is the group's
  // declared name whatever its length (Workday's "If you have not graduated yet, what is your anticipated graduation
  // date?").
  const captionFits = (node, caption) => caption.length <= 60
    || (node.tagName === "FIELDSET" && Boolean(node.querySelector(":scope > legend"))) || Boolean(declaredGroupName(node));
  const PLACEHOLDER = /^[MDYH]{2,4}$|^(select|choose|please select|pick)(\s+(one|an option|a value|date|month|year))?\s*(\.{3}|…)?$/i;
  // Validation text beside a field ("Error", "The field To is required") names the problem, never the field.
  const MESSAGE = "[role='alert'],[aria-live],[id*='error' i],[class*='error' i],[class*='invalid' i],[data-automation-id*='alert' i],[data-automation-id*='error' i],[class*='placeholder' i],[data-placeholder]";
  const firstVisibleLine = (node) => {
    const legend = node.tagName === "FIELDSET" ? node.querySelector(":scope > legend") : null;
    if (legend && clean(legend.textContent)) return clean(legend.textContent).replace(/[\s*:]+$/, "");
    const declared = declaredGroupName(node);
    if (declared) return declared;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const line = clean(text.nodeValue);
      if (!line || !/\p{L}/u.test(line) || PLACEHOLDER.test(line)) continue;
      const parent = text.parentElement;
      if (!parent || !isVisible(parent) || parent.closest(MESSAGE)) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      return line;
    }
    return "";
  };
  // The caption and the field's own label in one budget, keeping the segment word ("Month"/"Year") that a long group
  // question would otherwise push past the cap: the driver reads the part from the label's last word.
  const withSegment = (caption, label) => {
    const room = CAP_LABEL - label.length - 1;
    return room > 0 ? `${cut(caption, room)} ${label}` : cut(label, CAP_LABEL);
  };
  const byLabel = new Map();
  for (const field of fields) if (field.label) byLabel.set(field.label, [...(byLabel.get(field.label) ?? []), field]);
  const captionedRefs = new Set();
  for (const [label, same] of byLabel) {
    if (same.length < 2 || label.length > 40) continue;
    const nodes = same.map((field) => document.querySelector(`[data-omp-ref="${field.ref}"]`));
    // Workday retitles a filled entry's panel with its value ("Languages 1" becomes "English"): a caption that is one
    // of these fields' own values would rename the field by its answer.
    const values = new Set(same.map((field) => bare(String(field.value ?? ""))).filter(Boolean));
    const captioned = same.map((field, i) => {
      for (let node = nodes[i]?.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
        if (nodes.some((other, j) => j !== i && other && node.contains(other))) break;
        const caption = firstVisibleLine(node);
        if (caption && captionFits(node, caption) && !label.toLowerCase().includes(caption.toLowerCase()) && !fieldLabels.has(bare(caption)) && !values.has(bare(caption))) {
          return withSegment(caption, label);
        }
      }
      return label;
    });
    if (new Set(captioned).size < 2) continue;
    same.forEach((field, i) => { field.label = captioned[i]; captionedRefs.add(field.ref); });
  }
  // A date part with a generic label ("Start date year", "End date month", "To Year") is often unique on its screen
  // yet names no subject: an Education block's, an Employment block's and an availability question's "End date year"
  // are the same words, so one learned mapping or one stored answer would serve all three. Such a field takes its
  // section's caption whether or not the label repeats: the nearest ancestor caption that is no field's label, within
  // a section of at most twelve fields (a whole application form is no section).
  const GENERIC_DATE = /^(?:(start|end|from|to|date)\b.{0,30}\b)?(month|year|day)$|^(start|end|from|to|date) date$/;
  const fieldNodes = new Map(fields.map((field) => [field.ref, document.querySelector(`[data-omp-ref="${field.ref}"]`)]));
  for (const field of fields) {
    if (!field.label || captionedRefs.has(field.ref) || !GENERIC_DATE.test(bare(field.label))) continue;
    for (let node = fieldNodes.get(field.ref)?.parentElement, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
      let held = 0;
      for (const other of fieldNodes.values()) if (other && node.contains(other)) held += 1;
      if (held > 12) break;
      const caption = firstVisibleLine(node);
      if (caption && captionFits(node, caption) && !bare(field.label).includes(bare(caption)) && !fieldLabels.has(bare(caption))) {
        field.label = withSegment(caption, field.label);
        break;
      }
    }
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
      // Native groups report checked values; a container-grouped set's values are opaque ids, so its labels, and
      // so is a native value with no letters ("38": an option id).
      value: cut(checked.map((m) => {
        const own = clean(m.getAttribute("value"));
        return (box || !/\p{L}/u.test(own) ? clean(optionLabelOf(m)) || own : own) || "on";
      }).join(", "), CAP_VALUE),
      options,
      optionRefs,
      checkedRefs: checked.map((m) => stamp(optionElementFor(m) || m)),
    };
    if (groupFormRef) groupField.formRef = groupFormRef;
    const groupDialog = dialogIndex(first);
    if (groupDialog !== undefined) groupField.dialog = groupDialog;
    const groupLocator = locatorOf(first);
    if (groupLocator) groupField.locator = groupLocator;
    fields.push(groupField);
  }

  // Custom radio widgets with no native input. A role=radiogroup container (or a
  // shared parent holding several role=radio children) is one question; each
  // member is one option whose own element is the clickable optionRef. A member
  // marked aria-checked is the current choice. Native input radios never reach
  // this pass, nor does a role=radio box standing in for the hidden native radio
  // inside it (Rippling: div[role=radio] > input[type=radio] value="Yes") — the
  // native group above already lists that box as the option's ref — and members
  // are taken once even under nested containers. A box whose hidden input the
  // native pass could not show (its value is "true", not its words) stays here.
  const customRadioTaken = new Set();
  const customRadioGroups = [];
  const wrapsNativeRadio = (m) => Array.from(m.querySelectorAll("input[type='radio'],input[type='checkbox']")).some((input) => optionElementFor(input));
  // A group whose members carry no words offers nothing to choose (Workday draws a pair of unnamed role=radio boxes
  // under its page footer, which then read as a "© 2026 Workday" question): it is no field.
  const addCustomRadioGroup = (container, members) => {
    const usable = members.filter((m) => !customRadioTaken.has(m) && !wrapsNativeRadio(m));
    if (usable.length < 2 || usable.every((m) => !optionLabelOf(m))) return;
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
  // Toggle-button pills (aria-pressed) with no radiogroup, inside a container the question labels (Oracle
  // Candidate Experience: ul role=list aria-label="<question>" > li > button aria-pressed): that container is the group.
  const pillGroups = new Map();
  for (const el of elements) {
    if (el.tagName.toLowerCase() === "input" || !el.hasAttribute("aria-pressed")) continue;
    if (customRadioTaken.has(el) || !isVisible(el) || isDisabled(el)) continue;
    if (el.closest("[role='radiogroup'],[aria-hidden='true'],[role='listbox'],[role='menu'],[role='toolbar']")) continue;
    let box = el.parentElement;
    for (let depth = 0; box && depth < 3 && !box.hasAttribute("aria-label") && !box.hasAttribute("aria-labelledby"); depth += 1) box = box.parentElement;
    if (!box || !(box.hasAttribute("aria-label") || box.hasAttribute("aria-labelledby"))) continue;
    if (!pillGroups.has(box)) pillGroups.set(box, []);
    pillGroups.get(box).push(el);
  }
  for (const [box, members] of pillGroups) addCustomRadioGroup(box, members);
  for (const { container, members } of customRadioGroups) {
    const first = members[0];
    const optionRefs = members.map((m) => stamp(m));
    const checked = members.filter((m) => m.getAttribute("aria-checked") === "true" || m.getAttribute("aria-pressed") === "true");
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
    const groupDialog = dialogIndex(first);
    if (groupDialog !== undefined) groupField.dialog = groupDialog;
    const groupLocator = locatorOf(container);
    if (groupLocator) groupField.locator = groupLocator;
    fields.push(groupField);
  }

  // A text box with no label of its own can take the question of the choice group right after it: one instruction
  // block ("ELECTRONIC SIGNATURE: Please type your first and last name…" then "I testify that…: Accept / Decline")
  // feeds both. The text box's own prompt is the line shown just before the shared question, so a stored answer to
  // the choice ("Accept") is never typed into it.
  const choiceLabels = new Set(fields.filter((f) => f.type === "radio" || f.type === "checkbox").map((f) => f.label).filter(Boolean));
  for (const field of fields) {
    if (field.type === "radio" || field.type === "checkbox" || !choiceLabels.has(field.label)) continue;
    const node = document.querySelector(`[data-omp-ref="${field.ref}"]`);
    for (let block = node?.parentElement, depth = 0; block && depth < 8; block = block.parentElement, depth += 1) {
      const lines = (block.innerText || "").split("\n").map((line) => clean(line)).filter(Boolean);
      const at = lines.findIndex((line) => cut(line, CAP_LABEL) === field.label);
      if (at < 0) continue;
      if (at > 0 && !choiceLabels.has(cut(lines[at - 1], CAP_LABEL))) field.label = cut(lines[at - 1], CAP_LABEL);
      break;
    }
  }

  // A form that asks for a preferred name beside a bare "First Name"/"Last Name" means the bare one is the legal name.
  const namePart = /^\s*(first|last|middle|given|family|sur)\s*name\b/i;
  const preferredNames = new Set(fields.filter((f) => /\bpreferred\b/i.test(f.label || "") && /\bname\b/i.test(f.label || ""))
    .map((f) => f.formRef ?? ""));
  for (const field of fields) {
    if (field.tag !== "input" || !namePart.test(field.label || "") || /\b(legal|preferred)\b/i.test(field.label)) continue;
    if (preferredNames.has(field.formRef ?? "")) field.label = cut(`Legal ${field.label}`, CAP_LABEL);
  }
}
