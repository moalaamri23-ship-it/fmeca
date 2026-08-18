import React from 'react';
import { Icon } from './Icon';

/**
 * One control per field, and nothing else.
 *
 * The field is already crowded — a label, a wand, a textarea, and in the table a
 * column two hundred pixels wide. So the citation feature gets a single small
 * button, sitting beside the field's label where it covers none of the text,
 * and it says everything by how it looks:
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
                'flex shrink-0 items-center gap-0.5 leading-none transition',
                // Evidence is worth seeing without hunting for it; an empty field's
                // button stays out of the way exactly like the wand.
                has || running ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                state === 'stale'
                    ? 'text-amber-600 hover:text-amber-700'
                    : state === 'cited'
                    ? 'text-brand-600 hover:text-brand-700'
                    : 'text-slate-300 hover:text-brand-600',
                className,
            ].join(' ')}
        >
            <Icon
                name={running ? 'spinner' : 'quote'}
                className={running ? 'w-3 h-3 animate-spin' : 'w-3 h-3'}
            />
            {has && count > 0 && <span className="text-[9px] font-bold leading-none">{count}</span>}
        </button>
    );
};
