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
 *   flagged          — red: a line nothing supports, or a recommendation the PM
 *                      program already covers. A flag nobody sees is not a flag,
 *                      and nobody opens a modal for a field they think is fine
 *   stale            — amber: the field was edited after the evidence was found
 *
 * Clicking always ends in the same place: the citations modal. The first click
 * has to search first, which is what the spinner is for; afterwards the modal
 * opens straight away and re-searching is a button inside it.
 */
export type CiteState = 'none' | 'running' | 'cited' | 'flagged' | 'stale';

export const CiteButton: React.FC<{
    state: CiteState;
    count: number;
    onClick: () => void;
    className?: string;
}> = ({ state, count, onClick, className = '' }) => {
    const running = state === 'running';
    const has = state === 'cited' || state === 'stale' || state === 'flagged';

    const title = running
        ? 'Searching the references for this text…'
        : state === 'stale'
        ? `${count} citation${count === 1 ? '' : 's'} — found before this field was edited`
        : state === 'flagged'
        ? count === 0
            ? 'Nothing in the sources supports this field'
            : `${count} citation${count === 1 ? '' : 's'} — one or more lines need attention`
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
                    : state === 'flagged'
                    ? 'text-red-600 hover:text-red-700'
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

/**
 * One control for the whole card.
 *
 * Citing a subsystem properly means clicking five, ten, fifty buttons — Specs,
 * Function, and then Current Controls and Mitigation on every failure mode
 * below. That is the same request repeated, so it gets one button, beside the
 * subsystem's own name, that runs them all and then opens a single modal
 * holding every field's evidence at once.
 *
 * It reads the same way as a field's button, only summed: red if any field has
 * a line nothing supports, amber if any is stale, brand-coloured with the total
 * once there is evidence — and, like the wand and the field buttons beside it,
 * it stays out of the way until there is either evidence to announce or a
 * pointer on the card.
 */
export const BulkCiteButton: React.FC<{
    state: CiteState;
    count: number;
    /** How many fields on this card can be cited. Zero disables the button. */
    fields: number;
    onClick: () => void;
}> = ({ state, count, fields, onClick }) => {
    const running = state === 'running';
    const has = state === 'cited' || state === 'stale' || state === 'flagged';
    const disabled = running || fields === 0;

    const title = fields === 0
        ? 'Nothing on this subsystem has enough text to cite yet'
        : running
        ? 'Searching the references for every field on this subsystem…'
        : state === 'stale'
        ? `${count} citation${count === 1 ? '' : 's'} across ${fields} field${fields === 1 ? '' : 's'} — some were found before the field was edited`
        : state === 'flagged'
        ? `${count} citation${count === 1 ? '' : 's'} across ${fields} field${fields === 1 ? '' : 's'} — one or more lines need attention`
        : state === 'cited'
        ? `${count} citation${count === 1 ? '' : 's'} across ${fields} field${fields === 1 ? '' : 's'}`
        : `Cite every field on this subsystem — specs, function, and each mode's controls and mitigation (${fields})`;

    return (
        <button
            type="button"
            onClick={e => {
                e.stopPropagation();
                if (!disabled) onClick();
            }}
            disabled={disabled}
            title={title}
            className={[
                'flex shrink-0 items-center gap-0.5 leading-none transition disabled:cursor-not-allowed',
                has || running ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                state === 'stale'
                    ? 'text-amber-600 hover:text-amber-700'
                    : state === 'flagged'
                    ? 'text-red-600 hover:text-red-700'
                    : state === 'cited'
                    ? 'text-brand-600 hover:text-brand-700'
                    : fields === 0
                    ? 'text-slate-200'
                    : 'text-slate-300 hover:text-brand-600',
            ].join(' ')}
        >
            <Icon
                name={running ? 'spinner' : 'layers'}
                className={running ? 'w-3 h-3 animate-spin' : 'w-3 h-3'}
            />
            {!running && count > 0 && <span className="text-[9px] font-bold leading-none">{count}</span>}
        </button>
    );
};
