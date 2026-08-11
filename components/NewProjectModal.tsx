import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { listRegisterProjects, type RcmRegisterRow } from '../services/RcmRegisterService';

interface NewProjectModalProps {
    /** Empty when the register flow URL is not configured — the SharePoint option is then disabled. */
    registerFlowUrl: string;
    /** Opens the existing file picker (same handler as the Import button). */
    onPickLocal: () => void;
    /** Loads the FMECA JSON attached to the chosen register row. */
    onPickRegisterRow: (row: RcmRegisterRow) => Promise<void>;
    onCreateBlank: () => void;
    onClose: () => void;
}

const fmtDate = (iso: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
};

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
    registerFlowUrl,
    onPickLocal,
    onPickRegisterRow,
    onCreateBlank,
    onClose
}) => {
    const [source, setSource] = useState<'choose' | 'sharepoint'>('choose');
    const [rows, setRows] = useState<RcmRegisterRow[]>([]);
    const [selected, setSelected] = useState<RcmRegisterRow | null>(null);
    const [loading, setLoading] = useState(false);
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('');

    useEffect(() => {
        if (source !== 'sharepoint') return;
        let cancelled = false;
        setLoading(true);
        setError('');
        listRegisterProjects(registerFlowUrl)
            .then(list => { if (!cancelled) setRows(list); })
            .catch(e => { if (!cancelled) setError(e?.message || String(e)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [source, registerFlowUrl]);

    const confirm = async () => {
        if (!selected) return;
        setError('');
        setOpening(true);
        try {
            await onPickRegisterRow(selected);
        } catch (e: any) {
            setError(e?.message || String(e));
            setOpening(false);
        }
    };

    const needle = filter.trim().toLowerCase();
    const visible = needle
        ? rows.filter(r => `${r.rcmInternalNumber} ${r.system}`.toLowerCase().includes(needle))
        : rows;

    return (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-[92vw] max-w-2xl max-h-[90vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">
                            {source === 'choose' ? 'New Project' : 'Open from SharePoint RCM List'}
                        </h2>
                        <p className="text-xs text-slate-400 mt-0.5">
                            {source === 'choose'
                                ? 'Choose where this analysis comes from'
                                : 'Pick a registered study — its FMECA JSON attachment is loaded into the app'}
                        </p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100">&times;</button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 p-5">
                    {source === 'choose' ? (
                        <>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <button
                                    onClick={() => { if (registerFlowUrl.trim()) setSource('sharepoint'); }}
                                    disabled={!registerFlowUrl.trim()}
                                    className="text-left rounded-lg border border-slate-200 p-4 hover:border-brand-500 hover:bg-brand-50/40 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-slate-200 disabled:hover:bg-transparent"
                                >
                                    <div className="text-brand-600 mb-2"><Icon name="table" className="w-6 h-6" /></div>
                                    <div className="font-bold text-sm text-slate-800">SharePoint RCM List</div>
                                    <p className="text-xs text-slate-500 mt-1">
                                        {registerFlowUrl.trim()
                                            ? 'Browse registered studies by RCM internal number and load the attached FMECA.'
                                            : 'Set the RCM Register flow URL in Settings to enable this.'}
                                    </p>
                                </button>
                                <button
                                    onClick={onPickLocal}
                                    className="text-left rounded-lg border border-slate-200 p-4 hover:border-brand-500 hover:bg-brand-50/40 transition"
                                >
                                    <div className="text-brand-600 mb-2"><Icon name="folder" className="w-6 h-6" /></div>
                                    <div className="font-bold text-sm text-slate-800">Local FMECA Project</div>
                                    <p className="text-xs text-slate-500 mt-1">Open one or more exported FMECA JSON files from this computer.</p>
                                </button>
                            </div>
                            <button onClick={onCreateBlank} className="mt-4 text-xs font-semibold text-slate-500 hover:text-brand-600 underline">
                                Or start from scratch with a blank analysis
                            </button>
                        </>
                    ) : (
                        <>
                            {loading && <div className="text-sm text-slate-400 py-8 text-center">Loading register…</div>}
                            {error && (
                                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 whitespace-pre-wrap break-words mb-3">{error}</div>
                            )}
                            {!loading && !error && rows.length === 0 && (
                                <div className="text-sm text-slate-400 py-8 text-center">The register list has no rows yet.</div>
                            )}
                            {!loading && rows.length > 0 && (
                                <>
                                    <input
                                        type="text"
                                        value={filter}
                                        onChange={e => setFilter(e.target.value)}
                                        placeholder="Filter by RCM number or system…"
                                        className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 mb-3"
                                    />
                                    <div className="border border-slate-200 rounded-lg divide-y max-h-[45vh] overflow-y-auto">
                                        {visible.map(row => (
                                            <button
                                                key={row.itemId}
                                                onClick={() => setSelected(row)}
                                                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition ${selected?.itemId === row.itemId ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                                            >
                                                <span className="font-mono text-xs font-bold text-slate-800 whitespace-nowrap">{row.rcmInternalNumber || `#${row.itemId}`}</span>
                                                <span className="text-sm text-slate-700 flex-1 truncate">{row.system || '(no system name)'}</span>
                                                {row.status && <span className="text-[10px] font-bold uppercase text-slate-400 whitespace-nowrap">{row.status}</span>}
                                                {row.startDate && <span className="text-[10px] text-slate-400 whitespace-nowrap">{fmtDate(row.startDate)}</span>}
                                            </button>
                                        ))}
                                        {visible.length === 0 && <div className="px-3 py-4 text-xs text-slate-400">No row matches that filter.</div>}
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                {source === 'sharepoint' && (
                    <div className="px-5 py-4 border-t flex items-center justify-between gap-3">
                        <button onClick={() => { setSource('choose'); setSelected(null); setError(''); }} className="text-xs font-semibold text-slate-500 hover:text-slate-700 flex items-center gap-1">
                            <Icon name="arrowLeft" className="w-4 h-4" /> Back
                        </button>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 truncate max-w-[240px]">
                                {selected ? `${selected.rcmInternalNumber || `#${selected.itemId}`} — ${selected.system}` : 'Select a study'}
                            </span>
                            <button
                                onClick={confirm}
                                disabled={!selected || opening}
                                className="bg-slate-900 text-white px-4 py-2 rounded font-bold text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {opening ? 'Loading…' : 'Open Project'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
