import React, { useMemo, useState } from 'react';
import { Subsystem, BreakdownRow, Failure, FailureCategory } from '../types';

interface FunctionBreakdownModalProps {
    sub: Subsystem;
    onClose: () => void;
    onRedecompose: () => void;
    onLinkOrphan: (failureId: string, breakdownId: string) => void;
    onUnlink: (failureId: string) => void;
    isRedecomposing: boolean;
}

const CATEGORY_BG: Record<FailureCategory, string> = {
    'Total Failure': 'bg-red-50 text-red-700 border-red-200',
    'Partial/Degraded Failure': 'bg-amber-50 text-amber-700 border-amber-200',
    'Erratic Failure': 'bg-blue-50 text-blue-700 border-blue-200',
    'Secondary/Conditional Failure': 'bg-purple-50 text-purple-700 border-purple-200',
};

export const FunctionBreakdownModal: React.FC<FunctionBreakdownModalProps> = ({
    sub,
    onClose,
    onRedecompose,
    onLinkOrphan,
    onUnlink,
    isRedecomposing,
}) => {
    const rows: BreakdownRow[] = sub.functionBreakdown ?? [];
    const failures = sub.failures;

    // Group failures by their linked breakdownId.
    const linkedByRow = useMemo(() => {
        const map = new Map<string, Failure[]>();
        rows.forEach(r => map.set(r.id, []));
        failures.forEach(f => {
            const id = f.sourcePair?.breakdownId;
            if (id && map.has(id)) map.get(id)!.push(f);
        });
        return map;
    }, [rows, failures]);

    const orphans = failures.filter(f => !f.sourcePair?.breakdownId);
    const totalRows = rows.length;
    const filledRows = rows.filter(r => (linkedByRow.get(r.id)?.length ?? 0) > 0).length;

    return (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-[920px] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">Function Breakdown — {sub.name || 'Subsystem'}</h2>
                        <p className="text-xs text-slate-400 mt-0.5">
                            {totalRows === 0
                                ? 'No breakdown yet — click Re-decompose to generate one.'
                                : `${filledRows} of ${totalRows} rows linked to a Functional Failure`}
                        </p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100">&times;</button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 p-5 space-y-5">
                    {/* Function description (read-only) */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Function Description</label>
                        <textarea
                            readOnly
                            value={sub.func || ''}
                            className="w-full min-h-[80px] border border-slate-200 rounded px-3 py-2 text-sm bg-slate-50/40 text-slate-700 outline-none resize-none"
                        />
                    </div>

                    {/* Action row */}
                    <div className="flex items-center justify-end">
                        <button
                            onClick={onRedecompose}
                            disabled={isRedecomposing}
                            className="text-xs px-3 py-1.5 rounded border font-semibold text-brand-600 border-brand-200 bg-white hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            {isRedecomposing ? 'Decomposing…' : 'Re-decompose function description'}
                        </button>
                    </div>

                    {/* Breakdown table */}
                    {rows.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">Breakdown</p>
                            <div className="border rounded-lg overflow-hidden">
                                <table className="w-full text-sm border-collapse">
                                    <thead className="bg-slate-50 text-slate-500 text-xs font-bold uppercase">
                                        <tr>
                                            <th className="p-2 border-r text-left w-2/5">Function / Expectation</th>
                                            <th className="p-2 border-r text-left w-1/6">Category</th>
                                            <th className="p-2 border-r text-left w-2/5">Functional Failure</th>
                                            <th className="p-2 text-center w-16">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.map((r) => {
                                            const linked = linkedByRow.get(r.id) ?? [];
                                            const filled = linked.length > 0;
                                            return (
                                                <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50/30">
                                                    <td className="p-2 border-r align-top">
                                                        <div className="text-slate-800">{r.snippet || r.function}</div>
                                                        {r.standard && (
                                                            <div className="text-xs text-slate-500 mt-0.5">{r.standard}</div>
                                                        )}
                                                    </td>
                                                    <td className="p-2 border-r align-top">
                                                        <span className={`inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${CATEGORY_BG[r.category]}`}>
                                                            {r.category}
                                                        </span>
                                                    </td>
                                                    <td className="p-2 border-r align-top">
                                                        {filled ? (
                                                            <div className="space-y-1">
                                                                {linked.map(f => (
                                                                    <div key={f.id} className="flex items-start justify-between gap-2">
                                                                        <span className="text-slate-700">{f.desc || <em className="text-slate-400">(empty)</em>}</span>
                                                                        <button
                                                                            onClick={() => onUnlink(f.id)}
                                                                            className="text-[10px] text-slate-400 hover:text-red-600 shrink-0"
                                                                            title="Unlink this FF from the row"
                                                                        >
                                                                            unlink
                                                                        </button>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        ) : (
                                                            <em className="text-slate-400">— no FF linked</em>
                                                        )}
                                                    </td>
                                                    <td className="p-2 text-center align-top">
                                                        {filled
                                                            ? <span className="text-emerald-600 font-bold" title="Linked">✓</span>
                                                            : <span className="text-slate-300 font-bold" title="Empty">✗</span>}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Unlinked failures */}
                    {orphans.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">
                                Unlinked Functional Failures ({orphans.length})
                            </p>
                            <p className="text-xs text-slate-400 mb-2">
                                These FFs have no link to a breakdown row — typed manually, imported from Excel, or unlinked after re-decomposition. Use the dropdown to assign each to a row.
                            </p>
                            <div className="border rounded-lg overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead className="bg-slate-50 text-slate-500 text-xs font-bold uppercase">
                                        <tr>
                                            <th className="p-2 border-r text-left">Failure</th>
                                            <th className="p-2 text-left w-72">Match to row</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {orphans.map(f => (
                                            <tr key={f.id} className="border-b border-slate-100">
                                                <td className="p-2 border-r text-slate-700">{f.desc || <em className="text-slate-400">(empty)</em>}</td>
                                                <td className="p-2">
                                                    <select
                                                        value=""
                                                        onChange={e => { if (e.target.value) onLinkOrphan(f.id, e.target.value); }}
                                                        className="w-full border border-slate-200 rounded px-2 py-1 text-xs outline-none focus:border-blue-500"
                                                    >
                                                        <option value="">Select a breakdown row…</option>
                                                        {rows.map(r => (
                                                            <option key={r.id} value={r.id}>
                                                                [{r.category}] {r.snippet || r.function}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
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
