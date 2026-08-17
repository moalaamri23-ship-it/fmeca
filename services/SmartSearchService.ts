/**
 * Smart search: turn what the reader MEANT into passages that are actually in
 * the open document.
 *
 * The plain find bar can only report literal hits, so a query like "vibration
 * criteria" finds nothing in a document that says "vibration alarm limits".
 * This runs two cheap model calls around the document text:
 *
 *   1. expand the intent into the wording such a document would really use,
 *   2. hand the model the excerpts those terms point at and ask which passages
 *      answer the intent, quoted verbatim.
 *
 * Every quote is then VERIFIED against the document text before it reaches the
 * UI — anything the model paraphrased or invented is dropped, so a smart result
 * is always something the viewer can highlight.
 */

import { AIService } from './AIService';
import type { AIMessage, AIRequestPayload } from './AIService';
import { findMatches, normalizeQuery } from '../components/viewer/textSearch';
import type { DocumentPayload } from './DocumentPayload';

/** Excerpt window size, in characters — a few paragraphs of context. */
const WINDOW_CHARS = 1600;
/** Windows overlap so a passage on a boundary is whole in at least one of them. */
const WINDOW_OVERLAP = 400;
/** How many windows get sent for reading. */
const MAX_WINDOWS = 8;
/** Ceiling on the excerpt payload, so a book costs the same as a memo. */
const MAX_EXCERPT_CHARS = 14000;
/** Documents shorter than this are sent whole — no point pre-filtering. */
const WHOLE_DOC_CHARS = 12000;
/** Results shown in the panel. */
export const MAX_SMART_RESULTS = 12;

export interface SmartHit {
    id: string;
    /** Verbatim text from the document — what the canvases highlight. */
    quote: string;
    /** Why this passage answers the intent, in the model's words. */
    why: string;
    /** How many times the quote occurs in the document. */
    count: number;
    /** A term the expansion produced, rather than a passage the model chose. */
    fromTerm?: boolean;
    /**
     * Read off the picture rather than out of extracted text, so it could not be
     * verified and may not highlight. Shown as such in the panel.
     */
    fromImage?: boolean;
}

/** What smart search needs to reach a model — the app's live AI settings. */
export interface SmartSearchConfig {
    apiKey: string;
    model: string;
    provider: AIRequestPayload['provider'];
    azureEndpoint?: string;
    powerAutomateUrl?: string;
}

const EXPAND_PROMPT = `You expand a reader's search intent into the wording a real document would use.
Given a search intent, list the phrases that would appear in a technical or engineering document meaning the SAME thing — synonyms, standard terminology, near-equivalent headings, and common abbreviations.
Keep each phrase 1-4 words and searchable (no sentences, no explanations).
Return ONLY JSON: {"terms":["...","..."]}`;

const READ_PROMPT = `You find passages in a document that answer a reader's search intent, including passages that never use the reader's words.
You are given numbered excerpts from ONE document.
Select the passages that satisfy the intent, most relevant first.

Rules:
- "quote" MUST be copied character-for-character from an excerpt. Never paraphrase, never join text from two places, never add words.
- Quote 3-25 words: enough to be unique in the document, short enough to be one idea.
- "why" is one short clause saying how it answers the intent.
- If nothing in the excerpts answers the intent, return an empty list.

Return ONLY JSON: {"results":[{"quote":"...","why":"..."}]}`;

/**
 * Reading a document that has no usable text: the pages themselves are attached
 * as images (or, for Copilot, the file itself). Quotes cannot be verified against
 * extracted text here, so the prompt insists on transcription rather than
 * paraphrase — that is the only thing that gives a quote a chance of matching
 * once the reader searches for it.
 */
const READ_IMAGE_PROMPT = `You find passages in a document that answer a reader's search intent.
The document is attached as page images (and possibly as the original file). It has no machine-readable text, so READ the pages.
Select the passages that satisfy the intent, most relevant first.

Rules:
- "quote" MUST be TRANSCRIBED exactly as the words appear on the page — same words, same order, same spelling, same numbers and units. Never paraphrase and never summarize.
- Quote 3-25 words: enough to be unique, short enough to be one idea.
- "why" is one short clause saying how it answers the intent, and names the page number when you can see it.
- If nothing on the pages answers the intent, return an empty list.

Return ONLY JSON: {"results":[{"quote":"...","why":"..."}]}`;

/** The first JSON object in a model reply, fences and prose included. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
    const text = (raw || '').replace(/^\s*```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function jsonList(raw: string, key: string): unknown[] {
    const value = extractJsonObject(raw)?.[key];
    return Array.isArray(value) ? value : [];
}

/** One text-only call. */
async function ask(config: SmartSearchConfig, system: string, user: string): Promise<string> {
    return AIService.chat({
        feature: 'document-smart-search',
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        azureEndpoint: config.azureEndpoint,
        powerAutomateUrl: config.powerAutomateUrl,
        mode: 'ai',
        responseFormat: 'json',
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    });
}

/** One call that carries the document itself — pages as images, or the file. */
async function askWithPayload(
    config: SmartSearchConfig,
    system: string,
    user: string,
    payload: DocumentPayload
): Promise<string> {
    const content: Exclude<AIMessage['content'], string> = [
        { type: 'text', text: user },
        ...payload.images.map(url => ({ type: 'image_url', image_url: { url } })),
    ];
    return AIService.chatMultimodal({
        feature: 'document-smart-search',
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        azureEndpoint: config.azureEndpoint,
        powerAutomateUrl: config.powerAutomateUrl,
        mode: 'ai',
        responseFormat: 'json',
        attachments: payload.file ? [payload.file] : undefined,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content },
        ],
    });
}

/** Split text into overlapping windows, each stamped with where it starts. */
export function buildWindows(text: string): { start: number; text: string }[] {
    const windows: { start: number; text: string }[] = [];
    const stride = WINDOW_CHARS - WINDOW_OVERLAP;
    for (let start = 0; start < text.length; start += stride) {
        windows.push({ start, text: text.slice(start, start + WINDOW_CHARS) });
        if (start + WINDOW_CHARS >= text.length) break;
    }
    return windows;
}

/**
 * The windows most worth reading: scored by how many of the expanded terms
 * occur in them, keeping document order among the winners. Windows that match
 * nothing still fill the quota, so a document whose wording shares no words
 * with the intent is read from the top rather than not at all.
 */
export function pickExcerpts(text: string, terms: string[]): { start: number; text: string }[] {
    const windows = buildWindows(text);
    if (windows.length <= MAX_WINDOWS) return windows;

    const scored = windows.map((window, index) => ({
        window,
        index,
        score: terms.reduce((total, term) => total + findMatches(window.text, term, 20).length, 0),
    }));
    const hits = scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
    const chosen = hits.slice(0, MAX_WINDOWS);
    for (const entry of scored) {
        if (chosen.length >= MAX_WINDOWS) break;
        if (!chosen.includes(entry)) chosen.push(entry);
    }
    return chosen.sort((a, b) => a.index - b.index).map(entry => entry.window);
}

function excerptPayload(text: string, terms: string[]): string {
    if (text.length <= WHOLE_DOC_CHARS) return `[1]\n${text}`;
    const parts: string[] = [];
    let budget = MAX_EXCERPT_CHARS;
    for (const [index, window] of pickExcerpts(text, terms).entries()) {
        if (budget <= 0) break;
        const body = window.text.slice(0, budget);
        budget -= body.length;
        parts.push(`[${index + 1}]\n${body}`);
    }
    return parts.join('\n\n---\n\n');
}

/** Expand the intent into document wording. Falls back to the intent itself. */
export async function expandIntent(intent: string, config: SmartSearchConfig): Promise<string[]> {
    const terms = new Set<string>([intent.trim()]);
    try {
        const reply = await ask(config, EXPAND_PROMPT, `Search intent: ${intent}`);
        for (const term of jsonList(reply, 'terms')) {
            const value = String(term).trim();
            if (value && value.length <= 60) terms.add(value);
        }
    } catch {
        // An expansion failure is not fatal — the intent's own words still search.
    }
    return [...terms].slice(0, 24);
}

/**
 * Keep only the quotes that really occur in the document, de-duplicated and
 * counted. A model that paraphrased produces a result the viewer could never
 * highlight, so it is dropped rather than shown as a dead link.
 */
export function verifyQuotes(
    text: string,
    candidates: { quote: string; why: string; fromTerm?: boolean }[]
): SmartHit[] {
    const hits: SmartHit[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const quote = candidate.quote.trim();
        const key = normalizeQuery(quote);
        if (!key || seen.has(key)) continue;
        const count = findMatches(text, quote).length;
        if (count === 0) continue;
        seen.add(key);
        hits.push({
            id: `smart-${hits.length}-${key.slice(0, 40)}`,
            quote,
            why: candidate.why.trim(),
            count,
            fromTerm: candidate.fromTerm,
        });
        if (hits.length >= MAX_SMART_RESULTS) break;
    }
    return hits;
}

/**
 * Results read off the pages, where there is no extracted text to verify them
 * against. They are kept as the model transcribed them and marked `fromImage`,
 * because an unverifiable answer is still an answer — it just cannot promise a
 * highlight. A transcription that happens to match the rendered text layer will
 * highlight anyway, since the canvases search for the quote like any other term.
 */
function collectImageQuotes(candidates: { quote: string; why: string }[]): SmartHit[] {
    const hits: SmartHit[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const quote = candidate.quote.trim();
        const key = normalizeQuery(quote);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hits.push({
            id: `smart-img-${hits.length}-${key.slice(0, 40)}`,
            quote,
            why: candidate.why.trim(),
            count: 0,
            fromImage: true,
        });
        if (hits.length >= MAX_SMART_RESULTS) break;
    }
    return hits;
}

export interface SmartSearchResult {
    hits: SmartHit[];
    /** Every phrase the expansion produced, whether or not it occurs. */
    terms: string[];
}

/**
 * Run a smart search over one document.
 *
 * Which channel is read depends on what the document actually has. A digital
 * PDF, a Word file or a spreadsheet is read as text. A photo, a scan or a
 * drawing has none, so its pages ride as images (and, on Copilot, the file
 * itself) and the model reads them — an attachment is not always text.
 *
 * Throws only when the reading call itself fails; an empty `hits` list means the
 * model found nothing.
 */
export async function smartSearchDocument(
    documentName: string,
    payload: DocumentPayload,
    intent: string,
    config: SmartSearchConfig
): Promise<SmartSearchResult> {
    const trimmedIntent = intent.trim();
    const text = payload.text;
    const hasText = text.trim().length > 0 && !payload.textThin;
    const carriesDocument = payload.images.length > 0 || !!payload.file;
    if (!trimmedIntent || (!hasText && !carriesDocument)) return { hits: [], terms: [] };

    const terms = await expandIntent(trimmedIntent, config);

    // Nothing readable as text — send the document and have the model read it.
    if (!hasText) {
        const reply = await askWithPayload(
            config,
            READ_IMAGE_PROMPT,
            [
                `Document: ${documentName}`,
                `Search intent: ${trimmedIntent}`,
                `Related wording to watch for: ${terms.join(', ')}`,
                payload.images.length > 0
                    ? `${payload.images.length} page image${payload.images.length === 1 ? '' : 's'} attached, in page order.`
                    : 'The original file is attached.',
                text.trim() ? `\nWhat little text could be extracted:\n${text.slice(0, 4000)}` : '',
            ]
                .filter(Boolean)
                .join('\n'),
            payload
        );
        const candidates = jsonList(reply, 'results')
            .map(entry => {
                const row = entry as { quote?: unknown; why?: unknown };
                return { quote: String(row?.quote ?? ''), why: String(row?.why ?? '') };
            })
            .filter(row => row.quote.trim().length > 0);
        return { hits: collectImageQuotes(candidates), terms };
    }

    const excerpts = excerptPayload(text, terms);

    const reply = await ask(
        config,
        READ_PROMPT,
        [
            `Document: ${documentName}`,
            `Search intent: ${trimmedIntent}`,
            `Related wording to watch for: ${terms.join(', ')}`,
            '',
            'Excerpts:',
            excerpts,
        ].join('\n')
    );

    const candidates = jsonList(reply, 'results')
        .map(entry => {
            const row = entry as { quote?: unknown; why?: unknown };
            return { quote: String(row?.quote ?? ''), why: String(row?.why ?? '') };
        })
        .filter(row => row.quote.trim().length > 0);

    // The expanded terms that literally occur are worth showing too: they are the
    // hits the plain find bar would have found if the reader had guessed the
    // document's wording, and they fill the panel when the model returns little.
    const termCandidates = terms
        .filter(term => term.toLowerCase() !== trimmedIntent.toLowerCase())
        .map(term => ({ quote: term, why: 'related wording in this document', fromTerm: true }));

    return { hits: verifyQuotes(text, [...candidates, ...termCandidates]), terms };
}
