import React from 'react';
import { Subsystem, BreakdownRow, BreakdownMatch, Failure, Project } from '../types';
import { checkBreakdown, checkProject, findingsByRow, CoverageFinding } from '../services/CoverageCheck';

interface FunctionBreakdownModalProps {
    sub: Subsystem;
    onClose: () => void;
    onRedecompose: () => void;
    isRedecomposing: boolean;
    onMatch: () => void;
    isMatching: boolean;
    matchResults: BreakdownMatch[] | null;
    onGenerateFF: (row: BreakdownRow) => void;
    /** Rows with a "+ FF" call in flight. A set, so several rows can run at once. */
    generatingRowIds: Set<string>;
    /** True while Auto-Fill owns this subsystem — its AI actions are held. */
    locked?: boolean;
    /** The whole project, so a setpoint stated differently in a sibling subsystem shows up here. */
    project?: Project | null;
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
    generatingRowIds,
    locked = false,
    project = null,
}) => {
    const rows: BreakdownRow[] = sub.functionBreakdown ?? [];

    // Build a lookup: rowId → matched Failure[].
    //
    // This used to map to f.desc and hand the table bare strings, so failedState,
    // parameter, and needsReview never reached the render. A placeholder was
    // indistinguishable from analysis on precisely the screen where the breakdown
    // gets judged. Carry the whole object.
    const matchMap = React.useMemo(() => {
        if (!matchResults) return null;
        const failById = new Map(sub.failures.map(f => [f.id, f]));
        const map = new Map<string, Failure[]>();
        for (const m of matchResults) {
            map.set(m.rowId, m.failureIds.map(id => failById.get(id)).filter(Boolean) as Failure[]);
        }
        return map;
    }, [matchResults, sub.failures]);

    // Row-level findings, plus any cross-subsystem conflict that lands on one of
    // these rows. checkProject reports against every row carrying the disputed
    // parameter, so it needs no extra plumbing to reach the right line.
    const coverage = React.useMemo(() => {
        const own = checkBreakdown(rows, sub.failures, matchResults);
        const rowIds = new Set(rows.map(r => r.id));
        const cross = project ? checkProject(project).filter(f => rowIds.has(f.rowId)) : [];
        return findingsByRow([...own, ...cross]);
    }, [rows, sub.failures, matchResults, project]);

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
                            disabled={locked || isRedecomposing || !sub.func?.trim()}
                            className="text-xs px-3 py-1.5 rounded border font-semibold text-brand-600 border-brand-200 bg-white hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            {isRedecomposing ? 'Decomposing…' : 'Re-decompose'}
                        </button>
                        <button
                            onClick={onMatch}
                            disabled={locked || isMatching || rows.length === 0 || sub.failures.filter(f => f.desc).length === 0}
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
                                                    <div className="flex flex-wrap items-center gap-1 mt-1">
                                                        {r.functionClass && (
                                                            <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-semibold">
                                                                {r.functionClass}
                                                            </span>
                                                        )}
                                                        {r.evidence === 'hidden' && (
                                                            <span title="Hidden function — failure is not evident to operating staff and needs a failure-finding task" className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 font-semibold">
                                                                Hidden
                                                            </span>
                                                        )}
                                                        {r.quantified === false && (
                                                            <span title="Performance standard is not measurable (JA1011 5.1.2)" className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 font-semibold">
                                                                Unquantified
                                                            </span>
                                                        )}
                                                    </div>
                                                    {/* The parsed requirements are what the failures are derived from,
                                                        so showing them makes an uncovered one visible as a gap rather
                                                        than as an absence nobody can see. */}
                                                    {(r.standardParameters?.length ?? 0) > 0 && (
                                                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                                                            {r.standardParameters!.map((p, i) => (
                                                                <span
                                                                    key={i}
                                                                    title={`Requirement: ${p.name} — ${p.value}${p.unit ? ' ' + p.unit : ''} (${p.bound})`}
                                                                    className="text-[9px] px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-500 font-mono"
                                                                >
                                                                    {p.name} {p.value}{p.unit ? ` ${p.unit}` : ''}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {(coverage.get(r.id)?.length ?? 0) > 0 && (
                                                        <ul className="mt-1.5 space-y-0.5">
                                                            {coverage.get(r.id)!.map((c: CoverageFinding, i: number) => (
                                                                <li
                                                                    key={i}
                                                                    title={c.detail}
                                                                    className={`text-[10px] leading-snug ${c.severity === 'conflict' ? 'text-rose-600' : c.severity === 'gap' ? 'text-amber-600' : 'text-slate-400'}`}
                                                                >
                                                                    {c.severity === 'info' ? '·' : '!'} {c.label} — {c.detail}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </td>
                                                <td className="p-2 align-top">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="flex-1">
                                                            {matchMap === null ? (
                                                                <span className="text-slate-300 text-xs italic">—</span>
                                                            ) : matched && matched.length > 0 ? (
                                                                <ul className="space-y-1">
                                                                    {matched.map(f => (
                                                                        <li key={f.id} className="text-xs">
                                                                            <span className={f.needsReview ? 'text-slate-400 line-through' : 'text-slate-700'}>{f.desc}</span>
                                                                            {(f.failedState || f.parameter || f.needsReview) && (
                                                                                <span className="inline-flex flex-wrap items-center gap-1 ml-1.5 align-middle">
                                                                                    {f.parameter && (
                                                                                        <span title="Requirement this failure violates" className="text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-mono">
                                                                                            {f.parameter}
                                                                                        </span>
                                                                                    )}
                                                                                    {f.failedState && (
                                                                                        <span title="Direction the requirement is violated in (JA1011 5.2)" className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-semibold">
                                                                                            {f.failedState.replace('_', ' ')}
                                                                                        </span>
                                                                                    )}
                                                                                    {f.needsReview && (
                                                                                        <span title="Template text saved before generation was fixed — a placeholder, not analysis. Regenerate this subsystem." className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                                                                                            Placeholder
                                                                                        </span>
                                                                                    )}
                                                                                </span>
                                                                            )}
                                                                        </li>
                                                                    ))}
                                                                </ul>
                                                            ) : (
                                                                <span className="text-amber-600 text-xs font-medium">No failures generated</span>
                                                            )}
                                                        </div>
                                                        <button
                                                            onClick={() => onGenerateFF(r)}
                                                            disabled={locked || generatingRowIds.has(r.id)}
                                                            title="Generate a Functional Failure for this functional aspect"
                                                            className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-brand-200 text-brand-600 bg-white hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                                                        >
                                                            {generatingRowIds.has(r.id) ? '…' : '+ FF'}
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
