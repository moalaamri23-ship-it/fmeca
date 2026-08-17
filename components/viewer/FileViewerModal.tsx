import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { cn, categoryFor, formatBytes, iconFor, safeDownloadName } from './util';
import { DocumentCanvas } from './DocumentCanvas';
import { ErrorBoundary } from './ErrorBoundary';
import { DocumentSearchBar, DocumentSearchProvider, SmartSearchPanel } from './documentSearch';
import { useSmartPanelActive } from './searchContext';
import { fileKey as makeFileKey, useFileBytes } from './useFileBytes';
import type { BytesState } from './useFileBytes';
import type { CiteSource } from '../../services/CitationCorpus';
import { extractDocumentText } from '../../services/DocumentText';
import { buildDocumentPayload } from '../../services/DocumentPayload';
import type { DocumentPayload } from '../../services/DocumentPayload';
import type { SmartSearchConfig } from '../../services/SmartSearchService';
import type { LocalFileSystemProvider } from '../../services/FileSystem';
import type { FileEntry, SendFilesMode, ViewerCitation } from '../../types';

function locationLabel(citation: ViewerCitation): string {
    const parts: string[] = [];
    if (citation.page != null) parts.push(`page ${citation.page}`);
    if (citation.line != null) parts.push(`line ${citation.line}`);
    if (parts.length === 0 && citation.label) return citation.label;
    if (citation.label) parts.push(citation.label.toLowerCase());
    return parts.join(' · ');
}

const ReferenceCard: React.FC<{
    citation: ViewerCitation;
    active: boolean;
    missing: boolean;
    onSelect: () => void;
}> = ({ citation, active, missing, onSelect }) => (
    <button
        onClick={onSelect}
        className={cn(
            'w-full rounded-lg border p-2.5 text-left transition',
            active ? 'border-brand-500 bg-brand-50 shadow-sm' : 'border-slate-200 bg-white hover:bg-slate-50'
        )}
    >
        <div className="flex items-center gap-2">
            <span className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
                active ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700'
            )}>
                {citation.index}
            </span>
            <span className="truncate text-[11px] font-bold text-slate-700" title={citation.fileName}>
                {citation.fileName}
            </span>
        </div>
        {(citation.quote || citation.snippet || citation.anchor) && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                {citation.quote || citation.snippet || citation.anchor}
            </p>
        )}
        {citation.why && (
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400 italic">{citation.why}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] font-mono text-slate-400">
            {locationLabel(citation) && <span>{locationLabel(citation)}</span>}
            {citation.approximate && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 text-amber-700">approximate</span>
            )}
            {missing && (
                <span className="rounded-full border border-slate-200 bg-slate-100 px-1.5">no longer available</span>
            )}
        </div>
    </button>
);

/**
 * The citations list.
 *
 * Opened from a field's cite button it holds that field's evidence, across
 * every source that was searched; opened from the References panel it is empty,
 * because nothing has cited that folder yet.
 */
const ReferencePanel: React.FC<{
    groups: [string, ViewerCitation[]][];
    known: Set<string>;
    activeId: string | null;
    onSelect: (id: string) => void;
    /** Sources searched that supported nothing — worth saying, not worth a card. */
    emptySources?: string[];
    onRecite?: () => void;
    reciting?: boolean;
}> = ({ groups, known, activeId, onSelect, emptySources = [], onRecite, reciting = false }) => {
    // Smart results take the same slot while they are on screen, so the two
    // panels never compete for the viewer's width.
    if (useSmartPanelActive()) return null;

    return (
        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                <p className="text-[10px] font-bold uppercase text-slate-400">Citations</p>
                {onRecite && (
                    <button
                        onClick={onRecite}
                        disabled={reciting}
                        title="Search the sources again for this field"
                        className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-brand-600 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                        <Icon name={reciting ? 'spinner' : 'rotate'} className={cn('w-3 h-3', reciting && 'animate-spin')} />
                        {reciting ? 'Searching…' : 'Re-search'}
                    </button>
                )}
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto scroll-thin px-3 py-3">
                {groups.length === 0 ? (
                    <p className="px-1 py-4 text-[11px] leading-relaxed text-slate-400 italic">
                        Nothing in the sources supported this text. Re-search after editing the field, or attach
                        the document this came from to the subsystem.
                    </p>
                ) : (
                    groups.map(([fileName, list]) => (
                        <div key={fileName} className="space-y-1.5">
                            <p className="truncate px-0.5 text-[10px] font-mono text-slate-400" title={fileName}>
                                {fileName}
                            </p>
                            {list.map(citation => (
                                <ReferenceCard
                                    key={citation.id}
                                    citation={citation}
                                    active={citation.id === activeId}
                                    missing={!known.has(citation.fileName)}
                                    onSelect={() => onSelect(citation.id)}
                                />
                            ))}
                        </div>
                    ))
                )}
                {emptySources.length > 0 && (
                    <div className="border-t border-slate-200 pt-2">
                        <p className="text-[10px] leading-relaxed text-slate-400">
                            Searched, nothing found: {emptySources.join(', ')}
                        </p>
                    </div>
                )}
            </div>
        </aside>
    );
};

/**
 * Opens a reference file in place: PDF, Word, spreadsheet, image, text — each in
 * its own renderer, with find-in-document, smart search, page/row/line jumping,
 * zoom and rotation, and a citations panel beside it.
 *
 * Nothing is downloaded to be read. Saving a copy stays available for the
 * formats a browser genuinely cannot render, and on request.
 */
export const FileViewerModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    provider: LocalFileSystemProvider | null;
    /** Every file in the open folder — a citation names one of these. */
    files: FileEntry[];
    pathParts: string[];
    /**
     * Citing a field reaches past one folder: the knowledge file, the checklist,
     * the subsystem's documents and the failure's. When these are given they
     * replace `files` as what the viewer can open and jump between.
     */
    sources?: CiteSource[];
    /** The file that was clicked. A selected citation can point at another. */
    openName: string | null;
    onOpenName: (name: string) => void;
    citations?: ViewerCitation[];
    activeCitationId?: string | null;
    onSelectCitation?: (id: string) => void;
    /** Sources that were searched and supported nothing. */
    emptySources?: string[];
    /** Run the citation search again for the same field. */
    onRecite?: () => void;
    reciting?: boolean;
    /** Live AI settings, for smart search. Null disables it with a reason. */
    ai?: SmartSearchConfig | null;
    /** How much of the file may be sent to the AI. */
    sendFiles?: SendFilesMode;
    /** What these references belong to, e.g. a subsystem name. */
    entityName?: string | null;
}> = ({
    isOpen, onClose, provider, files, pathParts, sources, openName, onOpenName,
    citations = [], activeCitationId = null, onSelectCitation, emptySources = [],
    onRecite, reciting = false, ai = null, sendFiles = 'text', entityName,
}) => {
    const [panelOpen, setPanelOpen] = useState(true);
    const [text, setText] = useState<{ key: string; value: string } | null>(null);
    const [payload, setPayload] = useState<{ key: string; value: DocumentPayload } | null>(null);

    // Escape belongs to the find bar while it is open, and to the modal otherwise.
    const searchState = useRef<{ open: boolean; close: () => void }>({ open: false, close: () => {} });

    const active = useMemo(
        () => citations.find(c => c.id === activeCitationId) ?? null,
        [citations, activeCitationId]
    );

    /**
     * Every document this viewer can open, whether that is one folder's files or
     * the whole set a field was cited against. `id` is the folder-qualified key,
     * so two documents of the same name in different folders never collide — and
     * it is also the bytes cache key, which is what `forgetFileBytes` deletes.
     */
    const docs = useMemo(
        () =>
            sources
                ? sources.map(source => ({
                      id: source.id,
                      fileName: source.fileName,
                      entry: source.entry ?? null,
                      text: source.text,
                  }))
                : files.map(file => ({
                      id: makeFileKey(pathParts, file.name),
                      fileName: file.name,
                      entry: file,
                      text: undefined as string | undefined,
                  })),
        [sources, files, pathParts]
    );

    // A selected citation decides which document is shown — by the source it was
    // found in, falling back to the name. Otherwise the file the reader clicked
    // stays open.
    const doc = useMemo(() => {
        if (active) {
            const bySource = active.sourceId ? docs.find(d => d.id === active.sourceId) : undefined;
            if (bySource) return bySource;
            const byName = docs.find(d => d.fileName === active.fileName);
            if (byName) return byName;
        }
        return docs.find(d => d.fileName === openName) ?? (sources ? docs[0] ?? null : null);
    }, [active, docs, openName, sources]);

    const shownName = doc?.fileName ?? null;
    const entry = doc?.entry ?? null;
    const category = shownName ? categoryFor(shownName) : 'unsupported';
    const key = doc?.id ?? '';

    // The knowledge and checklist sources are text, not files. Encoding them as
    // bytes lets them travel the same path as everything else — the text
    // renderer decodes them, and smart search reads them, with no special case.
    const virtualBytes = useMemo(
        () => (doc?.text != null ? (new TextEncoder().encode(doc.text).buffer as ArrayBuffer) : null),
        [doc]
    );
    const fileBytes = useFileBytes(
        isOpen && !virtualBytes ? provider : null,
        isOpen && !virtualBytes ? entry : null,
        key
    );
    const bytes: BytesState = virtualBytes ? { status: 'ready', bytes: virtualBytes } : fileBytes;

    // The citation only applies to the document it was found in.
    const citation = active && doc && (active.sourceId ? active.sourceId === doc.id : active.fileName === doc.fileName)
        ? active
        : null;

    const known = useMemo(() => new Set(docs.map(d => d.fileName)), [docs]);

    // Grouped by file, so citations spanning several references read clearly.
    const groups = useMemo(() => {
        const map = new Map<string, ViewerCitation[]>();
        for (const c of citations) {
            map.set(c.fileName, [...(map.get(c.fileName) ?? []), c]);
        }
        return [...map.entries()];
    }, [citations]);

    // Extract the document's text once its bytes are in: it is what smart search
    // reads, and the fallback for formats with no renderer of their own.
    //
    // Keyed on the BUFFER, not on the loader's state object: that object is built
    // fresh on every render, and depending on it re-ran the extraction after
    // every setText — a loop that hung the tab.
    const loadedBytes = bytes.status === 'ready' ? bytes.bytes : null;
    useEffect(() => {
        if (!isOpen || !loadedBytes || !key) return;
        if (category === 'image') {
            setText({ key, value: '' });
            return;
        }
        let cancelled = false;
        void extractDocumentText(category, loadedBytes).then(value => {
            if (!cancelled) setText({ key, value });
        });
        return () => {
            cancelled = true;
        };
    }, [isOpen, loadedBytes, key, category]);

    const documentText = text?.key === key ? text.value : null;

    // Once the text is known, build what smart search may send: an image or a
    // scanned PDF has no text worth reading, so its pages go as images instead —
    // and on Copilot the original file rides along, since that flow can open one.
    useEffect(() => {
        if (!isOpen || !loadedBytes || !key || documentText == null || !shownName) return;
        let cancelled = false;
        void buildDocumentPayload(shownName, category, loadedBytes, documentText, {
            provider: ai?.provider ?? '',
            mode: sendFiles,
        }).then(value => {
            if (!cancelled) setPayload({ key, value });
        });
        return () => {
            cancelled = true;
        };
    }, [isOpen, loadedBytes, key, category, documentText, shownName, ai?.provider, sendFiles]);

    const documentPayload = payload?.key === key ? payload.value : null;

    const download = useCallback(() => {
        if (bytes.status !== 'ready' || !shownName) return;
        const url = URL.createObjectURL(new Blob([bytes.bytes]));
        const a = document.createElement('a');
        a.href = url;
        a.download = safeDownloadName(shownName);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
    }, [bytes, shownName]);

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (searchState.current.open) {
                searchState.current.close();
                return;
            }
            onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen, onClose]);

    const onStateChange = useCallback((state: { open: boolean; close: () => void }) => {
        searchState.current = state;
    }, []);

    if (!isOpen || !shownName) return null;

    // An image has no text to find in, but smart search can still read it, so the
    // bar appears as soon as there is something to send. ⌘F stays off there —
    // there is nothing for a literal find to match.
    const searchable = category !== 'image';
    const showSearchBar = searchable || documentPayload != null;
    const size = bytes.status === 'ready' ? bytes.bytes.byteLength : null;
    const showPanel = panelOpen;

    return (
        <div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center p-3" onMouseDown={onClose}>
            <div
                className="flex h-[92vh] w-[96vw] max-w-[1500px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl animate-enter"
                onMouseDown={e => e.stopPropagation()}
            >
                {/* Keyed by document: opening a different file starts a fresh search. */}
                <DocumentSearchProvider
                    key={key}
                    hotkey={searchable}
                    documentText={searchable ? (documentText ?? '') : ''}
                    documentName={shownName}
                    payload={documentPayload}
                    sendFiles={sendFiles}
                    ai={ai}
                    onStateChange={onStateChange}
                >
                    <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                            <Icon name={iconFor(category)} className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h3 className="truncate text-sm font-bold text-slate-900">{shownName}</h3>
                            <p className="truncate text-[11px] text-slate-400">
                                {citation
                                    ? `Citation ${citation.index} of ${citations.length}${locationLabel(citation) ? ` · ${locationLabel(citation)}` : ''}`
                                    : [
                                          category === 'unsupported' ? 'File' : category.toUpperCase(),
                                          size != null ? formatBytes(size) : null,
                                          entityName || null,
                                      ]
                                          .filter(Boolean)
                                          .join(' · ')}
                            </p>
                        </div>
                        {showSearchBar && <DocumentSearchBar />}
                        <button
                            onClick={download}
                            disabled={bytes.status !== 'ready'}
                            title="Save a copy"
                            className="rounded p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
                        >
                            <Icon name="download" className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setPanelOpen(p => !p)}
                            title={panelOpen ? 'Hide citations' : 'Show citations'}
                            className={cn(
                                'rounded p-2 transition hover:bg-slate-100 hover:text-slate-700',
                                panelOpen ? 'text-brand-600' : 'text-slate-400'
                            )}
                        >
                            <Icon name="panelRight" className="w-4 h-4" />
                        </button>
                        <button onClick={onClose} title="Close"
                            className="rounded p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
                            <Icon name="close" className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex min-h-0 flex-1">
                        <div className={cn('min-w-0 flex-1', showPanel && 'border-r border-slate-200')}>
                            <ErrorBoundary label="This document could not be displayed" resetKey={`${key}:${citation?.id ?? ''}`}>
                                <DocumentCanvas
                                    key={key}
                                    name={shownName}
                                    fileKey={key}
                                    category={category}
                                    bytes={bytes}
                                    text={documentText}
                                    citation={citation}
                                    onDownload={download}
                                />
                            </ErrorBoundary>
                        </div>

                        {showPanel && (
                            <ReferencePanel
                                groups={groups}
                                known={known}
                                activeId={activeCitationId}
                                emptySources={emptySources}
                                onRecite={onRecite}
                                reciting={reciting}
                                onSelect={id => {
                                    onSelectCitation?.(id);
                                    const target = citations.find(c => c.id === id);
                                    if (target && known.has(target.fileName)) onOpenName(target.fileName);
                                }}
                            />
                        )}
                        <SmartSearchPanel />
                    </div>
                </DocumentSearchProvider>
            </div>
        </div>
    );
};
