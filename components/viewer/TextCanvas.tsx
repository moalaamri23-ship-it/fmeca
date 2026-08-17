import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { locateText } from './locate';
import { JumpToInput } from './JumpToInput';
import { useSearchTarget } from './searchContext';
import { findMatches } from './textSearch';
import type { ViewerCitation } from '../../types';

/**
 * Scroll the container so line `line` of `content` sits at the top.
 *
 * The body is one wrapped <pre>, so a line is not a fixed number of pixels down
 * — its position has to be measured. Highlighting splits the text across
 * several nodes, but those nodes still concatenate to exactly `content`, so a
 * character offset maps onto a DOM position by walking them in order.
 */
function scrollToLine(
    scroller: HTMLDivElement | null,
    body: HTMLElement | null,
    content: string,
    line: number
): void {
    if (!scroller || !body) return;
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node = walker.nextNode();
    while (node) {
        const length = node.nodeValue?.length ?? 0;
        if (seen + length > offset) break;
        seen += length;
        node = walker.nextNode();
    }
    if (!node) return;

    const start = offset - seen;
    const range = document.createRange();
    range.setStart(node, start);
    // A collapsed range has no rect in some browsers — cover one character.
    range.setEnd(node, Math.min(node.nodeValue?.length ?? start, start + 1));
    scroller.scrollTop += range.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
}

const CITE_STYLE = { background: 'rgba(253,224,71,0.6)', outline: '1px solid rgba(234,179,8,0.6)', borderRadius: 2 };
const HIT_STYLE = { background: 'rgba(253,186,116,0.4)', borderRadius: 2 };
const HIT_ACTIVE_STYLE = { background: 'rgba(251,146,60,0.65)', outline: '1px solid rgb(234,88,12)', borderRadius: 2 };

/**
 * Renders a file's plain text with the cited span highlighted. Used for text and
 * code files, and as the fallback when a format has no renderer of its own.
 */
export const TextCanvas: React.FC<{
    content: string;
    fileId: string;
    citation: ViewerCitation | null;
    note?: string;
}> = ({ content, fileId, citation, note }) => {
    const markRef = useRef<HTMLSpanElement | null>(null);
    const hitRef = useRef<HTMLSpanElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLPreElement | null>(null);
    const anchor = citation?.quote?.trim() || citation?.anchor?.trim() || '';
    const { terms, active, report } = useSearchTarget();

    const span = useMemo(() => {
        if (!anchor) return null;
        const hit = locateText(content, anchor, fileId);
        return hit ? { start: hit.start, end: hit.end } : null;
    }, [content, anchor, fileId]);

    const hits = useMemo(() => findMatches(content, terms), [content, terms]);

    const lineCount = useMemo(() => content.split('\n').length, [content]);
    const jumpToLine = useCallback(
        (line: number) => scrollToLine(scrollRef.current, bodyRef.current, content, line),
        [content]
    );

    useEffect(() => report(hits.length), [hits, report]);

    useEffect(() => {
        markRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [span, citation?.id]);

    useEffect(() => {
        hitRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [hits, active]);

    // While searching, the matches own the highlighting — mixing them with the
    // citation highlight would make the current match hard to pick out.
    const body =
        hits.length > 0 ? (
            <>
                {hits.map((hit, i) => (
                    <span key={i}>
                        {content.slice(i === 0 ? 0 : hits[i - 1].end, hit.start)}
                        <span ref={i === active ? hitRef : undefined} style={i === active ? HIT_ACTIVE_STYLE : HIT_STYLE}>
                            {content.slice(hit.start, hit.end)}
                        </span>
                    </span>
                ))}
                {content.slice(hits[hits.length - 1].end)}
            </>
        ) : span ? (
            <>
                {content.slice(0, span.start)}
                <span ref={markRef} style={CITE_STYLE}>{content.slice(span.start, span.end)}</span>
                {content.slice(span.end)}
            </>
        ) : (
            content
        );

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 px-3 py-1.5">
                <span className="shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">{note ?? 'Text'}</span>
                {span && hits.length === 0 && (
                    <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-mono text-yellow-800">
                        passage highlighted
                    </span>
                )}
                {hits.length > 0 && (
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-mono text-orange-800">
                        {hits.length} match{hits.length > 1 ? 'es' : ''}
                    </span>
                )}
                <div className="ml-auto">
                    <JumpToInput unit="line" max={lineCount} onJump={jumpToLine} />
                </div>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-auto scroll-thin bg-slate-100 p-4">
                <pre
                    ref={bodyRef}
                    className="mx-auto max-w-3xl whitespace-pre-wrap rounded-lg border border-slate-200 bg-white px-6 py-6 font-mono text-xs leading-relaxed text-slate-700 shadow-sm"
                >
                    {body}
                </pre>
            </div>
        </div>
    );
};
