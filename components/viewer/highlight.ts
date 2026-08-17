import { locateText } from './locate';
import { findMatches } from './textSearch';

const MARK_ATTR = 'data-fmeca-cite';
const HIT_ATTR = 'data-fmeca-hit';

// Highlight colours are inline styles rather than utility classes: a rule
// assembled in a template literal is never emitted by a class scanner, and a
// blend mode over an accelerated canvas layer renders as nothing at all in
// Safari. Plain alpha keeps the glyphs legible, which is all a blend bought.
export const MARK_STYLE = 'background:rgba(253,224,71,0.55);outline:1px solid rgba(234,179,8,0.6);border-radius:2px';
export const HIT_STYLE = 'background:rgba(253,186,116,0.45);border-radius:2px';
export const HIT_ACTIVE_STYLE = 'background:rgba(251,146,60,0.65);outline:1px solid rgb(234,88,12);border-radius:2px';

/** Remove marks of one kind, restoring the original DOM text. */
export function clearHighlights(root: HTMLElement, attr: string = MARK_ATTR): void {
    for (const mark of Array.from(root.querySelectorAll(`mark[${attr}]`))) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
    }
}

interface TextNodeEntry {
    node: Text;
    start: number;
    end: number;
}

/**
 * Marks text the viewer itself added around the document (page captions and
 * such). It is not part of the file, so it must never be searched or cited.
 */
export const CHROME_ATTR = 'data-viewer-chrome';

/** Every text node under `root`, plus the concatenated text they form. */
function collectTextNodes(root: HTMLElement): { text: string; nodes: TextNodeEntry[] } {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: TextNodeEntry[] = [];
    let text = '';
    let current = walker.nextNode();
    while (current) {
        const node = current as Text;
        const value = node.nodeValue ?? '';
        if (value.length > 0 && !node.parentElement?.closest(`[${CHROME_ATTR}]`)) {
            nodes.push({ node, start: text.length, end: text.length + value.length });
            text += value;
        }
        current = walker.nextNode();
    }
    return { text, nodes };
}

/**
 * Wrap [start, end) of the concatenated text in <mark> elements — one per text
 * node the span crosses. Nodes are processed back to front so splitting a later
 * one cannot invalidate the offsets of an earlier one.
 */
function wrapSpan(
    nodes: TextNodeEntry[],
    start: number,
    end: number,
    attr: string,
    style: string
): HTMLElement[] {
    const marks: HTMLElement[] = [];
    for (let i = nodes.length - 1; i >= 0; i--) {
        const entry = nodes[i];
        if (entry.end <= start || entry.start >= end) continue;
        const localStart = Math.max(start, entry.start) - entry.start;
        const localEnd = Math.min(end, entry.end) - entry.start;

        let target = entry.node;
        if (localStart > 0) target = target.splitText(localStart);
        if (localEnd - localStart < (target.nodeValue?.length ?? 0)) target.splitText(localEnd - localStart);

        const parent = target.parentNode;
        if (!parent) continue;
        const mark = document.createElement('mark');
        mark.setAttribute(attr, '1');
        // color:inherit — <mark>'s own colours would fight the document's.
        mark.setAttribute('style', `color:inherit;${style}`);
        parent.replaceChild(mark, target);
        mark.appendChild(target);
        marks.push(mark);
    }
    // Back into document order.
    return marks.reverse();
}

/**
 * Wrap the first occurrence of `needle` inside `root` in <mark> elements,
 * spanning element boundaries when the phrase is split across inline nodes.
 * Returns the first mark so the caller can scroll it into view.
 */
export function highlightInElement(root: HTMLElement, needle: string): HTMLElement | null {
    clearHighlights(root);
    if (!needle.trim()) return null;

    const { text, nodes } = collectTextNodes(root);
    const span = locateText(text, needle);
    if (!span) return null;

    const marks = wrapSpan(nodes, span.start, span.end, MARK_ATTR, MARK_STYLE);
    return marks.length > 0 ? marks[0] : null;
}

/**
 * Mark EVERY occurrence of the search terms, returning the marks of each match
 * in document order (a single match may span several nodes). Uses its own mark
 * attribute so citation highlighting and searching do not clear each other.
 */
export function markSearchMatches(root: HTMLElement, query: string | string[]): HTMLElement[][] {
    clearHighlights(root, HIT_ATTR);
    const needles = (Array.isArray(query) ? query : [query]).filter(term => term.trim());
    if (needles.length === 0) return [];

    const { text, nodes } = collectTextNodes(root);
    const matches = findMatches(text, needles);
    const perMatch: HTMLElement[][] = matches.map(() => []);
    // Last match first: an earlier match's offsets survive later splits.
    for (let i = matches.length - 1; i >= 0; i--) {
        perMatch[i] = wrapSpan(nodes, matches[i].start, matches[i].end, HIT_ATTR, HIT_STYLE);
    }
    return perMatch.filter(marks => marks.length > 0);
}

/** Restyle already-placed search marks, so only the current match stands out. */
export function styleSearchMark(mark: HTMLElement, active: boolean): void {
    mark.setAttribute('style', `color:inherit;${active ? HIT_ACTIVE_STYLE : HIT_STYLE}`);
}
