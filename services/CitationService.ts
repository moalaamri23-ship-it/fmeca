/**
 * Citing one field against every document in its scope.
 *
 * A citation here is found AFTER the fact. The field already says what it says —
 * written by the AI, or typed by the engineer — and this asks each source in
 * scope which of its passages support that text. So what comes back is evidence,
 * not provenance: the passage supports the claim, it did not necessarily produce
 * it. The panel says "Evidence" for that reason, and a source that supports
 * nothing is reported as such rather than being made to produce something.
 *
 * The reading itself is `smartSearchDocument` with the field's text as the
 * intent: it already expands wording, windows a long document, and — the part
 * that matters most — VERIFIES every quote against the document's own text and
 * drops what it cannot find. A quote that survives that is a quote the viewer
 * can highlight, which is the whole promise of the citation panel.
 *
 * A scan or a drawing has no text to verify against. Its quotes are kept as the
 * model transcribed them, marked approximate, and given the page they were read
 * from when the model names one — a page is still somewhere to land.
 */

import { extractDocumentText } from './DocumentText';
import { buildDocumentPayload, payloadIsUsable } from './DocumentPayload';
import { smartSearchDocument } from './SmartSearchService';
import type { SmartSearchConfig } from './SmartSearchService';
import { toSourceRef } from './CitationCorpus';
import type { CiteSource } from './CitationCorpus';
import { categoryFor } from '../components/viewer/util';
import { lineAtOffset, locateText, pageAtOffset, snippetAround } from '../components/viewer/locate';
import type { LocalFileSystemProvider } from './FileSystem';
import type { FieldCitations, ViewerCitation } from '../types';

/** How much of a field's text is used as the search intent. */
const MAX_INTENT_CHARS = 1200;
/** Sources read at once. Enough to be quick, few enough not to trip rate limits. */
const CONCURRENCY = 3;
/** Passages kept per source, so one verbose document cannot fill the panel. */
const MAX_PER_SOURCE = 4;

/** A field's text is worth citing only once it says something. */
export const isCitable = (text: string): boolean => text.trim().length >= 12;

/**
 * Stable fingerprint of the text a citation set was found for. Cheap FNV-1a —
 * this only ever has to notice that the field changed.
 */
export function hashFieldText(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i++) {
        hash ^= normalized.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36) + ':' + normalized.length;
}

/** Whether stored citations still describe what the field says now. */
export const citationsAreStale = (stored: FieldCitations | undefined, text: string): boolean =>
    !!stored && stored.textHash !== hashFieldText(text);

/** The field's text as a search intent, labelled so the model knows what it is reading for. */
function buildIntent(fieldLabel: string, fieldText: string): string {
    const body = fieldText.replace(/\s+/g, ' ').trim().slice(0, MAX_INTENT_CHARS);
    return `${fieldLabel}: ${body}`;
}

/** "…on page 7…" in the model's reason — the only page an image-read quote has. */
function pageFromReason(why: string): number | undefined {
    const hit = /\bp(?:age|g)?\.?\s*(\d{1,4})\b/i.exec(why);
    if (!hit) return undefined;
    const page = Number(hit[1]);
    return Number.isFinite(page) && page > 0 ? page : undefined;
}

/** One source's text, read from disk or carried in the source itself. */
async function readSourceText(
    source: CiteSource,
    provider: LocalFileSystemProvider | null
): Promise<{ text: string; bytes: ArrayBuffer | null }> {
    if (source.text != null) return { text: source.text, bytes: null };
    if (!provider || !source.entry) return { text: '', bytes: null };
    const blob = await provider.readFile(source.entry);
    const bytes = await blob.arrayBuffer();
    const text = await extractDocumentText(categoryFor(source.fileName), bytes);
    return { text, bytes };
}

export interface CiteProgress {
    done: number;
    total: number;
    /** The source being read right now. */
    current: string;
}

export interface CiteFieldRequest {
    fieldLabel: string;
    fieldText: string;
    sources: CiteSource[];
    provider: LocalFileSystemProvider | null;
    ai: SmartSearchConfig;
    sendFiles: 'text' | 'all';
    onProgress?: (progress: CiteProgress) => void;
}

interface SourceResult {
    source: CiteSource;
    items: Omit<ViewerCitation, 'index'>[];
    /** The source was read and had nothing to say. */
    empty: boolean;
    /** The source could not be read at all. */
    error?: string;
}

/** Search one source and turn its verified quotes into citations. */
async function citeOneSource(
    source: CiteSource,
    req: CiteFieldRequest,
    intent: string
): Promise<SourceResult> {
    let text = '';
    let bytes: ArrayBuffer | null = null;
    try {
        ({ text, bytes } = await readSourceText(source, req.provider));
    } catch (e) {
        return { source, items: [], empty: true, error: e instanceof Error ? e.message : String(e) };
    }

    const category = categoryFor(source.fileName);
    const payload = bytes
        ? await buildDocumentPayload(source.fileName, category, bytes, text, {
              provider: req.ai.provider ?? '',
              mode: req.sendFiles,
          })
        : { text, images: [], textThin: false };

    if (!payloadIsUsable(payload)) {
        return {
            source,
            items: [],
            empty: true,
            error: text.trim() ? undefined : 'No readable text, and this file may not be sent whole.',
        };
    }

    const result = await smartSearchDocument(source.fileName, payload, intent, req.ai);

    // Expansion terms are search suggestions, not evidence — a document that
    // merely contains the word "bearing" has not supported anything.
    const hits = result.hits.filter(hit => !hit.fromTerm).slice(0, MAX_PER_SOURCE);

    const items = hits.map(hit => {
        const span = text ? locateText(text, hit.quote, source.id) : null;
        return {
            id: `cite-${source.id}-${hit.id}`,
            fileName: source.fileName,
            sourceId: source.id,
            anchor: hit.quote,
            quote: span ? text.slice(span.start, span.end) : hit.quote,
            snippet: span ? snippetAround(text, span.start, span.end) : undefined,
            page: span ? pageAtOffset(text, span.start) : pageFromReason(hit.why),
            line: span && categoryFor(source.fileName) !== 'pdf' ? lineAtOffset(text, span.start) : undefined,
            label: source.origin,
            why: hit.why,
            approximate: hit.fromImage || (span ? !span.exact : true),
        } satisfies Omit<ViewerCitation, 'index'>;
    });

    return { source, items, empty: items.length === 0 };
}

/** Run `worker` over `items`, `limit` at a time, keeping input order in the result. */
async function mapWithLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

export interface CiteFieldResult extends FieldCitations {
    /** Sources that could not be read, with why. Shown once, not stored. */
    failures: { fileName: string; message: string }[];
}

/**
 * Cite one field against every source in its scope.
 *
 * Throws only when there is nothing to work with. A source that fails on its own
 * is reported in `failures` and the rest of the run still produces its evidence.
 */
export async function citeField(req: CiteFieldRequest): Promise<CiteFieldResult> {
    const fieldText = req.fieldText.trim();
    if (!isCitable(fieldText)) throw new Error('There is not enough text in this field to cite.');
    if (req.sources.length === 0) {
        throw new Error(
            'Nothing to cite against. Load a knowledge or checklist file, or attach documents to this subsystem.'
        );
    }

    const intent = buildIntent(req.fieldLabel, fieldText);
    let done = 0;
    req.onProgress?.({ done: 0, total: req.sources.length, current: req.sources[0].fileName });

    const results = await mapWithLimit(req.sources, CONCURRENCY, async source => {
        try {
            return await citeOneSource(source, req, intent);
        } catch (e) {
            return {
                source,
                items: [],
                empty: true,
                error: e instanceof Error ? e.message : String(e),
            } satisfies SourceResult;
        } finally {
            done += 1;
            req.onProgress?.({ done, total: req.sources.length, current: source.fileName });
        }
    });

    // Numbered across the whole field, in source order, so the badge on a card
    // and the badge in the document are the same number.
    const items: ViewerCitation[] = [];
    for (const result of results) {
        for (const item of result.items) items.push({ ...item, index: items.length + 1 });
    }

    return {
        textHash: hashFieldText(fieldText),
        generatedAt: new Date().toISOString(),
        items,
        sources: req.sources.map(toSourceRef),
        emptySources: results.filter(r => r.empty && !r.error).map(r => r.source.fileName),
        failures: results
            .filter(r => r.error)
            .map(r => ({ fileName: r.source.fileName, message: r.error as string })),
    };
}
