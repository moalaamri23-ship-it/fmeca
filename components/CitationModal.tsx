import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { LocalFileSystemProvider } from '../services/FileSystem';
import type { CiteSource } from '../services/CitationCorpus';
import type { SmartSearchConfig } from '../services/SmartSearchService';
import type { SendFilesMode } from '../types';
import type { CitationGroup } from './viewer/FileViewerModal';

// Same renderers as the References panel, and the same reason to load them late.
const FileViewerModal = lazy(() =>
    import('./viewer/FileViewerModal').then(m => ({ default: m.FileViewerModal }))
);

export type { CitationGroup };

/**
 * A field's citations — or a whole subsystem's — in the document viewer.
 *
 * This is the References viewer with a different set of documents behind it:
 * not one folder, but every source the fields were cited against — the
 * knowledge file, the checklist, the subsystem's attachments and the failure's.
 * Selecting a citation switches to whichever of them holds it, so moving
 * through the list walks the reader across all of them without ever leaving the
 * modal.
 *
 * One group is one cited field. A field's own button opens a modal with a
 * single group; the subsystem's bulk button opens one holding every field it
 * ran, each re-searchable on its own.
 *
 * The first citation is selected on open, so the modal lands on a highlighted
 * passage rather than on an arbitrary first page.
 */
export const CitationModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    provider: LocalFileSystemProvider | null;
    sources: CiteSource[];
    /** One section per cited field, in the order they appear on the card. */
    groups: CitationGroup[];
    ai: SmartSearchConfig | null;
    sendFiles: SendFilesMode;
    /** What was cited, e.g. "Mitigation · Lube Oil Pump". */
    entityName: string;
}> = ({ isOpen, onClose, provider, sources, groups, ai, sendFiles, entityName }) => {
    const [openName, setOpenName] = useState<string | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);

    const citations = useMemo(() => groups.flatMap(g => g.citations), [groups]);

    // Open on the first citation. A re-search replaces the list, so this also
    // moves the reader onto the new first result rather than leaving them on a
    // selection that no longer exists.
    useEffect(() => {
        if (!isOpen) {
            setActiveId(null);
            setOpenName(null);
            return;
        }
        // A selection that survived the change is the reader's place in the
        // panel — re-searching one field of many must not drag them off it.
        if (activeId && citations.some(c => c.id === activeId)) return;
        const first = citations[0] ?? null;
        setActiveId(first?.id ?? null);
        setOpenName(first?.fileName ?? sources[0]?.fileName ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, citations, sources]);

    if (!isOpen) return null;

    return (
        <Suspense fallback={
            <div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center">
                <div className="bg-white rounded-xl px-6 py-4 border text-sm text-slate-500">Opening…</div>
            </div>
        }>
            <FileViewerModal
                isOpen={true}
                onClose={onClose}
                provider={provider}
                files={[]}
                pathParts={[]}
                sources={sources}
                openName={openName}
                onOpenName={setOpenName}
                groups={groups}
                activeCitationId={activeId}
                onSelectCitation={setActiveId}
                ai={ai}
                sendFiles={sendFiles}
                entityName={entityName}
            />
        </Suspense>
    );
};
