import React from 'react';
import { Subsystem, BreakdownRow, BreakdownMatch } from '../types';

interface FunctionBreakdownModalProps {
    sub: Subsystem;
    onClose: () => void;
    onRedecompose: () => void;
    isRedecomposing: boolean;
    onMatch: () => void;
    isMatching: boolean;
    matchResults: BreakdownMatch[] | null;
    onGenerateFF: (row: BreakdownRow) => void;
    generatingRowId: string | null;
}

export const FunctionBreakdownModal: React.FC<FunctionBreakdownModalProps> = ({
    sub,
    onClose,
    onRedecompose,
    isRedecomposing,
    onMatch,
    isMatching,
    matchResults,
    onGenerateFF,
    generatingRowId,
}) => {
    const rows: BreakdownRow[] = sub.functionBreakdown ?? [];

    // Build a lookup: rowId → matched Failure desc[]
    const matchMap = React.useMemo(() => {
        if (!matchResults) return null;
        const failById = new Map(sub.failures.map(f => [f.id, f.desc]));
        const map = new Map<string, string[]>();
        for (const m of matchResults) {
            map.set(m.rowId, m.failureIds.map(id => failById.get(id) ?? '').filter(Boolean));
        }
        return map;
    }, [matchResults, sub.failures]);

    return (
        <div
            className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center"
            onClick={onClose}
        >
            <div
                className="bg-white rounded-xl shadow-2xl w-[860px] max-h-[90vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">
                            Function Breakdown — {sub.name || 'Subsystem'}
                        </h2>
                        <p className="text-xs text-slate-400 mt-0.5">
                            {rows.length === 0
                                ? 'No breakdown yet — click Re-decompose to generate one.'
                                : `${rows.length} function/standard pair${rows.length !== 1 ? 's' : ''}`}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100"
                    >
                        &times;
                    </button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 p-5 space-y-4">
                    {/* Function description */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">
                            Function Description
                        </label>
                        <textarea
                            readOnly
                            value={sub.func || ''}
                            className="w-full min-h-[72px] border border-slate-200 rounded px-3 py-2 text-sm bg-slate-50/40 text-slate-700 outline-none resize-none"
                        />
                    </div>

                    {/* Action row */}
                    <div className="flex items-center justify-between gap-2">
                        <button
                            onClick={onRedecompose}
                            disabled={isRedecomposing || !sub.func?.trim()}
                            className="text-xs px-3 py-1.5 rounded border font-semibold text-brand-600 border-brand-200 bg-white hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            {isRedecomposing ? 'Decomposing…' : 'Re-decompose'}
                        </button>
                        <button
                            onClick={onMatch}
                            disabled={isMatching || rows.length === 0 || sub.failures.filter(f => f.desc).length === 0}
                            className="text-xs px-3 py-1.5 rounded border font-semibold text-slate-600 border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            {isMatching ? 'Matching…' : 'Match Failures to Breakdown'}
                        </button>
                    </div>

                    {/* Breakdown table */}
                    {rows.length > 0 && (
                        <div className="border rounded-lg overflow-hidden">
                            <table className="w-full text-sm border-collapse">
                                <thead className="bg-slate-50 text-slate-500 text-xs font-bold uppercase">
                                    <tr>
                                        <th className="p-2 border-r text-left w-1/2">Function / Expectation</th>
                                        <th className="p-2 text-left">Matched Failures</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map(r => {
                                        const matched = matchMap?.get(r.id);
                                        return (
                                            <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50/30">
                                                <td className="p-2 border-r align-top">
                                                    <div className="text-slate-800 font-medium">
                                                        {r.snippet || r.function}
                                                    </div>
                                                    {r.standard && (
                                                        <div className="text-xs text-slate-500 mt-0.5">{r.standard}</div>
                                                    )}
                                                </td>
                                                <td className="p-2 align-top">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="flex-1">
                                                            {matchMap === null ? (
                                                                <span className="text-slate-300 text-xs italic">—</span>
                                                            ) : matched && matched.length > 0 ? (
                                                                <ul className="space-y-0.5">
                                                                    {matched.map((desc, i) => (
                                                                        <li key={i} className="text-slate-700 text-xs">{desc}</li>
                                                                    ))}
                                                                </ul>
                                                            ) : (
                                                                <span className="text-amber-600 text-xs font-medium">No match found</span>
                                                            )}
                                                        </div>
                                                        <button
                                                            onClick={() => onGenerateFF(r)}
                                                            disabled={generatingRowId === r.id}
                                                            title="Generate a Functional Failure for this functional aspect"
                                                            className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-brand-200 text-brand-600 bg-white hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                                                        >
                                                            {generatingRowId === r.id ? '…' : '+ FF'}
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t flex items-center justify-end bg-slate-50/50 rounded-b-xl">
                    <button
                        onClick={onClose}
                        className="text-xs px-3 py-1.5 rounded border text-slate-600 border-slate-200 hover:bg-slate-100 transition"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
