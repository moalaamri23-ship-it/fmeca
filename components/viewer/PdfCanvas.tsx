import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pdfjsLib } from './pdfjs';
import { Icon } from '../Icon';
import { locateText, pageAnchor } from './locate';
import { JumpToInput } from './JumpToInput';
import { isQuarterTurn, usePageRotation, useVisiblePage } from './pageView';
import { textRangeFractions } from './pdfTextRange';
import { ViewerControls } from './ViewerControls';
import { useSearchTarget } from './searchContext';
import { MAX_MATCHES, findMatches, normalizeTerms } from './textSearch';
import type { ViewerCitation } from '../../types';
import type * as PdfJs from 'pdfjs-dist';

/** Highlight box in page-relative fractions, so it survives zoom changes. */
interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

const MAX_SEARCH_PAGES = 80;
const NEARBY_PAGES = 4;
const MAX_DPR = 2;
const PAGE_MARGIN = 16;
// Keep correcting the scroll position until the target page sits still for a few
// frames, or the budget runs out (a very long document may keep reflowing).
const SETTLE_STABLE_FRAMES = 5;
const SETTLE_TIMEOUT_MS = 4000;
// How far down the viewport the highlighted passage comes to rest.
const FOCUS_VIEWPORT_RATIO = 0.3;

// Highlight overlays sit on top of the rendered page canvas.
//
// The colours are inline styles, not utility classes. Safari renders nothing at
// all when an element blends against an accelerated canvas layer, so plain alpha
// is used instead of a blend mode — and a colour assembled in a template literal
// would never be emitted by a class scanner anyway. A style attribute survives both.
const HIGHLIGHT_BOX = 'pointer-events-none absolute rounded-[2px]';
const HIGHLIGHT_STYLES = {
    citation: { background: 'rgba(254, 240, 138, 0.45)' },
    citationActive: { background: 'rgba(250, 204, 21, 0.45)', outline: '1px solid rgb(202, 138, 4)' },
    search: { background: 'rgba(253, 186, 116, 0.40)' },
    searchActive: { background: 'rgba(251, 146, 60, 0.50)', outline: '1px solid rgb(234, 88, 12)' },
} as const;

type TextContent = Awaited<ReturnType<PdfJs.PDFPageProxy['getTextContent']>>;
type TextItem = Extract<TextContent['items'][number], { str: string }>;

interface PageText {
    text: string;
    items: TextItem[];
    styles: TextContent['styles'];
    /** Where each item's string sits inside `text`. */
    spans: { start: number; end: number; index: number }[];
}

let textMeasureCanvas: HTMLCanvasElement | null = null;

/** Canvas measurement mirrors PDF.js's text-layer horizontal scaling. */
function widthMeasurer(fontFamily: string | undefined, fontSize: number) {
    if (typeof document === 'undefined') return undefined;
    textMeasureCanvas ??= document.createElement('canvas');
    const context = textMeasureCanvas.getContext('2d');
    if (!context) return undefined;
    context.font = `${Math.max(fontSize, 1)}px ${fontFamily || 'sans-serif'}`;
    return (text: string) => context.measureText(text).width;
}

/** The page's reading-order text, remembering each item's span in it. */
function pageText(content: TextContent): PageText {
    const items = content.items.filter((i): i is TextItem => 'str' in i);
    let text = '';
    const spans: PageText['spans'] = [];
    items.forEach((item, index) => {
        const start = text.length;
        text += item.str;
        spans.push({ start, end: text.length, index });
        text += ' ';
    });
    return { text, items, styles: content.styles, spans };
}

/** Boxes covering [start, end) of the page text, in page-relative fractions. */
function boxesForSpan(page: PdfJs.PDFPageProxy, parsed: PageText, start: number, end: number): Box[] {
    const viewport = page.getViewport({ scale: 1 });
    const boxes: Box[] = [];
    for (const span of parsed.spans) {
        if (span.end <= start || span.start >= end) continue;
        const item = parsed.items[span.index];
        if (!item.str.trim()) continue;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const height = Math.hypot(tx[2], tx[3]) || item.height || 10;
        const style = parsed.styles[item.fontName];
        // PDF text transforms place tx[5] on the baseline, not at the bottom of
        // the font box. Respect the font's ascent/descent so the overlay houses
        // the glyphs evenly instead of leaving all spare line-box space above them.
        const ascent = style?.ascent || (style?.descent ? 1 + style.descent : 0.8);
        const width = item.width || 0;
        if (width <= 0) continue;
        // A text item can hold a whole proportional-font line. Measure glyph
        // advances like PDF.js's text layer does; character-count fractions drift
        // across mixed-width letters and can start/end inside neighbouring glyphs.
        const { from, to } = textRangeFractions(
            item.str,
            Math.max(0, start - span.start),
            Math.min(item.str.length, end - span.start),
            widthMeasurer(style?.fontFamily, height),
            item.dir === 'rtl' ? 'rtl' : 'ltr'
        );
        boxes.push({
            left: (tx[4] + width * from) / viewport.width,
            top: (tx[5] - height * ascent) / viewport.height,
            width: (width * (to - from)) / viewport.width,
            height: height / viewport.height,
        });
    }
    return boxes;
}

function itemBoxes(page: PdfJs.PDFPageProxy, content: TextContent, anchor: string): Box[] {
    const parsed = pageText(content);
    const hit = locateText(parsed.text, anchor);
    if (!hit) return [];
    return boxesForSpan(page, parsed, hit.start, hit.end);
}

/** One entry per occurrence of the search terms on this page. */
function searchBoxes(page: PdfJs.PDFPageProxy, content: TextContent, terms: string[]): Box[][] {
    const parsed = pageText(content);
    return findMatches(parsed.text, terms)
        .map(match => boxesForSpan(page, parsed, match.start, match.end))
        .filter(boxes => boxes.length > 0);
}

/** Topmost edge of a highlight, as a fraction of the page height. */
function topOfBoxes(boxes: Box[]): number | undefined {
    if (boxes.length === 0) return undefined;
    return boxes.reduce((min, box) => Math.min(min, box.top), 1);
}

interface PendingScroll {
    page: number;
    /** Where the cited passage sits inside the page box, 0 (top) to 1 (bottom). */
    focus?: number;
    stableFrames: number;
    deadline: number;
    cancelled?: boolean;
    frame?: number;
}

/**
 * Scroll the cited passage into view and KEEP it there until the layout settles.
 *
 * A single scrollTo lands on the wrong page: the pages above the target are
 * still placeholders when the offset is measured, and every one that renders
 * afterwards changes height and pushes the target away. So the position is
 * re-measured each frame against live geometry and corrected until it holds
 * still (or the budget runs out on a document that keeps reflowing).
 *
 * The resting position is the highlighted text itself, parked in the upper
 * third of the viewport — but never scrolled further up than the page's own
 * top, so a passage near the top of a page still shows the page it belongs to.
 */
function chasePage(
    scrollRef: { current: HTMLDivElement | null },
    pageRefs: Map<number, HTMLDivElement>,
    pending: PendingScroll
): PendingScroll {
    const step = () => {
        pending.frame = undefined;
        if (pending.cancelled) return;
        const scroller = scrollRef.current;
        if (!scroller) return;

        const el = pageRefs.get(pending.page);
        if (el) {
            // getBoundingClientRect, not offsetTop: the scroll container is not
            // the offsetParent, so offsetTop also carries the modal chrome's offset.
            const scrollerTop = scroller.getBoundingClientRect().top;
            const pageTop = el.getBoundingClientRect().top;
            let delta = pageTop - scrollerTop - PAGE_MARGIN;

            if (pending.focus != null) {
                // The page box excludes the "Page N" caption under it, so the
                // fraction maps onto the paper itself.
                const box = el.querySelector<HTMLElement>('[data-page-box]');
                const boxHeight = box?.getBoundingClientRect().height ?? el.getBoundingClientRect().height;
                const passageTop = pageTop + pending.focus * boxHeight;
                const focusDelta = passageTop - scrollerTop - scroller.clientHeight * FOCUS_VIEWPORT_RATIO;
                delta = Math.max(delta, focusDelta);
            }

            if (Math.abs(delta) > 1) {
                scroller.scrollTop += delta;
                pending.stableFrames = 0;
            } else {
                pending.stableFrames++;
            }
        }

        if (pending.stableFrames >= SETTLE_STABLE_FRAMES || performance.now() > pending.deadline) return;
        pending.frame = requestAnimationFrame(step);
    };
    // Position once synchronously: frame callbacks are throttled while the tab is
    // hidden, and the page must already be right when the reader looks at it.
    step();
    return pending;
}

/** Abort an in-flight chase (superseded target, unmount, or reader took over). */
function stopChase(pending: PendingScroll | null): void {
    if (!pending) return;
    pending.cancelled = true;
    if (pending.frame != null) cancelAnimationFrame(pending.frame);
}

const PageView: React.FC<{
    doc: PdfJs.PDFDocumentProxy;
    pageNumber: number;
    scale: number;
    boxes: Box[];
    active: boolean;
    /** Search matches on this page, and which of them the viewer is resting on. */
    hits: Box[][];
    activeHit: number | null;
    /** How far the reader has turned this page, in degrees. */
    rotation: number;
    /** Expected page box at the current zoom — keeps un-rendered pages the right height. */
    placeholder: { width: number; height: number };
    /** Render immediately (this is the page being scrolled to), skipping the observer. */
    priority: boolean;
    registerRef: (page: number, el: HTMLDivElement | null) => void;
}> = ({ doc, pageNumber, scale, boxes, active, hits, activeHit, placeholder, priority, rotation, registerRef }) => {
    const holderRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [seen, setSeen] = useState(pageNumber <= 2);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const visible = seen || priority;
    const pageBox = size ?? placeholder;
    const turned = isQuarterTurn(rotation);

    // Render only pages near the viewport — a 300-page manual stays responsive.
    useEffect(() => {
        const el = holderRef.current;
        if (!el || visible) return;
        const observer = new IntersectionObserver(
            entries => { if (entries.some(e => e.isIntersecting)) setSeen(true); },
            { rootMargin: '600px 0px' }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [visible]);

    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        let task: PdfJs.RenderTask | null = null;

        void (async () => {
            const page = await doc.getPage(pageNumber);
            if (cancelled) return;
            const viewport = page.getViewport({ scale });
            const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            setSize({ width: viewport.width, height: viewport.height });
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, viewport.width, viewport.height);
            task = page.render({ canvasContext: ctx, viewport, canvas });
            try {
                await task.promise;
            } catch {
                // Superseded by a newer render (zoom / resize) — nothing to do.
            }
        })();

        return () => {
            cancelled = true;
            task?.cancel();
        };
    }, [doc, pageNumber, scale, visible]);

    return (
        <div
            ref={el => {
                holderRef.current = el;
                registerRef(pageNumber, el);
            }}
            className="relative mx-auto mb-4 w-fit"
            data-page={pageNumber}
        >
            {/* A turned page needs the footprint the turn produces — this reserves
                it, so the pages below stay clear of it. */}
            <div
                className="relative"
                style={{
                    width: turned ? pageBox.height : pageBox.width,
                    height: turned ? pageBox.width : pageBox.height,
                }}
            >
                <div
                    data-page-box
                    className="absolute left-1/2 top-1/2 bg-white shadow-md ring-1 ring-black/10"
                    style={{ ...pageBox, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
                >
                    <canvas
                        ref={canvasRef}
                        className="block"
                        style={size ? { width: size.width, height: size.height } : undefined}
                    />
                    {!size && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-300">
                            <Icon name="spinner" className="w-5 h-5 animate-spin" />
                        </div>
                    )}
                    {boxes.map((box, i) => (
                        <div
                            key={i}
                            className={HIGHLIGHT_BOX}
                            style={{
                                ...(active ? HIGHLIGHT_STYLES.citationActive : HIGHLIGHT_STYLES.citation),
                                left: `${box.left * 100}%`,
                                top: `${box.top * 100}%`,
                                width: `${box.width * 100}%`,
                                height: `${box.height * 100}%`,
                            }}
                        />
                    ))}
                    {hits.map((match, m) =>
                        match.map((box, i) => (
                            <div
                                key={`${m}-${i}`}
                                className={HIGHLIGHT_BOX}
                                style={{
                                    ...(m === activeHit ? HIGHLIGHT_STYLES.searchActive : HIGHLIGHT_STYLES.search),
                                    left: `${box.left * 100}%`,
                                    top: `${box.top * 100}%`,
                                    width: `${box.width * 100}%`,
                                    height: `${box.height * 100}%`,
                                }}
                            />
                        ))
                    )}
                </div>
            </div>
            <div className="mt-1 text-center text-[10px] font-mono text-slate-400">Page {pageNumber}</div>
        </div>
    );
};

export const PdfCanvas: React.FC<{ bytes: ArrayBuffer; citation: ViewerCitation | null }> = ({ bytes, citation }) => {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const pageRefs = useRef(new Map<number, HTMLDivElement>());
    // State is stamped with what produced it, so a new file or a new citation is
    // reflected by derivation instead of a reset render.
    const [loaded, setLoaded] = useState<{
        bytes: ArrayBuffer;
        doc: PdfJs.PDFDocumentProxy | null;
        error: string | null;
    } | null>(null);
    const [baseSize, setBaseSize] = useState({ width: 612, height: 792 });
    const [containerWidth, setContainerWidth] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [found, setFound] = useState<{ key: string; page: number; boxes: Box[] } | null>(null);
    // Search matches in document order, stamped with the terms that produced them.
    const [hits, setHits] = useState<{ key: string; list: { page: number; boxes: Box[] }[] }>({ key: '', list: [] });

    // The page being scrolled to, plus the settle loop that keeps correcting the
    // scroll position while pages around it render and change height.
    const pendingRef = useRef<PendingScroll | null>(null);

    const rotation = usePageRotation();
    const { terms, active: activeHit, report } = useSearchTarget();
    // The scan is keyed by the normalized needles, so re-rendering with an equal
    // but freshly built term list does not re-scan the document. Newline is a safe
    // separator: normalization collapses all whitespace, so no needle holds one.
    const termKey = useMemo(() => normalizeTerms(terms).join('\n'), [terms]);
    const needles = useMemo(() => (termKey ? termKey.split('\n') : []), [termKey]);
    // A citation whose anchor names a page ("page 4") points at the page, not at
    // the words "page 4" — searching for them would highlight the wrong thing, or
    // scan the whole document for text that was never a quotation.
    const rawAnchor = citation?.quote?.trim() || citation?.anchor?.trim() || '';
    const anchor = citation && !citation.quote && pageAnchor(rawAnchor) != null ? '' : rawAnchor;
    const citationKey = `${citation?.id ?? ''}:${anchor}`;
    const doc = loaded?.bytes === bytes ? loaded.doc : null;
    const currentPage = useVisiblePage(scrollRef, doc?.numPages ?? 0);
    const error = loaded?.bytes === bytes ? loaded.error : null;
    const highlight = found?.key === citationKey ? found : null;
    // Results from a superseded query are ignored rather than cleared, so no state
    // has to be reset when the terms change.
    const matches = useMemo(() => (hits.key === termKey ? hits.list : []), [hits, termKey]);
    const currentHit = matches[activeHit] ?? null;
    // The page this citation wants: where the passage was actually found, else the
    // page the extracted-text offsets point at. Derived, so no extra state to sync.
    const targetPage = highlight?.page ?? citation?.page ?? null;

    // Matches grouped per page, so a page renders only its own overlays and each
    // one still knows its index in the document-wide match list.
    const hitsByPage = useMemo(() => {
        const map = new Map<number, { index: number; boxes: Box[] }[]>();
        matches.forEach((match, index) => {
            map.set(match.page, [...(map.get(match.page) ?? []), { index, boxes: match.boxes }]);
        });
        return map;
    }, [matches]);

    const scrollToPage = useCallback((page: number, focus?: number) => {
        stopChase(pendingRef.current);
        pendingRef.current = chasePage(scrollRef, pageRefs.current, {
            page,
            focus,
            stableFrames: 0,
            deadline: performance.now() + SETTLE_TIMEOUT_MS,
        });
    }, []);

    useEffect(() => () => stopChase(pendingRef.current), []);

    useEffect(() => {
        let cancelled = false;
        let opened: PdfJs.PDFDocumentProxy | null = null;
        // getDocument takes ownership of the buffer — hand it a copy so the cached
        // bytes stay usable for the next open.
        const task = pdfjsLib.getDocument({ data: bytes.slice(0) });
        task.promise.then(
            pdf => {
                if (cancelled) {
                    void pdf.destroy();
                    return;
                }
                opened = pdf;
                setLoaded({ bytes, doc: pdf, error: null });
                void pdf.getPage(1).then(page => {
                    if (cancelled) return;
                    const { width, height } = page.getViewport({ scale: 1 });
                    setBaseSize({ width, height });
                });
            },
            (e: unknown) => {
                if (!cancelled) setLoaded({ bytes, doc: null, error: e instanceof Error ? e.message : String(e) });
            }
        );
        return () => {
            cancelled = true;
            void task.destroy();
            void opened?.destroy();
        };
    }, [bytes]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
        observer.observe(el);
        setContainerWidth(el.clientWidth);

        // Once the reader takes over, stop chasing the cited page under them.
        const release = () => {
            stopChase(pendingRef.current);
            pendingRef.current = null;
        };
        el.addEventListener('wheel', release, { passive: true });
        el.addEventListener('touchstart', release, { passive: true });
        el.addEventListener('pointerdown', release);
        return () => {
            observer.disconnect();
            el.removeEventListener('wheel', release);
            el.removeEventListener('touchstart', release);
            el.removeEventListener('pointerdown', release);
        };
    }, []);

    const scale = useMemo(() => {
        const fit = containerWidth > 0 ? (containerWidth - 48) / baseSize.width : 1;
        return Math.min(Math.max(fit * zoom, 0.3), 4);
    }, [containerWidth, baseSize, zoom]);

    // Un-rendered pages reserve the real page box at the current zoom, so the
    // document's total height barely changes as pages render in.
    const placeholder = useMemo(
        () => ({ width: baseSize.width * scale, height: baseSize.height * scale }),
        [baseSize, scale]
    );

    // Zoom or a resize re-lays out every page — chase the target again afterwards.
    useEffect(() => {
        if (targetPage == null) return;
        scrollToPage(targetPage, highlight ? topOfBoxes(highlight.boxes) : undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scale]);

    // Locate the cited passage: trust the page derived from the extracted text,
    // and fall back to scanning the document when it is absent or wrong.
    useEffect(() => {
        if (!doc) return;
        const page = citation?.page;
        if (!anchor) {
            if (page) scrollToPage(page);
            return;
        }

        let cancelled = false;
        void (async () => {
            // Search the estimated page first, then its neighbours (extracted-text
            // page boundaries drift by a page on some PDFs), then the rest.
            const order: number[] = [];
            const queue = (p: number) => {
                if (p >= 1 && p <= doc.numPages && !order.includes(p)) order.push(p);
            };
            if (page) {
                queue(page);
                for (let d = 1; d <= NEARBY_PAGES; d++) {
                    queue(page - d);
                    queue(page + d);
                }
            }
            for (let p = 1; p <= Math.min(doc.numPages, MAX_SEARCH_PAGES); p++) queue(p);

            for (const pageNumber of order) {
                if (cancelled) return;
                const pdfPage = await doc.getPage(pageNumber);
                const content = await pdfPage.getTextContent();
                const boxes = itemBoxes(pdfPage, content, anchor);
                if (boxes.length > 0) {
                    if (cancelled) return;
                    setFound({ key: citationKey, page: pageNumber, boxes });
                    scrollToPage(pageNumber, topOfBoxes(boxes));
                    return;
                }
            }
            // Not found visually — still land on the page the text offsets suggest.
            if (!cancelled && page) scrollToPage(page);
        })();

        return () => {
            cancelled = true;
        };
    }, [doc, anchor, citationKey, citation?.page, scrollToPage]);

    // Full-document find: scan page by page, publishing results as they come in so
    // the first matches are usable before a long PDF finishes.
    useEffect(() => {
        if (!doc || needles.length === 0) return;

        let cancelled = false;
        void (async () => {
            const list: { page: number; boxes: Box[] }[] = [];
            for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
                if (cancelled) return;
                const pdfPage = await doc.getPage(pageNumber);
                const content = await pdfPage.getTextContent();
                if (cancelled) return;
                const pageHits = searchBoxes(pdfPage, content, needles);
                if (pageHits.length === 0) continue;
                for (const boxes of pageHits) list.push({ page: pageNumber, boxes });
                setHits({ key: termKey, list: [...list] });
                if (list.length >= MAX_MATCHES) return;
            }
            if (!cancelled) setHits({ key: termKey, list });
        })();

        return () => {
            cancelled = true;
        };
    }, [doc, needles, termKey]);

    useEffect(() => report(matches.length), [matches, report]);

    // Rest on the match the find bar points at.
    useEffect(() => {
        if (!currentHit) return;
        scrollToPage(currentHit.page, topOfBoxes(currentHit.boxes));
    }, [currentHit, scrollToPage]);

    if (error) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-400">
                This PDF could not be rendered ({error}).
            </div>
        );
    }

    return (
        <div className="relative flex h-full flex-col">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-3 py-1.5">
                <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">
                    {doc ? `${currentPage}/${doc.numPages} page${doc.numPages > 1 ? 's' : ''}` : 'Loading…'}
                </span>
                {doc && (
                    <div className="ml-2">
                        <JumpToInput unit="page" max={doc.numPages} onJump={page => scrollToPage(page)} />
                    </div>
                )}
                {highlight && (
                    <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-mono text-yellow-800">
                        highlighted on page {highlight.page}
                    </span>
                )}
                {matches.length > 0 && (
                    <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-mono text-orange-800">
                        {matches.length}
                        {matches.length >= MAX_MATCHES ? '+' : ''} match{matches.length > 1 ? 'es' : ''}
                        {currentHit ? ` · page ${currentHit.page}` : ''}
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
                {!doc ? (
                    <div className="flex h-full items-center justify-center text-slate-300">
                        <Icon name="spinner" className="w-5 h-5 animate-spin" />
                    </div>
                ) : (
                    Array.from({ length: doc.numPages }, (_, i) => i + 1).map(pageNumber => (
                        <PageView
                            key={pageNumber}
                            doc={doc}
                            pageNumber={pageNumber}
                            scale={scale}
                            boxes={highlight?.page === pageNumber ? highlight.boxes : []}
                            active={highlight?.page === pageNumber}
                            hits={(hitsByPage.get(pageNumber) ?? []).map(hit => hit.boxes)}
                            activeHit={(hitsByPage.get(pageNumber) ?? []).findIndex(hit => hit.index === activeHit)}
                            placeholder={placeholder}
                            rotation={rotation.degreesFor(pageNumber)}
                            priority={
                                (targetPage != null && Math.abs(targetPage - pageNumber) <= 1) ||
                                currentHit?.page === pageNumber
                            }
                            registerRef={(page, el) => {
                                if (el) pageRefs.current.set(page, el);
                                else pageRefs.current.delete(page);
                            }}
                        />
                    ))
                )}
            </div>
        </div>
    );
};
