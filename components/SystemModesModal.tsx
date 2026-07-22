import React, { useState, useRef } from 'react';
import XLSX from 'xlsx-js-style';
import { Icon } from './Icon';
import {
    aggregateSystemModes,
    groupSystemModes,
    parseSystemModesRows,
    type SystemMode,
    type SystemModesImportSummary,
} from '../services/SystemModesService';

interface SystemModesModalProps {
    systemType: string;
    systemModes: SystemMode[];
    systemContextEnabled: boolean;
    onInsert: (systemType: string, systemModes: SystemMode[]) => void;
    onClear: () => void;
    onToggle: () => void;
    onClose: () => void;
}

export const SystemModesModal: React.FC<SystemModesModalProps> = ({
    systemType: initialSystemType,
    systemModes: initialModes,
    systemContextEnabled,
    onInsert,
    onClear,
    onToggle,
    onClose
}) => {
    const [localType, setLocalType] = useState(initialSystemType);
    const [localModes, setLocalModes] = useState<SystemMode[]>(() => aggregateSystemModes(initialModes).modes);
    const [importSummary, setImportSummary] = useState<SystemModesImportSummary | null>(null);
    const [parseError, setParseError] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setParseError('');
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = new Uint8Array(ev.target!.result as ArrayBuffer);
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][];
                const parsed = parseSystemModesRows(rows);
                setLocalModes(parsed.modes);
                setImportSummary(parsed.summary);
                if (!parsed.modes.length) {
                    setParseError('No valid rows found. Component and Failure Mode must be present, and Occurrences must be at least 1.');
                }
            } catch (error: any) {
                setLocalModes([]);
                setImportSummary(null);
                setParseError(error?.message || 'Failed to parse the Excel file.');
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const grouped = groupSystemModes(localModes);
    const hasExistingData = initialModes.length > 0;
    const canInsert = localModes.length > 0;
    const skippedRows = importSummary
        ? importSummary.skippedBlankComponent + importSummary.skippedBlankMode + importSummary.skippedInvalidOccurrences
        : 0;

    return (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-[92vw] max-w-3xl max-h-[90vh] flex flex-col border border-slate-200" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">System Modes</h2>
                        <p className="text-xs text-slate-400 mt-0.5">Route grouped operational history to matching FMECA subsystems</p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100">&times;</button>
                </div>

                {/* Body */}
                <div className="overflow-y-auto flex-1 p-5 space-y-5">
                    {/* System Type */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">System Type</label>
                        <input
                            type="text"
                            value={localType}
                            onChange={e => setLocalType(e.target.value)}
                            placeholder="e.g. Centrifugal Pump"
                            className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500 transition"
                        />
                    </div>

                    {/* File Upload */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Upload Failure Data (Excel)</label>
                        <p className="text-xs text-slate-400 mb-2">
                            Required headings: Component &nbsp;&middot;&nbsp; Failure Mode (Failed State) &nbsp;&middot;&nbsp; Occurrences
                        </p>
                        <p className="text-[10px] text-slate-400 mb-2">Columns may appear in any order. Equipment and ISO 14224 Code are ignored.</p>
                        <label className="cursor-pointer inline-flex items-center gap-2 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-3 py-2 rounded border border-slate-200 transition">
                            <Icon name="upload" className="w-4 h-4" />
                            Choose Excel File
                            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
                        </label>
                        {parseError && <p className="text-xs text-red-500 mt-1.5">{parseError}</p>}
                    </div>

                    {importSummary && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="text-[10px] font-bold uppercase text-slate-400">Components</div>
                                <div className="text-lg font-bold text-slate-800">{importSummary.componentGroups}</div>
                            </div>
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="text-[10px] font-bold uppercase text-slate-400">Unique modes</div>
                                <div className="text-lg font-bold text-slate-800">{importSummary.uniqueModes}</div>
                            </div>
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="text-[10px] font-bold uppercase text-slate-400">Merged rows</div>
                                <div className="text-lg font-bold text-slate-800">{importSummary.duplicateRows}</div>
                            </div>
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                                <div className="text-[10px] font-bold uppercase text-slate-400">Skipped rows</div>
                                <div className={`text-lg font-bold ${skippedRows ? 'text-amber-600' : 'text-slate-800'}`}>{skippedRows}</div>
                            </div>
                        </div>
                    )}

                    {importSummary && skippedRows > 0 && (
                        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            Excluded {importSummary.skippedBlankComponent} blank-component, {importSummary.skippedBlankMode} blank-mode, and {importSummary.skippedInvalidOccurrences} invalid-occurrence row(s).
                        </p>
                    )}

                    {/* Component-grouped preview */}
                    {grouped.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">
                                Component groups — {grouped.length} component{grouped.length !== 1 ? 's' : ''}, {localModes.length} unique failure mode{localModes.length !== 1 ? 's' : ''}
                            </p>
                            <div className="max-h-80 overflow-y-auto scroll-thin space-y-3 pr-1">
                                {grouped.map(group => (
                                    <div key={group.component} className="border border-slate-200 rounded-lg overflow-hidden">
                                        <div className="flex items-center justify-between bg-slate-50 px-3 py-2 border-b border-slate-200">
                                            <span className="text-xs font-bold text-slate-700">{group.component}</span>
                                            <span className="text-[10px] font-mono text-slate-500">{group.totalOccurrences} occurrences · {group.modes.length} modes</span>
                                        </div>
                                        <table className="w-full text-xs">
                                            <thead className="text-[10px] font-bold uppercase text-slate-400">
                                                <tr><th className="text-left px-3 py-1.5">Failure Mode (Failed State)</th><th className="text-right px-3 py-1.5 w-24">Occurrences</th></tr>
                                            </thead>
                                            <tbody>
                                                {group.modes.map((mode, index) => (
                                                    <tr key={`${group.component}-${mode.mode}`} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                                                        <td className="px-3 py-1.5 text-slate-700">{mode.mode}</td>
                                                        <td className="px-3 py-1.5 text-slate-600 text-right font-mono">{mode.count}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t flex items-center justify-between gap-2 bg-slate-50/50 rounded-b-xl">
                    <div className="flex gap-2">
                        {hasExistingData && (
                            <>
                                <button
                                    onClick={onToggle}
                                    className={`text-xs px-3 py-1.5 rounded border font-semibold transition ${
                                        systemContextEnabled
                                            ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                                            : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                                    }`}
                                >
                                    {systemContextEnabled ? '● Enabled' : '○ Disabled'}
                                </button>
                                <button
                                    onClick={() => { onClear(); onClose(); }}
                                    className="text-xs px-3 py-1.5 rounded border font-semibold text-red-600 border-red-200 hover:bg-red-50 transition"
                                >
                                    Clear
                                </button>
                            </>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={onClose}
                            className="text-xs px-3 py-1.5 rounded border text-slate-600 border-slate-200 hover:bg-slate-100 transition"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => { onInsert(localType, localModes); onClose(); }}
                            disabled={!canInsert}
                            className="text-xs px-4 py-1.5 rounded bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            Insert
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
