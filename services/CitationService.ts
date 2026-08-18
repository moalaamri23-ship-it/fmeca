/**
 * Citing one field against every document in its scope.
 *
 * A citation here is found AFTER the fact. The field already says what it says —
 * written by the AI, or typed by the engineer — and this asks each source in
 * scope which of its passages support that text. So what comes back is evidence,
 * not provenance: the passage supports the claim, it did not necessarily produce
 * it.
 *
 * Evidence is judged per CLAIM, not per field. A Current Controls list of five
 * lines is five separate questions, and the answer worth having is which of the
 * five nothing supports — a control no source carries is one the generator
 * invented, and the detection score was rated against it. Splitting lives in
 * `FieldClaims`; what evidence MEANS for each field lives in `CitationPrompts`.
 *
 * One model call per source carries every claim at once. Per claim per source
 * would be twenty calls for a five-line list against four documents, for no
 * better answer.
 *
 * Every quote is verified against the document's own text before it reaches the
 * UI, so a quote that survives is a quote the viewer can highlight. A scan has
 * no text to verify against: its quotes are kept as transcribed, marked
 * approximate, and given the page the model read them from.
 */

import { extractDocumentText } from './DocumentText';
import { buildDocumentPayload, payloadIsUsable } from './DocumentPayload';
import { askDocument, excerptPayloadFor, expandIntent } from './SmartSearchService';
import { newConversationId } from './CopilotQueue';
import type { SmartSearchConfig } from './SmartSearchService';
import { toSourceRef } from './CitationCorpus';
import type { CiteSource } from './CitationCorpus';
import { buildClaims } from './FieldClaims';
import type { CitableField } from './FieldClaims';
import { citationLabel, isDuplicateCheck, maxPerClaimPerSource, readPromptFor } from './CitationPrompts';
import { categoryFor } from '../components/viewer/util';
import { lineAtOffset, locateText, pageAtOffset, snippetAround } from '../components/viewer/locate';
import { findMatches, normalizeQuery } from '../components/viewer/textSearch';
import type { LocalFileSystemProvider } from './FileSystem';
import type { FieldCitations, FieldClaim, ViewerCitation } from '../types';

/** Sources read at once. Quick enough to watch, gentle enough on rate limits. */
const CONCURRENCY = 3;
/** Claims sent in one call. A field longer than this is being used as a notepad. */
const MAX_CLAIMS = 12;

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
    field: CitableField;
    fieldLabel: string;
    fieldText: string;
    sources: CiteSource[];
    provider: LocalFileSystemProvider | null;
    ai: SmartSearchConfig;
    sendFiles: 'text' | 'all';
    onProgress?: (progress: CiteProgress) => void;
}

/** One passage the model returned, before it is verified. */
interface RawHit {
    claim: number;
    quote: string;
    why: string;
}

interface SourceResult {
    source: CiteSource;
    items: Omit<ViewerCitation, 'index'>[];
    /** Claims this source reported as already covered by the PM program. */
    duplicateClaims: string[];
    empty: boolean;
    error?: string;
}

/** The model's reply, as claim-tagged passages. */
function parseHits(reply: string, claimCount: number): RawHit[] {
    const text = (reply || '').replace(/^\s*```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    let parsed: any;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        return [];
    }
    if (!Array.isArray(parsed?.results)) return [];
    return parsed.results
        .map((row: any) => ({
            claim: Number(row?.claim),
            quote: String(row?.quote ?? ''),
            why: String(row?.why ?? ''),
        }))
        .filter((hit: RawHit) => hit.quote.trim() && hit.claim >= 1 && hit.claim <= claimCount);
}

/** The claim list as the model sees it. */
const claimBlock = (claims: FieldClaim[]): string =>
    claims.map(claim => `[${claim.index}] ${claim.text}`).join('\n');

/** Search one source for every claim at once. */
async function citeOneSource(
    source: CiteSource,
    claims: FieldClaim[],
    req: CiteFieldRequest,
    terms: string[]
): Promise<SourceResult> {
    let text = '';
    let bytes: ArrayBuffer | null = null;
    try {
        ({ text, bytes } = await readSourceText(source, req.provider));
    } catch (e) {
        return {
            source, items: [], duplicateClaims: [], empty: true,
            error: e instanceof Error ? e.message : String(e),
        };
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
            source, items: [], duplicateClaims: [], empty: true,
            error: text.trim() ? undefined : 'No readable text, and this file may not be sent whole.',
        };
    }

    const reply = await askDocument(
        req.ai,
        readPromptFor(req.field, source.kind),
        [
            `Document: ${source.fileName}`,
            `Field being cited: ${req.fieldLabel}`,
            '',
            'Claims:',
            claimBlock(claims),
            '',
            `Related wording to watch for: ${terms.join(', ')}`,
            '',
            'Excerpts:',
            excerptPayloadFor(payload.text, terms),
        ].join('\n'),
        payload
    );

    const duplicateCheck = isDuplicateCheck(req.field, source.kind);
    const perClaimCap = maxPerClaimPerSource(req.field);
    const label = citationLabel(req.field, source.kind, source.origin);

    const kept = new Map<number, number>();
    const seen = new Set<string>();
    const items: Omit<ViewerCitation, 'index'>[] = [];
    const duplicateClaims = new Set<string>();

    for (const hit of parseHits(reply, claims.length)) {
        const claim = claims[hit.claim - 1];
        if (!claim) continue;
        if ((kept.get(hit.claim) ?? 0) >= perClaimCap) continue;

        const quote = hit.quote.trim();
        const key = `${hit.claim}:${normalizeQuery(quote)}`;
        if (seen.has(key)) continue;

        // A quote the document does not contain is one the viewer could never
        // highlight, so it is dropped rather than shown as a dead link. Only a
        // document with no text at all is taken on trust.
        const verifiable = text.trim().length > 0;
        if (verifiable && findMatches(text, quote).length === 0) continue;
        seen.add(key);
        kept.set(hit.claim, (kept.get(hit.claim) ?? 0) + 1);
        if (duplicateCheck) duplicateClaims.add(claim.id);

        const span = verifiable ? locateText(text, quote, source.id) : null;
        items.push({
            id: `cite-${source.id}-${claim.id}-${items.length}`,
            fileName: source.fileName,
            sourceId: source.id,
            claimId: claim.id,
            anchor: quote,
            quote: span ? text.slice(span.start, span.end) : quote,
            snippet: span ? snippetAround(text, span.start, span.end) : undefined,
            page: span ? pageAtOffset(text, span.start) : pageFromReason(hit.why),
            line: span && category !== 'pdf' ? lineAtOffset(text, span.start) : undefined,
            label,
            why: hit.why.trim(),
            warning: duplicateCheck || undefined,
            approximate: !verifiable || (span ? !span.exact : true),
        });
    }

    return {
        source,
        items,
        duplicateClaims: [...duplicateClaims],
        empty: items.length === 0,
    };
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

    const claims = buildClaims(req.field, fieldText).slice(0, MAX_CLAIMS);
    if (claims.length === 0) throw new Error('There is nothing in this field to cite.');

    // This run gets a conversation of its own.
    //
    // Its questions are independent of everything else the app is asking, so it
    // has no use for the shared Copilot thread's history — and every reason not
    // to be stuck behind it. On its own conversation this run's calls queue only
    // against each other, which is what lets a second field be cited at the same
    // time. Providers other than Copilot ignore the field entirely.
    const ai: SmartSearchConfig = { ...req.ai, sessionId: req.ai.sessionId ?? newConversationId() };
    const scoped: CiteFieldRequest = { ...req, ai };

    // One expansion for the whole field, shared by every source: the claims are
    // about one subject, and expanding each of them separately buys nothing.
    const terms = await expandIntent(`${req.fieldLabel}: ${claims.map(c => c.text).join('; ')}`, ai);

    let done = 0;
    req.onProgress?.({ done: 0, total: req.sources.length, current: req.sources[0].fileName });

    const results = await mapWithLimit(req.sources, CONCURRENCY, async source => {
        try {
            return await citeOneSource(source, claims, scoped, terms);
        } catch (e) {
            return {
                source, items: [], duplicateClaims: [], empty: true,
                error: e instanceof Error ? e.message : String(e),
            } satisfies SourceResult;
        } finally {
            done += 1;
            req.onProgress?.({ done, total: req.sources.length, current: source.fileName });
        }
    });

    // Numbered across the whole field, claim by claim, so the badge on a card and
    // the badge in the document are the same number and the panel reads in order.
    const byClaim = new Map<string, Omit<ViewerCitation, 'index'>[]>();
    const duplicates = new Set<string>();
    for (const result of results) {
        for (const item of result.items) {
            const list = byClaim.get(item.claimId as string) ?? [];
            list.push(item);
            byClaim.set(item.claimId as string, list);
        }
        for (const claimId of result.duplicateClaims) duplicates.add(claimId);
    }

    const items: ViewerCitation[] = [];
    const resolved: FieldClaim[] = claims.map(claim => {
        const found = byClaim.get(claim.id) ?? [];
        for (const item of found) items.push({ ...item, index: items.length + 1 });
        return {
            ...claim,
            unsupported: found.length === 0,
            duplicateOfControl: duplicates.has(claim.id) || undefined,
        };
    });

    return {
        textHash: hashFieldText(fieldText),
        generatedAt: new Date().toISOString(),
        claims: resolved,
        items,
        sources: req.sources.map(toSourceRef),
        emptySources: results.filter(r => r.empty && !r.error).map(r => r.source.fileName),
        failures: results
            .filter(r => r.error)
            .map(r => ({ fileName: r.source.fileName, message: r.error as string })),
    };
}
