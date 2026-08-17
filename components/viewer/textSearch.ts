/**
 * Plain full-text search shared by every document canvas.
 *
 * Matching is case-insensitive and whitespace-insensitive: a query typed as
 * "annual report" finds "Annual   Report" and text broken across PDF text items
 * or inline HTML elements. Offsets are always returned in the ORIGINAL string,
 * so callers can highlight without re-mapping.
 *
 * Every entry point takes either one needle or a LIST of them: the find bar
 * searches for what was typed, while smart search searches for the several
 * phrases the model came back with. Matches from a list are merged into one
 * document-ordered sequence so the canvases and the match counter do not have
 * to know which phrase produced which hit.
 */

export const MIN_QUERY_LENGTH = 2;
/** Guard against a one-letter query lighting up a whole book. */
export const MAX_MATCHES = 500;

export interface Match {
    start: number;
    end: number;
}

interface Normalized {
    text: string;
    /** map[i] = index in the original string of normalized character i. */
    map: number[];
}

function normalize(input: string): Normalized {
    const text: string[] = [];
    const map: number[] = [];
    let pendingSpace = false;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (/\s/.test(char)) {
            pendingSpace = text.length > 0;
            continue;
        }
        if (pendingSpace) {
            text.push(' ');
            map.push(i);
            pendingSpace = false;
        }
        text.push(char.toLowerCase());
        map.push(i);
    }
    return { text: text.join(''), map };
}

/** Query in the same normalized form, or '' when it is too short to search. */
export function normalizeQuery(query: string): string {
    const norm = normalize(query).text;
    return norm.length >= MIN_QUERY_LENGTH ? norm : '';
}

/**
 * The searchable needles behind one or more queries: normalized, de-duplicated,
 * and with anything too short to search dropped. Longest first, so an overlap
 * between two phrases resolves in favour of the more specific one.
 */
export function normalizeTerms(query: string | string[]): string[] {
    const list = Array.isArray(query) ? query : [query];
    const seen = new Set<string>();
    for (const item of list) {
        const needle = normalizeQuery(item);
        if (needle) seen.add(needle);
    }
    return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * Every occurrence of `query` in `text`, as offsets into `text`. With several
 * needles the results are merged in document order and overlapping hits are
 * dropped, so each stretch of text is reported at most once.
 */
export function findMatches(text: string, query: string | string[], limit = MAX_MATCHES): Match[] {
    const needles = normalizeTerms(query);
    if (needles.length === 0 || !text) return [];

    const haystack = normalize(text);
    const found: Match[] = [];
    for (const needle of needles) {
        let from = 0;
        while (found.length < limit * needles.length) {
            const at = haystack.text.indexOf(needle, from);
            if (at === -1) break;
            found.push({
                start: haystack.map[at],
                end: haystack.map[at + needle.length - 1] + 1,
            });
            from = at + needle.length;
        }
    }
    if (needles.length === 1) return found.slice(0, limit);

    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Match[] = [];
    for (const match of found) {
        const previous = merged[merged.length - 1];
        if (previous && match.start < previous.end) continue;
        merged.push(match);
        if (merged.length >= limit) break;
    }
    return merged;
}

/** True when a single value (a spreadsheet cell, say) contains any needle. */
export function valueMatches(value: string, query: string | string[]): boolean {
    const needles = normalizeTerms(query);
    if (needles.length === 0) return false;
    const haystack = normalize(value).text;
    return needles.some(needle => haystack.includes(needle));
}
