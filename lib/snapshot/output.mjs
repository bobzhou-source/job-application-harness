// lib/snapshot/output.mjs — page messages, gate detection (captcha/payment/mfa), visible page text, and the snapshot return shape.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
  // Keep both ends of a long text within the same character budget: a page's own per-section markers ("Fields to
  // fix: 3", "You have no education history") render at the BOTTOM of a long form, so a head-only cut hides exactly
  // the part the models need. The middle is what nothing is decided from.
  const headTail = (text, cap) => {
    const s = String(text ?? "");
    if (s.length <= cap) return s;
    const marker = "\n…\n";
    const tail = Math.max(0, Math.floor(cap * 0.4) - marker.length);
    return s.slice(0, cap - tail - marker.length) + marker + s.slice(-tail);
  };
  // Page messages: visible ARIA alert/status/live-region text (validation banners, errors), and the standard
  // framework per-field validation text (ASP.NET MVC's field-validation-error, Bootstrap's invalid-feedback), shown
  // only once the site rejects a value. Polite/status regions often wrap whole widgets, so those count only when
  // they hold no interactive elements, options, or headings.
  const messages = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("[role='alert'],[role='alertdialog'],[role='status'],[aria-live='assertive'],[aria-live='polite'],.field-validation-error,.invalid-feedback"))) {
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
  const captchaWidgets = Array.from(document.querySelectorAll(
    "iframe[src*='recaptcha'],iframe[src*='hcaptcha'],iframe[src*='turnstile'],.g-recaptcha,.h-captcha"
  )).filter((el) => {
    if (!isVisible(el)) return false;
    if (el.matches("button,input,a") || el.getAttribute("data-size") === "invisible") return false;
    if (el.tagName === "IFRAME" && /[?&]size=invisible\b/.test(el.src)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 30 && rect.height > 30 && rect.bottom > 0 && rect.right > 0;
  });
  const shownCaptcha = captchaWidgets.length > 0;
  // A solved captcha (its response token filled in) no longer gates the page.
  const solvedCaptcha = Array.from(document.querySelectorAll(
    "[name='g-recaptcha-response'],[name='h-captcha-response'],[name='cf-turnstile-response']"
  )).some((el) => Boolean(el.value));
  // A home-grown human check ("I'm not a robot" / "I am human" checkbox) is a captcha too: ticking it is the user's.
  const robotChecks = fields.filter((f) => /\b(i'?m|i am) not a robot\b|\bi am (a )?human\b|\bverify (that )?you('re| are) (a )?human\b/i.test(f.label ?? "")
    && !(Array.isArray(f.checkedRefs) && f.checkedRefs.length) && f.value !== true && f.value !== "true" && f.value !== "on");
  const robotCheck = robotChecks.length > 0;
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
  // be ticked ("captcha") waits until the form it sits in is submitted: the site refuses that submit until the
  // person ticks it, whichever step it is (an account-creation form, a step's Next, the final submit). captchaForms
  // names those forms (document-local form refs; "" for a widget outside every form) so a submit elsewhere on the
  // page (a footer newsletter box with its own captcha) is not held up by it.
  if (openChallenge) gates.push("captcha-challenge");
  else if ((shownCaptcha && !solvedCaptcha) || robotCheck) gates.push("captcha");
  const captchaForms = [];
  if (gates.includes("captcha")) {
    for (const el of solvedCaptcha ? [] : captchaWidgets) if (!captchaForms.includes(formRefFor(el))) captchaForms.push(formRefFor(el));
    for (const f of robotChecks) if (!captchaForms.includes(f.formRef ?? "")) captchaForms.push(f.formRef ?? "");
  }
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

  // A message whose text is exactly a control/option/field label this same snapshot already exposes is the widget's
  // own screen-reader announcer (a veteran checkbox group narrating its option labels, "Link"), not a message about
  // the form: it must not crowd the real banners out of the 8 slots below.
  const labelTexts = new Set();
  for (const control of controls) labelTexts.add(clean(control.label));
  for (const field of fields) {
    labelTexts.add(clean(field.label));
    labelTexts.add(clean(field.name));
    for (const option of field.options ?? []) labelTexts.add(clean(option));
  }
  // The page's own issue announcement ("You have 10 issues that need to be fixed…", "The ZIP Code field is
  // required. (1 out of 10 issues)") is the only carrier of WHY a submit was rejected, and it is emitted into a live
  // region beside the widgets' own announcers: keep it first so the cap can never drop it.
  const issue = (message) => /\b\d+\s*(?:out of|\/)\s*\d+\s*issues?\b|\byou have\s+\d+\s+issues?\b|\b\d+\s+issues?\s+(?:that|need|to|must)\b/i.test(message);
  const kept = messages.filter((message) => !labelTexts.has(message));
  const shown = [...kept.filter(issue), ...kept.filter((message) => !issue(message))].slice(0, 8);

  // Visible page text in document order (headings, section notes such as "You have no education history.
  // Required"), so the models see structure that is not an interactive control. Line breaks are kept.
  const pageText = headTail((document.body ? document.body.innerText : "")
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim(), 3000);

  return { controls, fields, gates, captchaForms, messages: shown, pageText };
}
