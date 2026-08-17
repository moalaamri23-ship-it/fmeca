/**
 * Locating a cited passage inside a document's extracted text.
 *
 * A citation is written by a person or a model against the text they were shown,
 * which is a flattened projection of the file: line breaks collapsed, smart
 * quotes and dashes rewritten. So matching happens on a normalized projection of
 * the document with an index map back to the ORIGINAL offsets, and those offsets
 * are what the canvases highlight.
 */

interface Normalized {
    norm: string;
    /** norm index → original index */
    map: number[];
}

function foldChar(ch: string): string {
    if (ch === '‘' || ch === '’') return "'";
    if (ch === '“' || ch === '”') return '"';
    // Separators routinely rewritten as a plain hyphen when a document is
    // quoted back: en/em dash, minus, non-breaking hyphen, middot, bullet.
    if (ch === '–' || ch === '—' || ch === '−' || ch === '‑' || ch === '·' || ch === '•') return '-';
    if (ch === ' ') return ' ';
    return ch.toLowerCase();
}

function normalize(text: string): Normalized {
    const chars: string[] = [];
    const map: number[] = [];
    let prevSpace = true;
    for (let i = 0; i < text.length; i++) {
        const folded = foldChar(text[i]);
        if (/\s/.test(folded)) {
            if (prevSpace) continue;
            chars.push(' ');
            map.push(i);
            prevSpace = true;
            continue;
        }
        prevSpace = false;
        chars.push(folded);
        map.push(i);
    }
    return { norm: chars.join(''), map };
}

// Normalizing a large document is cheap but not free — cache per document text.
const normCache = new Map<string, Normalized>();

function normalizedContent(key: string, text: string): Normalized {
    const cacheKey = `${key}:${text.length}`;
    let cached = normCache.get(cacheKey);
    if (!cached) {
        cached = normalize(text);
        // Keep the cache small — a viewer only ever looks at a few documents.
        if (normCache.size > 24) normCache.clear();
        normCache.set(cacheKey, cached);
    }
    return cached;
}

export interface TextSpan {
    start: number;
    end: number;
    exact: boolean;
}

/**
 * Locate `needle` inside `text`, tolerating whitespace, case, quote-style and
 * dash differences. Falls back to the needle's leading words so a slightly
 * over-long anchor still lands on the right paragraph.
 */
export function locateText(text: string, needle: string, cacheKey = ''): TextSpan | null {
    const probe = needle.trim();
    if (!text || probe.length < 3) return null;

    const direct = text.indexOf(probe);
    if (direct >= 0) return { start: direct, end: direct + probe.length, exact: true };

    const haystack = cacheKey ? normalizedContent(cacheKey, text) : normalize(text);
    const target = normalize(probe).norm;
    if (!target) return null;

    const hit = haystack.norm.indexOf(target);
    if (hit >= 0) {
        return {
            start: haystack.map[hit],
            end: haystack.map[Math.min(hit + target.length - 1, haystack.map.length - 1)] + 1,
            exact: true,
        };
    }

    // Progressive fallback: shrink the anchor from one end until what remains
    // matches. Trailing words go first, since an anchor most often runs past the
    // document's wording — but leading ones are trimmed too, because a quote that
    // starts one word early would otherwise miss the passage entirely.
    const words = target.split(' ').filter(Boolean);
    const spanFrom = (at: number, length: number): TextSpan => ({
        start: haystack.map[at],
        end: haystack.map[Math.min(at + length - 1, haystack.map.length - 1)] + 1,
        exact: false,
    });

    // What remains has to stay specific enough to trust, and 12 characters is
    // that test — a word count is a cruder proxy and rejects real anchors:
    // "Overall Condition: Unacceptable" is three words and unmistakable.
    const MIN_WORDS = 2;
    for (let take = words.length - 1; take >= MIN_WORDS; take--) {
        const prefix = words.slice(0, take).join(' ');
        if (prefix.length < 12) break;
        const at = haystack.norm.indexOf(prefix);
        if (at >= 0) return spanFrom(at, prefix.length);
    }
    for (let drop = 1; words.length - drop >= MIN_WORDS; drop++) {
        const suffix = words.slice(drop).join(' ');
        if (suffix.length < 12) break;
        const at = haystack.norm.indexOf(suffix);
        if (at >= 0) return spanFrom(at, suffix.length);
    }
    return null;
}

const PAGE_MARKER_RE = /^--- Page (\d+) ---$/gm;

/** Character offsets of each `--- Page N ---` marker in extracted PDF text. */
function pageBreaks(content: string): { page: number; offset: number }[] {
    const breaks: { page: number; offset: number }[] = [];
    PAGE_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PAGE_MARKER_RE.exec(content)) !== null) {
        breaks.push({ page: Number(m[1]), offset: m.index });
    }
    return breaks;
}

/** 1-based page containing `offset`, or undefined when the text has no pages. */
export function pageAtOffset(content: string, offset: number): number | undefined {
    const breaks = pageBreaks(content);
    if (breaks.length === 0) return undefined;
    let page: number | undefined;
    for (const b of breaks) {
        if (b.offset > offset) break;
        page = b.page;
    }
    return page ?? breaks[0].page;
}

/** 1-based line number containing `offset`. */
export function lineAtOffset(content: string, offset: number): number {
    let line = 1;
    const stop = Math.min(offset, content.length);
    for (let i = 0; i < stop; i++) if (content[i] === '\n') line++;
    return line;
}

/** Readable context around a span, for the reference list. */
export function snippetAround(content: string, start: number, end: number, pad = 160): string {
    const from = Math.max(0, start - pad);
    const to = Math.min(content.length, end + pad);
    const lead = from > 0 ? '…' : '';
    const tail = to < content.length ? '…' : '';
    return (lead + content.slice(from, to) + tail)
        .replace(/[ \t]*\n[ \t]*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

const PAGE_ANCHOR_RE = /^(?:pp?\.?|pages?)\s*(\d{1,4})\b(?:\s*[-–—]\s*\d{1,4})?$/i;

/**
 * The page an anchor NAMES, for anchors that are a page reference rather than a
 * quotation ("page 4", "pp. 12-14"). Such an anchor points at the page, not at
 * the words "page 4" — searching for those would highlight the wrong thing.
 */
export function pageAnchor(anchor: string): number | undefined {
    const match = PAGE_ANCHOR_RE.exec(anchor.trim());
    if (!match) return undefined;
    const page = Number(match[1]);
    return Number.isFinite(page) && page > 0 ? page : undefined;
}
