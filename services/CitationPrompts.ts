/**
 * What "evidence" means, per field.
 *
 * The four citable fields are cited for four different reasons, and a single
 * prompt serves none of them well:
 *
 *   Specs            — the document STATES this value. Near-literal.
 *   Function         — the document shows the equipment doing this JOB. The
 *                      quantities in the claim are context only; citing them
 *                      would duplicate Specs and miss the duty entirely.
 *   Current Controls — the instrument, tag or existing task that IS this
 *                      control. It was generated from these very sources, so a
 *                      line nothing supports is a finding, not a shrug.
 *   Mitigation       — why this action is the right barrier. Against the PM
 *                      checklist the question inverts: a hit there means the
 *                      action already exists and is not a recommendation.
 */

import type { CitableField } from './FieldClaims';
import type { CitedSourceKind } from '../types';

/** Rules every reading call shares — verbatim quoting is what makes a citation locatable. */
const COMMON_RULES = `Rules:
- "quote" MUST be copied character-for-character from an excerpt. Never paraphrase, never join text from two places, never add words.
- Quote 3-25 words: enough to be unique in the document, short enough to be one idea.
- "claim" is the number of the claim the passage answers.
- "why" is one short clause saying how it answers that claim.
- A claim that nothing in these excerpts answers is simply left out. Never stretch a passage to cover a claim it does not.

Return ONLY JSON: {"results":[{"claim":1,"quote":"...","why":"..."}]}`;

const SPECS_PROMPT = `You find, for each specification a reader has written down, the passage in a document that states it.

You are given numbered CLAIMS — each is one specification: a parameter and its value — and numbered EXCERPTS from ONE document.
For each claim, find the passage that states that parameter's value.

- The value must match. A passage naming the parameter with a DIFFERENT value does not support the claim; leave the claim out rather than offer it.
- A nameplate row, a datasheet line, a table entry or a drawing annotation all count.
- Return AT MOST ONE passage per claim. Pick the one that states the value most directly.

${COMMON_RULES}`;

const FUNCTION_PROMPT = `You find, for each function a reader has written down, the passage in a document showing that the equipment performs that function.

You are given numbered CLAIMS — each is one duty the equipment performs — and numbered EXCERPTS from ONE document.

What you are looking for is the DUTY, not its numbers:
- A claim like "provides pressure of 9 barg in the loading and unloading sequence" is cited on the LOADING AND UNLOADING SEQUENCE — the service, the operating mode, the job. NOT on "9 barg". Specification values are cited elsewhere and must not be cited here.
- A passage that only repeats a number is worthless for this claim. A passage that shows the equipment in this service, this operating mode, this sequence, or serving this downstream user is what supports it, even when it never uses the reader's words.
- The document will rarely state the function outright. Operating descriptions, sequence and procedure steps, service descriptions, control narratives and line lists are where a function is implied. Implied evidence is what is wanted here.

${COMMON_RULES}`;

const CONTROLS_PROMPT = `You find, for each control a reader has recorded as already in place, the passage in a document that IS that control.

You are given numbered CLAIMS — each is one control already deployed — and numbered EXCERPTS from ONE document.

- In reference and engineering documents, look for the instrument, tag number, alarm, trip, interlock, shutdown, protection device or monitoring point that performs this control, with its setpoint or limit when stated.
- In a PM checklist, look for the existing maintenance or inspection task that performs this control, and prefer the passage that carries its team or interval.
- A passage that merely mentions the equipment is NOT evidence of a control. The passage must be the control itself.
- A claim may have more than one supporting passage; return each of them.

${COMMON_RULES}`;

const MITIGATION_PROMPT = `You find, for each recommended action a reader has written down, the passage in a document that justifies it.

You are given numbered CLAIMS — each is one recommended action — and numbered EXCERPTS from ONE document.

- Evidence for a recommendation is what makes it the right barrier: the equipment characteristic, the protection gap, the vulnerability, the failure history or the manufacturer instruction the action responds to.
- The passage naming the equipment this action applies to counts only when it establishes why the action is needed.
- A claim may have more than one supporting passage; return each of them.

${COMMON_RULES}`;

/**
 * Mitigation against the PM checklist, where the question inverts.
 *
 * A recommended action already in the plant's PM program is not a mitigation —
 * it is a control already in place, sitting in the wrong column. Finding it is
 * the point of this pass, which is why the flag it raises is a warning rather
 * than a citation like any other.
 */
const MITIGATION_DUPLICATE_PROMPT = `You check whether recommended actions ALREADY EXIST in a plant's PM program.

You are given numbered CLAIMS — each is one recommended action — and numbered EXCERPTS from the plant's EXISTING PM checklist.

For each claim, find the existing task that is the SAME WORK. Same intent counts, not only same wording: "monthly vibration check" and "vibration reading, monthly" are the same task; "replace the bearing" and "check the bearing" are not.
Leave out any claim the checklist does not already cover — that one is a genuine recommendation and there is nothing to report about it.

${COMMON_RULES}`;

/** The reading prompt for one field against one kind of source. */
export function readPromptFor(field: CitableField, sourceKind: CitedSourceKind): string {
    if (field === 'specs') return SPECS_PROMPT;
    if (field === 'func') return FUNCTION_PROMPT;
    if (field === 'currentControls') return CONTROLS_PROMPT;
    return sourceKind === 'checklist' ? MITIGATION_DUPLICATE_PROMPT : MITIGATION_PROMPT;
}

/**
 * True when a hit is a warning rather than support: the action is already in
 * the PM program.
 */
export const isDuplicateCheck = (field: CitableField, sourceKind: CitedSourceKind): boolean =>
    field === 'mitigation' && sourceKind === 'checklist';

/** How many passages one source may return for one claim. */
export const maxPerClaimPerSource = (field: CitableField): number => (field === 'specs' ? 1 : 3);

/** What the card says a passage is, for this field and source. */
export function citationLabel(field: CitableField, sourceKind: CitedSourceKind, origin: string): string {
    if (isDuplicateCheck(field, sourceKind)) return 'Already a PM task';
    if (field === 'func') return `${origin} · implied`;
    return origin;
}
