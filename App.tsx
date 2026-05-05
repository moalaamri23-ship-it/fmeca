import React, { useState, useEffect } from 'react';
import { toPng, toJpeg } from 'html-to-image';
import XLSX from 'xlsx-js-style';
import { Icon } from './components/Icon';
import { SmartInput } from './components/SmartInput';
import { MitigationBuilder } from './components/MitigationBuilder';
import { SystemModesModal, SystemMode } from './components/SystemModesModal';
import { TreeNode } from './components/TreeNode';
import { HybridMapView } from './components/HybridMapView';
import { AttachmentModal } from './components/AttachmentModal';
import { Chatbot } from './components/Chatbot';
import { ModelSelector } from './components/ModelSelector';
import { AIService, TieredModels } from './services/AIService';
import { LocalFileSystemProvider, sanitizeName, pickFolder } from './services/FileSystem';
import { RICH_LIBRARY } from './constants';
import { Project, Subsystem, Failure, Mode, RichLibrary, LibraryItem } from './types';

// Utility functions
const safeGet = (k: string, f: any) => { try { const i = localStorage.getItem(k); return i ? JSON.parse(i) : f; } catch (e) { return f; } };
const generateId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

const simpleHash = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h.toString(36);
};

const isSubExhausted = (sub: Subsystem): boolean => {
    const st = sub.exhaustionState;
    if (!st || !st.isExhausted) return false;
    return st.funcHash === simpleHash(sub.func || '') && st.failureCount === sub.failures.length;
};

const nowIso = () => new Date().toISOString();

const fmtDate = (iso?: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(); // you can switch to toLocaleString() if you want time
};

const touchProject = (p: any) => ({
  ...p,
  updatedAt: nowIso(),
});



const sanitizeProject = (p: any): Project => {
    if (!p) return p; 
    const newP = { ...p }; 
    const seenIds = new Set();
    const ensureUnique = (id: string) => { if (!id || seenIds.has(id)) { const newId = generateId(); seenIds.add(newId); return newId; } seenIds.add(id); return id; };
    if(newP.subsystems) {
        newP.subsystems = newP.subsystems.map((s: any) => {
            const sId = ensureUnique(s.id);
            const failures = s.failures ? s.failures.map((f: any) => {
                const fId = ensureUnique(f.id);
                const modes = f.modes ? f.modes.map((m: any) => {
                    const mId = ensureUnique(m.id);
                    return { ...m, id: mId, effect: m.effect !== undefined ? m.effect : "" };
                }) : [];
                return { ...f, id: fId, modes };
            }) : [];
            return { ...s, id: sId, specs: s.specs || "", imageData: s.imageData || "", imageName: s.imageName || "", imageJson: s.imageJson || "", showImageJson: !!s.showImageJson, failures };
        });
    }
    return newP;
};

type ChatbotResponseStyle = "normal" | "concise" | "one_sentence";
type AIProvider = 'gemini' | 'openai' | 'anthropic' | 'azure' | 'openrouter' | 'copilot';

const PROVIDER_LABELS: Record<AIProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', azure: 'Azure', openrouter: 'OpenRouter', copilot: 'Copilot' };
const PROVIDER_MODELS: Record<string, string[]> = {
    gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'],
    anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'],
};
const DEFAULT_MODELS: Record<AIProvider, string> = { gemini: 'gemini-2.0-flash', openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-4-20250514', azure: '', openrouter: '', copilot: '' };
const API_KEY_PLACEHOLDERS: Record<AIProvider, string> = { gemini: 'AIzaSy...', openai: 'sk-...', anthropic: 'sk-ant-...', azure: 'Azure API key', openrouter: 'sk-or-...', copilot: 'Not required' };

const App = () => {
    const [view, setView] = useState<'dashboard' | 'editor'>('dashboard');
    const [dashboardTab, setDashboardTab] = useState<'projects' | 'settings'>('projects');
    const [projects, setProjects] = useState<Project[]>([]);
    const [activeProject, setActiveProject] = useState<Project | null>(null);
    const [apiKey, setApiKey] = useState('');
    const [modelName, setModelName] = useState('gpt-4o-mini');
    const [aiSourceMode, setAiSourceMode] = useState('ai');
    const [aiProvider, setAiProvider] = useState<AIProvider>('gemini');
    const [azureEndpoint, setAzureEndpoint] = useState('');
    const [powerAutomateUrl, setPowerAutomateUrl] = useState('');
    const [liveModels, setLiveModels] = useState<Record<string, TieredModels>>(() => {
        try { return JSON.parse(localStorage.getItem('fmeca_models_cache') || '{}'); } catch { return {}; }
    });
    const [modelsFetching, setModelsFetching] = useState(false);
    const [enableChatbot, setEnableChatbot] = useState(true);
    const [chatbotStyle, setChatbotStyle] = useState<ChatbotResponseStyle>("normal");
    const [globalFileText, setGlobalFileText] = useState('');
    const [globalFileName, setGlobalFileName] = useState('');
    const [checklistText, setChecklistText] = useState('');
    const [checklistFileName, setChecklistFileName] = useState('');
    const [tab, setTab] = useState<'build' | 'viewTable' | 'map'>('build');
    const [showRPN, setShowRPN] = useState(true);
    const [showLib, setShowLib] = useState(false);
    const [showToolbar, setShowToolbar] = useState(false);
    // eslint-disable-next-line
    const [loadingExport, setLoadingExport] = useState(false);
    const [loadingMaster, setLoadingMaster] = useState(false);
    const [genId, setGenId] = useState<string | null>(null);
    const [modeGenId, setModeGenId] = useState<string | null>(null);
    const [activeSubId, setActiveSubId] = useState<string | null>(null);
    const [library, setLibrary] = useState<RichLibrary>(RICH_LIBRARY);
    const [showDownloadOptions, setShowDownloadOptions] = useState(false);
    const [dragId, setDragId] = useState<number | null>(null);
    const [dragAllowed, setDragAllowed] = useState<number | null>(null);
    // Delete Helper
    const [confirmBox, setConfirmBox] = useState<{ msg: string; run: null | (() => void) }>({ msg: "", run: null });
    const ask = (msg: string, run: () => void) => setConfirmBox({ msg, run });
    const closeAsk = () => setConfirmBox({ msg: "", run: null });
    // Map-tree state + handlers
    const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
    const [treeSelected, setTreeSelected] = useState<string | null>(null);

    const [rpnBusy, setRpnBusy] = useState<Set<string>>(new Set());

    const [rpnLoadingId, setRpnLoadingId] = useState<string | null>(null);

    // System Modes / System Context
    const [systemType, setSystemType] = useState('');
    const [systemModes, setSystemModes] = useState<SystemMode[]>([]);
    const [systemContextEnabled, setSystemContextEnabled] = useState(true);
    const [showSystemModes, setShowSystemModes] = useState(false);


    const toggleTree = (id: string) => setTreeExpanded(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });

    const selectTree = (id: string) => setTreeSelected(id);

const expandAllTree = () => {
  if (!activeProject) return;

  const ids: string[] = [];
  ids.push(activeProject.id);

  activeProject.subsystems.forEach(sub => {
    ids.push(sub.id);
    sub.failures.forEach(fail => {
      ids.push(fail.id);
      fail.modes.forEach(mode => {
        ids.push(mode.id);
      });
    });
  });

  setTreeExpanded(new Set(ids));
};

const collapseAllTree = () => {
  if (!activeProject) return;

  // Collapse everything except root
  setTreeExpanded(new Set([activeProject.id]));

  // Reset selection to root (UX safety)
  setTreeSelected(activeProject.id);
};


// Builds the system context injection block from operational failure data
    const buildSystemContext = (type: string, modes: SystemMode[]): string => {
        if (!modes.length) return '';
        const sorted = [...modes].sort((a, b) => b.count - a.count).slice(0, 20);
        const lines = sorted.map((m, i) => `${i + 1}. ${m.mode} — ${m.count} occurrences`).join('\n');
        return `---\nSYSTEM CONTEXT (Informed by Operational Failure Data):\nSystem Type: ${type || 'N/A'}\nTop Failure Modes by Occurrence (ranked):\n${lines}\nUse this data to inform your analysis — these failure modes are known to occur in this type of system.\n---`;
    };

    // Derived: non-empty only when data is present AND enabled
    const systemContext = (systemContextEnabled && systemModes.length > 0) ? buildSystemContext(systemType, systemModes) : '';

const tryIso=(x:any)=>{ try{ if(!x) return null; const d=new Date(x); return Number.isNaN(d.getTime())?null:d.toISOString(); }catch(e){ return null; } };
const normalizeProjectDates=(sp:any)=>{ const now=nowIso(); const createdAt=sp.createdAt||sp.updatedAt||tryIso(sp.created)||tryIso(sp.updated)||now; const updatedAt=sp.updatedAt||tryIso(sp.updated)||createdAt; return { ...sp, createdAt, updatedAt }; };

    /* ATTACHMENT STATE */
    const [storageProvider, setStorageProvider] = useState<LocalFileSystemProvider | null>(null);
    const [attachModal, setAttachModal] = useState<{ open: boolean, type: 'sub' | 'fail' | null, entity: any, sub: Subsystem | null }>({ open: false, type: null, entity: null, sub: null });
    
    // 1) Initial load (projects, settings, storage)
    useEffect(() => { 
    const rawProjects = safeGet('rcm_projects_v44', []);
setProjects(
  rawProjects.map((p: any) => {
    const sp: any = sanitizeProject(p);

    // Migration:
    // - Old "updated" was effectively creation date.
    // - New behavior: created = creation date, updated = last modified
    const created = sp.createdAt || sp.created || sp.updated || nowIso();
    const updated = sp.updatedAt || sp.updated || created;

    return {
      ...sp,
      createdAt: created,
      updatedAt: updated
    };
  })
); 
    setApiKey(localStorage.getItem('rcm_api_key_v44') || '');
    setModelName(localStorage.getItem('rcm_model_name_v1') || 'gemini-2.0-flash');
    setAiSourceMode(localStorage.getItem('rcm_ai_source_mode') || 'ai');
    setAiProvider((localStorage.getItem('rcm_ai_provider') as AIProvider) || 'gemini');
    setAzureEndpoint(localStorage.getItem('rcm_azure_endpoint') || '');
    setPowerAutomateUrl(localStorage.getItem('rcm_power_automate_url') || '');
    setEnableChatbot(localStorage.getItem('rcm_enable_chatbot') !== 'false');
    setChatbotStyle((localStorage.getItem('rcm_chatbot_style') as ChatbotResponseStyle) || 'normal');
    setGlobalFileText(localStorage.getItem('rcm_global_file_text') || '');
    setGlobalFileName(localStorage.getItem('rcm_global_file_name') || '');
    setChecklistText(localStorage.getItem('rcm_checklist_text') || '');
    setChecklistFileName(localStorage.getItem('rcm_checklist_name') || '');
    setSystemType(localStorage.getItem('rcm_system_type') || '');
    setSystemModes(safeGet('rcm_system_modes', []));
    setSystemContextEnabled(localStorage.getItem('rcm_system_context_enabled') !== 'false');
    

    // Init Storage Provider
    setStorageProvider(new LocalFileSystemProvider());
    }, []);


// 2) Select root node when project opens (do not override existing selection)
    useEffect(() => { 
    if(!activeProject) { 
        setTreeSelected(null); 
        return; 
    }
    setTreeSelected(s => s ? s : activeProject.id);
   }, [activeProject]);


// 3) Auto-expand root when entering Map view
    useEffect(() => {
    if(view === 'editor' && tab === 'map' && activeProject) {
        setTreeExpanded(prev => {
            const next = new Set(prev);
            next.add(activeProject.id);
            return next;
        });
    }
    }, [view, tab, activeProject]);

    useEffect(() => { 
        if(projects.length>0) localStorage.setItem('rcm_projects_v44', JSON.stringify(projects)); 
        localStorage.setItem('rcm_api_key_v44', apiKey);
        localStorage.setItem('rcm_model_name_v1', modelName);
        localStorage.setItem('rcm_ai_source_mode', aiSourceMode);
        localStorage.setItem('rcm_ai_provider', aiProvider);
        localStorage.setItem('rcm_azure_endpoint', azureEndpoint);
        localStorage.setItem('rcm_power_automate_url', powerAutomateUrl);
        localStorage.setItem('rcm_enable_chatbot', String(enableChatbot));
        localStorage.setItem('rcm_chatbot_style', chatbotStyle);
        localStorage.setItem('rcm_global_file_text', globalFileText);
        localStorage.setItem('rcm_global_file_name', globalFileName);
        localStorage.setItem('rcm_checklist_text', checklistText);
        localStorage.setItem('rcm_checklist_name', checklistFileName);
        localStorage.setItem('rcm_system_type', systemType);
        localStorage.setItem('rcm_system_modes', JSON.stringify(systemModes));
        localStorage.setItem('rcm_system_context_enabled', String(systemContextEnabled));
    }, [projects, apiKey, modelName, aiSourceMode, aiProvider, azureEndpoint, powerAutomateUrl, enableChatbot, chatbotStyle, globalFileText, globalFileName, checklistText, checklistFileName, systemType, systemModes, systemContextEnabled]);

    const FETCHABLE_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const;
    type FetchableProvider = typeof FETCHABLE_PROVIDERS[number];

    const doFetchModels = async (provider: FetchableProvider, key: string) => {
        if (!key || key.length < 10) return;
        setModelsFetching(true);
        try {
            const tiered = await AIService.fetchModels(provider, key);
            setLiveModels(prev => {
                const next = { ...prev, [provider]: tiered };
                localStorage.setItem('fmeca_models_cache', JSON.stringify(next));
                return next;
            });
        } catch (e) {
            console.warn('[ModelFetch] Failed:', e);
        } finally {
            setModelsFetching(false);
        }
    };

    // Auto-fetch when provider or apiKey changes (skip Azure/OpenRouter, respect 24h cache TTL)
    useEffect(() => {
        if (!(FETCHABLE_PROVIDERS as readonly string[]).includes(aiProvider)) return;
        const cached = liveModels[aiProvider];
        const TTL = 24 * 60 * 60 * 1000;
        if (cached && Date.now() - cached.fetchedAt < TTL) return;
        doFetchModels(aiProvider as FetchableProvider, apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [aiProvider, apiKey]);

    const createProject=()=>{ const now=nowIso(); const p:any={id:generateId(),name:"New Analysis",desc:"",createdAt:now,updatedAt:now,subsystems:[]}; setProjects([p,...projects]); setActiveProject(p); setView('editor'); };
    const closeEditor = () => { if(activeProject) setProjects(projects.map(p => p.id === activeProject.id ? activeProject : p)); setView('dashboard'); setActiveProject(null); };
    const deleteProject = (id: string, e: React.MouseEvent) => { e.stopPropagation(); ask("Delete this project?",() => { setProjects(prev => prev.filter(p => p.id !== id)); }); };

    const exportJSON = () => { if(!activeProject) return; const p:any = normalizeProjectDates(activeProject); const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(p)); const a = document.createElement('a'); a.href = dataStr; a.download = `FMECA_${p.name}.json`; a.click(); };
    const importJSON = (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { const imported:any = normalizeProjectDates(sanitizeProject(JSON.parse(e.target?.result as string))); imported.id = generateId(); setProjects([imported, ...projects]); } catch (err) { alert("Invalid File"); } }; reader.readAsText(file); };
    const downloadTemplate = () => { const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ "System": [{ "fail": "Desc", "mode": "Mode", "effect": "Effect", "cause": "Root", "task": "Task" }] }, null, 2)); const a = document.createElement('a'); a.href = dataStr; a.download = 'Library_Template.json'; a.click(); };
    const importLibrary = (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { setLibrary(prev => ({...prev, ...JSON.parse(e.target?.result as string)})); alert("Updated!"); } catch (err) { alert("Invalid File"); } }; reader.readAsText(file); };

    // eslint-disable-next-line
    const pickRootFolder = async () => {
        if(!storageProvider) return;
        if(!activeProject) return alert("Please open a project first.");
        try {
            const h = await pickFolder();
            await storageProvider.setRoot(activeProject.id, h);
            alert("Base folder set successfully.");
        } catch(e) { console.error(e); }
    };

    const openAttachments = async (type: 'sub' | 'fail', sub: Subsystem, fail: Failure | null = null) => {
        if(!storageProvider) return;
        setAttachModal({ open: true, type, entity: fail || sub, sub });
    };

    const getAttachmentPath = () => {
        if(!attachModal.open || !attachModal.sub) return [];
        const subName = sanitizeName(attachModal.sub.name);
        if(attachModal.type === 'sub') return ['Subsystems', subName];
        if(attachModal.type === 'fail' && attachModal.entity) {
            const failName = sanitizeName(attachModal.entity.desc);
            return ['Subsystems', subName, 'Failures', failName];
        }
        return [];
    };

    const downloadExcel = () => {
        if(!activeProject) return;
        const wb = XLSX.utils.book_new();
        const wsData: any[][] = [["Subsystem", "Specs", "Function", "Functional Failure", "Failure Mode", "Failure Effect", "Failure Cause", "Mitigation", "S", "O", "D", "RPN"]];
        const merges: any[] = []; let r = 1;
        activeProject.subsystems.forEach(sub => {
            const startRowSub = r;
            if(sub.failures.length === 0) { wsData.push([sub.name, sub.specs, sub.func, "", "", "", "", "", "", "", "", ""]); r++; } 
            else { sub.failures.forEach(fail => { const startRowFail = r; if(fail.modes.length === 0) { wsData.push([sub.name, sub.specs, sub.func, fail.desc, "", "", "", "", "", "", "", ""]); r++; } else { fail.modes.forEach(m => { const rpn = (Number(m.rpn.s)||1)*(Number(m.rpn.o)||1)*(Number(m.rpn.d)||1); wsData.push([sub.name, sub.specs, sub.func, fail.desc, m.mode, m.effect, m.cause, m.mitigation, m.rpn.s, m.rpn.o, m.rpn.d, rpn]); r++; }); } if(r-1 > startRowFail) merges.push({s:{r:startRowFail, c:3}, e:{r:r-1, c:3}}); }); }
            if(r-1 > startRowSub) { merges.push({s:{r:startRowSub, c:0}, e:{r:r-1, c:0}}); merges.push({s:{r:startRowSub, c:1}, e:{r:r-1, c:1}}); merges.push({s:{r:startRowSub, c:2}, e:{r:r-1, c:2}}); }
        });
        const ws = XLSX.utils.aoa_to_sheet(wsData); if(merges.length > 0) ws['!merges'] = merges;
        ws['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 25 }, { wch: 25 }, { wch: 20 }, { wch: 25 }, { wch: 25 }, { wch: 30 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 8 }];
        const border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
        const headStyle = { font: { bold: true, color: { rgb: "334155" } }, fill: { fgColor: { rgb: "F1F5F9" } }, border: border, alignment: { vertical: "center", horizontal: "center", wrapText: true } };
        const cellStyle = { border: border, alignment: { vertical: "top", wrapText: true } };
        const rpnStyle = { border: border, font: { bold: true }, alignment: { vertical: "top", horizontal: "center" } };
        // @ts-ignore
        const range = XLSX.utils.decode_range(ws['!ref']);
        for (let R = range.s.r; R <= range.e.r; ++R) { for (let C = range.s.c; C <= range.e.c; ++C) { const ref = XLSX.utils.encode_cell({ r: R, c: C }); if (!ws[ref]) ws[ref] = { t: 's', v: '' }; if (R === 0) ws[ref].s = headStyle; else ws[ref].s = (C === 11) ? rpnStyle : cellStyle; } }
        XLSX.utils.book_append_sheet(wb, ws, "FMEA"); XLSX.writeFile(wb, `FMECA_${activeProject.name.replace(/ /g, "_")}.xlsx`);
    };

    const captureMapImage = async (scale: number, format: 'png' | 'jpeg'): Promise<string | null> => {
        const element = document.querySelector('.hybrid-map-canvas') as HTMLElement;
        if (!element) return null;
        
        try {
            const filter = (node: HTMLElement) => {
                const exclusionClasses = ['sub-func-desc', 'map-export-hide'];
                if (node.classList && exclusionClasses.some(className => node.classList.contains(className))) {
                    return false;
                }
                return true;
            };

            const options = {
                backgroundColor: '#f8fafc',
                pixelRatio: scale,
                width: element.offsetWidth,
                height: element.offsetHeight,
                filter,
            };

            if (format === 'jpeg') {
                return await toJpeg(element, { ...options, quality: 0.88 });
            } else {
                return await toPng(element, options);
            }
        } catch (e) {
            console.error('Image capture failed:', e);
            return null;
        }
    };

    const downloadMap = async (scale: number) => {
        if (!activeProject) return;
        setShowDownloadOptions(false);
        setLoadingExport(true);
        try {
            const dataUrl = await captureMapImage(scale, 'png');
            if (!dataUrl) return;
            const link = document.createElement('a');
            link.download = `FMECA_Map_${activeProject.name}.png`;
            link.href = dataUrl;
            link.click();
        } catch { alert('Image export failed.'); } finally { setLoadingExport(false); }
    };

    const downloadPDF = async () => {
        if (!activeProject) return;
        setShowDownloadOptions(false);
        setLoadingExport(true);
        try {
            const imgData = await captureMapImage(2, 'jpeg');
            if (!imgData) return;
            const win = window.open('', '_blank');
            if (!win) { alert('Allow pop-ups to download PDF.'); return; }
            win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>FMECA Map – ${activeProject.name}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff}img{width:100%;height:auto;display:block}@page{size:landscape;margin:8mm}@media print{html,body{margin:0}}</style></head><body><img src="${imgData}"><script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script></body></html>`);
            win.document.close();
        } catch { alert('PDF export failed.'); } finally { setLoadingExport(false); }
    };

    const downloadInteractiveMap = () => {
        if (!activeProject) return;
        setShowDownloadOptions(false);
        const expandedIds = JSON.stringify([...treeExpanded]);
        const projectJson = JSON.stringify(activeProject);
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FMECA Map – ${activeProject.name}</title>
<script src="https://cdn.tailwindcss.com"><\/script>
<script>
tailwind.config={theme:{extend:{colors:{'brand':{500:'#6366f1',600:'#4f46e5',700:'#4338ca'},'slate':{850:'#1a2234',900:'#0f172a'}}}}}
<\/script>
<style>
*{box-sizing:border-box}
body{margin:0;padding:0;background:#f8fafc;font-family:Inter,system-ui,sans-serif}
#wrap{overflow:auto;padding:24px;padding-top:72px}
#map{position:relative}
.c{position:absolute;overflow:hidden;cursor:pointer;user-select:none;transition:transform .12s,box-shadow .12s;box-sizing:border-box}
.c:hover{transform:scale(1.04);z-index:200!important}
.clamp1{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ln{position:absolute;background:#cbd5e1;pointer-events:none}
#tip{display:none;position:fixed;z-index:9999;max-width:300px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2);padding:16px;pointer-events:none;font-family:Inter,system-ui,sans-serif}
</style>
</head>
<body>
<div class="fixed top-0 left-0 right-0 z-50 flex items-center gap-3 px-5 py-3 bg-white border-b border-slate-200 shadow-sm">
  <span class="text-sm font-bold text-slate-700 mr-2">${activeProject.name}</span>
  <button onclick="expandAll()" class="bg-white border border-slate-200 px-3 py-1.5 rounded text-xs font-bold text-slate-600 hover:bg-slate-50 shadow-sm">Expand All</button>
  <button onclick="collapseAll()" class="bg-white border border-slate-200 px-3 py-1.5 rounded text-xs font-bold text-slate-600 hover:bg-slate-50 shadow-sm">Collapse All</button>
</div>
<div id="wrap"><div id="map"></div></div>
<div id="tip"></div>
<script>
const DATA=${projectJson};
const INIT_EXP=new Set(${expandedIds});
const SYS_W=320,SYS_H=72,SUB_W=200,SUB_H=90,FF_W=190,FF_H=62,FM_W=215,FM_H=136;
const H_GAP=32,V_GAP=24,FM_V_GAP=16,COL_GAP=40;
const SYS_BOTTOM_TO_BUS=28,BUS_TO_SUB=28,PADDING=56,CONN_W=2;
let expanded=new Set(INIT_EXP);
function colW(sub){return expanded.has(sub.id)?SUB_W+H_GAP+FF_W+H_GAP+FM_W:SUB_W;}
function ffRowH(fail){if(!expanded.has(fail.id)||!fail.modes.length)return FF_H;return Math.max(FF_H,fail.modes.length*FM_H+(fail.modes.length-1)*FM_V_GAP);}
function groupH(sub){if(!expanded.has(sub.id)||!sub.failures.length)return SUB_H;let t=0;sub.failures.forEach((f,i)=>{t+=ffRowH(f);if(i<sub.failures.length-1)t+=V_GAP;});return Math.max(SUB_H,t);}
function layout(){
  const subs=DATA.subsystems,n=subs.length;
  const colXs=[];let curX=PADDING;
  subs.forEach(s=>{colXs.push(curX);curX+=colW(s)+COL_GAP;});
  const contentRight=n>0?curX-COL_GAP:PADDING;
  const cW=Math.max(SYS_W+PADDING*2,contentRight+PADDING);
  const sysX=(cW-SYS_W)/2,sysY=PADDING;
  const busY=sysY+SYS_H+SYS_BOTTOM_TO_BUS,subRowY=busY+BUS_TO_SUB;
  let maxGH=SUB_H;subs.forEach(s=>{maxGH=Math.max(maxGH,groupH(s));});
  const cH=subRowY+maxGH+PADDING;
  const map={};
  map[DATA.id]={x:sysX,y:sysY,w:SYS_W,h:SYS_H};
  subs.forEach((sub,i)=>{
    const gh=groupH(sub),colX=colXs[i];
    const subY=subRowY+Math.max(0,(gh-SUB_H)/2);
    map[sub.id]={x:colX,y:subY,w:SUB_W,h:SUB_H};
    if(!expanded.has(sub.id))return;
    let cur=subRowY;const ffX=colX+SUB_W+H_GAP,fmX=ffX+FF_W+H_GAP;
    sub.failures.forEach((fail,fi)=>{
      const rh=ffRowH(fail),ffY=cur+Math.max(0,(rh-FF_H)/2);
      map[fail.id]={x:ffX,y:ffY,w:FF_W,h:FF_H};
      if(expanded.has(fail.id))fail.modes.forEach((m,mi)=>{map[m.id]={x:fmX,y:cur+mi*(FM_H+FM_V_GAP),w:FM_W,h:FM_H};});
      cur+=rh;if(fi<sub.failures.length-1)cur+=V_GAP;
    });
  });
  return{map,cW,cH,busY,colXs};
}
function conn(x,y,w,h){const d=document.createElement('div');d.className='ln';Object.assign(d.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});return d;}
function hln(x1,y,x2){const x=Math.min(x1,x2),w=Math.abs(x2-x1);if(w<1)return null;return conn(x,Math.round(y)-1,w,CONN_W);}
function vln(x,y1,y2){const y=Math.min(y1,y2),h=Math.abs(y2-y1);if(h<1)return null;return conn(Math.round(x)-1,y,CONN_W,h);}
function rpnVal(m){const v=Number(m.rpn.s)*Number(m.rpn.o)*Number(m.rpn.d);return isNaN(v)||v===0?'':String(v);}
function esc(s){const d=document.createElement('div');d.textContent=String(s||'');return d.innerHTML;}
let hoverTimer=null;
let hideTimer=null;
function startHover(e,type,data){
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  const r=e.currentTarget.getBoundingClientRect();
  hoverTimer=setTimeout(()=>showTip(r,type,data),1000);
}
function endHover(typeOverride){
  clearTimeout(hoverTimer);
  const tip=document.getElementById('tip');
  if(typeOverride==='sys' || tip.getAttribute('data-type')==='sys'){
    hideTimer=setTimeout(()=>tip.style.display='none',500);
  }else{
    tip.style.display='none';
  }
}
function cancelHide(){clearTimeout(hideTimer);}
function showTip(r,type,data){
  const tip=document.getElementById('tip');
  tip.setAttribute('data-type',type);
  if(type==='sys'){
    tip.style.pointerEvents='auto';
    tip.style.overflowY='auto';
    tip.style.maxHeight='50vh';
    tip.classList.add('scroll-thin');
    tip.onmouseenter=cancelHide;
    tip.onmouseleave=()=>endHover('sys');
  }else{
    tip.style.pointerEvents='none';
    tip.style.overflowY='visible';
    tip.style.maxHeight='none';
    tip.classList.remove('scroll-thin');
    tip.onmouseenter=null;
    tip.onmouseleave=null;
  }
  let h='';
  if(type==='sys'){
    h='<div style="font-weight:700;color:#1e293b;font-size:13px;margin-bottom:8px">'+esc(data.name)+'</div>';
    if(data.desc)h+='<div style="margin-bottom:6px"><div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Description</div><div style="font-size:12px;color:#334155;line-height:1.5">'+esc(data.desc)+'</div></div>';
  }else if(type==='sub'){
    h='<div style="font-weight:700;color:#1e293b;font-size:13px;margin-bottom:8px">'+esc(data.name)+'</div>';
    if(data.func)h+='<div style="margin-bottom:6px"><div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Function</div><div style="font-size:12px;color:#334155;line-height:1.5">'+esc(data.func)+'</div></div>';
    if(data.specs)h+='<div><div style="font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Specs</div><div style="font-size:12px;color:#64748b;line-height:1.5">'+esc(data.specs)+'</div></div>';
  }else if(type==='ff'){
    h='<div style="font-weight:700;color:#1e293b;font-size:13px;margin-bottom:8px">'+esc(data.desc)+'</div>';
  }else{
    h='<div style="font-weight:700;color:#1e293b;font-size:13px;margin-bottom:8px">'+esc(data.mode)+'</div>';
    if(data.effect)h+='<div style="font-size:11px;color:#ef4444;font-weight:700;margin-bottom:4px">'+esc(data.effect)+'</div>';
    if(data.cause)h+='<div style="font-size:11px;color:#64748b;font-style:italic;margin-bottom:4px">'+esc(data.cause)+'</div>';
    if(data.mitigation)h+='<div style="font-size:11px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;padding:4px 8px;border-radius:4px;font-weight:600;margin-bottom:6px">'+esc(data.mitigation)+'</div>';
    const rv=rpnVal(data);if(rv)h+='<div style="font-size:11px;color:#94a3b8">RPN: <b style="color:#475569;font-size:13px">'+rv+'</b></div>';
  }
  tip.innerHTML=h;
  tip.style.display='block';
  let left=r.right+10;
  if(left+310>window.innerWidth)left=r.left-310-10;
  tip.style.left=Math.max(8,left)+'px';
  if(r.top>window.innerHeight/2){tip.style.top='auto';tip.style.bottom=Math.max(8,window.innerHeight-r.bottom)+'px';}else{tip.style.bottom='auto';tip.style.top=Math.max(8,r.top)+'px';}
}
function mk(cls,style,html){const d=document.createElement('div');d.className=cls;if(style)Object.assign(d.style,style);if(html!==undefined)d.innerHTML=html;return d;}
function render(){
  const mel=document.getElementById('map');mel.innerHTML='';
  const{map,cW,cH,busY,colXs}=layout();
  mel.style.width=cW+'px';mel.style.height=cH+'px';
  const sl=map[DATA.id];
  // System card
  const sc=mk('c bg-slate-900 text-white border border-slate-800 rounded-xl px-6 py-4 shadow-lg text-center',
    {left:sl.x+'px',top:sl.y+'px',width:SYS_W+'px',height:SYS_H+'px',zIndex:20,cursor:'default'},
    '<div class="font-bold text-base leading-tight clamp1">'+esc(DATA.name)+'</div>'+(DATA.desc?'<div class="text-xs text-slate-400 mt-1 clamp2">'+esc(DATA.desc)+'</div>':''));
  sc.addEventListener('mouseenter',e=>startHover(e,'sys',DATA));
  sc.addEventListener('mouseleave',()=>endHover('sys'));
  mel.appendChild(sc);
  // Sys→bus connector
  const sysCx=sl.x+SYS_W/2,sysBot=sl.y+SYS_H;
  const sv=vln(sysCx,sysBot,busY);if(sv)mel.appendChild(sv);
  const subCxs=DATA.subsystems.map((_,i)=>colXs[i]+SUB_W/2);
  if(subCxs.length>1){const bh=hln(Math.min(...subCxs),busY,Math.max(...subCxs));if(bh)mel.appendChild(bh);}
  DATA.subsystems.forEach((sub,i)=>{
    const s=map[sub.id];if(!s)return;
    const isExp=expanded.has(sub.id),subCx=s.x+SUB_W/2;
    const dv=vln(subCx,busY,s.y);if(dv)mel.appendChild(dv);
    // Sub card — exact same classes as React app
    const card=mk('c bg-white border border-slate-200 border-l-[5px] border-l-brand-500 rounded-lg p-3 shadow-sm',
      {left:s.x+'px',top:s.y+'px',width:SUB_W+'px',height:SUB_H+'px',zIndex:20},
      '<div class="font-bold text-sm text-slate-700 leading-tight clamp1">'+esc(sub.name)+'</div>'+
      (sub.func?'<div class="text-xs text-slate-500 mt-1 leading-tight clamp2">'+esc(sub.func)+'</div>':'')+
      '<div class="text-slate-400 mt-1 flex items-center gap-1" style="font-size:10px"><span>'+sub.failures.length+' FF</span><span>'+(isExp?'▲':'▼')+'</span></div>');
    card.addEventListener('click',()=>toggle(sub.id));
    card.addEventListener('mouseenter',e=>startHover(e,'sub',sub));
    card.addEventListener('mouseleave',endHover);
    mel.appendChild(card);
    if(!isExp||!sub.failures.length)return;
    const subMY=s.y+SUB_H/2,ffBX=s.x+SUB_W+H_GAP/2;
    const ffL=sub.failures.map(f=>map[f.id]).filter(Boolean);
    if(!ffL.length)return;
    const hc=hln(s.x+SUB_W,subMY,ffBX);if(hc)mel.appendChild(hc);
    const vt=Math.min(subMY,ffL[0].y+FF_H/2),vb=Math.max(subMY,ffL[ffL.length-1].y+FF_H/2);
    if(vt<vb){const vc=vln(ffBX,vt,vb);if(vc)mel.appendChild(vc);}
    sub.failures.forEach(fail=>{
      const f=map[fail.id];if(!f)return;
      const fExp=expanded.has(fail.id),ffMY=f.y+FF_H/2;
      const fhc=hln(ffBX,ffMY,f.x);if(fhc)mel.appendChild(fhc);
      // FF card
      const fc=mk('c bg-white border border-slate-200 border-l-[5px] border-l-amber-500 rounded-lg p-2 shadow-sm',
        {left:f.x+'px',top:f.y+'px',width:FF_W+'px',height:FF_H+'px',zIndex:20},
        '<div class="font-bold text-xs text-slate-700 leading-tight clamp2">'+esc(fail.desc||'Unnamed')+'</div>'+
        '<div class="text-slate-400 mt-1 flex items-center gap-1" style="font-size:10px"><span>'+fail.modes.length+' FM</span><span>'+(fExp?'▲':'▼')+'</span></div>');
      fc.addEventListener('click',()=>toggle(fail.id));
      fc.addEventListener('mouseenter',e=>startHover(e,'ff',fail));
      fc.addEventListener('mouseleave',endHover);
      mel.appendChild(fc);
      if(!fExp||!fail.modes.length)return;
      const fmBX=f.x+FF_W+H_GAP/2;
      const fmL=fail.modes.map(m=>map[m.id]).filter(Boolean);
      if(!fmL.length)return;
      const fmhc=hln(f.x+FF_W,ffMY,fmBX);if(fmhc)mel.appendChild(fmhc);
      const fmvt=Math.min(ffMY,fmL[0].y+FM_H/2),fmvb=Math.max(ffMY,fmL[fmL.length-1].y+FM_H/2);
      if(fmvt<fmvb){const fmvc=vln(fmBX,fmvt,fmvb);if(fmvc)mel.appendChild(fmvc);}
      fail.modes.forEach(mode=>{
        const m=map[mode.id];if(!m)return;
        const mc=hln(fmBX,m.y+FM_H/2,m.x);if(mc)mel.appendChild(mc);
        const rv=rpnVal(mode);
        // FM card — exact same classes as React app
        const mcard=mk('c bg-white border border-slate-200 border-l-[5px] border-l-red-500 rounded-lg p-2 shadow-sm',
          {left:m.x+'px',top:m.y+'px',width:FM_W+'px',height:FM_H+'px',zIndex:20},
          '<div class="font-bold text-slate-700 mb-1 leading-tight clamp2" style="font-size:11px">'+esc(mode.mode||'Unnamed')+'</div>'+
          (mode.effect?'<div class="font-bold mb-1 leading-tight clamp1" style="font-size:10px;color:#ef4444">'+esc(mode.effect)+'</div>':'')+
          (mode.cause?'<div class="italic mb-1 leading-tight clamp1" style="font-size:10px;color:#64748b">'+esc(mode.cause)+'</div>':'')+
          (mode.mitigation?'<div class="font-bold leading-tight clamp2" style="font-size:10px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;padding:3px 6px;border-radius:4px;margin-top:3px">'+esc(mode.mitigation)+'</div>':'')+
          (rv?'<div style="font-size:10px;color:#94a3b8;margin-top:4px">RPN: <span style="font-weight:700;color:#475569">'+rv+'</span></div>':''));
        mcard.addEventListener('mouseenter',e=>startHover(e,'fm',mode));
        mcard.addEventListener('mouseleave',endHover);
        mel.appendChild(mcard);
      });
    });
  });
}
function toggle(id){if(expanded.has(id))expanded.delete(id);else expanded.add(id);render();}
function expandAll(){expanded=new Set([DATA.id]);DATA.subsystems.forEach(s=>{expanded.add(s.id);s.failures.forEach(f=>{expanded.add(f.id);f.modes.forEach(m=>expanded.add(m.id));});});render();}
function collapseAll(){expanded=new Set([DATA.id]);render();}
render();
<\/script>
</body>
</html>`;
        const blob = new Blob([html], { type: 'text/html' });
        const link = document.createElement('a');
        link.download = `FMECA_Map_${activeProject.name.replace(/ /g, '_')}.html`;
        link.href = URL.createObjectURL(blob);
        link.click();
        URL.revokeObjectURL(link.href);
    };

    const updateHeader = (k: keyof Project, v: any) => { setActiveProject(p => p ? touchProject({ ...p, [k]: v }) : p); };
    const updateSub = (id: string, k: keyof Subsystem, v: any) => { setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.map(s => s.id === id ? { ...s, [k]: v } : s) }) : p); };
    const addSub = () => { setActiveProject(p => p ? touchProject({ ...p, subsystems: [...p.subsystems, {id: generateId(), name: "", func: "", specs: "", imageData: "", imageName: "", imageJson: "", showImageJson: false, failures: []}] }) : p); };
    const deleteSub = (id: string) => { if (!activeProject) return; ask("Delete Subsystem?", () => { setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.filter(s => s.id !== id) }) : p ); }); };
    const toggleSub = (id: string) => { setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.map(s => s.id === id ? { ...s, collapsed: !s.collapsed } : s) }) : p); };
    const handleSubImageUpload = (subId: string, file: File) => { if (!file || !activeProject) return; const reader = new FileReader(); reader.onload = (e) => { const result = e.target && e.target.result ? String(e.target.result) : ""; const base64 = result.includes(",") ? result.split(",")[1] : result; setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.map(s => s.id === subId ? { ...s, imageData: base64, imageName: file.name || "image" } : s) }) : null); }; reader.readAsDataURL(file); };
    const analyzeSubImage = async (subId: string) => { if(!activeProject) return; const sub = activeProject.subsystems.find(s => s.id === subId); if (!sub || !sub.imageData) { alert("Upload image."); return; } if (!apiKey) { alert("API Key required."); return; } try { const raw = await AIService.analyzeImageForSubsystem(sub.imageData, apiKey, modelName); let clean = (raw || "").trim(); if (clean.startsWith("```")) clean = clean.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```$/m, "").trim(); let specs = ""; try { const parsed = JSON.parse(clean); if (parsed && parsed.specs) specs = parsed.specs.trim(); } catch (e) {} setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.map(s => s.id === subId ? { ...s, imageJson: clean, showImageJson: true, specs: specs || s.specs } : s) }) : null); } catch (e) { alert("Error: " + e); } };
    const toggleImageJson = (subId: string) => { if(activeProject) setActiveProject(p => p ? touchProject({ ...p, subsystems: p.subsystems.map(s => s.id === subId ? { ...s, showImageJson: !s.showImageJson } : s) }) : null); };
    const addFail = (sId: string) => { if(activeProject) setActiveProject(p => p ? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: [...s.failures, {id: generateId(), desc: "", modes: []}]} : s)}) : null); };
    const updateFail = (sId: string, fId: string, v: string) => { if(activeProject) setActiveProject(p => p ? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: s.failures.map(f => f.id === fId ? {...f, desc: v} : f)} : s)}) : null); };
    const deleteFail = (sId: string, fId: string) => {if (!activeProject) return; ask("Delete Failure?", () => {setActiveProject(p => p? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? { ...s, failures: s.failures.filter(f => f.id !== fId) } : s )}) : p ); }); };
    const toggleFail = (sId: string, fId: string) => { if(activeProject) setActiveProject(p => p ? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: s.failures.map(f => f.id === fId ? {...f, collapsed: !f.collapsed} : f)} : s)}) : null); };
    const addMode = (sId: string, fId: string, data?: Mode) => { if(activeProject) setActiveProject(p => p ? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: s.failures.map(f => f.id === fId ? {...f, collapsed: false, modes: [...f.modes, data || {id: generateId(), mode:"", effect:"", cause:"", mitigation:"", rpn:{s:5,o:5,d:5}}]} : f)} : s)}) : null); };
    const updateMode = (sId: string, fId: string, mId: string, k: keyof Mode, v: any) => { if(activeProject) setActiveProject(p => p ? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: s.failures.map(f => f.id === fId ? {...f, modes: f.modes.map(m => m.id === mId ? {...m, [k]: v} : m)} : f)} : s)}) : null); };
    const deleteMode = (sId: string, fId: string, mId: string) => {if (!activeProject) return; ask("Delete Mode?", () => {setActiveProject(p => p? touchProject({...p, subsystems: p.subsystems.map(s => s.id === sId? {...s, failures: s.failures.map(f => f.id === fId ? { ...f, modes: f.modes.filter(m => m.id !== mId) } : f ) }: s )}) : p ); }); };
    // const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop=(e:React.DragEvent,dropIndex:number)=>{ e.preventDefault(); setDragId(null); setDragAllowed(null); };


    const handleDragStart = (e: React.DragEvent, i: number) => { setDragId(i); e.dataTransfer.setData('subIndex', String(i)); e.dataTransfer.effectAllowed='move'; };
    const handleDragEnd = () => { setDragId(null); setDragAllowed(null); };
     
    const moveItem = (arr:any[], from:number, to:number) => { const a=[...arr]; const [x]=a.splice(from,1); a.splice(to,0,x); return a; };

    const handleDragEnter = (i:number) => { 
    if(!activeProject) return; 
    if(dragId===null || dragId===i) return; 
    const newSubs = moveItem(activeProject.subsystems, dragId, i); 
    setActiveProject(p=>p? touchProject({ ...p, subsystems:newSubs }) : p); 
    setDragId(i); 
    };


    const aiScoreModeRpn = async (sId:any, fId:any, mId:any) => { try { if(!activeProject) return; if(!apiKey && aiProvider !== 'copilot') return alert("API Key required."); const sid=String(sId), fid=String(fId), mid=String(mId); const sub=activeProject.subsystems.find(s=>String(s.id)===sid); const fail=sub?.failures.find(f=>String(f.id)===fid); const mode=fail?.modes.find(m=>String(m.id)===mid); if(!sub||!fail||!mode) return alert("RPN AI error: Mode not found"); setRpnLoadingId(mid); const r=await AIService.evaluateRpnFromText({ project: activeProject.name, subName: sub.name||"", subSpecs: sub.specs||"", subFunc: sub.func||"", failDesc: fail.desc||"", mode: mode.mode||"", effect: mode.effect||"", cause: mode.cause||"", mitigation: mode.mitigation||"", key: apiKey, modelName, modeSource: aiSourceMode as any, refText: globalFileText||"", aiProvider, azureEndpoint, systemContext, powerAutomateUrl }); setActiveProject(p=>!p? p : ({...p, subsystems: p.subsystems.map(s=>String(s.id)!==sid? s : ({...s, failures: s.failures.map(f=>String(f.id)!==fid? f : ({...f, modes: f.modes.map(m=>String(m.id)!==mid? m : ({...m, rpn:{...m.rpn, s:r.s, o:r.o, d:r.d}}))}))}))})); } catch(e:any){ console.error(e); alert("RPN AI error: " + (e?.message||e)); } finally { setRpnLoadingId(String(mId)); setTimeout(()=>setRpnLoadingId(null), 150); } };


    const setBusy = (id: string, on: boolean) => setRpnBusy(prev => { const next = new Set(prev); on ? next.add(id) : next.delete(id); return next; });

    const autoGen = async (sId: string, name: string, specs: string, func: string) => {
        setGenId(sId);
        if (!activeProject) { setGenId(null); return; }
        const sub = activeProject.subsystems.find(s => s.id === sId);
        if (!sub) { setGenId(null); return; }
        if (isSubExhausted(sub)) { setGenId(null); return; }  // defense-in-depth

        const existingFailures = sub.failures.filter(f => f.desc).map(f => f.desc);

        // Step 1 — Decompose, invert, match. Result tells us if more work is needed and what's missing.
        const analysis = await AIService.analyzeFunctionCoverage(func, existingFailures, apiKey, modelName, aiProvider, azureEndpoint, powerAutomateUrl);

        if (analysis.is_exhausted) {
            // Persist the exhaustion flag and append one blank row for manual entry.
            setActiveProject(p => p ? ({
                ...p,
                subsystems: p.subsystems.map(s => {
                    if (s.id !== sId) return s;
                    const newFailures = [...s.failures, { id: generateId(), desc: '', modes: [] }];
                    return {
                        ...s,
                        failures: newFailures,
                        exhaustionState: {
                            funcHash: simpleHash(s.func || ''),
                            failureCount: newFailures.length,
                            isExhausted: true,
                        },
                    };
                }),
            }) : null);
            setGenId(null);
            return;
        }

        // Step 2 — Bounded generation: produce failures only for the missing pairs.
        const res = await AIService.generateCompleteSubsystem(
            name, specs, func, activeProject.name, apiKey, modelName, aiSourceMode,
            globalFileText, aiProvider, azureEndpoint, systemContext, checklistText,
            powerAutomateUrl, existingFailures, analysis.missing_pairs
        );

        if (res && res.failures && res.failures.length > 0) {
            setActiveProject(p => p ? ({
                ...p,
                subsystems: p.subsystems.map(s => s.id !== sId ? s : {
                    ...s,
                    failures: [...s.failures, ...res.failures.map((f: any) => ({
                        ...f,
                        id: generateId(),
                        modes: (f.modes || []).map((m: any) => ({ ...m, id: generateId() })),
                    }))],
                    exhaustionState: undefined,
                }),
            }) : null);
        } else {
            addFail(sId);
        }
        setGenId(null);
    };
    const genModes = async (sId: string, fId: string, name: string, specs: string, func: string, failDesc: string) => { setModeGenId(fId); if(activeProject) { const modes = await AIService.generateModesForFailure(failDesc, name, specs, func, activeProject.name, apiKey, modelName, aiSourceMode, globalFileText, aiProvider, azureEndpoint, systemContext, checklistText, powerAutomateUrl); if(modes) setActiveProject(p => p ? ({...p, subsystems: p.subsystems.map(s => s.id === sId ? {...s, failures: s.failures.map(f => f.id === fId ? {...f, collapsed: false, modes: [...f.modes, ...modes.map(m => ({...m, id: generateId()}))]} : f)} : s)}) : null); } setModeGenId(null); };
    const masterGen = async () => {
        if (!apiKey && aiProvider !== 'copilot') return alert("API Key required.");
        if (!activeProject?.name) return alert("Enter System Name.");
        setLoadingMaster(true);

        // Step 1: Generate subsystem skeletons (name, specs, func, initial failures)
        const rawSubs = await AIService.generateMasterStructure(activeProject.name, activeProject.desc, apiKey, modelName, aiSourceMode, globalFileText, aiProvider, azureEndpoint, systemContext, powerAutomateUrl);
        if (!rawSubs || !Array.isArray(rawSubs) || rawSubs.length === 0) { alert("Generation failed."); setLoadingMaster(false); return; }

        // Build a rich project context so all downstream steps see the full system description,
        // not just the name — this is what generateMasterStructure already receives via sysDesc.
        const projectContext = activeProject.desc
            ? `${activeProject.name}: ${activeProject.desc.substring(0, 800)}`
            : activeProject.name;

        const completedSubs: any[] = [];
        for (const s of rawSubs) {
            // Step 2: Regenerate func using the same mechanism as the Function field magic wand
            // Pass projectContext so the function description is aware of the full system config.
            const funcDesc = await AIService.generate("Function", "", apiKey, modelName, aiSourceMode, globalFileText, { project: projectContext, subsystem: s.name, specs: s.specs }, aiProvider, azureEndpoint, systemContext, powerAutomateUrl);
            const enrichedSub = { ...s, func: funcDesc || s.func };

            // Step 3: Derive comprehensive functional failures — pass full projectContext.
            const expanded = await AIService.generateCompleteSubsystem(enrichedSub.name, enrichedSub.specs, enrichedSub.func, projectContext, apiKey, modelName, aiSourceMode, globalFileText, aiProvider, azureEndpoint, systemContext, checklistText, powerAutomateUrl);
            const failures: any[] = expanded?.failures?.length > 0 ? expanded.failures : (enrichedSub.failures || []);

            // Step 4: Derive comprehensive failure modes — pass full projectContext.
            const fullFailures: any[] = [];
            for (const f of failures) {
                const modes = await AIService.generateModesForFailure(f.desc, enrichedSub.name, enrichedSub.specs, enrichedSub.func, projectContext, apiKey, modelName, aiSourceMode, globalFileText, aiProvider, azureEndpoint, systemContext, checklistText, powerAutomateUrl);
                fullFailures.push({ ...f, modes: modes?.length > 0 ? modes : (f.modes || []) });
            }
            completedSubs.push({ ...enrichedSub, failures: fullFailures });
        }

        const newSubs = completedSubs.map(s => ({
            id: generateId(), name: s.name, specs: s.specs, func: s.func,
            imageData: "", imageName: "", imageJson: "", showImageJson: false,
            failures: (s.failures || []).map((f: any) => ({
                id: generateId(), desc: f.desc,
                modes: (f.modes || []).map((m: any) => ({ id: generateId(), mode: m.mode, effect: m.effect, cause: m.cause, mitigation: m.mitigation, rpn: m.rpn || { s: 5, o: 5, d: 5 } }))
            }))
        }));
        setActiveProject(p => p ? ({ ...p, subsystems: [...p.subsystems, ...newSubs] }) : null);
        setLoadingMaster(false);
    };
    const injectLib = (item: LibraryItem) => { if(!activeProject) return; if(activeProject.subsystems.length === 0) return alert("Add Subsystem"); let targetSubId = activeSubId || activeProject.subsystems[0].id; const targetIndex = activeProject.subsystems.findIndex(s => s.id === targetSubId); if(targetIndex === -1) return; const nm: Mode = {id: generateId(), mode: item.mode, effect: item.effect || "", cause: item.cause, mitigation: item.task, rpn:{s:5,o:5,d:5}}; const nf: Failure = {id: generateId(), desc: item.fail || `Failure`, modes: [nm]}; const newSubs = [...activeProject.subsystems]; newSubs[targetIndex] = {...newSubs[targetIndex], failures: [...newSubs[targetIndex].failures, nf]}; setActiveProject({...activeProject, subsystems: newSubs}); };
    const getRpnColor = (r: number) => r >= 100 ? "bg-red-100 text-red-800" : r >= 40 ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800";
    const getSubRowSpan = (sub: Subsystem) => { if (sub.failures.length === 0) return 1; return sub.failures.reduce((acc, f) => acc + (f.modes.length || 1), 0); };
    const getFailRowSpan = (fail: Failure) => fail.modes.length || 1;

    return (
        <div className="h-screen flex flex-col font-sans text-slate-700 bg-slate-50">
            <header className="h-14 bg-slate-900 text-white flex items-center justify-between px-6 shadow-md shrink-0 z-20">
                <div className="flex items-center gap-2 cursor-pointer" onClick={() => { if(view==='editor') closeEditor(); }}>
                    <img src="icon-512.png" className="w-12 h-12 rounded" alt="FMECA Studio"/><span className="font-bold">FMECA Studio</span>{activeProject && <span className="text-xs text-slate-400 ml-2 animate-pulse">• Auto-saved</span>}
                </div>
                {view === 'editor' && activeProject && (
                    <div className="flex items-center gap-2">
                        <div className={`flex items-center gap-2 overflow-hidden transition-all duration-300 ease-in-out ${showToolbar ? 'max-w-[500px] opacity-100 mr-2' : 'max-w-0 opacity-0'}`}>
                            <button onClick={() => setShowRPN(!showRPN)} className={`px-3 py-1 rounded text-xs font-bold whitespace-nowrap ${showRPN?'bg-green-600':'bg-slate-700'}`}>RPN</button>
                            <button onClick={downloadExcel} className="text-xs font-bold bg-green-700 px-3 py-1 rounded flex items-center gap-1 hover:bg-green-600 whitespace-nowrap"><Icon name="excel"/> Download</button>
                            <button onClick={exportJSON} className="text-xs font-bold bg-slate-800 px-3 py-1 rounded border border-slate-600 flex gap-1 items-center whitespace-nowrap"><Icon name="code"/> Export</button>
                            <button onClick={() => setShowLib(!showLib)} className="text-xs font-bold bg-slate-800 px-3 py-1 rounded border border-slate-600 whitespace-nowrap">Library</button>
                        </div>
                        <button onClick={() => setShowToolbar(!showToolbar)} className="text-slate-400 hover:text-white transition p-2 bg-slate-800 rounded hover:bg-slate-700" title="Tools">
                            <Icon name={showToolbar ? "chevronRight" : "gear"} className="w-5 h-5" />
                        </button>
                        <div className="flex bg-slate-800 rounded p-1">
                            <button onClick={() => setTab('build')} className={`px-3 py-1 rounded text-xs font-bold ${tab==='build'?'bg-brand-600':'text-slate-400'}`}>Build</button>
                            <button onClick={() => setTab('viewTable')} className={`px-3 py-1 rounded text-xs font-bold ${tab==='viewTable'?'bg-brand-600':'text-slate-400'}`}>Table</button>
                            <button onClick={() => setTab('map')} className={`px-3 py-1 rounded text-xs font-bold ${tab==='map'?'bg-brand-600':'text-slate-400'}`}>Map</button>
                        </div>
                        <button onClick={closeEditor} className="text-xs font-bold text-slate-400 hover:text-white ml-2 flex items-center gap-1"><Icon name="arrowLeft"/> Exit</button>
                    </div>
                )}
            </header>
             {confirmBox.run && (
  <div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center" onMouseDown={closeAsk}>
    <div className="bg-white rounded-xl p-4 w-[92vw] max-w-sm border" onMouseDown={(e)=>e.stopPropagation()}>
      <div className="text-sm text-slate-700">{confirmBox.msg}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="px-3 py-2 text-sm border rounded-lg" onClick={closeAsk}>Cancel</button>
        <button className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg"
          onClick={() => { const fn = confirmBox.run; closeAsk(); fn?.(); }}>
          Delete
        </button>
      </div>
    </div>
  </div>
)}    
            {activeProject && enableChatbot && view === 'editor' && (
  <Chatbot
    activeProject={activeProject}
    apiKey={apiKey}
    modelName={modelName}
    responseStyle={chatbotStyle}
    aiProvider={aiProvider}
    azureEndpoint={azureEndpoint}
    systemContext={systemContext}
    powerAutomateUrl={powerAutomateUrl}
  />
)}

            {view === 'dashboard' && (
                <div className="flex-1 p-10 overflow-y-auto flex flex-col">
                    <div className="max-w-5xl mx-auto w-full flex-1">
                        <div className="flex justify-between items-end mb-8">
                            <div><h1 className="text-3xl font-bold text-slate-900">FMECA Studio</h1><div className="mt-3 flex gap-2 text-xs"><button onClick={() => setDashboardTab('projects')} className={`px-3 py-1 rounded-full border font-semibold ` + (dashboardTab === 'projects' ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-100 text-slate-600 border-slate-300')}>Projects</button><button onClick={() => setDashboardTab('settings')} className={`px-3 py-1 rounded-full border font-semibold ` + (dashboardTab === 'settings' ? 'bg-slate-900 text-white border-slate-900' : 'bg-slate-100 text-slate-600 border-slate-300')}>Settings</button></div></div>
                            {dashboardTab === 'projects' && (<div className="flex gap-2"><label className="bg-white border text-slate-600 px-4 py-2 rounded font-bold flex gap-2 cursor-pointer hover:bg-slate-50"><Icon name="upload" /> Import<input type="file" accept=".json" className="hidden" onChange={importJSON}/></label><button onClick={createProject} className="bg-slate-900 text-white px-4 py-2 rounded font-bold flex gap-2"><Icon name="plus" /> New</button></div>)}
                        </div>
                        {dashboardTab === 'projects' ? (
                            <div className="grid md:grid-cols-3 gap-6 mb-12">
                                {projects.map(p => (
                                    <div key={p.id} onClick={() => { setActiveProject(p); setView('editor'); }} className="bg-white p-6 rounded shadow hover:shadow-lg cursor-pointer relative group">
                                        <button onClick={(e) => deleteProject(p.id, e)} className="absolute top-4 right-4 text-slate-300 hover:text-red-500 transition z-10 p-1"><Icon name="trash"/></button>
                                        <h3 className="font-bold text-lg">{p.name}</h3><p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.desc || "No description."}</p><div className="mt-4 flex justify-between items-center text-xs text-slate-400"><span>Created: {fmtDate((p as any).createdAt)}</span><span>Updated: {fmtDate((p as any).updatedAt)}</span></div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <>
                                <div className="bg-white p-6 rounded border max-w-xl">
                                    <h2 className="text-lg font-semibold mb-4">AI Provider</h2>
                                    <div className="flex flex-wrap gap-1 bg-slate-100 p-1 rounded mb-5">
                                        {(Object.keys(PROVIDER_LABELS) as AIProvider[]).map(p => (
                                            <button key={p} onClick={() => { setAiProvider(p); setModelName(DEFAULT_MODELS[p]); }} className={`px-3 py-1.5 rounded text-xs font-bold transition ${aiProvider === p ? 'bg-brand-600 text-white shadow' : 'text-slate-500 hover:text-slate-700 hover:bg-white'}`}>{PROVIDER_LABELS[p]}</button>
                                        ))}
                                    </div>
                                    <div className="space-y-3">
                                        {aiProvider !== 'copilot' && (
                                        <div>
                                            <label className="block text-xs font-semibold text-slate-500 mb-1">API Key</label>
                                            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono outline-none focus:border-brand-500" placeholder={API_KEY_PLACEHOLDERS[aiProvider]}/>
                                        </div>
                                        )}
                                        {aiProvider === 'azure' && (
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-500 mb-1">Azure Endpoint</label>
                                                <input type="text" value={azureEndpoint} onChange={e => setAzureEndpoint(e.target.value)} className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono outline-none focus:border-brand-500" placeholder="https://your-resource.openai.azure.com"/>
                                            </div>
                                        )}
                                        {aiProvider === 'copilot' && (
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-500 mb-1">Power Automate URL</label>
                                                <input type="text" value={powerAutomateUrl} onChange={e => setPowerAutomateUrl(e.target.value)} className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono outline-none focus:border-brand-500" placeholder="https://prod-xx.westus.logic.azure.com/workflows/..."/>
                                            </div>
                                        )}
                                        {aiProvider === 'copilot' ? (
                                            <p className="text-xs text-slate-400 mt-1">Model selection is managed by Copilot Studio. No model ID is required here.</p>
                                        ) : aiProvider === 'azure' ? (
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-500 mb-1">Deployment Name</label>
                                                <input type="text" value={modelName} onChange={e => setModelName(e.target.value)} className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono outline-none focus:border-brand-500" placeholder="your-deployment-name"/>
                                            </div>
                                        ) : aiProvider === 'openrouter' ? (
                                            <div>
                                                <label className="block text-xs font-semibold text-slate-500 mb-1">Model</label>
                                                <ModelSelector
                                                    value={modelName}
                                                    onChange={setModelName}
                                                    liveModels={null}
                                                    fallbackModels={[]}
                                                    provider="openrouter"
                                                    allowCustomList={true}
                                                />
                                                <p className="text-xs text-slate-400 mt-1">Add any OpenRouter model ID (e.g. anthropic/claude-3-5-sonnet, meta-llama/llama-3-70b-instruct)</p>
                                            </div>
                                        ) : (
                                            <div>
                                                <div className="flex items-center justify-between mb-1">
                                                    <label className="block text-xs font-semibold text-slate-500">Model</label>
                                                    {(FETCHABLE_PROVIDERS as readonly string[]).includes(aiProvider) && (
                                                        <div className="flex items-center gap-2">
                                                            {liveModels[aiProvider] && (
                                                                <span className="text-[10px] text-slate-400">
                                                                    Updated {new Date(liveModels[aiProvider].fetchedAt).toLocaleDateString()}
                                                                </span>
                                                            )}
                                                            <button
                                                                onClick={() => doFetchModels(aiProvider as FetchableProvider, apiKey)}
                                                                disabled={modelsFetching || !apiKey}
                                                                title="Refresh model list from provider"
                                                                className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 disabled:text-slate-300 disabled:cursor-not-allowed transition"
                                                            >
                                                                {modelsFetching ? (
                                                                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" strokeOpacity=".25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                                                                ) : (
                                                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 4v5h5M20 20v-5h-5"/><path d="M4 9a9 9 0 0 1 15-3M20 15a9 9 0 0 1-15 3"/></svg>
                                                                )}
                                                                <span>{modelsFetching ? 'Fetching…' : 'Refresh'}</span>
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                                <ModelSelector
                                                    value={modelName}
                                                    onChange={setModelName}
                                                    liveModels={liveModels[aiProvider] || null}
                                                    fallbackModels={PROVIDER_MODELS[aiProvider] || []}
                                                    provider={aiProvider}
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="bg-white p-6 rounded border max-w-xl mt-4">
                                    <h2 className="text-lg font-semibold mb-4">Chatbot</h2>
                                    <div className="flex items-center gap-3">
                                        <input 
                                            type="checkbox" 
                                            id="enableChatbot" 
                                            checked={enableChatbot} 
                                            onChange={e => setEnableChatbot(e.target.checked)}
                                            className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                                        />
                                        <label htmlFor="enableChatbot" className="text-sm font-medium text-slate-700">Enable AI Chatbot Consultant</label>
                                    </div>
                                    <p className="text-xs text-slate-500 mt-1 ml-7">Shows a floating assistant button inside the editor.</p>
                                <div className="mt-4">
  <label className="block text-xs font-semibold text-slate-500 mb-1">
    Chatbot Response Style
  </label>

  <select
    value={chatbotStyle}
    onChange={(e) => setChatbotStyle(e.target.value as ChatbotResponseStyle)}
    className="w-full border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:border-brand-500"
  >
    <option value="normal">Normal</option>
    <option value="concise">Concise</option>
    <option value="one_sentence">One Sentence</option>
  </select>

  <p className="text-xs text-slate-500 mt-1">
    Normal keeps current behavior. Concise shortens responses. One sentence forces a single sentence output.
  </p>
</div>

                                </div>
                                <div className="bg-white p-6 rounded border max-w-xl mt-4">
                                    <h2 className="text-lg font-semibold mb-4">AI Source</h2>
                                    <div className="space-y-4">
                                        <div className="space-y-2 text-xs">
                                            <div className="flex items-center gap-2"><input type="radio" id="source-ai" checked={aiSourceMode === 'ai'} onChange={() => setAiSourceMode('ai')}/><label htmlFor="source-ai">AI only</label></div>
                                            <div className="flex items-center gap-2"><input type="radio" id="source-file" checked={aiSourceMode === 'file'} onChange={() => setAiSourceMode('file')}/><label htmlFor="source-file">File only (RAG)</label></div>
                                            <div className="flex items-center gap-2"><input type="radio" id="source-hybrid" checked={aiSourceMode === 'hybrid'} onChange={() => setAiSourceMode('hybrid')}/><label htmlFor="source-hybrid">Hybrid</label></div>
                                        </div>
                                        <div className="border-t pt-4 mt-2">
                                            <label className="block text-xs font-semibold text-slate-500 mb-2">Global Reference File</label>
                                            <label className="inline-flex items-center gap-2 px-3 py-2 border rounded bg-slate-50 cursor-pointer text-xs"><Icon name="upload" /><span>Upload</span><input type="file" accept=".txt,.md,.json,.csv,.xlsx,.xls,.doc,.docx,.pdf" className="hidden" onChange={async e => { const file = e.target.files && e.target.files[0]; if (!file) return; const text = await file.text(); setGlobalFileText(text); setGlobalFileName(file.name); }}/></label>
                                            {globalFileName && (
                                                <div className="mt-2 flex items-center gap-3 bg-slate-50 border rounded p-2">
                                                    <div className="text-[11px] text-slate-600 flex-1 truncate"><span className="font-bold">Loaded:</span> <span className="font-mono">{globalFileName}</span></div>
                                                    <button onClick={() => { setGlobalFileText(''); setGlobalFileName(''); }} className="text-[10px] bg-white border border-slate-300 px-2 py-1 rounded text-red-500 hover:bg-red-50 hover:border-red-200 font-bold transition">Clear</button>
                                                </div>
                                            )}
                                        </div>
                                        <div className="border-t pt-4 mt-2">
                                            <label className="block text-xs font-semibold text-slate-500 mb-2">Checklist Knowledge</label>
                                            <p className="text-[10px] text-slate-400 mb-2">PM checklists by team &amp; interval — used for mitigation in File/Hybrid mode</p>
                                            <label className="inline-flex items-center gap-2 px-3 py-2 border rounded bg-slate-50 cursor-pointer text-xs"><Icon name="upload" /><span>Upload</span><input type="file" accept=".txt,.md,.csv" className="hidden" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setChecklistText(await file.text()); setChecklistFileName(file.name); }}/></label>
                                            {checklistFileName && (
                                                <div className="mt-2 flex items-center gap-3 bg-slate-50 border rounded p-2">
                                                    <div className="text-[11px] text-slate-600 flex-1 truncate"><span className="font-bold">Loaded:</span> <span className="font-mono">{checklistFileName}</span></div>
                                                    <button onClick={() => { setChecklistText(''); setChecklistFileName(''); }} className="text-[10px] bg-white border border-slate-300 px-2 py-1 rounded text-red-500 hover:bg-red-50 hover:border-red-200 font-bold transition">Clear</button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            
                            </>
                        )}
                    </div>
                    <div className="text-center text-xs text-slate-400 mt-8">Developed by Mohamed Al Amri | Reliability Engineer</div>
                </div>
            )}
            {view === 'editor' && activeProject && (
                <div className="flex-1 flex overflow-hidden relative">
                    <div className="flex-1 bg-slate-100 overflow-y-auto scroll-thin p-8">
                        {tab === 'build' ? (
                            <div className="max-w-7xl mx-auto pb-40">
                                <div className="bg-white p-6 rounded shadow-sm mb-8">
                                    <div className="flex items-center gap-4 mb-2">
                                        <input className="text-2xl font-bold w-full outline-none flex-1" value={activeProject.name} onChange={e => updateHeader('name', e.target.value)} />
                                        {systemModes.length > 0 && systemContextEnabled && (
                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded whitespace-nowrap">
                                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block"></span>
                                                System Context Active
                                            </span>
                                        )}
                                        <button
                                            onClick={() => setShowSystemModes(true)}
                                            className={`px-3 py-2 rounded border font-bold text-xs inline-flex items-center gap-1 whitespace-nowrap transition ${systemModes.length > 0 ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                                            title="Configure System Modes context for AI"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
                                            System Modes
                                        </button>
                                        <button
                                            onClick={masterGen}
                                            className="bg-gradient-to-r from-brand-600 to-indigo-600 text-white px-4 py-2 rounded shadow font-bold text-xs inline-flex items-center whitespace-nowrap hover:shadow-lg transition"
                                        >
                                            {loadingMaster ? (
                                                "Generating..."
                                            ) : (
                                                <>
                                                    <Icon name="bolt" />
                                                    <span className="whitespace-nowrap ml-1">Auto-Generate</span>
                                                </>
                                            )}
                                        </button>
                                    </div>
                                    <SmartInput label="Context" value={activeProject.desc} onChange={v => updateHeader('desc', v)} isTextArea apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} />
                                </div>
                                {activeProject.subsystems.map((sub, i) => (
                                    <div key={sub.id} draggable={dragAllowed===i||dragId===i} onDragStart={(e)=>handleDragStart(e,i)} onDragEnd={handleDragEnd} onDragOver={(e)=>e.preventDefault()} onDragEnter={()=>handleDragEnter(i)} onDrop={(e)=>{ e.preventDefault(); setDragId(null); setDragAllowed(null); }} onClick={()=>setActiveSubId(sub.id)} className={`bg-white rounded border shadow-sm mb-8 overflow-hidden animate-enter transition-all cursor-pointer border-2 ${activeSubId===sub.id?'border-brand-500 ring-2 ring-brand-100':'border-slate-200'} ${dragId===i?'is-dragging opacity-50 border-dashed border-brand-500':''} ${dragId!==null&&dragId!==i?'':' '}`}>
                                        <div className="bg-slate-50 p-4 border-b flex justify-between items-start">
                                            <div className="flex-1 grid grid-cols-2 gap-4">
                                                <div className="flex gap-2 items-center">
                                                    <div className="text-slate-400 cursor-grab hover:text-brand-600 drag-handle p-1" title="Reorder" onMouseEnter={()=>setDragAllowed(i)} onMouseLeave={()=>{ if(dragId===null) setDragAllowed(null); }}><Icon name="move"/></div>
                                                    <button onClick={(e) => {e.stopPropagation(); toggleSub(sub.id)}} className="text-slate-400"><Icon name={sub.collapsed ? "chevronDown" : "chevronUp"} /></button>
                                                    <SmartInput label="Subsystem" value={sub.name} onChange={v => updateSub(sub.id, 'name', v)} apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name}} />
                                                </div>
                                                <SmartInput label="Specs" value={sub.specs} onChange={v => updateSub(sub.id, 'specs', v)} apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name}} />
                                                <div className="mt-2 space-y-1">
                                                    <div className="text-[10px] font-semibold uppercase text-slate-500">Subsystem image (AI)</div>
                                                    <div className="flex items-center gap-2 flex-nowrap">
                                                        <label title="Upload Image for Datasheet or Nameplate" className="inline-flex items-center gap-1 px-2 py-1 border rounded-full text-[11px] bg-white hover:bg-slate-50 cursor-pointer">
                                                            <span className="text-xs">📷</span>
                                                            <span></span>
                                                            <input 
                                                                type="file" 
                                                                accept="image/*" 
                                                                className="hidden" 
                                                                onChange={e => { 
                                                                    const file = e.target.files && e.target.files[0]; 
                                                                    if (file) handleSubImageUpload(sub.id, file); 
                                                                }}
                                                            />
                                                        </label>
                                                        <button 
                                                            title="Extract Specs"
                                                            type="button" 
                                                            onClick={e => { e.stopPropagation(); analyzeSubImage(sub.id); }} 
                                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-emerald-400 text-[11px] text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                                                        >
                                                            <span className="text-xs">⚡</span>
                                                        </button>
                                                        {sub.imageName && (<span className="text-[10px] text-slate-500 truncate max-w-[140px]">{sub.imageName}</span>)}
                                                    </div>
                                                    {sub.imageJson && (
                                                        <div className="mt-1 flex flex-col gap-1">
                                                            <button type="button" onClick={e => { e.stopPropagation(); toggleImageJson(sub.id); }} className="self-start text-[10px] px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50">{sub.showImageJson ? '︿' : '﹀'}</button>
                                                            {sub.showImageJson && (<pre className="border border-slate-200 rounded bg-slate-50 p-2 max-h-40 overflow-auto text-[10px] font-mono text-slate-700 whitespace-pre-wrap">{sub.imageJson}</pre>)}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="ml-2 flex flex-col gap-2 pt-1">
                                                <button onClick={(e) => {e.stopPropagation(); deleteSub(sub.id)}} className="text-red-500 hover:text-red-700 p-1"><Icon name="trash"/></button>
                                                <button onClick={(e) => {e.stopPropagation(); openAttachments('sub', sub)}} className="text-slate-400 hover:text-brand-600 p-1" title="Attachments / References"><Icon name="clip"/></button>
                                            </div>
                                        </div>
                                        {!sub.collapsed && (
                                            <div className="animate-enter">
                                                <div className="p-4 border-b bg-slate-50/30 flex items-end gap-4">
                                                    <div className="flex-1"><SmartInput label="Function" value={sub.func} onChange={v => updateSub(sub.id, 'func', v)} apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name, specs: sub.specs}} /></div>
                                                    {isSubExhausted(sub) && (
                                                        <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-200 text-slate-600 px-2 py-1 rounded self-center">Function fully covered ✓</span>
                                                    )}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); autoGen(sub.id, sub.name, sub.specs, sub.func); }}
                                                        disabled={isSubExhausted(sub) || genId === sub.id}
                                                        title={isSubExhausted(sub) ? "All functional standards in the description are already covered. Edit the Function Description or remove a Functional Failure to re-enable." : undefined}
                                                        className={`h-9 px-3 border rounded text-xs font-bold flex items-center gap-2 transition ${isSubExhausted(sub) ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed" : "bg-white text-brand-600 hover:bg-brand-50 border-brand-200"}`}
                                                    >
                                                        {genId===sub.id ? "..." : <span><Icon name="wand"/> Auto-Fill</span>}
                                                    </button>
                                                </div>
                                                <div className="overflow-x-auto">
                                                    <table className="w-full text-left text-sm border-collapse">
                                                        <thead className="bg-slate-50 text-slate-500 text-xs font-bold uppercase"><tr><th className="p-2 border-r w-1/5">Functional Failure</th><th className="p-2 border-r w-1/6">Mode</th><th className="p-2 border-r w-1/6">Effect</th><th className="p-2 border-r w-1/6">Cause</th><th className="p-2 border-r w-1/5">Mitigation</th>{showRPN && <th className="p-2 text-center">RPN</th>}<th className="p-2 text-center">Edit</th></tr></thead>
                                                        <tbody>
                                                            {sub.failures.map((fail) => (
                                                                <React.Fragment key={fail.id}>
                                                                    <tr>
                                                                        <td colSpan={showRPN?7:6} className="p-0 border-b border-slate-100 bg-slate-50/20">
                                                                            <div className="flex items-start p-2 gap-2 group">
                                                                                <button onClick={(e)=>{e.stopPropagation(); toggleFail(sub.id, fail.id)}} className="mt-1 text-slate-400"><Icon name={fail.collapsed?"chevronDown":"chevronUp"}/></button>
                                                                                <div className="flex-1">
                                                                                    <SmartInput label="Functional Failure" value={fail.desc} onChange={v => updateFail(sub.id, fail.id, v)} isTextArea placeholder="Functional Failure..." apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name, funcDescription: sub.func, existingFailures: sub.failures.filter(f => f.id !== fail.id && f.desc).map(f => f.desc)}} />
                                                                                    <div className="flex gap-4 mt-1">
                                                                                        <button onClick={(e)=>{e.stopPropagation(); genModes(sub.id, fail.id, sub.name, sub.specs, sub.func, fail.desc)}} disabled={modeGenId === fail.id} className="text-xs text-brand-600 font-bold flex gap-1 items-center hover:underline">{modeGenId === fail.id ? "..." : <span><Icon name="bolt"/> Generate Modes</span>}</button>
                                                                                        <button onClick={(e)=>{e.stopPropagation(); openAttachments('fail', sub, fail)}} className="text-xs text-slate-500 font-bold flex gap-1 items-center hover:text-brand-600"><Icon name="clip" className="w-3 h-3"/> References</button>
                                                                                    </div>
                                                                                </div>
                                                                                <button onClick={(e)=>{e.stopPropagation(); deleteFail(sub.id, fail.id)}} className="text-red-400 opacity-0 group-hover:opacity-100"><Icon name="trash"/></button>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                    {!fail.collapsed && fail.modes.map((mode, mIdx) => (
                                                                        <tr key={mode.id} className="group hover:bg-slate-50">
                                                                            <td className="p-2 border-r bg-slate-50/10 text-right text-xs text-slate-300">M{mIdx+1}</td>
                                                                            <td className="p-2 border-r"><SmartInput label="Failure Mode" value={mode.mode} onChange={v=>updateMode(sub.id, fail.id, mode.id, 'mode', v)} isTextArea apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name, failureDesc: fail.desc, existingModes: fail.modes.filter(m => m.id !== mode.id && m.mode).map(m => m.mode)}} /></td>
                                                                            <td className="p-2 border-r"><SmartInput label="Failure Effect" value={mode.effect} onChange={v=>updateMode(sub.id, fail.id, mode.id, 'effect', v)} isTextArea apiKey={apiKey} modelName={modelName} placeholder="Consequence..." aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name}} /></td>
                                                                            <td className="p-2 border-r"><SmartInput label="Failure Cause" value={mode.cause} onChange={v=>updateMode(sub.id, fail.id, mode.id, 'cause', v)} isTextArea apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name}} /></td>
                                                                            <td className="p-2 border-r"><MitigationBuilder value={mode.mitigation} onChange={v=>updateMode(sub.id, fail.id, mode.id, 'mitigation', v)} apiKey={apiKey} modelName={modelName} aiSourceMode={aiSourceMode} referenceFileText={globalFileText} aiProvider={aiProvider} azureEndpoint={azureEndpoint} systemContext={systemContext} powerAutomateUrl={powerAutomateUrl} contextData={{project: activeProject.name, subsystem: sub.name, checklistText: checklistText, detectionScore: Number(mode.rpn.d) || 5}} /></td>
                                                                            {showRPN && <td className="p-2 text-center"><div className="flex justify-center gap-0.5 mb-1"><input className="w-5 text-center border text-xs" value={mode.rpn.s} onChange={e=>updateMode(sub.id, fail.id, mode.id, 'rpn', {...mode.rpn, s:e.target.value})}/><input className="w-5 text-center border text-xs" value={mode.rpn.o} onChange={e=>updateMode(sub.id, fail.id, mode.id, 'rpn', {...mode.rpn, o:e.target.value})}/><input className="w-5 text-center border text-xs" value={mode.rpn.d} onChange={e=>updateMode(sub.id, fail.id, mode.id, 'rpn', {...mode.rpn, d:e.target.value})}/></div><div className={`text-xs font-bold rounded py-1 border ${getRpnColor((Number(mode.rpn.s)||1)*(Number(mode.rpn.o)||1)*(Number(mode.rpn.d)||1))}`}>{(Number(mode.rpn.s)||1)*(Number(mode.rpn.o)||1)*(Number(mode.rpn.d)||1)}</div></td>}
                                                                            <td className="p-2 text-center opacity-0 group-hover:opacity-100"><div className="flex flex-col items-center gap-1"><button onClick={(e)=>{e.stopPropagation();deleteMode(sub.id,fail.id,mode.id)}} className="text-red-500 mb-2"><Icon name="trash"/></button><button onClick={(e)=>{e.stopPropagation();aiScoreModeRpn(sub.id,fail.id,mode.id)}} className={`text-blue-500 text-sm ${rpnLoadingId===String(mode.id) ? "animate-pulse scale-110 drop-shadow-[0_0_6px_rgba(59,130,246,0.6)]" : ""}`} title="AI score S/O/D">🤖</button></div></td>
                                                                        </tr>
                                                                    ))}
                                                                    {!fail.collapsed && (<tr><td colSpan={showRPN?7:6} className="p-1 text-center border-b-4 border-slate-100"><button onClick={(e)=>{e.stopPropagation(); addMode(sub.id, fail.id)}} className="text-xs font-bold text-brand-600">+ Add Mode</button></td></tr>)}
                                                                </React.Fragment>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                    <div className="border-t flex items-center justify-center gap-2">
                                                        <button onClick={(e)=>{e.stopPropagation(); addFail(sub.id)}} className="flex-1 py-2 text-xs font-bold text-slate-400 hover:text-brand-600">+ Add Failure</button>
                                                        {isSubExhausted(sub) && (
                                                            <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-200 text-slate-600 px-2 py-1 rounded mr-2">Function fully covered ✓</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                <button onClick={addSub} className="w-full py-4 border-2 border-dashed border-slate-300 rounded font-bold text-slate-400 hover:border-brand-500 hover:text-brand-500">Add Subsystem</button>
                            </div>
                        ) : tab === 'viewTable' ? (
                            <div className="max-w-full mx-auto p-8 overflow-auto">
                                <div className="bg-white rounded shadow border border-slate-200">
                                    <table className="w-full text-left border-collapse merged-table">
                                        <thead>
                                            <tr><th>Subsystem</th><th>Specs</th><th>Function</th><th>Functional Failure</th><th>Failure Mode</th><th>Failure Effect</th><th>Failure Cause</th><th>Mitigation</th><th className="text-center">S</th><th className="text-center">O</th><th className="text-center">D</th><th className="text-center">RPN</th></tr>
                                        </thead>
                                        <tbody>
                                            {activeProject.subsystems.map((sub) => {
                                                const subRowSpan = getSubRowSpan(sub);
                                                if (sub.failures.length === 0) {
                                                    return (<tr key={sub.id}><td rowSpan={1} className="font-bold">{sub.name}</td><td rowSpan={1}>{sub.specs}</td><td rowSpan={1}>{sub.func}</td><td colSpan={9} className="text-center text-slate-400 italic">No Failures Defined</td></tr>);
                                                }
                                                return sub.failures.map((fail, fIndex) => {
                                                    const failRowSpan = getFailRowSpan(fail);
                                                    if (fail.modes.length === 0) {
                                                        return (
                                                            <tr key={fail.id}>
                                                                {fIndex === 0 && (<React.Fragment><td rowSpan={subRowSpan} className="font-bold">{sub.name}</td><td rowSpan={subRowSpan}>{sub.specs}</td><td rowSpan={subRowSpan}>{sub.func}</td></React.Fragment>)}
                                                                <td rowSpan={1} className="font-medium text-slate-700">{fail.desc}</td><td colSpan={8} className="text-center text-slate-400 italic">No Modes Defined</td>
                                                            </tr>
                                                        );
                                                    }
                                                    return fail.modes.map((mode, mIndex) => {
                                                        const rpn = (Number(mode.rpn.s) || 1) * (Number(mode.rpn.o) || 1) * (Number(mode.rpn.d) || 1);
                                                        return (
                                                            <tr key={mode.id}>
                                                                {fIndex === 0 && mIndex === 0 && (<React.Fragment><td rowSpan={subRowSpan} className="font-bold">{sub.name}</td><td rowSpan={subRowSpan}>{sub.specs}</td><td rowSpan={subRowSpan}>{sub.func}</td></React.Fragment>)}
                                                                {mIndex === 0 && (<td rowSpan={failRowSpan} className="font-medium text-slate-700">{fail.desc}</td>)}
                                                                <td>{mode.mode}</td><td>{mode.effect}</td><td>{mode.cause}</td><td className="whitespace-pre-wrap">{mode.mitigation}</td><td className="text-center">{mode.rpn.s}</td><td className="text-center">{mode.rpn.o}</td><td className="text-center">{mode.rpn.d}</td><td className="text-center font-bold">{rpn}</td>
                                                            </tr>
                                                        );
                                                    });
                                                });
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ) : (
                            <div className="tree-viewport">
  <div className="fixed top-20 right-10 z-20 map-export-hide">
    <div className="relative flex items-center gap-2">

      {/* Expand all */}
      <button
        onClick={expandAllTree}
        className="bg-white border px-2 py-2 rounded shadow text-[11px] font-bold hover:bg-brand-50"
        title="Expand all"
      >
        Expand
      </button>

      {/* Collapse all */}
      <button
        onClick={collapseAllTree}
        className="bg-white border px-2 py-2 rounded shadow text-[11px] font-bold hover:bg-brand-50"
        title="Collapse all"
      >
        Collapse
      </button>

      {/* Download */}
      <div className="relative">
        <button
          onClick={() => setShowDownloadOptions(!showDownloadOptions)}
          className="bg-white border px-4 py-2 rounded font-bold shadow text-xs flex items-center gap-2 hover:bg-brand-50"
        >
          <Icon name="image" /> Download
        </button>

        {showDownloadOptions && (
          <div className="absolute top-10 right-0 bg-white border rounded shadow-xl flex flex-col w-52 z-30">
            <button
              onClick={downloadPDF}
              className="text-left px-4 py-2 hover:bg-slate-50 text-xs font-medium flex items-center gap-2"
            >
              <span>📄</span> PDF
            </button>
            <button
              onClick={downloadInteractiveMap}
              className="text-left px-4 py-2 hover:bg-slate-50 text-xs font-medium border-t flex items-center gap-2"
            >
              <span>🗺️</span> Interactive Map
            </button>
            <button
              onClick={() => downloadMap(2)}
              className="text-left px-4 py-2 hover:bg-slate-50 text-xs font-medium border-t flex items-center gap-2"
            >
              <span>🖼️</span> Standard Quality IMG
            </button>
            <button
              onClick={() => downloadMap(4)}
              className="text-left px-4 py-2 hover:bg-slate-50 text-xs font-medium border-t flex items-center gap-2"
            >
              <span>🖼️</span> High Resolution IMG
            </button>
          </div>
        )}
      </div>

    </div>
  </div>
                                <HybridMapView
                                    project={activeProject}
                                    treeExpanded={treeExpanded}
                                    treeSelected={treeSelected}
                                    onToggle={toggleTree}
                                    onSelect={selectTree}
                                />

                            </div>
                        )}
                    </div>
                    {showLib && (
                        <div className="w-80 border-l border-slate-200 bg-white h-full overflow-y-auto shadow-xl p-4 absolute right-0 top-0 bottom-0 animate-enter z-30">
                            <div className="flex justify-between items-center mb-6"><h3 className="font-bold text-brand-600 flex items-center gap-2"><Icon name="book"/> Library</h3><div className="flex gap-2"><button onClick={downloadTemplate} className="text-[10px] text-blue-600 underline">Get Template</button><label className="text-xs font-bold text-slate-400 cursor-pointer hover:text-slate-600"><Icon name="upload"/> <input type="file" accept=".json" className="hidden" onChange={importLibrary}/></label><button onClick={()=>setShowLib(false)} className="text-slate-400 hover:text-slate-600">×</button></div></div>
                            {Object.entries(library).map(([k, v]) => (<div key={k} className="mb-6"><h4 className="text-xs font-bold uppercase text-slate-400 border-b pb-1 mb-2">{k}</h4>{(v as any[]).map((item, i) => (<div key={i} onClick={()=>injectLib(item)} className="p-3 border rounded-lg mb-2 text-xs hover:bg-brand-50 cursor-pointer shadow-sm bg-white"><div className="font-bold text-brand-700 mb-1">{item.fail}</div><div><b>Mode:</b> {item.mode}</div><div><b>Effect:</b> {item.effect}</div><div><b>Cause:</b> {item.cause}</div><div className="mt-1 text-slate-400">Task: {item.task}</div></div>))}</div>))}
                        </div>
                    )}
                    <AttachmentModal
                        isOpen={attachModal.open}
                        onClose={()=>setAttachModal({...attachModal, open: false})}
                        entityType={attachModal.type}
                        entityName={attachModal.type==='sub' ? (attachModal.entity && attachModal.entity.name) : (attachModal.entity && attachModal.entity.desc)}
                        provider={storageProvider}
                        projectId={activeProject && activeProject.id}
                        pathParts={getAttachmentPath()}
                    />
                </div>
            )}
            {showSystemModes && (
                <SystemModesModal
                    systemType={systemType}
                    systemModes={systemModes}
                    systemContextEnabled={systemContextEnabled}
                    onInsert={(type, modes) => { setSystemType(type); setSystemModes(modes); setSystemContextEnabled(true); }}
                    onClear={() => { setSystemType(''); setSystemModes([]); setSystemContextEnabled(true); }}
                    onToggle={() => setSystemContextEnabled(e => !e)}
                    onClose={() => setShowSystemModes(false)}
                />
            )}
        </div>
    );
};

export default App;