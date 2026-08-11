import React, { useState } from 'react';
import { Project } from '../types';
import {
    RCM_STATUS_OPTIONS,
    buildSubSystemsList,
    buildSummaryOfActions,
    projectStartDateInput,
    type RcmRegisterResult,
} from '../services/RcmRegisterService';

export interface RcmRegisterSubmit {
    engineerEmail: string;
    status: string;
    startDate: string;
    summaryOfActions: string;
}

interface RcmRegisterModalProps {
    project: Project;
    defaultEngineerEmail: string;
    attachments: { fileName: string; sizeBytes: number }[];
    onPublish: (values: RcmRegisterSubmit) => Promise<RcmRegisterResult>;
    onClose: () => void;
}

const fmtSize = (bytes: number) => bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const RcmRegisterModal: React.FC<RcmRegisterModalProps> = ({
    project,
    defaultEngineerEmail,
    attachments,
    onPublish,
    onClose
}) => {
    const [engineerEmail, setEngineerEmail] = useState(defaultEngineerEmail);
    const [status, setStatus] = useState(RCM_STATUS_OPTIONS[0]);
    const [startDate, setStartDate] = useState(() => projectStartDateInput(project));
    const [summary, setSummary] = useState(() => buildSummaryOfActions(project));
    const [publishing, setPublishing] = useState(false);
    const [result, setResult] = useState<RcmRegisterResult | null>(null);
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<{ engineerEmail?: string; status?: string; summary?: string }>({});

    const subSystems = buildSubSystemsList(project).split('\n').filter(Boolean);

    const submit = async () => {
        const errs: typeof fieldErrors = {};
        if (!engineerEmail.trim()) errs.engineerEmail = 'Engineer email is required.';
        else if (!engineerEmail.includes('@')) errs.engineerEmail = 'Enter a valid email / UPN.';
        if (!status.trim()) errs.status = 'Status is required.';
        if (!summary.trim()) errs.summary = 'Summary of actions is required.';
        setFieldErrors(errs);
        if (Object.keys(errs).length) return;

        setError('');
        setPublishing(true);
        try {
            const res = await onPublish({ engineerEmail: engineerEmail.trim(), status, startDate, summaryOfActions: summary });
            setResult(res);
        } catch (e: any) {
            setError(e?.message || String(e));
        } finally {
            setPublishing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-[92vw] max-w-2xl max-h-[90vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">Publish to RCM Register</h2>
                        <p className="text-xs text-slate-400 mt-0.5">Creates a row in the SharePoint list and attaches the FMECA workbook</p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100">&times;</button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 p-5 space-y-5">
                    {result ? (
                        <div className="text-center py-6">
                            <div className="text-xs font-bold uppercase text-slate-400 mb-2">Registered as</div>
                            <div className="text-3xl font-bold text-slate-900 font-mono">{result.rcmInternalNumber}</div>
                            <div className="text-xs text-slate-400 mt-2">List item #{result.itemId}</div>
                            {result.itemLink && (
                                <a href={result.itemLink} target="_blank" rel="noopener noreferrer" className="inline-block mt-4 text-sm font-semibold text-brand-600 hover:text-brand-700 underline">
                                    Open in SharePoint
                                </a>
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Read-only summary */}
                            <div className="grid sm:grid-cols-2 gap-3">
                                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">System</div>
                                    <div className="text-sm text-slate-700">{project.name || '—'}</div>
                                </div>
                                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Attachments ({attachments.length})</div>
                                    {attachments.map(a => (
                                        <div key={a.fileName} className="mb-1 last:mb-0">
                                            <div className="text-xs font-mono text-slate-700 break-all">{a.fileName}</div>
                                            <div className="text-[10px] text-slate-400">{fmtSize(a.sizeBytes)}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">Sub-Systems ({subSystems.length})</div>
                                <div className="max-h-32 overflow-y-auto scroll-thin rounded-lg border border-slate-200 divide-y divide-slate-100">
                                    {subSystems.length === 0 && <div className="px-3 py-2 text-xs text-slate-400 italic">No sub-systems.</div>}
                                    {subSystems.map(name => (
                                        <div key={name} className="px-3 py-1.5 text-xs text-slate-700">{name}</div>
                                    ))}
                                </div>
                            </div>

                            {/* Editable fields */}
                            <div className="grid sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold text-slate-500 mb-1">Engineer email</label>
                                    <input
                                        type="text"
                                        value={engineerEmail}
                                        onChange={e => setEngineerEmail(e.target.value)}
                                        placeholder="name@company.com"
                                        className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition"
                                    />
                                    {fieldErrors.engineerEmail && <p className="text-xs text-red-500 mt-1">{fieldErrors.engineerEmail}</p>}
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-slate-500 mb-1">Status</label>
                                    <select
                                        value={status}
                                        onChange={e => setStatus(e.target.value)}
                                        className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500"
                                    >
                                        {RCM_STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                                    </select>
                                    {fieldErrors.status && <p className="text-xs text-red-500 mt-1">{fieldErrors.status}</p>}
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-500 mb-1">Start date</label>
                                <input
                                    type="date"
                                    value={startDate}
                                    onChange={e => setStartDate(e.target.value)}
                                    className="w-full sm:w-56 border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-500 mb-1">Summary of actions</label>
                                <textarea
                                    value={summary}
                                    onChange={e => setSummary(e.target.value)}
                                    rows={7}
                                    className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 min-h-[50px]"
                                />
                                <p className="text-[10px] text-slate-400 mt-1">{summary.length} / 2000 characters — rolled up from mitigations, highest RPN first.</p>
                                {fieldErrors.summary && <p className="text-xs text-red-500 mt-1">{fieldErrors.summary}</p>}
                            </div>

                            {error && (
                                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 whitespace-pre-wrap break-words">
                                    {error}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t flex items-center justify-end gap-2 bg-slate-50/50 rounded-b-xl">
                    <button
                        onClick={onClose}
                        className="text-xs px-3 py-1.5 rounded border text-slate-600 border-slate-200 hover:bg-slate-100 transition"
                    >
                        {result ? 'Close' : 'Cancel'}
                    </button>
                    {!result && (
                        <button
                            onClick={submit}
                            disabled={publishing}
                            className="text-xs px-4 py-1.5 rounded bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            {publishing ? 'Publishing...' : 'Publish'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
