import React, { useState, useEffect } from 'react';
import { LocalFileSystemProvider, sanitizeName, isCancellation } from '../services/FileSystem';
import { FileEntry } from '../types';

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

    // In the portal iframe the browser forbids disk access, so attachments live in
    // this browser's storage instead. The standalone tab keeps using real folders.
    const diskMode = provider ? provider.diskMode : true;

    const loadFiles = async () => {
        if(!provider || !projectId) return;
        setLoading(true); setMsg("");
        try {
            setHasRoot(await provider.hasRoot(projectId));
            setFiles(await provider.listFiles(projectId, pathParts));
        } catch(e: any) {
            setMsg(e?.message || "Could not read the attachments.");
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
        if(isOpen) { setMode('view'); setCustomFolder(""); }
    }, [isOpen, pathParts.join("|")]);

    // Opens the OS folder picker. Called straight from the click so the browser
    // still sees the user gesture the File System Access API requires.
    const handlePickRoot = async () => {
        if(!provider || !projectId) return;
        setMsg("");
        try {
            await provider.chooseRoot(projectId);
            setHasRoot(true);
            loadFiles();
        } catch(e: any) {
            if(isCancellation(e)) return;
            setMsg(e?.message || "Could not open the folder picker.");
        }
    };

    const handleCreateFolder = async () => {
        if(!provider || !projectId) return;
        const finalParts = pathParts.length ? [...pathParts] : ['Attachments'];
        if(customFolder.trim()) finalParts[finalParts.length-1] = customFolder;
        setMsg("");
        try {
            await provider.ensureFolderForEntity(projectId, finalParts);
            setMsg("Folder ready.");
            setHasRoot(true);
            setMode('view');
            loadFiles();
        } catch(e: any) {
            if(isCancellation(e)) return;
            setMsg("Error creating folder: " + (e?.message || e));
        }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        if(!provider || !projectId || !input.files?.length) return;
        setLoading(true); setMsg("");
        try {
            await provider.uploadFiles(projectId, pathParts, input.files);
            setMsg(`Saved ${input.files.length} file${input.files.length > 1 ? 's' : ''}.`);
            await loadFiles();
        } catch(err: any) {
            if(!isCancellation(err)) setMsg("Upload failed: " + (err?.message || err));
            setLoading(false);
        }
        input.value = '';
    };

    const handleDelete = async (name: string) => {
        if(!provider || !projectId) return;
        setMsg("");
        try {
            await provider.deleteFile(projectId, pathParts, name);
            await loadFiles();
        } catch(err: any) {
            setMsg("Could not delete " + name + ": " + (err?.message || err));
        }
    };

    const DL_EXT = new Set(["doc","docx","dot","dotx","xls","xlsx","xlsm","xltx","ppt","pptx","pptm","pps","ppsx","odt","ods","odp","rtf","zip","rar","7z","tar","gz","bz2","xz","iso","img","exe","msi","dll","bat","cmd","ps1","apk","dmg","pkg"]);
    const dlName = (s: string) => String(s || "file").replace(/[\\/:*?"<>|]+/g, "_");

    const openFile = async (f: FileEntry) => {
        if(!provider) return;
        let blob: Blob;
        try { blob = await provider.readFile(f); }
        catch(err: any) { setMsg(err?.message || "Could not open that file."); return; }

        const n = f.name || "file";
        const ext = (n.toLowerCase().split(".").pop() || "");
        const url = URL.createObjectURL(blob);
        if(ext && DL_EXT.has(ext)) {
            const a = document.createElement("a");
            a.href = url; a.download = dlName(n);
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            return;
        }
        const w = window.open("", "_blank");
        if(!w) { window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 60000); return; }
        w.document.title = n;
        w.document.body.style.margin = "0";
        w.document.body.innerHTML = `<iframe src="${url}" style="border:0;width:100vw;height:100vh"></iframe>`;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    };

    if(!isOpen) return null;

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal-content" onClick={e=>e.stopPropagation()}>
                <div className="flex justify-between items-center mb-4 border-b pb-2">
                    <h3 className="font-bold text-lg">References: {entityName}</h3>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600">×</button>
                </div>

                <div className="flex gap-2 mb-4">
                    <button onClick={()=>setMode('view')} className={`px-3 py-1 rounded text-sm font-bold ${mode==='view'?'bg-brand-600 text-white':'bg-slate-100'}`}>View</button>
                    {diskMode && (
                        <button onClick={()=>setMode('create')} className={`px-3 py-1 rounded text-sm font-bold ${mode==='create'?'bg-brand-600 text-white':'bg-slate-100'}`}>Create Folder</button>
                    )}
                    <label className="px-3 py-1 rounded text-sm font-bold bg-slate-100 cursor-pointer hover:bg-brand-50">Upload <input type="file" multiple className="hidden" onChange={handleUpload}/></label>
                </div>

                {msg && <div className="mb-4 text-xs p-2 bg-yellow-50 text-yellow-700 rounded border border-yellow-200">{msg}</div>}

                {!diskMode && (
                    <div className="p-3 bg-slate-50 rounded border mb-4">
                        <div className="text-xs text-slate-500 mb-2">
                            Files attach to this project inside your browser. Writing to a folder on your
                            computer needs FMECA Studio in its own tab — browsers block folder access for
                            embedded pages.
                        </div>
                        <button
                            onClick={()=>window.open(window.location.href, '_blank', 'noopener')}
                            className="bg-white border text-slate-600 px-3 py-1.5 rounded text-xs font-bold hover:bg-slate-50">
                            Open in a new tab
                        </button>
                    </div>
                )}

                {diskMode && hasRoot === false && (
                    <div className="p-4 bg-slate-50 rounded border mb-4">
                        <div className="text-xs text-slate-500 mb-2">
                            No project folder is linked yet. Pick the folder on your computer where this project's files should live.
                        </div>
                        <button onClick={handlePickRoot} className="bg-slate-900 text-white px-4 py-2 rounded text-sm font-bold">
                            Select Project Folder
                        </button>
                    </div>
                )}

                {diskMode && mode === 'create' && (
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
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button onClick={()=>openFile(f)} className="text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded font-bold hover:bg-brand-100">Open</button>
                                        <button onClick={()=>handleDelete(f.name)} title="Remove" className="text-slate-300 hover:text-red-500 transition p-1 opacity-0 group-hover:opacity-100">✕</button>
                                    </div>
                                </div>
                            ))
                        }
                    </div>
                )}
                <div className="mt-4 pt-2 border-t text-[10px] text-slate-400">
                    {diskMode ? 'Path: [Project Root] / ' : 'Stored in this browser: '}{pathParts.join(' / ')}
                </div>
            </div>
        </div>
    );
};
