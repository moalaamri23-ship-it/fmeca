import React, { useCallback, useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { Icon } from '../Icon';
import { CHROME_ATTR, highlightInElement, markSearchMatches, styleSearchMark } from './highlight';
import { applyRotations, paginateUnbrokenSections, prepareDocx, settleImages } from './docxPrepare';
import { JumpToInput } from './JumpToInput';
import { applyPageRotation, usePageRotation, useVisiblePage } from './pageView';
import { ViewerControls } from './ViewerControls';
import { scrollElementToTop } from './viewerScroll';
import { useSearchTarget } from './searchContext';
import type { ViewerCitation } from '../../types';

/**
 * Word documents are rendered by docx-preview, which reads the file's own
 * styles, tables, section geometry and image transforms — the document as Word
 * lays it out, not a semantic approximation of it.
 *
 * Pages come from the file too: `ignoreLastRenderedPageBreak: false` keeps the
 * page breaks Word recorded the last time it rendered the document, so the
 * pages here are the pages the author saw.
 */
const RENDER_OPTIONS = {
    // Its own wrapper stays: the document's base typography — Word's fonts and
    // point sizes — is defined against it, and without it the app's own font
    // leaks into the page.
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
} as const;

/** Number the rendered pages and caption them, as the PDF viewer does. */
function numberPages(root: HTMLElement): number {
    // Numbering can run again once late-decoding pictures have changed the page
    // boundaries, so last time's captions go first.
    for (const caption of Array.from(root.querySelectorAll(`[${CHROME_ATTR}]`))) caption.remove();
    const pages = Array.from(root.querySelectorAll<HTMLElement>('section.docx'));
    pages.forEach((page, i) => {
        page.dataset.page = String(i + 1);
        const caption = document.createElement('div');
        caption.setAttribute(CHROME_ATTR, '');
        caption.className = 'mb-4 mt-1 text-center text-[10px] font-mono text-slate-400';
        caption.textContent = `Page ${i + 1}`;
        page.after(caption);
    });
    return pages.length;
}

export const DocxCanvas: React.FC<{ bytes: ArrayBuffer; citation: ViewerCitation | null }> = ({ bytes, citation }) => {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const styleRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // Results are stamped with the input that produced them, so switching file or
    // citation is handled by derivation rather than by resetting state.
    const [rendered, setRendered] = useState<{ bytes: ArrayBuffer; pages: number; error: string | null } | null>(null);
    const [located, setLocated] = useState<{ key: string; found: boolean } | null>(null);
    const [hits, setHits] = useState<HTMLElement[][]>([]);
    const [zoom, setZoom] = useState(1);
    const rotation = usePageRotation();
    const { terms, active, report } = useSearchTarget();

    const anchor = citation?.quote?.trim() || citation?.anchor?.trim() || '';
    const citationKey = `${citation?.id ?? ''}:${anchor}`;
    const current = rendered?.bytes === bytes ? rendered : null;
    const pageCount = current?.pages ?? 0;
    const error = current?.error ?? null;
    const done = current != null && current.error == null;
    const found = anchor && located?.key === citationKey ? located.found : null;

    useEffect(() => {
        const root = bodyRef.current;
        const styles = styleRef.current;
        if (!root || !styles) return;
        let cancelled = false;

        root.textContent = '';
        // A copy, so the cached bytes stay usable the next time this file opens.
        prepareDocx(bytes.slice(0))
            .then(async prepared => {
                await renderAsync(prepared.bytes, root, styles, RENDER_OPTIONS);
                applyRotations(root, prepared.rotations);
                await settleImages(root);
                paginateUnbrokenSections(root);
            })
            .then(() => {
                if (cancelled) return;
                setRendered({ bytes, pages: numberPages(root), error: null });
                // Pictures that decoded after the wait above change the heights the
                // fallback pagination measured, so it gets one more look. A document
                // that carries its own pagination is already page-sized: nothing to do.
                void settleImages(root, 30000).then(() => {
                    if (cancelled) return;
                    paginateUnbrokenSections(root);
                    setRendered({ bytes, pages: numberPages(root), error: null });
                });
            })
            .catch((e: unknown) => {
                if (!cancelled) {
                    setRendered({ bytes, pages: 0, error: e instanceof Error ? e.message : String(e) });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [bytes]);

    useEffect(() => {
        const root = bodyRef.current;
        if (!root || !done || !anchor) return;
        const mark = highlightInElement(root, anchor);
        setLocated({ key: citationKey, found: !!mark });
        mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [done, anchor, citationKey]);

    // Search marks live under their own attribute, so they and the citation
    // highlight never clear each other.
    useEffect(() => {
        const root = bodyRef.current;
        if (!root || !done) {
            setHits([]);
            return;
        }
        setHits(markSearchMatches(root, terms));
    }, [done, terms]);

    useEffect(() => report(hits.length), [hits, report]);

    // The renderer builds the pages, so their rotation is set on them directly
    // rather than rendered by React.
    useEffect(() => {
        const root = bodyRef.current;
        if (!root) return;
        for (const page of root.querySelectorAll<HTMLElement>('section.docx')) {
            applyPageRotation(page, rotation.degreesFor(Number(page.dataset.page)));
        }
    }, [rotation, pageCount]);

    // Only the match being rested on gets the strong highlight.
    useEffect(() => {
        hits.forEach((marks, i) => {
            for (const mark of marks) styleSearchMark(mark, i === active);
        });
        hits[active]?.[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [hits, active]);

    const currentPage = useVisiblePage(scrollRef, pageCount);

    const jumpToPage = useCallback(
        (page: number) =>
            scrollElementToTop(scrollRef.current, scrollRef.current?.querySelector(`[data-page="${page}"]`)),
        []
    );

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 px-3 py-1.5">
                <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">
                    {pageCount > 0 ? `${currentPage}/${pageCount} page${pageCount > 1 ? 's' : ''}` : 'Word document'}
                </span>
                <JumpToInput unit="page" max={pageCount} onJump={jumpToPage} />
                {found === true && (
                    <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-mono text-yellow-800">
                        passage highlighted
                    </span>
                )}
                {found === false && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-mono text-slate-400">
                        passage not located in the rendered layout
                    </span>
                )}
                {hits.length > 0 && (
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-mono text-orange-800">
                        {hits.length} match{hits.length > 1 ? 'es' : ''}
                    </span>
                )}
                <div className="ml-auto">
                    <ViewerControls
                        zoom={zoom}
                        onZoom={setZoom}
                        onFlip={() => rotation.flip(currentPage)}
                        onFlipAll={() => rotation.flipAll(currentPage)}
                        onReset={() => {
                            rotation.reset();
                            setZoom(1);
                        }}
                        changed={rotation.turned || zoom !== 1}
                    />
                </div>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-auto scroll-thin bg-slate-100 p-4">
                {error != null && (
                    <p className="p-6 text-center text-xs text-slate-400">
                        This Word file could not be rendered ({error}).
                    </p>
                )}
                {current == null && (
                    <div className="flex h-full items-center justify-center text-slate-300">
                        <Icon name="spinner" className="w-5 h-5 animate-spin" />
                    </div>
                )}
                {/* docx-preview writes the document's own stylesheet here and its
                    pages into the body below; both belong to it, so React never
                    renders children into either. */}
                <div ref={styleRef} className="hidden" />
                {/* Zoom, not a transform: `zoom` takes part in layout, so the
                    scroll area still measures the pages at the size they are shown. */}
                <div ref={bodyRef} style={{ zoom }} />
            </div>
        </div>
    );
};
