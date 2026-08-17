/**
 * Plain text extraction from a reference file's bytes.
 *
 * The renderers show the document as it looks; this is the same document as one
 * searchable string. It backs two things: smart search, which needs to read the
 * file to answer an intent, and the text fallback for formats with no renderer.
 *
 * PDF text carries `--- Page N ---` markers, which is what lets a character
 * offset be turned back into a page number (see `locate.pageAtOffset`).
 */

import * as XLSX from 'xlsx-js-style';
import { pdfjsLib } from '../components/viewer/pdfjs';
import type { FileCategory } from '../types';

/** Pages read from one PDF — enough for search, bounded for a huge manual. */
const MAX_PDF_PAGES = 400;
/** Rows read per sheet, matching what the sheet canvas renders. */
const MAX_SHEET_ROWS = 2000;

async function pdfText(bytes: ArrayBuffer): Promise<string> {
    // getDocument takes ownership of the buffer — hand it a copy so the cached
    // bytes stay usable for rendering.
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    try {
        const parts: string[] = [];
        const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
        for (let page = 1; page <= pages; page++) {
            const content = await (await doc.getPage(page)).getTextContent();
            const text = content.items
                .map(item => ('str' in item ? item.str : ''))
                .join(' ')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
            parts.push(`--- Page ${page} ---\n${text || '[no extractable text]'}`);
        }
        return parts.join('\n\n');
    } finally {
        void doc.destroy();
    }
}

async function docxText(bytes: ArrayBuffer): Promise<string> {
    // Loaded on demand: mammoth is only ever needed once a Word file is opened.
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.slice(0) });
    return result.value ?? '';
}

function sheetText(bytes: ArrayBuffer): string {
    const wb = XLSX.read(bytes.slice(0), { type: 'array', cellDates: true });
    return wb.SheetNames.map((name: string) => {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null });
        const body = rows
            .slice(0, MAX_SHEET_ROWS)
            .map(row => row.map(cell => (cell == null ? '' : String(cell))).join('\t'))
            .join('\n');
        return `=== Sheet: ${name} ===\n${body}`;
    }).join('\n\n');
}

function plainText(bytes: ArrayBuffer): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * The file's text, or '' when the format carries none (an image) or extraction
 * failed. Never throws — a viewer that cannot search is still a viewer.
 */
export async function extractDocumentText(category: FileCategory, bytes: ArrayBuffer): Promise<string> {
    try {
        if (category === 'pdf') return await pdfText(bytes);
        if (category === 'docx') return await docxText(bytes);
        if (category === 'sheet') return sheetText(bytes);
        if (category === 'text') return plainText(bytes);
        return '';
    } catch (e) {
        console.warn('[DocumentText] extraction failed', e);
        return '';
    }
}
