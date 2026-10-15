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
    limits: string[];
}

export interface CardSubsystem {
    name: string;
    specs: string;
    func: string;
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
function formatLimit(row: string): string {
    const cols = row.replace(SOURCE_REF, '').split('|').map(c => c.trim());
    if (cols.length < 8) return '';
    const unit = isNotStated(cols[7]) ? '' : ` ${cols[7]}`;
    const values = LIMIT_COLUMNS
        .map((label, i) => [label, cols[2 + i]] as const)
        .filter(([, v]) => v && !isNotStated(v) && /\d/.test(v))
        .map(([label, v]) => `${label} ${v}${unit}`);
    return values.length ? `${cols[0]}: ${values.join(', ')}` : '';
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
            current = { name: header[1].trim(), functions: [], specs: [], delivers: [], limits: [] };
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
        const limit = line.match(/^Limits\s*:\s*(.+)$/i);
        if (limit) { const l = formatLimit(limit[1]); if (l) current.limits.push(l); }
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

export function cleanCards(cards: KnowledgeCard[]): KnowledgeCard[] {
    return cards
        .filter(c => !STRUCTURE_NAME.test(c.name))
        .map(c => ({ ...c, functions: c.functions.filter(keepFunction) }))
        .filter(c => c.functions.length > 0);
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
    const specs = [...card.specs, ...card.limits]
        .map(s => tidy(s).replace(/[.;\s]+$/, ''))
        .filter(s => s && !isNotStated(s))
        .join('; ');
    return { name: card.name.replace(TAG, '').replace(/\s{2,}/g, ' ').trim(), specs, func };
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
