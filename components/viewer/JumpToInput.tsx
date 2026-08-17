import React, { useId, useState } from 'react';

/**
 * "Go to <unit>" box for the viewer toolbars: type a number, press Enter, land
 * there. Every renderer has a different unit — a PDF has pages, a spreadsheet
 * rows, plain text lines — but the box behaves the same everywhere, so the
 * shared part lives here and each canvas supplies only its unit, its count and
 * how to scroll.
 */
export const JumpToInput: React.FC<{
    unit: string;
    max: number;
    onJump: (target: number) => void;
}> = ({ unit, max, onJump }) => {
    const [value, setValue] = useState('');
    const id = useId();

    // Nothing to navigate in a one-page (or empty) document.
    if (max < 2) return null;

    return (
        <form
            onSubmit={e => {
                e.preventDefault();
                const target = Number.parseInt(value, 10);
                if (!Number.isFinite(target)) return;
                // Out-of-range entries land on the nearest real target rather
                // than silently doing nothing.
                const clamped = Math.min(Math.max(target, 1), max);
                setValue(String(clamped));
                onJump(clamped);
            }}
            className="flex shrink-0 items-center gap-1"
        >
            <label htmlFor={id} className="whitespace-nowrap text-[10px] font-bold uppercase text-slate-400">
                Go to {unit}
            </label>
            <input
                id={id}
                type="text"
                inputMode="numeric"
                value={value}
                onChange={e => setValue(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="#"
                title={`Type a ${unit} number (1–${max}) and press Enter`}
                className="w-12 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-center text-[10px] font-mono text-slate-700 outline-none focus:border-brand-500"
            />
        </form>
    );
};
