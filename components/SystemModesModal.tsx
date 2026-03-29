import React, { useState, useRef } from 'react';
import XLSX from 'xlsx-js-style';

export interface SystemMode {
    mode: string;
    count: number;
}

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
    const [localModes, setLocalModes] = useState<SystemMode[]>(initialModes);
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
                const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
                // Skip header if first cell is text and second cell is not a number
                const startRow = (rows.length > 0 && typeof rows[0][0] === 'string' && isNaN(Number(rows[0][1]))) ? 1 : 0;
                const parsed: SystemMode[] = rows
                    .slice(startRow)
                    .filter((r) => r[0] && String(r[0]).trim())
                    .map((r) => ({
                        mode: String(r[0]).trim(),
                        count: parseInt(String(r[1])) || 0
                    }));
                setLocalModes(parsed);
            } catch {
                setParseError('Failed to parse file. Ensure it is a valid Excel file with Failure Mode in Column 1 and Count in Column 2.');
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    };

    const sorted = [...localModes].sort((a, b) => b.count - a.count).slice(0, 20);
    const hasExistingData = initialModes.length > 0;
    const canInsert = localType.trim().length > 0 || localModes.length > 0;

    return (
        <div className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-[560px] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <div>
                        <h2 className="font-bold text-slate-800 text-base">System Modes</h2>
                        <p className="text-xs text-slate-400 mt-0.5">Inject operational failure data as context into AI prompts</p>
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
                            className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
                        />
                    </div>

                    {/* File Upload */}
                    <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">Upload Failure Data (Excel)</label>
                        <p className="text-xs text-slate-400 mb-2">
                            Column 1: Failure Mode &nbsp;&middot;&nbsp; Column 2: Failure Count (occurrences)
                        </p>
                        <label className="cursor-pointer inline-flex items-center gap-2 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-3 py-2 rounded border border-slate-200 transition">
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                            </svg>
                            Choose Excel File
                            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleFile} />
                        </label>
                        {parseError && <p className="text-xs text-red-500 mt-1.5">{parseError}</p>}
                    </div>

                    {/* Parsed Table */}
                    {localModes.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">
                                Parsed — {localModes.length} failure mode{localModes.length !== 1 ? 's' : ''} found
                                {localModes.length > 20 && ' (showing top 20 by count)'}
                            </p>
                            <div className="border rounded-lg overflow-hidden">
                                <div className="max-h-52 overflow-y-auto">
                                    <table className="w-full text-xs">
                                        <thead className="bg-slate-50 sticky top-0 z-10">
                                            <tr>
                                                <th className="text-left px-3 py-2 text-slate-500 font-semibold border-b w-8">#</th>
                                                <th className="text-left px-3 py-2 text-slate-500 font-semibold border-b">Failure Mode</th>
                                                <th className="text-right px-3 py-2 text-slate-500 font-semibold border-b w-20">Count</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {sorted.map((m, i) => (
                                                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                                                    <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                                                    <td className="px-3 py-1.5 text-slate-700">{m.mode}</td>
                                                    <td className="px-3 py-1.5 text-slate-600 text-right font-mono">{m.count}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
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
                            className="text-xs px-4 py-1.5 rounded bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                        >
                            Insert
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
