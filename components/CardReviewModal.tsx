import React, { useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { ReviewDecision, ReviewFlag } from '../services/CardReview';
import { isDecided } from '../services/CardReview';
import type { FunctionClass } from '../services/KnowledgeCards';

const CLASSES: FunctionClass[] = ['primary', 'containment', 'protection', 'control'];

/**
 * The engineer's review of a knowledge file's subsystem cards, between the
 * extraction agent's draft and MasterGen. Each flag is a question only the
 * engineer can answer: is this component duty a function of its own, and does
 * this protective duty belong where the agent put it.
 *
 * Suggested duties (the model's pick) must be answered. The remaining component
 * duties default to "part of an existing function" and sit collapsed, because
 * nearly all of them are; they stay one click away for the case the model missed.
 */
export const CardReviewModal: React.FC<{
    flags: ReviewFlag[];
    /** Ids of uncovered duties the model suggests adding. */
    suggested: Set<string>;
    initial: Record<string, ReviewDecision>;
    onGenerate: (decisions: Record<string, ReviewDecision>) => void;
    onGenerateAnyway: () => void;
    onDownload: (decisions: Record<string, ReviewDecision>) => void;
    onClose: () => void;
}> = ({ flags, suggested, initial, onGenerate, onGenerateAnyway, onDownload, onClose }) => {
    const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>(() => {
        const d = { ...initial };
        // Unsuggested component duties default to "part of an existing function".
        for (const f of flags) if (f.kind === 'uncovered' && !suggested.has(f.id) && !d[f.id]) d[f.id] = { action: 'ignore' };
        return d;
    });
    const [showOthers, setShowOthers] = useState(false);
    const set = (id: string, d: ReviewDecision) => setDecisions(prev => ({ ...prev, [id]: d }));

    const foreign = flags.filter(f => f.kind === 'foreign');
    const primaryList = flags.filter(f => f.kind === 'uncovered' && suggested.has(f.id));
    const others = flags.filter(f => f.kind === 'uncovered' && !suggested.has(f.id));
    const required = [...foreign, ...primaryList];
    const open = required.filter(f => !isDecided(f, decisions)).length;

    const bySubsystem = useMemo(() => {
        const m = new Map<string, ReviewFlag[]>();
        for (const f of [...foreign, ...primaryList]) m.set(f.subsystem, [...(m.get(f.subsystem) || []), f]);
        return [...m.entries()];
    }, [flags, suggested]);

    const choice = (active: boolean) =>
        `px-2.5 py-1 rounded border text-xs font-bold transition ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`;

    const renderFlag = (f: ReviewFlag) => {
        const d = decisions[f.id];
        if (f.kind === 'foreign') {
            return (
                <div key={f.id} className="p-3 border-b last:border-b-0">
                    <div className="text-[10px] font-bold uppercase text-amber-600 mb-1">Protection owned by another subsystem</div>
                    <div className="text-sm text-slate-700">{f.text.replace(/\s*\[S\d+[^\]]*\]/g, '')}</div>
                    <div className="text-xs text-slate-400 mt-0.5">Names <span className="font-semibold text-slate-600">{f.owner}</span> as the one acting.</div>
                    <div className="flex gap-2 mt-2">
                        <button className={choice(d?.action === 'move')} onClick={() => set(f.id, { action: 'move' })}>Move to {f.owner}</button>
                        <button className={choice(d?.action === 'keep')} onClick={() => set(f.id, { action: 'keep' })}>Keep: own device</button>
                    </div>
                </div>
            );
        }
        const cls = d?.action === 'add' ? d.cls : (f.suggestedClass || 'primary');
        return (
            <div key={f.id} className="p-3 border-b last:border-b-0">
                <div className="text-[10px] font-bold uppercase text-brand-600 mb-1">Duty not covered by a function</div>
                <div className="text-sm text-slate-700"><span className="font-semibold">{f.item}</span>: {f.duty}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                    <button className={choice(d?.action === 'add')} onClick={() => set(f.id, { action: 'add', cls })}>Add as function</button>
                    <select
                        value={cls}
                        onChange={e => set(f.id, { action: 'add', cls: e.target.value as FunctionClass })}
                        className="border border-slate-200 rounded px-2 py-1 text-xs outline-none focus:border-brand-500"
                    >
                        {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button className={choice(d?.action === 'ignore')} onClick={() => set(f.id, { action: 'ignore' })}>Part of an existing function</button>
                </div>
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center" onMouseDown={onClose}>
            <div className="bg-white rounded-xl w-[92vw] max-w-2xl max-h-[85vh] flex flex-col border shadow-2xl" onMouseDown={e => e.stopPropagation()}>
                <div className="bg-slate-900 text-white px-5 py-4 rounded-t-xl flex items-start justify-between">
                    <div>
                        <div className="font-bold text-sm">Review knowledge file before MasterGen</div>
                        <div className="text-xs text-slate-400 mt-0.5">
                            {required.length ? `${required.length} item${required.length === 1 ? '' : 's'} need your decision` : 'Nothing needs a decision'}
                            {open > 0 && ` · ${open} open`}
                        </div>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none">×</button>
                </div>

                <div className="flex-1 overflow-y-auto scroll-thin bg-slate-50 p-4 space-y-4">
                    {bySubsystem.map(([sub, list]) => (
                        <div key={sub} className="bg-white rounded border border-slate-200 overflow-hidden">
                            <div className="bg-slate-50 px-3 py-2 border-b text-xs font-bold text-slate-600">{sub}</div>
                            {list.map(renderFlag)}
                        </div>
                    ))}
                    {others.length > 0 && (
                        <div className="bg-white rounded border border-slate-200 overflow-hidden">
                            <button onClick={() => setShowOthers(v => !v)} className="w-full text-left px-3 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50 flex items-center gap-2">
                                <Icon name={showOthers ? 'chevronDown' : 'chevronRight'} className="w-3.5 h-3.5" />
                                Other component duties ({others.length}) — treated as part of an existing function
                            </button>
                            {showOthers && others.map(f => (
                                <div key={f.id} className="border-t">
                                    <div className="px-3 pt-2 text-[10px] font-bold uppercase text-slate-400">{f.subsystem}</div>
                                    {renderFlag(f)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="px-5 py-3 border-t flex flex-wrap items-center justify-between gap-2">
                    <button onClick={() => onDownload(decisions)} className="bg-white border text-slate-600 px-3 py-2 rounded font-bold text-xs flex items-center gap-2 hover:bg-slate-50">
                        <Icon name="download" className="w-4 h-4" /> Download corrected file
                    </button>
                    <div className="flex gap-2">
                        <button onClick={onGenerateAnyway} className="px-3 py-2 text-xs font-bold border rounded text-slate-600 hover:bg-slate-50">Generate anyway</button>
                        <button
                            onClick={() => onGenerate(decisions)}
                            disabled={open > 0}
                            className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-4 py-2 rounded shadow font-bold text-xs inline-flex items-center gap-2 hover:shadow-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <Icon name="bolt" className="w-4 h-4" /> Generate FMECA
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
