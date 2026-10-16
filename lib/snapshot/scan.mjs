// lib/snapshot/scan.mjs — main element scan: classifies each candidate as a button/link control or a fillable field with value, options, required/invalid state.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
  // A control or field inside a visible modal dialog (role=dialog/alertdialog, aria-modal, or an open <dialog>)
  // carries the dialog's index for this scan, so plan vetting can tell a dialog's own Cancel/Close from the
  // application form's, and count the fields the dialog holds (see lib/apply/controls.mjs).
  const dialogIds = new Map();
  const dialogIndex = (el) => {
    const dlg = el.closest("[role='dialog'],[role='alertdialog'],[aria-modal='true'],dialog[open]");
    if (!dlg || !isVisible(dlg)) return undefined;
    if (!dialogIds.has(dlg)) dialogIds.set(dlg, dialogIds.size);
    return dialogIds.get(dlg);
  };
  // Stable identity an ATS replays by: the element's own data-automation-id, else its Workday question wrapper's
  // (formField-*), else its nearest ancestor's unless that is a page/section wrapper; plus its id and name. Empty
  // keys are omitted, and no locator is returned when none remain. Workday's date segments carry one id on every
  // date box (dateSectionMonth-input), so a segment is named by its wrapper too: formField-startDate/dateSectionMonth-input
  // is a job's start month on every tenant, while a custom question's formField-<guid>/… is that tenant's alone.
  const locatorOf = (el) => {
    const aidOf = (node) => clean(node && node.getAttribute("data-automation-id"));
    const own = aidOf(el);
    const wrapper = aidOf(el.closest("[data-automation-id^='formField-']"));
    let aid = /^dateSection\w+-input$/i.test(own) && wrapper ? `${wrapper}/${own}` : own || wrapper;
    const near = aidOf(el.parentElement && el.parentElement.closest("[data-automation-id]"));
    if (!aid && near && !/^(page|section|root|body|main)(?!.*(Button|Link|Input))/i.test(near)) aid = near;
    const locator = {};
    if (aid) locator.aid = aid;
    const id = clean(el.id);
    if (id) locator.id = id;
    const name = clean(el.getAttribute("name"));
    if (name) locator.name = name;
    return Object.keys(locator).length ? locator : null;
  };
  // A date segment's own word and group, read from the DOM rather than guessed from a label the group question can
  // crowd out (Workday's "Please provide the graduation date …" leaves "Date Month" with no room for the question).
  // `dateSectionMonth-input`, a lone "Month"/"YYYY" aria-label/placeholder, or a spinbutton in a date wrapper names
  // the part; the wrapper's data-automation-id is the group all of its segments share.
  const DATE_SEGMENTS = { month: "month", mm: "month", m: "month", year: "year", yyyy: "year", yy: "year", y: "year", day: "day", dd: "day", d: "day" };
  const segmentWord = (text) => DATE_SEGMENTS[clean(text).toLowerCase()];
  const segmentOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" || !["text", "number", "tel", ""].includes((el.getAttribute("type") || "text").toLowerCase())) return undefined;
    const own = clean(el.getAttribute("data-automation-id"));
    const fromId = /^dateSection(month|day|year)-input$/i.exec(own);
    if (fromId) return fromId[1].toLowerCase();
    const spin = (el.getAttribute("role") || "").toLowerCase() === "spinbutton" || Boolean(el.closest("[data-automation-id=dateInputWrapper]"));
    if (!spin) return undefined;
    return segmentWord(el.getAttribute("aria-label")) || segmentWord(el.getAttribute("placeholder"));
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
    // A text box drawn smaller than a pixel (Workday's "Enter website. This input is for robots only" at 1 × 0.01 px)
    // is a honeypot: a person never sees it, so no applicant field. Boxes hidden behind their labels (file, radio,
    // checkbox) and widget-backed selects are kept by the rule above, so only free-standing text-like inputs qualify.
    // A 0 × 0 box drawn by a visible sibling display (Workday's date segments: `dateSectionMonth-input` behind the
    // `dateSectionMonth-display` showing "MM") is a real box the applicant types into.
    if (tag === "input" && !isFile && !["radio", "checkbox"].includes(type) && !replacedSelect(el) && !customDropdowns.has(el)) {
      const box = el.getBoundingClientRect();
      const displayed = Array.from(el.parentElement?.children ?? []).some((n) => n !== el
        && /-display$/.test(n.getAttribute("data-automation-id") ?? "") && n.getClientRects().length);
      if ((box.width < 1 || box.height < 1) && !displayed) continue;
    }
    // Outside the accessibility tree (aria-hidden): a backing element for a custom widget (e.g. the native
    // <select> behind a select2 combobox), not what the applicant operates.
    if (!isFile && el.closest("[aria-hidden='true']")) continue;

    // A non-input combobox owning no text box is a select-only dropdown (ARIA listbox pattern): a choice field, with
    // options read from its listbox while open. One holding a text box is a popup trigger (clicked to open). A
    // collapsed listbox announcing a popup (ARIA 1.0 select, Dojo's dijit Select) is the same select-only dropdown;
    // its hidden/presentational inputs (the posted value, a focus sink) are no text box. So is a button announcing a
    // listbox that a form question owns (Workday's questionnaire: <fieldset><legend>Are you over 18?</legend>
    // <button aria-haspopup="listbox">Select One</button>); a menu button elsewhere (a language chooser) stays a button.
    const popupListbox = role === "listbox" && /^(true|listbox|menu)$/i.test(el.getAttribute("aria-haspopup") || "");
    const popupButton = tag === "button" && /^(true|listbox)$/i.test(el.getAttribute("aria-haspopup") || "")
      && !!(el.closest("fieldset,[data-automation-id^='formField']") || (el.labels && el.labels.length) || el.getAttribute("aria-labelledby"));
    const ariaSelect = (role === "combobox" || popupListbox || popupButton) && tag !== "input"
      && !el.querySelector("input:not([type='hidden']):not([role='presentation']),textarea,[contenteditable='true']");
    const isAction =
      (tag === "button" && !ariaSelect) ||
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
      const controlLocator = locatorOf(el);
      if (controlLocator) control.locator = controlLocator;
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
      const passwords = formPasswordCount(el);
      if (passwords) control.formPasswordCount = passwords;
      // Disclosure state (dropdown/menu buttons): lets the driver see a list is already open.
      const expanded = el.getAttribute("aria-expanded");
      if (expanded === "true" || expanded === "false") control.expanded = expanded === "true";
      // A popup trigger's own text is its current selection (custom selects show the chosen option).
      const haspopup = el.getAttribute("aria-haspopup");
      if (haspopup && haspopup !== "false") {
        control.current = cut(textOf(el), CAP_LABEL);
        // Labelled only by its own selection ("Select question"): prefix the question it answers ("Question 3"), as
        // a reader of the form would.
        if (bareName(control.label) === bareName(control.current)) {
          const context = questionFor(el);
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
            // ("resume_consumer.pdf Preview document") names none ("Preview document" is the chip's link). The walk
            // stops at the first ancestor too long to be one slot.
            let section = node;
            const names = (candidate) => /\b(resume|résumé|cv|cover\s*letter|transcript|documents?)(?!\w)/i.test(clean(candidate.innerText || "").replace(text, ""));
            for (let up = 0; section && up < 8 && !names(section); up += 1) {
              const above = section.parentElement;
              if (!above || clean(above.innerText || "").length > 600) break;
              section = above;
            }
            const context = clean(section?.innerText || "");
            if (context.length <= 600) control.context = cut(context, 160);
            break;
          }
        }
      }
      // A section's generic button ("Add", "Add Another", "Delete") is named by the group it acts in ("Add Another
      // Work Experience", "Delete Certifications 1"), as a reader of the form sees it: Workday's My Experience page
      // otherwise shows five identical "Add" buttons.
      if (!control.attached && !control.uploadError && /^(add( another| more| new| row| entry)?|delete|remove)$/i.test(clean(control.label))) {
        const group = groupNameOf(el);
        if (group) control.label = cut(`${control.label} ${group}`, CAP_LABEL);
      }
      const controlFormRef = formRefFor(el);
      if (controlFormRef) control.formRef = controlFormRef;
      const controlDialog = dialogIndex(el);
      if (controlDialog !== undefined) control.dialog = controlDialog;
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
        // (<option value=""> or a blank-text option with an id value, "0"/"-1"; a disabled option; or a leading
        // "-- No answer --" / "Select…" / "Choose one" with a real value) stays empty and fillable; multi-select
        // joins with ", " as groups do.
        const placeholderOption = (o) => o.value === "" || !clean(o.textContent) || o.disabled
          || (o.index === 0 && /^-+.*-+$|^-+$|^(please )?(select|choose)\b/i.test(clean(o.textContent)));
        const chosen = Array.from(el.selectedOptions).filter((o) => !placeholderOption(o));
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
        const label = clean(labelIds.size ? document.getElementById([...labelIds][0])?.textContent : labelOf(el, true)).replace(/[\s*:]+$/, "").toLowerCase();
        if (value.replace(/[\s*:]+$/, "").toLowerCase() === label || PROMPT.test(value)) value = "";
      } else if ("value" in el && el.value != null) {
        value = String(el.value);
      }
      // A select-only combobox (custom dropdown) shows its chosen option as text in its widget box, not in the
      // input's value. That text is the field's value, and never the question. An ARIA-less custom dropdown keeps
      // its value in the hidden input; its trigger text is a placeholder or that same choice, never the question.
      const custom = customDropdowns.get(el);
      // A select-only combobox that is itself an empty sliver (react-select v1: a 1px focus div beside the shown
      // choice) shows its value in the surrounding widget box, like a combobox input. So does a list-autocomplete
      // input whose wrapper owns the popup (Paylocity: aria-haspopup="listbox" on the wrapper, the committed choice
      // rendered as text beside the emptied input).
      const popupInput = tag === "input" && (el.getAttribute("role") === "combobox"
        || (el.getAttribute("aria-autocomplete") === "list" && !!el.closest("[aria-haspopup='listbox']")));
      const widget = custom ? custom.trigger : popupInput || (ariaSelect && !value) ? widgetOf(el) : el;
      // True when the value is the widget's displayed choice (the input itself is empty): a committed pick.
      let shownChoice = false;
      if (widget !== el && !custom) {
        if (!value) {
          // Placeholder text ("Select…") is not a choice; dropdown libraries mark it with a placeholder class.
          const walker = document.createTreeWalker(widget, NodeFilter.SHOW_TEXT);
          const parts = [];
          // The widget's own popup list (every suggestion row) is not its value. A lone selected option outside any
          // list (react-select v1 renders the chosen value as role=option aria-selected) is the shown choice. A
          // validation message beside the box ("This field is required") is not its value either, nor is the
          // field's label when the box holds it (Workday: one short wrapper around "Degree *" and the button).
          const popup = "[role='listbox'],[role='grid'],[role='tree'],[role='menu'],[role='option'],[role='row'],[role='status'],[aria-live]";
          const message = "[role='alert'],[class*='invalid' i],[class*='error' i],[class*='feedback' i]";
          const labelNode = document.getElementById((el.getAttribute("aria-labelledby") || "").trim().split(/\s+/)[0] || "");
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const inside = node.parentElement?.closest(popup);
            if (inside && !(inside.matches("[role='option'][aria-selected='true']") && !inside.parentElement?.closest(popup))) continue;
            const notice = node.parentElement?.closest(message);
            if (notice && notice !== widget && widget.contains(notice) && !notice.contains(el)) continue;
            if (node.parentElement?.closest("label") || (labelNode && labelNode !== widget && labelNode.contains(node))) continue;
            if (!node.parentElement?.closest("[class*='placeholder' i]") && isVisible(node.parentElement)) parts.push(clean(node.nodeValue));
          }
          value = parts.filter(Boolean).join(" ");
          // The widget box repeating the field's own question ("How did you hear about us? *") or a prompt
          // ("Select One", "Choose…"), or both in one box (Workday's "Do you go to school …? * Select One"), is a
          // placeholder: an executor that took it for a value would refuse every fill on a field that is still empty.
          const own = clean(labelOf(el, true)).replace(/[\s*:]+$/, "").toLowerCase();
          let rest = value.replace(/[\s*:]+$/, "").toLowerCase();
          if (own && rest.startsWith(own)) rest = rest.slice(own.length).replace(/^[\s*:]+/, "");
          if (!rest || PROMPT.test(rest)) value = "";
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
      // A date segment's own descriptors: its part, its input mask, its aria-valuenow, and the group it shares with
      // its sibling segments. A spinbutton's value can live in aria-valuenow alone, so an empty box takes it.
      const fieldSegment = segmentOf(el);
      const placeholder = clean(el.getAttribute("placeholder"));
      const ariaValueNow = role === "spinbutton" || fieldSegment ? clean(el.getAttribute("aria-valuenow")) : "";
      if (!value && role === "spinbutton" && ariaValueNow) value = ariaValueNow;
      let label = cut(labelOf(el, true), CAP_LABEL);
      // A select-only combobox labelled "label selection": the label is its first aria-labelledby element alone. One
      // named only by its own selection ("Select One Required", "Yes Required") takes the question it answers, and one
      // named "<question> <selection> Required" (Workday's "Degree Bachelor's Degree Required") keeps the question
      // alone, so the field keeps one identity before and after the pick.
      if (ariaSelect) {
        const first = document.getElementById((el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)[0] || "");
        const own = clean(textOf(el));
        if (first && clean(first.textContent)) label = cut(clean(first.textContent), CAP_LABEL);
        else if (label && bareName(label) === bareName(own)) {
          const question = questionFor(el);
          if (question) label = cut(question, CAP_LABEL);
        } else if (label && own) {
          const named = clean(label).match(new RegExp(`^(.*\\S)\\s+${own.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s+(required|optional))?\\.?$`, "i"));
          if (named) label = cut(named[1], CAP_LABEL);
        }
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
      // A bare "First Name" whose own name/id says which name it is ("legalName--firstName", "preferred_first_name")
      // gets that word: the section heading saying "Legal Name" often sits outside any label/legend/group link.
      if (tag === "input" && /\bname\b/i.test(label) && !/\b(legal|preferred)\b/i.test(label)) {
        const kind = `${name} ${el.id || ""}`.match(/(legal|preferred)(?=[\W_]*(name|first|last|middle|given|family))/i)?.[1];
        if (kind) label = cut(`${kind[0].toUpperCase()}${kind.slice(1).toLowerCase()} ${label}`, CAP_LABEL);
      }
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
        // The date part this box takes and how to read it back, when the DOM says so (a bare group label otherwise
        // hides the segment word from the driver).
        ...(fieldSegment ? { segment: fieldSegment } : {}),
        ...(placeholder ? { placeholder: cut(placeholder, 60) } : {}),
        ...(role === "spinbutton" ? { role: "spinbutton" } : {}),
        ...(ariaValueNow ? { ariaValueNow: cut(ariaValueNow, 40) } : {}),
        // Required is what the site declares (required / aria-required) or shows: a screen-reader suffix on the
        // label ("Today's Date Required", "Phone (required)") or on a select-only dropdown's own name (Workday's
        // "Select One Required", renamed above by its question), or an asterisk element beside the label text in the
        // field's own wrapper (Formily "ud-formily-item-asterisk"). Class names are not read: they name the site's
        // implementation ("ng-valid-required" sits on every AngularJS box with an ng-required binding, optional ones
        // included), not its rules. A field the site marks in no readable way is upgraded by the site's own
        // validation message once a step is tried without it (observe.mjs).
        required: el.required === true || el.getAttribute("aria-required") === "true"
          || (/(^|[^?])\s(required|\(required\))\s*$/i.test(label) || /\(required\)\s*$/i.test(label)) && !/\b(is|be|are|been)\s+required\s*$/i.test(label)
          || (ariaSelect && /(^|[^?])\srequired\s*$/i.test(clean(el.getAttribute("aria-label") || "")))
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
      const fieldLocator = locatorOf(el);
      if (fieldLocator) field.locator = fieldLocator;
      // The wrapper all of the group's segments share (Workday's `formField-<id>`), so the driver can tell one Date
      // group from another on the same screen without trusting a label the question crowded out.
      if (fieldSegment && fieldLocator?.aid) field.dateGroup = fieldLocator.aid.split("/")[0];
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
      // An email box is typed, never picked: a sibling hint or error list inside its wrapper is not a suggestion list.
      const structuralAutocomplete = textAutocomplete && type !== "email" ? structuralAutocompleteFor(el) : null;
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
      // "Transcript") says which document it wants. The nearest ancestor whose short text names a document is it;
      // Workday's "Resume/CV" heading sits eight wrappers above the input, so the walk is bounded by text length.
      if (type === "file") {
        // A shared wrapper can also hold the neighbouring section's "Cover letter" words, and documentKind checks cover
        // before resume; the nearest heading above the input names this slot, so it is preferred when it names a document.
        const docWords = /\b(resume|résumé|cv|cover\s*letter|letter of motivation|motivation letter|transcript|writing sample|work sample|code sample|supplement|essay|statement|proposal|portfolio|attachment|document)s?(?!\w)/i;
        for (let node = el.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
          const text = clean(node.innerText || node.textContent || "");
          if (text.length > 400) break;
          if (docWords.test(text)) {
            const above = [...node.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].filter(h => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
            const heading = clean(above.at(-1)?.innerText || above.at(-1)?.textContent || "");
            field.context = cut(docWords.test(heading) ? heading : text, 160);
            // Employer instructions for the slot ("Instructions from employer: Include: …"), or the slot's own ask for a
            // document to be written ("a brief research supplement describing a relevant project"), are kept in full.
            if (/\binstructions?\b|\b(include|attach|provide|submit)\s*:|\b(describ|explain|summari[sz]|outline|discuss)\w*\b/i.test(text)) field.instructions = cut(text, 1000);
            break;
          }
        }
      }
      if (fieldFormRef) field.formRef = fieldFormRef;
      const fieldDialog = dialogIndex(el);
      if (fieldDialog !== undefined) field.dialog = fieldDialog;
      if (type !== "file" && inSignup(el)) field.signup = true;
      fields.push(field);
    }
  }
}
