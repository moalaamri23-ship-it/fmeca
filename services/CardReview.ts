/**
 * Review of a knowledge file's subsystem cards before MasterGen uses them.
 *
 * The extraction agent drafts the cards; it sometimes drops a duty or files a
 * duty under the wrong subsystem, and a different one each run. Both errors are
 * visible in the file's own content, so they are flagged here for the engineer
 * to decide rather than repaired in code: whether a component's duty deserves a
 * function of its own is an engineering judgement, and auto-adding every item's
 * duty would bring back the bloat the cards exist to remove ("intake filter
 * filters air" as a compressor function).
 *
 * Decisions are applied to the knowledge text itself, so the corrected file is
 * both what MasterGen reads and what the engineer can download.
 */
import { parseKnowledgeCards, cleanCards, keepFunction, tokens, isNotStated, MEASUREMENT_ONLY, type FunctionClass, type KnowledgeCard } from './KnowledgeCards';

export type ReviewFlag =
    | { id: string; kind: 'uncovered'; subsystem: string; item: string; duty: string; suggestedClass?: FunctionClass }
    | { id: string; kind: 'foreign'; subsystem: string; text: string; owner: string };

export type ReviewDecision =
    | { action: 'add'; cls: FunctionClass }
    | { action: 'ignore' }
    | { action: 'move' }
    | { action: 'keep' };

const hash = (s: string) => s.split('').reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0).toString(36);

// Word stem for matching a duty's verb against function wording: "separates",
// "separated" and "separate" agree; "separator" (an item's name) does not.
const NOUN_ENDING = /(or|ors|er|ers)$/;
const stem = (w: string) => w.toLowerCase().replace(/(ing|ed|es|s)$/, '').slice(0, 5);
const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2);

// Verbs that say "hands something on" without saying what is done to it. A duty
// led by one is matched on its object instead.
const GENERIC_VERBS = new Set(['provid', 'suppl', 'deliv', 'trans', 'conve', 'carry', 'feed', 'pass']);
// Duties that are never functions of their own: reading a value, showing it,
// isolating for maintenance, or physically holding an item in place.
const NOT_A_DUTY = /\b(isolat\w*.*\bmaintenance|local (pressure |level )?indication|support\w* (the )?(package )?instrument)/i;
// Signal paths: an item that reports, confirms or relays a command serves the
// control subsystem's decision; it is that decision's means, not a duty here.
const SIGNAL_DUTY = /^(detect|confirm|report|command|actuat|pilot|receiv|clear|transmit|signal)/i;

function dutyCovered(duty: string, card: KnowledgeCard): boolean {
    const fnWords = card.functions.flatMap(f => words(f.text)).filter(w => !NOUN_ENDING.test(w));
    const fnStems = new Set(fnWords.map(stem));
    const dutyWords = words(duty);
    if (!dutyWords.length) return true;
    const verb = stem(dutyWords[0]);
    if (!GENERIC_VERBS.has(verb)) return fnStems.has(verb);
    // A generic verb: covered when the object it hands on is named in a function.
    return dutyWords.slice(1).some(w => fnStems.has(stem(w)));
}

/** Name tokens that identify exactly one card. */
function distinctiveNameTokens(cards: KnowledgeCard[]): Map<string, KnowledgeCard> {
    const seen = new Map<string, KnowledgeCard[]>();
    for (const c of cards) for (const t of tokens(c.name)) {
        if (t.length < 3) continue;
        seen.set(t, [...(seen.get(t) || []), c]);
    }
    const out = new Map<string, KnowledgeCard>();
    for (const [t, owners] of seen) if (owners.length === 1) out.set(t, owners[0]);
    return out;
}

/**
 * Every flag the file's content supports. Uncovered duties here are only
 * candidates: most component duties are the means of the function they sit
 * under (a filter serves "compress air"), and only the model can tell a means
 * from a separately failing duty. See `AIService.selectMissingDuties`.
 */
export function reviewKnowledge(text: string): ReviewFlag[] {
    const cards = cleanCards(parseKnowledgeCards(text));
    if (cards.length < 2) return [];
    const flags: ReviewFlag[] = [];

    for (const card of cards) {
        for (const item of card.items) {
            const duty = item.duty.trim();
            if (!duty || isNotStated(duty) || MEASUREMENT_ONLY.test(duty) || NOT_A_DUTY.test(duty) || SIGNAL_DUTY.test(duty)) continue;
            if (dutyCovered(duty, card)) continue;
            flags.push({ id: hash(`uncovered|${card.name}|${item.name}|${duty}`), kind: 'uncovered', subsystem: card.name, item: item.name, duty });
        }
    }

    // A protective line that names another subsystem as the one acting ("stop
    // when the MCC removes the run command") is that subsystem's duty.
    const distinctive = distinctiveNameTokens(cards);
    for (const card of cards) {
        for (const fn of card.functions.filter(f => f.cls === 'protection')) {
            const owner = [...tokens(fn.text)].map(t => distinctive.get(t)).find(c => c && c !== card);
            if (!owner) continue;
            flags.push({ id: hash(`foreign|${card.name}|${fn.text}`), kind: 'foreign', subsystem: card.name, text: fn.text, owner: owner.name });
        }
    }
    return flags;
}

export const isDecided = (flag: ReviewFlag, decisions: Record<string, ReviewDecision>) => {
    const d = decisions[flag.id];
    if (!d) return false;
    return flag.kind === 'uncovered' ? d.action === 'add' || d.action === 'ignore' : d.action === 'move' || d.action === 'keep';
};

// ---------------------------------------------------------------------------
// Applying decisions to the text.

const HEADER = /^SECTION\s+3\/\d+\s*-\s*SUBSYSTEM:\s*(.+?)\s*$/i;
const ANY_SECTION = /^SECTION\s+\d/i;
const FUNCTION_LINE = /^-\s*(primary|containment|protection|control|support)\s*:/i;

/** [start, end) line range of a subsystem block. */
function blockRange(lines: string[], name: string): [number, number] | null {
    const start = lines.findIndex(l => { const m = l.trim().match(HEADER); return !!m && m[1].trim() === name; });
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !ANY_SECTION.test(lines[end].trim())) end++;
    return [start, end];
}

function insertFunction(lines: string[], name: string, line: string): void {
    const range = blockRange(lines, name);
    if (!range) return;
    let at = -1;
    for (let i = range[0]; i < range[1]; i++) if (FUNCTION_LINE.test(lines[i].trim()) || /^Functions\s*:/i.test(lines[i].trim())) at = i;
    if (at < 0) return;
    lines.splice(at + 1, 0, line);
}

function removeFunction(lines: string[], name: string, text: string): void {
    const range = blockRange(lines, name);
    if (!range) return;
    for (let i = range[0]; i < range[1]; i++) {
        const t = lines[i].trim();
        if (FUNCTION_LINE.test(t) && t.includes(text)) { lines.splice(i, 1); return; }
    }
}

const REVIEW_REF = '[engineer review]';

/**
 * The knowledge text with the decisions applied: an added duty becomes a
 * function line on its subsystem, a moved protective duty leaves its card and
 * joins the owner's unless the owner already states it.
 */
export function applyReview(text: string, flags: ReviewFlag[], decisions: Record<string, ReviewDecision>): string {
    const lines = text.split(/\r?\n/);
    const cards = cleanCards(parseKnowledgeCards(text));
    for (const flag of flags) {
        const d = decisions[flag.id];
        if (!d) continue;
        if (flag.kind === 'uncovered' && d.action === 'add') {
            insertFunction(lines, flag.subsystem, `- ${d.cls}: ${flag.duty} ${REVIEW_REF}`);
        }
        if (flag.kind === 'foreign' && d.action === 'move') {
            removeFunction(lines, flag.subsystem, flag.text);
            const owner = cards.find(c => c.name === flag.owner);
            const moved = tokens(flag.text);
            // Three shared content words: the owner already says it.
            const stated = owner?.functions.filter(keepFunction).some(f => [...tokens(f.text)].filter(t => moved.has(t)).length >= 3);
            if (owner && !stated) insertFunction(lines, flag.owner, `- protection: ${flag.text} ${REVIEW_REF}`);
        }
    }
    return lines.join('\n');
}

/** What the duty-selection call needs from each card. */
export function dutyCandidates(text: string, flags: ReviewFlag[]) {
    const cards = cleanCards(parseKnowledgeCards(text));
    return cards
        .map(c => ({
            subsystem: c.name,
            functions: c.functions.map(f => `${f.cls}: ${f.text.replace(/\s*\[S\d+[^\]]*\]/g, '')}`),
            candidates: flags.filter(f => f.kind === 'uncovered' && f.subsystem === c.name)
                .map(f => ({ id: f.id, item: (f as any).item as string, duty: (f as any).duty as string })),
        }))
        .filter(c => c.candidates.length);
}
