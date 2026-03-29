import React, { useState } from 'react';
import { Icon } from './Icon';
import { AIService } from '../services/AIService';
import { ContextData } from '../types';

interface SmartInputProps {
    label?: string;
    value: string;
    onChange: (value: string) => void;
    isTextArea?: boolean;
    apiKey: string;
    modelName: string;
    placeholder?: string;
    aiSourceMode?: string;
    referenceFileText?: string;
    contextData?: ContextData;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
}

export const SmartInput: React.FC<SmartInputProps> = ({ label, value, onChange, isTextArea, apiKey, modelName, placeholder, aiSourceMode = 'ai', referenceFileText = '', contextData = {}, aiProvider = '', azureEndpoint = '', systemContext = '' }) => {
    const [loading, setLoading] = useState(false);
    const handleAI = async () => {
        setLoading(true);
        try {
            const res = await AIService.generate(label || "", value, apiKey, modelName, aiSourceMode, referenceFileText, contextData, aiProvider, azureEndpoint, systemContext);
            onChange(res);
        } catch(e) {
            console.error(e);
        }
        setLoading(false);
    };
    return ( 
        <div className="w-full mb-1 relative group">
            {label && <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1 ml-1">{label}</label>}
            <div className="relative">
                {isTextArea ? 
                    <textarea value={value||""} onChange={e => onChange(e.target.value)} onClick={e=>e.stopPropagation()} placeholder={placeholder} className="w-full bg-white border border-slate-200 rounded p-2 text-sm min-h-[50px] outline-none focus:border-brand-500 transition shadow-sm"/> 
                    : 
                    <input value={value||""} onChange={e => onChange(e.target.value)} onClick={e=>e.stopPropagation()} placeholder={placeholder} className="w-full bg-white border border-slate-200 rounded p-2 text-sm outline-none focus:border-brand-500 transition shadow-sm"/>
                }
                <button onClick={(e)=>{e.stopPropagation(); handleAI();}} className="absolute right-2 top-2 text-slate-300 hover:text-brand-600 bg-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition border border-transparent hover:border-slate-200">
                    {loading?"...":<Icon name="wand"/>}
                </button>
            </div>
        </div> 
    );
};
