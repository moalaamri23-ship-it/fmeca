import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';

const THROTTLE_MS = 100;

/**
 * The page the reader is currently on: the first one still crossing the top of
 * the viewport. Every paged canvas marks its pages with `data-page`, so this
 * reads the same in a PDF and in a Word document.
 */
export function useVisiblePage(scrollRef: RefObject<HTMLElement | null>, pageCount: number): number {
    const [page, setPage] = useState(1);

    useEffect(() => {
        const scroller = scrollRef.current;
        if (!scroller || pageCount === 0) return;
        let last = 0;
        let trailing: number | undefined;

        const measure = () => {
            last = performance.now();
            const top = scroller.getBoundingClientRect().top;
            let current = 1;
            for (const el of scroller.querySelectorAll<HTMLElement>('[data-page]')) {
                current = Number(el.dataset.page);
                // A page stays current until its bottom edge leaves the top of
                // the viewport, so the number turns over as each page scrolls away.
                if (el.getBoundingClientRect().bottom >= top + 8) break;
            }
            setPage(current || 1);
        };

        // Throttled on a clock rather than on animation frames: those are paused
        // while the page is not being painted, and the number would then stop
        // moving in a background tab and come back stale.
        const onScroll = () => {
            window.clearTimeout(trailing);
            if (performance.now() - last >= THROTTLE_MS) measure();
            // The last scroll event of a gesture lands mid-throttle; this settles it.
            trailing = window.setTimeout(measure, THROTTLE_MS);
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        measure();
        return () => {
            scroller.removeEventListener('scroll', onScroll);
            window.clearTimeout(trailing);
        };
    }, [scrollRef, pageCount]);

    return page;
}

export interface PageRotation {
    /** How far this page is turned, in degrees. */
    degreesFor: (page: number) => number;
    /** Turn one page a quarter further clockwise. */
    flip: (page: number) => void;
    /** Give every page the turn this one has. */
    flipAll: (page: number) => void;
    reset: () => void;
    turned: boolean;
}

/**
 * Per-page rotation, with a setting that covers every page.
 *
 * A page keeps its own angle once it has been turned; pages that have not been
 * turned individually follow the document-wide one.
 */
export function usePageRotation(): PageRotation {
    const [state, setState] = useState<{ all: number; perPage: Record<number, number> }>({
        all: 0,
        perPage: {},
    });

    const degreesFor = useCallback((page: number) => state.perPage[page] ?? state.all, [state]);

    const flip = useCallback(
        (page: number) =>
            setState(s => ({
                ...s,
                perPage: { ...s.perPage, [page]: ((s.perPage[page] ?? s.all) + 90) % 360 },
            })),
        []
    );

    const flipAll = useCallback(
        (page: number) => setState(s => ({ all: s.perPage[page] ?? s.all, perPage: {} })),
        []
    );

    const reset = useCallback(() => setState({ all: 0, perPage: {} }), []);

    const turned = state.all !== 0 || Object.values(state.perPage).some(degrees => degrees !== 0);

    return useMemo(
        () => ({ degreesFor, flip, flipAll, reset, turned }),
        [degreesFor, flip, flipAll, reset, turned]
    );
}

/** A quarter turn swaps a page's footprint; a half turn leaves it as it was. */
export function isQuarterTurn(degrees: number): boolean {
    return degrees === 90 || degrees === 270;
}

/**
 * Turn a page that is not React's to render — the Word renderer builds its own
 * pages, so theirs are styled directly.
 *
 * The margins reserve the footprint the turn produces, so a turned page pushes
 * the pages after it down instead of overlapping them.
 */
export function applyPageRotation(page: HTMLElement, degrees: number): void {
    page.style.transform = '';
    page.style.margin = '';
    if (degrees === 0) return;

    const width = page.offsetWidth;
    const height = page.offsetHeight;
    page.style.transformOrigin = 'center';
    page.style.transform = `rotate(${degrees}deg)`;
    if (!isQuarterTurn(degrees)) return;
    page.style.margin = `${(width - height) / 2}px ${(height - width) / 2}px`;
}
