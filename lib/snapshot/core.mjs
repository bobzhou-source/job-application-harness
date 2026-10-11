// lib/snapshot/core.mjs — collectInFrame primitives: size caps, text cleaning (clean/cut), ref/form-ref stamping, visibility/disabled checks.
// Part of the in-page collectInFrame program (lib/snapshot.mjs), imported there as
// text and concatenated in the original order; the if(false) wrapper keeps the part
// importable as a module without executing browser code in node.
if (false) {
  const CAP_LABEL = 120;
  const CAP_OPTION = 80;
  const CAP_OPTIONS = 40;
  const CAP_VALUE = 200;
  const CAP_HREF = 300;

  // Icon-font glyphs (Unicode private use: a dropdown's caret, a required mark) are not text; invisible format
  // characters (zero-width space before a dijit option, direction marks around "(English US)") are not either.
  const clean = (s) => String(s || "").replace(/\p{Co}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
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

}
