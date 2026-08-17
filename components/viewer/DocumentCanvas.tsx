import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { PdfCanvas } from './PdfCanvas';
import { DocxCanvas } from './DocxCanvas';
import { SheetCanvas } from './SheetCanvas';
import { TextCanvas } from './TextCanvas';
import { formatBytes } from './util';
import type { BytesState } from './useFileBytes';
import type { FileCategory, ViewerCitation } from '../../types';

/** Images render straight from a blob URL — no parsing, no text to search. */
const ImageCanvas: React.FC<{ bytes: ArrayBuffer; name: string }> = ({ bytes, name }) => {
    const url = useMemo(() => URL.createObjectURL(new Blob([bytes])), [bytes]);
    useEffect(() => () => URL.revokeObjectURL(url), [url]);
    return (
        <div className="flex h-full flex-col">
            <div className="border-b border-slate-200 px-3 py-1.5">
                <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">Image</span>
            </div>
            <div className="flex flex-1 items-center justify-center overflow-auto scroll-thin bg-slate-100 p-4">
                <img src={url} alt={name} className="max-h-full max-w-full rounded-lg shadow-md ring-1 ring-black/10" />
            </div>
        </div>
    );
};

/**
 * No renderer can open this format in a browser — a legacy .doc, an archive, an
 * installer. Saying so and offering the file is honest; rendering nonsense is not.
 */
const UnsupportedCanvas: React.FC<{ name: string; size: number; onDownload: () => void }> = ({ name, size, onDownload }) => (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Icon name="clip" className="w-8 h-8 text-slate-300" />
        <div>
            <p className="text-sm font-bold text-slate-700">No preview for this file type</p>
            <p className="mt-1 text-xs text-slate-400 font-mono">{name} · {formatBytes(size)}</p>
        </div>
        <p className="max-w-sm text-xs text-slate-400">
            A browser cannot open this format in place. Save it and open it in the application that owns it.
        </p>
        <button onClick={onDownload} className="bg-slate-900 text-white px-4 py-2 rounded font-bold text-sm flex items-center gap-2">
            <Icon name="download" className="w-4 h-4" /> Save a copy
        </button>
    </div>
);

/**
 * Renders one reference file with its cited passage highlighted, picking the
 * renderer that matches the format.
 */
export const DocumentCanvas: React.FC<{
    name: string;
    fileKey: string;
    category: FileCategory;
    bytes: BytesState;
    /** Extracted text, once it is ready — the fallback and the search corpus. */
    text: string | null;
    citation: ViewerCitation | null;
    onDownload: () => void;
}> = ({ name, fileKey, category, bytes, text, citation, onDownload }) => {
    const [waited, setWaited] = useState(false);

    // A format with no renderer of its own falls back to extracted text, but only
    // once extraction has had its turn — otherwise an empty page flashes first.
    useEffect(() => {
        setWaited(false);
        const timer = setTimeout(() => setWaited(true), 400);
        return () => clearTimeout(timer);
    }, [fileKey]);

    if (bytes.status === 'loading') {
        return (
            <div className="flex h-full items-center justify-center text-slate-300">
                <Icon name="spinner" className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    if (bytes.status === 'error') {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="text-sm font-bold text-slate-700">This file could not be read</p>
                <p className="max-w-md text-xs text-slate-400">{bytes.message}</p>
            </div>
        );
    }

    if (category === 'image') return <ImageCanvas bytes={bytes.bytes} name={name} />;
    if (category === 'pdf') return <PdfCanvas bytes={bytes.bytes} citation={citation} />;
    if (category === 'docx') return <DocxCanvas bytes={bytes.bytes} citation={citation} />;
    if (category === 'sheet') return <SheetCanvas bytes={bytes.bytes} citation={citation} />;
    if (category === 'text') {
        return (
            <TextCanvas
                content={text ?? ''}
                fileId={fileKey}
                citation={citation}
                note={text == null ? 'Reading…' : 'Text'}
            />
        );
    }

    // Some files a browser cannot render still hold readable text (a .csv saved
    // under an odd extension, a log). If extraction found any, show it.
    if (text) return <TextCanvas content={text} fileId={fileKey} citation={citation} note="Extracted text" />;
    if (!waited) {
        return (
            <div className="flex h-full items-center justify-center text-slate-300">
                <Icon name="spinner" className="w-5 h-5 animate-spin" />
            </div>
        );
    }
    return <UnsupportedCanvas name={name} size={bytes.bytes.byteLength} onDownload={onDownload} />;
};
