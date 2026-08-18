import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { CiteButton } from './CiteButton';
import type { CiteState } from './CiteButton';
import { AIService } from '../services/AIService';
import { newConversationId } from '../services/CopilotQueue';
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
    /** Citation state for this field. Omitted where a field cannot be cited. */
    citeState?: CiteState;
    citeCount?: number;
    onCite?: () => void;
    /** Held while a higher-level action (Auto-Fill) owns this subsystem. */
    locked?: boolean;
}

export const SmartInput: React.FC<SmartInputProps> = ({ label, labelAddon, value, onChange, isTextArea, heightClass, onBlur, apiKey, modelName, placeholder, aiSourceMode = 'ai', referenceFileText = '', contextData = {}, aiProvider = '', azureEndpoint = '', systemContext = '', powerAutomateUrl = '', citeState = 'none', citeCount = 0, onCite, locked = false }) => {
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
        // A second press on the same field would race its own result.
        if (loading || locked) return;
        setLoading(true);
        try {
            // Its own Copilot conversation, so this field runs beside every
            // other wand instead of queueing behind them on the shared thread.
            const res = await AIService.generate(label || "", value, apiKey, modelName, aiSourceMode, referenceFileText, contextData, aiProvider, azureEndpoint, systemContext, powerAutomateUrl, newConversationId());
            onChange(res);
        } catch(e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };
    return ( 
        <div className="w-full mb-1 relative group">
            {label && (
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                    <label onClick={(e) => { e.stopPropagation(); setExpanded(true); }} className="text-[10px] font-bold text-slate-400 uppercase cursor-default select-none hover:text-brand-600 transition">{label}</label>
                    {onCite && <CiteButton state={citeState} count={citeCount} onClick={onCite} />}
                    {labelAddon}
                </div>
            )}
            <div className="relative">
                {isTextArea ? 
                    <textarea value={value||""} onChange={e => onChange(e.target.value)} onBlur={onBlur} onClick={e=>e.stopPropagation()} placeholder={placeholder} className={`w-full bg-white border border-slate-200 rounded p-2 text-sm ${heightClass || 'min-h-[50px]'} outline-none focus:border-brand-500 transition shadow-sm`}/>
                    : 
                    <input value={value||""} onChange={e => onChange(e.target.value)} onClick={e=>e.stopPropagation()} placeholder={placeholder} className="w-full bg-white border border-slate-200 rounded p-2 text-sm outline-none focus:border-brand-500 transition shadow-sm"/>
                }
                <button
                    onClick={(e)=>{e.stopPropagation(); handleAI();}}
                    disabled={loading || locked}
                    title={locked ? "Auto-Fill is running on this subsystem" : undefined}
                    className={`absolute right-2 top-2 text-slate-300 hover:text-brand-600 bg-white p-1 rounded-full transition border border-transparent hover:border-slate-200 disabled:cursor-not-allowed disabled:hover:text-slate-300 disabled:hover:border-transparent ${loading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${locked ? 'group-hover:opacity-40' : ''}`}
                >
                    {loading?"...":<Icon name="wand"/>}
                </button>
            </div>
            {expanded && createPortal((
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
            ), document.body)}
        </div>
    );
};
