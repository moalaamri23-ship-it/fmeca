import React from 'react';
import { Icon } from './Icon';

/**
 * One control per field, and nothing else.
 *
 * The field is already crowded — a label, a wand, a textarea, and in the table a
 * column two hundred pixels wide. So the citation feature gets a single button
 * that says everything by how it looks:
 *
 *   nothing cited yet — faint, and only on hover, like the wand beside it
 *   searching        — a spinner in the same spot
 *   evidence found   — brand-coloured with its count, always visible, because a
 *                      field with evidence behind it should say so at a glance
 *   stale            — amber: the field was edited after the evidence was found
 *
 * Clicking always ends in the same place: the citations modal. The first click
 * has to search first, which is what the spinner is for; afterwards the modal
 * opens straight away and re-searching is a button inside it.
 */
export type CiteState = 'none' | 'running' | 'cited' | 'stale';

export const CiteButton: React.FC<{
    state: CiteState;
    count: number;
    onClick: () => void;
    className?: string;
}> = ({ state, count, onClick, className = '' }) => {
    const running = state === 'running';
    const has = state === 'cited' || state === 'stale';

    const title = running
        ? 'Searching the references for this text…'
        : state === 'stale'
        ? `${count} citation${count === 1 ? '' : 's'} — found before this field was edited`
        : state === 'cited'
        ? `${count} citation${count === 1 ? '' : 's'}`
        : 'Find citations for this text';

    return (
        <button
            type="button"
            onClick={e => {
                e.stopPropagation();
                if (!running) onClick();
            }}
            disabled={running}
            title={title}
            className={[
                'absolute top-2 flex items-center gap-0.5 rounded-full border bg-white p-1 transition',
                // Evidence is worth seeing without hunting for it; an empty field's
                // button stays out of the way exactly like the wand.
                has || running ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                state === 'stale'
                    ? 'border-amber-200 text-amber-600 hover:border-amber-300'
                    : state === 'cited'
                    ? 'border-brand-200 text-brand-600 hover:border-brand-300'
                    : 'border-transparent text-slate-300 hover:border-slate-200 hover:text-brand-600',
                className,
            ].join(' ')}
        >
            <Icon
                name={running ? 'spinner' : 'quote'}
                className={running ? 'w-4 h-4 animate-spin' : 'w-4 h-4'}
            />
            {has && count > 0 && <span className="pr-0.5 text-[9px] font-bold leading-none">{count}</span>}
        </button>
    );
};
