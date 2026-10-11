// lib/snapshot/groups.mjs — post passes: duplicate-label disambiguation by group caption; native and custom radio/checkbox groups as single fields.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
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
}
