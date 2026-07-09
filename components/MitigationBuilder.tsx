import React, { useState } from 'react';
import { SmartInput } from './SmartInput';
import { ContextData } from '../types';

interface MitigationBuilderProps {
    value: string;
    onChange: (value: string) => void;
    label?: string;
    placeholder?: string;
    apiKey: string;
    modelName: string;
    aiSourceMode?: string;
    referenceFileText?: string;
    contextData?: ContextData;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
    powerAutomateUrl?: string;
}

// Normalize a numbered action list: strip any existing numbering from each
// non-empty line and renumber sequentially as "1- text". Keeps numbering
// correct after deletions, insertions, and AI generation.
export const renumberActions = (text: string): string => {
    const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => l.replace(/^\d+\s*[-–.)]\s*/, ''));
    return lines.map((l, i) => `${i + 1}- ${l}`).join('\n');
};

// Merge Current Controls and Mitigation into one continuously numbered list:
// controls first, then mitigations, renumbered sequentially.
export const combineControlsAndMitigation = (currentControls?: string, mitigation?: string): string => {
    const combined = [currentControls, mitigation].filter(Boolean).join('\n');
    return combined ? renumberActions(combined) : '';
};

// Numbered action-list builder shared by the Mitigation and Current Controls
// fields: "N- Action (Owner)" lines, auto-renumbered on insert and on blur.
export const MitigationBuilder: React.FC<MitigationBuilderProps> = ({ value, onChange, label = 'Mitigation', placeholder = 'Mitigation...', apiKey, modelName, aiSourceMode, referenceFileText, contextData, aiProvider, azureEndpoint, systemContext, powerAutomateUrl }) => {
    const [act, setAct] = useState("");
    const [own, setOwn] = useState("");
    const insert = (e: React.MouseEvent) => {
        e.stopPropagation();
        if(!act) return;
        const line = `${act} (${own || 'Assignee'})`;
        onChange(renumberActions(value ? value + "\n" + line : line));
        setAct("");
        setOwn("");
    };
    return (
        <div className="w-full">
            <div className="flex gap-1 mb-1 items-center">
                <input className="border rounded p-1 text-[10px] w-full outline-none focus:border-brand-500" placeholder="Action" value={act} onChange={e=>setAct(e.target.value)} onClick={e=>e.stopPropagation()} />
                <input className="border rounded p-1 text-[10px] w-24 outline-none focus:border-brand-500" placeholder="Owner" value={own} onChange={e=>setOwn(e.target.value)} onClick={e=>e.stopPropagation()} />
                <button onClick={insert} className="bg-blue-50 text-blue-600 px-2 py-1 rounded font-bold text-[10px] hover:bg-blue-100 border border-blue-200">+</button>
            </div>
            <SmartInput label={label} value={value} onChange={onChange} onBlur={() => { const fixed = renumberActions(value); if (fixed !== value) onChange(fixed); }} isTextArea apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={referenceFileText} contextData={contextData} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} placeholder={placeholder} />
        </div>
    );
};
