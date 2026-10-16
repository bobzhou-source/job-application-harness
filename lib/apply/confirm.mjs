// Submission confirmation: the page-text/URL evidence that an application was actually received.

import * as rules from '../rules.mjs';
import { isEmpty } from './fields.mjs';
import { activeFields } from './screen.mjs';

// A submission counts only with positive evidence: the page states it was received (a thank-you, "application
// submitted/received", "applied on <date>"), and no final-submit control or required empty field remains.
// A closed modal or an emptied form alone is not a submission.
// Only consulted after this run clicked a final submit (submittedVia), so post-submit phrasing ("You're all set")
// counts too. The evidence must be NEW since that click: a standing phrase ("the position you applied for" in a
// privacy FAQ, "Thank you for your interest" on a careers home) that the page already showed before the click
// proves nothing about it, so the pre-click phrases and URL are recorded (evidenceOf) and excluded.
// "succesfully"/"sucessfully" misspellings and "has successfully been submitted" word order are site wording too.
// "Applied on" counts only with its date ("Applied on October 10, 2026"): a status table's "Applied On" column
// header names no application.
const APPLIED_ON = /\bapplied on:?\s+(\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i.source;

// "You have applied" states a submission; "Have you applied (to us) before?", "if you have applied" and "the
// position for which you have applied" ask about or refer to one.
const YOU_APPLIED = `(?<!\\b(have|if|whether|when|once|after|before|until|unless|which|that|where|whom)\\s+)you('ve| have)? (succ?ess?fully )?applied\\b(?!\\s+(before|previously|in the past)\\b)`;

export const SUBMITTED_TEXT = new RegExp(`thank(s| you) for (your )?(application|applying|submitting|submission|your interest|(your )?registration|registering)|application (has |have )?(been |was |is )?(succ?ess?fully )?(been )?(submitted|received|complete|sent)|(we('ve| have)|has been) received your application|${APPLIED_ON}|${YOU_APPLIED}|submission (is )?(complete|received|successful)|succ?ess?fully submitted|you('| a)re all set\\b`, 'i');

// Some sites confirm only by where they land after the submit (Workday: /jobTasks/completed/application).
export const SUBMITTED_URL = /\/(completed\/application|application-?(submitted|complete|confirmation)|thank-?you|confirmation)\b/i;

// Every confirmation phrase a page shows, lowercased, plus whether its URL already confirms: the baseline recorded
// at the submit click, and the set a later screen is compared against.
export const evidenceOf = current => ({
  text: new Set((String(current.pageText ?? '').match(new RegExp(SUBMITTED_TEXT.source, 'gi')) ?? []).map(phrase => phrase.toLowerCase())),
  url: SUBMITTED_URL.test(new URL(current.url).pathname),
});

// The confirmation on `current` that `before` (the submit click's baseline) did not already show: a phrase or the
// landing URL. Without a baseline (a rerun's standing confirmation) any evidence counts.
export const newEvidence = (current, before = null) => {
  const now = evidenceOf(current);
  const phrase = [...now.text].find(text => !before?.text.has(text));
  if (phrase) return phrase;
  if (now.url && !before?.url) return new URL(current.url).pathname;
  return null;
};

export const isConfirmed = (current, before = null) => Boolean(newEvidence(current, before))
  && !current.controls.some(control => rules.classifyControl(control) === 'final-submit')
  && !activeFields(current).some(field => field.required && isEmpty(field));

// A standing confirmation found without this run's submit must name a received application: account sign-up
// pages say "Thank you for registering" too, and a talent-community "thank you for your interest" is no application.
export const APPLIED_TEXT = new RegExp(`application (has |have )?(been |was |is )?(succ?ess?fully )?(been )?(submitted|received|sent)|(we('ve| have)|has been) received your application|thank(s| you) for (your )?(application|applying)|${YOU_APPLIED}|${APPLIED_ON}`, 'i');
