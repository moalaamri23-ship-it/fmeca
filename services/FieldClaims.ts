/**
 * Splitting a field into the assertions it actually makes.
 *
 * Evidence is judged per assertion, not per field. "Rated flow 120 m3/h,
 * discharge pressure 6 bar, motor 45 kW" is three claims about three different
 * parameters, and a datasheet that proves the flow says nothing about the
 * motor. A five-line control list is five claims, and the useful answer is
 * which of the five nothing supports.
 *
 * Each field splits differently because each field is written differently, so
 * the shape of the split lives here rather than inside the search.
 */

import type { FieldClaim } from '../types';

/** The four fields that carry citations. */
export type CitableField = 'specs' | 'func' | 'currentControls' | 'mitigation';

/** Below this a fragment is a stray token, not an assertion. */
const MIN_CLAIM_CHARS = 6;

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Strip the "1- " / "2)" numbering a list line carries. */
const unnumber = (line: string): string => line.replace(/^\s*\d+\s*[-–.)]\s*/, '').trim();

/**
 * Specs: one claim per parameter.
 *
 * Commas and semicolons separate parameters, newlines separate them too. A
 * comma inside a number ("1,480 rpm") must not split it, so a separator only
 * counts when it is not sitting between two digits.
 */
function splitSpecs(text: string): string[] {
    return text
        .split(/\n+|;|,(?!\d)/)
        .map(clean)
        .filter(part => part.length >= MIN_CLAIM_CHARS);
}

/**
 * Function: one claim per duty.
 *
 * A function statement is prose, and its clauses are usually one duty each —
 * "to deliver lube oil to the bearings, and to maintain supply on standby" is
 * two duties. Sentences and newlines split; a single sentence stays whole,
 * because chopping a duty in half loses the thing being cited.
 *
 * Quantities are deliberately LEFT IN. They are context the reader needs to
 * recognise the duty; the prompt is what keeps the citation off them.
 */
function splitFunction(text: string): string[] {
    const parts = text
        .split(/\n+|(?<=[.!?])\s+(?=[A-Z])|;/)
        .map(clean)
        .filter(part => part.length >= MIN_CLAIM_CHARS);
    return parts.length > 0 ? parts : [clean(text)].filter(Boolean);
}

/**
 * Current Controls and Mitigation: one claim per numbered line.
 *
 * Both are built by the numbered-action builder, so the line IS the assertion.
 * Text that never went through the builder falls back to one claim per line.
 */
function splitActions(text: string): string[] {
    return text
        .split(/\n+/)
        .map(line => unnumber(clean(line)))
        .filter(line => line.length >= MIN_CLAIM_CHARS);
}

const SPLITTERS: Record<CitableField, (text: string) => string[]> = {
    specs: splitSpecs,
    func: splitFunction,
    currentControls: splitActions,
    mitigation: splitActions,
};

/**
 * The claims a field makes. Empty when the field has nothing worth citing.
 *
 * Ids are positional and stable for a given text, which is all they have to be:
 * the citations they key are thrown away and refound whenever the text changes.
 */
export function buildClaims(field: CitableField, text: string): FieldClaim[] {
    const parts = (SPLITTERS[field] ?? splitActions)(text || '');
    const seen = new Set<string>();
    const claims: FieldClaim[] = [];
    for (const part of parts) {
        const key = part.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ id: `k${claims.length + 1}`, index: claims.length + 1, text: part });
    }
    return claims;
}
