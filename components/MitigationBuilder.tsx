import React, { useState } from 'react';
import { SmartInput } from './SmartInput';
import { ContextData } from '../types';

interface MitigationBuilderProps {
    value: string;
    onChange: (value: string) => void;
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

export const MitigationBuilder: React.FC<MitigationBuilderProps> = ({ value, onChange, apiKey, modelName, aiSourceMode, referenceFileText, contextData, aiProvider, azureEndpoint, systemContext, powerAutomateUrl }) => {
    const [act, setAct] = useState(""); 
    const [own, setOwn] = useState("");
    const insert = (e: React.MouseEvent) => { 
        e.stopPropagation(); 
        if(!act) return; 
        const line = `${act} (${own || 'Assignee'})`; 
        onChange(value ? value + "\n" + line : line); 
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
            <SmartInput label="" value={value} onChange={onChange} isTextArea apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={referenceFileText} contextData={contextData} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} placeholder="Mitigation..." />
        </div> 
    );
};
