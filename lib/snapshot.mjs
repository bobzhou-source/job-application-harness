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

import coreSource from "./snapshot/core.mjs" with { type: "text" };
import textSource from "./snapshot/text.mjs" with { type: "text" };
import labelsSource from "./snapshot/labels.mjs" with { type: "text" };
import discoverySource from "./snapshot/discovery.mjs" with { type: "text" };
import scanSource from "./snapshot/scan.mjs" with { type: "text" };
import groupsSource from "./snapshot/groups.mjs" with { type: "text" };
import optionsSource from "./snapshot/options.mjs" with { type: "text" };
import outputSource from "./snapshot/output.mjs" with { type: "text" };

// Runs inside one frame's document. Must be self-contained: serialized by evaluate.
// The body lives in lib/snapshot/*.mjs parts — source fragments kept importable there
// behind an if(false) wrapper — concatenated here in the original order into one
// function, so the program evaluate serializes and the single scope its helpers
// share are unchanged.
const partBody = (text) => text.slice(text.indexOf("if (false) {\n") + "if (false) {\n".length, text.lastIndexOf("\n}"));
const collectInFrame = new Function(
  [coreSource, textSource, labelsSource, discoverySource, scanSource, groupsSource, optionsSource, outputSource].map(partBody).join("\n")
);

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
    // Browser-extension frames (a password manager's injected "Update password?" bar) are the browser's, not the
    // site's: acting there changes the applicant's own saved data.
    if (/^(chrome|chrome-extension|moz-extension|devtools|edge):/i.test(frameUrl)) continue;

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
