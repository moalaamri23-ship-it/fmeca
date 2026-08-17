import React, { useState, useEffect, useRef } from 'react';
import { LocalFileSystemProvider, WriteSession, sanitizeName, isCancellation, describePickerFailure } from '../services/FileSystem';
import { FileEntry } from '../types';

// Which side picks the files when embedded. Starts on the frame's own picker —
// one click to the file dialog — and drops to the helper window's picker only
// for a browser that will not serve a single click to both.
const FLOW_KEY = 'fmeca_upload_flow_v1';

interface AttachmentModalProps {
    isOpen: boolean;
    onClose: () => void;
    entityType: string | null;
    entityName: string | null;
    provider: LocalFileSystemProvider | null;
    pathParts: string[];
    projectId: string | null;
}

export const AttachmentModal: React.FC<AttachmentModalProps> = ({ isOpen, onClose, entityName, provider, pathParts, projectId }) => {
    // Every hook must run on every render — bail out below the hook list, never above it.
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<'view' | 'create'>('view');
    const [customFolder, setCustomFolder] = useState("");
    const [msg, setMsg] = useState("");
    const [hasRoot, setHasRoot] = useState<boolean | null>(null);
    const [rootName, setRootName] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [pickInFrame, setPickInFrame] = useState<boolean>(() => {
        try { return localStorage.getItem(FLOW_KEY) !== 'helper'; } catch { return true; }
    });
    const inputRef = useRef<HTMLInputElement>(null);
    // One helper window for the whole panel. Held open so that later clicks can
    // spend their user activation on the file picker rather than on a window.
    const sessionRef = useRef<WriteSession | null>(null);

    const loadFiles = async () => {
        if(!provider || !projectId) return;
        setLoading(true); setMsg("");
        try {
            // Also warms the in-memory root, so the next click can open the write
            // window without awaiting IndexedDB and losing its user activation.
            setHasRoot(await provider.hasRoot(projectId));
            setRootName(await provider.rootName(projectId));
            setFiles(await provider.listFiles(projectId, pathParts));
        } catch(e: any) {
            setMsg(e?.message || "Folder not found or access denied.");
            setFiles([]);
        }
        setLoading(false);
    };

    useEffect(() => {
        if(isOpen && provider && projectId) loadFiles();
        // eslint-disable-next-line
    }, [isOpen, provider, projectId, pathParts.join("|")]);

    // Reset transient UI whenever the modal is reopened on a different entity.
    useEffect(() => {
        if(isOpen) { setMode('view'); setCustomFolder(""); setConfirmDelete(null); }
    }, [isOpen, pathParts.join("|")]);

    // Linking a folder retires the Create Folder tab, so don't strand its panel.
    useEffect(() => {
        if(hasRoot && mode === 'create') setMode('view');
    }, [hasRoot, mode]);

    const closeSession = () => {
        sessionRef.current?.done();
        sessionRef.current = null;
    };

    // The helper window belongs to this panel and to this project only.
    useEffect(() => {
        if(!isOpen) closeSession();
        return closeSession;
    }, [isOpen, projectId]);

    /**
     * Open the helper window with the panel, for browsers that cannot spare a
     * click for both it and the file picker.
     *
     * The click that opened References is still the current gesture here, so the
     * window costs nothing that Upload will need. Only for a project whose folder
     * is already in hand — nothing should pop up for a project that has none.
     */
    useEffect(() => {
        if(!isOpen || pickInFrame || !provider?.embedded || !projectId) return;
        if(sessionRef.current || !provider.hasLiveRoot(projectId)) return;
        try { ensureSession(); } catch { /* Upload will report it, and can retry */ }
        // eslint-disable-next-line
    }, [isOpen, pickInFrame, provider, projectId]);

    /**
     * The open write channel, opening one if this is the first write.
     *
     * MUST be called straight from a click: opening the helper window is itself
     * gesture-gated. Throws when the window is blocked.
     */
    const ensureSession = (): WriteSession | null => {
        if(sessionRef.current) return sessionRef.current;
        if(!provider || !projectId) return null;
        const session = provider.beginWrite(projectId);
        sessionRef.current = session;
        const where = [rootName || 'the project folder', ...pathParts].join(' / ');
        void provider.describeWrite(session, 'Saving to ' + where + '. This window stays open while References is.');
        return session;
    };

    /**
     * Open the file dialog here in the app. Returns false when the browser has no
     * user activation left to open it with — which is what happens on the click
     * that also had to open the helper window.
     */
    const openPicker = (): boolean => {
        const input = inputRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
        if(!input) return false;
        // showPicker reports the refusal; the legacy click only fails silently.
        if(typeof input.showPicker === 'function') {
            try { input.showPicker(); return true; } catch { return false; }
        }
        input.click();
        return true;
    };

    const rememberHelperPick = () => {
        setPickInFrame(false);
        try { localStorage.setItem(FLOW_KEY, 'helper'); } catch { /* preference only */ }
    };

    const handlePickRoot = async () => {
        if(!provider || !projectId) return;
        setMsg("");
        // A new root leaves the open helper holding the old one.
        closeSession();
        try {
            await provider.chooseRoot(projectId);
            await loadFiles();
        } catch(e: any) {
            if(isCancellation(e)) return;
            setMsg(describePickerFailure(e));
        }
    };

    const handleCreateFolder = async () => {
        if(!provider || !projectId) return;
        const finalParts = pathParts.length ? [...pathParts] : ['Attachments'];
        if(customFolder.trim()) finalParts[finalParts.length-1] = customFolder.trim();
        setMsg("");
        try {
            const session = ensureSession();
            await provider.ensureFolderForEntity(projectId, finalParts, session ?? undefined);
            setMsg("Folder ready.");
            setMode('view');
            await loadFiles();
        } catch(e: any) {
            if(isCancellation(e)) return;
            setMsg("Could not create the folder: " + (e?.message || e));
        }
    };

    /**
     * One click from Upload to the file dialog.
     *
     * The helper window opens first, because writing is only allowed there. The
     * picker then runs here, so the files are chosen in the app and the window is
     * left doing what it is good for: showing where they are going. Should the
     * browser spend the click's activation on the window and leave none for the
     * picker, the helper picks instead — one extra click, remembered so the next
     * upload starts that way.
     */
    const handleUploadClick = () => {
        if(!provider || !projectId) return;
        setMsg("");
        if(!provider.embedded) { openPicker(); return; }
        const reused = !!sessionRef.current;
        let session: WriteSession | null;
        try { session = ensureSession(); }
        catch(e: any) { setMsg(describePickerFailure(e)); return; }
        if(!session) return;
        // An already-open window costs this click nothing, so the picker can run
        // here whatever the remembered preference is.
        if((pickInFrame || reused) && openPicker()) return;
        if(!reused) rememberHelperPick();
        void runHelperPick(session);
    };

    const runHelperPick = async (session: WriteSession) => {
        if(!provider || !projectId) return;
        try {
            const written = await provider.uploadViaHelper(projectId, pathParts, session);
            setMsg(`Saved ${written} file${written > 1 ? 's' : ''}.`);
            await loadFiles();
        } catch(err: any) {
            if(!isCancellation(err)) setMsg("Upload failed: " + (err?.message || err));
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        const picked = Array.from(input.files || []);
        input.value = '';
        if(!provider || !projectId || !picked.length) return;
        setMsg(`Saving ${picked.length} file${picked.length > 1 ? 's' : ''}...`);
        try {
            const written = await provider.writeChosenFiles(projectId, pathParts, picked, sessionRef.current ?? undefined);
            setMsg(`Saved ${written} file${written > 1 ? 's' : ''}.`);
            await loadFiles();
        } catch(err: any) {
            if(!isCancellation(err)) setMsg("Upload failed: " + (err?.message || err));
        }
    };

    const handleDelete = async (name: string) => {
        if(!provider || !projectId) return;
        setConfirmDelete(null); setMsg("");
        try {
            const session = ensureSession();
            await provider.deleteFile(projectId, pathParts, name, session ?? undefined);
            setMsg(`Deleted ${name}.`);
            await loadFiles();
        } catch(err: any) {
            if(!isCancellation(err)) setMsg("Could not delete " + name + ": " + (err?.message || err));
        }
    };

    if(!isOpen) return null;

    const DL_EXT=new Set(["doc","docx","dot","dotx","xls","xlsx","xlsm","xltx","ppt","pptx","pptm","pps","ppsx","odt","ods","odp","rtf","zip","rar","7z","tar","gz","bz2","xz","iso","img","exe","msi","dll","bat","cmd","ps1","apk","dmg","pkg"]);
    const dlName=(s:string)=>String(s||"file").replace(/[\\/:*?"<>|]+/g,"_");
    const openFile=async(f:FileEntry)=>{
        if(!provider) return;
        let file: Blob;
        try { file = await provider.readFile(f); }
        catch(err: any){ setMsg(err?.message || "Could not open that file."); return; }
        const n=f.name||"file"; const ext=(n.toLowerCase().split(".").pop()||""); const url=URL.createObjectURL(file);
        if(ext&&DL_EXT.has(ext)){ const a=document.createElement("a"); a.href=url; a.download=dlName(n); document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),3000); return; }
        const w=window.open("","_blank"); if(!w){ window.open(url,"_blank"); setTimeout(()=>URL.revokeObjectURL(url),60000); return; }
        w.document.title=n; w.document.body.style.margin="0"; w.document.body.innerHTML=`<iframe src="${url}" style="border:0;width:100vw;height:100vh"></iframe>`; setTimeout(()=>URL.revokeObjectURL(url),60000);
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-content" onClick={e=>e.stopPropagation()}>
                <div className="flex justify-between items-center mb-4 border-b pb-2">
                    <h3 className="font-bold text-lg">References: {entityName}</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">×</button>
                </div>

                <div className="flex gap-2 mb-4">
                        <button onClick={()=>setMode('view')} className={`px-3 py-1 rounded text-sm font-bold ${mode==='view'?'bg-brand-600 text-white':'bg-slate-100'}`}>View</button>
                        {/* Uploading creates the folder chain on its own, so once a folder is
                            linked this only duplicates what Change Folder is for. */}
                        {!hasRoot && (
                            <button onClick={()=>setMode('create')} className={`px-3 py-1 rounded text-sm font-bold ${mode==='create'?'bg-brand-600 text-white':'bg-slate-100'}`}>Create Folder</button>
                        )}
                        <button onClick={handleUploadClick} disabled={hasRoot === false}
                            title={hasRoot === false ? 'Link a project folder first' : 'Add files to this folder'}
                            className="px-3 py-1 rounded text-sm font-bold bg-slate-100 hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed">Upload</button>
                        {/* Kept in the layout rather than display:none, so the browser
                            never has reason to refuse to open its dialog. */}
                        <input ref={inputRef} type="file" multiple onChange={handleUpload}
                            className="w-0 h-0 opacity-0 overflow-hidden" tabIndex={-1} aria-hidden="true"/>
                        {hasRoot && (
                            <button onClick={handlePickRoot} title="Choose a different project folder"
                                className="px-3 py-1 rounded text-sm font-bold bg-slate-100 hover:bg-brand-50 ml-auto">Change Folder</button>
                        )}
                </div>

                {msg && <div className="mb-4 text-xs p-2 bg-yellow-50 text-yellow-700 rounded border border-yellow-200">{msg}</div>}

                {hasRoot === false && (
                    <div className="p-4 bg-slate-50 rounded border mb-4">
                        <div className="text-xs text-slate-500 mb-2">
                            No project folder is linked yet. Choose where this project's files should live on your computer.
                        </div>
                        <button onClick={handlePickRoot} className="bg-slate-900 text-white px-4 py-2 rounded font-bold text-sm">
                            Select Project Folder
                        </button>
                    </div>
                )}

                {mode === 'create' && !hasRoot && (
                    <div className="p-4 bg-slate-50 rounded border mb-4">
                        <label className="block text-xs font-bold text-slate-500 mb-1">Folder Name (Default: {sanitizeName(pathParts[pathParts.length-1])})</label>
                        <input className="w-full border p-2 rounded text-sm mb-2" placeholder="Custom folder name..." value={customFolder} onChange={e=>setCustomFolder(e.target.value)}/>
                        <button onClick={handleCreateFolder} className="bg-brand-600 text-white px-4 py-2 rounded text-sm font-bold">Create / Ensure Exists</button>
                    </div>
                )}

                {loading ? <div className="p-4 text-center text-slate-400">Loading...</div> : (
                    <div className="space-y-2">
                        {files.length === 0 ? <div className="text-sm text-slate-400 italic">No files found.</div> :
                            files.map((f, i) => (
                                <div key={i} className="flex justify-between items-center p-2 border rounded hover:bg-slate-50 group">
                                    <span className="text-sm truncate font-medium">{f.name}</span>
                                    {confirmDelete === f.name ? (
                                        <div className="flex items-center gap-2 shrink-0">
                                            <span className="text-xs text-slate-500">Delete?</span>
                                            <button onClick={()=>handleDelete(f.name)} className="text-xs bg-red-600 text-white px-2 py-1 rounded font-bold">Yes</button>
                                            <button onClick={()=>setConfirmDelete(null)} className="text-xs border px-2 py-1 rounded font-bold">No</button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2 shrink-0">
                                            <button onClick={()=>openFile(f)} className="text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded font-bold hover:bg-brand-100">Open</button>
                                            <button onClick={()=>setConfirmDelete(f.name)} title="Delete file"
                                                className="text-slate-300 hover:text-red-500 transition p-1 opacity-0 group-hover:opacity-100">✕</button>
                                        </div>
                                    )}
                                </div>
                            ))
                        }
                    </div>
                )}
                <div className="mt-4 pt-2 border-t text-[10px] text-slate-400">
                        Path: {rootName ? rootName : '[Project Root]'} / {pathParts.join(' / ')}
                </div>
            </div>
        </div>
    );
};
