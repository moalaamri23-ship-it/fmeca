import React, { Suspense, lazy, useEffect, useState } from 'react';
import type { LocalFileSystemProvider } from '../services/FileSystem';
import type { CiteSource } from '../services/CitationCorpus';
import type { SmartSearchConfig } from '../services/SmartSearchService';
import type { FieldClaim, SendFilesMode, ViewerCitation } from '../types';

// Same renderers as the References panel, and the same reason to load them late.
const FileViewerModal = lazy(() =>
    import('./viewer/FileViewerModal').then(m => ({ default: m.FileViewerModal }))
);

/**
 * A field's citations, in the document viewer.
 *
 * This is the References viewer with a different set of documents behind it:
 * not one folder, but every source the field was cited against — the knowledge
 * file, the checklist, the subsystem's attachments and the failure's. Selecting
 * a citation switches to whichever of them holds it, so moving through the list
 * walks the reader across all of them without ever leaving the modal.
 *
 * The first citation is selected on open, so the modal lands on a highlighted
 * passage rather than on an arbitrary first page.
 */
export const CitationModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    provider: LocalFileSystemProvider | null;
    sources: CiteSource[];
    citations: ViewerCitation[];
    /** The field's assertions — the panel is one section per claim. */
    claims: FieldClaim[];
    emptySources?: string[];
    onRecite: () => void;
    reciting: boolean;
    ai: SmartSearchConfig | null;
    sendFiles: SendFilesMode;
    /** What was cited, e.g. "Mitigation · Lube Oil Pump". */
    entityName: string;
}> = ({
    isOpen, onClose, provider, sources, citations, claims, emptySources = [],
    onRecite, reciting, ai, sendFiles, entityName,
}) => {
    const [openName, setOpenName] = useState<string | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);

    // Open on the first citation. A re-search replaces the list, so this also
    // moves the reader onto the new first result rather than leaving them on a
    // selection that no longer exists.
    useEffect(() => {
        if (!isOpen) {
            setActiveId(null);
            setOpenName(null);
            return;
        }
        const first = citations[0] ?? null;
        setActiveId(first?.id ?? null);
        setOpenName(first?.fileName ?? sources[0]?.fileName ?? null);
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
                citations={citations}
                claims={claims}
                activeCitationId={activeId}
                onSelectCitation={setActiveId}
                emptySources={emptySources}
                onRecite={onRecite}
                reciting={reciting}
                ai={ai}
                sendFiles={sendFiles}
                entityName={entityName}
            />
        </Suspense>
    );
};
