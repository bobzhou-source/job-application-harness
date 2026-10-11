// lib/snapshot/output.mjs — page messages, gate detection (captcha/payment/mfa), visible page text, and the snapshot return shape.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
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
