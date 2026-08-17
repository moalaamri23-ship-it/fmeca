/**
 * What gets sent to a model about one open document.
 *
 * Extracted text alone is not the document. A photo of a nameplate has no text
 * at all; a scanned procedure has none either, and OCR of a drawing loses the
 * drawing. So a payload carries three channels, and each provider takes what it
 * can:
 *
 *   - `text`   — the extracted text, when the format yields any
 *   - `images` — the picture itself, or the PDF's pages rendered to images, for
 *                any provider with a vision channel
 *   - `file`   — the original bytes, for the one transport that opens real files
 *                (the Power Automate flow behind the Copilot provider)
 *
 * Mirrors FileLM's attachment policy: images ride inline over the OpenAI schema
 * everywhere, and only Copilot gets the file itself.
 */

import { pdfjsLib } from '../components/viewer/pdfjs';
import { fileExt } from '../components/viewer/util';
import type { FileCategory } from '../types';

/** Pages rendered for a text-less PDF. Enough to answer from, bounded in cost. */
const MAX_PAGE_IMAGES = 6;
/** Rendered page width, in pixels — legible to a vision model, not wasteful. */
const PAGE_IMAGE_WIDTH = 1400;
const PAGE_IMAGE_QUALITY = 0.8;
/** Below this many characters per page, a PDF is treated as scanned. */
const THIN_TEXT_PER_PAGE = 40;
/** Ceiling on the bytes handed to the Copilot file channel (~8 MB raw). */
const MAX_FILE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** A file the Copilot flow can open for itself. */
export interface FileAttachment {
    name: string;
    contentType: string;
    /** Base64, no data-URL prefix — what the flow's attachment input expects. */
    contentBytes: string;
}

export interface DocumentPayload {
    text: string;
    /** Data URLs, in page order. */
    images: string[];
    file?: FileAttachment;
    /** True when the text channel is too thin to answer from on its own. */
    textThin: boolean;
}

const IMAGE_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml',
};

// Only formats the Copilot agent can actually open. Anything else stays text.
const FILE_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt: 'application/vnd.ms-powerpoint',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
};

function toBase64(bytes: ArrayBuffer): string {
    const view = new Uint8Array(bytes);
    let binary = '';
    // Chunked: spreading a multi-megabyte array into apply() overflows the stack.
    const CHUNK = 0x8000;
    for (let i = 0; i < view.length; i += CHUNK) {
        binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** How many pages the extracted text claims to cover. */
function pageCountOf(text: string): number {
    return (text.match(/^--- Page \d+ ---$/gm) || []).length || 1;
}

/** True when the text is too sparse to be the document's real content. */
export function isTextThin(text: string): boolean {
    const body = text.replace(/^--- Page \d+ ---$/gm, '').replace(/\[no extractable text\]/g, '').trim();
    return body.length < THIN_TEXT_PER_PAGE * pageCountOf(text);
}

/** Render the first pages of a PDF to JPEG data URLs. */
async function pdfPageImages(bytes: ArrayBuffer, limit = MAX_PAGE_IMAGES): Promise<string[]> {
    // getDocument takes ownership of the buffer — hand it a copy.
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    try {
        const images: string[] = [];
        const pages = Math.min(doc.numPages, limit);
        for (let page = 1; page <= pages; page++) {
            const pdfPage = await doc.getPage(page);
            const base = pdfPage.getViewport({ scale: 1 });
            const viewport = pdfPage.getViewport({ scale: PAGE_IMAGE_WIDTH / base.width });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) break;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await pdfPage.render({ canvasContext: ctx, viewport, canvas }).promise;
            images.push(canvas.toDataURL('image/jpeg', PAGE_IMAGE_QUALITY));
        }
        return images;
    } finally {
        void doc.destroy();
    }
}

/**
 * Build the payload for one document. Never throws — a channel that cannot be
 * built is simply absent, and the caller decides what is still possible.
 *
 * Pages are rendered only when the text channel is thin: a digital PDF's text
 * answers better and costs a fraction as much.
 */
export async function buildDocumentPayload(
    name: string,
    category: FileCategory,
    bytes: ArrayBuffer,
    text: string,
    options: { provider: string }
): Promise<DocumentPayload> {
    const ext = fileExt(name);
    const thin = isTextThin(text);
    const payload: DocumentPayload = { text, images: [], textThin: thin };

    try {
        if (category === 'image') {
            const mime = IMAGE_MIME[ext] || 'image/png';
            payload.images = [`data:${mime};base64,${toBase64(bytes)}`];
        } else if (category === 'pdf' && thin) {
            payload.images = await pdfPageImages(bytes);
        }
    } catch (e) {
        console.warn('[DocumentPayload] image channel unavailable', e);
    }

    // Only Copilot's flow can open a real file, and only up to its request size.
    if (options.provider === 'copilot' && ext in FILE_MIME && bytes.byteLength <= MAX_FILE_ATTACHMENT_BYTES) {
        try {
            payload.file = { name, contentType: FILE_MIME[ext], contentBytes: toBase64(bytes) };
        } catch (e) {
            console.warn('[DocumentPayload] file channel unavailable', e);
        }
    }

    return payload;
}

/** Whether a model could say anything at all about this document. */
export function payloadIsUsable(payload: DocumentPayload | null): boolean {
    if (!payload) return false;
    return payload.text.trim().length > 0 || payload.images.length > 0 || !!payload.file;
}
