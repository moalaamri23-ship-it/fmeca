import type { FileCategory } from '../../types';

/** Join class names, dropping anything falsy. */
export const cn = (...classes: (string | false | null | undefined)[]): string =>
    classes.filter(Boolean).join(' ');

export const fileExt = (name: string): string => (name.toLowerCase().split('.').pop() || '');

const PDF = new Set(['pdf']);
const DOCX = new Set(['docx', 'dotx', 'docm']);
const SHEET = new Set(['xlsx', 'xlsm', 'xls', 'xltx', 'csv', 'tsv']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const TEXT = new Set([
    'txt', 'md', 'markdown', 'json', 'log', 'csv', 'xml', 'yml', 'yaml', 'html', 'htm', 'css',
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'sql', 'sh', 'ini', 'cfg', 'env',
]);

/**
 * Which renderer opens this file.
 *
 * `unsupported` is honest rather than a failure: a .zip or a legacy .doc has no
 * in-browser renderer, and the viewer offers to save it instead of pretending.
 */
export function categoryFor(name: string): FileCategory {
    const ext = fileExt(name);
    if (PDF.has(ext)) return 'pdf';
    if (DOCX.has(ext)) return 'docx';
    if (SHEET.has(ext)) return 'sheet';
    if (IMAGE.has(ext)) return 'image';
    if (TEXT.has(ext)) return 'text';
    return 'unsupported';
}

/** The Icon name that stands for this kind of file. */
export function iconFor(category: FileCategory): string {
    if (category === 'sheet') return 'excel';
    if (category === 'image') return 'image';
    if (category === 'pdf' || category === 'docx') return 'book';
    if (category === 'text') return 'code';
    return 'clip';
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** power;
    return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

/** Strip characters a file system will not accept in a download name. */
export const safeDownloadName = (name: string): string =>
    String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
