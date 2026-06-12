import React, { useState, useRef, useEffect } from 'react';
import { Icon } from './Icon';
import { AIService } from '../services/AIService';
import { ContextData } from '../types';

interface SmartInputProps {
    label?: string;
    labelAddon?: React.ReactNode;
    value: string;
    onChange: (value: string) => void;
    isTextArea?: boolean;
    heightClass?: string;
    onBlur?: () => void;
    apiKey: string;
    modelName: string;
    placeholder?: string;
    aiSourceMode?: string;
    referenceFileText?: string;
    contextData?: ContextData;
    aiProvider?: string;
    azureEndpoint?: string;
    systemContext?: string;
    powerAutomateUrl?: string;
}

export const SmartInput: React.FC<SmartInputProps> = ({ label, labelAddon, value, onChange, isTextArea, heightClass, onBlur, apiKey, modelName, placeholder, aiSourceMode = 'ai', referenceFileText = '', contextData = {}, aiProvider = '', azureEndpoint = '', systemContext = '', powerAutomateUrl = '' }) => {
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const modalTextRef = useRef<HTMLTextAreaElement>(null);
    // Auto-fit the modal textarea to its content (capped at 70% of the viewport).
    useEffect(() => {
        if (!expanded) return;
        const el = modalTextRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.max(120, Math.min(el.scrollHeight + 2, window.innerHeight * 0.7)) + 'px';
    }, [expanded, value]);
    const handleAI = async () => {
        setLoading(true);
        try {
            const res = await AIService.generate(label || "", value, apiKey, modelName, aiSourceMode, referenceFileText, contextData, aiProvider, azureEndpoint, systemContext, powerAutomateUrl);
            onChange(res);
        } catch(e) {
            console.error(e);
        }
        setLoading(false);
    };
    return ( 
        <div className="w-full mb-1 relative group">
            {label && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                    <label onClick={(e) => { e.stopPropagation(); setExpanded(true); }} className="text-[10px] font-bold text-slate-400 uppercase cursor-default select-none hover:text-brand-600 transition">{label}</label>
                    {labelAddon}
                </div>
            )}
            <div className="relative">
                {isTextArea ? 
                    <textarea value={value||""} onChange={e => onChange(e.target.value)} onBlur={onBlur} onClick={e=>e.stopPropagation()} placeholder={placeholder} className={`w-full bg-white border border-slate-200 rounded p-2 text-sm ${heightClass || 'min-h-[50px]'} outline-none focus:border-brand-500 transition shadow-sm`}/>
                    : 
                    <input value={value||""} onChange={e => onChange(e.target.value)} onClick={e=>e.stopPropagation()} placeholder={placeholder} className="w-full bg-white border border-slate-200 rounded p-2 text-sm outline-none focus:border-brand-500 transition shadow-sm"/>
                }
                <button onClick={(e)=>{e.stopPropagation(); handleAI();}} className="absolute right-2 top-2 text-slate-300 hover:text-brand-600 bg-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition border border-transparent hover:border-slate-200">
                    {loading?"...":<Icon name="wand"/>}
                </button>
            </div>
            {expanded && (
                <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-6" onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>
                    <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl p-4 animate-enter" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-slate-500 uppercase">{label}</span>
                            <button onClick={() => setExpanded(false)} className="text-slate-400 hover:text-slate-700 font-bold px-2" title="Close (Esc)">✕</button>
                        </div>
                        <textarea
                            ref={modalTextRef}
                            autoFocus
                            value={value || ""}
                            onChange={e => onChange(e.target.value)}
                            onBlur={onBlur}
                            onKeyDown={e => { if (e.key === 'Escape') setExpanded(false); }}
                            placeholder={placeholder}
                            className="w-full bg-white border border-slate-200 rounded p-3 text-sm outline-none focus:border-brand-500 transition resize-none overflow-auto"
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
