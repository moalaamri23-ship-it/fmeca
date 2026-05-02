import React, { useState, useEffect } from 'react';
import { LocalFileSystemProvider, sanitizeName } from '../services/FileSystem';
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
    if(!isOpen) return null;
    const [files, setFiles] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [mode, setMode] = useState<'view' | 'upload' | 'create'>('view');
    const [customFolder, setCustomFolder] = useState("");
    const [msg, setMsg] = useState("");

    const loadFiles = async () => {
        if(!provider || !projectId) return;
        setLoading(true); setMsg("");
        try {
            const list = await provider.listFiles(projectId, pathParts);
            setFiles(list);
        } catch(e: any) {
            setMsg(e.message || "Folder not found or access denied.");
            setFiles([]);
        }
        setLoading(false);
    };

    useEffect(() => {
        if(isOpen && provider && projectId) loadFiles();
        // eslint-disable-next-line
    }, [isOpen, provider, projectId, pathParts.join("|")]);

    const handleCreateFolder = async () => {
        if(!provider || !projectId) return;
        try {
            const finalParts = [...pathParts];
            if(customFolder) finalParts[finalParts.length-1] = customFolder;
            await provider.ensureFolderForEntity(projectId, finalParts);
            setMsg("Folder ready.");
            setMode('view');
            loadFiles();
        } catch(e: any) { setMsg("Error creating folder: " + e.message); }
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if(!provider || !projectId) return;
        if(!e.target.files?.length) return;
        setLoading(true);
        try {
            await provider.uploadFiles(projectId, pathParts, e.target.files);
            setMsg("Upload successful.");
            loadFiles();
        } catch(e: any) { setMsg("Upload failed: "+e.message); }
        setLoading(false);
    };

    const DL_EXT=new Set(["doc","docx","dot","dotx","xls","xlsx","xlsm","xltx","ppt","pptx","pptm","pps","ppsx","odt","ods","odp","rtf","zip","rar","7z","tar","gz","bz2","xz","iso","img","exe","msi","dll","bat","cmd","ps1","apk","dmg","pkg"]);
    const dlName=(s:string)=>String(s||"file").replace(/[\\/:*?"<>|]+/g,"_");
    const openFile=async(f:FileEntry)=>{ if(!f.handle) return alert("No file handle."); const file=await f.handle.getFile(); const n=(file.name||f.name||"file"); const ext=(n.toLowerCase().split(".").pop()||""); const url=URL.createObjectURL(file);
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
                        <button onClick={()=>setMode('create')} className={`px-3 py-1 rounded text-sm font-bold ${mode==='create'?'bg-brand-600 text-white':'bg-slate-100'}`}>Create Folder</button>
                        <label className="px-3 py-1 rounded text-sm font-bold bg-slate-100 cursor-pointer hover:bg-brand-50">Upload <input type="file" multiple className="hidden" onChange={handleUpload}/></label>
                </div>

                {msg && <div className="mb-4 text-xs p-2 bg-yellow-50 text-yellow-700 rounded border border-yellow-200">{msg}</div>}

                {mode === 'create' && (
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
                                <div key={i} className="flex justify-between items-center p-2 border rounded hover:bg-slate-50">
                                    <span className="text-sm truncate font-medium">{f.name}</span>
                                    <button onClick={()=>openFile(f)} className="text-xs bg-brand-50 text-brand-700 px-2 py-1 rounded font-bold hover:bg-brand-100">Open</button>
                                </div>
                            ))
                        }
                    </div>
                )}
                <div className="mt-4 pt-2 border-t text-[10px] text-slate-400">
                        Path: [Project Root] / {pathParts.join(' / ')}
                </div>
            </div>
        </div>
    );
};
