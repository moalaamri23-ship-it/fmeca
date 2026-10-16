/**
 * Subsystem cards from an extracted knowledge file.
 *
 * The extraction skill (docs/knowledge-extraction-skill) writes one block per
 * subsystem: "SECTION 3/<n> - SUBSYSTEM: <name>" with Items, Functions and
 * Specifications lines. When a knowledge file has that layout, MasterGen takes
 * the subsystem names, specs and function descriptions straight from it instead
 * of asking the model to decide them again. Two independent decisions about the
 * same boundaries disagreed run to run; the extraction agent sees the full
 * documents, so its decision is the one kept.
 *
 * The extraction agent is reliable on layout and unreliable on a few judgement
 * calls that repeat in the same shapes. `cleanCards` removes those shapes in
 * code, so the result does not depend on which run produced the file.
 */

import type { FailureShape } from '../types';

export type FunctionClass = 'primary' | 'containment' | 'protection' | 'control' | 'support';

export interface CardFunction {
    cls: FunctionClass;
    text: string;
}

export interface KnowledgeCard {
    name: string;
    functions: CardFunction[];
    specs: string[];
    delivers: string[];
    receives: string[];
    limits: CardLimit[];
    /** Its Delivers values are all produced by the subsystem it receives from. */
    passThrough?: boolean;
    /** Name plus Items lines, for matching an "executed by" entry to this card. */
    itemsText: string;
}

export interface CardLimit {
    text: string;
    executedBy: string;
}

/** One row per card function line; MasterGen uses these as the breakdown rows. */
export interface CardRow {
    function: string;
    standard: string;
    functionClass: FunctionClass;
    quantified: boolean;
    evidence: 'evident' | 'hidden';
    /** Set where the class alone decides it; value duties are classified by the model. */
    failureShape?: FailureShape;
}

export interface CardSubsystem {
    name: string;
    specs: string;
    func: string;
    rows: CardRow[];
}

const SUBSYSTEM_HEADER = /^SECTION\s+3\/\d+\s*-\s*SUBSYSTEM:\s*(.+?)\s*$/i;
const ANY_SECTION = /^SECTION\s+\d/i;
const FUNCTION_LINE = /^-\s*(primary|containment|protection|control|support)\s*:\s*(.+)$/i;
const SOURCE_REF = /\s*\[S\d+[^\]]*\]/g;
// Plant tags (66-PT-127381, 66-D-127453A). Identity, not function.
const TAG = /\b\d{2,3}-?[A-Z]{1,5}-\d{3,}[A-Z]?\b/g;

const tidy = (s: string) => s
    .replace(SOURCE_REF, '')
    .replace(TAG, '')
    .replace(/\(\s*[\/;,\s]*\)/g, '')
    .replace(/\s*\/\s*(?=[,;.]|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .trim();

const isNotStated = (s: string) => /^not stated\.?$/i.test(s.replace(SOURCE_REF, '').trim());

// Limits rows: parameter | tag | normal | lo alarm | lo trip | hi alarm | hi trip | units | ...
// Only the stated numbers travel; they are the performance standards of the
// protective and control functions, and the FF step needs them as values.
const LIMIT_COLUMNS = ['normal', 'low alarm', 'low trip', 'high alarm', 'high trip'];
function parseLimit(row: string): CardLimit | null {
    const cols = row.replace(SOURCE_REF, '').split('|').map(c => c.trim());
    if (cols.length < 8) return null;
    const unit = isNotStated(cols[7]) ? '' : ` ${cols[7]}`;
    const values = LIMIT_COLUMNS
        .map((label, i) => [label, cols[2 + i]] as const)
        .filter(([, v]) => v && !isNotStated(v) && /\d/.test(v))
        .map(([label, v]) => `${label} ${v}${unit}`);
    if (!values.length) return null;
    const executedBy = cols.length > 10 && !isNotStated(cols[10]) ? cols[10] : '';
    return { text: `${cols[0]}: ${values.join(', ')}`, executedBy };
}

/** Parse the subsystem blocks. Returns [] when the file has no card layout. */
export function parseKnowledgeCards(text: string): KnowledgeCard[] {
    if (!text) return [];
    const cards: KnowledgeCard[] = [];
    let current: KnowledgeCard | null = null;
    let inFunctions = false;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const header = line.match(SUBSYSTEM_HEADER);
        if (header) {
            current = { name: header[1].trim(), functions: [], specs: [], delivers: [], receives: [], limits: [], itemsText: header[1].trim() };
            cards.push(current);
            inFunctions = false;
            continue;
        }
        if (ANY_SECTION.test(line)) { current = null; inFunctions = false; continue; }
        if (!current || !line || /^=+$/.test(line)) continue;

        if (/^Functions\s*:/i.test(line)) { inFunctions = true; continue; }
        const fn = line.match(FUNCTION_LINE);
        if (fn && inFunctions) {
            current.functions.push({ cls: fn[1].toLowerCase() as FunctionClass, text: fn[2].trim() });
            continue;
        }
        if (/^[A-Za-z][A-Za-z ,]*:/.test(line)) inFunctions = false;

        const spec = line.match(/^Specifications\s*:\s*(.+)$/i);
        if (spec) { current.specs.push(spec[1].trim()); continue; }
        const delivers = line.match(/^Delivers\s*:\s*(.+)$/i);
        if (delivers) { current.delivers.push(delivers[1].trim()); continue; }
        const receives = line.match(/^Receives\s*:\s*(.+)$/i);
        if (receives) { current.receives.push(receives[1].trim()); continue; }
        const limit = line.match(/^Limits\s*:\s*(.+)$/i);
        if (limit) { const l = parseLimit(limit[1]); if (l) current.limits.push(l); continue; }
        const items = line.match(/^Items\s*:\s*(.+)$/i);
        if (items) current.itemsText += ' ' + items[1];
    }
    return cards.filter(c => c.functions.length > 0);
}

// Frame, skid, canopy and access are where equipment sits, not something that
// delivers an output. The skill says so; this holds when a run ignores it.
const STRUCTURE_NAME = /\b(skid|structure|structural|base ?frame|frame|access|enclosures?|canop(y|ies)|platforms?|ladders?|handrails?)\b/i;
// A protective function is an action. Reporting a value to something else that
// acts is the other subsystem's duty.
const PROTECTIVE_ACTION = /\b(reliev|stop|trip|shut|isolat|prevent|clos|vent|de-?energi|inhibit|limit|interrupt|disconnect|block|bypass|release|discharg)/i;
const MEASUREMENT_ONLY = /\b(monitor|measur|indicat|signal|sens|display|reading|transmit)/i;
// `support` covers the subsystem's own structural duty. Heat or air handling
// written as support is a misclassified process duty.
const PROCESS_AS_SUPPORT = /\b(heat|air|cool|eject|exhaust|flow|ventilat|temperature)/i;

export function keepFunction(fn: CardFunction): boolean {
    if (!fn.text || isNotStated(fn.text)) return false;
    if (fn.cls === 'protection' && !PROTECTIVE_ACTION.test(fn.text) && MEASUREMENT_ONLY.test(fn.text)) return false;
    if (fn.cls === 'support' && PROCESS_AS_SUPPORT.test(fn.text)) return false;
    return true;
}

const STOP_WORDS = new Set(['and', 'the', 'of', 'a', 'b', 'ab', 'or', 'by', 'to', 'in', 'not', 'stated', 'system', 'subsystem', 'package']);
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP_WORDS.has(t)));

/** The card whose name or items best match an "executed by" entry, or null. */
function executingCard(executedBy: string, cards: KnowledgeCard[]): KnowledgeCard | null {
    const want = tokens(executedBy);
    let best: KnowledgeCard | null = null;
    let bestScore = 0;
    for (const c of cards) {
        // The name decides; items only break a tie. Items lines mention what a
        // device is used for ("for lead/lag control"), so on their own they
        // pull a limit toward any subsystem that merely feeds the controller.
        const name = tokens(c.name);
        const items = tokens(c.itemsText);
        const score = [...want].reduce((n, t) => n + (name.has(t) ? 10 : items.has(t) ? 1 : 0), 0);
        if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
}

export function cleanCards(cards: KnowledgeCard[]): KnowledgeCard[] {
    const kept = cards
        .filter(c => !STRUCTURE_NAME.test(c.name))
        .map(c => ({ ...c, functions: c.functions.filter(keepFunction), limits: [] as CardLimit[] }))
        .filter(c => c.functions.length > 0);
    // A limit is a performance standard of the subsystem that acts on it. An
    // alarm or trip left on the subsystem that is merely measured turns into a
    // "does not signal" or "unable to trip" failure there, duplicating the one
    // the control subsystem already owns.
    cards.forEach(original => {
        const own = kept.find(c => c.name === original.name);
        for (const limit of original.limits) {
            const target = (limit.executedBy && executingCard(limit.executedBy, kept)) || own;
            if (target) target.limits.push(limit);
        }
    });
    // A subsystem that hands on exactly the values it receives (a buffer vessel
    // between a producer and the boundary) does not produce them. Judging it
    // against them writes the producer's shortfall a second time.
    const numbers = (s: string) => new Set((s.replace(SOURCE_REF, '').match(/\d+(?:\.\d+)?/g) || []));
    for (const card of kept) {
        const own = numbers(card.delivers.join(' '));
        if (!own.size) continue;
        const received = card.receives.join(' ').toLowerCase();
        const sources = kept.filter(o => o !== card && received.includes(o.name.toLowerCase()));
        card.passThrough = sources.some(src => {
            const theirs = numbers(src.delivers.join(' '));
            return [...own].every(n => theirs.has(n));
        });
    }
    return kept;
}

// Primary first: it is the mission every other line qualifies.
const CLASS_ORDER: FunctionClass[] = ['primary', 'control', 'containment', 'protection', 'support'];

const sentence = (s: string) => {
    const t = tidy(s).replace(/[.;,\s]+$/, '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) + '.' : '';
};

export function cardToSubsystem(card: KnowledgeCard): CardSubsystem {
    const func = CLASS_ORDER
        .flatMap(cls => card.functions.filter(f => f.cls === cls))
        .map(f => sentence(f.text))
        .filter(Boolean)
        .join(' ');
    const specs = [...card.specs, ...card.limits.map(l => l.text)]
        .map(s => tidy(s).replace(/[.;\s]+$/, ''))
        .filter(s => s && !isNotStated(s))
        .join('; ');
    const rows = CLASS_ORDER
        .flatMap(cls => card.functions.filter(f => f.cls === cls))
        .map(f => toRow(f, tidy(card.delivers[0] || '').replace(/[.;\s]+$/, ''), !!card.passThrough))
        .filter((r): r is CardRow => !!r);
    return { name: card.name.replace(TAG, '').replace(/\s{2,}/g, ' ').trim(), specs, func, rows };
}

// The card already states each function once with its standard. Re-deriving
// rows with the model let it add duties from the operating context (standby,
// trips, cycling) to subsystems that do not own them.
// The class settles the shape for duties with no amount to fall short of:
// containment is held or lost, a protective device acts on demand or does not.
// Duties carrying a value (primary, control) depend on the physics of that
// value -- a flow can fall short, a dew point can only be exceeded -- so the
// model classifies them (AIService.classifyFailureShapes).
const SHAPE_BY_CLASS: Partial<Record<FunctionClass, FailureShape>> = {
    containment: 'binary',
    protection: 'protective',
    support: 'binary',
};

function toRow(f: CardFunction, delivers: string, passThrough: boolean): CardRow | null {
    const text = tidy(f.text).replace(/[.;,\s]+$/, '');
    if (!text) return null;
    // A primary function is judged against what this subsystem itself hands on:
    // its Delivers line. Its own wording can name a variable another subsystem
    // produces ("maintain air pressure and quality" on a controller whose output
    // is commands), and every failure written against that variable duplicates
    // the producer's. A pass-through subsystem (see cleanCards) produces none of
    // its Delivers values, so they are no standard of its own.
    if (f.cls === 'primary' && passThrough) {
        return { function: text.charAt(0).toUpperCase() + text.slice(1), standard: 'required', functionClass: f.cls, quantified: false, evidence: 'evident', failureShape: 'binary' };
    }
    const standard = f.cls === 'primary' && delivers ? delivers
        : /\d/.test(text) ? text
        : 'required';
    return {
        function: text.charAt(0).toUpperCase() + text.slice(1),
        standard,
        functionClass: f.cls,
        quantified: /\d/.test(standard),
        // A protective device is only called on demand; its failure is hidden
        // until the demand arrives (JA1011 5.2).
        evidence: f.cls === 'protection' ? 'hidden' : 'evident',
        // A primary duty with no stated amount cannot fall short of one: "less"
        // has no standard to be judged against (JA1011 5.1.2), so it is done or
        // not done.
        failureShape: SHAPE_BY_CLASS[f.cls] ?? (f.cls === 'primary' && !/\d/.test(standard) ? 'binary' : undefined),
    };
}

/**
 * The subsystems a knowledge file defines, cleaned and ready for MasterGen.
 * Fewer than two means the file is not in card layout; the caller falls back
 * to generating the structure.
 */
export function subsystemsFromKnowledge(text: string): CardSubsystem[] {
    const subs = cleanCards(parseKnowledgeCards(text)).map(cardToSubsystem).filter(s => s.name && s.func);
    return subs.length >= 2 ? subs : [];
}
