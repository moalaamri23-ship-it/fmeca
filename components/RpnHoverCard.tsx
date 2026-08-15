import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mode } from '../types';
import { parseRpnReason, rpnScoreDeltas, rpnTotal, RpnScoreDelta } from '../services/ProjectUtils';

/**
 * Hover surfaces for the Build page RPN cell.
 *
 * `mode.rpn` holds the POST-mitigation score; `mode.rpnBaseline` holds the score using
 * current controls only. Neither the baseline nor the stored `rpnReason` had any UI
 * before this, so an AI-scored mode looked identical to a hand-typed one.
 */

// ── Floating panel ───────────────────────────────────────────────────────────
// The Build table sits inside `overflow-x-auto`, which clips absolutely positioned
// children on both axes. Portal + fixed positioning off the trigger rect escapes it.

interface HoverPanelProps {
    rect: DOMRect;
    width: number;
    children: React.ReactNode;
}

const HoverPanel: React.FC<HoverPanelProps> = ({ rect, width, children }) => createPortal(
    <div
        style={{
            position: 'fixed',
            zIndex: 9999,
            width,
            ...(rect.top > window.innerHeight / 2
                ? { bottom: Math.max(10, window.innerHeight - rect.bottom) }
                : { top: Math.max(10, rect.top) }),
            ...(rect.left - width - 12 > 10
                ? { left: Math.max(10, rect.left - width - 12) }
                : { left: Math.min(rect.right + 12, Math.max(10, window.innerWidth - width - 10)) })
        }}
        className="bg-white border border-slate-200 rounded-xl shadow-2xl p-3 pointer-events-none text-left animate-enter"
    >
        {children}
    </div>,
    document.body
);

/** Shared open/close wiring — returns the trigger rect while hovered. */
const useHoverRect = () => {
    const [rect, setRect] = useState<DOMRect | null>(null);
    const ref = useRef<HTMLElement | null>(null);
    const open = useCallback(() => { if (ref.current) setRect(ref.current.getBoundingClientRect()); }, []);
    const close = useCallback(() => setRect(null), []);
    return { rect, ref, open, close };
};

// ── Shared bits ──────────────────────────────────────────────────────────────

const scoreBoxColor = (v: number) =>
    v >= 8 ? 'bg-red-50 border-red-300 text-red-700'
        : v >= 5 ? 'bg-amber-50 border-amber-300 text-amber-700'
            : 'bg-emerald-50 border-emerald-300 text-emerald-700';

const ScoreBox: React.FC<{ value: number; caption: string }> = ({ value, caption }) => (
    <div className="flex flex-col items-center gap-1">
        <div className={`w-9 h-9 grid place-items-center rounded-lg border font-mono font-bold text-sm ${scoreBoxColor(value)}`}>
            {value}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">{caption}</div>
    </div>
);

/** `[before] → [after]` when mitigation moved the score, single box when it did not. */
const DeltaRow: React.FC<{ delta: RpnScoreDelta }> = ({ delta }) => {
    if (delta.after === null) return <div className="text-xs text-slate-400 italic">Unscored</div>;
    if (delta.before === null || !delta.changed) {
        return (
            <div className="flex items-center gap-2">
                <ScoreBox value={delta.after} caption={delta.before === null ? 'Rating' : 'Unchanged'} />
                <span className="text-[11px] text-slate-500 leading-snug">
                    {delta.before === null ? 'No baseline recorded' : 'Mitigation did not change this rating'}
                </span>
            </div>
        );
    }
    return (
        <div className="flex items-center gap-2">
            <ScoreBox value={delta.before} caption="Before" />
            <span className="text-slate-400 text-lg leading-none">&rarr;</span>
            <ScoreBox value={delta.after} caption="After mitigation" />
        </div>
    );
};

const ReasonBlock: React.FC<{ title: string; body?: string }> = ({ title, body }) => {
    if (!body) return null;
    return (
        <div className="mt-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-400 mb-0.5">{title}</div>
            <div className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap">{body}</div>
        </div>
    );
};

const NoReason: React.FC<{ status?: Mode['rpnStatus'] }> = ({ status }) => (
    <div className="text-[11px] text-slate-400 italic leading-relaxed">
        {status === 'manual'
            ? 'Entered manually — no AI reasoning recorded. Run 🤖 to score with a justification.'
            : 'Not scored yet. Run 🤖 to score this mode.'}
    </div>
);

// ── RPN total badge ──────────────────────────────────────────────────────────

interface RpnTotalBadgeProps {
    mode: Mode;
    colorClass: string;
}

/** The coloured total. Hover shows the full stored `rpnReason` plus baseline vs mitigated RPN. */
export const RpnTotalBadge: React.FC<RpnTotalBadgeProps> = ({ mode, colorClass }) => {
    const { rect, ref, open, close } = useHoverRect();
    const total = rpnTotal(mode.rpn);
    const parts = parseRpnReason(mode.rpnReason);
    const imp = mode.rpnImprovement;
    const hasBody = Boolean(mode.rpnReason || imp);

    return (
        <>
            <div
                ref={el => { ref.current = el; }}
                onMouseEnter={open}
                onMouseLeave={close}
                className={`text-xs font-bold rounded py-1 border cursor-help ${colorClass}`}
            >
                {total === '' ? 'Unscored' : total}
            </div>
            {rect && (
                <HoverPanel rect={rect} width={320}>
                    <div className="text-[11px] font-bold text-slate-700 mb-2">Risk Priority Number</div>
                    {imp && imp.baselineRpn !== undefined && imp.mitigatedRpn !== undefined ? (
                        <div className="flex items-center gap-2 mb-1">
                            <div className="flex flex-col items-center gap-1">
                                <div className="px-2 h-9 min-w-[44px] grid place-items-center rounded-lg border border-slate-300 bg-slate-50 font-mono font-bold text-sm text-slate-700">{imp.baselineRpn}</div>
                                <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">Before</div>
                            </div>
                            <span className="text-slate-400 text-lg leading-none">&rarr;</span>
                            <div className="flex flex-col items-center gap-1">
                                <div className={`px-2 h-9 min-w-[44px] grid place-items-center rounded-lg border font-mono font-bold text-sm ${colorClass}`}>{imp.mitigatedRpn}</div>
                                <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">After mitigation</div>
                            </div>
                            {imp.rpnReduction !== undefined && imp.rpnReduction > 0 && (
                                <span className="ml-1 text-[10px] font-bold text-emerald-600">&minus;{imp.rpnReduction}</span>
                            )}
                        </div>
                    ) : (
                        <div className="text-[11px] text-slate-500 mb-1">
                            {total === '' ? 'Unscored' : <>Post-mitigation RPN <span className="font-mono font-bold">{total}</span> (S&times;O&times;D)</>}
                        </div>
                    )}

                    {!hasBody && <div className="mt-2"><NoReason status={mode.rpnStatus} /></div>}

                    <ReasonBlock title="Severity (S)" body={parts.s} />
                    <ReasonBlock title="Occurrence (O)" body={parts.o} />
                    <ReasonBlock title="Detection — before mitigation" body={parts.baselineD} />
                    <ReasonBlock title="Detection — after mitigation" body={parts.mitigatedD} />
                    {/* Unparseable reason text still gets shown rather than swallowed. */}
                    {mode.rpnReason && !parts.s && !parts.o && !parts.baselineD && !parts.mitigatedD && (
                        <ReasonBlock title="Reasoning" body={mode.rpnReason} />
                    )}
                    {imp?.summary && <ReasonBlock title="Improvement" body={imp.summary} />}
                    {parts.confidence && (
                        <div className="mt-2 pt-2 border-t border-slate-100 text-[10px] text-slate-400">
                            Confidence: <span className="font-semibold text-slate-500">{parts.confidence}</span>
                        </div>
                    )}
                </HoverPanel>
            )}
        </>
    );
};

// ── S / O / D inputs ─────────────────────────────────────────────────────────

interface RpnScoreInputProps {
    mode: Mode;
    scoreKey: 's' | 'o' | 'd';
    value: string | number;
    onChange: (v: string) => void;
}

/** One S/O/D box. Hover shows `[before] → [after]` and that score's slice of the reason. */
export const RpnScoreInput: React.FC<RpnScoreInputProps> = ({ mode, scoreKey, value, onChange }) => {
    const { rect, ref, open, close } = useHoverRect();
    const delta = rpnScoreDeltas(mode).find(d => d.key === scoreKey)!;
    const parts = parseRpnReason(mode.rpnReason);
    const reason = scoreKey === 's' ? parts.s : scoreKey === 'o' ? parts.o : parts.mitigatedD;
    const baselineReason = scoreKey === 'd' ? parts.baselineD : undefined;

    return (
        <>
            <span
                ref={el => { ref.current = el; }}
                onMouseEnter={open}
                onMouseLeave={close}
                className="relative inline-flex"
            >
                <input
                    className={`w-5 text-center border text-xs ${delta.changed ? 'border-emerald-400 bg-emerald-50/50' : ''}`}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                />
            </span>
            {rect && (
                <HoverPanel rect={rect} width={300}>
                    <div className="text-[11px] font-bold text-slate-700 mb-2">
                        {delta.label} ({scoreKey.toUpperCase()})
                    </div>
                    <DeltaRow delta={delta} />
                    {baselineReason && <ReasonBlock title="Before mitigation" body={baselineReason} />}
                    <ReasonBlock title={baselineReason ? 'After mitigation' : 'Reasoning'} body={reason} />
                    {!reason && !baselineReason && <div className="mt-2"><NoReason status={mode.rpnStatus} /></div>}
                </HoverPanel>
            )}
        </>
    );
};
