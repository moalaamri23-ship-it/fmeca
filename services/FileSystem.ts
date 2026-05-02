import { FileEntry } from '../types';

declare global {
    interface FileSystemHandlePermissionDescriptor {
        mode?: 'read' | 'readwrite';
    }

    interface FileSystemHandle {
        queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
        requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    }
}

const IDB_NAME = 'FmecaPro_FS';
const STORE_NAME = 'project_handles';
const BLOB_STORE = 'blob_files';

export const isInIframe = (): boolean => {
    try { return window.self !== window.top; } catch { return true; }
};

const initDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = (e: any) => {
        const db: IDBDatabase = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = (e: any) => resolve(e.target.result);
    req.onerror = reject;
});

const saveProjectHandle = async (projectId: string, handle: FileSystemDirectoryHandle): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = reject;
    });
};

const getProjectHandle = async (projectId: string): Promise<FileSystemDirectoryHandle | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = reject;
    });
};

interface BlobRecord { name: string; mimeType: string; data: ArrayBuffer; }

const saveBlobFile = async (projectId: string, pathKey: string, filename: string, record: BlobRecord): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).put(record, `${projectId}||${pathKey}||${filename}`);
        tx.oncomplete = () => resolve();
        tx.onerror = reject;
    });
};

const listBlobFiles = async (projectId: string, pathKey: string): Promise<FileEntry[]> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BLOB_STORE, 'readonly');
        const store = tx.objectStore(BLOB_STORE);
        const req = store.getAllKeys();
        req.onsuccess = () => {
            const prefix = `${projectId}||${pathKey}||`;
            const keys = (req.result as string[]).filter(k => k.startsWith(prefix));
            if (!keys.length) { resolve([]); return; }
            const entries: FileEntry[] = [];
            let remaining = keys.length;
            keys.forEach(key => {
                const gr = store.get(key);
                gr.onsuccess = () => {
                    const r: BlobRecord = gr.result;
                    entries.push({ name: r.name, data: r.data, mimeType: r.mimeType });
                    if (--remaining === 0) resolve(entries);
                };
                gr.onerror = reject;
            });
        };
        req.onerror = reject;
    });
};

export const sanitizeName = (n: string | undefined): string => (n||'Untitled').replace(/[^a-z0-9 \-_]/gi, '_').trim();

export class LocalFileSystemProvider {
    private useBlob: boolean;
    constructor() { this.useBlob = isInIframe() || !('showDirectoryPicker' in window); }

    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (this.useBlob) throw new Error("File system access is not available in embedded mode.");
        if (!('showDirectoryPicker' in window)) throw new Error("Local folder access is not supported in this browser.");
        let handle = await getProjectHandle(projectId);
        if (handle) {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) !== 'granted') {
                if ((await handle.requestPermission(opts)) !== 'granted') {
                    throw new Error("Permission to access folder was denied.");
                }
            }
            return handle;
        }
        try {
            handle = await window.showDirectoryPicker();
            await saveProjectHandle(projectId, handle);
            return handle;
        } catch (err: any) {
            if (err.name === 'AbortError') throw new Error("Folder selection cancelled.");
            throw err;
        }
    }

    async setRoot(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
        await saveProjectHandle(projectId, handle);
    }

    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<FileSystemDirectoryHandle> {
        if (this.useBlob) return {} as FileSystemDirectoryHandle;
        const root = await this.getRoot(projectId);
        let curr = root;
        for (const part of pathParts) {
            const clean = sanitizeName(part);
            curr = await curr.getDirectoryHandle(clean, { create: true });
        }
        return curr;
    }

    async uploadFiles(projectId: string, pathParts: string[], files: FileList): Promise<void> {
        if (this.useBlob) {
            const pathKey = pathParts.map(sanitizeName).join('/');
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const data = await file.arrayBuffer();
                await saveBlobFile(projectId, pathKey, file.name, { name: file.name, mimeType: file.type || 'application/octet-stream', data });
            }
            return;
        }
        const dir = await this.ensureFolderForEntity(projectId, pathParts);
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileHandle = await dir.getFileHandle(file.name, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
        }
    }

    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        if (this.useBlob) {
            const pathKey = pathParts.map(sanitizeName).join('/');
            return listBlobFiles(projectId, pathKey);
        }
        try {
            const dir = await this.ensureFolderForEntity(projectId, pathParts);
            const files: FileEntry[] = [];
            // @ts-ignore - Async iterator for FileSystemDirectoryHandle
            for await (const entry of dir.values()) {
                if (entry.kind === 'file') {
                    files.push({ name: entry.name, handle: entry as FileSystemFileHandle });
                }
            }
            return files;
        } catch(e) {
            console.warn(e);
            return [];
        }
    }
}
