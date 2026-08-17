import React, { useRef } from 'react';
import { Icon } from '../Icon';

const BUTTON = 'rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700';
const HOLD_MS = 500;

/**
 * Turn the current page, or hold to turn the whole document.
 *
 * The hold fires on its own timer rather than on release, so the document turns
 * under the reader's finger and they know the press has been understood.
 */
const FlipButton: React.FC<{ onFlip: () => void; onFlipAll: () => void }> = ({ onFlip, onFlipAll }) => {
    const held = useRef(false);
    const timer = useRef<number | undefined>(undefined);

    const start = () => {
        held.current = false;
        timer.current = window.setTimeout(() => {
            held.current = true;
            onFlipAll();
        }, HOLD_MS);
    };
    const stop = () => window.clearTimeout(timer.current);

    return (
        <button
            onPointerDown={start}
            onPointerUp={stop}
            onPointerLeave={stop}
            onClick={() => {
                // The hold already acted; the release must not turn the page again.
                if (held.current) {
                    held.current = false;
                    return;
                }
                onFlip();
            }}
            title="Rotate this page — hold to rotate every page"
            className={BUTTON}
        >
            <Icon name="rotate" className="w-3.5 h-3.5" />
        </button>
    );
};

/**
 * The right-hand side of a page viewer's toolbar: zoom, rotation, and a way
 * back to the document as it was.
 */
export const ViewerControls: React.FC<{
    zoom: number;
    onZoom: (zoom: number) => void;
    onFlip: () => void;
    onFlipAll: () => void;
    onReset: () => void;
    /** Whether anything has been zoomed or turned yet. */
    changed: boolean;
}> = ({ zoom, onZoom, onFlip, onFlipAll, onReset, changed }) => (
    <div className="flex items-center gap-1">
        <FlipButton onFlip={onFlip} onFlipAll={onFlipAll} />
        <button
            onClick={onReset}
            disabled={!changed}
            title="Reset zoom and rotation"
            className={`${BUTTON} disabled:pointer-events-none disabled:opacity-40`}
        >
            <Icon name="undo" className="w-3.5 h-3.5" />
        </button>
        <button
            onClick={() => onZoom(Math.max(0.4, zoom - 0.2))}
            title="Zoom out"
            className="rounded px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
            −
        </button>
        <span className="w-10 text-center text-[10px] font-mono text-slate-400">
            {Math.round(zoom * 100)}%
        </span>
        <button
            onClick={() => onZoom(Math.min(3, zoom + 0.2))}
            title="Zoom in"
            className="rounded px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
            +
        </button>
    </div>
);
