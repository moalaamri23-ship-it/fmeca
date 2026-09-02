import React, { useState } from 'react';
import { OperatingContext } from '../types';

export const EMPTY_OPERATING_CONTEXT: OperatingContext = {
    summary: '',
    redundancy: '',
    dutyCycle: '',
    environment: '',
    productionImpactRule: '',
    safetyEnvRegime: '',
};

export const hasOperatingContext = (context?: OperatingContext) =>
    Boolean(context && Object.values(context).some(value => String(value || '').trim()));

const FIELDS: Array<{ key: keyof OperatingContext; label: string; hint: string; rows?: number }> = [
    { key: 'summary', label: 'Summary', hint: 'Where the asset sits, what it does for the plant, its duty and criticality in one paragraph.', rows: 3 },
    { key: 'redundancy', label: 'Redundancy / standby', hint: 'e.g. 2×100% pumps with auto-changeover; single unit, no installed spare.' },
    { key: 'dutyCycle', label: 'Duty cycle', hint: 'Continuous, intermittent, standby, seasonal, hours per year.' },
    { key: 'environment', label: 'Environment / service', hint: 'Fluid, temperature, corrosion, location, climate.' },
    { key: 'productionImpactRule', label: 'Production impact rule', hint: 'When does a functional failure cost production or service? e.g. loss > 2 h stops the train.' },
    { key: 'safetyEnvRegime', label: 'Safety / environmental regime', hint: 'Hazardous area, SIL, permits, containment class, regulatory limits.' },
];

interface OperatingContextModalProps {
    context?: OperatingContext;
    projectDescription: string;
    onSave: (context: OperatingContext) => void;
    onClose: () => void;
}

/**
 * SAE JA1011 Q1 operating context. Exported with the project JSON so RCM Studio classifies
 * consequences in the stated context instead of inferring it from effects.
 */
export const OperatingContextModal: React.FC<OperatingContextModalProps> = ({ context, projectDescription, onSave, onClose }) => {
    const [draft, setDraft] = useState<OperatingContext>(() => ({
        ...EMPTY_OPERATING_CONTEXT,
        ...(context || {}),
        summary: context?.summary || projectDescription || '',
    }));
    const stated = FIELDS.filter(field => draft[field.key].trim()).length;

    return (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b">
                    <div>
                        <h3 className="font-bold text-slate-900 text-lg">Operating Context</h3>
                        <p className="text-xs text-slate-500">SAE JA1011 Q1 — the conditions every failure consequence is judged in. Carried into the RCM study with the export. {stated}/{FIELDS.length} stated.</p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none" aria-label="Close">×</button>
                </div>
                <div className="p-6 overflow-y-auto scroll-thin grid md:grid-cols-2 gap-4">
                    {FIELDS.map(field => (
                        <label key={field.key} className={`block ${field.key === 'summary' ? 'md:col-span-2' : ''}`}>
                            <span className="text-[10px] font-bold uppercase text-slate-400">{field.label}</span>
                            <textarea
                                className="mt-1 w-full border border-slate-200 rounded p-2 text-sm focus:ring-2 focus:ring-brand-500 outline-none"
                                rows={field.rows || 2}
                                placeholder={field.hint}
                                value={draft[field.key]}
                                onChange={e => setDraft(prev => ({ ...prev, [field.key]: e.target.value }))}
                            />
                        </label>
                    ))}
                </div>
                <div className="px-6 py-4 border-t flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 rounded border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
                    <button onClick={() => { onSave(draft); onClose(); }} className="px-4 py-2 rounded bg-slate-900 text-white text-sm font-bold hover:bg-slate-800">Save</button>
                </div>
            </div>
        </div>
    );
};
